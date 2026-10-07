import { randomUUID } from 'node:crypto';
import { config } from '../config/index.js';
import { notify } from './routing.js';
import { getSetting } from './platformSettings.js';

const dayMs = 24 * 60 * 60 * 1000;

function dateRange(startDate, endDate) {
  const dates = [];
  for (let timestamp = Date.parse(`${startDate}T00:00:00Z`); timestamp < Date.parse(`${endDate}T00:00:00Z`); timestamp += dayMs) {
    dates.push(new Date(timestamp).toISOString().slice(0, 10));
  }
  return dates;
}

export async function createHotelRoomHold(client, {
  awardId, organizationId, propertyId, requestId, offerId, roomType, rooms, startDate, endDate,
}) {
  if (!propertyId || !startDate || !endDate) return { hold: null, reason: 'inventory_not_date_specific' };
  const dates = dateRange(startDate, endDate);
  if (!dates.length) return { error: [409, 'HOTEL_DATES_UNAVAILABLE', 'Exact travel dates are required to hold hotel rooms.'] };

  const inventory = await client.query(
    `SELECT inventory_date::text AS inventory_date, available_rooms
     FROM hotel_room_inventory
     WHERE organization_id = $1 AND room_type = $2 AND inventory_date >= $3 AND inventory_date < $4
     ORDER BY inventory_date FOR UPDATE`,
    [organizationId, roomType, startDate, endDate],
  );
  if (!inventory.rowCount) return { hold: null, reason: 'inventory_not_configured' };
  const byDate = new Map(inventory.rows.map((row) => [row.inventory_date, Number(row.available_rooms)]));
  if (dates.some((date) => !byDate.has(date))) return { error: [409, 'ROOMS_UNAVAILABLE', 'The hotel has not configured room availability for every requested night.'] };

  for (const date of dates) {
    const reserved = await client.query(
      `SELECT COALESCE(SUM(rooms), 0)::int AS rooms
       FROM hotel_room_holds
       WHERE organization_id = $1 AND room_type = $2
         AND (status IN ('confirmed', 'booked') OR (status = 'held' AND expires_at > NOW()))
         AND start_date <= $3 AND end_date > $3`,
      [organizationId, roomType, date],
    );
    if (byDate.get(date) - Number(reserved.rows[0].rooms) < rooms) {
      return { error: [409, 'ROOMS_UNAVAILABLE', `Not enough ${roomType} rooms remain available for ${date}.`] };
    }
  }

  const holdMinutes = await getSetting(client, 'hotel_room_hold_minutes');
  const expiresAt = new Date(Date.now() + holdMinutes * 60 * 1000);
  const previousHold = await client.query('SELECT id, status FROM hotel_room_holds WHERE award_id = $1 FOR UPDATE', [awardId]);
  if (previousHold.rowCount) {
    if (!['expired', 'released'].includes(previousHold.rows[0].status)) return { error: [409, 'ROOM_HOLD_ACTIVE', 'This award already has an active room hold.'] };
    const renewed = await client.query(
      `UPDATE hotel_room_holds SET organization_id = $2, property_id = $3, request_id = $4, offer_id = $5,
         room_type = $6, rooms = $7, start_date = $8, end_date = $9, status = 'held', expires_at = $10,
         confirmed_at = NULL, released_at = NULL
       WHERE id = $1 RETURNING *`,
      [previousHold.rows[0].id, organizationId, propertyId, requestId, offerId, roomType, rooms, startDate, endDate, expiresAt],
    );
    return { hold: renewed.rows[0] };
  }
  const created = await client.query(
    `INSERT INTO hotel_room_holds (id, award_id, organization_id, property_id, request_id, offer_id, room_type, rooms, start_date, end_date, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [randomUUID(), awardId, organizationId, propertyId, requestId, offerId, roomType, rooms, startDate, endDate, expiresAt],
  );
  return { hold: created.rows[0] };
}

export async function confirmHotelRoomHold(client, awardId) {
  return client.query(
    `UPDATE hotel_room_holds SET status = 'confirmed', expires_at = NULL, confirmed_at = NOW()
     WHERE award_id = $1 AND status = 'held' AND expires_at > NOW() RETURNING *`,
    [awardId],
  );
}

export async function bookHotelRoomHold(client, awardId) {
  await client.query(
    `UPDATE hotel_room_holds SET status = 'booked', expires_at = NULL
     WHERE award_id = $1 AND status IN ('held', 'confirmed')`,
    [awardId],
  );
}

export async function releaseHotelRoomHold(client, awardId) {
  await client.query(
    `UPDATE hotel_room_holds SET status = 'released', expires_at = NULL, released_at = NOW()
     WHERE award_id = $1 AND status IN ('held', 'confirmed')`,
    [awardId],
  );
}

export async function processHotelRoomHolds(pool, { now = () => new Date(), batchSize = 100 } = {}) {
  const current = now();
  const expired = await pool.query(
    `UPDATE hotel_room_holds hold SET status = 'expired', expires_at = NULL, released_at = $1
     FROM awards award JOIN marketplace_requests request ON request.id = award.request_id
     WHERE award.id = hold.award_id AND hold.status = 'held' AND hold.expires_at <= $1
       AND hold.id IN (SELECT id FROM hotel_room_holds WHERE status = 'held' AND expires_at <= $1 ORDER BY expires_at, id LIMIT $2 FOR UPDATE SKIP LOCKED)
     RETURNING hold.award_id, hold.organization_id, hold.request_id, hold.offer_id, request.agency_organization_id, request.request_code`,
    [current, batchSize],
  );
  for (const hold of expired.rows) {
    const data = { awardId: hold.award_id, requestId: hold.request_id, requestCode: hold.request_code, offerId: hold.offer_id };
    await notify(pool, hold.agency_organization_id, 'hotel_room_hold_expired', 'Hotel room hold expired', `${hold.request_code} / The room hold expired before booking confirmation.`, data);
    await notify(pool, hold.organization_id, 'hotel_room_hold_expired', 'Hotel room hold expired', `${hold.request_code} / The agency did not confirm before the hold expired.`, data);
  }
  return { expired: expired.rowCount };
}

export function startHotelRoomHoldWorker(pool, { intervalMs = config.deadlineJobIntervalMs, logger = console } = {}) {
  let active = false;
  let stopped = false;
  const run = async () => {
    if (active || stopped) return;
    active = true;
    try {
      await processHotelRoomHolds(pool);
    } catch {
      logger.error('Hotel room hold processing failed.');
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