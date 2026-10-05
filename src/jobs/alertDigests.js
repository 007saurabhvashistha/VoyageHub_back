import { getSetting } from '../services/platformSettings.js';
import { loadRequestStops, notify, routeLabel } from '../services/routing.js';

// Most recent daily send time at or before `now`.
export function latestDigestBoundary(now, hourUtc) {
  const boundary = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc));
  if (boundary > now) boundary.setUTCDate(boundary.getUTCDate() - 1);
  return boundary;
}

// One notification per seller listing leads queued for the digest before the last send time.
export async function processAlertDigests(pool, { now = new Date() } = {}) {
  const boundary = latestDigestBoundary(now, await getSetting(pool, 'digest_send_hour_utc'));
  const due = await pool.query(
    'SELECT DISTINCT organization_id FROM alert_digest_items WHERE sent_at IS NULL AND queued_at <= $1',
    [boundary],
  );
  let sent = 0;
  for (const { organization_id: organizationId } of due.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const items = await client.query(
        `UPDATE alert_digest_items item SET sent_at = $3
         FROM marketplace_requests r
         WHERE item.organization_id = $1 AND item.sent_at IS NULL AND item.queued_at <= $2 AND r.id = item.request_id
         RETURNING r.id, r.request_code, r.destination, r.nights, r.status, r.response_deadline`,
        [organizationId, boundary, now],
      );
      const open = items.rows.filter((row) => row.status === 'open' && new Date(row.response_deadline) > now);
      if (open.length) {
        const lines = [];
        for (const row of open.slice(0, 20)) lines.push(`${row.request_code} / ${routeLabel(await loadRequestStops(client, row.id)) || row.destination} / ${row.nights} nights`);
        await notify(client, organizationId, 'request_matched_digest', `${open.length} new lead${open.length === 1 ? '' : 's'} in your area`, lines.join('\n'),
          { requestIds: open.map((row) => row.id), requestCodes: open.map((row) => row.request_code) });
        sent += 1;
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  return { sent };
}

export function startAlertDigestWorker(pool, { intervalMs, logger = console }) {
  let active = false;
  const run = async () => {
    if (active) return;
    active = true;
    try {
      await processAlertDigests(pool);
    } catch {
      logger.error('Lead alert digest processing failed.');
    } finally {
      active = false;
    }
  };
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  void run();
  return () => clearInterval(timer);
}
