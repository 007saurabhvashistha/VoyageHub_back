import { Router } from 'express';
import { z } from 'zod';
import { config, countryList, currencyList, isCountryCode } from '../config/index.js';
import { agencyVerificationStatuses, alertDeliveryModes, bookingChangeStatuses, bookingChangeTypes, bookingStatuses, businessTypes, comparisonLabels, coverageModes, destinationKinds, destinationParentKinds, documentScanStatuses, groupTypes, guestAccessActions, hotelCategories, hotelPropertyStatuses, legalDocumentTypes, matchTypes, mealPlans, memberRoles, negotiationKinds, negotiationStatuses, offerInclusions, offerLineItemTypes, operationRunKinds, reportCategories, reportTargetTypes, requestVisibilities, requirementTypes, serviceTypes, travellerTypes, verificationDocumentTypes, webhookDeliveryStatuses, webhookEventTypes } from '../config/referenceData.js';
import { destinationDto, listChildren, listCountryRoots, loadLevelLabels, searchDestinations } from '../services/destinations.js';
import { propertyDestinationKinds } from '../services/hotelProperties.js';
import { getMaxOffersPerRequest, getSetting } from '../services/platformSettings.js';
import { createRateLimiter } from '../utils/rateLimit.js';
import { parseWith } from '../utils/validation.js';

const kindValues = destinationKinds.map((kind) => kind.value);
const destinationSearchSchema = z.object({
  q: z.string().trim().min(1, 'Type at least one character.').max(120),
  country: z.string().trim().toUpperCase().refine(isCountryCode, 'Choose a valid ISO country code.').optional(),
  kinds: z.string().optional().transform((value) => value ? value.split(',') : null).pipe(z.array(z.enum(kindValues)).nullable()),
  featured: z.stringbool().optional(),
});

