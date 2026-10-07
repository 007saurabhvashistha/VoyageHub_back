const isoDate = (value) => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export function parseAnalyticsRange(query) {
  const from = query.from ?? null;
  const to = query.to ?? null;
  if ((from && !isoDate(from)) || (to && !isoDate(to)) || (from && to && from > to)) {
    return { error: 'Use valid from/to dates in YYYY-MM-DD format, with from on or before to.' };
  }
  return { from, to };
}

function numberOrNull(value) {
  return value == null ? null : Number(value);
}

function minutesOrNull(value) {
  return value == null ? null : Number(Number(value).toFixed(1));
}

function jsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return []; }
  }
  return [];
}

export async function getAgencyReport(db, organizationId, range) {
  const result = await db.query(
    `WITH scoped_requests AS (
       SELECT id, published_at, budget_max_minor, budget_currency, nights, room_count
       FROM marketplace_requests
       WHERE agency_organization_id = $1 AND published_at IS NOT NULL AND status NOT IN ('draft', 'cancelled')
         AND ($2::date IS NULL OR published_at >= $2::date)
         AND ($3::date IS NULL OR published_at < $3::date + INTERVAL '1 day')
     ), first_responses AS (
       SELECT request.id, request.published_at, MIN(offer.created_at) AS first_offer_at, COUNT(offer.id) AS offer_count
       FROM scoped_requests request LEFT JOIN offers offer ON offer.request_id = request.id
       GROUP BY request.id, request.published_at
     ), award_prices AS (
       SELECT award.request_id, award.status, request.budget_max_minor, request.budget_currency, offer.currency,
         CASE WHEN award.offer_option_id IS NOT NULL
           THEN COALESCE(option.total_minor::numeric, option.rate_per_night_minor::numeric * request.nights * COALESCE(offer.room_count, request.room_count, 1))
           ELSE COALESCE(offer.total_minor::numeric, offer.rate_per_night_minor::numeric * request.nights * COALESCE(offer.room_count, request.room_count, 1))
         END AS awarded_minor
       FROM awards award
       JOIN scoped_requests request ON request.id = award.request_id
       JOIN offers offer ON offer.id = award.offer_id
       LEFT JOIN offer_options option ON option.id = award.offer_option_id
       WHERE award.agency_organization_id = $1
     ), request_award_totals AS (
       SELECT request_id, MAX(budget_max_minor) AS budget_max_minor, MAX(budget_currency) AS budget_currency,
              MIN(currency) AS currency, SUM(awarded_minor) AS awarded_minor,
              COUNT(DISTINCT currency) AS currency_count, COUNT(awarded_minor) AS priced_awards, COUNT(*) AS award_count
       FROM award_prices WHERE status <> 'cancelled' GROUP BY request_id
     ), savings AS (
       SELECT currency, SUM(budget_max_minor - awarded_minor)::text AS total_minor, COUNT(*) AS request_count
       FROM request_award_totals
       WHERE currency_count = 1 AND priced_awards = award_count AND budget_max_minor IS NOT NULL
         AND budget_currency = currency AND budget_max_minor > awarded_minor
       GROUP BY currency
     )
     SELECT
       (SELECT COUNT(*) FROM scoped_requests) AS requests_count,
       (SELECT COALESCE(SUM(offer_count), 0) FROM first_responses) AS offers_received,
       (SELECT COUNT(*) FROM first_responses WHERE first_offer_at IS NOT NULL) AS responded_requests,
       (SELECT AVG(EXTRACT(EPOCH FROM (first_offer_at - published_at)) / 60)
        FROM first_responses WHERE first_offer_at IS NOT NULL AND published_at IS NOT NULL) AS response_time_minutes,
       (SELECT COUNT(DISTINCT request_id) FROM award_prices WHERE status <> 'cancelled') AS awarded_requests,
       (SELECT COALESCE(json_agg(json_build_object('currency', currency, 'totalMinor', total_minor, 'requestCount', request_count) ORDER BY currency), '[]'::json) FROM savings) AS savings_by_currency`,
    [organizationId, range.from, range.to],
  );
  const row = result.rows[0];
  const requestsCount = Number(row.requests_count);
  const awardedRequests = Number(row.awarded_requests);
  return {
    requestsCount,
    offersReceived: Number(row.offers_received),
    respondedRequests: Number(row.responded_requests),
    awardRatePercent: requestsCount ? Number((awardedRequests / requestsCount * 100).toFixed(2)) : null,
    responseTimeMinutes: minutesOrNull(row.response_time_minutes),
    savingsByCurrency: jsonArray(row.savings_by_currency),
  };
}

