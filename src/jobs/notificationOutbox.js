function safeErrorCode(error) {
  return typeof error?.code === 'string' && /^[a-z0-9_-]{1,80}$/i.test(error.code)
    ? error.code
    : 'delivery_failed';
}

export async function processNotificationOutbox(pool, {
  deliver = null,
  batchSize = 20,
  maxAttempts = 8,
  baseDelayMs = 30000,
  maxDelayMs = 6 * 60 * 60 * 1000,
  now = () => new Date(),
  random = Math.random,
} = {}) {
  const client = await pool.connect();
  let claimed;
  const claimedAt = now();
  try {
    await client.query('BEGIN');
    const selected = await client.query(
      `SELECT id, notification_id, organization_id, recipient_user_id, attempts, allow_unverified
       FROM notification_outbox
       WHERE ((status IN ('pending', 'retrying') AND available_at <= $1)
         OR (status = 'processing' AND locked_at < $1 - INTERVAL '5 minutes')
         OR ($3 AND status = 'blocked_config' AND last_error_code = 'provider_not_configured') )
       ORDER BY available_at, id
       LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [claimedAt, batchSize, Boolean(deliver)],
    );
    claimed = selected.rows;
    if (claimed.length) {
      await client.query(
        `UPDATE notification_outbox SET status = 'processing', locked_at = $2, updated_at = $2
         WHERE id = ANY($1::bigint[])`,
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

  const result = { claimed: claimed.length, delivered: 0, retrying: 0, deadLetter: 0, blockedConfig: 0 };
  for (const item of claimed) {
    if (!deliver) {
      await pool.query(
        `UPDATE notification_outbox SET status = 'blocked_config', locked_at = NULL,
           last_error_code = 'provider_not_configured', updated_at = $2 WHERE id = $1`,
        [item.id, now()],
      );
      result.blockedConfig += 1;
      continue;
    }

    try {
      const destination = await pool.query(
        `SELECT recipient.email, recipient.email_verified_at, notification.title, notification.message, notification.data
         FROM users recipient CROSS JOIN notifications notification
         WHERE recipient.id = $1 AND notification.id = $2`,
        [item.recipient_user_id, item.notification_id],
      );
      if (!destination.rowCount) {
        const attempts = Number(item.attempts) + 1;
        await pool.query(
          `UPDATE notification_outbox SET status = 'dead_letter', attempts = $2, locked_at = NULL,
             last_error_code = 'recipient_unavailable', updated_at = $3 WHERE id = $1`,
          [item.id, attempts, now()],
        );
        result.deadLetter += 1;
        continue;
      }
      const notification = destination.rows[0];
      if (!notification.email_verified_at && !item.allow_unverified) {
        await pool.query(
          `UPDATE notification_outbox SET status = 'blocked_config', locked_at = NULL,
             last_error_code = 'recipient_email_unverified', updated_at = $2 WHERE id = $1`,
          [item.id, now()],
        );
        result.blockedConfig += 1;
        continue;
      }
      await deliver({
        idempotencyKey: `notification-outbox-${item.id}`,
        recipientEmail: notification.email,
        notification: { title: notification.title, message: notification.message, data: notification.data },
      });
      await pool.query(
        `UPDATE notification_outbox SET status = 'delivered', attempts = attempts + 1,
           locked_at = NULL, delivered_at = $2, last_error_code = NULL, updated_at = $2 WHERE id = $1`,
        [item.id, now()],
      );
      result.delivered += 1;
    } catch (error) {
      const attempts = Number(item.attempts) + 1;
      const deadLetter = error?.retryable === false || attempts >= maxAttempts;
      const backoff = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, attempts - 1)));
      const availableAt = new Date(now().getTime() + Math.floor(backoff * (0.5 + random())));
      await pool.query(
        `UPDATE notification_outbox SET status = $2, attempts = $3, available_at = $4,
           locked_at = NULL, last_error_code = $5, updated_at = $6 WHERE id = $1`,
        [item.id, deadLetter ? 'dead_letter' : 'retrying', attempts, availableAt, safeErrorCode(error), now()],
      );
      result[deadLetter ? 'deadLetter' : 'retrying'] += 1;
    }
  }
  return result;
}

export function startNotificationOutboxWorker(pool, {
  deliver = null,
  intervalMs = 5000,
  logger = console,
} = {}) {
  let active = false;
  let stopped = false;
  const run = async () => {
    if (active || stopped) return;
    active = true;
    try {
      await processNotificationOutbox(pool, { deliver });
    } catch {
      logger.error('Notification outbox processing failed.');
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