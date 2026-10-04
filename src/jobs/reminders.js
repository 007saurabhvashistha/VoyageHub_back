import { randomUUID } from 'node:crypto';
import { config } from '../config/index.js';

async function claimReminder(client, key) {
  const claimed = await client.query('INSERT INTO reminder_log (reminder_key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING reminder_key', [key]);
  return claimed.rowCount > 0;
}

async function notify(client, organizationId, eventType, title, message, data) {
  await client.query(
    'INSERT INTO notifications (id, organization_id, event_type, title, message, data) VALUES ($1, $2, $3, $4, $5, $6)',
    [randomUUID(), organizationId, eventType, title, message, JSON.stringify(data)],
  );
}

export async function processReminders(pool, {
  now = () => new Date(),
  deadlineHours = config.reminders.deadlineHours,
  offerExpiryHours = config.reminders.offerExpiryHours,
} = {}) {
  const client = await pool.connect();
  const result = { deadlineReminders: 0, offerExpiryReminders: 0 };
  try {
    await client.query('BEGIN');
    const current = now();
    const deadlineWindowEnd = new Date(current.getTime() + deadlineHours * 60 * 60 * 1000);
    const closingSoon = await client.query(
      `SELECT r.id, r.request_code, r.destination, r.response_deadline, r.agency_organization_id
       FROM marketplace_requests r
       WHERE r.status = 'open' AND r.response_deadline > $1 AND r.response_deadline <= $2`,
      [current, deadlineWindowEnd],
    );
    for (const request of closingSoon.rows) {
      if (!(await claimReminder(client, `deadline:${request.id}:${new Date(request.response_deadline).toISOString()}`))) continue;
      const data = { requestId: request.id, requestCode: request.request_code, responseDeadline: request.response_deadline };
      // Sellers whose offer still awaits re-confirmation for changed trip details are reminded too.
      const waitingSellers = await client.query(
        `SELECT t.seller_organization_id FROM request_targets t
         JOIN marketplace_requests r ON r.id = t.request_id
         WHERE t.request_id = $1 AND t.declined_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM offers f WHERE f.request_id = t.request_id
             AND f.seller_organization_id = t.seller_organization_id AND f.status IN ('submitted', 'shortlisted', 'accepted')
             AND f.confirmed_trip_version >= r.trip_version)`,
        [request.id],
      );
      for (const seller of waitingSellers.rows) {
        await notify(client, seller.seller_organization_id, 'request_deadline_near', 'Request closing soon', `${request.request_code} / ${request.destination} / Respond before the deadline`, data);
      }
      await notify(client, request.agency_organization_id, 'request_deadline_near', 'Your request closes soon', `${request.request_code} / ${request.destination}`, data);
      result.deadlineReminders += 1;
    }

    const expiryWindowEnd = new Date(current.getTime() + offerExpiryHours * 60 * 60 * 1000);
    const expiringOffers = await client.query(
      `SELECT f.id, f.validity_until, f.seller_organization_id, r.id AS request_id, r.request_code,
              r.destination, r.agency_organization_id, seller.name AS seller_name
       FROM offers f JOIN marketplace_requests r ON r.id = f.request_id
       JOIN organizations seller ON seller.id = f.seller_organization_id
       WHERE f.status IN ('submitted', 'shortlisted') AND r.status IN ('open', 'closed')
         AND f.validity_until > $1 AND f.validity_until <= $2`,
      [current, expiryWindowEnd],
    );
    for (const offer of expiringOffers.rows) {
      if (!(await claimReminder(client, `offer_expiry:${offer.id}:${new Date(offer.validity_until).toISOString()}`))) continue;
      const data = { requestId: offer.request_id, requestCode: offer.request_code, offerId: offer.id, validityUntil: offer.validity_until };
      await notify(client, offer.agency_organization_id, 'offer_expiring', 'Offer expiring soon', `${offer.request_code} / ${offer.seller_name} / Decide or ask for an extension`, data);
      await notify(client, offer.seller_organization_id, 'offer_expiring', 'Your offer expires soon', `${offer.request_code} / ${offer.destination} / Revise validity if the price still holds`, data);
      result.offerExpiryReminders += 1;
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

export function startReminderWorker(pool, { intervalMs = config.reminders.intervalMs, logger = console } = {}) {
  let active = false;
  let stopped = false;
  const run = async () => {
    if (active || stopped) return;
    active = true;
    try {
      await processReminders(pool);
    } catch {
      logger.error('Reminder processing failed.');
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
