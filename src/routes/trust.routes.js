import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { loadSession, requireActiveAccount, requireCsrf, requireMfaForPlatformAdmin } from './auth.routes.js';
import { bookingRatingScale } from '../config/referenceData.js';
import { parseWith } from '../utils/validation.js';

const uuidSchema = z.uuid();
const ratingSchema = z.object({ rating: z.number().int().min(bookingRatingScale.minimum).max(bookingRatingScale.maximum) });
const disputeSchema = z.object({
  category: z.string().trim().min(2).max(32),
  summary: z.string().trim().min(10).max(200),
  evidence: z.string().trim().min(10).max(2000),
});
const evidenceSchema = z.object({ evidence: z.string().trim().min(10).max(2000) });
const decisionSchema = z.object({
  status: z.enum(['in_review', 'resolved', 'rejected']),
  note: z.string().trim().min(5).max(1000),
});

function fail(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

async function notify(db, organizationId, eventType, title, message, data) {
  await db.query(
    'INSERT INTO notifications (id, organization_id, event_type, title, message, data) VALUES ($1, $2, $3, $4, $5, $6)',
    [randomUUID(), organizationId, eventType, title, message, JSON.stringify(data)],
  );
}

async function loadPartyBooking(db, awardId, organizationId) {
  const result = await db.query(
    `SELECT a.id, a.status, a.agency_organization_id, a.seller_organization_id,
            r.request_code, COALESCE(g.trip_end_date, r.travel_end_date)::date AS trip_end_date,
            (a.status = 'booked' AND COALESCE(g.trip_end_date, r.travel_end_date)::date <= CURRENT_DATE) AS trip_complete
     FROM awards a JOIN marketplace_requests r ON r.id = a.request_id
     LEFT JOIN booking_guest_details g ON g.award_id = a.id
     WHERE a.id = $1 AND (a.agency_organization_id = $2 OR a.seller_organization_id = $2)`,
    [awardId, organizationId],
  );
  return result.rows[0] ?? null;
}

function reviewDto(row) {
  return row ? { rating: row.rating, createdAt: row.created_at } : null;
}

function disputeDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    category: row.category,
    summary: row.summary,
    status: row.status,
    openedByOrganizationId: row.opened_by_organization_id,
    resolutionNote: row.resolution_note,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    timeline: row.timeline ?? [],
  };
}

