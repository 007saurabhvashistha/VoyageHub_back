import { Router } from 'express';
import { z } from 'zod';
import { config, countryList, currencyList, isCountryCode } from '../config/index.js';
import { bookingStatuses, businessTypes, destinationKinds, documentScanStatuses, groupTypes, guestAccessActions, hotelCategories, legalDocumentTypes, mealPlans, memberRoles, offerInclusions, offerLineItemTypes, operationRunKinds, reportCategories, reportTargetTypes, requestVisibilities, serviceTypes, travellerTypes, verificationDocumentTypes, webhookDeliveryStatuses, webhookEventTypes } from '../config/referenceData.js';
import { destinationDto, searchDestinations } from '../services/destinations.js';
import { getMaxOffersPerRequest } from '../services/platformSettings.js';
import { createRateLimiter } from '../utils/rateLimit.js';
import { parseWith } from '../utils/validation.js';

const kindValues = destinationKinds.map((kind) => kind.value);
const destinationSearchSchema = z.object({
  q: z.string().trim().min(1, 'Type at least one character.').max(120),
  country: z.string().trim().toUpperCase().refine(isCountryCode, 'Choose a valid ISO country code.').optional(),
  kinds: z.string().optional().transform((value) => value ? value.split(',') : null).pipe(z.array(z.enum(kindValues)).nullable()),
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
    offerInclusions,
    offerLineItemTypes,
    reportCategories,
    reportTargetTypes,
    requestVisibilities,
    memberRoles,
    destinationKinds,
    legalDocumentTypes,
    verificationDocumentTypes,
    documentScanStatuses,
    bookingStatuses,
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

  router.get('/destinations', searchLimiter, async (request, response, next) => {
    const input = parseWith(destinationSearchSchema, request.query);
    if (input.error) return response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: input.error } });
    if (!pool) return response.status(503).json({ error: { code: 'DATABASE_NOT_CONFIGURED', message: 'Destination search is unavailable.' } });
    try {
      const rows = await searchDestinations(pool, { query: input.data.q, countryCode: input.data.country ?? null, kinds: input.data.kinds, limit: config.destinationSearchLimit });
      response.set('cache-control', 'public, max-age=300');
      return response.json({ destinations: rows.map(destinationDto) });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/', async (_request, response, next) => {
    try {
      const maxOffersPerRequest = pool ? await getMaxOffersPerRequest(pool) : null;
      response.set('cache-control', 'private, max-age=300');
      return response.json({
        ...staticData,
        limits: {
          maxInvitedSuppliers: config.maxInvitedSuppliers,
          maxOffersPerRequest,
          requestDeadline: config.requestDeadline,
          offerValidity: config.offerValidity,
          invitationTtlHours: config.invitationTtlHours,
          maxOfferLineItems: config.maxOfferLineItems,
          maxCoverageDestinations: config.maxCoverageDestinations,
          documentUpload: { maxBytes: config.documents.maxBytes, allowedMimeTypes: config.documents.allowedMimeTypes },
          maxVouchersPerBooking: config.bookings.maxVouchersPerBooking,
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
