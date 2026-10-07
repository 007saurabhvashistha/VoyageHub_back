import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Router } from 'express';
import { loadSession, requireActiveAccount, requireCsrf, requireMfaForPlatformAdmin } from './auth.routes.js';
import { getMaxOffersPerRequest, getSetting } from '../services/platformSettings.js';
import { requireCapability } from '../services/permissions.js';
import { config, isCurrencyCode } from '../config/index.js';
import { audienceFor, capabilities, groupTypes as groupTypeOptions, hotelCategories, mealPlans as mealPlanOptions, requestVisibilities, requirementTypes, serviceTypes as serviceOptions, travellerTypes, valuesOf } from '../config/referenceData.js';
import { loadLineItems, loadOptions, offerOptionDto, offerPricingDto, offerSchemaFor, offerTermsDto, replaceLineItems, replaceOptions } from '../services/offerInput.js';
import { contactDetailsPattern, containsContactDetails } from '../utils/contactDetails.js';
import { parseWith } from '../utils/validation.js';
import { createRateLimiter } from '../utils/rateLimit.js';
import { z } from 'zod';
import { reportCategories, reportTargetTypes } from '../config/referenceData.js';
import { resolveActiveDestinations, sellerProfileResponse } from '../services/destinations.js';
import { findAudience, rerouteRequest, routeLabel, targetPublishedRequest } from '../services/routing.js';
import { organizationIsActive } from '../services/organizationLifecycle.js';
import { declineSchema, listNegotiations, loadOpenNegotiations, negotiationDto, negotiationSchema } from '../services/offerNegotiations.js';
import { findConversation, sellerCanSeeRequest } from '../services/requestConversations.js';
import { loadAttachments } from '../services/marketplaceAttachments.js';
import { convertMinorUnits, loadComparisonRates } from '../services/comparisonRates.js';
import { createHotelRoomHold } from '../services/hotelRoomHolds.js';
import { createAviatCrmItinerary } from '../services/aviatCrm.js';

const reportSchema = z.object({
  target_type: z.enum(reportTargetTypes.map((item) => item.value), { error: 'Choose what you are reporting.' }),
  target_id: z.uuid('Choose a valid item to report.'),
  category: z.enum(reportCategories.map((item) => item.value), { error: 'Choose a report reason.' }),
  details: z.string().trim().max(2000).nullish().transform((value) => value || null),
});
const languageTagSchema = z.string().trim().min(2)
  .refine((tag) => { try { return Intl.getCanonicalLocales(tag).length === 1; } catch { return false; } }, 'Use valid BCP 47 language tags.')
  .transform((tag) => Intl.getCanonicalLocales(tag)[0]);
const sellerSettingsSchema = z.object({
  accepting_requests: z.boolean(),
  handled_group_types: z.array(z.enum(groupTypeOptions.map((type) => type.value))).max(groupTypeOptions.length).default([]).transform((items) => [...new Set(items)]),
  minimum_group_size: z.number().int().min(1).max(32767).nullish().transform((value) => value ?? null),
  budget_min_minor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullish().transform((value) => value ?? null),
  budget_max_minor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullish().transform((value) => value ?? null),
  budget_currency: z.string().trim().toUpperCase().refine(isCurrencyCode, 'Use an ISO 4217 currency code.').nullish().transform((value) => value ?? null),
  languages: z.array(languageTagSchema).default([]).transform((items) => [...new Set(items)]),
}).superRefine((settings, context) => {
  if ((settings.budget_min_minor == null) !== (settings.budget_max_minor == null)) context.addIssue({ code: 'custom', message: 'Provide both budget bounds or neither.', path: ['budget_min_minor'] });
  if (settings.budget_min_minor != null && (settings.budget_max_minor < settings.budget_min_minor || !settings.budget_currency)) context.addIssue({ code: 'custom', message: 'Budget requires an ordered range and currency.', path: ['budget_max_minor'] });
});
const offerLibrarySchema = z.object({
  library_type: z.enum(['draft', 'template']),
  name: z.string().trim().min(1).max(80),
  payload: z.record(z.string(), z.unknown()),
});

const groupTypes = valuesOf(groupTypeOptions);
const mealPlans = valuesOf(mealPlanOptions);
const serviceTypes = valuesOf(serviceOptions);
const hotelCategoryValues = valuesOf(hotelCategories);
const visibilities = valuesOf(requestVisibilities);
const requirementTypeValues = valuesOf(requirementTypes);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;

