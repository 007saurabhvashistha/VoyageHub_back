import { randomBytes, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { loadSession, requireCsrf, requireMfaForPlatformAdmin } from './auth.routes.js';
import { getMaxOffersPerRequest } from '../services/platformSettings.js';

const groupTypes = new Set(['family', 'honeymoon', 'friends', 'corporate', 'school', 'seniors', 'solo', 'other']);
const mealPlans = new Set(['room_only', 'breakfast', 'half_board', 'full_board', 'all_inclusive']);
const serviceTypes = new Set(['hotel', 'transfers', 'sightseeing', 'guide', 'visa', 'flights']);
const offerInclusions = new Set(['accommodation', 'breakfast', 'transfers', 'sightseeing', 'guide', 'taxes', 'visa', 'flights', 'meals', 'rail', 'insurance']);
const contactDetailsPattern = /(?:\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b(?:https?:\/\/|www\.)\S+|\b\+\d[\d\s().-]{6,}\d\b|\b\d{10,15}\b)/i;
const visibilities = new Set(['open', 'invite_only', 'open_and_invite']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxInvitedSellers = 20;
// Closed requests stay visible to sellers whose offer is still under review.
const sellerCanSeeRequest = `(r.status = 'open'
  OR (r.status = 'closed' AND EXISTS (SELECT 1 FROM offers own WHERE own.request_id = r.id
    AND own.seller_organization_id = t.seller_organization_id AND own.status IN ('submitted', 'shortlisted')))
  OR (r.status = 'awarded' AND EXISTS (SELECT 1 FROM awards a WHERE a.request_id = r.id
    AND a.seller_organization_id = t.seller_organization_id)))`;

function fail(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

async function notify(pool, organizationId, eventType, title, message, data) {
  await pool.query(
    'INSERT INTO notifications (id, organization_id, event_type, title, message, data) VALUES ($1, $2, $3, $4, $5, $6)',
    [randomUUID(), organizationId, eventType, title, message, JSON.stringify(data)],
  );
}

function validDate(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function validRequest(body) {
  const destination = typeof body.destination === 'string' ? body.destination.trim() : '';
  const countryCode = typeof body.destination_country === 'string' ? body.destination_country.trim().toUpperCase() : '';
  const travelMonth = typeof body.travel_month === 'string' ? body.travel_month : null;
  const hasDates = validDate(body.travel_start_date) && validDate(body.travel_end_date) && body.travel_end_date > body.travel_start_date;
  const hasMonth = typeof travelMonth === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(travelMonth);
  const services = Array.isArray(body.services) ? [...new Set(body.services)] : [];
  const nights = Number(body.nights);
  const adults = Number(body.adults);
  const children = Number(body.children ?? 0);
  const infants = Number(body.infants ?? 0);
  const responseDeadline = typeof body.response_deadline === 'string' ? new Date(body.response_deadline) : null;
  const budgetMin = body.budget_min_minor == null ? null : Number(body.budget_min_minor);
  const budgetMax = body.budget_max_minor == null ? null : Number(body.budget_max_minor);
  const budgetCurrency = typeof body.budget_currency === 'string' ? body.budget_currency.toUpperCase() : null;
  const visibility = body.visibility ?? 'open';
  const invitedSellerIds = Array.isArray(body.invited_seller_ids) ? [...new Set(body.invited_seller_ids)] : [];

  if (destination.length < 2 || destination.length > 120) return { error: 'Destination must be between 2 and 120 characters.' };
  if (!/^[A-Z]{2}$/.test(countryCode)) return { error: 'Choose a valid ISO country code.' };
  if (!hasDates && !hasMonth) return { error: 'Provide exact travel dates or a travel month.' };
  if (hasDates && travelMonth) return { error: 'Choose exact dates or a travel month, not both.' };
  if (!Number.isInteger(nights) || nights < 1 || nights > 90) return { error: 'Nights must be between 1 and 90.' };
  if (hasDates && Math.ceil((Date.parse(`${body.travel_end_date}T00:00:00Z`) - Date.parse(`${body.travel_start_date}T00:00:00Z`)) / 86400000) !== nights) return { error: 'Nights must match the selected travel dates.' };
  if (!Number.isInteger(adults) || adults < 1 || adults > 100) return { error: 'Adults must be between 1 and 100.' };
  if (!Number.isInteger(children) || children < 0 || children > 80) return { error: 'Children must be between 0 and 80.' };
  if (!Number.isInteger(infants) || infants < 0 || infants > 40) return { error: 'Infants must be between 0 and 40.' };
  if (!groupTypes.has(body.group_type)) return { error: 'Choose a supported group type.' };
  if (!services.length || services.length > serviceTypes.size || services.some((service) => !serviceTypes.has(service))) return { error: 'Choose one or more supported services.' };
  if (body.hotel_category != null && ![3, 4, 5].includes(Number(body.hotel_category))) return { error: 'Hotel category must be 3, 4 or 5 stars.' };
  if (body.room_count != null && (!Number.isInteger(Number(body.room_count)) || Number(body.room_count) < 1 || Number(body.room_count) > 50)) return { error: 'Room count must be between 1 and 50.' };
  if (body.meal_plan != null && !mealPlans.has(body.meal_plan)) return { error: 'Choose a supported meal plan.' };
  if (!responseDeadline || Number.isNaN(responseDeadline.getTime()) || responseDeadline <= new Date() || responseDeadline > new Date(Date.now() + 90 * 86400000)) return { error: 'Response deadline must be within the next 90 days.' };
  if ((budgetMin == null) !== (budgetMax == null)) return { error: 'Provide both budget bounds or neither.' };
  if (budgetMin != null && (!Number.isSafeInteger(budgetMin) || !Number.isSafeInteger(budgetMax) || budgetMin < 0 || budgetMax < budgetMin || !/^[A-Z]{3}$/.test(budgetCurrency ?? ''))) return { error: 'Budget requires valid minor-unit bounds and an ISO currency code.' };
  if (!visibilities.has(visibility)) return { error: 'Choose open, invite-only, or open and invited visibility.' };
  if (invitedSellerIds.length > maxInvitedSellers || invitedSellerIds.some((id) => typeof id !== 'string' || !uuidPattern.test(id))) return { error: `Invite up to ${maxInvitedSellers} verified suppliers.` };
  if (visibility === 'open' && invitedSellerIds.length) return { error: 'Open requests cannot include invited suppliers. Choose invite-only or open and invited visibility.' };
  if (visibility === 'invite_only' && !invitedSellerIds.length) return { error: 'Invite at least one verified supplier for an invite-only request.' };

  return {
    destination,
    countryCode,
    travelStartDate: hasDates ? body.travel_start_date : null,
    travelEndDate: hasDates ? body.travel_end_date : null,
    travelMonth: hasMonth ? travelMonth : null,
    nights,
    adults,
    children,
    infants,
    groupType: body.group_type,
    hotelCategory: body.hotel_category == null ? null : Number(body.hotel_category),
    roomCount: body.room_count == null ? null : Number(body.room_count),
    mealPlan: body.meal_plan ?? null,
    services,
    budgetMin,
    budgetMax,
    budgetCurrency: budgetMin == null ? null : budgetCurrency,
    responseDeadline,
    visibility,
    invitedSellerIds,
  };
}

function requestDto(row) {
  const dateText = (value) => value instanceof Date ? value.toISOString().slice(0, 10) : value;
  const startDate = row.travel_start_date ? dateText(row.travel_start_date) : null;
  const endDate = row.travel_end_date ? dateText(row.travel_end_date) : null;
  const travelerParts = [`${row.adults} adults`];
  if (row.children) travelerParts.push(`${row.children} children`);
  if (row.infants) travelerParts.push(`${row.infants} infants`);
  return {
    id: row.id,
    requestCode: row.request_code,
    destination: row.destination,
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
    travelers: travelerParts.join(', '),
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
  };
}

function sellerRequestDto(row, offerLimit) {
  const offers = Number(row.offer_count ?? 0);
  return { ...requestDto(row), offerLimit, offerLimitReached: offers >= offerLimit, hasActiveOffer: Boolean(row.has_active_offer) };
}

export function createMarketplaceRouter({ pool }) {
  const router = Router();
  router.use((request, response, next) => loadSession(pool, request, response, next));
  router.use(requireMfaForPlatformAdmin);
  router.use((request, response, next) => request.method === 'GET' ? next() : requireCsrf(request, response, next));

  router.get('/seller-profile', async (request, response, next) => {
    if (!['dmc', 'hotelier'].includes(request.auth.business_type)) return fail(response, 403, 'ROLE_FORBIDDEN', 'Seller profile is only available to DMCs and hoteliers.');
    try {
      const result = await pool.query('SELECT coverage_destinations, property_city, verification_status, verification_reason FROM seller_profiles WHERE organization_id = $1', [request.auth.organization_id]);
      if (!result.rowCount) return fail(response, 404, 'PROFILE_NOT_FOUND', 'Seller profile was not found.');
      const profile = result.rows[0];
      return response.json({ coverageDestinations: profile.coverage_destinations, propertyCity: profile.property_city, verificationStatus: profile.verification_status, verificationReason: profile.verification_reason });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/suppliers', async (request, response, next) => {
    if (request.auth.business_type !== 'agency') return fail(response, 403, 'ROLE_FORBIDDEN', 'The supplier directory is only available to travel agencies.');
    const search = typeof request.query.search === 'string' ? request.query.search.trim() : '';
    const country = typeof request.query.country === 'string' ? request.query.country.toUpperCase() : '';
    const limit = Number(request.query.limit ?? 25);
    const offset = Number(request.query.offset ?? 0);
    if (search.length > 120 || (country && !/^[A-Z]{2}$/.test(country)) || !Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(offset) || offset < 0 || offset > 100000) {
      return fail(response, 400, 'VALIDATION_ERROR', 'Use a search up to 120 characters, an ISO country code, and valid pagination values.');
    }
    try {
      const searchPattern = search ? `%${search}%` : null;
      const values = [searchPattern, country || null];
      const where = `p.verification_status = 'approved' AND o.business_type IN ('dmc', 'hotelier')
        AND ($1::text IS NULL OR o.name ILIKE $1 OR p.property_city ILIKE $1
          OR EXISTS (SELECT 1 FROM unnest(p.coverage_destinations) AS destination WHERE destination ILIKE $1))
        AND ($2::text IS NULL OR o.country_code = $2)`;
      const count = await pool.query(
        `SELECT COUNT(*) AS total FROM seller_profiles p JOIN organizations o ON o.id = p.organization_id WHERE ${where}`,
        values,
      );
      const result = await pool.query(
        `SELECT o.id AS organization_id, o.name AS organization_name, o.business_type, o.country_code,
                p.coverage_destinations, p.property_city
         FROM seller_profiles p JOIN organizations o ON o.id = p.organization_id
         WHERE ${where}
         ORDER BY o.name ASC, o.id ASC LIMIT $3 OFFSET $4`,
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
          verified: true,
        })),
        pagination: { limit, offset, total: Number(count.rows[0].total) },
      });
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

  router.put('/hotel/inventory', async (request, response, next) => {
    if (request.auth.business_type !== 'hotelier') return fail(response, 403, 'ROLE_FORBIDDEN', 'Only hotelier accounts can update room inventory.');
    if (!Array.isArray(request.body?.inventory) || request.body.inventory.length < 1 || request.body.inventory.length > 300) return fail(response, 400, 'VALIDATION_ERROR', 'Submit between 1 and 300 room inventory rows.');
    const inventory = [];
    const uniqueKeys = new Set();
    for (const item of request.body.inventory) {
      const date = item?.date;
      const roomType = typeof item?.room_type === 'string' ? item.room_type.trim() : '';
      const availableRooms = Number(item?.available_rooms);
      const nightlyRateMinor = item?.nightly_rate_minor == null || item.nightly_rate_minor === '' ? null : Number(item.nightly_rate_minor);
      const currency = typeof item?.currency === 'string' ? item.currency.toUpperCase() : 'USD';
      if (!validDate(date) || roomType.length < 2 || roomType.length > 120 || !Number.isInteger(availableRooms) || availableRooms < 0 || availableRooms > 100) return fail(response, 400, 'VALIDATION_ERROR', 'Each row needs a valid date, room type and availability from 0 to 100.');
      if (nightlyRateMinor != null && (!Number.isSafeInteger(nightlyRateMinor) || nightlyRateMinor < 0)) return fail(response, 400, 'VALIDATION_ERROR', 'Nightly rate must be non-negative integer minor units.');
      if (!/^[A-Z]{3}$/.test(currency)) return fail(response, 400, 'VALIDATION_ERROR', 'Use an ISO 4217 currency code.');
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
            `SELECT r.*, o.name AS agency_name, o.verified_at IS NOT NULL AS agency_verified,
              (SELECT COUNT(*) FROM offers f JOIN seller_profiles p ON p.organization_id = f.seller_organization_id
               WHERE f.request_id = r.id AND p.verification_status = 'approved' AND f.status IN ('submitted', 'shortlisted', 'accepted')) AS offer_count
           FROM marketplace_requests r JOIN organizations o ON o.id = r.agency_organization_id
           WHERE r.agency_organization_id = $1 ORDER BY r.created_at DESC`,
          [request.auth.organization_id],
        );
        return response.json({ requests: result.rows.map(requestDto) });
      }
      const result = await pool.query(
        `SELECT r.*, o.name AS agency_name, o.verified_at IS NOT NULL AS agency_verified,
          (SELECT COUNT(*) FROM offers f JOIN seller_profiles p ON p.organization_id = f.seller_organization_id
           WHERE f.request_id = r.id AND p.verification_status = 'approved' AND f.status IN ('submitted', 'shortlisted', 'accepted')) AS offer_count,
          EXISTS (SELECT 1 FROM offers mine WHERE mine.request_id = r.id AND mine.seller_organization_id = t.seller_organization_id
            AND mine.status IN ('submitted', 'shortlisted', 'accepted')) AS has_active_offer
         FROM request_targets t
         JOIN marketplace_requests r ON r.id = t.request_id
         JOIN organizations o ON o.id = r.agency_organization_id
         WHERE t.seller_organization_id = $1 AND t.declined_at IS NULL
           AND ${sellerCanSeeRequest}
         ORDER BY r.response_deadline ASC`,
        [request.auth.organization_id],
      );
      const offerLimit = await getMaxOffersPerRequest(pool);
      return response.json({ requests: result.rows.map((row) => sellerRequestDto(row, offerLimit)) });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/requests/:requestId', async (request, response, next) => {
    try {
      if (request.auth.business_type === 'agency') {
        const result = await pool.query(
          `SELECT r.*, o.name AS agency_name, o.verified_at IS NOT NULL AS agency_verified,
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
        return response.json({ request: { ...requestDto(result.rows[0]), invitedSellers: invited.rows.map((row) => ({ organizationId: row.id, name: row.name, type: row.business_type })) } });
      }
      const result = await pool.query(
        `SELECT r.seller_visible_snapshot FROM request_targets t
         JOIN marketplace_requests r ON r.id = t.request_id
         WHERE t.request_id = $1 AND t.seller_organization_id = $2 AND t.declined_at IS NULL
           AND ${sellerCanSeeRequest}`,
        [request.params.requestId, request.auth.organization_id],
      );
      if (!result.rowCount) return fail(response, 404, 'REQUEST_NOT_AVAILABLE', 'This request is not available to your organization.');
      return response.json({ request: result.rows[0].seller_visible_snapshot });
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
      const conversation = await pool.query(
        `SELECT r.request_code, r.agency_organization_id, r.status, a.seller_organization_id AS awarded_seller_id,
                seller.id AS seller_organization_id, seller.name AS seller_name, agency.name AS agency_name
         FROM marketplace_requests r
         JOIN request_targets t ON t.request_id = r.id AND t.seller_organization_id = $2 AND t.declined_at IS NULL
         JOIN organizations seller ON seller.id = t.seller_organization_id
         JOIN organizations agency ON agency.id = r.agency_organization_id
         LEFT JOIN awards a ON a.request_id = r.id
         WHERE r.id = $1
           AND ($3 = r.agency_organization_id OR $3 = t.seller_organization_id)
           AND ${sellerCanSeeRequest}`,
        [request.params.requestId, sellerOrganizationId, request.auth.organization_id],
      );
      if (!conversation.rowCount) return fail(response, 404, 'CONVERSATION_NOT_FOUND', 'This request conversation is not available to your organization.');
      const limit = Number(request.query.limit ?? 100);
      const offset = Number(request.query.offset ?? 0);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 10000) return fail(response, 400, 'VALIDATION_ERROR', 'Choose valid message pagination values.');
      const participant = conversation.rows[0];
      const agencyIsSender = request.auth.organization_id === participant.agency_organization_id;
      const peerOrganizationId = agencyIsSender ? participant.seller_organization_id : participant.agency_organization_id;
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
      return response.json({
        requestCode: participant.request_code,
        peerName: agencyIsSender ? participant.seller_name : participant.agency_name,
        messages: messages.rows.map((message) => ({ id: message.id, senderName: message.sender_name, body: message.body, createdAt: message.created_at, isMine: message.sender_organization_id === request.auth.organization_id })),
        pagination: { limit, offset, total: Number(count.rows[0].total) },
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/requests/:requestId/messages', async (request, response, next) => {
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
      const conversation = await client.query(
        `SELECT r.request_code, r.agency_organization_id, r.status, a.seller_organization_id AS awarded_seller_id,
                seller.id AS seller_organization_id, agency.name AS agency_name, seller.name AS seller_name
         FROM marketplace_requests r
         JOIN request_targets t ON t.request_id = r.id AND t.seller_organization_id = $2 AND t.declined_at IS NULL
         JOIN organizations seller ON seller.id = t.seller_organization_id
         JOIN organizations agency ON agency.id = r.agency_organization_id
         LEFT JOIN awards a ON a.request_id = r.id
         WHERE r.id = $1
           AND ($3 = r.agency_organization_id OR $3 = t.seller_organization_id)
           AND ${sellerCanSeeRequest}
         FOR UPDATE OF r`,
        [request.params.requestId, sellerOrganizationId, request.auth.organization_id],
      );
      if (!conversation.rowCount) {
        await client.query('ROLLBACK');
        return fail(response, 404, 'CONVERSATION_NOT_FOUND', 'This request conversation is not available to your organization.');
      }
      const participant = conversation.rows[0];
      const agencyIsSender = request.auth.organization_id === participant.agency_organization_id;
      const recipientOrganizationId = agencyIsSender ? participant.seller_organization_id : participant.agency_organization_id;
      const messageId = randomUUID();
      await client.query(
        `INSERT INTO request_messages (id, request_id, sender_organization_id, recipient_organization_id, sender_user_id, body)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [messageId, request.params.requestId, request.auth.organization_id, recipientOrganizationId, request.auth.user_id, body],
      );
      const senderName = agencyIsSender ? participant.agency_name : participant.seller_name;
      await notify(client, recipientOrganizationId, 'request_message', 'New marketplace message', `${participant.request_code} / New message from ${senderName}`, { requestId: request.params.requestId, requestCode: participant.request_code, messageId });
      await client.query('COMMIT');
      return response.status(201).json({ message: { id: messageId, requestId: request.params.requestId, senderName, body, createdAt: new Date().toISOString(), isMine: true } });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  router.post('/requests', async (request, response, next) => {
    if (request.auth.business_type !== 'agency') return fail(response, 403, 'ROLE_FORBIDDEN', 'Only travel agencies can create marketplace requests.');
    const input = validRequest(request.body ?? {});
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    const id = randomUUID();
    const requestCode = `LX-${randomBytes(4).toString('hex').toUpperCase()}`;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (input.invitedSellerIds.length) {
        const eligible = await client.query(
          `SELECT o.id, o.business_type FROM organizations o
           JOIN seller_profiles p ON p.organization_id = o.id
           WHERE o.id = ANY($1::uuid[]) AND o.id <> $2
             AND o.business_type IN ('dmc', 'hotelier') AND p.verification_status = 'approved'`,
          [input.invitedSellerIds, request.auth.organization_id],
        );
        if (eligible.rowCount !== input.invitedSellerIds.length) {
          await client.query('ROLLBACK');
          return fail(response, 400, 'INVALID_INVITATION', 'Invite only verified DMCs and hotels from the supplier directory.');
        }
        if (!input.services.includes('hotel') && eligible.rows.some((row) => row.business_type === 'hotelier')) {
          await client.query('ROLLBACK');
          return fail(response, 400, 'INVALID_INVITATION', 'Add the hotel service before inviting hotels.');
        }
      }
      const result = await client.query(
        `INSERT INTO marketplace_requests (
           id, request_code, agency_organization_id, destination, destination_country,
           travel_start_date, travel_end_date, travel_month, nights, adults, children, infants,
           group_type, hotel_category, room_count, meal_plan, services,
           budget_min_minor, budget_max_minor, budget_currency, response_deadline, visibility
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
         RETURNING *`,
        [id, requestCode, request.auth.organization_id, input.destination, input.countryCode,
          input.travelStartDate, input.travelEndDate, input.travelMonth, input.nights, input.adults,
          input.children, input.infants, input.groupType, input.hotelCategory, input.roomCount,
          input.mealPlan, input.services, input.budgetMin, input.budgetMax, input.budgetCurrency,
          input.responseDeadline, input.visibility],
      );
      for (const sellerId of input.invitedSellerIds) {
        await client.query('INSERT INTO request_invitations (request_id, seller_organization_id) VALUES ($1, $2)', [id, sellerId]);
      }
      const invited = await client.query(
        `SELECT o.id, o.name, o.business_type FROM request_invitations i
         JOIN organizations o ON o.id = i.seller_organization_id WHERE i.request_id = $1 ORDER BY o.name`,
        [id],
      );
      await client.query('COMMIT');
      const dto = requestDto({ ...result.rows[0], agency_name: request.auth.organization_name, agency_verified: request.auth.verified_at });
      return response.status(201).json({ request: { ...dto, invitedSellers: invited.rows.map((row) => ({ organizationId: row.id, name: row.name, type: row.business_type })) } });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  router.post('/requests/:requestId/publish', async (request, response, next) => {
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
      const updated = await client.query(
        `UPDATE marketplace_requests SET status = 'open', published_at = NOW(), updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [request.params.requestId],
      );
      const row = updated.rows[0];
      const targets = await client.query(
        `INSERT INTO request_targets (request_id, seller_organization_id)
         SELECT $1, profile.organization_id
         FROM seller_profiles profile
         JOIN organizations seller ON seller.id = profile.organization_id
         WHERE profile.verification_status = 'approved'
           AND seller.id <> $2
           AND (seller.business_type = 'dmc' OR (seller.business_type = 'hotelier' AND 'hotel' = ANY($5::text[])))
           AND (
             ($6::text IN ('open', 'open_and_invite') AND (
               (seller.business_type = 'dmc' AND (
                 lower($3) = ANY(SELECT lower(destination) FROM unnest(profile.coverage_destinations) AS destination)
                 OR lower($4) = ANY(SELECT lower(destination) FROM unnest(profile.coverage_destinations) AS destination)
               ))
               OR (seller.business_type = 'hotelier' AND lower(profile.property_city) = lower($3))
             ))
             OR ($6::text IN ('invite_only', 'open_and_invite') AND EXISTS (
               SELECT 1 FROM request_invitations invitation
               WHERE invitation.request_id = $1 AND invitation.seller_organization_id = seller.id
             ))
           )
         ON CONFLICT DO NOTHING RETURNING seller_organization_id`,
        [row.id, request.auth.organization_id, row.destination, row.destination_country, row.services, row.visibility],
      );
      await client.query(
        `UPDATE marketplace_requests r SET seller_visible_snapshot = jsonb_build_object(
           'requestCode', r.request_code, 'destination', r.destination,
           'destinationCountry', r.destination_country, 'travelStartDate', r.travel_start_date,
           'travelEndDate', r.travel_end_date, 'travelMonth', r.travel_month,
           'nights', r.nights, 'adults', r.adults, 'children', r.children, 'infants', r.infants,
           'groupType', r.group_type, 'hotelCategory', r.hotel_category, 'roomCount', r.room_count,
           'mealPlan', r.meal_plan, 'services', r.services, 'budgetMinMinor', r.budget_min_minor,
           'budgetMaxMinor', r.budget_max_minor, 'budgetCurrency', r.budget_currency,
           'responseDeadline', r.response_deadline, 'agencyName', o.name,
           'agencyVerified', (o.verified_at IS NOT NULL)
         ) FROM organizations o WHERE r.id = $1 AND o.id = r.agency_organization_id`,
        [row.id],
      );
      for (const target of targets.rows) {
        await notify(client, target.seller_organization_id, 'request_matched', 'New matching request', `${row.request_code} / ${row.destination} / ${row.nights} nights`, { requestId: row.id, requestCode: row.request_code, destination: row.destination });
      }
      await client.query('COMMIT');
      return response.json({ request: { ...requestDto({ ...row, agency_name: request.auth.organization_name, agency_verified: request.auth.verified_at }), status: 'open' }, targetedSellerCount: targets.rowCount });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  router.post('/requests/:requestId/close', async (request, response, next) => {
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

  router.post('/requests/:requestId/decline', async (request, response, next) => {
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

  router.post('/requests/:requestId/offers', async (request, response, next) => {
    const isDmc = request.auth.business_type === 'dmc';
    const isHotelier = request.auth.business_type === 'hotelier';
    if (!isDmc && !isHotelier) return fail(response, 403, 'ROLE_FORBIDDEN', 'Only DMCs and hoteliers can submit seller offers.');
    const totalMinor = isDmc ? Number(request.body?.total_minor) : null;
    const ratePerNightMinor = isHotelier ? Number(request.body?.rate_per_night_minor) : null;
    const roomType = isHotelier && typeof request.body?.room_type === 'string' ? request.body.room_type.trim() : null;
    const mealPlan = isHotelier && mealPlans.has(request.body?.meal_plan) ? request.body.meal_plan : null;
    const currency = typeof request.body?.currency === 'string' ? request.body.currency.toUpperCase() : '';
    const inclusions = Array.isArray(request.body?.inclusions) ? [...new Set(request.body.inclusions)] : [];
    const exclusions = Array.isArray(request.body?.exclusions) ? [...new Set(request.body.exclusions)] : [];
    const validityUntil = typeof request.body?.validity_until === 'string' ? new Date(request.body.validity_until) : null;
    if (isDmc && (!Number.isSafeInteger(totalMinor) || totalMinor <= 0)) return fail(response, 400, 'VALIDATION_ERROR', 'Offer total must be a positive integer in minor currency units.');
    if (isHotelier && (!Number.isSafeInteger(ratePerNightMinor) || ratePerNightMinor <= 0 || !roomType || roomType.length > 120)) return fail(response, 400, 'VALIDATION_ERROR', 'A valid per-night rate and room type are required.');
    if (!/^[A-Z]{3}$/.test(currency)) return fail(response, 400, 'VALIDATION_ERROR', 'Use an ISO 4217 currency code.');
    if (inclusions.length > 20 || exclusions.length > 20 || [...inclusions, ...exclusions].some((item) => !offerInclusions.has(item))) return fail(response, 400, 'VALIDATION_ERROR', 'Use supported structured inclusion and exclusion values.');
    if (!validityUntil || Number.isNaN(validityUntil.getTime()) || validityUntil <= new Date()) return fail(response, 400, 'VALIDATION_ERROR', 'Offer validity must be in the future.');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const profile = await client.query('SELECT verification_status FROM seller_profiles WHERE organization_id = $1', [request.auth.organization_id]);
      if (profile.rows[0]?.verification_status !== 'approved') {
        await client.query('ROLLBACK');
        return fail(response, 403, 'SELLER_NOT_VERIFIED', 'Your seller profile must be verified before submitting offers.');
      }
      const target = await client.query(
        `SELECT r.id, r.agency_organization_id, r.request_code, r.destination, r.services, r.response_deadline
         FROM request_targets t JOIN marketplace_requests r ON r.id = t.request_id
         WHERE t.request_id = $1 AND t.seller_organization_id = $2 AND t.declined_at IS NULL AND r.status = 'open'
         FOR UPDATE OF r`,
        [request.params.requestId, request.auth.organization_id],
      );
      if (!target.rowCount) {
        await client.query('ROLLBACK');
        return fail(response, 404, 'REQUEST_NOT_AVAILABLE', 'This request is not available to your organization.');
      }
      if (new Date(target.rows[0].response_deadline) <= new Date()) {
        await client.query('ROLLBACK');
        return fail(response, 409, 'RESPONSE_DEADLINE_PASSED', 'The response deadline for this request has passed.');
      }
      if (isHotelier && !target.rows[0].services.includes('hotel')) {
        await client.query('ROLLBACK');
        return fail(response, 409, 'HOTEL_NOT_REQUESTED', 'The agency did not request hotel services.');
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
           room_type, currency, inclusions, exclusions, meal_plan, validity_until)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id, request_id, offer_kind, total_minor, rate_per_night_minor, room_type, currency,
           inclusions, exclusions, meal_plan, validity_until, status, created_at`,
        [randomUUID(), request.params.requestId, request.auth.organization_id, isDmc ? 'land_package' : 'hotel_room',
          totalMinor, ratePerNightMinor, roomType, currency, inclusions, exclusions, mealPlan, validityUntil],
      );
      const offer = result.rows[0];
      await notify(client, target.rows[0].agency_organization_id, 'offer_submitted', 'New seller offer', `${target.rows[0].request_code} / ${request.auth.organization_name} / ${target.rows[0].destination}`, { requestId: request.params.requestId, requestCode: target.rows[0].request_code, offerId: offer.id });
      await client.query('COMMIT');
      return response.status(201).json({ offer: { id: offer.id, requestId: offer.request_id, kind: offer.offer_kind, totalMinor: offer.total_minor, ratePerNightMinor: offer.rate_per_night_minor, roomType: offer.room_type, currency: offer.currency, inclusions: offer.inclusions, exclusions: offer.exclusions, mealPlan: offer.meal_plan, validityUntil: offer.validity_until, status: offer.status, createdAt: offer.created_at } });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error.code === '23505') return fail(response, 409, 'OFFER_ALREADY_SUBMITTED', 'Your organization already has an active offer for this request.');
      return next(error);
    } finally {
      client.release();
    }
  });

  router.get('/requests/:requestId/offers', async (request, response, next) => {
    if (request.auth.business_type !== 'agency') return fail(response, 403, 'ROLE_FORBIDDEN', 'Only the requesting agency can compare offers.');
    try {
      const ownedRequest = await pool.query('SELECT id FROM marketplace_requests WHERE id = $1 AND agency_organization_id = $2', [request.params.requestId, request.auth.organization_id]);
      if (!ownedRequest.rowCount) return fail(response, 404, 'REQUEST_NOT_FOUND', 'Request was not found.');
      const result = await pool.query(
        `SELECT f.id, f.seller_organization_id, f.offer_kind, f.total_minor, f.rate_per_night_minor, f.room_type, f.meal_plan, f.currency, f.inclusions, f.exclusions,
                f.validity_until, f.status, f.created_at, seller.name AS seller_name
         FROM offers f JOIN organizations seller ON seller.id = f.seller_organization_id
         JOIN seller_profiles profile ON profile.organization_id = seller.id
         WHERE f.request_id = $1 AND profile.verification_status = 'approved'
           AND f.status IN ('submitted', 'shortlisted', 'accepted')
         ORDER BY f.created_at ASC`,
        [request.params.requestId],
      );
      return response.json({ offers: result.rows.map((offer) => ({ id: offer.id, sellerOrganizationId: offer.seller_organization_id, sellerName: offer.seller_name, kind: offer.offer_kind, totalMinor: offer.total_minor, ratePerNightMinor: offer.rate_per_night_minor, roomType: offer.room_type, mealPlan: offer.meal_plan, currency: offer.currency, inclusions: offer.inclusions, exclusions: offer.exclusions, validityUntil: offer.validity_until, status: offer.status, createdAt: offer.created_at })) });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/offers/:offerId', async (request, response, next) => {
    try {
      const result = await pool.query(
        `SELECT f.id, f.request_id, f.seller_organization_id, f.offer_kind, f.total_minor,
                f.rate_per_night_minor, f.room_type, f.currency, f.inclusions, f.exclusions,
                f.meal_plan, f.cancellation_policy, f.validity_until, f.status, f.created_at,
                r.agency_organization_id, r.request_code, r.destination, seller.name AS seller_name
         FROM offers f JOIN marketplace_requests r ON r.id = f.request_id
         JOIN organizations seller ON seller.id = f.seller_organization_id
         WHERE f.id = $1`,
        [request.params.offerId],
      );
      const offer = result.rows[0];
      if (!offer) return fail(response, 404, 'OFFER_NOT_FOUND', 'Offer was not found.');
      const isOwnSellerOffer = offer.seller_organization_id === request.auth.organization_id;
      const isRequestingAgency = offer.agency_organization_id === request.auth.organization_id && request.auth.business_type === 'agency';
      if (!isOwnSellerOffer && !isRequestingAgency) return fail(response, 404, 'OFFER_NOT_FOUND', 'Offer was not found.');
      return response.json({ offer: { id: offer.id, requestId: offer.request_id, requestCode: offer.request_code, destination: offer.destination, kind: offer.offer_kind, totalMinor: offer.total_minor, ratePerNightMinor: offer.rate_per_night_minor, roomType: offer.room_type, currency: offer.currency, inclusions: offer.inclusions, exclusions: offer.exclusions, mealPlan: offer.meal_plan, cancellationPolicy: offer.cancellation_policy, validityUntil: offer.validity_until, status: offer.status, createdAt: offer.created_at, ...(isRequestingAgency ? { sellerName: offer.seller_name } : {}) } });
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

  router.put('/offers/:offerId', async (request, response, next) => {
    if (!['dmc', 'hotelier'].includes(request.auth.business_type)) return fail(response, 403, 'ROLE_FORBIDDEN', 'Only the seller can revise its offer.');
    const currency = typeof request.body?.currency === 'string' ? request.body.currency.toUpperCase() : '';
    const inclusions = Array.isArray(request.body?.inclusions) ? [...new Set(request.body.inclusions)] : [];
    const exclusions = Array.isArray(request.body?.exclusions) ? [...new Set(request.body.exclusions)] : [];
    const validityUntil = typeof request.body?.validity_until === 'string' ? new Date(request.body.validity_until) : null;
    if (!/^[A-Z]{3}$/.test(currency) || !validityUntil || Number.isNaN(validityUntil.getTime()) || validityUntil <= new Date()) return fail(response, 400, 'VALIDATION_ERROR', 'Provide a supported currency and future offer validity.');
    if ([...inclusions, ...exclusions].some((item) => !offerInclusions.has(item))) return fail(response, 400, 'VALIDATION_ERROR', 'Use supported structured inclusion and exclusion values.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(
        `SELECT f.*, r.agency_organization_id, r.response_deadline FROM offers f JOIN marketplace_requests r ON r.id = f.request_id
         WHERE f.id = $1 AND f.seller_organization_id = $2 AND r.status = 'open'
           AND f.status IN ('submitted', 'shortlisted') FOR UPDATE`,
        [request.params.offerId, request.auth.organization_id],
      );
      if (!current.rowCount) {
        await client.query('ROLLBACK');
        return fail(response, 404, 'OFFER_NOT_EDITABLE', 'This active offer was not found.');
      }
      const oldOffer = current.rows[0];
      if (new Date(oldOffer.response_deadline) <= new Date()) {
        await client.query('ROLLBACK');
        return fail(response, 409, 'RESPONSE_DEADLINE_PASSED', 'Offers cannot be revised after the response deadline.');
      }
      if ((request.auth.business_type === 'dmc' && oldOffer.offer_kind !== 'land_package') || (request.auth.business_type === 'hotelier' && oldOffer.offer_kind !== 'hotel_room')) {
        await client.query('ROLLBACK');
        return fail(response, 403, 'ROLE_FORBIDDEN', 'This offer type does not belong to your seller role.');
      }
      const valueMinor = Number(request.body?.total_minor ?? request.body?.rate_per_night_minor);
      if (!Number.isSafeInteger(valueMinor) || valueMinor <= 0) {
        await client.query('ROLLBACK');
        return fail(response, 400, 'VALIDATION_ERROR', 'Offer price must be a positive integer in minor units.');
      }
      const roomType = oldOffer.offer_kind === 'hotel_room' && typeof request.body?.room_type === 'string' ? request.body.room_type.trim() : oldOffer.room_type;
      if (oldOffer.offer_kind === 'hotel_room' && (!roomType || roomType.length > 120)) {
        await client.query('ROLLBACK');
        return fail(response, 400, 'VALIDATION_ERROR', 'Provide a valid room type.');
      }
      const latestRevision = await client.query('SELECT COALESCE(MAX(revision_number), 0) AS revision_number FROM offer_revisions WHERE offer_id = $1', [oldOffer.id]);
      const snapshot = { offerKind: oldOffer.offer_kind, totalMinor: oldOffer.total_minor, ratePerNightMinor: oldOffer.rate_per_night_minor, roomType: oldOffer.room_type, currency: oldOffer.currency, inclusions: oldOffer.inclusions, exclusions: oldOffer.exclusions, mealPlan: oldOffer.meal_plan, cancellationPolicy: oldOffer.cancellation_policy, validityUntil: oldOffer.validity_until, status: oldOffer.status };
      await client.query('INSERT INTO offer_revisions (id, offer_id, revision_number, snapshot) VALUES ($1, $2, $3, $4)', [randomUUID(), oldOffer.id, Number(latestRevision.rows[0].revision_number) + 1, JSON.stringify(snapshot)]);
      const revised = await client.query(
        `UPDATE offers SET total_minor = $2, rate_per_night_minor = $3, room_type = $4,
           currency = $5, inclusions = $6, exclusions = $7, meal_plan = $8,
           cancellation_policy = $9, validity_until = $10, status = 'submitted', updated_at = NOW()
         WHERE id = $1
         RETURNING id, request_id, offer_kind, total_minor, rate_per_night_minor, room_type,
           currency, inclusions, exclusions, meal_plan, cancellation_policy, validity_until, status`,
        [oldOffer.id, oldOffer.offer_kind === 'land_package' ? valueMinor : null,
          oldOffer.offer_kind === 'hotel_room' ? valueMinor : null, roomType, currency,
          inclusions, exclusions, oldOffer.offer_kind === 'hotel_room' ? request.body?.meal_plan ?? oldOffer.meal_plan : null,
          typeof request.body?.cancellation_policy === 'string' ? request.body.cancellation_policy.slice(0, 1000) : oldOffer.cancellation_policy,
          validityUntil],
      );
      await notify(client, oldOffer.agency_organization_id, 'offer_revised', 'Seller revised an offer', `${oldOffer.request_id} / ${request.auth.organization_name}`, { offerId: oldOffer.id, requestId: oldOffer.request_id });
      await client.query('COMMIT');
      return response.json({ offer: { id: revised.rows[0].id, requestId: revised.rows[0].request_id, kind: revised.rows[0].offer_kind, totalMinor: revised.rows[0].total_minor, ratePerNightMinor: revised.rows[0].rate_per_night_minor, roomType: revised.rows[0].room_type, currency: revised.rows[0].currency, inclusions: revised.rows[0].inclusions, exclusions: revised.rows[0].exclusions, mealPlan: revised.rows[0].meal_plan, cancellationPolicy: revised.rows[0].cancellation_policy, validityUntil: revised.rows[0].validity_until, status: revised.rows[0].status } });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  router.post('/offers/:offerId/withdraw', async (request, response, next) => {
    if (!['dmc', 'hotelier'].includes(request.auth.business_type)) return fail(response, 403, 'ROLE_FORBIDDEN', 'Only the seller can withdraw its offer.');
    try {
      const result = await pool.query(
        `UPDATE offers f SET status = 'withdrawn', updated_at = NOW()
         FROM marketplace_requests r WHERE f.id = $1 AND f.request_id = r.id
           AND f.seller_organization_id = $2 AND r.status = 'open' AND f.status IN ('submitted', 'shortlisted')
         RETURNING f.id, f.request_id, r.agency_organization_id, r.request_code, r.destination`,
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
        return response.json({ offers: agencyOffers.rows.map((offer) => ({ id: offer.id, requestId: offer.request_id, requestCode: offer.request_code, destination: offer.destination, sellerName: offer.seller_name, kind: offer.offer_kind, totalMinor: offer.total_minor, ratePerNightMinor: offer.rate_per_night_minor, roomType: offer.room_type, mealPlan: offer.meal_plan, currency: offer.currency, inclusions: offer.inclusions, exclusions: offer.exclusions, validityUntil: offer.validity_until, status: offer.status, createdAt: offer.created_at })) });
      }
      if (request.auth.business_type === 'hotelier') {
        const hotelOffers = await pool.query(
          `SELECT f.id, f.request_id, r.request_code, r.destination, f.rate_per_night_minor,
                  f.room_type, f.meal_plan, f.currency, f.validity_until, f.status, f.outcome_reason, f.created_at
           FROM offers f JOIN marketplace_requests r ON r.id = f.request_id
           WHERE f.seller_organization_id = $1 ORDER BY f.created_at DESC`,
          [request.auth.organization_id],
        );
        return response.json({ offers: hotelOffers.rows.map((offer) => ({ id: offer.id, requestId: offer.request_id, requestCode: offer.request_code, destination: offer.destination, kind: 'hotel_room', ratePerNightMinor: offer.rate_per_night_minor, roomType: offer.room_type, mealPlan: offer.meal_plan, currency: offer.currency, validityUntil: offer.validity_until, status: offer.status, outcomeReason: offer.outcome_reason, createdAt: offer.created_at })) });
      }
      if (request.auth.business_type !== 'dmc') return fail(response, 403, 'ROLE_FORBIDDEN', 'This offer inbox is for sellers.');
      const result = await pool.query(
        `SELECT f.id, f.request_id, r.request_code, r.destination, f.total_minor, f.currency,
                f.inclusions, f.exclusions, f.validity_until, f.status, f.outcome_reason, f.created_at,
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
      return response.json({ offers: result.rows.map((offer) => ({ id: offer.id, requestId: offer.request_id, requestCode: offer.request_code, destination: offer.destination, totalMinor: offer.total_minor, currency: offer.currency, inclusions: offer.inclusions, exclusions: offer.exclusions, validityUntil: offer.validity_until, status: offer.status, outcomeReason: offer.outcome_reason, createdAt: offer.created_at, rank: Number(offer.seller_rank), eligibleCount: Number(offer.eligible_count) })) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/requests/:requestId/award', async (request, response, next) => {
    if (request.auth.business_type !== 'agency') return fail(response, 403, 'ROLE_FORBIDDEN', 'Only the requesting agency can award an offer.');
    const offerId = typeof request.body?.offer_id === 'string' ? request.body.offer_id : '';
    if (!/^[0-9a-f-]{36}$/i.test(offerId)) return fail(response, 400, 'VALIDATION_ERROR', 'Choose an offer to award.');
    const notSelectedReason = typeof request.body?.not_selected_reason === 'string' ? request.body.not_selected_reason.trim() : '';
    if (notSelectedReason.length > 300) return fail(response, 400, 'VALIDATION_ERROR', 'Keep the not-selected reason under 300 characters.');
    if (contactDetailsPattern.test(notSelectedReason)) return fail(response, 400, 'CONTACT_DETAILS_NOT_ALLOWED', 'Remove contact details and external links from the not-selected reason.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const requestRow = await client.query("SELECT id FROM marketplace_requests WHERE id = $1 AND agency_organization_id = $2 AND status IN ('open', 'closed') FOR UPDATE", [request.params.requestId, request.auth.organization_id]);
      if (!requestRow.rowCount) {
        await client.query('ROLLBACK');
        return fail(response, 404, 'REQUEST_NOT_AVAILABLE', 'This open or closed request was not found.');
      }
      const selected = await client.query(
        `SELECT f.id, f.seller_organization_id FROM offers f JOIN seller_profiles p ON p.organization_id = f.seller_organization_id
         WHERE f.id = $1 AND f.request_id = $2 AND f.status IN ('submitted', 'shortlisted') AND p.verification_status = 'approved'`,
        [offerId, request.params.requestId],
      );
      if (!selected.rowCount) {
        await client.query('ROLLBACK');
        return fail(response, 404, 'OFFER_NOT_AVAILABLE', 'The selected offer is not available for this request.');
      }
      const awardId = randomUUID();
      await client.query(
        'INSERT INTO awards (id, request_id, offer_id, agency_organization_id, seller_organization_id) VALUES ($1, $2, $3, $4, $5)',
        [awardId, request.params.requestId, offerId, request.auth.organization_id, selected.rows[0].seller_organization_id],
      );
      await client.query("UPDATE marketplace_requests SET status = 'awarded', updated_at = NOW() WHERE id = $1", [request.params.requestId]);
      const outcomes = await client.query(
        `UPDATE offers SET status = CASE WHEN id = $2 THEN 'accepted' ELSE 'rejected' END,
           outcome_reason = CASE WHEN id = $2 THEN NULL ELSE $3::varchar END, updated_at = NOW()
         WHERE request_id = $1 AND status IN ('submitted', 'shortlisted') RETURNING seller_organization_id, status`,
        [request.params.requestId, offerId, notSelectedReason || null],
      );
      const requestDetails = await client.query('SELECT request_code, destination FROM marketplace_requests WHERE id = $1', [request.params.requestId]);
      for (const outcome of outcomes.rows) {
        const selected = outcome.status === 'accepted';
        const summary = `${requestDetails.rows[0].request_code} / ${requestDetails.rows[0].destination}`;
        await notify(client, outcome.seller_organization_id, selected ? 'offer_awarded' : 'offer_not_selected', selected ? 'Your offer was awarded' : 'Offer not selected', selected || !notSelectedReason ? summary : `${summary} / Reason: ${notSelectedReason}`, { requestId: request.params.requestId, requestCode: requestDetails.rows[0].request_code, awardId, offerId: selected ? offerId : null });
      }
      await client.query('COMMIT');
      return response.status(201).json({ award: { id: awardId, requestId: request.params.requestId, offerId, sellerOrganizationId: selected.rows[0].seller_organization_id, status: 'awarded' } });
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
        `SELECT a.id, a.request_id, r.request_code, r.destination, a.offer_id, a.status,
                a.created_at, a.booking_confirmed_at, a.agency_organization_id,
                a.seller_organization_id, o.name AS seller_name
         FROM awards a JOIN marketplace_requests r ON r.id = a.request_id
         JOIN organizations o ON o.id = a.seller_organization_id WHERE a.id = $1`,
        [request.params.awardId],
      );
      const award = result.rows[0];
      if (!award || (award.agency_organization_id !== request.auth.organization_id && award.seller_organization_id !== request.auth.organization_id)) return fail(response, 404, 'AWARD_NOT_FOUND', 'Award was not found.');
      return response.json({ award: { id: award.id, requestId: award.request_id, requestCode: award.request_code, destination: award.destination, offerId: award.offer_id, sellerName: award.seller_name, status: award.status, createdAt: award.created_at, bookingConfirmedAt: award.booking_confirmed_at, guestDetailsReleased: false } });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}