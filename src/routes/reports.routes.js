import { Router } from 'express';
import { getAgencyReport, getSellerPerformance, parseAnalyticsRange } from '../services/marketplaceAnalytics.js';
import { loadSession, requireActiveAccount, requireMfaForPlatformAdmin } from './auth.routes.js';

function fail(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

export function createReportsRouter({ pool }) {
  const router = Router();
  router.use((request, response, next) => loadSession(pool, request, response, next));
  router.use(requireMfaForPlatformAdmin);
  router.use((request, response, next) => requireActiveAccount(pool, request, response, next));

  router.get('/agency', async (request, response, next) => {
    if (request.auth.business_type !== 'agency') return fail(response, 403, 'ROLE_FORBIDDEN', 'Agency reports are available only to agency organizations.');
    const range = parseAnalyticsRange(request.query);
    if (range.error) return fail(response, 400, 'VALIDATION_ERROR', range.error);
    try {
      return response.json({ range: { from: range.from, to: range.to }, metrics: await getAgencyReport(pool, request.auth.organization_id, range) });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/seller', async (request, response, next) => {
    if (request.auth.business_type === 'agency') return fail(response, 403, 'ROLE_FORBIDDEN', 'Seller performance is available only to seller organizations.');
    const range = parseAnalyticsRange(request.query);
    if (range.error) return fail(response, 400, 'VALIDATION_ERROR', range.error);
    try {
      return response.json({ range: { from: range.from, to: range.to }, metrics: await getSellerPerformance(pool, request.auth.organization_id, range) });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}