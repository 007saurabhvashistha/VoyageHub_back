import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config/index.js';
import { capabilities, webhookDeliveryStatuses, webhookEventTypes, webhookTestEventType } from '../config/referenceData.js';
import { requireCapability } from '../services/permissions.js';
import { recordOrganizationEvent } from '../services/organizationAudit.js';
import { generateWebhookSecret, sealWebhookSecret, webhookUrlProblem } from '../services/webhooks.js';
import { createRateLimiter } from '../utils/rateLimit.js';
import { parseWith } from '../utils/validation.js';
import { loadSession, requireActiveAccount, requireCsrf, requireMfaForPlatformAdmin } from './auth.routes.js';

const deliveryStatusValues = webhookDeliveryStatuses.map((status) => status.value);
const uuidSchema = z.uuid();
const deliveryIdSchema = z.coerce.number().int().positive();

function fail(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

function eventTypesFor(businessType) {
  return webhookEventTypes.filter((type) => type.businessTypes.includes(businessType)).map((type) => type.value);
}

function endpointSchema(businessType, { partial, allowInsecureUrls }) {
  const allowed = eventTypesFor(businessType);
  const shape = {
    url: z.string().trim().max(2048, 'Webhook URL is too long.').superRefine((value, context) => {
      const problem = webhookUrlProblem(value, { allowInsecureUrls });
      if (problem) context.addIssue({ code: 'custom', message: problem });
    }),
    description: z.string().trim().max(200, 'Keep the description under 200 characters.').nullish().transform((value) => value || null),
    event_types: z.array(z.enum(allowed, { error: 'Choose event types from the list for your business type.' }))
      .min(1, 'Subscribe to at least one event type.').transform((values) => [...new Set(values)]),
  };
  if (!partial) return z.object(shape);
  return z.object({ ...shape, enabled: z.boolean() }).partial()
    .refine((value) => Object.keys(value).length > 0, 'Nothing to update.');
}

function endpointDto(row) {
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    eventTypes: row.event_types,
    status: row.status,
    disabledReason: row.disabled_reason,
    consecutiveFailures: row.consecutive_failures,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    secretRotatedAt: row.secret_rotated_at,
    previousSecretExpiresAt: row.previous_secret_expires_at && new Date(row.previous_secret_expires_at) > new Date() ? row.previous_secret_expires_at : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deliveryDto(row) {
  return {
    id: String(row.id),
    endpointId: row.endpoint_id,
    eventType: row.event_type,
    messageId: row.message_id,
    status: row.status,
    attempts: row.attempts,
    manualRetries: row.manual_retries,
    nextAttemptAt: ['pending', 'retrying'].includes(row.status) ? row.available_at : null,
    lastAttemptAt: row.last_attempt_at,
    deliveredAt: row.delivered_at,
    lastStatusCode: row.last_status_code,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
  };
}

export function createWebhookRouter({ pool, encryptionKey = null, allowInsecureUrls = config.webhooks.allowInsecureUrls }) {
  const router = Router();
  const manageLimiter = createRateLimiter(config.rateLimits.webhookManage, 'Too many webhook changes. Try again later.');
  router.use((request, response, next) => loadSession(pool, request, response, next));
  router.use(requireMfaForPlatformAdmin);
  router.use((request, response, next) => requireActiveAccount(pool, request, response, next));
  router.use(requireCapability(capabilities.integrationManage));
  router.use((request, response, next) => request.method === 'GET' ? next() : requireCsrf(request, response, next));

  const requireKey = (_request, response, next) => encryptionKey
    ? next()
    : fail(response, 503, 'WEBHOOKS_NOT_CONFIGURED', 'Webhooks are unavailable until the platform operator configures the webhook signing key.');

  async function inTransaction(work) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query(result?.error ? 'ROLLBACK' : 'COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function loadEndpoint(db, request, { lock = false } = {}) {
    if (!uuidSchema.safeParse(request.params.endpointId).success) return null;
    const result = await db.query(
      `SELECT * FROM webhook_endpoints WHERE id = $1 AND organization_id = $2${lock ? ' FOR UPDATE' : ''}`,
      [request.params.endpointId, request.auth.organization_id],
    );
    return result.rows[0] ?? null;
  }

  router.get('/endpoints', async (request, response, next) => {
    try {
      const result = await pool.query('SELECT * FROM webhook_endpoints WHERE organization_id = $1 ORDER BY created_at', [request.auth.organization_id]);
      return response.json({
        endpoints: result.rows.map(endpointDto),
        availableEventTypes: eventTypesFor(request.auth.business_type),
        signingConfigured: Boolean(encryptionKey),
        limits: { maxEndpoints: config.webhooks.maxEndpointsPerOrganization, maxAttempts: config.webhooks.maxAttempts, disableAfterFailures: config.webhooks.disableAfterFailures, secretRotationGraceHours: config.webhooks.secretRotationGraceMs / 3600000 },
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/endpoints', manageLimiter, requireKey, async (request, response, next) => {
    const input = parseWith(endpointSchema(request.auth.business_type, { partial: false, allowInsecureUrls }), request.body);
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    const secret = generateWebhookSecret();
    try {
      const outcome = await inTransaction(async (client) => {
        await client.query('SELECT id FROM organizations WHERE id = $1 FOR UPDATE', [request.auth.organization_id]);
        const count = await client.query('SELECT COUNT(*) AS total FROM webhook_endpoints WHERE organization_id = $1', [request.auth.organization_id]);
        if (Number(count.rows[0].total) >= config.webhooks.maxEndpointsPerOrganization) {
          return { error: [409, 'TOO_MANY_ENDPOINTS', `Delete an endpoint first. At most ${config.webhooks.maxEndpointsPerOrganization} are allowed.`] };
        }
        const created = await client.query(
          `INSERT INTO webhook_endpoints (id, organization_id, url, description, event_types, secret_ciphertext, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [randomUUID(), request.auth.organization_id, input.data.url, input.data.description, input.data.event_types, sealWebhookSecret(secret, encryptionKey), request.auth.user_id],
        );
        await recordOrganizationEvent(client, { organizationId: request.auth.organization_id, actorUserId: request.auth.user_id, action: 'webhook.created', details: { endpointId: created.rows[0].id, url: input.data.url, eventTypes: input.data.event_types } });
        return { endpoint: created.rows[0] };
      });
      if (outcome.error) return fail(response, ...outcome.error);
      // The secret is only ever returned here and on rotation.
      return response.status(201).json({ endpoint: endpointDto(outcome.endpoint), secret });
    } catch (error) {
      return next(error);
    }
  });

  router.patch('/endpoints/:endpointId', manageLimiter, async (request, response, next) => {
    const input = parseWith(endpointSchema(request.auth.business_type, { partial: true, allowInsecureUrls }), request.body);
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    try {
      const outcome = await inTransaction(async (client) => {
        const endpoint = await loadEndpoint(client, request, { lock: true });
        if (!endpoint) return { error: [404, 'ENDPOINT_NOT_FOUND', 'Webhook endpoint was not found.'] };
        const { url = endpoint.url, description = endpoint.description, event_types: eventTypes = endpoint.event_types, enabled } = input.data;
        let status = endpoint.status;
        let disabledReason = endpoint.disabled_reason;
        let failures = endpoint.consecutive_failures;
        if (enabled === true && endpoint.status === 'disabled') {
          status = 'active';
          disabledReason = null;
          failures = 0;
        } else if (enabled === false && endpoint.status === 'active') {
          status = 'disabled';
          disabledReason = 'manual';
        }
        const updated = await client.query(
          `UPDATE webhook_endpoints SET url = $2, description = $3, event_types = $4, status = $5, disabled_reason = $6,
             consecutive_failures = $7, updated_at = NOW() WHERE id = $1 RETURNING *`,
          [endpoint.id, url, description, eventTypes, status, disabledReason, failures],
        );
        if (status === 'disabled' && endpoint.status === 'active') {
          await client.query(
            `UPDATE webhook_deliveries SET status = 'cancelled', locked_at = NULL, last_error_code = 'endpoint_disabled', updated_at = NOW()
             WHERE endpoint_id = $1 AND status IN ('pending', 'retrying')`,
            [endpoint.id],
          );
        }
        await recordOrganizationEvent(client, { organizationId: request.auth.organization_id, actorUserId: request.auth.user_id, action: 'webhook.updated', details: { endpointId: endpoint.id, changes: Object.keys(input.data), status } });
        return { endpoint: updated.rows[0] };
      });
      if (outcome.error) return fail(response, ...outcome.error);
      return response.json({ endpoint: endpointDto(outcome.endpoint) });
    } catch (error) {
      return next(error);
    }
  });

  router.delete('/endpoints/:endpointId', async (request, response, next) => {
    try {
      const outcome = await inTransaction(async (client) => {
        const endpoint = await loadEndpoint(client, request, { lock: true });
        if (!endpoint) return { error: [404, 'ENDPOINT_NOT_FOUND', 'Webhook endpoint was not found.'] };
        await client.query('DELETE FROM webhook_endpoints WHERE id = $1', [endpoint.id]);
        await recordOrganizationEvent(client, { organizationId: request.auth.organization_id, actorUserId: request.auth.user_id, action: 'webhook.deleted', details: { endpointId: endpoint.id, url: endpoint.url } });
        return {};
      });
      if (outcome.error) return fail(response, ...outcome.error);
      return response.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  router.post('/endpoints/:endpointId/rotate-secret', manageLimiter, requireKey, async (request, response, next) => {
    const secret = generateWebhookSecret();
    try {
      const outcome = await inTransaction(async (client) => {
        const endpoint = await loadEndpoint(client, request, { lock: true });
        if (!endpoint) return { error: [404, 'ENDPOINT_NOT_FOUND', 'Webhook endpoint was not found.'] };
        const updated = await client.query(
          `UPDATE webhook_endpoints SET previous_secret_ciphertext = secret_ciphertext,
             previous_secret_expires_at = NOW() + make_interval(secs => $3::double precision),
             secret_ciphertext = $2, secret_rotated_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`,
          [endpoint.id, sealWebhookSecret(secret, encryptionKey), config.webhooks.secretRotationGraceMs / 1000],
        );
        await recordOrganizationEvent(client, { organizationId: request.auth.organization_id, actorUserId: request.auth.user_id, action: 'webhook.secret_rotated', details: { endpointId: endpoint.id } });
        return { endpoint: updated.rows[0] };
      });
      if (outcome.error) return fail(response, ...outcome.error);
      return response.json({ endpoint: endpointDto(outcome.endpoint), secret });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/endpoints/:endpointId/test', manageLimiter, requireKey, async (request, response, next) => {
    try {
      const endpoint = await loadEndpoint(pool, request);
      if (!endpoint) return fail(response, 404, 'ENDPOINT_NOT_FOUND', 'Webhook endpoint was not found.');
      if (endpoint.status !== 'active') return fail(response, 409, 'ENDPOINT_DISABLED', 'Enable the endpoint before sending a test event.');
      const messageId = `msg_${randomUUID().replaceAll('-', '')}`;
      const payload = {
        type: webhookTestEventType,
        timestamp: new Date().toISOString(),
        data: { organizationId: request.auth.organization_id, endpointId: endpoint.id, title: 'Test event', message: 'This is a test event from VoyageHub. Verify the signature, then return any 2xx status.' },
      };
      const created = await pool.query(
        `INSERT INTO webhook_deliveries (endpoint_id, organization_id, event_type, message_id, payload)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [endpoint.id, request.auth.organization_id, webhookTestEventType, messageId, JSON.stringify(payload)],
      );
      return response.status(202).json({ delivery: deliveryDto(created.rows[0]) });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/endpoints/:endpointId/deliveries', async (request, response, next) => {
    const status = typeof request.query.status === 'string' && request.query.status ? request.query.status : null;
    if (status && !deliveryStatusValues.includes(status)) return fail(response, 400, 'VALIDATION_ERROR', 'Choose a supported delivery status.');
    try {
      const endpoint = await loadEndpoint(pool, request);
      if (!endpoint) return fail(response, 404, 'ENDPOINT_NOT_FOUND', 'Webhook endpoint was not found.');
      const result = await pool.query(
        `SELECT * FROM webhook_deliveries WHERE endpoint_id = $1 AND ($2::text IS NULL OR status = $2)
         ORDER BY created_at DESC, id DESC LIMIT 100`,
        [endpoint.id, status],
      );
      return response.json({ deliveries: result.rows.map(deliveryDto) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/deliveries/:deliveryId/retry', manageLimiter, async (request, response, next) => {
    const deliveryId = deliveryIdSchema.safeParse(request.params.deliveryId);
    if (!deliveryId.success) return fail(response, 400, 'VALIDATION_ERROR', 'Choose a valid delivery.');
    try {
      const outcome = await inTransaction(async (client) => {
        const delivery = await client.query(
          `SELECT delivery.id, endpoint.status AS endpoint_status FROM webhook_deliveries delivery
           JOIN webhook_endpoints endpoint ON endpoint.id = delivery.endpoint_id
           WHERE delivery.id = $1 AND delivery.organization_id = $2 FOR UPDATE OF delivery`,
          [deliveryId.data, request.auth.organization_id],
        );
        if (!delivery.rowCount) return { error: [404, 'DELIVERY_NOT_FOUND', 'Webhook delivery was not found.'] };
        if (delivery.rows[0].endpoint_status !== 'active') return { error: [409, 'ENDPOINT_DISABLED', 'Enable the endpoint before retrying deliveries.'] };
        const requeued = await client.query(
          `UPDATE webhook_deliveries SET status = 'pending', attempts = 0, manual_retries = manual_retries + 1, available_at = NOW(),
             locked_at = NULL, updated_at = NOW()
           WHERE id = $1 AND status IN ('dead_letter', 'cancelled') RETURNING *`,
          [deliveryId.data],
        );
        if (!requeued.rowCount) return { error: [409, 'DELIVERY_NOT_RETRYABLE', 'Only failed or cancelled deliveries can be retried.'] };
        return { delivery: requeued.rows[0] };
      });
      if (outcome.error) return fail(response, ...outcome.error);
      return response.json({ delivery: deliveryDto(outcome.delivery) });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