export async function getSellerPerformance(db, organizationId, range) {
  const result = await db.query(
    `WITH scoped_offers AS (
       SELECT offer.id, offer.status, offer.outcome_reason, offer.created_at, request.published_at
       FROM offers offer JOIN marketplace_requests request ON request.id = offer.request_id
       WHERE offer.seller_organization_id = $1 AND request.published_at IS NOT NULL
         AND ($2::date IS NULL OR offer.created_at >= $2::date)
         AND ($3::date IS NULL OR offer.created_at < $3::date + INTERVAL '1 day')
     ), lost_reasons AS (
       SELECT COALESCE(NULLIF(BTRIM(outcome_reason), ''), 'No reason provided') AS reason, COUNT(*) AS offer_count
       FROM scoped_offers WHERE status = 'rejected'
       GROUP BY COALESCE(NULLIF(BTRIM(outcome_reason), ''), 'No reason provided')
     ), review_summary AS (
       SELECT AVG(rating) AS average_rating, COUNT(*) AS rating_count
       FROM organization_reviews
       WHERE reviewee_organization_id = $1
         AND ($2::date IS NULL OR created_at >= $2::date)
         AND ($3::date IS NULL OR created_at < $3::date + INTERVAL '1 day')
     )
     SELECT
       COUNT(*) FILTER (WHERE status IN ('accepted', 'rejected')) AS decided_offers,
       COUNT(*) FILTER (WHERE status = 'accepted') AS wins,
       AVG(EXTRACT(EPOCH FROM (created_at - published_at)) / 60) AS response_time_minutes,
       (SELECT average_rating FROM review_summary) AS average_rating,
       (SELECT rating_count FROM review_summary) AS rating_count,
       COALESCE((SELECT json_agg(json_build_object('reason', reason, 'count', offer_count) ORDER BY offer_count DESC, reason)
                 FROM lost_reasons), '[]'::json) AS lost_reasons
     FROM scoped_offers`,
    [organizationId, range.from, range.to],
  );
  const row = result.rows[0];
  const decidedOffers = Number(row.decided_offers);
  const wins = Number(row.wins);
  return {
    decidedOffers,
    wins,
    winRatePercent: decidedOffers ? Number((wins / decidedOffers * 100).toFixed(2)) : null,
    responseTimeMinutes: minutesOrNull(row.response_time_minutes),
    averageRating: numberOrNull(row.average_rating),
    ratingCount: Number(row.rating_count),
    lostReasons: jsonArray(row.lost_reasons),
  };
}

export async function getMarketplaceDashboard(db, range) {
  const result = await db.query(
    `WITH scoped_requests AS (
       SELECT id, published_at FROM marketplace_requests
       WHERE published_at IS NOT NULL AND status NOT IN ('draft', 'cancelled')
         AND ($1::date IS NULL OR published_at >= $1::date)
         AND ($2::date IS NULL OR published_at < $2::date + INTERVAL '1 day')
     ), responses AS (
       SELECT request.id, request.published_at, MIN(offer.created_at) AS first_offer_at, COUNT(offer.id) AS offer_count
       FROM scoped_requests request LEFT JOIN offers offer ON offer.request_id = request.id
       GROUP BY request.id, request.published_at
     ), award_summary AS (
       SELECT COUNT(DISTINCT award.request_id) FILTER (WHERE award.status <> 'cancelled') AS awarded_requests
       FROM awards award JOIN scoped_requests request ON request.id = award.request_id
     ), booking_summary AS (
       SELECT COUNT(*) FILTER (WHERE status = 'booked') AS booked_awards,
              COUNT(*) FILTER (WHERE status IN ('awarded', 'confirmation_pending', 'booked')) AS eligible_awards
       FROM awards
       WHERE ($1::date IS NULL OR created_at >= $1::date)
         AND ($2::date IS NULL OR created_at < $2::date + INTERVAL '1 day')
     )
     SELECT
       (SELECT COUNT(*) FROM scoped_requests) AS published_requests,
       (SELECT COALESCE(SUM(offer_count), 0) FROM responses) AS offers_received,
       (SELECT AVG(offer_count) FROM responses) AS average_offers_per_request,
       (SELECT AVG(EXTRACT(EPOCH FROM (first_offer_at - published_at)) / 60)
        FROM responses WHERE first_offer_at IS NOT NULL) AS response_time_minutes,
       (SELECT awarded_requests FROM award_summary) AS awarded_requests,
       (SELECT booked_awards FROM booking_summary) AS booked_awards,
       (SELECT eligible_awards FROM booking_summary) AS eligible_awards`,
    [range.from, range.to],
  );
  const row = result.rows[0];
  const publishedRequests = Number(row.published_requests);
  const awardedRequests = Number(row.awarded_requests);
  const bookedAwards = Number(row.booked_awards);
  const eligibleAwards = Number(row.eligible_awards);
  return {
    publishedRequests,
    offersReceived: Number(row.offers_received),
    averageOffersPerRequest: numberOrNull(row.average_offers_per_request),
    awardRatePercent: publishedRequests ? Number((awardedRequests / publishedRequests * 100).toFixed(2)) : null,
    responseTimeMinutes: minutesOrNull(row.response_time_minutes),
    awardedRequests,
    bookedAwards,
    bookingConversionPercent: eligibleAwards ? Number((bookedAwards / eligibleAwards * 100).toFixed(2)) : null,
  };
}