function fail(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

async function notify(pool, organizationId, eventType, title, message, data) {
  await pool.query(
    'INSERT INTO notifications (id, organization_id, event_type, title, message, data) VALUES ($1, $2, $3, $4, $5, $6)',
    [randomUUID(), organizationId, eventType, title, message, JSON.stringify(data)],
  );
}

function offerDto(row, { lineItems = [], options = [], attachments = [], openNegotiation = null, request, sellerName } = {}) {
  const minor = (value) => value == null ? null : Number(value);
  return {
    id: row.id,
    requestId: row.request_id,
    sellerOrganizationId: row.seller_organization_id,
    ...(sellerName ? { sellerName } : {}),
    kind: row.offer_kind,
    totalMinor: minor(row.total_minor),
    ratePerNightMinor: minor(row.rate_per_night_minor),
    roomType: row.room_type,
    mealPlan: row.meal_plan,
    hotelCategory: row.hotel_category ?? null,
    itinerary: row.itinerary ?? [],
    optionLabel: row.option_label ?? null,
    hotelPropertyId: row.hotel_property_id ?? null,
    ...(row.hotel_property_name !== undefined ? { hotelPropertyName: row.hotel_property_name } : {}),
    ...(row.match_type !== undefined ? { matchType: row.match_type } : {}),
    currency: row.currency,
    inclusions: row.inclusions,
    exclusions: row.exclusions,
    validityUntil: row.validity_until,
    status: row.status,
    outcomeReason: row.outcome_reason ?? null,
    createdAt: row.created_at,
    confirmedTripVersion: Number(row.confirmed_trip_version ?? 1),
    reconfirmedAt: row.reconfirmed_at ?? null,
    ...(request?.trip_version != null ? { needsReconfirmation: Number(row.confirmed_trip_version ?? 1) < Number(request.trip_version) } : {}),
    ...offerTermsDto(row),
    ...(request ? offerPricingDto(row, request) : {}),
    ...(request?.dates ? { dates: request.dates } : {}),
    ...(request?.published_at ? { responseTimeMinutes: Math.max(0, Math.round((new Date(row.created_at).getTime() - new Date(request.published_at).getTime()) / 60000)) } : {}),
    lineItems,
    options: options.map((option) => offerOptionDto(option, row, request)),
    attachments,
    openNegotiation,
  };
}

// Line items, alternative options, attachments and the open negotiation per offer id; read one after the other so a single client is safe.
async function loadOfferParts(db, offerIds) {
  const lineItems = await loadLineItems(db, offerIds);
  const options = await loadOptions(db, offerIds);
  const attachments = await loadAttachments(db, 'offer', offerIds);
  const negotiations = await loadOpenNegotiations(db, offerIds);
  return (offerId) => ({ lineItems: lineItems.get(offerId), options: options.get(offerId), attachments: attachments.get(offerId), openNegotiation: negotiations.get(offerId) ?? null });
}

// Stores the offer as it was before a change, so "which version was awarded" can always be answered.
async function recordOfferRevision(client, offerRow, requestFacts) {
  const parts = await loadOfferParts(client, [offerRow.id]);
  const latest = await client.query('SELECT COALESCE(MAX(revision_number), 0) AS revision_number FROM offer_revisions WHERE offer_id = $1', [offerRow.id]);
  await client.query(
    'INSERT INTO offer_revisions (id, offer_id, revision_number, snapshot) VALUES ($1, $2, $3, $4)',
    [randomUUID(), offerRow.id, Number(latest.rows[0].revision_number) + 1, JSON.stringify(offerDto(offerRow, { ...parts(offerRow.id), request: requestFacts }))],
  );
}

const requestFactsOf = (row) => {
  const startDate = row.travel_start_date ? dateText(row.travel_start_date) : null;
  const endDate = row.travel_end_date ? dateText(row.travel_end_date) : null;
  return {
    adults: row.adults,
    children: row.children,
    nights: row.nights,
    room_count: row.request_room_count,
    trip_version: row.trip_version,
    dates: startDate && endDate ? `${startDate} - ${endDate}` : row.travel_month ? `${row.travel_month} / ${row.nights} nights` : null,
  };
};

function validDate(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

// null when omitted, undefined when malformed.
function parseTripVersion(value) {
  if (value == null) return null;
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

// Trip details are the fields an agency may change after publishing; sellers must re-confirm when they do.
function validTrip(body) {
  const travelMonth = typeof body.travel_month === 'string' ? body.travel_month : null;
  const hasDates = validDate(body.travel_start_date) && validDate(body.travel_end_date) && body.travel_end_date > body.travel_start_date;
  const hasMonth = typeof travelMonth === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(travelMonth);
  const nights = Number(body.nights);
  const adults = Number(body.adults);
  const children = Number(body.children ?? 0);
  const infants = Number(body.infants ?? 0);
  const childAges = Array.isArray(body.child_ages) ? body.child_ages.map(Number) : [];
  const specialRequests = typeof body.special_requests === 'string' ? body.special_requests.trim() || null : null;
  const childAgeRange = travellerTypes.find((type) => type.value === 'child');

  if (!hasDates && !hasMonth) return { error: 'Provide exact travel dates or a travel month.' };
  if (hasDates && travelMonth) return { error: 'Choose exact dates or a travel month, not both.' };
  if (!Number.isInteger(nights) || nights < 1 || nights > 90) return { error: 'Nights must be between 1 and 90.' };
  if (hasDates && Math.ceil((Date.parse(`${body.travel_end_date}T00:00:00Z`) - Date.parse(`${body.travel_start_date}T00:00:00Z`)) / 86400000) !== nights) return { error: 'Nights must match the selected travel dates.' };
  if (!Number.isInteger(adults) || adults < 1 || adults > 100) return { error: 'Adults must be between 1 and 100.' };
  if (!Number.isInteger(children) || children < 0 || children > 80) return { error: 'Children must be between 0 and 80.' };
  if (!Number.isInteger(infants) || infants < 0 || infants > 40) return { error: 'Infants must be between 0 and 40.' };
  if (childAges.length && (childAges.length !== children || childAges.some((age) => !Number.isInteger(age) || age < childAgeRange.minAge || age > childAgeRange.maxAge))) return { error: `Provide one valid age for each child (${childAgeRange.minAge}-${childAgeRange.maxAge}).` };
  if (specialRequests && (specialRequests.length > 2000 || containsContactDetails(specialRequests))) return { error: 'Special requests must be under 2000 characters and cannot include contact details or external links.', code: containsContactDetails(specialRequests) ? 'CONTACT_DETAILS_NOT_ALLOWED' : 'VALIDATION_ERROR' };
  if (body.room_count != null && (!Number.isInteger(Number(body.room_count)) || Number(body.room_count) < 1 || Number(body.room_count) > 50)) return { error: 'Room count must be between 1 and 50.' };

  return {
    travelStartDate: hasDates ? body.travel_start_date : null,
    travelEndDate: hasDates ? body.travel_end_date : null,
    travelMonth: hasMonth ? travelMonth : null,
    nights,
    adults,
    children,
    infants,
    childAges,
    specialRequests,
    roomCount: body.room_count == null ? null : Number(body.room_count),
  };
}

function validDeadline(value) {
  const deadline = typeof value === 'string' ? new Date(value) : null;
  if (!deadline || Number.isNaN(deadline.getTime())
    || deadline < new Date(Date.now() + config.requestDeadline.minHours * hourMs)
    || deadline > new Date(Date.now() + config.requestDeadline.maxDays * dayMs)) {
    return { error: `Response deadline must be between ${config.requestDeadline.minHours} hour(s) and ${config.requestDeadline.maxDays} days from now.` };
  }
  return { deadline };
}

// Ordered stops; the legacy single destination_id is accepted as a one-stop list.
function validStops(body) {
  const raw = Array.isArray(body.destinations)
    ? body.destinations
    : typeof body.destination_id === 'string' ? [{ destination_id: body.destination_id }] : [];
  if (!raw.length) return { error: 'Choose a destination from the destination list.' };
  const stops = [];
  for (const item of raw) {
    const destinationId = typeof item === 'string' ? item : item?.destination_id;
    const nights = item?.nights == null || item.nights === '' ? null : Number(item.nights);
    if (typeof destinationId !== 'string' || !uuidPattern.test(destinationId)) return { error: 'Choose each destination from the destination list.' };
    if (nights != null && (!Number.isInteger(nights) || nights < 1 || nights > 90)) return { error: 'Nights per destination must be between 1 and 90.' };
    stops.push({ destinationId, nights });
  }
  if (new Set(stops.map((stop) => stop.destinationId)).size !== stops.length) return { error: 'Choose each destination only once.' };
  return { stops };
}

// Rule: a hotel-only lead has one destination and only hotel services; anything else is an itinerary.
function validRequirement(requirementType, services, stops, nights) {
  if (!requirementTypeValues.has(requirementType)) return { error: 'Choose whether you need a hotel only or a full itinerary.', code: 'VALIDATION_ERROR' };
  const definition = requirementTypes.find((item) => item.value === requirementType);
  const disallowed = services.filter((service) => !serviceOptions.find((option) => option.value === service)?.allowedFor.includes(requirementType));
  if (disallowed.length) return { error: `A ${definition.label.toLowerCase()} lead cannot include: ${disallowed.join(', ')}. Choose the itinerary type instead.`, code: 'REQUIREMENT_TYPE_MISMATCH' };
  if (definition.maxDestinations != null && stops.length > definition.maxDestinations) return { error: `A ${definition.label.toLowerCase()} lead has ${definition.maxDestinations} destination. Choose the itinerary type for multi-stop trips.`, code: 'REQUIREMENT_TYPE_MISMATCH' };
  const stopNights = stops.map((stop) => stop.nights).filter((value) => value != null);
  const totalStopNights = stopNights.reduce((sum, value) => sum + value, 0);
  if (totalStopNights > nights || (stopNights.length === stops.length && stops.length > 1 && totalStopNights !== nights)) {
    return { error: 'Nights per destination must add up to the trip nights.', code: 'VALIDATION_ERROR' };
  }
  return {};
}

function validRequest(body) {
  const services = Array.isArray(body.services) ? [...new Set(body.services)] : [];
  const budgetMin = body.budget_min_minor == null ? null : Number(body.budget_min_minor);
  const budgetMax = body.budget_max_minor == null ? null : Number(body.budget_max_minor);
  const budgetCurrency = typeof body.budget_currency === 'string' ? body.budget_currency.toUpperCase() : null;
  const visibility = body.visibility ?? 'open';
  const invitedSellerIds = Array.isArray(body.invited_seller_ids) ? [...new Set(body.invited_seller_ids)] : [];

  const stops = validStops(body);
  if (stops.error) return stops;
  const trip = validTrip(body);
  if (trip.error) return trip;
  if (trip.children > 0 && trip.childAges.length !== trip.children) return { error: 'Provide one age for each child.' };
  if (!groupTypes.has(body.group_type)) return { error: 'Choose a supported group type.' };
  if (!services.length || services.length > serviceTypes.size || services.some((service) => !serviceTypes.has(service))) return { error: 'Choose one or more supported services.' };
  const requirement = validRequirement(body.requirement_type, services, stops.stops, trip.nights);
  if (requirement.error) return requirement;
  if (body.hotel_category != null && !hotelCategoryValues.has(Number(body.hotel_category))) return { error: 'Choose a supported hotel category.' };
  if (body.meal_plan != null && !mealPlans.has(body.meal_plan)) return { error: 'Choose a supported meal plan.' };
  const deadline = validDeadline(body.response_deadline);
  if (deadline.error) return deadline;
  if ((budgetMin == null) !== (budgetMax == null)) return { error: 'Provide both budget bounds or neither.' };
  if (budgetMin != null && (!Number.isSafeInteger(budgetMin) || !Number.isSafeInteger(budgetMax) || budgetMin < 0 || budgetMax < budgetMin || !isCurrencyCode(budgetCurrency))) return { error: 'Budget requires valid minor-unit bounds and an ISO currency code.' };
  if (!visibilities.has(visibility)) return { error: 'Choose open, invite-only, or open and invited visibility.' };
  if (invitedSellerIds.length > config.maxInvitedSuppliers || invitedSellerIds.some((id) => typeof id !== 'string' || !uuidPattern.test(id))) return { error: `Invite up to ${config.maxInvitedSuppliers} verified suppliers.` };
  if (visibility === 'open' && invitedSellerIds.length) return { error: 'Open requests cannot include invited suppliers. Choose invite-only or open and invited visibility.' };
  if (visibility === 'invite_only' && !invitedSellerIds.length) return { error: 'Invite at least one verified supplier for an invite-only request.' };

  return {
    stops: stops.stops,
    requirementType: body.requirement_type,
    ...trip,
    groupType: body.group_type,
    hotelCategory: body.hotel_category == null ? null : Number(body.hotel_category),
    mealPlan: body.meal_plan ?? null,
    services,
    budgetMin,
    budgetMax,
    budgetCurrency: budgetMin == null ? null : budgetCurrency,
    responseDeadline: deadline.deadline,
    visibility,
    invitedSellerIds,
  };
}

const dateText = (value) => value instanceof Date ? value.toISOString().slice(0, 10) : value ?? null;

function travellersText(adults, children, infants) {
  const parts = [`${adults} adults`];
  if (children) parts.push(`${children} children`);
  if (infants) parts.push(`${infants} infants`);
  return parts.join(', ');
}

// Stored in request_trip_changes and compared to detect a real change.
function tripFields(row) {
  return {
    travel_start_date: dateText(row.travel_start_date),
    travel_end_date: dateText(row.travel_end_date),
    travel_month: row.travel_month ?? null,
    nights: Number(row.nights),
    adults: Number(row.adults),
    children: Number(row.children ?? 0),
    infants: Number(row.infants ?? 0),
    child_ages: row.child_ages ?? [],
    special_requests: row.special_requests ?? null,
    room_count: row.room_count == null ? null : Number(row.room_count),
  };
}

function tripDto(trip) {
  return {
    travelStartDate: trip.travel_start_date,
    travelEndDate: trip.travel_end_date,
    travelMonth: trip.travel_month,
    dates: trip.travel_start_date && trip.travel_end_date ? `${trip.travel_start_date} - ${trip.travel_end_date}` : trip.travel_month,
    nights: trip.nights,
    adults: trip.adults,
    children: trip.children,
    infants: trip.infants,
    childAges: trip.child_ages ?? [],
    specialRequests: trip.special_requests ?? null,
    travelers: travellersText(trip.adults, trip.children, trip.infants),
    roomCount: trip.room_count,
  };
}

function tripChangeDto(row) {
  return {
    version: row.trip_version,
    changedAt: row.created_at,
    note: row.note,
    previous: tripDto(row.previous_trip),
    current: tripDto(row.current_trip),
  };
}

function requestDto(row) {
  const startDate = row.travel_start_date ? dateText(row.travel_start_date) : null;
  const endDate = row.travel_end_date ? dateText(row.travel_end_date) : null;
  return {
    id: row.id,
    requestCode: row.request_code,
    destination: row.destination,
    destinationId: row.destination_id ?? null,
    destinationCountry: row.destination_country,
    country: row.destination_country,
    travelStartDate: startDate,
    travelEndDate: endDate,
    travelMonth: row.travel_month,
    dates: startDate && endDate ? `${startDate} - ${endDate}` : row.travel_month,
    nights: row.nights,
    adults: row.adults,
    children: row.children,
    infants: row.infants,
    childAges: row.child_ages ?? [],
    specialRequests: row.special_requests ?? null,
    travelers: travellersText(row.adults, row.children, row.infants),
    groupType: row.group_type,
    hotelCategory: row.hotel_category,
    roomCount: row.room_count,
    mealPlan: row.meal_plan,
    services: row.services,
    budgetMinMinor: row.budget_min_minor,
    budgetMaxMinor: row.budget_max_minor,
    budgetCurrency: row.budget_currency,
    responseDeadline: row.response_deadline,
    deadline: row.response_deadline ? new Date(row.response_deadline).toLocaleDateString('en', { day: '2-digit', month: 'short' }) : '',
    status: row.status,
    visibility: row.visibility,
    closedAt: row.closed_at ?? null,
    offers: Number(row.offer_count ?? 0),
    agencyName: row.agency_name,
    agencyVerified: Boolean(row.agency_verified),
    tripVersion: Number(row.trip_version ?? 1),
    tripChangedAt: row.trip_changed_at ?? null,
    requirementType: row.requirement_type,
    destinations: row.stops ?? [],
    destinationUnresolved: Boolean(row.destination_unresolved),
    awardedAt: row.awarded_at ?? null,
    awardUndoUntil: row.awarded_at && row.award_undoable ? new Date(new Date(row.awarded_at).getTime() + config.awards.undoWindowMs).toISOString() : null,
  };
}

function sellerRequestDto(row, offerLimit) {
  const offers = Number(row.offer_count ?? 0);
  return {
    ...requestDto(row),
    offerLimit,
    offerLimitReached: offers >= offerLimit,
    hasActiveOffer: Boolean(row.my_offer_id),
    myOfferId: row.my_offer_id ?? null,
    needsReconfirmation: Boolean(row.needs_reconfirmation),
    matchType: row.match_type ?? null,
    matchingProperties: row.matching_properties ?? [],
    tripChange: row.last_change_version ? tripChangeDto({ trip_version: row.last_change_version, created_at: row.last_change_at, note: row.last_change_note, previous_trip: row.last_change_previous, current_trip: row.last_change_current }) : null,
  };
}

// Ordered stops per request for DTOs: [{ destinationId, name, kind, nights }].
async function loadStops(db, requestIds) {
  const byRequest = new Map(requestIds.map((id) => [id, []]));
  if (!requestIds.length) return byRequest;
  const result = await db.query(
    `SELECT rd.request_id, rd.destination_id, rd.nights, d.name, d.kind FROM request_destinations rd
     JOIN destinations d ON d.id = rd.destination_id WHERE rd.request_id = ANY($1::uuid[]) ORDER BY rd.request_id, rd.sequence`,
    [requestIds],
  );
  for (const row of result.rows) byRequest.get(row.request_id)?.push({ destinationId: row.destination_id, name: row.name, kind: row.kind, nights: row.nights });
  return byRequest;
}

async function withStops(db, rows) {
  const stops = await loadStops(db, rows.map((row) => row.id));
  return rows.map((row) => ({ ...row, stops: stops.get(row.id) ?? [] }));
}

// Active destinations for the stops, with the hotel-only level rule from platform settings.
async function resolveStops(db, requirementType, stops) {
  const resolved = await resolveActiveDestinations(db, stops.map((stop) => stop.destinationId));
  if (resolved.error) return resolved;
  if (audienceFor(requirementType) === 'hotelier') {
    const allowedKinds = await getSetting(db, 'hotel_lead_allowed_destination_kinds');
    if (!allowedKinds.includes(resolved.rows[0].kind)) return { error: `For a hotel-only lead choose a destination of type: ${allowedKinds.join(', ')}.` };
  }
  const maxStops = await getSetting(db, 'max_request_destinations');
  if (stops.length > maxStops) return { error: `Choose at most ${maxStops} destinations.` };
  return resolved;
}

async function replaceStops(db, requestId, stops) {
  await db.query('DELETE FROM request_destinations WHERE request_id = $1', [requestId]);
  await db.query(
    `INSERT INTO request_destinations (request_id, sequence, destination_id, nights)
     SELECT $1, stop.sequence, stop.destination_id, stop.nights
     FROM unnest($2::uuid[], $3::int[]) WITH ORDINALITY AS stop(destination_id, nights, sequence)`,
    [requestId, stops.map((stop) => stop.destinationId), stops.map((stop) => stop.nights)],
  );
}

// Only allowlisted fields reach sellers; rebuilt whenever published trip details change.
const refreshSellerSnapshotSql = `UPDATE marketplace_requests r SET seller_visible_snapshot = jsonb_build_object(
    'requestCode', r.request_code, 'destination', r.destination,
    'destinationCountry', r.destination_country, 'travelStartDate', r.travel_start_date,
    'travelEndDate', r.travel_end_date, 'travelMonth', r.travel_month,
    'nights', r.nights, 'adults', r.adults, 'children', r.children, 'infants', r.infants,
    'childAges', r.child_ages, 'specialRequests', r.special_requests,
    'groupType', r.group_type, 'hotelCategory', r.hotel_category, 'roomCount', r.room_count,
    'mealPlan', r.meal_plan, 'services', r.services, 'budgetMinMinor', r.budget_min_minor,
    'budgetMaxMinor', r.budget_max_minor, 'budgetCurrency', r.budget_currency,
    'responseDeadline', r.response_deadline, 'agencyName', o.name,
    'agencyVerified', (o.verified_at IS NOT NULL),
    'tripVersion', r.trip_version, 'tripChangedAt', r.trip_changed_at,
    'requirementType', r.requirement_type,
    'destinations', COALESCE((SELECT jsonb_agg(jsonb_build_object('destinationId', d.id, 'name', d.name, 'kind', d.kind, 'nights', rd.nights) ORDER BY rd.sequence)
      FROM request_destinations rd JOIN destinations d ON d.id = rd.destination_id WHERE rd.request_id = r.id), '[]'::jsonb)
  ) FROM organizations o WHERE r.id = $1 AND o.id = r.agency_organization_id`;

const tripChangeSchema = z.object({
  response_deadline: z.string().nullish().transform((value) => value || null),
  note: z.string().trim().max(500, 'Keep the change note under 500 characters.').nullish().transform((value) => value || null),
  trip_version: z.number({ error: 'Send the trip version you are changing.' }).int().positive(),
});
const deadlineExtensionSchema = z.object({
  response_deadline: z.string().min(1),
  note: z.string().trim().max(500).nullish().transform((value) => value || null),
});
const cancelRequestSchema = z.object({
  note: z.string().trim().max(500).nullish().transform((value) => value || null),
}).refine((input) => !containsContactDetails(input.note), 'Remove contact details and external links from the cancellation note.');

const awardSelectionSchema = z.object({
  offer_id: z.uuid('Choose an offer to award.'),
  offer_option_id: z.uuid('Choose a valid offer option, or leave it empty for the main option.').nullish().transform((value) => value ?? null),
});

// `offer_id` alone awards one seller; `selections` splits the trip across several sellers in one decision.
const awardSchema = z.object({
  selections: z.array(awardSelectionSchema).min(1, 'Choose an offer to award.')
    .max(config.awards.maxPerRequest, `Award at most ${config.awards.maxPerRequest} sellers on one request.`).optional(),
  offer_id: z.uuid('Choose an offer to award.').optional(),
  offer_option_id: z.uuid('Choose a valid offer option, or leave it empty for the main option.').nullish(),
  not_selected_reason: z.string().trim().max(300, 'Keep the not-selected reason under 300 characters.').nullish().transform((value) => value || null),
}).transform((input) => ({
  selections: input.selections ?? (input.offer_id ? [{ offer_id: input.offer_id, offer_option_id: input.offer_option_id ?? null }] : []),
  notSelectedReason: input.not_selected_reason,
})).refine((input) => input.selections.length > 0, 'Choose an offer to award.')
  .refine((input) => new Set(input.selections.map((item) => item.offer_id)).size === input.selections.length, 'Choose each offer only once.');

const undoAwardSchema = z.object({
  reason: z.string().trim().max(300, 'Keep the reason under 300 characters.').nullish().transform((value) => value || null),
}).refine((input) => !containsContactDetails(input.reason), 'Remove contact details and external links from the reason.');
const aviatCrmExportSchema = z.object({
  api_base_url: z.string().trim().url().max(500),
  access_token: z.string().trim().min(1).max(4096).refine((value) => !/[\r\n]/.test(value), 'Access token is invalid.'),
  offer_option_id: z.uuid().nullish().transform((value) => value ?? null),
  markup_percentage: z.number().finite().nonnegative(),
});

// An award decision can be undone only while every award in it is still before booking confirmation.
const agencyAwardColumns = `(SELECT MIN(a.created_at) FROM awards a WHERE a.request_id = r.id) AS awarded_at,
  NOT EXISTS (SELECT 1 FROM awards a WHERE a.request_id = r.id AND a.status <> 'awarded') AS award_undoable`;

export function createMarketplaceRouter({ pool, storage = null, comparisonRateFetch = globalThis.fetch, crmItineraryCreate = createAviatCrmItinerary }) {
  const router = Router();
  const reportLimiter = createRateLimiter(config.rateLimits.report, 'Too many reports. Try again later.');
  router.use((request, response, next) => loadSession(pool, request, response, next));
  router.use(requireMfaForPlatformAdmin);
  router.use((request, response, next) => requireActiveAccount(pool, request, response, next));
  router.use((request, response, next) => request.method === 'GET' ? next() : requireCsrf(request, response, next));

  router.get('/seller-profile', async (request, response, next) => {
    if (!['dmc', 'hotelier'].includes(request.auth.business_type)) return fail(response, 403, 'ROLE_FORBIDDEN', 'Seller profile is only available to DMCs and hoteliers.');
    try {
      const profile = await sellerProfileResponse(pool, request.auth.organization_id);
      if (!profile) return fail(response, 404, 'PROFILE_NOT_FOUND', 'Seller profile was not found.');
      return response.json(profile);
    } catch (error) {
      return next(error);
    }
  });

  router.put('/seller-settings', requireCapability(capabilities.profileManage), async (request, response, next) => {
    if (!['dmc', 'hotelier'].includes(request.auth.business_type)) return fail(response, 403, 'ROLE_FORBIDDEN', 'Seller settings are only available to DMCs and hoteliers.');
    const input = parseWith(sellerSettingsSchema, request.body);
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    if (request.auth.business_type !== 'dmc' && (
      input.data.handled_group_types.length || input.data.minimum_group_size != null
      || input.data.budget_min_minor != null || input.data.budget_max_minor != null || input.data.languages.length
    )) return fail(response, 400, 'VALIDATION_ERROR', 'Only DMCs can set trip, group, budget and language preferences.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(
        `SELECT handled_group_types, minimum_group_size, budget_min_minor, budget_max_minor, budget_currency, languages, accepting_requests
         FROM seller_profiles WHERE organization_id = $1 FOR UPDATE`,
        [request.auth.organization_id],
      );
      if (!current.rowCount) {
        await client.query('ROLLBACK');
        return fail(response, 404, 'PROFILE_NOT_FOUND', 'Seller profile was not found.');
      }
      const old = current.rows[0];
      const settings = input.data;
      const changed = JSON.stringify({ groups: old.handled_group_types, minimum: old.minimum_group_size, min: old.budget_min_minor == null ? null : Number(old.budget_min_minor), max: old.budget_max_minor == null ? null : Number(old.budget_max_minor), currency: old.budget_currency, languages: old.languages, accepting: old.accepting_requests })
        !== JSON.stringify({ groups: settings.handled_group_types, minimum: settings.minimum_group_size, min: settings.budget_min_minor, max: settings.budget_max_minor, currency: settings.budget_currency, languages: settings.languages, accepting: settings.accepting_requests });
      const matchingChanged = JSON.stringify({ groups: old.handled_group_types, minimum: old.minimum_group_size, min: old.budget_min_minor == null ? null : Number(old.budget_min_minor), max: old.budget_max_minor == null ? null : Number(old.budget_max_minor), currency: old.budget_currency })
        !== JSON.stringify({ groups: settings.handled_group_types, minimum: settings.minimum_group_size, min: settings.budget_min_minor, max: settings.budget_max_minor, currency: settings.budget_currency });
      const resumed = old.accepting_requests === false && settings.accepting_requests;
      if (changed) {
        await client.query(
          `INSERT INTO seller_profile_changes (id, seller_organization_id, changed_by_user_id, previous_profile, updated_profile)
           VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), request.auth.organization_id, request.auth.user_id,
            JSON.stringify({ ...old, budget_min_minor: old.budget_min_minor == null ? null : Number(old.budget_min_minor), budget_max_minor: old.budget_max_minor == null ? null : Number(old.budget_max_minor) }),
            JSON.stringify(settings)],
        );
        await client.query(
          `UPDATE seller_profiles SET handled_group_types = $2, minimum_group_size = $3,
             budget_min_minor = $4, budget_max_minor = $5, budget_currency = $6,
             languages = $7, accepting_requests = $8, updated_at = NOW()
           WHERE organization_id = $1`,
          [request.auth.organization_id, settings.handled_group_types, settings.minimum_group_size,
            settings.budget_min_minor, settings.budget_max_minor, settings.budget_currency, settings.languages, settings.accepting_requests],
        );
      }
      let reroutedRequests = 0;
      if (matchingChanged || resumed) {
        const requirementTypesForRole = requirementTypes.filter((type) => type.audience === request.auth.business_type).map((type) => type.value);
        const openRequests = await client.query("SELECT id FROM marketplace_requests WHERE status = 'open' AND requirement_type = ANY($1::text[]) ORDER BY created_at, id", [requirementTypesForRole]);
        for (const row of openRequests.rows) {
          await rerouteRequest(client, row.id, { alertNew: true });
          reroutedRequests += 1;
        }
      }
      await client.query('COMMIT');
      return response.json({ ...(await sellerProfileResponse(client, request.auth.organization_id)), changed, reroutedRequests });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  router.get('/suppliers', async (request, response, next) => {
    if (request.auth.business_type !== 'agency') return fail(response, 403, 'ROLE_FORBIDDEN', 'The supplier directory is only available to travel agencies.');
    const search = typeof request.query.search === 'string' ? request.query.search.trim() : '';
    const country = typeof request.query.country === 'string' ? request.query.country.toUpperCase() : '';
    const favoritesOnly = request.query.favorites_only === 'true';
    if (request.query.favorites_only != null && !['true', 'false'].includes(request.query.favorites_only)) return fail(response, 400, 'VALIDATION_ERROR', 'Choose whether to show only preferred suppliers.');
    const limit = Number(request.query.limit ?? 25);
    const offset = Number(request.query.offset ?? 0);
    if (search.length > 120 || (country && !/^[A-Z]{2}$/.test(country)) || !Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(offset) || offset < 0 || offset > 100000) {
      return fail(response, 400, 'VALIDATION_ERROR', 'Use a search up to 120 characters, an ISO country code, and valid pagination values.');
    }
    try {
      const searchPattern = search ? `%${search}%` : null;
      const values = [searchPattern, country || null, request.auth.organization_id, favoritesOnly];
      const where = `p.verification_status = 'approved' AND p.accepting_requests AND ${organizationIsActive('o')} AND o.business_type IN ('dmc', 'hotelier')
        AND ($1::text IS NULL OR o.name ILIKE $1 OR p.property_city ILIKE $1
          OR EXISTS (SELECT 1 FROM unnest(p.coverage_destinations) AS destination WHERE destination ILIKE $1))
        AND ($2::text IS NULL OR o.country_code = $2)
        AND (NOT $4::boolean OR EXISTS (SELECT 1 FROM agency_preferred_sellers preferred
          WHERE preferred.agency_organization_id = $3 AND preferred.seller_organization_id = o.id))`;
      const count = await pool.query(
        `SELECT COUNT(*) AS total FROM seller_profiles p JOIN organizations o ON o.id = p.organization_id WHERE ${where}`,
        values,
      );
      const result = await pool.query(
        `SELECT o.id AS organization_id, o.name AS organization_name, o.business_type, o.country_code,
          p.coverage_destinations, p.property_city,
          EXISTS (SELECT 1 FROM agency_preferred_sellers preferred
            WHERE preferred.agency_organization_id = $3 AND preferred.seller_organization_id = o.id) AS is_favorite
         FROM seller_profiles p JOIN organizations o ON o.id = p.organization_id
         WHERE ${where}
         ORDER BY is_favorite DESC, o.name ASC, o.id ASC LIMIT $5 OFFSET $6`,
        [...values, limit, offset],
      );
      return response.json({
        suppliers: result.rows.map((row) => ({
          organizationId: row.organization_id,
          name: row.organization_name,
          type: row.business_type,
          countryCode: row.country_code,
          coverageDestinations: row.coverage_destinations,
          propertyCity: row.property_city,
          isFavorite: row.is_favorite,
          verified: true,
        })),
        pagination: { limit, offset, total: Number(count.rows[0].total) },
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/suppliers/favorites', async (request, response, next) => {
    if (request.auth.business_type !== 'agency') return fail(response, 403, 'ROLE_FORBIDDEN', 'Preferred suppliers are only available to travel agencies.');
    try {
      const result = await pool.query(
        `SELECT organization.id AS organization_id, organization.name AS organization_name,
                organization.business_type, organization.country_code, organization.suspended_at,
                profile.accepting_requests, profile.verification_status, profile.coverage_destinations,
                profile.property_city, preferred.created_at
         FROM agency_preferred_sellers preferred
         JOIN organizations organization ON organization.id = preferred.seller_organization_id
         LEFT JOIN seller_profiles profile ON profile.organization_id = organization.id
         WHERE preferred.agency_organization_id = $1
         ORDER BY organization.name, organization.id`,
        [request.auth.organization_id],
      );
      return response.json({ suppliers: result.rows.map((row) => ({
        organizationId: row.organization_id,
        name: row.organization_name,
        type: row.business_type,
        countryCode: row.country_code,
        coverageDestinations: row.coverage_destinations ?? [],
        propertyCity: row.property_city ?? null,
        isEligible: row.suspended_at == null && row.verification_status === 'approved' && row.accepting_requests === true,
        addedAt: row.created_at,
      })) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/suppliers/:sellerOrganizationId/favorite', requireCapability(capabilities.requestWrite), async (request, response, next) => {
    if (request.auth.business_type !== 'agency') return fail(response, 403, 'ROLE_FORBIDDEN', 'Only travel agencies can save preferred suppliers.');
    if (!z.uuid().safeParse(request.params.sellerOrganizationId).success) return fail(response, 400, 'VALIDATION_ERROR', 'Choose a valid supplier.');
    try {
      const seller = await pool.query(
        `SELECT organization.id FROM organizations organization
         JOIN seller_profiles profile ON profile.organization_id = organization.id
         WHERE organization.id = $1 AND organization.business_type IN ('dmc', 'hotelier')
           AND profile.verification_status = 'approved' AND profile.accepting_requests
           AND ${organizationIsActive('organization')}`,
        [request.params.sellerOrganizationId],
      );
      if (!seller.rowCount) return fail(response, 404, 'SUPPLIER_NOT_AVAILABLE', 'Only active, verified suppliers can be saved.');
      await pool.query(
        `INSERT INTO agency_preferred_sellers (agency_organization_id, seller_organization_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [request.auth.organization_id, request.params.sellerOrganizationId],
      );
      return response.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  router.delete('/suppliers/:sellerOrganizationId/favorite', requireCapability(capabilities.requestWrite), async (request, response, next) => {
    if (request.auth.business_type !== 'agency') return fail(response, 403, 'ROLE_FORBIDDEN', 'Only travel agencies can manage preferred suppliers.');
    if (!z.uuid().safeParse(request.params.sellerOrganizationId).success) return fail(response, 400, 'VALIDATION_ERROR', 'Choose a valid supplier.');
    try {
      await pool.query(
        'DELETE FROM agency_preferred_sellers WHERE agency_organization_id = $1 AND seller_organization_id = $2',
        [request.auth.organization_id, request.params.sellerOrganizationId],
      );
      return response.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  router.get('/hotel/inventory', async (request, response, next) => {
    if (request.auth.business_type !== 'hotelier') return fail(response, 403, 'ROLE_FORBIDDEN', 'Only hotelier accounts can view room inventory.');
    const from = request.query.from;
    const to = request.query.to;
    if (!validDate(from) || !validDate(to) || to < from || (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 > 90) {
      return fail(response, 400, 'VALIDATION_ERROR', 'Choose an inventory date range of up to 90 days.');
    }
    try {
      const result = await pool.query(
        `SELECT id, inventory_date, room_type, available_rooms, nightly_rate_minor, currency, updated_at
         FROM hotel_room_inventory WHERE organization_id = $1 AND inventory_date BETWEEN $2 AND $3
         ORDER BY inventory_date, room_type`,
        [request.auth.organization_id, from, to],
      );
      return response.json({ inventory: result.rows.map((row) => ({ id: row.id, date: row.inventory_date instanceof Date ? row.inventory_date.toISOString().slice(0, 10) : row.inventory_date, roomType: row.room_type, availableRooms: row.available_rooms, nightlyRateMinor: row.nightly_rate_minor, currency: row.currency, updatedAt: row.updated_at })) });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/hotel-properties/:propertyId/photos', async (request, response, next) => {
    if (request.auth.business_type !== 'agency') return fail(response, 403, 'ROLE_FORBIDDEN', 'Only requesting agencies can view hotel offer photos.');
    if (!uuidPattern.test(request.params.propertyId)) return fail(response, 404, 'HOTEL_NOT_FOUND', 'Hotel was not found.');
    if (!storage) return fail(response, 503, 'STORAGE_NOT_CONFIGURED', 'Hotel photos need private file storage.');
    try {
      const eligible = await pool.query(
        `SELECT 1 FROM hotel_properties property
         WHERE property.id = $1 AND property.active AND property.verification_status = 'approved'
           AND EXISTS (SELECT 1 FROM offers offer JOIN marketplace_requests request ON request.id = offer.request_id
             WHERE offer.hotel_property_id = property.id AND request.agency_organization_id = $2
               AND offer.status IN ('submitted', 'shortlisted', 'accepted'))`,
        [request.params.propertyId, request.auth.organization_id],
      );
      if (!eligible.rowCount) return fail(response, 404, 'HOTEL_NOT_FOUND', 'Hotel was not found on one of your requests.');
      const photos = await pool.query(
        `SELECT id, original_filename, content_type, size_bytes, storage_key, storage_provider, created_at
         FROM hotel_property_photos WHERE property_id = $1 AND scan_status = 'clean' AND deleted_at IS NULL ORDER BY created_at, id`,
        [request.params.propertyId],
      );
      const entries = [];
      for (const photo of photos.rows) {
        if (photo.storage_provider !== storage.provider) continue;
        const expiresInSeconds = config.documents.downloadUrlTtlSeconds;
        const url = await storage.createDownloadUrl(photo.storage_key, { expiresInSeconds, contentType: photo.content_type });
        entries.push({ id: photo.id, filename: photo.original_filename, contentType: photo.content_type, sizeBytes: photo.size_bytes, url, expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString() });
      }
      return response.json({ photos: entries });
    } catch (error) {
      return next(error);
    }
  });

  router.put('/hotel/inventory', requireCapability(capabilities.profileManage), async (request, response, next) => {
    if (request.auth.business_type !== 'hotelier') return fail(response, 403, 'ROLE_FORBIDDEN', 'Only hotelier accounts can update room inventory.');
    if (!Array.isArray(request.body?.inventory) || request.body.inventory.length < 1 || request.body.inventory.length > 300) return fail(response, 400, 'VALIDATION_ERROR', 'Submit between 1 and 300 room inventory rows.');
    const inventory = [];
    const uniqueKeys = new Set();
    for (const item of request.body.inventory) {
      const date = item?.date;
      const roomType = typeof item?.room_type === 'string' ? item.room_type.trim() : '';
      const availableRooms = Number(item?.available_rooms);
      const nightlyRateMinor = item?.nightly_rate_minor == null || item.nightly_rate_minor === '' ? null : Number(item.nightly_rate_minor);
      const currency = typeof item?.currency === 'string' ? item.currency.toUpperCase() : config.defaultCurrency;
      if (!validDate(date) || roomType.length < 2 || roomType.length > 120 || !Number.isInteger(availableRooms) || availableRooms < 0 || availableRooms > 100) return fail(response, 400, 'VALIDATION_ERROR', 'Each row needs a valid date, room type and availability from 0 to 100.');
      if (nightlyRateMinor != null && (!Number.isSafeInteger(nightlyRateMinor) || nightlyRateMinor < 0)) return fail(response, 400, 'VALIDATION_ERROR', 'Nightly rate must be non-negative integer minor units.');
      if (!isCurrencyCode(currency)) return fail(response, 400, 'VALIDATION_ERROR', 'Use an ISO 4217 currency code.');
      const uniqueKey = `${date}|${roomType.toLowerCase()}`;
      if (uniqueKeys.has(uniqueKey)) return fail(response, 400, 'VALIDATION_ERROR', 'Room type and date rows must be unique.');
      uniqueKeys.add(uniqueKey);
      inventory.push({ date, roomType, availableRooms, nightlyRateMinor, currency });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const item of inventory) {
        await client.query(
          `INSERT INTO hotel_room_inventory (id, organization_id, inventory_date, room_type, available_rooms, nightly_rate_minor, currency)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (organization_id, inventory_date, room_type) DO UPDATE SET
             available_rooms = EXCLUDED.available_rooms, nightly_rate_minor = EXCLUDED.nightly_rate_minor,
             currency = EXCLUDED.currency, updated_at = NOW()`,
          [randomUUID(), request.auth.organization_id, item.date, item.roomType, item.availableRooms, item.nightlyRateMinor, item.currency],
        );
      }
      await client.query('COMMIT');
      return response.status(200).json({ savedCount: inventory.length });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  router.get('/requests', async (request, response, next) => {
    try {
      if (request.auth.business_type === 'agency') {
        const result = await pool.query(
            `SELECT r.*, o.name AS agency_name, o.verified_at IS NOT NULL AS agency_verified, ${agencyAwardColumns},
              (SELECT COUNT(*) FROM offers f JOIN seller_profiles p ON p.organization_id = f.seller_organization_id
               WHERE f.request_id = r.id AND p.verification_status = 'approved' AND f.status IN ('submitted', 'shortlisted', 'accepted')) AS offer_count
           FROM marketplace_requests r JOIN organizations o ON o.id = r.agency_organization_id
           WHERE r.agency_organization_id = $1 ORDER BY r.created_at DESC`,
          [request.auth.organization_id],
        );
        return response.json({ requests: (await withStops(pool, result.rows)).map(requestDto) });
      }
      const result = await pool.query(
        `SELECT r.*, o.name AS agency_name, o.verified_at IS NOT NULL AS agency_verified,
          t.match_type,
          (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', hp.id, 'name', hp.name) ORDER BY hp.name), '[]'::jsonb)
           FROM hotel_properties hp WHERE hp.id = ANY(t.matching_property_ids)) AS matching_properties,
          (SELECT COUNT(*) FROM offers f JOIN seller_profiles p ON p.organization_id = f.seller_organization_id
           WHERE f.request_id = r.id AND p.verification_status = 'approved' AND f.status IN ('submitted', 'shortlisted', 'accepted')) AS offer_count,
          mine.id AS my_offer_id,
          (mine.id IS NOT NULL AND mine.status <> 'accepted' AND mine.confirmed_trip_version < r.trip_version) AS needs_reconfirmation,
          change.trip_version AS last_change_version, change.created_at AS last_change_at, change.note AS last_change_note,
          change.previous_trip AS last_change_previous, change.current_trip AS last_change_current
         FROM request_targets t
         JOIN marketplace_requests r ON r.id = t.request_id
         JOIN organizations o ON o.id = r.agency_organization_id
         LEFT JOIN LATERAL (SELECT f.id, f.status, f.confirmed_trip_version FROM offers f
           WHERE f.request_id = r.id AND f.seller_organization_id = t.seller_organization_id
             AND f.status IN ('submitted', 'shortlisted', 'accepted') LIMIT 1) mine ON TRUE
         LEFT JOIN LATERAL (SELECT c.trip_version, c.created_at, c.note, c.previous_trip, c.current_trip FROM request_trip_changes c
           WHERE c.request_id = r.id ORDER BY c.trip_version DESC LIMIT 1) change ON TRUE
         WHERE t.seller_organization_id = $1 AND t.declined_at IS NULL
           AND ${sellerCanSeeRequest}
         ORDER BY r.response_deadline ASC`,
        [request.auth.organization_id],
      );
      const offerLimit = await getMaxOffersPerRequest(pool);
      const negotiations = await loadOpenNegotiations(pool, result.rows.map((row) => row.my_offer_id).filter(Boolean));
      return response.json({ requests: (await withStops(pool, result.rows)).map((row) => ({ ...sellerRequestDto(row, offerLimit), openNegotiation: negotiations.get(row.my_offer_id) ?? null })) });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/requests/:requestId', async (request, response, next) => {
    try {
      if (request.auth.business_type === 'agency') {
        const result = await pool.query(
          `SELECT r.*, o.name AS agency_name, o.verified_at IS NOT NULL AS agency_verified, ${agencyAwardColumns},
                  (SELECT COUNT(*) FROM offers f JOIN seller_profiles p ON p.organization_id = f.seller_organization_id
                   WHERE f.request_id = r.id AND p.verification_status = 'approved' AND f.status IN ('submitted', 'shortlisted', 'accepted')) AS offer_count
           FROM marketplace_requests r JOIN organizations o ON o.id = r.agency_organization_id
           WHERE r.id = $1 AND r.agency_organization_id = $2`,
          [request.params.requestId, request.auth.organization_id],
        );
        if (!result.rowCount) return fail(response, 404, 'REQUEST_NOT_FOUND', 'Request was not found.');
        const invited = await pool.query(
          `SELECT o.id, o.name, o.business_type FROM request_invitations i
           JOIN organizations o ON o.id = i.seller_organization_id
           WHERE i.request_id = $1 ORDER BY o.name`,
          [request.params.requestId],
        );
        const changes = await pool.query('SELECT * FROM request_trip_changes WHERE request_id = $1 ORDER BY trip_version DESC', [request.params.requestId]);
        const [withRoute] = await withStops(pool, result.rows);
        return response.json({ request: { ...requestDto(withRoute), invitedSellers: invited.rows.map((row) => ({ organizationId: row.id, name: row.name, type: row.business_type })), tripChanges: changes.rows.map(tripChangeDto) } });
      }
      const result = await pool.query(
        `SELECT r.seller_visible_snapshot, t.match_type,
           (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', hp.id, 'name', hp.name) ORDER BY hp.name), '[]'::jsonb)
            FROM hotel_properties hp WHERE hp.id = ANY(t.matching_property_ids)) AS matching_properties,
           change.* FROM request_targets t
         JOIN marketplace_requests r ON r.id = t.request_id
         LEFT JOIN LATERAL (SELECT c.trip_version, c.created_at, c.note, c.previous_trip, c.current_trip FROM request_trip_changes c
           WHERE c.request_id = r.id ORDER BY c.trip_version DESC LIMIT 1) change ON TRUE
         WHERE t.request_id = $1 AND t.seller_organization_id = $2 AND t.declined_at IS NULL
           AND ${sellerCanSeeRequest}`,
        [request.params.requestId, request.auth.organization_id],
      );
      if (!result.rowCount) return fail(response, 404, 'REQUEST_NOT_AVAILABLE', 'This request is not available to your organization.');
      const row = result.rows[0];
      return response.json({ request: { ...row.seller_visible_snapshot, matchType: row.match_type ?? null, matchingProperties: row.matching_properties ?? [], tripChange: row.trip_version ? tripChangeDto(row) : null } });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/requests/:requestId/messages', async (request, response, next) => {
    const sellerOrganizationId = request.auth.business_type === 'agency'
      ? request.query.seller_organization_id
      : request.auth.organization_id;
    if (!/^[0-9a-f-]{36}$/i.test(sellerOrganizationId ?? '')) return fail(response, 400, 'VALIDATION_ERROR', 'Choose a matched seller conversation.');
    try {
      const participant = await findConversation(pool, { requestId: request.params.requestId, sellerOrganizationId, organizationId: request.auth.organization_id });
      if (!participant) return fail(response, 404, 'CONVERSATION_NOT_FOUND', 'This request conversation is not available to your organization.');
      const limit = Number(request.query.limit ?? 100);
      const offset = Number(request.query.offset ?? 0);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 10000) return fail(response, 400, 'VALIDATION_ERROR', 'Choose valid message pagination values.');
      const { peerOrganizationId } = participant;
      const [count, messages] = await Promise.all([
        pool.query(
          `SELECT COUNT(*) AS total FROM request_messages
           WHERE request_id = $1 AND ((sender_organization_id = $2 AND recipient_organization_id = $3)
             OR (sender_organization_id = $3 AND recipient_organization_id = $2))`,
          [request.params.requestId, request.auth.organization_id, peerOrganizationId],
        ),
        pool.query(
          `SELECT * FROM (
             SELECT m.id, m.sender_organization_id, sender.name AS sender_name, m.body, m.created_at
             FROM request_messages m JOIN organizations sender ON sender.id = m.sender_organization_id
             WHERE m.request_id = $1 AND ((m.sender_organization_id = $2 AND m.recipient_organization_id = $3)
               OR (m.sender_organization_id = $3 AND m.recipient_organization_id = $2))
             ORDER BY m.created_at DESC, m.id DESC LIMIT $4 OFFSET $5
           ) thread ORDER BY created_at ASC, id ASC`,
          [request.params.requestId, request.auth.organization_id, peerOrganizationId, limit, offset],
        ),
      ]);
      const attachments = await loadAttachments(pool, 'message', messages.rows.map((message) => message.id));
      return response.json({
        requestCode: participant.request_code,
        peerName: participant.peerName,
        messages: messages.rows.map((message) => ({ id: message.id, senderName: message.sender_name, body: message.body, createdAt: message.created_at, isMine: message.sender_organization_id === request.auth.organization_id, attachments: attachments.get(message.id) ?? [] })),
        pagination: { limit, offset, total: Number(count.rows[0].total) },
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/requests/:requestId/messages', requireCapability(capabilities.messageWrite), async (request, response, next) => {
    const sellerOrganizationId = request.auth.business_type === 'agency'
      ? request.body?.seller_organization_id
      : request.auth.organization_id;
    const body = typeof request.body?.body === 'string' ? request.body.body.trim() : '';
    if (!/^[0-9a-f-]{36}$/i.test(sellerOrganizationId ?? '')) return fail(response, 400, 'VALIDATION_ERROR', 'Choose a matched seller conversation.');
    if (!body || body.length > 4000) return fail(response, 400, 'VALIDATION_ERROR', 'Messages must be between 1 and 4000 characters.');
    if (contactDetailsPattern.test(body)) return fail(response, 400, 'CONTACT_DETAILS_NOT_ALLOWED', 'Remove contact details and external links before sending this marketplace message.');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const participant = await findConversation(client, { requestId: request.params.requestId, sellerOrganizationId, organizationId: request.auth.organization_id, lock: true });
      if (!participant) {
        await client.query('ROLLBACK');
        return fail(response, 404, 'CONVERSATION_NOT_FOUND', 'This request conversation is not available to your organization.');
      }
      const recipientOrganizationId = participant.peerOrganizationId;
      const messageId = randomUUID();
      await client.query(
        `INSERT INTO request_messages (id, request_id, sender_organization_id, recipient_organization_id, sender_user_id, body)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [messageId, request.params.requestId, request.auth.organization_id, recipientOrganizationId, request.auth.user_id, body],
      );
      const senderName = participant.callerName;
      await notify(client, recipientOrganizationId, 'request_message', 'New marketplace message', `${participant.request_code} / New message from ${senderName}`, { requestId: request.params.requestId, requestCode: participant.request_code, messageId });
      await client.query('COMMIT');
      return response.status(201).json({ message: { id: messageId, requestId: request.params.requestId, senderName, body, createdAt: new Date().toISOString(), isMine: true, attachments: [] } });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  router.post('/requests', requireCapability(capabilities.requestWrite), async (request, response, next) => {
    if (request.auth.business_type !== 'agency') return fail(response, 403, 'ROLE_FORBIDDEN', 'Only travel agencies can create marketplace requests.');
    const input = validRequest(request.body ?? {});
    if (input.error) return fail(response, 400, input.code ?? 'VALIDATION_ERROR', input.error);
    const id = randomUUID();
    const requestCode = `LX-${randomBytes(4).toString('hex').toUpperCase()}`;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const resolved = await resolveStops(client, input.requirementType, input.stops);
      if (resolved.error) {
        await client.query('ROLLBACK');
        return fail(response, 400, 'VALIDATION_ERROR', resolved.error);
      }
      const destination = resolved.rows[0];
      if (input.invitedSellerIds.length) {
        const eligible = await client.query(
           `SELECT o.id, o.business_type, p.accepting_requests FROM organizations o
           JOIN seller_profiles p ON p.organization_id = o.id
           WHERE o.id = ANY($1::uuid[]) AND o.id <> $2
             AND o.business_type IN ('dmc', 'hotelier') AND p.verification_status = 'approved' AND p.accepting_requests AND ${organizationIsActive('o')}`,
          [input.invitedSellerIds, request.auth.organization_id],
        );
        if (eligible.rowCount !== input.invitedSellerIds.length) {
          await client.query('ROLLBACK');
          return fail(response, 400, 'INVALID_INVITATION', 'Invite only verified, available DMCs and hotels from the supplier directory.');
        }
        const audience = audienceFor(input.requirementType);
        if (eligible.rows.some((row) => row.business_type !== audience)) {
          await client.query('ROLLBACK');
          return fail(response, 409, 'SELLER_TYPE_NOT_ELIGIBLE', `A ${requirementTypes.find((item) => item.value === input.requirementType).label.toLowerCase()} lead can only be sent to ${audience === 'hotelier' ? 'hotels' : 'DMCs'}.`);
        }
      }
      const result = await client.query(
        `INSERT INTO marketplace_requests (
           id, request_code, agency_organization_id, destination, destination_country,
           travel_start_date, travel_end_date, travel_month, nights, adults, children, infants,
           group_type, hotel_category, room_count, meal_plan, services,
           budget_min_minor, budget_max_minor, budget_currency, response_deadline, visibility, destination_id,
           requirement_type, child_ages, special_requests
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)
         RETURNING *`,
        [id, requestCode, request.auth.organization_id, destination.name, destination.country_code,
          input.travelStartDate, input.travelEndDate, input.travelMonth, input.nights, input.adults,
          input.children, input.infants, input.groupType, input.hotelCategory, input.roomCount,
          input.mealPlan, input.services, input.budgetMin, input.budgetMax, input.budgetCurrency,
          input.responseDeadline, input.visibility, destination.id, input.requirementType, input.childAges, input.specialRequests],
      );
      await replaceStops(client, id, input.stops);
      for (const sellerId of input.invitedSellerIds) {
        await client.query('INSERT INTO request_invitations (request_id, seller_organization_id) VALUES ($1, $2)', [id, sellerId]);
      }
      const invited = await client.query(
        `SELECT o.id, o.name, o.business_type FROM request_invitations i
         JOIN organizations o ON o.id = i.seller_organization_id WHERE i.request_id = $1 ORDER BY o.name`,
        [id],
      );
      const [withRoute] = await withStops(client, result.rows);
      await client.query('COMMIT');
      const dto = requestDto({ ...withRoute, agency_name: request.auth.organization_name, agency_verified: request.auth.verified_at });
      return response.status(201).json({ request: { ...dto, invitedSellers: invited.rows.map((row) => ({ organizationId: row.id, name: row.name, type: row.business_type })) } });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  router.post('/requests/audience-preview', requireCapability(capabilities.requestWrite), async (request, response, next) => {
    if (request.auth.business_type !== 'agency') return fail(response, 403, 'ROLE_FORBIDDEN', 'Only travel agencies can preview a lead audience.');
    const body = request.body ?? {};
    if (!requirementTypeValues.has(body.requirement_type)) return fail(response, 400, 'VALIDATION_ERROR', 'Choose whether you need a hotel only or a full itinerary.');
    const stops = validStops(body);
    if (stops.error) return fail(response, 400, 'VALIDATION_ERROR', stops.error);
    const hotelCategory = body.hotel_category == null || body.hotel_category === '' ? null : Number(body.hotel_category);
    if (hotelCategory != null && !hotelCategoryValues.has(hotelCategory)) return fail(response, 400, 'VALIDATION_ERROR', 'Choose a supported hotel category.');
    const groupType = groupTypes.has(body.group_type) ? body.group_type : null;
    const adults = Number(body.adults ?? 0);
    const children = Number(body.children ?? 0);
    const infants = Number(body.infants ?? 0);
    const groupSize = [adults, children, infants].every(Number.isInteger) && adults >= 0 && children >= 0 && infants >= 0 ? adults + children + infants : null;
    const budgetMinMinor = body.budget_min_minor == null || body.budget_min_minor === '' ? null : Number(body.budget_min_minor);
    const budgetMaxMinor = body.budget_max_minor == null || body.budget_max_minor === '' ? null : Number(body.budget_max_minor);
    if ((budgetMinMinor == null) !== (budgetMaxMinor == null) || (budgetMinMinor != null && (!Number.isSafeInteger(budgetMinMinor) || !Number.isSafeInteger(budgetMaxMinor) || budgetMinMinor < 0 || budgetMaxMinor < budgetMinMinor || !isCurrencyCode(body.budget_currency)))) return fail(response, 400, 'VALIDATION_ERROR', 'Provide a valid request budget range and currency.');
    const travelStartDate = validDate(body.travel_start_date) && validDate(body.travel_end_date) && body.travel_end_date > body.travel_start_date ? body.travel_start_date : null;
    const travelEndDate = travelStartDate ? body.travel_end_date : null;
    const roomCount = body.room_count == null || body.room_count === '' ? null : Number(body.room_count);
    if (roomCount != null && (!Number.isInteger(roomCount) || roomCount < 1 || roomCount > 50)) return fail(response, 400, 'VALIDATION_ERROR', 'Room count must be between 1 and 50.');
    try {
      const resolved = await resolveStops(pool, body.requirement_type, stops.stops);
      if (resolved.error) return fail(response, 400, 'VALIDATION_ERROR', resolved.error);
      const audience = await findAudience(pool, {
        requirementType: body.requirement_type,
        destinationIds: stops.stops.map((stop) => stop.destinationId),
        hotelCategory,
        excludeOrganizationId: request.auth.organization_id,
        groupType,
        groupSize,
        budgetMinMinor,
        budgetMaxMinor,
        budgetCurrency: budgetMinMinor == null ? null : String(body.budget_currency).toUpperCase(),
        travelStartDate,
        travelEndDate,
        roomCount,
      });
      return response.json({
        audience: audienceFor(body.requirement_type),
        sellers: audience.length,
        fullMatches: audience.filter((row) => row.match_type === 'full').length,
        partialMatches: audience.filter((row) => row.match_type === 'partial').length,
        properties: audience.reduce((sum, row) => sum + row.matching_property_ids.length, 0),
      });
    } catch (error) {
      return next(error);
    }
  });

  // Copies a lead into a new draft, optionally switching its type (the only way to change type after publishing).
  router.post('/requests/:requestId/repost', requireCapability(capabilities.requestWrite), async (request, response, next) => {
    if (request.auth.business_type !== 'agency') return fail(response, 403, 'ROLE_FORBIDDEN', 'Only the owning agency can repost this request.');
    if (!uuidPattern.test(request.params.requestId)) return fail(response, 404, 'REQUEST_NOT_FOUND', 'Request was not found.');
    const nextType = request.body?.requirement_type;
    if (nextType != null && !requirementTypeValues.has(nextType)) return fail(response, 400, 'VALIDATION_ERROR', 'Choose a supported lead type.');
    const cancelOriginal = request.body?.cancel_original === true;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT * FROM marketplace_requests WHERE id = $1 AND agency_organization_id = $2 FOR UPDATE', [request.params.requestId, request.auth.organization_id]);
      const original = current.rows[0];
      if (!original) {
        await client.query('ROLLBACK');
        return fail(response, 404, 'REQUEST_NOT_FOUND', 'Request was not found.');
      }
      const requirementType = nextType ?? original.requirement_type;
      const originalStops = (await loadStops(client, [original.id])).get(original.id);
      if (!originalStops.length) {
        await client.query('ROLLBACK');
        return fail(response, 409, 'DESTINATION_UNRESOLVED', 'Pick a destination for this lead before reposting it.');
      }
      const hotelServices = serviceOptions.filter((option) => option.allowedFor.includes(requirementType)).map((option) => option.value);
      const services = original.services.filter((service) => hotelServices.includes(service));
      const maxStops = requirementTypes.find((item) => item.value === requirementType).maxDestinations;
      const stops = originalStops.slice(0, maxStops ?? originalStops.length)
        .map((stop) => ({ destinationId: stop.destinationId, nights: maxStops === 1 ? null : stop.nights }));
      const resolved = await resolveStops(client, requirementType, stops);
      if (resolved.error) {
        await client.query('ROLLBACK');
        return fail(response, 409, 'VALIDATION_ERROR', `${resolved.error} Create a new lead instead.`);
      }
      const minimumDeadline = new Date(Date.now() + config.requestDeadline.minHours * hourMs);
      const deadline = new Date(original.response_deadline) > minimumDeadline ? original.response_deadline : new Date(Date.now() + config.requestDeadline.defaultHours * hourMs);
      const id = randomUUID();
      const created = await client.query(
        `INSERT INTO marketplace_requests (
           id, request_code, agency_organization_id, destination, destination_country, destination_id,
           travel_start_date, travel_end_date, travel_month, nights, adults, children, infants,
           group_type, hotel_category, room_count, meal_plan, services,
           budget_min_minor, budget_max_minor, budget_currency, response_deadline, visibility,
           requirement_type, reposted_from_request_id, child_ages, special_requests)
         SELECT $1, $2, agency_organization_id, destination, destination_country, destination_id,
           travel_start_date, travel_end_date, travel_month, nights, adults, children, infants,
           group_type, hotel_category, room_count, meal_plan, $3,
           budget_min_minor, budget_max_minor, budget_currency, $4, 'open', $5, id, child_ages, special_requests
         FROM marketplace_requests WHERE id = $6 RETURNING *`,
        [id, `LX-${randomBytes(4).toString('hex').toUpperCase()}`, services.length ? services : hotelServices.slice(0, 1), deadline, requirementType, original.id],
      );
      await replaceStops(client, id, stops);
      if (cancelOriginal && ['draft', 'open'].includes(original.status)) {
        await client.query("UPDATE marketplace_requests SET status = 'cancelled', closed_at = NOW(), updated_at = NOW() WHERE id = $1", [original.id]);
        const sellers = await client.query('SELECT seller_organization_id FROM request_targets WHERE request_id = $1 AND declined_at IS NULL', [original.id]);
        for (const seller of sellers.rows) {
          await notify(client, seller.seller_organization_id, 'request_cancelled', 'Request cancelled', `${original.request_code} / The agency cancelled this request.`, { requestId: original.id, requestCode: original.request_code });
        }
        await client.query(
          `UPDATE offers SET status = 'withdrawn', outcome_reason = 'Request cancelled by the agency.', updated_at = NOW()
           WHERE request_id = $1 AND status IN ('submitted', 'shortlisted')`,
          [original.id],
        );
      }
      const [withRoute] = await withStops(client, created.rows);
      await client.query('COMMIT');
      return response.status(201).json({ request: requestDto({ ...withRoute, agency_name: request.auth.organization_name, agency_verified: request.auth.verified_at }), originalCancelled: cancelOriginal && ['draft', 'open'].includes(original.status) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  router.post('/requests/:requestId/publish', requireCapability(capabilities.requestWrite), async (request, response, next) => {
    if (request.auth.business_type !== 'agency') return fail(response, 403, 'ROLE_FORBIDDEN', 'Only the owning agency can publish this request.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(
        "SELECT * FROM marketplace_requests WHERE id = $1 AND agency_organization_id = $2 FOR UPDATE",
        [request.params.requestId, request.auth.organization_id],
      );
      if (!current.rowCount) {
        await client.query('ROLLBACK');
        return fail(response, 404, 'REQUEST_NOT_FOUND', 'Request was not found.');
      }
      if (current.rows[0].status !== 'draft') {
        await client.query('ROLLBACK');
        return fail(response, 409, 'REQUEST_NOT_DRAFT', 'Only a draft request can be published.');
      }
      if (new Date(current.rows[0].response_deadline) <= new Date()) {
        await client.query('ROLLBACK');
        return fail(response, 409, 'RESPONSE_DEADLINE_PASSED', 'The response deadline has passed. Create a new request with a future deadline.');
      }
      if (current.rows[0].destination_unresolved) {
        await client.query('ROLLBACK');
        return fail(response, 409, 'DESTINATION_UNRESOLVED', 'Pick a destination from the destination list before publishing.');
      }
      const updated = await client.query(
        `UPDATE marketplace_requests SET status = 'open', published_at = NOW(), updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [request.params.requestId],
      );
      const row = updated.rows[0];
      await client.query(refreshSellerSnapshotSql, [row.id]);
      const targeting = await targetPublishedRequest(client, row.id);
      await client.query(
        'UPDATE destinations SET lead_count = lead_count + 1 WHERE id IN (SELECT destination_id FROM request_destinations WHERE request_id = $1)',
        [row.id],
      );
      const [withRoute] = await withStops(client, [row]);
      await client.query('COMMIT');
      return response.json({
        request: { ...requestDto({ ...withRoute, agency_name: request.auth.organization_name, agency_verified: request.auth.verified_at }), status: 'open' },
        targetedSellerCount: targeting.targets.length,
        alerts: targeting.alerts,
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  router.post('/requests/:requestId/close', requireCapability(capabilities.requestWrite), async (request, response, next) => {
    if (request.auth.business_type !== 'agency') return fail(response, 403, 'ROLE_FORBIDDEN', 'Only the owning agency can close this request.');
    try {
      const result = await pool.query(
        `UPDATE marketplace_requests SET status = 'closed', closed_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND agency_organization_id = $2 AND status = 'open' RETURNING id, request_code`,
        [request.params.requestId, request.auth.organization_id],
      );
      if (!result.rowCount) return fail(response, 404, 'REQUEST_NOT_OPEN', 'Open request was not found.');
      return response.json({ requestId: result.rows[0].id, requestCode: result.rows[0].request_code, status: 'closed' });
    } catch (error) {
      return next(error);
    }
  });

  router.patch('/requests/:requestId/deadline', requireCapability(capabilities.requestWrite), async (request, response, next) => {
    if (request.auth.business_type !== 'agency') return fail(response, 403, 'ROLE_FORBIDDEN', 'Only the owning agency can extend this deadline.');
    if (!uuidPattern.test(request.params.requestId)) return fail(response, 404, 'REQUEST_NOT_FOUND', 'Request was not found.');
    const input = parseWith(deadlineExtensionSchema, request.body);
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    const deadline = validDeadline(input.data.response_deadline);
    if (deadline.error) return fail(response, 400, 'VALIDATION_ERROR', deadline.error);
    if (containsContactDetails(input.data.note)) return fail(response, 400, 'CONTACT_DETAILS_NOT_ALLOWED', 'Remove contact details and external links from the deadline note.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(
        "SELECT id, request_code, response_deadline, status FROM marketplace_requests WHERE id = $1 AND agency_organization_id = $2 FOR UPDATE",
        [request.params.requestId, request.auth.organization_id],
      );
      const row = current.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return fail(response, 404, 'REQUEST_NOT_FOUND', 'Request was not found.');
      }
      if (row.status !== 'open') {
        await client.query('ROLLBACK');
        return fail(response, 409, 'REQUEST_NOT_OPEN', 'Only an open request can have its deadline extended.');
      }
      if (deadline.deadline <= new Date(row.response_deadline)) {
        await client.query('ROLLBACK');
        return fail(response, 400, 'VALIDATION_ERROR', 'Choose a deadline later than the current deadline.');
      }
      const updated = await client.query('UPDATE marketplace_requests SET response_deadline = $2, updated_at = NOW() WHERE id = $1 RETURNING *', [row.id, deadline.deadline]);
      await client.query(
        `INSERT INTO request_deadline_changes (id, request_id, changed_by_user_id, previous_deadline, current_deadline, note)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), row.id, request.auth.user_id, row.response_deadline, deadline.deadline, input.data.note],
      );
      await client.query(refreshSellerSnapshotSql, [row.id]);
      const sellers = await client.query('SELECT seller_organization_id FROM request_targets WHERE request_id = $1 AND declined_at IS NULL', [row.id]);
      for (const seller of sellers.rows) {
        await notify(client, seller.seller_organization_id, 'request_deadline_extended', 'Request deadline extended', `${row.request_code} / New deadline ${deadline.deadline.toISOString()}`, { requestId: row.id, requestCode: row.request_code, responseDeadline: deadline.deadline.toISOString() });
      }
      await client.query('COMMIT');
      return response.json({ requestId: row.id, requestCode: row.request_code, responseDeadline: updated.rows[0].response_deadline });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  router.post('/requests/:requestId/cancel', requireCapability(capabilities.requestWrite), async (request, response, next) => {
    if (request.auth.business_type !== 'agency') return fail(response, 403, 'ROLE_FORBIDDEN', 'Only the owning agency can cancel this request.');
    if (!uuidPattern.test(request.params.requestId)) return fail(response, 404, 'REQUEST_NOT_FOUND', 'Request was not found.');
    const input = parseWith(cancelRequestSchema, request.body ?? {});
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(
        "SELECT id, request_code, status FROM marketplace_requests WHERE id = $1 AND agency_organization_id = $2 FOR UPDATE",
        [request.params.requestId, request.auth.organization_id],
      );
      const row = current.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return fail(response, 404, 'REQUEST_NOT_FOUND', 'Request was not found.');
      }
      if (!['draft', 'open', 'closed'].includes(row.status)) {
        await client.query('ROLLBACK');
        return fail(response, 409, 'REQUEST_CANNOT_BE_CANCELLED', 'An awarded or booked request cannot be cancelled here.');
      }
      await client.query("UPDATE marketplace_requests SET status = 'cancelled', closed_at = NOW(), updated_at = NOW() WHERE id = $1", [row.id]);
      const sellers = await client.query('SELECT seller_organization_id FROM request_targets WHERE request_id = $1 AND declined_at IS NULL', [row.id]);
      for (const seller of sellers.rows) {
        await notify(client, seller.seller_organization_id, 'request_cancelled', 'Request cancelled', `${row.request_code}${input.data.note ? ` / ${input.data.note}` : ''}`, { requestId: row.id, requestCode: row.request_code });
      }
      await client.query(
        `UPDATE offers SET status = 'withdrawn', outcome_reason = $2, updated_at = NOW()
         WHERE request_id = $1 AND status IN ('submitted', 'shortlisted')`,
        [row.id, input.data.note ?? 'Request cancelled by the agency.'],
      );
      await client.query('COMMIT');
      return response.json({ requestId: row.id, requestCode: row.request_code, status: 'cancelled' });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  router.patch('/requests/:requestId/trip', requireCapability(capabilities.requestWrite), async (request, response, next) => {
    if (request.auth.business_type !== 'agency') return fail(response, 403, 'ROLE_FORBIDDEN', 'Only the owning agency can change trip details.');
    if (!uuidPattern.test(request.params.requestId)) return fail(response, 404, 'REQUEST_NOT_FOUND', 'Request was not found.');
    const meta = parseWith(tripChangeSchema, request.body);
    if (meta.error) return fail(response, 400, 'VALIDATION_ERROR', meta.error);
    const trip = validTrip(request.body ?? {});
    if (trip.error) return fail(response, 400, 'VALIDATION_ERROR', trip.error);
    const requestedDeadline = meta.data.response_deadline ? validDeadline(meta.data.response_deadline) : null;
    if (requestedDeadline?.error) return fail(response, 400, 'VALIDATION_ERROR', requestedDeadline.error);
    if (containsContactDetails(meta.data.note)) return fail(response, 400, 'CONTACT_DETAILS_NOT_ALLOWED', 'Remove contact details and external links from the change note.');
    const stopInput = request.body?.destinations != null ? validStops({ destinations: request.body.destinations }) : null;
    if (stopInput?.error) return fail(response, 400, 'VALIDATION_ERROR', stopInput.error);
    const nextTrip = {
      travel_start_date: trip.travelStartDate,
      travel_end_date: trip.travelEndDate,
      travel_month: trip.travelMonth,
      nights: trip.nights,
      adults: trip.adults,
      children: trip.children,
      infants: trip.infants,
      child_ages: trip.childAges,
      special_requests: trip.specialRequests,
      room_count: trip.roomCount,
    };

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(
        `SELECT *, travel_start_date::text AS start_text, travel_end_date::text AS end_text
         FROM marketplace_requests WHERE id = $1 AND agency_organization_id = $2 FOR UPDATE`,
        [request.params.requestId, request.auth.organization_id],
      );
      const row = current.rows[0];
      const reject = async (status, code, message) => {
        await client.query('ROLLBACK');
        return fail(response, status, code, message);
      };
      if (!row) return reject(404, 'REQUEST_NOT_FOUND', 'Request was not found.');
      if (row.status !== 'open') return reject(409, 'REQUEST_NOT_OPEN', 'Trip details can only be changed while the request is open for offers.');
      if (new Date(row.response_deadline) <= new Date()) return reject(409, 'RESPONSE_DEADLINE_PASSED', 'The response deadline has passed, so sellers can no longer re-confirm.');
      if (meta.data.trip_version !== Number(row.trip_version)) return reject(409, 'TRIP_CHANGED', 'These trip details were changed by someone else. Reload the request and try again.');
      if (request.body?.requirement_type != null && request.body.requirement_type !== row.requirement_type) {
        return reject(409, 'REQUIREMENT_TYPE_LOCKED', 'The lead type cannot change after publishing. Cancel this lead and repost it with the other type.');
      }
      const currentStops = (await loadStops(client, [row.id])).get(row.id);
      const stops = stopInput?.stops ?? currentStops.map((stop) => ({ destinationId: stop.destinationId, nights: stop.nights }));
      const requirement = validRequirement(row.requirement_type, row.services, stops, nextTrip.nights);
      if (requirement.code === 'REQUIREMENT_TYPE_MISMATCH') return reject(409, 'REQUIREMENT_TYPE_LOCKED', `${requirement.error} The lead type cannot change after publishing.`);
      if (requirement.error) return reject(400, 'VALIDATION_ERROR', requirement.error);
      if (stopInput) {
        const resolved = await resolveStops(client, row.requirement_type, stops);
        if (resolved.error) return reject(400, 'VALIDATION_ERROR', resolved.error);
      }
      const previousTrip = { ...tripFields({ ...row, travel_start_date: row.start_text, travel_end_date: row.end_text }), destinations: currentStops.map((stop) => ({ destination_id: stop.destinationId, name: stop.name, nights: stop.nights })) };
      const destinationsChanged = !isDeepStrictEqual(
        currentStops.map((stop) => [stop.destinationId, stop.nights]),
        stops.map((stop) => [stop.destinationId, stop.nights]),
      );
      const comparableNext = { ...nextTrip, destinations: previousTrip.destinations };
      if (isDeepStrictEqual(previousTrip, comparableNext) && !destinationsChanged) return reject(400, 'NO_TRIP_CHANGES', 'Change the dates, travellers, rooms or destinations before saving.');
      const currentDeadline = new Date(row.response_deadline);
      if (requestedDeadline && requestedDeadline.deadline < currentDeadline) return reject(400, 'VALIDATION_ERROR', 'After publishing, the response deadline can be extended but not shortened.');
      const deadline = requestedDeadline?.deadline ?? currentDeadline;
      if (deadline < new Date(Date.now() + config.requestDeadline.minHours * hourMs)) {
        return reject(409, 'DEADLINE_TOO_CLOSE', `Sellers need at least ${config.requestDeadline.minHours} hour(s) to re-confirm. Extend the response deadline with this change.`);
      }

      const updated = await client.query(
        `UPDATE marketplace_requests SET travel_start_date = $2, travel_end_date = $3, travel_month = $4, nights = $5,
           adults = $6, children = $7, infants = $8, child_ages = $9, special_requests = $10, room_count = $11, response_deadline = $12,
           trip_version = trip_version + 1, trip_changed_at = NOW(), updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [row.id, nextTrip.travel_start_date, nextTrip.travel_end_date, nextTrip.travel_month, nextTrip.nights,
          nextTrip.adults, nextTrip.children, nextTrip.infants, nextTrip.child_ages, nextTrip.special_requests, nextTrip.room_count, deadline],
      );
      const changed = updated.rows[0];
      let routing = null;
      if (destinationsChanged) {
        await replaceStops(client, row.id, stops);
        const primary = (await resolveActiveDestinations(client, [stops[0].destinationId])).rows[0];
        await client.query(
          'UPDATE marketplace_requests SET destination_id = $2, destination = $3, destination_country = $4 WHERE id = $1',
          [row.id, primary.id, primary.name, primary.country_code],
        );
        Object.assign(changed, { destination_id: primary.id, destination: primary.name, destination_country: primary.country_code });
        await client.query(
          'UPDATE destinations SET lead_count = lead_count + 1 WHERE id IN (SELECT destination_id FROM request_destinations WHERE request_id = $1) AND NOT (id = ANY($2::uuid[]))',
          [row.id, currentStops.map((stop) => stop.destinationId)],
        );
      }
      const newStops = (await loadStops(client, [row.id])).get(row.id);
      nextTrip.destinations = newStops.map((stop) => ({ destination_id: stop.destinationId, name: stop.name, nights: stop.nights }));
      const change = await client.query(
        `INSERT INTO request_trip_changes (id, request_id, trip_version, changed_by_user_id, previous_trip, current_trip, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [randomUUID(), row.id, changed.trip_version, request.auth.user_id, JSON.stringify(previousTrip), JSON.stringify(nextTrip), meta.data.note],
      );
      await client.query(refreshSellerSnapshotSql, [row.id]);
      if (destinationsChanged) routing = await rerouteRequest(client, row.id);
      const sellers = await client.query(
        `SELECT t.seller_organization_id, EXISTS (SELECT 1 FROM offers f WHERE f.request_id = t.request_id
           AND f.seller_organization_id = t.seller_organization_id AND f.status IN ('submitted', 'shortlisted')) AS has_offer
         FROM request_targets t
         WHERE t.request_id = $1 AND t.declined_at IS NULL AND NOT (t.seller_organization_id = ANY($2::uuid[]))`,
        [row.id, routing?.newlyMatched ?? []],
      );
      const summary = tripDto(nextTrip);
      for (const seller of sellers.rows) {
        await notify(client, seller.seller_organization_id, 'request_trip_changed',
          seller.has_offer ? 'Trip changed: re-confirm your offer' : 'Trip details changed',
          `${row.request_code} / ${routeLabel(newStops) || changed.destination} / ${summary.dates} / ${summary.travelers}`,
          { requestId: row.id, requestCode: row.request_code, tripVersion: changed.trip_version });
      }
      await client.query('COMMIT');
      return response.json({
        request: { ...requestDto({ ...changed, stops: newStops, agency_name: request.auth.organization_name, agency_verified: request.auth.verified_at }), tripChange: tripChangeDto(change.rows[0]) },
        offersAwaitingReconfirmation: sellers.rows.filter((seller) => seller.has_offer).length,
        routing: routing ? { newlyMatched: routing.newlyMatched.length, removed: routing.removed.length, grandfathered: routing.grandfathered.length } : null,
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  router.post('/requests/:requestId/decline', requireCapability(capabilities.offerWrite), async (request, response, next) => {
    if (!['dmc', 'hotelier'].includes(request.auth.business_type)) return fail(response, 403, 'ROLE_FORBIDDEN', 'Only matched sellers can decline a request.');
    const reason = typeof request.body?.reason === 'string' ? request.body.reason.trim() : '';
    if (reason.length < 5 || reason.length > 300) return fail(response, 400, 'VALIDATION_ERROR', 'Provide a decline reason between 5 and 300 characters.');
    try {
      const result = await pool.query(
        `UPDATE request_targets SET declined_at = NOW(), decline_reason = $3
         WHERE request_id = $1 AND seller_organization_id = $2 AND declined_at IS NULL
           AND EXISTS (SELECT 1 FROM marketplace_requests r WHERE r.id = request_targets.request_id AND r.status = 'open')
         RETURNING request_id`,
        [request.params.requestId, request.auth.organization_id, reason],
      );
      if (!result.rowCount) return fail(response, 404, 'REQUEST_NOT_AVAILABLE', 'This targeted request was not found.');
      return response.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  router.post('/requests/:requestId/offers', requireCapability(capabilities.offerWrite), async (request, response, next) => {
    const isDmc = request.auth.business_type === 'dmc';
    const isHotelier = request.auth.business_type === 'hotelier';
    if (!isDmc && !isHotelier) return fail(response, 403, 'ROLE_FORBIDDEN', 'Only DMCs and hoteliers can submit seller offers.');
    const offerKind = isDmc ? 'land_package' : 'hotel_room';
    const input = parseWith(offerSchemaFor(offerKind), request.body);
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    const offerInput = input.data;
    const acknowledgedTripVersion = parseTripVersion(request.body?.trip_version);
    if (acknowledgedTripVersion === undefined) return fail(response, 400, 'VALIDATION_ERROR', 'Trip version must be a positive whole number.');
    const requestedPropertyId = request.body?.hotel_property_id ?? null;
    if (requestedPropertyId != null && (typeof requestedPropertyId !== 'string' || !uuidPattern.test(requestedPropertyId))) return fail(response, 400, 'VALIDATION_ERROR', 'Choose one of your hotels for this offer.');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const profile = await client.query('SELECT verification_status FROM seller_profiles WHERE organization_id = $1', [request.auth.organization_id]);
      if (profile.rows[0]?.verification_status !== 'approved') {
        await client.query('ROLLBACK');
        return fail(response, 403, 'SELLER_NOT_VERIFIED', 'Your seller profile must be verified before submitting offers.');
      }
      const target = await client.query(
        `SELECT r.id, r.agency_organization_id, r.request_code, r.destination, r.services, r.response_deadline,
                r.adults, r.children, r.nights, r.room_count, r.trip_version, r.requirement_type,
                t.match_type, t.matching_property_ids
         FROM request_targets t JOIN marketplace_requests r ON r.id = t.request_id
         WHERE t.request_id = $1 AND t.seller_organization_id = $2 AND t.declined_at IS NULL AND r.status = 'open'
         FOR UPDATE OF r`,
        [request.params.requestId, request.auth.organization_id],
      );
      if (!target.rowCount || audienceFor(target.rows[0].requirement_type) !== request.auth.business_type) {
        await client.query('ROLLBACK');
        return fail(response, 404, 'REQUEST_NOT_AVAILABLE', 'This request is not available to your organization.');
      }
      if (acknowledgedTripVersion != null && acknowledgedTripVersion !== Number(target.rows[0].trip_version)) {
        await client.query('ROLLBACK');
        return fail(response, 409, 'TRIP_CHANGED', 'The agency changed the trip details. Review the latest details before sending your offer.');
      }
      if (new Date(target.rows[0].response_deadline) <= new Date()) {
        await client.query('ROLLBACK');
        return fail(response, 409, 'RESPONSE_DEADLINE_PASSED', 'The response deadline for this request has passed.');
      }
      let hotelPropertyId = null;
      if (isHotelier) {
        // Invited hotels may offer any approved property; matched hotels only the properties in the requested area.
        const eligibleProperties = await client.query(
          `SELECT id FROM hotel_properties WHERE organization_id = $1 AND active AND verification_status = 'approved'
             AND ($2::boolean OR id = ANY($3::uuid[])) ORDER BY created_at, id`,
          [request.auth.organization_id, target.rows[0].match_type === 'invited', target.rows[0].matching_property_ids],
        );
        const eligibleIds = eligibleProperties.rows.map((row) => row.id);
        hotelPropertyId = requestedPropertyId ?? (eligibleIds.length === 1 ? eligibleIds[0] : null);
        if (!hotelPropertyId || !eligibleIds.includes(hotelPropertyId)) {
          await client.query('ROLLBACK');
          return fail(response, 400, 'HOTEL_PROPERTY_REQUIRED', 'Choose which of your matching hotels this offer is for.');
        }
        const perOrganization = await getSetting(client, 'max_offers_per_hotel_org_per_request');
        const ownOffers = await client.query(
          "SELECT COUNT(*) AS total FROM offers WHERE request_id = $1 AND seller_organization_id = $2 AND status IN ('submitted', 'shortlisted', 'accepted')",
          [request.params.requestId, request.auth.organization_id],
        );
        if (Number(ownOffers.rows[0].total) >= perOrganization) {
          await client.query('ROLLBACK');
          return fail(response, 409, 'OFFER_ALREADY_SUBMITTED', `Your organization can send at most ${perOrganization} offer(s) for this request.`);
        }
      }
      const offerLimit = await getMaxOffersPerRequest(client);
      const activeOffers = await client.query(
        `SELECT COUNT(*) AS total FROM offers f JOIN seller_profiles p ON p.organization_id = f.seller_organization_id
         WHERE f.request_id = $1 AND p.verification_status = 'approved' AND f.status IN ('submitted', 'shortlisted', 'accepted')`,
        [request.params.requestId],
      );
      if (Number(activeOffers.rows[0].total) >= offerLimit) {
        await client.query('ROLLBACK');
        return fail(response, 409, 'OFFER_LIMIT_REACHED', `This request already has the maximum of ${offerLimit} offers.`);
      }
      const result = await client.query(
        `INSERT INTO offers (id, request_id, seller_organization_id, offer_kind, total_minor, rate_per_night_minor,
           room_type, currency, inclusions, exclusions, meal_plan, validity_until, cancellation_policy,
           free_cancellation_until, deposit_percent, balance_due_days_before_travel, payment_notes,
           room_count, taxes_included, availability_confirmed, confirmed_trip_version, hotel_category, option_label, hotel_property_id, itinerary)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
         RETURNING *`,
        [randomUUID(), request.params.requestId, request.auth.organization_id, offerKind,
          offerInput.total_minor ?? null, offerInput.rate_per_night_minor ?? null, offerInput.room_type ?? null,
          offerInput.currency, offerInput.inclusions, offerInput.exclusions, offerInput.meal_plan ?? null, offerInput.validity_until,
          offerInput.cancellation_policy, offerInput.free_cancellation_until, offerInput.deposit_percent,
          offerInput.balance_due_days_before_travel, offerInput.payment_notes, offerInput.room_count ?? null,
          offerInput.taxes_included ?? null, offerInput.availability_confirmed ?? null, target.rows[0].trip_version,
          offerInput.hotel_category ?? null, offerInput.option_label, hotelPropertyId, JSON.stringify(offerInput.itinerary ?? [])],
      );
      const offer = result.rows[0];
      await replaceLineItems(client, offer.id, offerInput.line_items ?? [], randomUUID);
      await replaceOptions(client, offer.id, offerInput.options, randomUUID);
      const parts = await loadOfferParts(client, [offer.id]);
      await notify(client, target.rows[0].agency_organization_id, 'offer_submitted', 'New seller offer', `${target.rows[0].request_code} / ${request.auth.organization_name} / ${target.rows[0].destination}`, { requestId: request.params.requestId, requestCode: target.rows[0].request_code, offerId: offer.id });
      await client.query('COMMIT');
      return response.status(201).json({ offer: offerDto(offer, { ...parts(offer.id), request: target.rows[0] }) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error.code === '23505') return fail(response, 409, 'OFFER_ALREADY_SUBMITTED', 'Your organization already has an active offer for this request (and hotel).');
      return next(error);
    } finally {
      client.release();
    }
  });

  router.get('/offer-library', async (request, response, next) => {
    if (request.auth.business_type !== 'dmc') return fail(response, 403, 'ROLE_FORBIDDEN', 'Only DMCs can access the offer library.');
    try {
      const result = await pool.query(
        'SELECT id, library_type, name, payload, created_at, updated_at FROM dmc_offer_library WHERE organization_id = $1 ORDER BY updated_at DESC, name',
        [request.auth.organization_id],
      );
      return response.json({ items: result.rows.map((row) => ({ id: row.id, type: row.library_type, name: row.name, payload: row.payload, createdAt: row.created_at, updatedAt: row.updated_at })) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/offer-library', requireCapability(capabilities.offerWrite), async (request, response, next) => {
    if (request.auth.business_type !== 'dmc') return fail(response, 403, 'ROLE_FORBIDDEN', 'Only DMCs can save offer drafts and templates.');
    const input = parseWith(offerLibrarySchema, request.body);
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    try {
      const result = await pool.query(
        `INSERT INTO dmc_offer_library (id, organization_id, library_type, name, payload)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, library_type, name, payload, created_at, updated_at`,
        [randomUUID(), request.auth.organization_id, input.data.library_type, input.data.name, JSON.stringify(input.data.payload)],
      );
      const row = result.rows[0];
      return response.status(201).json({ item: { id: row.id, type: row.library_type, name: row.name, payload: row.payload, createdAt: row.created_at, updatedAt: row.updated_at } });
    } catch (error) {
      return next(error);
    }
  });

  router.delete('/offer-library/:itemId', requireCapability(capabilities.offerWrite), async (request, response, next) => {
    if (request.auth.business_type !== 'dmc') return fail(response, 403, 'ROLE_FORBIDDEN', 'Only DMCs can manage the offer library.');
    try {
      const result = await pool.query('DELETE FROM dmc_offer_library WHERE id = $1 AND organization_id = $2', [request.params.itemId, request.auth.organization_id]);
      if (!result.rowCount) return fail(response, 404, 'OFFER_LIBRARY_ITEM_NOT_FOUND', 'Saved offer was not found.');
      return response.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  router.get('/requests/:requestId/offers', async (request, response, next) => {
    if (request.auth.business_type !== 'agency') return fail(response, 403, 'ROLE_FORBIDDEN', 'Only the requesting agency can compare offers.');
    const matchFilter = typeof request.query.match_type === 'string' ? request.query.match_type : null;
    try {
      const ownedRequest = await pool.query('SELECT id, request_code, destination, travel_start_date, travel_end_date, travel_month, adults, children, nights, room_count, trip_version, published_at FROM marketplace_requests WHERE id = $1 AND agency_organization_id = $2', [request.params.requestId, request.auth.organization_id]);
      if (!ownedRequest.rowCount) return fail(response, 404, 'REQUEST_NOT_FOUND', 'Request was not found.');
      const result = await pool.query(
        `SELECT f.*, seller.name AS seller_name, target.match_type, property.name AS hotel_property_name
         FROM offers f JOIN organizations seller ON seller.id = f.seller_organization_id
         JOIN seller_profiles profile ON profile.organization_id = seller.id
         LEFT JOIN request_targets target ON target.request_id = f.request_id AND target.seller_organization_id = f.seller_organization_id
         LEFT JOIN hotel_properties property ON property.id = f.hotel_property_id
         WHERE f.request_id = $1 AND profile.verification_status = 'approved'
           AND f.status IN ('submitted', 'shortlisted', 'accepted')
           AND ($2::text IS NULL OR target.match_type = $2)
         ORDER BY f.created_at ASC`,
        [request.params.requestId, matchFilter],
      );
      const parts = await loadOfferParts(pool, result.rows.map((row) => row.id));
      const comparisonCurrency = config.defaultCurrency;
      const rates = await loadComparisonRates(pool, result.rows.map((offer) => offer.currency), { quoteCurrency: comparisonCurrency, fetchImpl: comparisonRateFetch });
      const offers = result.rows.map((offer) => {
        const dto = offerDto(offer, { ...parts(offer.id), request: ownedRequest.rows[0], sellerName: offer.seller_name });
        const exchangeRate = rates.get(offer.currency);
        const comparisonTotalMinor = exchangeRate ? convertMinorUnits(dto.estimatedTotalMinor, exchangeRate.rate, offer.currency, comparisonCurrency) : null;
        const comparisonPerTravellerMinor = comparisonTotalMinor != null && dto.travellers > 0 ? Math.round(comparisonTotalMinor / dto.travellers) : null;
        const options = dto.options.map((option) => {
          const total = exchangeRate ? convertMinorUnits(option.estimatedTotalMinor, exchangeRate.rate, offer.currency, comparisonCurrency) : null;
          return { ...option, comparisonTotalMinor: total, comparisonPerTravellerMinor: total != null && option.travellers > 0 ? Math.round(total / option.travellers) : null };
        });
        return {
          ...dto,
          requestCode: ownedRequest.rows[0].request_code,
          destination: ownedRequest.rows[0].destination,
          options,
          comparisonTotalMinor,
          comparisonPerTravellerMinor,
          comparisonCurrency,
          exchangeRate,
          comparisonLabels: [],
        };
      });
      const validPrices = offers.filter((offer) => offer.comparisonTotalMinor != null);
      if (validPrices.length === offers.length && offers.length) {
        const lowest = Math.min(...validPrices.map((offer) => offer.comparisonTotalMinor));
        for (const offer of offers) if (offer.comparisonTotalMinor === lowest) offer.comparisonLabels.push('lowest');
      }
      const hasInclusionData = offers.some((offer) => offer.inclusions.length || offer.exclusions.length);
      if (hasInclusionData) {
        const mostInclusions = Math.max(...offers.map((offer) => offer.inclusions.length));
        const fewestExclusions = Math.min(...offers.filter((offer) => offer.inclusions.length === mostInclusions).map((offer) => offer.exclusions.length));
        for (const offer of offers) {
          if (offer.inclusions.length === mostInclusions && offer.exclusions.length === fewestExclusions) offer.comparisonLabels.push('most_inclusive');
        }
      }
      return response.json({ offers, comparisonCurrency });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/offers/:offerId/shortlist', requireCapability(capabilities.requestWrite), async (request, response, next) => {
    if (request.auth.business_type !== 'agency') return fail(response, 403, 'ROLE_FORBIDDEN', 'Only the requesting agency can shortlist an offer.');
    if (!uuidPattern.test(request.params.offerId)) return fail(response, 404, 'OFFER_NOT_FOUND', 'Offer was not found.');
    if (typeof request.body?.shortlisted !== 'boolean') return fail(response, 400, 'VALIDATION_ERROR', 'Choose whether this offer is shortlisted.');
    try {
      const result = await pool.query(
        `UPDATE offers f SET status = $3, updated_at = NOW()
         FROM marketplace_requests r
         WHERE f.id = $1 AND f.request_id = r.id AND r.agency_organization_id = $2
           AND r.status IN ('open', 'closed') AND f.status IN ('submitted', 'shortlisted')
           AND (f.status = CASE WHEN $3 = 'shortlisted' THEN 'submitted' ELSE 'shortlisted' END
             OR f.status = $3)
         RETURNING f.id, f.status`,
        [request.params.offerId, request.auth.organization_id, request.body.shortlisted ? 'shortlisted' : 'submitted'],
      );
      if (!result.rowCount) return fail(response, 404, 'OFFER_NOT_AVAILABLE', 'This active offer is not available to shortlist.');
      return response.json({ offerId: result.rows[0].id, status: result.rows[0].status, shortlisted: result.rows[0].status === 'shortlisted' });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/offers/:offerId', async (request, response, next) => {
    try {
      const result = await pool.query(
        `SELECT f.*, r.agency_organization_id, r.request_code, r.destination, r.travel_start_date, r.travel_end_date, r.travel_month, r.adults, r.children, r.nights,
                r.room_count AS request_room_count, r.trip_version, seller.name AS seller_name, property.name AS hotel_property_name
         FROM offers f JOIN marketplace_requests r ON r.id = f.request_id
         JOIN organizations seller ON seller.id = f.seller_organization_id
         LEFT JOIN hotel_properties property ON property.id = f.hotel_property_id
         WHERE f.id = $1`,
        [request.params.offerId],
      );
      const offer = result.rows[0];
      if (!offer) return fail(response, 404, 'OFFER_NOT_FOUND', 'Offer was not found.');
      const isOwnSellerOffer = offer.seller_organization_id === request.auth.organization_id;
      const isRequestingAgency = offer.agency_organization_id === request.auth.organization_id && request.auth.business_type === 'agency';
      if (!isOwnSellerOffer && !isRequestingAgency) return fail(response, 404, 'OFFER_NOT_FOUND', 'Offer was not found.');
      const parts = await loadOfferParts(pool, [offer.id]);
      const requestFacts = { adults: offer.adults, children: offer.children, nights: offer.nights, room_count: offer.request_room_count, trip_version: offer.trip_version };
      return response.json({ offer: { ...offerDto(offer, { ...parts(offer.id), request: requestFacts, sellerName: isRequestingAgency ? offer.seller_name : undefined }), requestCode: offer.request_code, destination: offer.destination } });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/offers/:offerId/export/aviat-crm', requireCapability(capabilities.requestWrite), async (request, response, next) => {
    if (request.auth.business_type !== 'agency') return fail(response, 403, 'ROLE_FORBIDDEN', 'Only the requesting agency can export an offer to Aviat CRM.');
    const input = parseWith(aviatCrmExportSchema, request.body ?? {});
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    try {
      const result = await pool.query(
        `SELECT f.*, r.agency_organization_id, r.request_code, r.destination, r.destination_country,
                r.travel_start_date::text AS travel_start_date, r.travel_end_date::text AS travel_end_date,
                r.travel_month, r.nights, r.adults, r.children, r.room_count AS request_room_count,
                r.trip_version, seller.name AS seller_name
         FROM offers f JOIN marketplace_requests r ON r.id = f.request_id
         JOIN organizations seller ON seller.id = f.seller_organization_id
         WHERE f.id = $1 AND r.agency_organization_id = $2 AND f.status IN ('submitted', 'shortlisted', 'accepted')`,
        [request.params.offerId, request.auth.organization_id],
      );
      const offerRow = result.rows[0];
      if (!offerRow) return fail(response, 404, 'OFFER_NOT_FOUND', 'Offer was not found.');

      const parts = await loadOfferParts(pool, [offerRow.id]);
      const dto = offerDto(offerRow, { ...parts(offerRow.id), request: requestFactsOf(offerRow), sellerName: offerRow.seller_name });
      const selectedOption = input.data.offer_option_id
        ? dto.options.find((option) => option.id === input.data.offer_option_id)
        : null;
      if (input.data.offer_option_id && !selectedOption) return fail(response, 400, 'OPTION_NOT_AVAILABLE', 'Choose an option included in this offer.');
      const selectedPrice = selectedOption ?? dto;
      const costMinor = selectedPrice.estimatedTotalMinor ?? selectedPrice.totalMinor ?? selectedPrice.ratePerNightMinor;
      if (!Number.isSafeInteger(costMinor) || costMinor < 0) return fail(response, 422, 'OFFER_PRICE_MISSING', 'This offer does not have a valid total price to export.');

      const multiplier = 1 + input.data.markup_percentage / 100;
      const priceMinor = Math.round(costMinor * multiplier);
      if (!Number.isSafeInteger(priceMinor)) return fail(response, 400, 'VALIDATION_ERROR', 'Markup produces a price outside the supported range.');
      const fractionDigits = new Intl.NumberFormat('en', { style: 'currency', currency: dto.currency }).resolvedOptions().maximumFractionDigits;
      const minorUnit = 10 ** fractionDigits;
      const itineraryDays = dto.itinerary.map((day, index) => ({
        day_number: Number(day.day) || index + 1,
        title: String(day.title ?? ''),
        activities: [day.destination, day.description].filter(Boolean).join(' / '),
        meals: '',
      }));
      const travelLabel = offerRow.travel_start_date && offerRow.travel_end_date
        ? `${dateText(offerRow.travel_start_date)} - ${dateText(offerRow.travel_end_date)}`
        : offerRow.travel_month;
      const title = [offerRow.request_code, offerRow.destination, travelLabel, offerRow.seller_name].filter(Boolean).join(' / ');
      let crmItinerary;
      try {
        crmItinerary = await crmItineraryCreate({
          apiBaseUrl: input.data.api_base_url,
          accessToken: input.data.access_token,
          itinerary: {
            title,
            destination: offerRow.destination,
            total_days: itineraryDays.length || Number(offerRow.nights) || null,
            status: 'draft',
            total_cost: Number((costMinor / minorUnit).toFixed(fractionDigits)),
            margin_percentage: input.data.markup_percentage,
            price_total: Number((priceMinor / minorUnit).toFixed(fractionDigits)),
            currency: dto.currency,
            days: itineraryDays,
          },
        });
      } catch {
        return fail(response, 502, 'CRM_EXPORT_FAILED', 'Aviat CRM export failed. Verify the API URL, access token, and itinerary permissions.');
      }
      return response.status(201).json({ crmItinerary: { ...crmItinerary, title }, priceTotalMinor: priceMinor, currency: dto.currency });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/offers/:offerId/revisions', async (request, response, next) => {
    try {
      const owner = await pool.query(
        `SELECT f.seller_organization_id, r.agency_organization_id FROM offers f
         JOIN marketplace_requests r ON r.id = f.request_id WHERE f.id = $1`,
        [request.params.offerId],
      );
      if (!owner.rowCount || (owner.rows[0].seller_organization_id !== request.auth.organization_id && owner.rows[0].agency_organization_id !== request.auth.organization_id)) return fail(response, 404, 'OFFER_NOT_FOUND', 'Offer was not found.');
      const result = await pool.query('SELECT revision_number, snapshot, created_at FROM offer_revisions WHERE offer_id = $1 ORDER BY revision_number DESC', [request.params.offerId]);
      return response.json({ revisions: result.rows.map((revision) => ({ revision: revision.revision_number, snapshot: revision.snapshot, createdAt: revision.created_at })) });
    } catch (error) {
      return next(error);
    }
  });

  router.put('/offers/:offerId', requireCapability(capabilities.offerWrite), async (request, response, next) => {
    if (!['dmc', 'hotelier'].includes(request.auth.business_type)) return fail(response, 403, 'ROLE_FORBIDDEN', 'Only the seller can revise its offer.');
    const offerKind = request.auth.business_type === 'dmc' ? 'land_package' : 'hotel_room';
    const input = parseWith(offerSchemaFor(offerKind), request.body);
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    const offerInput = input.data;
    const acknowledgedTripVersion = parseTripVersion(request.body?.trip_version);
    if (acknowledgedTripVersion === undefined) return fail(response, 400, 'VALIDATION_ERROR', 'Trip version must be a positive whole number.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(
        `SELECT f.*, r.agency_organization_id, r.response_deadline, r.adults, r.children, r.nights,
                r.room_count AS request_room_count, r.trip_version, r.status AS request_status,
                (SELECT n.id FROM offer_negotiations n WHERE n.offer_id = f.id AND n.status = 'open') AS open_negotiation_id
         FROM offers f JOIN marketplace_requests r ON r.id = f.request_id
         WHERE f.id = $1 AND f.seller_organization_id = $2 AND r.status IN ('open', 'closed')
           AND f.status IN ('submitted', 'shortlisted') FOR UPDATE OF f`,
        [request.params.offerId, request.auth.organization_id],
      );
      const answersNegotiation = Boolean(current.rows[0]?.open_negotiation_id);
      // An agency's open revision request or counter-offer lets the seller answer after the deadline.
      if (!current.rowCount || (current.rows[0].request_status !== 'open' && !answersNegotiation)) {
        await client.query('ROLLBACK');
        return fail(response, 404, 'OFFER_NOT_EDITABLE', 'This active offer was not found.');
      }
      const oldOffer = current.rows[0];
      if (!answersNegotiation && new Date(oldOffer.response_deadline) <= new Date()) {
        await client.query('ROLLBACK');
        return fail(response, 409, 'RESPONSE_DEADLINE_PASSED', 'Offers cannot be revised after the response deadline.');
      }
      if (oldOffer.offer_kind !== offerKind) {
        await client.query('ROLLBACK');
        return fail(response, 403, 'ROLE_FORBIDDEN', 'This offer type does not belong to your seller role.');
      }
      if (acknowledgedTripVersion != null && acknowledgedTripVersion !== Number(oldOffer.trip_version)) {
        await client.query('ROLLBACK');
        return fail(response, 409, 'TRIP_CHANGED', 'The agency changed the trip details again. Review the latest details before revising.');
      }
      // A revision only re-confirms the offer when the seller says which trip version it priced.
      const confirmedTripVersion = acknowledgedTripVersion ?? oldOffer.confirmed_trip_version;
      const reconfirmed = confirmedTripVersion > oldOffer.confirmed_trip_version;
      const requestFacts = requestFactsOf(oldOffer);
      await recordOfferRevision(client, oldOffer, requestFacts);
      const revised = await client.query(
        `UPDATE offers SET total_minor = $2, rate_per_night_minor = $3, room_type = $4,
           currency = $5, inclusions = $6, exclusions = $7, meal_plan = $8,
           cancellation_policy = $9, validity_until = $10, free_cancellation_until = $11,
           deposit_percent = $12, balance_due_days_before_travel = $13, payment_notes = $14,
           room_count = $15, taxes_included = $16, availability_confirmed = $17,
           confirmed_trip_version = $18, reconfirmed_at = CASE WHEN $19 THEN NOW() ELSE reconfirmed_at END,
           hotel_category = $20, option_label = $21,
           itinerary = $22,
           status = 'submitted', updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [oldOffer.id, offerInput.total_minor ?? null, offerInput.rate_per_night_minor ?? null, offerInput.room_type ?? null,
          offerInput.currency, offerInput.inclusions, offerInput.exclusions, offerInput.meal_plan ?? null,
          offerInput.cancellation_policy, offerInput.validity_until, offerInput.free_cancellation_until,
          offerInput.deposit_percent, offerInput.balance_due_days_before_travel, offerInput.payment_notes,
          offerInput.room_count ?? null, offerInput.taxes_included ?? null, offerInput.availability_confirmed ?? null,
          confirmedTripVersion, reconfirmed, offerInput.hotel_category ?? null, offerInput.option_label, JSON.stringify(offerInput.itinerary ?? [])],
      );
      await replaceLineItems(client, oldOffer.id, offerInput.line_items ?? [], randomUUID);
      await replaceOptions(client, oldOffer.id, offerInput.options, randomUUID);
      if (answersNegotiation) {
        await client.query("UPDATE offer_negotiations SET status = 'revised', responded_by_user_id = $2, responded_at = NOW() WHERE id = $1", [oldOffer.open_negotiation_id, request.auth.user_id]);
      }
      const parts = await loadOfferParts(client, [oldOffer.id]);
      const revisedTitle = answersNegotiation ? 'Seller revised an offer as you asked' : reconfirmed ? 'Seller revised an offer for the changed trip' : 'Seller revised an offer';
      await notify(client, oldOffer.agency_organization_id, 'offer_revised', revisedTitle, `${oldOffer.request_id} / ${request.auth.organization_name}`, { offerId: oldOffer.id, requestId: oldOffer.request_id });
      await client.query('COMMIT');
      return response.json({ offer: offerDto(revised.rows[0], { ...parts(oldOffer.id), request: requestFacts }) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  router.post('/offers/:offerId/reconfirm', requireCapability(capabilities.offerWrite), async (request, response, next) => {
    if (!['dmc', 'hotelier'].includes(request.auth.business_type)) return fail(response, 403, 'ROLE_FORBIDDEN', 'Only the seller can re-confirm its offer.');
    if (!uuidPattern.test(request.params.offerId)) return fail(response, 404, 'OFFER_NOT_EDITABLE', 'This active offer was not found.');
    const acknowledgedTripVersion = parseTripVersion(request.body?.trip_version);
    if (acknowledgedTripVersion == null) return fail(response, 400, 'VALIDATION_ERROR', 'Send the trip version you are re-confirming.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(
        `SELECT f.*, r.agency_organization_id, r.request_code, r.destination, r.response_deadline, r.adults, r.children, r.nights,
                r.room_count AS request_room_count, r.trip_version
         FROM offers f JOIN marketplace_requests r ON r.id = f.request_id
         WHERE f.id = $1 AND f.seller_organization_id = $2 AND r.status = 'open'
           AND f.status IN ('submitted', 'shortlisted') FOR UPDATE OF f`,
        [request.params.offerId, request.auth.organization_id],
      );
      const offer = current.rows[0];
      const reject = async (status, code, message) => {
        await client.query('ROLLBACK');
        return fail(response, status, code, message);
      };
      if (!offer) return reject(404, 'OFFER_NOT_EDITABLE', 'This active offer was not found.');
      if (new Date(offer.response_deadline) <= new Date()) return reject(409, 'RESPONSE_DEADLINE_PASSED', 'Offers cannot be re-confirmed after the response deadline.');
      if (offer.confirmed_trip_version >= offer.trip_version) return reject(409, 'OFFER_ALREADY_CONFIRMED', 'This offer already matches the current trip details.');
      if (acknowledgedTripVersion !== Number(offer.trip_version)) return reject(409, 'TRIP_CHANGED', 'The agency changed the trip details again. Review the latest details before re-confirming.');
      if (new Date(offer.validity_until) <= new Date()) return reject(409, 'OFFER_EXPIRED', 'This offer is no longer valid. Revise it with a new validity date instead.');

      const requestFacts = requestFactsOf(offer);
      await recordOfferRevision(client, offer, requestFacts);
      const updated = await client.query(
        'UPDATE offers SET confirmed_trip_version = $2, reconfirmed_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *',
        [offer.id, offer.trip_version],
      );
      const parts = await loadOfferParts(client, [offer.id]);
      await notify(client, offer.agency_organization_id, 'offer_reconfirmed', 'Seller re-confirmed an offer', `${offer.request_code} / ${request.auth.organization_name} / Same price for the changed trip`, { offerId: offer.id, requestId: offer.request_id, requestCode: offer.request_code });
      await client.query('COMMIT');
      return response.json({ offer: offerDto(updated.rows[0], { ...parts(offer.id), request: requestFacts }) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  router.get('/offers/:offerId/negotiations', async (request, response, next) => {
    if (!uuidPattern.test(request.params.offerId)) return fail(response, 404, 'OFFER_NOT_FOUND', 'Offer was not found.');
    try {
      const owner = await pool.query(
        `SELECT f.seller_organization_id, r.agency_organization_id FROM offers f
         JOIN marketplace_requests r ON r.id = f.request_id WHERE f.id = $1`,
        [request.params.offerId],
      );
      const parties = owner.rows[0];
      if (!parties || ![parties.seller_organization_id, parties.agency_organization_id].includes(request.auth.organization_id)) return fail(response, 404, 'OFFER_NOT_FOUND', 'Offer was not found.');
      return response.json({ negotiations: await listNegotiations(pool, request.params.offerId) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/offers/:offerId/negotiations', requireCapability(capabilities.requestWrite), async (request, response, next) => {
    if (request.auth.business_type !== 'agency') return fail(response, 403, 'ROLE_FORBIDDEN', 'Only the requesting agency can ask for a revision or send a counter-offer.');
    if (!uuidPattern.test(request.params.offerId)) return fail(response, 404, 'OFFER_NOT_FOUND', 'Offer was not found.');
    const input = parseWith(negotiationSchema, request.body);
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const reject = async (status, code, message) => {
        await client.query('ROLLBACK');
        return fail(response, status, code, message);
      };
      const current = await client.query(
        `SELECT f.id, f.status, f.seller_organization_id, f.request_id, r.status AS request_status, r.request_code, r.destination,
                (SELECT COUNT(*)::int FROM offer_negotiations n WHERE n.offer_id = f.id) AS rounds,
                EXISTS (SELECT 1 FROM offer_negotiations n WHERE n.offer_id = f.id AND n.status = 'open') AS has_open
         FROM offers f JOIN marketplace_requests r ON r.id = f.request_id
         WHERE f.id = $1 AND r.agency_organization_id = $2 FOR UPDATE OF f`,
        [request.params.offerId, request.auth.organization_id],
      );
      const offer = current.rows[0];
      if (!offer) return reject(404, 'OFFER_NOT_FOUND', 'Offer was not found.');
      if (!['submitted', 'shortlisted'].includes(offer.status) || !['open', 'closed'].includes(offer.request_status)) return reject(409, 'OFFER_NOT_NEGOTIABLE', 'Only active offers on an undecided request can be negotiated.');
      if (offer.has_open) return reject(409, 'NEGOTIATION_ALREADY_OPEN', 'Wait for the seller to answer your last request, or withdraw it first.');
      if (offer.rounds >= config.maxNegotiationRoundsPerOffer) return reject(409, 'NEGOTIATION_LIMIT_REACHED', `An offer can be negotiated at most ${config.maxNegotiationRoundsPerOffer} times.`);
      const { kind, message, counter_price_minor: counterPriceMinor, offer_option_id: optionId } = input.data;
      const option = optionId ? await client.query('SELECT label FROM offer_options WHERE id = $1 AND offer_id = $2', [optionId, offer.id]) : null;
      if (option && !option.rowCount) return reject(404, 'OPTION_NOT_AVAILABLE', 'This option is no longer part of the offer. Reload the offers and choose again.');
      const created = await client.query(
        `INSERT INTO offer_negotiations (id, offer_id, offer_option_id, option_label, kind, message, counter_price_minor, requested_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [randomUUID(), offer.id, optionId, option?.rows[0].label ?? null, kind, message, counterPriceMinor, request.auth.user_id],
      );
      const counter = kind === 'counter_offer';
      await notify(client, offer.seller_organization_id, counter ? 'offer_counter_received' : 'offer_revision_requested', counter ? 'Agency sent a counter-offer' : 'Agency asked for a revised offer', `${offer.request_code} / ${offer.destination}${message ? ` / ${message}` : ''}`, { requestId: offer.request_id, requestCode: offer.request_code, offerId: offer.id, negotiationId: created.rows[0].id });
      await client.query('COMMIT');
      const [negotiation] = (await listNegotiations(client, offer.id)).filter((item) => item.id === created.rows[0].id);
      return response.status(201).json({ negotiation });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error.code === '23505') return fail(response, 409, 'NEGOTIATION_ALREADY_OPEN', 'Wait for the seller to answer your last request, or withdraw it first.');
      return next(error);
    } finally {
      client.release();
    }
  });

  router.post('/negotiations/:negotiationId/withdraw', requireCapability(capabilities.requestWrite), async (request, response, next) => {
    if (request.auth.business_type !== 'agency') return fail(response, 403, 'ROLE_FORBIDDEN', 'Only the requesting agency can withdraw its request.');
    if (!uuidPattern.test(request.params.negotiationId)) return fail(response, 404, 'NEGOTIATION_NOT_OPEN', 'This open negotiation was not found.');
    try {
      const result = await pool.query(
        `UPDATE offer_negotiations n SET status = 'withdrawn', responded_at = NOW()
         FROM offers f JOIN marketplace_requests r ON r.id = f.request_id
         WHERE n.id = $1 AND n.offer_id = f.id AND r.agency_organization_id = $2 AND n.status = 'open'
         RETURNING n.*, f.currency, f.offer_kind`,
        [request.params.negotiationId, request.auth.organization_id],
      );
      if (!result.rowCount) return fail(response, 404, 'NEGOTIATION_NOT_OPEN', 'This open negotiation was not found.');
      return response.json({ negotiation: negotiationDto(result.rows[0]) });
    } catch (error) {
      return next(error);
    }
  });

  // Seller answers: accept a counter price as-is, or decline with a reason. Revising the offer answers either kind.
  const answerNegotiation = (accepting) => async (request, response, next) => {
    if (!['dmc', 'hotelier'].includes(request.auth.business_type)) return fail(response, 403, 'ROLE_FORBIDDEN', 'Only the seller can answer a negotiation.');
    if (!uuidPattern.test(request.params.negotiationId)) return fail(response, 404, 'NEGOTIATION_NOT_FOUND', 'Negotiation was not found.');
    const decline = accepting ? null : parseWith(declineSchema, request.body);
    if (decline?.error) return fail(response, 400, 'VALIDATION_ERROR', decline.error);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const reject = async (status, code, message) => {
        await client.query('ROLLBACK');
        return fail(response, status, code, message);
      };
      const current = await client.query(
        `SELECT n.id AS negotiation_id, n.kind, n.status AS negotiation_status, n.offer_option_id, n.counter_price_minor,
                f.*, r.status AS request_status, r.agency_organization_id, r.request_code, r.destination,
                r.adults, r.children, r.nights, r.room_count AS request_room_count, r.trip_version
         FROM offer_negotiations n JOIN offers f ON f.id = n.offer_id JOIN marketplace_requests r ON r.id = f.request_id
         WHERE n.id = $1 AND f.seller_organization_id = $2 FOR UPDATE OF n, f`,
        [request.params.negotiationId, request.auth.organization_id],
      );
      const row = current.rows[0];
      if (!row) return reject(404, 'NEGOTIATION_NOT_FOUND', 'Negotiation was not found.');
      if (row.negotiation_status !== 'open') return reject(409, 'NEGOTIATION_NOT_OPEN', 'This negotiation was already answered or withdrawn.');
      if (!['submitted', 'shortlisted'].includes(row.status) || !['open', 'closed'].includes(row.request_status)) return reject(409, 'OFFER_NOT_NEGOTIABLE', 'This offer can no longer change.');
      const summary = `${row.request_code} / ${request.auth.organization_name}`;
      const eventData = { requestId: row.request_id, requestCode: row.request_code, offerId: row.id, negotiationId: row.negotiation_id };

      if (!accepting) {
        await client.query("UPDATE offer_negotiations SET status = 'declined', response_note = $2, responded_by_user_id = $3, responded_at = NOW() WHERE id = $1", [row.negotiation_id, decline.data.note, request.auth.user_id]);
        await notify(client, row.agency_organization_id, 'offer_negotiation_declined', row.kind === 'counter_offer' ? 'Seller declined your counter-offer' : 'Seller declined your revision request', `${summary} / Reason: ${decline.data.note}`, eventData);
        await client.query('COMMIT');
        return response.json({ negotiation: (await listNegotiations(client, row.id)).find((item) => item.id === row.negotiation_id) });
      }

      if (row.kind !== 'counter_offer') return reject(409, 'NEGOTIATION_NOT_COUNTER', 'Answer a revision request by revising your offer.');
      if (new Date(row.validity_until) <= new Date()) return reject(409, 'OFFER_EXPIRED', 'This offer is no longer valid. Revise it with a new validity date instead.');
      const priceColumn = row.offer_kind === 'hotel_room' ? 'rate_per_night_minor' : 'total_minor';
      if (!row.offer_option_id && row.offer_kind === 'land_package') {
        const lines = await client.query('SELECT 1 FROM offer_line_items WHERE offer_id = $1 LIMIT 1', [row.id]);
        if (lines.rowCount) return reject(409, 'COUNTER_NEEDS_REVISION', 'Your offer has a price breakdown. Revise the offer so the line items add up to the counter price.');
      }
      await recordOfferRevision(client, row, requestFactsOf(row));
      if (row.offer_option_id) {
        await client.query(`UPDATE offer_options SET ${priceColumn} = $2 WHERE id = $1`, [row.offer_option_id, row.counter_price_minor]);
        await client.query('UPDATE offers SET updated_at = NOW() WHERE id = $1', [row.id]);
      } else {
        await client.query(`UPDATE offers SET ${priceColumn} = $2, updated_at = NOW() WHERE id = $1`, [row.id, row.counter_price_minor]);
      }
      await client.query("UPDATE offer_negotiations SET status = 'accepted', responded_by_user_id = $2, responded_at = NOW() WHERE id = $1", [row.negotiation_id, request.auth.user_id]);
      await notify(client, row.agency_organization_id, 'offer_counter_accepted', 'Seller accepted your counter-offer', summary, eventData);
      const updated = await client.query('SELECT * FROM offers WHERE id = $1', [row.id]);
      const parts = await loadOfferParts(client, [row.id]);
      await client.query('COMMIT');
      return response.json({ offer: offerDto(updated.rows[0], { ...parts(row.id), request: requestFactsOf(row) }) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  };
  router.post('/negotiations/:negotiationId/accept', requireCapability(capabilities.offerWrite), answerNegotiation(true));
  router.post('/negotiations/:negotiationId/decline', requireCapability(capabilities.offerWrite), answerNegotiation(false));

  router.post('/offers/:offerId/withdraw', requireCapability(capabilities.offerWrite), async (request, response, next) => {
    if (!['dmc', 'hotelier'].includes(request.auth.business_type)) return fail(response, 403, 'ROLE_FORBIDDEN', 'Only the seller can withdraw its offer.');
    try {
      const result = await pool.query(
        `WITH withdrawn AS (
           UPDATE offers f SET status = 'withdrawn', updated_at = NOW()
           FROM marketplace_requests r WHERE f.id = $1 AND f.request_id = r.id
             AND f.seller_organization_id = $2 AND r.status = 'open' AND f.status IN ('submitted', 'shortlisted')
           RETURNING f.id, f.request_id, r.agency_organization_id, r.request_code, r.destination
         ), closed AS (
           UPDATE offer_negotiations SET status = 'closed', responded_at = NOW()
           WHERE status = 'open' AND offer_id IN (SELECT id FROM withdrawn)
         )
         SELECT * FROM withdrawn`,
        [request.params.offerId, request.auth.organization_id],
      );
      if (!result.rowCount) return fail(response, 404, 'OFFER_NOT_WITHDRAWABLE', 'Active offer was not found.');
      await notify(pool, result.rows[0].agency_organization_id, 'offer_withdrawn', 'Seller withdrew an offer', `${result.rows[0].request_code} / ${result.rows[0].destination}`, { offerId: result.rows[0].id, requestId: result.rows[0].request_id, requestCode: result.rows[0].request_code });
      return response.json({ offerId: result.rows[0].id, requestId: result.rows[0].request_id, status: 'withdrawn' });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/offers', async (request, response, next) => {
    try {
      if (request.auth.business_type === 'agency') {
        const agencyOffers = await pool.query(
            `SELECT f.id, f.request_id, r.request_code, r.destination, f.offer_kind, f.total_minor,
              f.rate_per_night_minor, f.room_type, f.meal_plan, f.currency, f.inclusions,
              f.exclusions, f.validity_until, f.status, f.created_at,
              (f.confirmed_trip_version < r.trip_version) AS needs_reconfirmation,
                  seller.name AS seller_name
           FROM marketplace_requests r
           JOIN offers f ON f.request_id = r.id
           JOIN organizations seller ON seller.id = f.seller_organization_id
           JOIN seller_profiles profile ON profile.organization_id = seller.id
           WHERE r.agency_organization_id = $1 AND profile.verification_status = 'approved'
             AND f.status IN ('submitted', 'shortlisted', 'accepted')
           ORDER BY f.created_at DESC`,
          [request.auth.organization_id],
        );
        return response.json({ offers: agencyOffers.rows.map((offer) => ({ id: offer.id, requestId: offer.request_id, requestCode: offer.request_code, destination: offer.destination, sellerName: offer.seller_name, kind: offer.offer_kind, totalMinor: offer.total_minor, ratePerNightMinor: offer.rate_per_night_minor, roomType: offer.room_type, mealPlan: offer.meal_plan, currency: offer.currency, inclusions: offer.inclusions, exclusions: offer.exclusions, validityUntil: offer.validity_until, status: offer.status, createdAt: offer.created_at, needsReconfirmation: offer.needs_reconfirmation })) });
      }
      if (request.auth.business_type === 'hotelier') {
        const hotelOffers = await pool.query(
          `SELECT f.id, f.request_id, r.request_code, r.destination, f.rate_per_night_minor,
                  f.room_type, f.meal_plan, f.currency, f.validity_until, f.status, f.outcome_reason, f.created_at,
                  (f.status IN ('submitted', 'shortlisted') AND f.confirmed_trip_version < r.trip_version) AS needs_reconfirmation
           FROM offers f JOIN marketplace_requests r ON r.id = f.request_id
           WHERE f.seller_organization_id = $1 ORDER BY f.created_at DESC`,
          [request.auth.organization_id],
        );
        const hotelNegotiations = await loadOpenNegotiations(pool, hotelOffers.rows.map((offer) => offer.id));
        return response.json({ offers: hotelOffers.rows.map((offer) => ({ id: offer.id, requestId: offer.request_id, requestCode: offer.request_code, destination: offer.destination, kind: 'hotel_room', ratePerNightMinor: offer.rate_per_night_minor, roomType: offer.room_type, mealPlan: offer.meal_plan, currency: offer.currency, validityUntil: offer.validity_until, status: offer.status, outcomeReason: offer.outcome_reason, createdAt: offer.created_at, needsReconfirmation: offer.needs_reconfirmation, openNegotiation: hotelNegotiations.get(offer.id) ?? null })) });
      }
      if (request.auth.business_type !== 'dmc') return fail(response, 403, 'ROLE_FORBIDDEN', 'This offer inbox is for sellers.');
      const result = await pool.query(
        `SELECT f.id, f.request_id, r.request_code, r.destination, f.total_minor, f.currency,
                f.inclusions, f.exclusions, f.validity_until, f.status, f.outcome_reason, f.created_at,
                (f.status IN ('submitted', 'shortlisted') AND f.confirmed_trip_version < r.trip_version) AS needs_reconfirmation,
                 1 + (SELECT COUNT(*) FROM offers lower_offer WHERE lower_offer.request_id = f.request_id
                   AND lower_offer.offer_kind = 'land_package'
                     AND lower_offer.currency = f.currency AND lower_offer.total_minor < f.total_minor
                     AND lower_offer.status IN ('submitted', 'shortlisted', 'accepted')) AS seller_rank,
                 (SELECT COUNT(*) FROM offers comparable WHERE comparable.request_id = f.request_id
                   AND comparable.offer_kind = 'land_package'
                     AND comparable.currency = f.currency AND comparable.status IN ('submitted', 'shortlisted', 'accepted')) AS eligible_count
         FROM offers f JOIN marketplace_requests r ON r.id = f.request_id
         WHERE f.seller_organization_id = $1 AND f.offer_kind = 'land_package' ORDER BY f.created_at DESC`,
        [request.auth.organization_id],
      );
      const negotiations = await loadOpenNegotiations(pool, result.rows.map((offer) => offer.id));
      return response.json({ offers: result.rows.map((offer) => ({ id: offer.id, requestId: offer.request_id, requestCode: offer.request_code, destination: offer.destination, totalMinor: offer.total_minor, currency: offer.currency, inclusions: offer.inclusions, exclusions: offer.exclusions, validityUntil: offer.validity_until, status: offer.status, outcomeReason: offer.outcome_reason, createdAt: offer.created_at, rank: Number(offer.seller_rank), eligibleCount: Number(offer.eligible_count), needsReconfirmation: offer.needs_reconfirmation, openNegotiation: negotiations.get(offer.id) ?? null })) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/requests/:requestId/award', requireCapability(capabilities.requestAward), async (request, response, next) => {
    if (request.auth.business_type !== 'agency') return fail(response, 403, 'ROLE_FORBIDDEN', 'Only the requesting agency can award an offer.');
    const input = parseWith(awardSchema, request.body ?? {});
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    const { selections, notSelectedReason } = input.data;
    if (containsContactDetails(notSelectedReason)) return fail(response, 400, 'CONTACT_DETAILS_NOT_ALLOWED', 'Remove contact details and external links from the not-selected reason.');
    const requestId = request.params.requestId;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const reject = async (status, code, message) => {
        await client.query('ROLLBACK');
        return fail(response, status, code, message);
      };
      const requestRow = await client.query("SELECT id, request_code, destination FROM marketplace_requests WHERE id = $1 AND agency_organization_id = $2 AND status IN ('open', 'closed') FOR UPDATE", [requestId, request.auth.organization_id]);
      if (!requestRow.rowCount) return reject(404, 'REQUEST_NOT_AVAILABLE', 'This open or closed request was not found.');
      const winners = [];
      for (const selection of selections) {
        const selected = await client.query(
            `SELECT f.id, f.seller_organization_id, f.confirmed_trip_version, f.option_label, f.offer_kind,
              f.hotel_property_id, f.room_type, f.room_count, r.trip_version, r.travel_start_date::text AS travel_start_date,
              r.travel_end_date::text AS travel_end_date, r.room_count AS request_room_count
           FROM offers f JOIN seller_profiles p ON p.organization_id = f.seller_organization_id
           JOIN marketplace_requests r ON r.id = f.request_id
           WHERE f.id = $1 AND f.request_id = $2 AND f.status IN ('submitted', 'shortlisted') AND p.verification_status = 'approved'`,
          [selection.offer_id, requestId],
        );
        const offer = selected.rows[0];
        if (!offer) return reject(404, 'OFFER_NOT_AVAILABLE', 'The selected offer is not available for this request.');
        if (offer.confirmed_trip_version < offer.trip_version) return reject(409, 'OFFER_NEEDS_RECONFIRMATION', 'This offer was priced for earlier trip details. Wait for the seller to re-confirm it.');
        const option = selection.offer_option_id ? await client.query('SELECT label, room_type FROM offer_options WHERE id = $1 AND offer_id = $2', [selection.offer_option_id, offer.id]) : null;
        if (option && !option.rowCount) return reject(404, 'OPTION_NOT_AVAILABLE', 'This option is no longer part of the offer. Reload the offers and choose again.');
        winners.push({ id: randomUUID(), offer, optionId: selection.offer_option_id, option: option?.rows[0] ?? null, optionLabel: option ? option.rows[0].label : offer.option_label ?? null });
      }
      for (const winner of winners) {
        await client.query(
          'INSERT INTO awards (id, request_id, offer_id, offer_option_id, agency_organization_id, seller_organization_id) VALUES ($1, $2, $3, $4, $5, $6)',
          [winner.id, requestId, winner.offer.id, winner.optionId, request.auth.organization_id, winner.offer.seller_organization_id],
        );
        if (winner.offer.offer_kind === 'hotel_room') {
          const hold = await createHotelRoomHold(client, {
            awardId: winner.id,
            organizationId: winner.offer.seller_organization_id,
            propertyId: winner.offer.hotel_property_id,
            requestId,
            offerId: winner.offer.id,
            roomType: winner.option?.room_type ?? winner.offer.room_type,
            rooms: Number(winner.offer.room_count ?? winner.offer.request_room_count ?? 1),
            startDate: winner.offer.travel_start_date,
            endDate: winner.offer.travel_end_date,
          });
          if (hold.error) return reject(...hold.error);
          winner.roomHold = hold.hold;
        }
      }
      await client.query("UPDATE marketplace_requests SET status = 'awarded', updated_at = NOW() WHERE id = $1", [requestId]);
      await client.query("UPDATE offer_negotiations SET status = 'closed', responded_at = NOW() WHERE status = 'open' AND offer_id IN (SELECT id FROM offers WHERE request_id = $1)", [requestId]);
      const winningIds = winners.map((winner) => winner.offer.id);
      const outcomes = await client.query(
        `UPDATE offers SET status = CASE WHEN id = ANY($2::uuid[]) THEN 'accepted' ELSE 'rejected' END,
           outcome_reason = CASE WHEN id = ANY($2::uuid[]) THEN NULL ELSE $3::varchar END, updated_at = NOW()
         WHERE request_id = $1 AND status IN ('submitted', 'shortlisted') RETURNING id, seller_organization_id, status`,
        [requestId, winningIds, notSelectedReason],
      );
      const { request_code: requestCode, destination } = requestRow.rows[0];
      const summary = `${requestCode} / ${destination}`;
      const split = winners.length > 1 ? ' / Shared award: you supply part of this trip' : '';
      for (const outcome of outcomes.rows) {
        const winner = winners.find((item) => item.offer.id === outcome.id);
        if (winner) {
          await notify(client, outcome.seller_organization_id, 'offer_awarded', 'Your offer was awarded', `${summary}${winner.optionLabel ? ` / Option: ${winner.optionLabel}` : ''}${split}`, { requestId, requestCode, awardId: winner.id, offerId: winner.offer.id, offerOptionId: winner.optionId });
        } else {
          await notify(client, outcome.seller_organization_id, 'offer_not_selected', 'Offer not selected', notSelectedReason ? `${summary} / Reason: ${notSelectedReason}` : summary, { requestId, requestCode, awardId: null, offerId: null, offerOptionId: null });
        }
      }
      await client.query('COMMIT');
      const awards = winners.map((winner) => ({ id: winner.id, requestId, offerId: winner.offer.id, offerOptionId: winner.optionId, optionLabel: winner.optionLabel, sellerOrganizationId: winner.offer.seller_organization_id, status: 'awarded', roomHoldExpiresAt: winner.roomHold?.expires_at ?? null }));
      return response.status(201).json({ award: awards[0], awards, undoUntil: new Date(Date.now() + config.awards.undoWindowMs).toISOString() });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  // Reverses the whole award decision while no booking step has started; offers become active again.
  router.post('/requests/:requestId/award/undo', requireCapability(capabilities.requestAward), async (request, response, next) => {
    if (request.auth.business_type !== 'agency') return fail(response, 403, 'ROLE_FORBIDDEN', 'Only the requesting agency can undo its award.');
    const input = parseWith(undoAwardSchema, request.body ?? {});
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    const requestId = request.params.requestId;
    if (!uuidPattern.test(requestId)) return fail(response, 404, 'REQUEST_NOT_AWARDED', 'This awarded request was not found.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const reject = async (status, code, message) => {
        await client.query('ROLLBACK');
        return fail(response, status, code, message);
      };
      const requestRow = await client.query(
        "SELECT id, request_code, destination, closed_at, response_deadline FROM marketplace_requests WHERE id = $1 AND agency_organization_id = $2 AND status = 'awarded' FOR UPDATE",
        [requestId, request.auth.organization_id],
      );
      if (!requestRow.rowCount) return reject(404, 'REQUEST_NOT_AWARDED', 'This awarded request was not found.');
      const awards = await client.query('SELECT * FROM awards WHERE request_id = $1 ORDER BY created_at FOR UPDATE', [requestId]);
      if (awards.rows.some((award) => award.status !== 'awarded')) return reject(409, 'AWARD_IN_PROGRESS', 'A booking was already confirmed for this award, so it can no longer be undone.');
      const awardedAt = new Date(awards.rows[0].created_at);
      if (Date.now() - awardedAt.getTime() > config.awards.undoWindowMs) return reject(409, 'UNDO_WINDOW_PASSED', `Awards can only be undone within ${config.awards.undoWindowMs / 60000} minutes.`);

      await client.query(
        'INSERT INTO award_reversals (id, request_id, agency_organization_id, undone_by_user_id, reason, awards, awarded_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [randomUUID(), requestId, request.auth.organization_id, request.auth.user_id, input.data.reason, JSON.stringify(awards.rows), awardedAt],
      );
      await client.query('DELETE FROM awards WHERE request_id = $1', [requestId]);
      const { closed_at: closedAt, response_deadline: deadline, request_code: requestCode, destination } = requestRow.rows[0];
      const reopened = !closedAt && new Date(deadline) > new Date();
      await client.query(
        "UPDATE marketplace_requests SET status = CASE WHEN $2 THEN 'open' ELSE 'closed' END, closed_at = CASE WHEN $2 THEN NULL ELSE COALESCE(closed_at, NOW()) END, updated_at = NOW() WHERE id = $1",
        [requestId, reopened],
      );
      const restored = await client.query(
        "UPDATE offers SET status = 'submitted', outcome_reason = NULL, updated_at = NOW() WHERE request_id = $1 AND status IN ('accepted', 'rejected') RETURNING seller_organization_id",
        [requestId],
      );
      for (const offer of restored.rows) {
        await notify(client, offer.seller_organization_id, 'award_undone', 'Agency reopened its decision', `${requestCode} / ${destination} / The award was undone and your offer is active again.${input.data.reason ? ` Reason: ${input.data.reason}` : ''}`, { requestId, requestCode });
      }
      await client.query('COMMIT');
      return response.json({ requestId, status: reopened ? 'open' : 'closed', restoredOffers: restored.rowCount });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  router.get('/awards/:awardId', async (request, response, next) => {
    try {
      const result = await pool.query(
        `SELECT a.id, a.request_id, r.request_code, r.destination, a.offer_id, a.offer_option_id, a.status,
                COALESCE(opt.label, f.option_label) AS option_label,
                a.created_at, a.booking_confirmed_at, a.agency_organization_id,
                a.seller_organization_id, o.name AS seller_name,
                (g.award_id IS NOT NULL AND g.revoked_at IS NULL AND g.purged_at IS NULL) AS guest_details_released
         FROM awards a JOIN marketplace_requests r ON r.id = a.request_id
         JOIN offers f ON f.id = a.offer_id
         LEFT JOIN offer_options opt ON opt.id = a.offer_option_id
         JOIN organizations o ON o.id = a.seller_organization_id
         LEFT JOIN booking_guest_details g ON g.award_id = a.id WHERE a.id = $1`,
        [request.params.awardId],
      );
      const award = result.rows[0];
      if (!award || (award.agency_organization_id !== request.auth.organization_id && award.seller_organization_id !== request.auth.organization_id)) return fail(response, 404, 'AWARD_NOT_FOUND', 'Award was not found.');
      return response.json({ award: { id: award.id, requestId: award.request_id, requestCode: award.request_code, destination: award.destination, offerId: award.offer_id, offerOptionId: award.offer_option_id ?? null, optionLabel: award.option_label ?? null, sellerName: award.seller_name, status: award.status, createdAt: award.created_at, bookingConfirmedAt: award.booking_confirmed_at, guestDetailsReleased: Boolean(award.guest_details_released) } });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/reports', reportLimiter, async (request, response, next) => {
    const input = parseWith(reportSchema, request.body);
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    const { target_type: targetType, target_id: targetId, category, details } = input.data;
    if (containsContactDetails(details)) return fail(response, 400, 'CONTACT_DETAILS_NOT_ALLOWED', 'Describe the problem without contact details or links; operations can see the reported item.');
    const me = request.auth.organization_id;
    const targetQueries = {
      request: [`SELECT r.agency_organization_id AS target_organization_id FROM request_targets t
        JOIN marketplace_requests r ON r.id = t.request_id WHERE r.id = $1 AND t.seller_organization_id = $2`, [targetId, me]],
      offer: [`SELECT f.seller_organization_id AS target_organization_id FROM offers f
        JOIN marketplace_requests r ON r.id = f.request_id WHERE f.id = $1 AND r.agency_organization_id = $2`, [targetId, me]],
      message: ['SELECT sender_organization_id AS target_organization_id FROM request_messages WHERE id = $1 AND recipient_organization_id = $2', [targetId, me]],
      organization: [`SELECT $1::uuid AS target_organization_id WHERE $1::uuid <> $2::uuid AND EXISTS (
        SELECT 1 FROM request_targets t JOIN marketplace_requests r ON r.id = t.request_id
        WHERE (r.agency_organization_id = $2 AND t.seller_organization_id = $1) OR (r.agency_organization_id = $1 AND t.seller_organization_id = $2))`, [targetId, me]],
    };
    try {
      const [sql, params] = targetQueries[targetType];
      const target = await pool.query(sql, params);
      if (!target.rowCount) return fail(response, 404, 'REPORT_TARGET_NOT_FOUND', 'You can only report items your organization has taken part in.');
      const created = await pool.query(
        `INSERT INTO abuse_reports (id, reporter_organization_id, reporter_user_id, target_type, target_id, target_organization_id, category, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, status, created_at`,
        [randomUUID(), me, request.auth.user_id, targetType, targetId, target.rows[0].target_organization_id, category, details],
      );
      return response.status(201).json({ report: { id: created.rows[0].id, status: created.rows[0].status, createdAt: created.rows[0].created_at } });
    } catch (error) {
      if (error.code === '23505') return fail(response, 409, 'REPORT_ALREADY_OPEN', 'Your organization already has an open report for this item.');
      return next(error);
    }
  });

  return router;
}