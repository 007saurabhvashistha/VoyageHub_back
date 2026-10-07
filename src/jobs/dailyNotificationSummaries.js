import { randomUUID } from 'node:crypto';

export async function processDailyNotificationSummaries(pool, { now = new Date() } = {}) {
  const summaryDate = now.toISOString().slice(0, 10);
  const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const organizations = await pool.query(
    `SELECT DISTINCT membership.organization_id
     FROM organization_memberships membership
     JOIN user_notification_preferences preference ON preference.user_id = membership.user_id
     WHERE preference.email_enabled = TRUE AND preference.email_frequency = 'daily'
       AND EXISTS (
         SELECT 1 FROM notifications item
         WHERE item.organization_id = membership.organization_id AND item.created_at > $1
           AND item.created_at <= $2 AND item.event_type NOT IN ('daily_summary', 'email_verification', 'password_recovery')
       )`,
    [windowStart, now],
  );
  const result = { organizations: organizations.rowCount, created: 0 };
  for (const { organization_id: organizationId } of organizations.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const claimed = await client.query(
        `INSERT INTO notification_daily_summaries (organization_id, summary_date)
         VALUES ($1, $2::date) ON CONFLICT DO NOTHING RETURNING organization_id`,
        [organizationId, summaryDate],
      );
      if (!claimed.rowCount) {
        await client.query('ROLLBACK');
        continue;
      }
      const items = await client.query(
        `SELECT event_type, title, created_at FROM notifications
         WHERE organization_id = $1 AND created_at > $2 AND created_at <= $3
           AND event_type NOT IN ('daily_summary', 'email_verification', 'password_recovery')
         ORDER BY created_at DESC LIMIT 50`,
        [organizationId, windowStart, now],
      );
      if (!items.rowCount) {
        await client.query('ROLLBACK');
        continue;
      }
      const lines = items.rows.slice(0, 10).map((item) => `${item.title} (${item.event_type.replaceAll('_', ' ')})`);
      const notificationId = randomUUID();
      await client.query(
        `INSERT INTO notifications (id, organization_id, event_type, title, message, data)
         VALUES ($1, $2, 'daily_summary', $3, $4, $5)`,
        [notificationId, organizationId, 'Your daily VoyageHub summary', `${items.rowCount} new update${items.rowCount === 1 ? '' : 's'} in the last 24 hours:\n${lines.join('\n')}`.slice(0, 500), JSON.stringify({ itemCount: items.rowCount, summaryDate })],
      );
      await client.query(
        'UPDATE notification_daily_summaries SET notification_id = $3 WHERE organization_id = $1 AND summary_date = $2::date',
        [organizationId, summaryDate, notificationId],
      );
      await client.query('COMMIT');
      result.created += 1;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  return result;
}

export function startDailyNotificationSummaryWorker(pool, { intervalMs, logger = console } = {}) {
  let active = false;
  let stopped = false;
  const run = async () => {
    if (active || stopped) return;
    active = true;
    try {
      await processDailyNotificationSummaries(pool);
    } catch {
      logger.error('Daily notification summary processing failed.');
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
