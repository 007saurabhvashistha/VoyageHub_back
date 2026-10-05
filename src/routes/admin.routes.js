import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { loadSession, requireActiveAccount, requireCsrf, requireMfaForPlatformAdmin } from './auth.routes.js';
import { listSettings, platformSettingDefinitions, settingErrorMessage, settingSchema, updateSetting } from '../services/platformSettings.js';
import { retargetSeller } from '../services/routing.js';
import { registerHotelPropertyAdminRoutes } from './adminHotelProperties.routes.js';
import { registerModerationRoutes } from './moderation.routes.js';
import { registerDestinationAdminRoutes } from './adminDestinations.routes.js';
import { registerLegalAdminRoutes } from './adminLegal.routes.js';
import { registerDocumentAdminRoutes } from './adminDocuments.routes.js';
import { registerOperationsAdminRoutes } from './adminOperations.routes.js';
import { registerAgencyVerificationAdminRoutes } from './adminAgencyVerification.routes.js';
import { verificationDecisionSchema, verificationDocumentStatus } from '../services/verificationDocuments.js';
import { parseWith } from '../utils/validation.js';

function fail(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

export function createAdminRouter({ pool, storage = null }) {
  const router = Router();
  router.use((request, response, next) => loadSession(pool, request, response, next));
  router.use((request, response, next) => request.auth.is_platform_admin
    ? next()
    : fail(response, 403, 'ADMIN_REQUIRED', 'Platform administrator access is required.'));
  router.use(requireMfaForPlatformAdmin);
  // Registered before the legal-acceptance guard so an admin can publish every document in one session.
  registerLegalAdminRoutes(router, pool);
  router.use((request, response, next) => requireActiveAccount(pool, request, response, next));
  registerModerationRoutes(router, pool);
  registerDestinationAdminRoutes(router, pool);
  registerDocumentAdminRoutes(router, pool, storage);
  registerOperationsAdminRoutes(router, pool);
  registerAgencyVerificationAdminRoutes(router, pool);
  registerHotelPropertyAdminRoutes(router, pool);

  router.get('/settings', async (_request, response, next) => {
    try {
      return response.json({ settings: await listSettings(pool) });
    } catch (error) {
      return next(error);
    }
  });

  router.put('/settings/:key', requireCsrf, async (request, response, next) => {
    const key = request.params.key;
    if (!Object.hasOwn(platformSettingDefinitions, key)) return fail(response, 404, 'SETTING_NOT_FOUND', 'This platform setting does not exist.');
    const parsed = settingSchema(key).safeParse(request.body?.value);
    if (!parsed.success) return fail(response, 400, 'VALIDATION_ERROR', settingErrorMessage(key));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await updateSetting(client, key, parsed.data, request.auth.user_id);
      await client.query('COMMIT');
      return response.json({ settings: await listSettings(client) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  router.get('/notification-outbox', async (request, response, next) => {
    const allowedStatuses = new Set(['pending', 'processing', 'retrying', 'delivered', 'blocked_config', 'dead_letter']);
    const status = typeof request.query.status === 'string' ? request.query.status : '';
    if (status && !allowedStatuses.has(status)) return fail(response, 400, 'VALIDATION_ERROR', 'Choose a supported outbox status.');
    try {
      const [summary, entries] = await Promise.all([
        pool.query('SELECT status, COUNT(*) AS count FROM notification_outbox GROUP BY status ORDER BY status'),
        pool.query(
          `SELECT item.id, item.notification_id, item.event_type, item.status, item.attempts,
                  item.manual_retries, item.available_at, item.delivered_at, item.last_error_code,
                  item.created_at, organization.name AS organization_name, notification.title
           FROM notification_outbox item
           JOIN organizations organization ON organization.id = item.organization_id
           JOIN notifications notification ON notification.id = item.notification_id
           WHERE ($1::text IS NULL OR item.status = $1)
           ORDER BY item.created_at DESC, item.id DESC LIMIT 100`,
          [status || null],
        ),
      ]);
      return response.json({
        summary: summary.rows.map((row) => ({ status: row.status, count: Number(row.count) })),
        entries: entries.rows.map((row) => ({ id: row.id, notificationId: row.notification_id, eventType: row.event_type, title: row.title, organizationName: row.organization_name, status: row.status, attempts: row.attempts, manualRetries: row.manual_retries, availableAt: row.available_at, deliveredAt: row.delivered_at, lastErrorCode: row.last_error_code, createdAt: row.created_at })),
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/notification-outbox/:outboxId/retry', requireCsrf, async (request, response, next) => {
    if (!/^[1-9]\d{0,17}$/.test(request.params.outboxId)) return fail(response, 400, 'VALIDATION_ERROR', 'Choose a valid outbox entry.');
    try {
      const result = await pool.query(
        `UPDATE notification_outbox SET status = 'pending', attempts = 0, manual_retries = manual_retries + 1,
           available_at = NOW(), locked_at = NULL, delivered_at = NULL, last_error_code = NULL, updated_at = NOW()
         WHERE id = $1 AND status IN ('blocked_config', 'dead_letter') RETURNING id`,
        [request.params.outboxId],
      );
      if (!result.rowCount) return fail(response, 409, 'OUTBOX_NOT_RETRYABLE', 'Only blocked or dead-lettered notifications can be queued for retry.');
      return response.status(202).json({ id: result.rows[0].id, status: 'pending' });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/seller-profiles/pending', async (_request, response, next) => {
    try {
      const result = await pool.query(
        `SELECT p.organization_id, p.coverage_destinations, p.property_city, p.verification_status,
                p.updated_at, o.name AS organization_name, o.business_type, o.country_code
         FROM seller_profiles p JOIN organizations o ON o.id = p.organization_id
         WHERE p.verification_status = 'pending'
         ORDER BY p.updated_at ASC`,
      );
      const sellers = [];
      for (const seller of result.rows) {
        const documents = await verificationDocumentStatus(pool, { organizationId: seller.organization_id, businessType: seller.business_type, countryCode: seller.country_code });
        sellers.push({
          organizationId: seller.organization_id,
          organizationName: seller.organization_name,
          businessType: seller.business_type,
          countryCode: seller.country_code,
          coverageDestinations: seller.coverage_destinations,
          propertyCity: seller.property_city,
          status: seller.verification_status,
          submittedAt: seller.updated_at,
          documents,
        });
      }
      return response.json({ sellers });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/seller-profiles/:organizationId/decision', requireCsrf, async (request, response, next) => {
    const input = parseWith(verificationDecisionSchema, request.body);
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    const { decision, reason } = input.data;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (decision === 'approved') {
        const seller = await client.query(
          `SELECT o.business_type, o.country_code FROM organizations o JOIN seller_profiles p ON p.organization_id = o.id
           WHERE o.id = $1 AND p.verification_status = 'pending' FOR UPDATE OF p`,
          [request.params.organizationId],
        );
        if (seller.rowCount) {
          const documents = await verificationDocumentStatus(client, { organizationId: request.params.organizationId, businessType: seller.rows[0].business_type, countryCode: seller.rows[0].country_code });
          if (!documents.complete) {
            await client.query('ROLLBACK');
            const missing = documents.requirements.filter((item) => documents.missing.includes(item.type)).map((item) => item.label);
            return fail(response, 409, 'DOCUMENTS_INCOMPLETE', `Approval needs every required document uploaded and scanned clean. Missing: ${missing.join('; ')}.`);
          }
        }
      }
      const updated = await client.query(
        `UPDATE seller_profiles SET verification_status = $2, verification_reason = $3, updated_at = NOW()
         WHERE organization_id = $1 AND verification_status = 'pending'
         RETURNING organization_id, verification_status, verification_reason`,
        [request.params.organizationId, decision, reason],
      );
      if (!updated.rowCount) {
        await client.query('ROLLBACK');
        return fail(response, 404, 'PENDING_SELLER_NOT_FOUND', 'Pending seller profile was not found.');
      }
      await client.query(
        `INSERT INTO seller_verification_reviews (id, seller_organization_id, admin_user_id, decision, reason)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), request.params.organizationId, request.auth.user_id, decision, reason],
      );
      if (decision === 'approved') {
        await client.query(
          `UPDATE hotel_properties SET verification_status = 'approved', reviewed_by = $2, reviewed_at = NOW(), updated_at = NOW()
           WHERE organization_id = $1 AND verification_status = 'pending'`,
          [request.params.organizationId, request.auth.user_id],
        );
        await retargetSeller(client, request.params.organizationId);
      }
      await client.query('COMMIT');
      return response.json({ organizationId: updated.rows[0].organization_id, status: updated.rows[0].verification_status, reason: updated.rows[0].verification_reason });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  return router;
}