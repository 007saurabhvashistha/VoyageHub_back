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
import { registerDisputeAdminRoutes } from './trust.routes.js';
import { getMarketplaceDashboard, parseAnalyticsRange } from '../services/marketplaceAnalytics.js';
import { config } from '../config/index.js';
import { z } from 'zod';

function fail(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

const adminAuditSources = ['organization', 'seller_profile', 'seller_verification', 'agency_verification', 'platform_setting', 'request_trip', 'request_deadline'];
const auditSearchSchema = z.object({
  q: z.string().trim().max(120).default(''),
  organizationId: z.uuid().optional(),
  source: z.enum(adminAuditSources).optional(),
  action: z.string().trim().max(64).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(config.adminAudit.maxPageSize).default(config.adminAudit.maxPageSize),
});

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
  registerDisputeAdminRoutes(router, pool);

  router.get('/analytics/marketplace', async (request, response, next) => {
    const range = parseAnalyticsRange(request.query);
    if (range.error) return fail(response, 400, 'VALIDATION_ERROR', range.error);
    try {
      return response.json({ range: { from: range.from, to: range.to }, metrics: await getMarketplaceDashboard(pool, range) });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/audit-events', async (request, response, next) => {
    const parsed = auditSearchSchema.safeParse(request.query);
    if (!parsed.success) return fail(response, 400, 'VALIDATION_ERROR', 'Use a search under 120 characters, valid filters, and a page size within the configured limit.');
    const input = parsed.data;
    if (input.from && input.to && input.from > input.to) return fail(response, 400, 'VALIDATION_ERROR', 'The start date must be on or before the end date.');
    const offset = (input.page - 1) * input.limit;
    if (!Number.isSafeInteger(offset) || offset > config.adminAudit.maxOffset) return fail(response, 400, 'VALIDATION_ERROR', 'The requested audit page is outside the configured range.');
    const query = `WITH audit_rows AS (
      SELECT event.id::text AS id, 'organization'::text AS source, event.organization_id,
             organization.name AS organization_name, event.actor_user_id, actor.full_name AS actor_name,
             event.action, event.target_user_id, target.full_name AS target_name, event.details, event.created_at
      FROM organization_audit_events event
      JOIN organizations organization ON organization.id = event.organization_id
      LEFT JOIN users actor ON actor.id = event.actor_user_id
      LEFT JOIN users target ON target.id = event.target_user_id
      UNION ALL
      SELECT change.id::text, 'seller_profile', change.seller_organization_id, organization.name,
             change.changed_by_user_id, actor.full_name, 'seller_profile.updated', NULL::uuid, NULL::text,
             jsonb_build_object('previous', change.previous_profile, 'updated', change.updated_profile), change.created_at
      FROM seller_profile_changes change JOIN organizations organization ON organization.id = change.seller_organization_id
      LEFT JOIN users actor ON actor.id = change.changed_by_user_id
      UNION ALL
      SELECT review.id::text, 'seller_verification', review.seller_organization_id, organization.name,
             review.admin_user_id, actor.full_name, 'seller_verification.' || review.decision, NULL::uuid, NULL::text,
             jsonb_build_object('decision', review.decision, 'reason', review.reason), review.created_at
      FROM seller_verification_reviews review JOIN organizations organization ON organization.id = review.seller_organization_id
      LEFT JOIN users actor ON actor.id = review.admin_user_id
      UNION ALL
      SELECT review.id::text, 'agency_verification', review.agency_organization_id, organization.name,
             review.admin_user_id, actor.full_name, 'agency_verification.' || review.decision, NULL::uuid, NULL::text,
             jsonb_build_object('decision', review.decision, 'reason', review.reason), review.created_at
      FROM agency_verification_reviews review JOIN organizations organization ON organization.id = review.agency_organization_id
      LEFT JOIN users actor ON actor.id = review.admin_user_id
      UNION ALL
      SELECT change.id::text, 'platform_setting', NULL::uuid, 'Platform', change.changed_by,
             actor.full_name, 'platform_setting.updated', NULL::uuid, NULL::text,
             jsonb_build_object('settingKey', change.setting_key, 'oldValue', change.old_value, 'newValue', change.new_value), change.changed_at
      FROM platform_setting_changes change LEFT JOIN users actor ON actor.id = change.changed_by
      UNION ALL
      SELECT change.id::text, 'request_trip', request.agency_organization_id, organization.name,
             change.changed_by_user_id, actor.full_name, 'request.trip_changed', NULL::uuid, NULL::text,
             jsonb_build_object('requestId', change.request_id, 'tripVersion', change.trip_version,
               'previous', change.previous_trip, 'current', change.current_trip, 'note', change.note), change.created_at
      FROM request_trip_changes change JOIN marketplace_requests request ON request.id = change.request_id
      JOIN organizations organization ON organization.id = request.agency_organization_id
      LEFT JOIN users actor ON actor.id = change.changed_by_user_id
      UNION ALL
      SELECT change.id::text, 'request_deadline', request.agency_organization_id, organization.name,
             change.changed_by_user_id, actor.full_name, 'request.deadline_changed', NULL::uuid, NULL::text,
             jsonb_build_object('requestId', change.request_id, 'previousDeadline', change.previous_deadline,
               'currentDeadline', change.current_deadline, 'note', change.note), change.created_at
      FROM request_deadline_changes change JOIN marketplace_requests request ON request.id = change.request_id
      JOIN organizations organization ON organization.id = request.agency_organization_id
      LEFT JOIN users actor ON actor.id = change.changed_by_user_id
    )
    SELECT * FROM audit_rows
    WHERE ($1::text IS NULL OR CONCAT_WS(' ', source, action, organization_name, actor_name, target_name, details::text) ILIKE $1)
      AND ($2::uuid IS NULL OR organization_id = $2)
      AND ($3::text IS NULL OR source = $3)
      AND ($4::text IS NULL OR action ILIKE $4)
      AND ($5::date IS NULL OR created_at >= $5::date)
      AND ($6::date IS NULL OR created_at < $6::date + INTERVAL '1 day')`;
    const queryValues = [input.q ? `%${input.q}%` : null, input.organizationId ?? null, input.source ?? null, input.action || null, input.from ?? null, input.to ?? null];
    try {
      const count = await pool.query(`SELECT COUNT(*) AS total FROM (${query}) filtered_audit`, queryValues);
      const result = await pool.query(`${query} ORDER BY created_at DESC, id DESC LIMIT $7 OFFSET $8`, [...queryValues, input.limit, offset]);
      return response.json({
        events: result.rows.map((row) => ({
          id: row.id,
          source: row.source,
          organizationId: row.organization_id,
          organizationName: row.organization_name,
          actorName: row.actor_name,
          action: row.action,
          targetName: row.target_name,
          details: row.details,
          createdAt: row.created_at,
        })),
        pagination: { page: input.page, limit: input.limit, total: Number(count.rows[0].total), hasMore: offset + result.rowCount < Number(count.rows[0].total) },
      });
    } catch (error) {
      return next(error);
    }
  });

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
    const allowedStatuses = new Set(['pending', 'processing', 'retrying', 'delivered', 'blocked_config', 'dead_letter', 'suppressed']);
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