import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config/index.js';
import { capabilities } from '../config/referenceData.js';
import { guestAccessWindow, openGuestDetails, parseGuestDetails, sealGuestDetails } from '../services/bookingGuestDetails.js';
import { recordOrganizationEvent } from '../services/organizationAudit.js';
import { organizationIsActive } from '../services/organizationLifecycle.js';
import { requireCapability } from '../services/permissions.js';
import { getSetting } from '../services/platformSettings.js';
import { detectAllowedFileType, displayFilename, downloadDisposition, sha256Hex } from '../services/verificationDocuments.js';
import { containsContactDetails } from '../utils/contactDetails.js';
import { createRateLimiter } from '../utils/rateLimit.js';
import { parseWith } from '../utils/validation.js';
import { loadSession, requireActiveAccount, requireCsrf, requireMfaForPlatformAdmin } from './auth.routes.js';

const uuidSchema = z.uuid();
const confirmedStatuses = ['confirmation_pending', 'booked'];
const sellerConfirmationSchema = z.object({
  confirmation_number: z.string().trim().min(3, 'Enter the confirmation number from your reservation system.').max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9 ./_-]*$/, 'Use letters, digits, spaces, dots, slashes, underscores or hyphens in the confirmation number.'),
  note: z.string().trim().max(500).nullish().transform((value) => value || null),
}).refine((input) => !containsContactDetails(input.note), 'Remove contact details and links from the note.');
const revokeSchema = z.object({
  reason: z.string().trim().min(5, 'Give a reason of at least 5 characters.').max(300),
}).refine((input) => !containsContactDetails(input.reason), 'Remove contact details and links from the reason.');

const allowedFormats = config.documents.allowedMimeTypes.map((mime) => mime.split('/')[1].toUpperCase()).join(', ');
const multerErrors = {
  LIMIT_FILE_SIZE: [413, 'FILE_TOO_LARGE', `Files must be ${config.documents.maxBytes / (1024 * 1024)} MB or smaller.`],
  LIMIT_FILE_COUNT: [400, 'VALIDATION_ERROR', 'Upload one file at a time.'],
  LIMIT_UNEXPECTED_FILE: [400, 'VALIDATION_ERROR', 'Send the voucher in the "file" field.'],
};

const bookingSelect = `
  SELECT a.id, a.request_id, a.offer_id, a.status, a.created_at, a.booking_confirmed_at,
         a.seller_confirmation_number, a.seller_confirmation_note, a.seller_confirmed_at,
         a.agency_organization_id, a.seller_organization_id,
         r.request_code, r.destination, r.destination_country, r.travel_start_date::text AS travel_start_date,
         r.travel_end_date::text AS travel_end_date, r.travel_month, r.nights, r.adults, r.children, r.infants,
         r.room_count AS request_room_count,
         f.offer_kind, f.room_type, f.room_count AS offer_room_count, f.meal_plan, f.currency, f.total_minor, f.rate_per_night_minor,
         agency.name AS agency_name, seller.name AS seller_name, seller.business_type AS seller_type,
         (${organizationIsActive('seller')}) AS seller_active,
         g.award_id IS NOT NULL AS has_guest_details, g.guest_count, g.trip_end_date::text AS trip_end_date,
         g.version AS guest_version, g.released_at, g.revoked_at, g.revoked_reason, g.purged_at, g.updated_at AS guest_updated_at,
         (SELECT COUNT(*)::int FROM booking_vouchers v WHERE v.award_id = a.id AND v.deleted_at IS NULL) AS voucher_count
  FROM awards a
  JOIN marketplace_requests r ON r.id = a.request_id
  JOIN offers f ON f.id = a.offer_id
  JOIN organizations agency ON agency.id = a.agency_organization_id
  JOIN organizations seller ON seller.id = a.seller_organization_id
  LEFT JOIN booking_guest_details g ON g.award_id = a.id`;