export function createReferenceDataRouter({ pool, cookieName }) {
  const router = Router();
  const searchLimiter = createRateLimiter(config.rateLimits.destinationSearch, 'Too many destination searches. Try again shortly.');
  const sessionHours = config.sessionLifetimeMs / 3600000;
  const staticData = {
    businessTypes,
    groupTypes,
    mealPlans,
    hotelCategories,
    services: serviceTypes,
    requirementTypes,
    coverageModes,
    matchTypes,
    alertDeliveryModes,
    hotelPropertyStatuses,
    hotelPropertyDestinationKinds: propertyDestinationKinds,
    offerInclusions,
    offerLineItemTypes,
    comparisonLabels,
    negotiationKinds,
    negotiationStatuses,
    reportCategories,
    reportTargetTypes,
    requestVisibilities,
    memberRoles,
    destinationKinds,
    destinationParentKinds,
    legalDocumentTypes,
    verificationDocumentTypes,
    documentScanStatuses,
    agencyVerificationStatuses,
    bookingStatuses,
    bookingChangeTypes,
    bookingChangeStatuses,
    travellerTypes,
    guestAccessActions,
    webhookEventTypes,
    webhookDeliveryStatuses,
    operationRunKinds,
    cookies: [
      { name: cookieName, category: 'strictly_necessary', purpose: 'Keeps you signed in and protects actions with a CSRF check.', lifetimeHours: sessionHours },
      { name: `${cookieName}_mfa_challenge`, category: 'strictly_necessary', purpose: 'Completes two-step sign-in.', lifetimeHours: config.mfaChallengeTtlMs / 3600000 },
    ],
    countries: countryList(),
    currencies: currencyList(),
    defaults: { country: config.defaultCountry, currency: config.defaultCurrency },
  };

  router.get('/countries', (_request, response) => {
    response.set('cache-control', 'public, max-age=86400');
    return response.json({ countries: countryList(), defaultCountry: config.defaultCountry });
  });

  router.get('/destinations', searchLimiter, async (request, response, next) => {
    const input = parseWith(destinationSearchSchema, request.query);
    if (input.error) return response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: input.error } });
    if (!pool) return response.status(503).json({ error: { code: 'DATABASE_NOT_CONFIGURED', message: 'Destination search is unavailable.' } });
    try {
      const enabledCountries = await getSetting(pool, 'destination_countries');
      const rows = await searchDestinations(pool, { query: input.data.q, countryCode: input.data.country ?? null, countryCodes: enabledCountries, kinds: input.data.kinds, limit: config.destinationSearchLimit, featuredOnly: input.data.featured ?? false });
      response.set('cache-control', 'public, max-age=300');
      return response.json({ destinations: rows.map(destinationDto) });
    } catch (error) {
      return next(error);
    }
  });

  // Countries offered in pickers with their level labels; falls back to every country that has destinations.
  router.get('/destination-countries', searchLimiter, async (_request, response, next) => {
    if (!pool) return response.status(503).json({ error: { code: 'DATABASE_NOT_CONFIGURED', message: 'Destination data is unavailable.' } });
    try {
      let codes = await getSetting(pool, 'destination_countries');
      if (!codes.length) codes = (await pool.query("SELECT country_code FROM destinations WHERE kind = 'country' AND active ORDER BY name")).rows.map((row) => row.country_code);
      const [roots, labels] = [await listCountryRoots(pool, codes), await loadLevelLabels(pool, codes)];
      response.set('cache-control', 'private, max-age=300');
      return response.json({ countries: roots.map((row) => ({ ...destinationDto(row), levels: labels.find((item) => item.countryCode === row.country_code)?.levels ?? [] })) });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/destinations/:destinationId/children', searchLimiter, async (request, response, next) => {
    if (!z.uuid().safeParse(request.params.destinationId).success) return response.status(404).json({ error: { code: 'DESTINATION_NOT_FOUND', message: 'Destination was not found.' } });
    if (!pool) return response.status(503).json({ error: { code: 'DATABASE_NOT_CONFIGURED', message: 'Destination data is unavailable.' } });
    try {
      const rows = await listChildren(pool, request.params.destinationId, { limit: config.destinationChildrenLimit });
      response.set('cache-control', 'public, max-age=300');
      return response.json({ destinations: rows.map(destinationDto) });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/', async (_request, response, next) => {
    try {
      const maxOffersPerRequest = pool ? await getMaxOffersPerRequest(pool) : null;
      const routingLimits = pool ? {
        maxRequestDestinations: await getSetting(pool, 'max_request_destinations'),
        hotelLeadAllowedDestinationKinds: await getSetting(pool, 'hotel_lead_allowed_destination_kinds'),
        maxOffersPerHotelOrgPerRequest: await getSetting(pool, 'max_offers_per_hotel_org_per_request'),
        maxHotelPropertiesPerOrganization: await getSetting(pool, 'max_hotel_properties_per_organization'),
      } : {};
      response.set('cache-control', 'private, max-age=300');
      return response.json({
        ...staticData,
        limits: {
          maxInvitedSuppliers: config.maxInvitedSuppliers,
          maxOffersPerRequest,
          ...routingLimits,
          requestDeadline: config.requestDeadline,
          offerValidity: config.offerValidity,
          invitationTtlHours: config.invitationTtlHours,
          maxOfferLineItems: config.maxOfferLineItems,
          maxOfferOptions: config.maxOfferOptions,
          maxNegotiationRoundsPerOffer: config.maxNegotiationRoundsPerOffer,
          maxAwardsPerRequest: config.awards.maxPerRequest,
          awardUndoWindowMinutes: config.awards.undoWindowMs / 60000,
          bookingChanges: config.bookingChanges,
          maxCoverageDestinations: config.maxCoverageDestinations,
          documentUpload: { maxBytes: config.documents.maxBytes, allowedMimeTypes: config.documents.allowedMimeTypes },
          maxVouchersPerBooking: config.bookings.maxVouchersPerBooking,
          maxOfferAttachments: config.attachments.maxPerOffer,
          maxMessageAttachmentsPerConversation: config.attachments.maxPerConversation,
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
