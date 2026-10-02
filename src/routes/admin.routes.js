import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { loadSession, requireCsrf, requireMfaForPlatformAdmin } from './auth.routes.js';
import { getMaxOffersPerRequest, maxOffersPerRequestBounds } from '../services/platformSettings.js';

function fail(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

export function createAdminRouter({ pool }) {
  const router = Router();
  router.use((request, response, next) => loadSession(pool, request, response, next));
  router.use((request, response, next) => request.auth.is_platform_admin
    ? next()
    : fail(response, 403, 'ADMIN_REQUIRED', 'Platform administrator access is required.'));
  router.use(requireMfaForPlatformAdmin);

  router.get('/settings', async (_request, response, next) => {
    try {
      const maxOffersPerRequest = await getMaxOffersPerRequest(pool);
      const changed = await pool.query("SELECT updated_at FROM platform_settings WHERE setting_key = 'max_offers_per_request'");
      return response.json({ settings: { maxOffersPerRequest, maxOffersPerRequestBounds, updatedAt: changed.rows[0]?.updated_at ?? null } });
    } catch (error) {
      return next(error);
    }
  });

  router.put('/settings/max-offers-per-request', requireCsrf, async (request, response, next) => {
    const value = Number(request.body?.value);
    if (!Number.isInteger(value) || value < maxOffersPerRequestBounds.min || value > maxOffersPerRequestBounds.max) {
      return fail(response, 400, 'VALIDATION_ERROR', `Offer limit must be a whole number from ${maxOffersPerRequestBounds.min} to ${maxOffersPerRequestBounds.max}.`);
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const previous = await client.query("SELECT setting_value FROM platform_settings WHERE setting_key = 'max_offers_per_request' FOR UPDATE");
      await client.query(
        `INSERT INTO platform_settings (setting_key, setting_value, updated_by, updated_at)
         VALUES ('max_offers_per_request', $1::jsonb, $2, NOW())
         ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [JSON.stringify(value), request.auth.user_id],
      );
      await client.query(
        `INSERT INTO platform_setting_changes (id, setting_key, old_value, new_value, changed_by)
         VALUES ($1, 'max_offers_per_request', $2::jsonb, $3::jsonb, $4)`,
        [randomUUID(), previous.rowCount ? JSON.stringify(previous.rows[0].setting_value) : null, JSON.stringify(value), request.auth.user_id],
      );
      await client.query('COMMIT');
      return response.json({ settings: { maxOffersPerRequest: value } });
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
      return response.json({ sellers: result.rows.map((seller) => ({
        organizationId: seller.organization_id,
        organizationName: seller.organization_name,
        businessType: seller.business_type,
        countryCode: seller.country_code,
        coverageDestinations: seller.coverage_destinations,
        propertyCity: seller.property_city,
        status: seller.verification_status,
        submittedAt: seller.updated_at,
      })) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/seller-profiles/:organizationId/decision', requireCsrf, async (request, response, next) => {
    const decision = request.body?.decision;
    const reason = typeof request.body?.reason === 'string' ? request.body.reason.trim() : '';
    if (!['approved', 'rejected'].includes(decision)) return fail(response, 400, 'VALIDATION_ERROR', 'Decision must be approved or rejected.');
    if (reason.length < 5 || reason.length > 500) return fail(response, 400, 'VALIDATION_ERROR', 'Provide a review reason between 5 and 500 characters.');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
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
        const retargeted = await client.query(
          `INSERT INTO request_targets (request_id, seller_organization_id)
           SELECT r.id, p.organization_id
           FROM marketplace_requests r
           JOIN seller_profiles p ON p.organization_id = $1
           JOIN organizations seller ON seller.id = p.organization_id
           WHERE r.status = 'open' AND r.response_deadline > NOW()
             AND (seller.business_type = 'dmc' OR (seller.business_type = 'hotelier' AND 'hotel' = ANY(r.services)))
             AND (
               (r.visibility IN ('open', 'open_and_invite') AND (
                 (seller.business_type = 'dmc' AND (
                   lower(r.destination) = ANY(SELECT lower(destination) FROM unnest(p.coverage_destinations) AS destination)
                   OR lower(r.destination_country) = ANY(SELECT lower(destination) FROM unnest(p.coverage_destinations) AS destination)
                 ))
                 OR (seller.business_type = 'hotelier' AND lower(p.property_city) = lower(r.destination))
               ))
               OR (r.visibility IN ('invite_only', 'open_and_invite') AND EXISTS (
                 SELECT 1 FROM request_invitations invitation
                 WHERE invitation.request_id = r.id AND invitation.seller_organization_id = p.organization_id
               ))
             )
           ON CONFLICT (request_id, seller_organization_id) DO UPDATE
             SET declined_at = NULL, decline_reason = NULL, matched_at = NOW()
             WHERE request_targets.declined_at IS NOT NULL
           RETURNING seller_organization_id, request_id`,
          [request.params.organizationId],
        );
        for (const target of retargeted.rows) {
          const matchedRequest = await client.query('SELECT id, request_code, destination, nights FROM marketplace_requests WHERE id = $1', [target.request_id]);
          const item = matchedRequest.rows[0];
          await client.query(
            'INSERT INTO notifications (id, organization_id, event_type, title, message, data) VALUES ($1, $2, $3, $4, $5, $6)',
            [randomUUID(), target.seller_organization_id, 'request_matched', 'New matching request', `${item.request_code} / ${item.destination} / ${item.nights} nights`, JSON.stringify({ requestId: item.id, requestCode: item.request_code, destination: item.destination })],
          );
        }
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