function fail(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

async function inTransaction(pool, work) {
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

async function notify(db, organizationId, eventType, title, message, data) {
  await db.query(
    'INSERT INTO notifications (id, organization_id, event_type, title, message, data) VALUES ($1, $2, $3, $4, $5, $6)',
    [randomUUID(), organizationId, eventType, title, message, JSON.stringify(data)],
  );
}

async function logAccess(db, { awardId, organizationId, userId, action, details = {} }) {
  await db.query(
    'INSERT INTO booking_guest_access_log (id, award_id, organization_id, user_id, action, details) VALUES ($1, $2, $3, $4, $5, $6)',
    [randomUUID(), awardId, organizationId, userId, action, JSON.stringify(details)],
  );
}

async function loadBooking(db, awardId, organizationId, { lock = false } = {}) {
  const result = await db.query(
    `${bookingSelect} WHERE a.id = $1 AND (a.agency_organization_id = $2 OR a.seller_organization_id = $2)${lock ? ' FOR UPDATE OF a' : ''}`,
    [awardId, organizationId],
  );
  return result.rows[0] ?? null;
}

async function guestDataSettings(db) {
  return {
    sellerAccessDays: await getSetting(db, 'guest_data_seller_access_days'),
    retentionDays: await getSetting(db, 'guest_data_retention_days'),
  };
}

function bookingFacts(row) {
  return {
    adults: row.adults,
    children: row.children,
    infants: row.infants,
    travelStartDate: row.travel_start_date,
    travelEndDate: row.travel_end_date,
    travelMonth: row.travel_month,
    nights: row.nights,
    roomCount: Number(row.offer_room_count ?? row.request_room_count ?? 1),
    roomingRequired: row.offer_kind === 'hotel_room',
  };
}

// Null when the winning seller may open guest details; otherwise the reason it may not.
function sellerAccessError(row, settings) {
  if (!row.has_guest_details) return [404, 'GUEST_DETAILS_NOT_RELEASED', 'Guest details are shared only after the agency confirms the booking.'];
  if (row.purged_at) return [410, 'GUEST_DETAILS_DELETED', 'Guest details were deleted under the retention policy.'];
  if (!confirmedStatuses.includes(row.status)) return [403, 'GUEST_DETAILS_NOT_AVAILABLE', 'Guest details are not available for this booking.'];
  if (row.revoked_at) return [403, 'GUEST_DETAILS_REVOKED', 'The agency has withdrawn access to these guest details.'];
  if (!guestAccessWindow(row.trip_end_date, settings).sellerAccessOpen) return [403, 'GUEST_DETAILS_ACCESS_EXPIRED', 'Access to guest details ended after the trip.'];
  return null;
}

function bookingDto(row, organizationId, settings) {
  const window = row.has_guest_details ? guestAccessWindow(row.trip_end_date, settings) : null;
  const roomCount = Number(row.offer_room_count ?? row.request_room_count ?? 1);
  return {
    id: row.id,
    requestId: row.request_id,
    requestCode: row.request_code,
    destination: row.destination,
    destinationCountry: row.destination_country,
    travelStartDate: row.travel_start_date,
    travelEndDate: row.travel_end_date,
    travelMonth: row.travel_month,
    nights: row.nights,
    adults: row.adults,
    children: row.children,
    infants: row.infants,
    roomCount,
    roomingRequired: row.offer_kind === 'hotel_room',
    viewerRole: row.agency_organization_id === organizationId ? 'agency' : 'seller',
    agencyName: row.agency_name,
    sellerName: row.seller_name,
    sellerType: row.seller_type,
    offer: {
      id: row.offer_id,
      kind: row.offer_kind,
      roomType: row.room_type,
      mealPlan: row.meal_plan,
      currency: row.currency,
      totalMinor: row.total_minor == null ? null : Number(row.total_minor),
      ratePerNightMinor: row.rate_per_night_minor == null ? null : Number(row.rate_per_night_minor),
    },
    status: row.status,
    awardedAt: row.created_at,
    bookingConfirmedAt: row.booking_confirmed_at,
    sellerConfirmationNumber: row.seller_confirmation_number,
    sellerConfirmationNote: row.seller_confirmation_note,
    sellerConfirmedAt: row.seller_confirmed_at,
    guestDetails: row.has_guest_details ? {
      guestCount: row.guest_count,
      version: row.guest_version,
      releasedAt: row.released_at,
      updatedAt: row.guest_updated_at,
      revokedAt: row.revoked_at,
      revokedReason: row.revoked_reason,
      purgedAt: row.purged_at,
      tripEndDate: row.trip_end_date,
      sellerAccessEndsOn: window.sellerAccessEndsOn,
      deletionDueOn: window.deletionDueOn,
      sellerCanView: !sellerAccessError(row, settings),
    } : null,
    voucherCount: row.voucher_count,
  };
}

function voucherDto(row) {
  return {
    id: row.id,
    filename: row.original_filename,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    scanStatus: row.scan_status,
    uploadedAt: row.created_at,
    removedAt: row.deleted_at,
  };
}

export function createBookingRouter({ pool, storage = null, guestDataEncryptionKey = null }) {
  const router = Router();
  const viewLimiter = createRateLimiter(config.rateLimits.guestDetailsView, 'Too many guest detail requests. Try again later.');
  const uploadLimiter = createRateLimiter(config.rateLimits.documentUpload, 'Too many voucher uploads. Try again later.');
  const upload = multer({
    storage: multer.memoryStorage(),
    defParamCharset: 'utf8',
    limits: { fileSize: config.documents.maxBytes, files: 1, fields: 2, fieldSize: 1024, parts: 3 },
  }).single('file');

  router.use((request, response, next) => loadSession(pool, request, response, next));
  router.use(requireMfaForPlatformAdmin);
  router.use((request, response, next) => requireActiveAccount(pool, request, response, next));
  router.use((request, response, next) => request.method === 'GET' ? next() : requireCsrf(request, response, next));
  router.param('awardId', (request, response, next, value) => uuidSchema.safeParse(value).success ? next() : fail(response, 404, 'BOOKING_NOT_FOUND', 'Booking was not found.'));

  const requireGuestKey = (_request, response, next) => guestDataEncryptionKey
    ? next()
    : fail(response, 503, 'GUEST_DATA_ENCRYPTION_NOT_CONFIGURED', 'Guest details are unavailable until guest-data encryption is configured for this platform.');

  async function bookingResponse(awardId, organizationId) {
    const row = await loadBooking(pool, awardId, organizationId);
    const settings = await guestDataSettings(pool);
    const vouchers = await pool.query('SELECT * FROM booking_vouchers WHERE award_id = $1 ORDER BY created_at DESC', [awardId]);
    return { ...bookingDto(row, organizationId, settings), vouchers: vouchers.rows.map(voucherDto) };
  }

  router.get('/', async (request, response, next) => {
    try {
      const settings = await guestDataSettings(pool);
      const result = await pool.query(
        `${bookingSelect} WHERE a.agency_organization_id = $1 OR a.seller_organization_id = $1 ORDER BY a.created_at DESC LIMIT 200`,
        [request.auth.organization_id],
      );
      return response.json({ bookings: result.rows.map((row) => bookingDto(row, request.auth.organization_id, settings)) });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:awardId', async (request, response, next) => {
    try {
      if (!await loadBooking(pool, request.params.awardId, request.auth.organization_id)) return fail(response, 404, 'BOOKING_NOT_FOUND', 'Booking was not found.');
      return response.json({ booking: await bookingResponse(request.params.awardId, request.auth.organization_id) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:awardId/confirm', requireCapability(capabilities.requestAward), requireGuestKey, async (request, response, next) => {
    if (request.auth.business_type !== 'agency') return fail(response, 403, 'ROLE_FORBIDDEN', 'Only the agency that awarded the offer can confirm the booking.');
    const { awardId } = request.params;
    const me = request.auth.organization_id;
    try {
      const outcome = await inTransaction(pool, async (client) => {
        const booking = await loadBooking(client, awardId, me, { lock: true });
        if (!booking || booking.agency_organization_id !== me) return { error: [404, 'BOOKING_NOT_FOUND', 'Booking was not found.'] };
        if (booking.status !== 'awarded') return { error: [409, 'BOOKING_ALREADY_CONFIRMED', 'This booking has already been confirmed or cancelled.'] };
        if (!booking.seller_active) return { error: [409, 'SELLER_UNAVAILABLE', 'The awarded seller is suspended or closing, so guest details cannot be released.'] };
        const parsed = parseGuestDetails(request.body, bookingFacts(booking));
        if (parsed.error) return { error: [400, 'VALIDATION_ERROR', parsed.error] };
        await client.query(
          `INSERT INTO booking_guest_details (award_id, ciphertext, guest_count, trip_end_date, updated_by)
           VALUES ($1, $2, $3, $4, $5)`,
          [awardId, sealGuestDetails(awardId, parsed.data, guestDataEncryptionKey), parsed.data.guests.length, parsed.data.departure.date, request.auth.user_id],
        );
        await client.query(
          "UPDATE awards SET status = 'confirmation_pending', booking_confirmed_at = NOW(), booking_confirmed_by = $2 WHERE id = $1",
          [awardId, request.auth.user_id],
        );
        await logAccess(client, { awardId, organizationId: me, userId: request.auth.user_id, action: 'released', details: { version: 1, guestCount: parsed.data.guests.length } });
        await notify(client, booking.seller_organization_id, 'booking_confirmed', 'Booking confirmed by the agency', `${booking.request_code} / ${booking.destination} / Guest details are ready. Confirm with your booking reference.`, { awardId, requestId: booking.request_id, requestCode: booking.request_code });
        await recordOrganizationEvent(client, { organizationId: me, actorUserId: request.auth.user_id, action: 'booking.confirmed', details: { awardId, requestCode: booking.request_code } });
        return {};
      });
      if (outcome.error) return fail(response, ...outcome.error);
      return response.status(201).json({ booking: await bookingResponse(awardId, me) });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:awardId/guest-details', viewLimiter, requireCapability(capabilities.bookingManage), requireGuestKey, async (request, response, next) => {
    const { awardId } = request.params;
    const me = request.auth.organization_id;
    try {
      const booking = await loadBooking(pool, awardId, me);
      if (!booking) return fail(response, 404, 'BOOKING_NOT_FOUND', 'Booking was not found.');
      if (booking.agency_organization_id === me) {
        if (!booking.has_guest_details) return fail(response, 404, 'GUEST_DETAILS_NOT_RELEASED', 'Confirm the booking to enter guest details.');
        if (booking.purged_at) return fail(response, 410, 'GUEST_DETAILS_DELETED', 'Guest details were deleted under the retention policy.');
      } else {
        const denied = sellerAccessError(booking, await guestDataSettings(pool));
        if (denied) return fail(response, ...denied);
      }
      const sealed = await pool.query('SELECT ciphertext, version FROM booking_guest_details WHERE award_id = $1 AND purged_at IS NULL', [awardId]);
      if (!sealed.rowCount) return fail(response, 410, 'GUEST_DETAILS_DELETED', 'Guest details were deleted under the retention policy.');
      const details = openGuestDetails(awardId, sealed.rows[0].ciphertext, guestDataEncryptionKey);
      await logAccess(pool, { awardId, organizationId: me, userId: request.auth.user_id, action: 'viewed', details: { version: sealed.rows[0].version } });
      response.set('cache-control', 'no-store');
      return response.json({ guestDetails: { version: sealed.rows[0].version, ...details } });
    } catch (error) {
      return next(error);
    }
  });

  router.put('/:awardId/guest-details', requireCapability(capabilities.bookingManage), requireGuestKey, async (request, response, next) => {
    if (request.auth.business_type !== 'agency') return fail(response, 403, 'ROLE_FORBIDDEN', 'Only the agency can correct guest details.');
    const { awardId } = request.params;
    const me = request.auth.organization_id;
    try {
      const outcome = await inTransaction(pool, async (client) => {
        const booking = await loadBooking(client, awardId, me, { lock: true });
        if (!booking || booking.agency_organization_id !== me) return { error: [404, 'BOOKING_NOT_FOUND', 'Booking was not found.'] };
        if (!booking.has_guest_details || !confirmedStatuses.includes(booking.status)) return { error: [409, 'BOOKING_NOT_CONFIRMED', 'Confirm the booking before correcting guest details.'] };
        if (booking.purged_at) return { error: [410, 'GUEST_DETAILS_DELETED', 'Guest details were deleted under the retention policy.'] };
        const parsed = parseGuestDetails(request.body, bookingFacts(booking));
        if (parsed.error) return { error: [400, 'VALIDATION_ERROR', parsed.error] };
        const updated = await client.query(
          `UPDATE booking_guest_details SET ciphertext = $2, guest_count = $3, trip_end_date = $4, version = version + 1,
             updated_by = $5, updated_at = NOW()
           WHERE award_id = $1 AND purged_at IS NULL RETURNING version`,
          [awardId, sealGuestDetails(awardId, parsed.data, guestDataEncryptionKey), parsed.data.guests.length, parsed.data.departure.date, request.auth.user_id],
        );
        if (!updated.rowCount) return { error: [410, 'GUEST_DETAILS_DELETED', 'Guest details were deleted under the retention policy.'] };
        const version = updated.rows[0].version;
        await logAccess(client, { awardId, organizationId: me, userId: request.auth.user_id, action: 'corrected', details: { version } });
        if (!booking.revoked_at) await notify(client, booking.seller_organization_id, 'guest_details_corrected', 'Guest details updated', `${booking.request_code} / The agency corrected the guest details (version ${version}).`, { awardId, requestId: booking.request_id, requestCode: booking.request_code });
        return {};
      });
      if (outcome.error) return fail(response, ...outcome.error);
      return response.json({ booking: await bookingResponse(awardId, me) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:awardId/guest-details/revoke', requireCapability(capabilities.bookingManage), async (request, response, next) => {
    if (request.auth.business_type !== 'agency') return fail(response, 403, 'ROLE_FORBIDDEN', 'Only the agency can revoke access to guest details.');
    const input = parseWith(revokeSchema, request.body);
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    const { awardId } = request.params;
    const me = request.auth.organization_id;
    try {
      const outcome = await inTransaction(pool, async (client) => {
        const booking = await loadBooking(client, awardId, me, { lock: true });
        if (!booking || booking.agency_organization_id !== me) return { error: [404, 'BOOKING_NOT_FOUND', 'Booking was not found.'] };
        const updated = await client.query(
          `UPDATE booking_guest_details SET revoked_at = NOW(), revoked_reason = $2, updated_at = NOW()
           WHERE award_id = $1 AND revoked_at IS NULL AND purged_at IS NULL`,
          [awardId, input.data.reason],
        );
        if (!updated.rowCount) return { error: [409, 'GUEST_DETAILS_NOT_SHARED', 'There are no shared guest details to revoke.'] };
        await logAccess(client, { awardId, organizationId: me, userId: request.auth.user_id, action: 'revoked', details: { reason: input.data.reason } });
        await notify(client, booking.seller_organization_id, 'guest_details_revoked', 'Access to guest details withdrawn', `${booking.request_code} / Reason: ${input.data.reason}`, { awardId, requestId: booking.request_id, requestCode: booking.request_code });
        return {};
      });
      if (outcome.error) return fail(response, ...outcome.error);
      return response.json({ booking: await bookingResponse(awardId, me) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:awardId/guest-details/restore', requireCapability(capabilities.bookingManage), async (request, response, next) => {
    if (request.auth.business_type !== 'agency') return fail(response, 403, 'ROLE_FORBIDDEN', 'Only the agency can restore access to guest details.');
    const { awardId } = request.params;
    const me = request.auth.organization_id;
    try {
      const outcome = await inTransaction(pool, async (client) => {
        const booking = await loadBooking(client, awardId, me, { lock: true });
        if (!booking || booking.agency_organization_id !== me) return { error: [404, 'BOOKING_NOT_FOUND', 'Booking was not found.'] };
        if (!confirmedStatuses.includes(booking.status)) return { error: [409, 'BOOKING_NOT_CONFIRMED', 'Guest details can only be shared for a confirmed booking.'] };
        if (!booking.seller_active) return { error: [409, 'SELLER_UNAVAILABLE', 'The awarded seller is suspended or closing, so guest details cannot be released.'] };
        const updated = await client.query(
          `UPDATE booking_guest_details SET revoked_at = NULL, revoked_reason = NULL, updated_at = NOW()
           WHERE award_id = $1 AND revoked_at IS NOT NULL AND purged_at IS NULL`,
          [awardId],
        );
        if (!updated.rowCount) return { error: [409, 'GUEST_DETAILS_NOT_REVOKED', 'Seller access to these guest details is not revoked.'] };
        await logAccess(client, { awardId, organizationId: me, userId: request.auth.user_id, action: 'restored' });
        await notify(client, booking.seller_organization_id, 'guest_details_restored', 'Access to guest details restored', `${booking.request_code} / The agency shared the guest details again.`, { awardId, requestId: booking.request_id, requestCode: booking.request_code });
        return {};
      });
      if (outcome.error) return fail(response, ...outcome.error);
      return response.json({ booking: await bookingResponse(awardId, me) });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:awardId/guest-details/access-log', requireCapability(capabilities.bookingManage), async (request, response, next) => {
    try {
      const booking = await loadBooking(pool, request.params.awardId, request.auth.organization_id);
      if (!booking || booking.agency_organization_id !== request.auth.organization_id) return fail(response, 404, 'BOOKING_NOT_FOUND', 'Booking was not found.');
      const result = await pool.query(
        `SELECT l.id, l.action, l.details, l.created_at, o.name AS organization_name, u.full_name AS user_name
         FROM booking_guest_access_log l
         LEFT JOIN organizations o ON o.id = l.organization_id
         LEFT JOIN users u ON u.id = l.user_id
         WHERE l.award_id = $1 ORDER BY l.created_at DESC, l.id LIMIT 200`,
        [request.params.awardId],
      );
      return response.json({ entries: result.rows.map((row) => ({ id: row.id, action: row.action, details: row.details, organizationName: row.organization_name, userName: row.user_name, createdAt: row.created_at })) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:awardId/seller-confirmation', requireCapability(capabilities.bookingManage), async (request, response, next) => {
    if (!['dmc', 'hotelier'].includes(request.auth.business_type)) return fail(response, 403, 'ROLE_FORBIDDEN', 'Only the winning seller can confirm the booking reference.');
    const input = parseWith(sellerConfirmationSchema, request.body);
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    const { awardId } = request.params;
    const me = request.auth.organization_id;
    try {
      const outcome = await inTransaction(pool, async (client) => {
        const booking = await loadBooking(client, awardId, me, { lock: true });
        if (!booking || booking.seller_organization_id !== me) return { error: [404, 'BOOKING_NOT_FOUND', 'Booking was not found.'] };
        if (!confirmedStatuses.includes(booking.status)) return { error: [409, 'BOOKING_NOT_CONFIRMED', 'The agency has not confirmed this booking yet.'] };
        await client.query(
          `UPDATE awards SET status = 'booked', seller_confirmation_number = $2, seller_confirmation_note = $3,
             seller_confirmed_at = NOW(), seller_confirmed_by = $4 WHERE id = $1`,
          [awardId, input.data.confirmation_number, input.data.note, request.auth.user_id],
        );
        const updated = booking.status === 'booked';
        await notify(client, booking.agency_organization_id, 'booking_seller_confirmed', updated ? 'Booking reference updated' : 'Seller confirmed the booking', `${booking.request_code} / ${booking.seller_name} / Reference ${input.data.confirmation_number}`, { awardId, requestId: booking.request_id, requestCode: booking.request_code });
        await recordOrganizationEvent(client, { organizationId: me, actorUserId: request.auth.user_id, action: updated ? 'booking.reference_updated' : 'booking.seller_confirmed', details: { awardId, requestCode: booking.request_code } });
        return {};
      });
      if (outcome.error) return fail(response, ...outcome.error);
      return response.json({ booking: await bookingResponse(awardId, me) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:awardId/vouchers', requireCapability(capabilities.bookingManage), (request, response, next) => {
    if (!['dmc', 'hotelier'].includes(request.auth.business_type)) return fail(response, 403, 'ROLE_FORBIDDEN', 'Only the winning seller can upload a booking voucher.');
    if (!storage) return fail(response, 503, 'STORAGE_NOT_CONFIGURED', 'Voucher upload is unavailable until private file storage is configured.');
    return next();
  }, uploadLimiter, (request, response, next) => upload(request, response, (error) => {
    if (!error) return next();
    const [status, code, message] = multerErrors[error.code] ?? [400, 'VALIDATION_ERROR', 'The upload could not be read. Try again with a single file.'];
    return fail(response, status, code, message);
  }), async (request, response, next) => {
    const { awardId } = request.params;
    const me = request.auth.organization_id;
    if (!request.file?.buffer?.length) return fail(response, 400, 'VALIDATION_ERROR', 'Attach the voucher file.');
    try {
      const booking = await loadBooking(pool, awardId, me);
      if (!booking || booking.seller_organization_id !== me) return fail(response, 404, 'BOOKING_NOT_FOUND', 'Booking was not found.');
      if (!confirmedStatuses.includes(booking.status)) return fail(response, 409, 'BOOKING_NOT_CONFIRMED', 'Upload a voucher after the agency confirms the booking.');
      if (booking.purged_at) return fail(response, 410, 'GUEST_DETAILS_DELETED', 'This booking is past its retention period.');
      if (booking.voucher_count >= config.bookings.maxVouchersPerBooking) return fail(response, 409, 'VOUCHER_LIMIT_REACHED', `A booking can hold up to ${config.bookings.maxVouchersPerBooking} vouchers.`);
      const detected = await detectAllowedFileType(request.file.buffer).catch(() => null);
      if (!detected) return fail(response, 415, 'UNSUPPORTED_FILE_TYPE', `Upload a ${allowedFormats} file. The file content must match a supported format.`);

      const voucherId = randomUUID();
      const storageKey = `${config.bookings.voucherKeyPrefix}/${awardId}/${voucherId}.${detected.ext}`;
      const filename = displayFilename(request.file.originalname, `voucher-${booking.request_code}.${detected.ext}`);
      await storage.putObject({ key: storageKey, body: request.file.buffer, contentType: detected.mime });
      try {
        const inserted = await pool.query(
          `INSERT INTO booking_vouchers (id, award_id, seller_organization_id, agency_organization_id, storage_provider, storage_key,
             original_filename, content_type, size_bytes, sha256, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
          [voucherId, awardId, me, booking.agency_organization_id, storage.provider, storageKey, filename, detected.mime, request.file.size, sha256Hex(request.file.buffer), request.auth.user_id],
        );
        await recordOrganizationEvent(pool, { organizationId: me, actorUserId: request.auth.user_id, action: 'booking.voucher_uploaded', details: { awardId, voucherId } });
        return response.status(201).json({ voucher: voucherDto(inserted.rows[0]) });
      } catch (error) {
        await storage.deleteObject(storageKey).catch(() => {});
        throw error;
      }
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:awardId/vouchers/:voucherId/download-url', requireCapability(capabilities.bookingManage), async (request, response, next) => {
    const { awardId, voucherId } = request.params;
    const me = request.auth.organization_id;
    if (!uuidSchema.safeParse(voucherId).success) return fail(response, 404, 'VOUCHER_NOT_FOUND', 'Voucher was not found.');
    if (!storage) return fail(response, 503, 'STORAGE_NOT_CONFIGURED', 'Vouchers cannot be opened until private file storage is configured.');
    try {
      const booking = await loadBooking(pool, awardId, me);
      if (!booking) return fail(response, 404, 'BOOKING_NOT_FOUND', 'Booking was not found.');
      if (booking.seller_organization_id === me) {
        const denied = sellerAccessError(booking, await guestDataSettings(pool));
        if (denied) return fail(response, ...denied);
      }
      const result = await pool.query('SELECT * FROM booking_vouchers WHERE id = $1 AND award_id = $2', [voucherId, awardId]);
      const voucher = result.rows[0];
      if (!voucher || voucher.deleted_at) return fail(response, 404, 'VOUCHER_NOT_FOUND', 'Voucher was not found or has been removed.');
      if (voucher.scan_status !== 'clean') return fail(response, 409, 'DOCUMENT_NOT_SCANNED', 'Only vouchers that passed the malware scan can be opened.');
      if (voucher.storage_provider !== storage.provider) return fail(response, 409, 'STORAGE_PROVIDER_CHANGED', 'This voucher is held by a storage provider that is no longer configured.');
      const expiresInSeconds = config.documents.downloadUrlTtlSeconds;
      const url = await storage.createDownloadUrl(voucher.storage_key, {
        expiresInSeconds,
        contentDisposition: downloadDisposition(voucher.original_filename),
        contentType: voucher.content_type,
      });
      await logAccess(pool, { awardId, organizationId: me, userId: request.auth.user_id, action: 'voucher_opened', details: { voucherId } });
      return response.json({ url, expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString() });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
