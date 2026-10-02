import { randomUUID } from 'node:crypto';

async function notify(client, organizationId, eventType, title, message, data) {
  await client.query(
    'INSERT INTO notifications (id, organization_id, event_type, title, message, data) VALUES ($1, $2, $3, $4, $5, $6)',
    [randomUUID(), organizationId, eventType, title, message, JSON.stringify(data)],
  );
}

export async function processRequestDeadlines(pool, { now = () => new Date(), batchSize = 50 } = {}) {
  const client = await pool.connect();
  const result = { closed: 0, expired: 0 };
  try {
    await client.query('BEGIN');
    const due = await client.query(
      `SELECT r.id, r.request_code, r.destination, r.agency_organization_id,
              (SELECT COUNT(*) FROM offers f WHERE f.request_id = r.id
                 AND f.status IN ('submitted', 'shortlisted')) AS active_offers
       FROM marketplace_requests r
       WHERE r.status = 'open' AND r.response_deadline <= $1
       ORDER BY r.response_deadline, r.id
       LIMIT $2 FOR UPDATE OF r SKIP LOCKED`,
      [now(), batchSize],
    );
    for (const row of due.rows) {
      const activeOffers = Number(row.active_offers);
      const nextStatus = activeOffers > 0 ? 'closed' : 'expired';
      await client.query(
        'UPDATE marketplace_requests SET status = $2, closed_at = $3, updated_at = $3 WHERE id = $1',
        [row.id, nextStatus, now()],
      );
      const data = { requestId: row.id, requestCode: row.request_code };
      if (nextStatus === 'closed') {
        await notify(client, row.agency_organization_id, 'request_closed', 'Responses closed', `${row.request_code} / ${row.destination} / ${activeOffers} offers ready to review`, data);
        const sellers = await client.query(
          "SELECT DISTINCT seller_organization_id FROM offers WHERE request_id = $1 AND status IN ('submitted', 'shortlisted')",
          [row.id],
        );
        for (const seller of sellers.rows) {
          await notify(client, seller.seller_organization_id, 'request_closed', 'Request closed for new offers', `${row.request_code} / ${row.destination} / The agency is reviewing offers`, data);
        }
        result.closed += 1;
      } else {
        await notify(client, row.agency_organization_id, 'request_expired', 'Request expired without offers', `${row.request_code} / ${row.destination}`, data);
        result.expired += 1;
      }
    }
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function startRequestDeadlineWorker(pool, { intervalMs = 60000, logger = console } = {}) {
  let active = false;
  let stopped = false;
  const run = async () => {
    if (active || stopped) return;
    active = true;
    try {
      await processRequestDeadlines(pool);
    } catch {
      logger.error('Request deadline processing failed.');
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
