import { randomUUID } from 'node:crypto';
import { config } from '../config/index.js';
import { organizationIsActive } from '../services/organizationLifecycle.js';
import { recordOrganizationEvent } from '../services/organizationAudit.js';
import { openWebhookSecret, postWebhook, signWebhook, WebhookDeliveryError } from '../services/webhooks.js';

function safeErrorCode(error) {
  return typeof error?.code === 'string' && /^[a-z0-9_-]{1,80}$/i.test(error.code) ? error.code : 'delivery_failed';
}

async function disableFailingEndpoint(pool, endpointId, current) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const disabled = await client.query(
      `UPDATE webhook_endpoints SET status = 'disabled', disabled_reason = 'failing', updated_at = $2
       WHERE id = $1 AND status = 'active' RETURNING organization_id, url, consecutive_failures`,
      [endpointId, current],
    );
    if (disabled.rowCount) {
      const endpoint = disabled.rows[0];
      await client.query(
        `UPDATE webhook_deliveries SET status = 'cancelled', locked_at = NULL, last_error_code = 'endpoint_disabled', updated_at = $2
         WHERE endpoint_id = $1 AND status IN ('pending', 'retrying')`,
        [endpointId, current],
      );
      await client.query(
        'INSERT INTO notifications (id, organization_id, event_type, title, message, data) VALUES ($1, $2, $3, $4, $5, $6)',
        [randomUUID(), endpoint.organization_id, 'webhook_endpoint_disabled', 'Webhook endpoint disabled',
          `${endpoint.url} failed ${endpoint.consecutive_failures} times in a row. Fix the receiver, then re-enable it in Integrations.`,
          JSON.stringify({ endpointId })],
      );
      await recordOrganizationEvent(client, { organizationId: endpoint.organization_id, actorUserId: null, action: 'webhook.disabled', details: { endpointId, reason: 'failing', consecutiveFailures: endpoint.consecutive_failures } });
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function processWebhookDeliveries(pool, {
  encryptionKey = null,
  allowPrivateNetwork = config.webhooks.allowInsecureUrls,
  send = postWebhook,
  settings = config.webhooks,
  batchSize = 20,
  now = () => new Date(),
  random = Math.random,
} = {}) {
  const result = { claimed: 0, delivered: 0, retrying: 0, deadLetter: 0, disabledEndpoints: 0, blockedConfig: !encryptionKey };
  // Without the key nothing can be signed; deliveries wait instead of going out unsigned.
  if (!encryptionKey) return result;
  const claimedAt = now();
  await pool.query(
    `UPDATE webhook_deliveries delivery SET status = 'cancelled', locked_at = NULL, last_error_code = 'organization_inactive', updated_at = $1
     FROM organizations organization
     WHERE organization.id = delivery.organization_id AND delivery.status IN ('pending', 'retrying')
       AND NOT (${organizationIsActive('organization')})`,
    [claimedAt],
  );

  const client = await pool.connect();
  let claimed;
  try {
    await client.query('BEGIN');
    const selected = await client.query(
      `SELECT delivery.id, delivery.endpoint_id, delivery.message_id, delivery.payload, delivery.attempts
       FROM webhook_deliveries delivery
       JOIN webhook_endpoints endpoint ON endpoint.id = delivery.endpoint_id
       WHERE endpoint.status = 'active'
         AND ((delivery.status IN ('pending', 'retrying') AND delivery.available_at <= $1)
           OR (delivery.status = 'processing' AND delivery.locked_at < $1 - INTERVAL '5 minutes'))
       ORDER BY delivery.available_at, delivery.id
       LIMIT $2 FOR UPDATE OF delivery SKIP LOCKED`,
      [claimedAt, batchSize],
    );
    claimed = selected.rows;
    if (claimed.length) {
      await client.query(
        `UPDATE webhook_deliveries SET status = 'processing', locked_at = $2, updated_at = $2 WHERE id = ANY($1::bigint[])`,
        [claimed.map((row) => row.id), claimedAt],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  result.claimed = claimed.length;

  for (const item of claimed) {
    const attemptAt = now();
    const attempts = Number(item.attempts) + 1;
    let statusCode = null;
    try {
      const endpoint = (await pool.query(
        'SELECT url, secret_ciphertext, previous_secret_ciphertext, previous_secret_expires_at FROM webhook_endpoints WHERE id = $1',
        [item.endpoint_id],
      )).rows[0];
      let secrets;
      try {
        secrets = [openWebhookSecret(endpoint.secret_ciphertext, encryptionKey)];
      } catch {
        throw new WebhookDeliveryError('secret_unreadable', { retryable: false });
      }
      // After a key change the previous secret may be unreadable; the current one alone still signs.
      if (endpoint.previous_secret_ciphertext && new Date(endpoint.previous_secret_expires_at) > attemptAt) {
        try {
          secrets.push(openWebhookSecret(endpoint.previous_secret_ciphertext, encryptionKey));
        } catch { /* skip */ }
      }
      const body = JSON.stringify(item.payload);
      const headers = signWebhook({ messageId: item.message_id, timestamp: attemptAt, body, secrets });
      const response = await send({ url: endpoint.url, body, headers, timeoutMs: settings.timeoutMs, allowPrivateNetwork });
      statusCode = response.statusCode;
      if (statusCode < 200 || statusCode >= 300) throw new WebhookDeliveryError(`http_${statusCode}`, { statusCode });

      await pool.query(
        `UPDATE webhook_deliveries SET status = 'delivered', attempts = $2, locked_at = NULL, delivered_at = $3, last_attempt_at = $3,
           last_status_code = $4, last_error_code = NULL, updated_at = $3 WHERE id = $1`,
        [item.id, attempts, attemptAt, statusCode],
      );
      await pool.query(
        'UPDATE webhook_endpoints SET consecutive_failures = 0, last_success_at = $2 WHERE id = $1',
        [item.endpoint_id, attemptAt],
      );
      result.delivered += 1;
    } catch (error) {
      const code = safeErrorCode(error);
      const deadLetter = error?.retryable === false || attempts >= settings.maxAttempts;
      const backoff = Math.min(settings.retryMaxMs, settings.retryBaseMs * (2 ** Math.max(0, attempts - 1)));
      const availableAt = new Date(attemptAt.getTime() + Math.floor(backoff * (0.5 + random())));
      await pool.query(
        `UPDATE webhook_deliveries SET status = $2, attempts = $3, available_at = $4, locked_at = NULL, last_attempt_at = $5,
           last_status_code = $6, last_error_code = $7, updated_at = $5 WHERE id = $1`,
        [item.id, deadLetter ? 'dead_letter' : 'retrying', attempts, availableAt, attemptAt, statusCode, code],
      );
      result[deadLetter ? 'deadLetter' : 'retrying'] += 1;
      // A secret we cannot decrypt is our configuration problem, not the receiver's.
      if (code === 'secret_unreadable') continue;
      const failures = await pool.query(
        `UPDATE webhook_endpoints SET consecutive_failures = consecutive_failures + 1, last_failure_at = $2
         WHERE id = $1 AND status = 'active' RETURNING consecutive_failures`,
        [item.endpoint_id, attemptAt],
      );
      if (failures.rowCount && failures.rows[0].consecutive_failures >= settings.disableAfterFailures) {
        await disableFailingEndpoint(pool, item.endpoint_id, attemptAt);
        result.disabledEndpoints += 1;
      }
    }
  }
  return result;
}

export async function processWebhookDeliveryRetention(pool, { now = () => new Date(), retentionDays = config.webhooks.deliveryRetentionDays } = {}) {
  const cutoff = new Date(now().getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const deleted = await pool.query(
    "DELETE FROM webhook_deliveries WHERE status IN ('delivered', 'dead_letter', 'cancelled') AND updated_at < $1",
    [cutoff],
  );
  return { deleted: deleted.rowCount };
}

export function startWebhookDeliveryWorker(pool, {
  encryptionKey = null,
  intervalMs = config.webhooks.intervalMs,
  logger = console,
} = {}) {
  let active = false;
  let stopped = false;
  const run = async () => {
    if (active || stopped) return;
    active = true;
    try {
      await processWebhookDeliveries(pool, { encryptionKey });
    } catch {
      logger.error('Webhook delivery processing failed.');
    } finally {
      active = false;
    }
  };
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  void run();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