export function createTrustRouter({ pool }) {
  const router = Router();
  router.use((request, response, next) => loadSession(pool, request, response, next));
  router.use(requireMfaForPlatformAdmin);
  router.use((request, response, next) => requireActiveAccount(pool, request, response, next));
  router.use((request, response, next) => request.method === 'GET' ? next() : requireCsrf(request, response, next));
  router.param('awardId', (request, response, next, value) => uuidSchema.safeParse(value).success ? next() : fail(response, 404, 'BOOKING_NOT_FOUND', 'Booking was not found.'));

  router.get('/bookings/:awardId', async (request, response, next) => {
    try {
      const booking = await loadPartyBooking(pool, request.params.awardId, request.auth.organization_id);
      if (!booking) return fail(response, 404, 'BOOKING_NOT_FOUND', 'Booking was not found.');
      const otherOrganizationId = booking.agency_organization_id === request.auth.organization_id
        ? booking.seller_organization_id
        : booking.agency_organization_id;
      const [reviews, disputeResult, ratingResult] = await Promise.all([
        pool.query('SELECT reviewer_organization_id, rating, created_at FROM organization_reviews WHERE award_id = $1', [booking.id]),
        pool.query(
          `SELECT d.*, COALESCE(json_agg(json_build_object('id', e.id, 'type', e.event_type, 'message', e.message, 'createdAt', e.created_at)
             ORDER BY e.created_at, e.id) FILTER (WHERE e.id IS NOT NULL), '[]'::json) AS timeline
           FROM booking_disputes d LEFT JOIN booking_dispute_events e ON e.dispute_id = d.id
           WHERE d.award_id = $1 GROUP BY d.id`,
          [booking.id],
        ),
        pool.query(
          'SELECT COUNT(*)::int AS count, ROUND(AVG(rating)::numeric, 2) AS average FROM organization_reviews WHERE reviewee_organization_id = $1',
          [otherOrganizationId],
        ),
      ]);
      const ownReview = reviews.rows.find((row) => row.reviewer_organization_id === request.auth.organization_id);
      const otherReview = reviews.rows.find((row) => row.reviewer_organization_id !== request.auth.organization_id);
      return response.json({
        eligible: Boolean(booking.trip_complete),
        tripEndDate: booking.trip_end_date,
        ownReview: reviewDto(ownReview),
        otherReview: ownReview ? reviewDto(otherReview) : null,
        canReview: Boolean(booking.trip_complete && !ownReview),
        counterpartyRating: {
          count: ratingResult.rows[0].count,
          average: ratingResult.rows[0].average == null ? null : Number(ratingResult.rows[0].average),
        },
        dispute: disputeDto(disputeResult.rows[0]),
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/bookings/:awardId/reviews', async (request, response, next) => {
    const input = parseWith(ratingSchema, request.body);
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    try {
      const booking = await loadPartyBooking(pool, request.params.awardId, request.auth.organization_id);
      if (!booking) return fail(response, 404, 'BOOKING_NOT_FOUND', 'Booking was not found.');
      if (!booking.trip_complete) return fail(response, 409, 'RATING_NOT_YET_AVAILABLE', 'Ratings open after a confirmed booking has completed.');
      const revieweeOrganizationId = booking.agency_organization_id === request.auth.organization_id
        ? booking.seller_organization_id
        : booking.agency_organization_id;
      const inserted = await pool.query(
        `INSERT INTO organization_reviews (id, award_id, reviewer_organization_id, reviewee_organization_id, rating)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (award_id, reviewer_organization_id) DO NOTHING RETURNING rating, created_at`,
        [randomUUID(), booking.id, request.auth.organization_id, revieweeOrganizationId, input.data.rating],
      );
      if (!inserted.rowCount) return fail(response, 409, 'RATING_ALREADY_SUBMITTED', 'Your rating for this booking has already been submitted.');
      await notify(pool, revieweeOrganizationId, 'booking_review_received', 'A booking rating was received', `${booking.request_code} has a new private booking rating.`, { awardId: booking.id });
      return response.status(201).json({ review: reviewDto(inserted.rows[0]) });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/organizations/:organizationId/ratings', async (request, response, next) => {
    if (!uuidSchema.safeParse(request.params.organizationId).success) return fail(response, 404, 'ORGANIZATION_NOT_FOUND', 'Organization was not found.');
    try {
      const target = await pool.query('SELECT business_type FROM organizations WHERE id = $1', [request.params.organizationId]);
      if (!target.rowCount) return fail(response, 404, 'ORGANIZATION_NOT_FOUND', 'Organization was not found.');
      if (request.auth.business_type === 'agency' || target.rows[0].business_type !== 'agency') return fail(response, 403, 'RATING_SUMMARY_FORBIDDEN', 'Seller access to agency ratings is required.');
      const result = await pool.query(
        `SELECT COUNT(*)::int AS count, ROUND(AVG(rating)::numeric, 2) AS average
         FROM organization_reviews WHERE reviewee_organization_id = $1 AND reviewer_organization_id IN
           (SELECT id FROM organizations WHERE business_type <> 'agency')`,
        [request.params.organizationId],
      );
      return response.json({ ratings: { count: result.rows[0].count, average: result.rows[0].average == null ? null : Number(result.rows[0].average) } });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/bookings/:awardId/disputes', async (request, response, next) => {
    const input = parseWith(disputeSchema, request.body);
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    try {
      const booking = await loadPartyBooking(pool, request.params.awardId, request.auth.organization_id);
      if (!booking) return fail(response, 404, 'BOOKING_NOT_FOUND', 'Booking was not found.');
      if (!booking.trip_complete) return fail(response, 409, 'DISPUTE_NOT_YET_AVAILABLE', 'A problem can be reported after the confirmed trip has ended.');
      const disputeId = randomUUID();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const created = await client.query(
          `INSERT INTO booking_disputes (id, award_id, opened_by_organization_id, opened_by_user_id, category, summary)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (award_id) DO NOTHING RETURNING *`,
          [disputeId, booking.id, request.auth.organization_id, request.auth.user_id, input.data.category, input.data.summary],
        );
        if (!created.rowCount) {
          await client.query('ROLLBACK');
          return fail(response, 409, 'DISPUTE_ALREADY_OPENED', 'A dispute already exists for this booking. Add evidence to its timeline.');
        }
        await client.query(
          `INSERT INTO booking_dispute_events (id, dispute_id, actor_organization_id, actor_user_id, event_type, message)
           VALUES ($1, $2, $3, $4, 'opened', $5), ($6, $2, $3, $4, 'evidence_added', $7)`,
          [randomUUID(), disputeId, request.auth.organization_id, request.auth.user_id, input.data.summary, randomUUID(), input.data.evidence],
        );
        const otherOrganizationId = booking.agency_organization_id === request.auth.organization_id ? booking.seller_organization_id : booking.agency_organization_id;
        await notify(client, otherOrganizationId, 'booking_dispute_opened', 'A booking problem was reported', `${booking.request_code} has a new dispute.`, { awardId: booking.id, disputeId });
        await client.query('COMMIT');
        return response.status(201).json({ dispute: disputeDto({ ...created.rows[0], timeline: [] }) });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      return next(error);
    }
  });

  router.post('/disputes/:disputeId/evidence', async (request, response, next) => {
    if (!uuidSchema.safeParse(request.params.disputeId).success) return fail(response, 404, 'DISPUTE_NOT_FOUND', 'Dispute was not found.');
    const input = parseWith(evidenceSchema, request.body);
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    try {
      const result = await pool.query(
        `INSERT INTO booking_dispute_events (id, dispute_id, actor_organization_id, actor_user_id, event_type, message)
         SELECT $1, d.id, $2, $3, 'evidence_added', $4 FROM booking_disputes d JOIN awards a ON a.id = d.award_id
         WHERE d.id = $5 AND d.status IN ('open', 'in_review') AND $2 IN (a.agency_organization_id, a.seller_organization_id)
         RETURNING id, event_type, message, created_at`,
        [randomUUID(), request.auth.organization_id, request.auth.user_id, input.data.evidence, request.params.disputeId],
      );
      if (!result.rowCount) return fail(response, 404, 'DISPUTE_NOT_FOUND', 'An active dispute for this booking was not found.');
      const other = await pool.query(
        `SELECT CASE WHEN d.opened_by_organization_id = $2 THEN a.seller_organization_id ELSE a.agency_organization_id END AS organization_id
         FROM booking_disputes d JOIN awards a ON a.id = d.award_id WHERE d.id = $1`,
        [request.params.disputeId, request.auth.organization_id],
      );
      if (other.rowCount) await notify(pool, other.rows[0].organization_id, 'booking_dispute_evidence', 'New dispute evidence', 'New evidence was added to a booking dispute.', { disputeId: request.params.disputeId });
      const row = result.rows[0];
      return response.status(201).json({ event: { id: row.id, type: row.event_type, message: row.message, createdAt: row.created_at } });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

export function registerDisputeAdminRoutes(router, pool) {
  router.get('/disputes', async (request, response, next) => {
    const status = typeof request.query.status === 'string' ? request.query.status : 'open';
    if (!['open', 'in_review', 'resolved', 'rejected', 'all'].includes(status)) return fail(response, 400, 'VALIDATION_ERROR', 'Choose a supported dispute status.');
    try {
      const result = await pool.query(
        `SELECT d.*, r.request_code, agency.name AS agency_name, seller.name AS seller_name,
                COALESCE(json_agg(json_build_object('id', e.id, 'type', e.event_type, 'message', e.message, 'createdAt', e.created_at)
                  ORDER BY e.created_at, e.id) FILTER (WHERE e.id IS NOT NULL), '[]'::json) AS timeline
         FROM booking_disputes d JOIN awards a ON a.id = d.award_id JOIN marketplace_requests r ON r.id = a.request_id
         JOIN organizations agency ON agency.id = a.agency_organization_id JOIN organizations seller ON seller.id = a.seller_organization_id
         LEFT JOIN booking_dispute_events e ON e.dispute_id = d.id
         WHERE ($1 = 'all' OR d.status = $1) GROUP BY d.id, r.request_code, agency.name, seller.name ORDER BY d.created_at`,
        [status],
      );
      return response.json({ disputes: result.rows.map((row) => ({ ...disputeDto(row), awardId: row.award_id, requestCode: row.request_code, agencyName: row.agency_name, sellerName: row.seller_name })) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/disputes/:disputeId/decision', requireCsrf, async (request, response, next) => {
    if (!uuidSchema.safeParse(request.params.disputeId).success) return fail(response, 404, 'DISPUTE_NOT_FOUND', 'Dispute was not found.');
    const input = parseWith(decisionSchema, request.body);
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    const { status, note } = input.data;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query(
            `UPDATE booking_disputes SET status = $2::varchar, resolution_note = CASE WHEN $2::varchar IN ('resolved', 'rejected') THEN $3::varchar ELSE NULL END,
              resolved_by_user_id = CASE WHEN $2::varchar IN ('resolved', 'rejected') THEN $4::uuid ELSE NULL END,
            resolved_at = CASE WHEN $2::varchar IN ('resolved', 'rejected') THEN NOW() ELSE NULL END, updated_at = NOW()
         WHERE id = $1 AND status IN ('open', 'in_review') RETURNING id, award_id, opened_by_organization_id`,
        [request.params.disputeId, status, note, request.auth.user_id],
      );
      if (!updated.rowCount) {
        await client.query('ROLLBACK');
        return fail(response, 404, 'DISPUTE_NOT_OPEN', 'An active dispute was not found.');
      }
      await client.query(
        `INSERT INTO booking_dispute_events (id, dispute_id, actor_user_id, event_type, message)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), request.params.disputeId, request.auth.user_id, status === 'in_review' ? 'status_changed' : 'resolved', note],
      );
      const parties = await client.query('SELECT agency_organization_id, seller_organization_id FROM awards WHERE id = $1', [updated.rows[0].award_id]);
      for (const organizationId of [parties.rows[0].agency_organization_id, parties.rows[0].seller_organization_id]) {
        await notify(client, organizationId, 'booking_dispute_updated', 'Booking dispute updated', `A dispute is now ${status.replace('_', ' ')}.`, { disputeId: request.params.disputeId, status });
      }
      await client.query('COMMIT');
      return response.json({ dispute: { id: updated.rows[0].id, status } });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });
}
