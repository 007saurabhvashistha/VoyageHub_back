import { randomUUID } from 'node:crypto';
import { audienceFor } from '../config/referenceData.js';
import { organizationIsActive } from './organizationLifecycle.js';
import { getSetting } from './platformSettings.js';

// Marks targets that the router (not the seller) removed, so a later re-route may restore them.
export const routingDeclinePrefix = 'Routing:';
const activeOfferStatuses = ['submitted', 'shortlisted', 'accepted'];

export async function notify(db, organizationId, eventType, title, message, data) {
  await db.query(
    'INSERT INTO notifications (id, organization_id, event_type, title, message, data) VALUES ($1, $2, $3, $4, $5, $6)',
    [randomUUID(), organizationId, eventType, title, message, JSON.stringify(data)],
  );
}

export async function loadRequestStops(db, requestId) {
  const result = await db.query(
    `SELECT rd.sequence, rd.destination_id, rd.nights, d.name, d.kind
     FROM request_destinations rd JOIN destinations d ON d.id = rd.destination_id
     WHERE rd.request_id = $1 ORDER BY rd.sequence`,
    [requestId],
  );
  return result.rows;
}

export async function loadRoutingRequest(db, requestId) {
  const result = await db.query(
      `SELECT id, request_code, agency_organization_id, requirement_type, hotel_category, visibility, nights,
            destination, status, response_deadline, group_type, adults, children, infants,
          budget_min_minor, budget_max_minor, budget_currency, travel_start_date, travel_end_date, room_count,
          seller_visible_snapshot
     FROM marketplace_requests WHERE id = $1`,
    [requestId],
  );
  if (!result.rowCount) return null;
  return { ...result.rows[0], stops: await loadRequestStops(db, requestId) };
}

export const routeLabel = (stops) => stops.map((stop) => stop.nights ? `${stop.name} ${stop.nights}N` : stop.name).join(' → ');

const eligibleSeller = (audienceParam) => `seller.business_type = ${audienceParam}
  AND profile.verification_status = 'approved' AND profile.accepting_requests AND ${organizationIsActive('seller')}
  AND ($2::uuid IS NULL OR seller.id <> $2)
  AND ($3::uuid[] IS NULL OR seller.id = ANY($3::uuid[]))`;

// Hotels match when an approved, active property sits at the requested destination or anywhere inside it.
async function hotelAudience(db, { destinationIds, hotelCategory, excludeOrganizationId, sellerIds, audience, travelStartDate, travelEndDate, roomCount }) {
  const result = await db.query(
    `SELECT hp.organization_id AS seller_organization_id, 'full' AS match_type,
            array_agg(hp.id ORDER BY hp.name, hp.id) AS matching_property_ids
     FROM hotel_properties hp
     JOIN destinations located ON located.id = hp.destination_id
     JOIN organizations seller ON seller.id = hp.organization_id
     JOIN seller_profiles profile ON profile.organization_id = seller.id
     WHERE hp.active AND hp.verification_status = 'approved'
       AND ${eligibleSeller('$5')}
       AND located.match_path @> $1::uuid[]
       AND ($4::smallint IS NULL OR hp.star_category IS NULL OR hp.star_category = $4)
       AND ($6::date IS NULL OR NOT EXISTS (SELECT 1 FROM hotel_room_inventory configured WHERE configured.organization_id = seller.id)
         OR (SELECT COUNT(DISTINCT inventory.inventory_date) FROM hotel_room_inventory inventory
             WHERE inventory.organization_id = seller.id AND inventory.inventory_date >= $6::date AND inventory.inventory_date < $7::date
               AND inventory.available_rooms >= COALESCE($8::smallint, 1)) = ($7::date - $6::date))
     GROUP BY hp.organization_id`,
    [destinationIds.slice(0, 1), excludeOrganizationId, sellerIds, hotelCategory, audience, travelStartDate, travelEndDate, roomCount],
  );
  return result.rows;
}

// DMCs match when coverage overlaps any stop in either direction; "full" needs every stop covered from above.
// The most specific rule (deepest destination) applying to a stop decides include vs exclude.
async function dmcAudience(db, { destinationIds, excludeOrganizationId, sellerIds, audience, groupType, groupSize, budgetMinMinor, budgetMaxMinor, budgetCurrency }) {
  const result = await db.query(
    `WITH stops AS (
       SELECT d.id AS destination_id, d.match_path FROM destinations d WHERE d.id = ANY($1::uuid[])
     ), candidates AS (
       SELECT seller.id FROM organizations seller
       JOIN seller_profiles profile ON profile.organization_id = seller.id
       WHERE ${eligibleSeller('$4')}
         AND (cardinality(profile.handled_group_types) = 0 OR $5::text IS NULL OR $5 = ANY(profile.handled_group_types))
         AND (profile.minimum_group_size IS NULL OR $6::integer >= profile.minimum_group_size)
         AND ($7::bigint IS NULL OR profile.budget_min_minor IS NULL OR profile.budget_currency IS DISTINCT FROM $9
           OR (profile.budget_min_minor <= $8 AND profile.budget_max_minor >= $7))
         AND EXISTS (
           SELECT 1 FROM seller_coverage c JOIN destinations cd ON cd.id = c.destination_id CROSS JOIN stops s
           WHERE c.organization_id = seller.id AND c.mode = 'include'
             AND (c.destination_id = ANY(s.match_path) OR cd.match_path @> ARRAY[s.destination_id]))
     ), stop_status AS (
       SELECT candidate.id AS seller_id, s.destination_id,
         (SELECT c.mode FROM seller_coverage c JOIN destinations cd ON cd.id = c.destination_id
          WHERE c.organization_id = candidate.id AND c.destination_id = ANY(s.match_path)
          ORDER BY cardinality(cd.path) DESC, (c.mode = 'exclude') DESC LIMIT 1) AS ancestor_mode,
         EXISTS (SELECT 1 FROM seller_coverage c JOIN destinations cd ON cd.id = c.destination_id
          WHERE c.organization_id = candidate.id AND c.mode = 'include' AND c.destination_id <> s.destination_id
            AND cd.match_path @> ARRAY[s.destination_id]) AS includes_inside,
         EXISTS (SELECT 1 FROM seller_coverage c JOIN destinations cd ON cd.id = c.destination_id
          WHERE c.organization_id = candidate.id AND c.mode = 'exclude' AND c.destination_id <> s.destination_id
            AND cd.match_path @> ARRAY[s.destination_id]) AS excludes_inside
       FROM candidates candidate CROSS JOIN stops s
     )
     SELECT seller_id AS seller_organization_id,
       CASE WHEN bool_and(COALESCE(ancestor_mode = 'include', FALSE) AND NOT excludes_inside) THEN 'full' ELSE 'partial' END AS match_type,
       ARRAY[]::uuid[] AS matching_property_ids
     FROM stop_status GROUP BY seller_id
     HAVING bool_or(COALESCE(ancestor_mode = 'include', FALSE) OR includes_inside)`,
    [destinationIds, excludeOrganizationId, sellerIds, audience, groupType, groupSize, budgetMinMinor, budgetMaxMinor, budgetCurrency],
  );
  return result.rows;
}

// Sellers that may see a lead with these facts. Rule 0: only the requirement type's audience is ever considered.
export async function findAudience(db, { requirementType, destinationIds, hotelCategory = null, excludeOrganizationId = null, sellerIds = null,
  groupType = null, groupSize = null, budgetMinMinor = null, budgetMaxMinor = null, budgetCurrency = null,
  travelStartDate = null, travelEndDate = null, roomCount = null }) {
  const audience = audienceFor(requirementType);
  if (!audience || !destinationIds.length) return [];
  const input = { destinationIds, hotelCategory, excludeOrganizationId, sellerIds: sellerIds?.length ? sellerIds : null, audience,
    groupType, groupSize, budgetMinMinor, budgetMaxMinor, budgetCurrency, travelStartDate, travelEndDate, roomCount };
  const rows = audience === 'hotelier' ? await hotelAudience(db, input) : await dmcAudience(db, input);
  return rows.map((row) => ({ ...row, business_type: audience }));
}

// Invited sellers still pass Rule 0; hotels list whichever of their properties match the destination.
async function invitedAudience(db, request) {
  const audience = audienceFor(request.requirement_type);
  const result = await db.query(
    `SELECT seller.id AS seller_organization_id FROM request_invitations invitation
     JOIN organizations seller ON seller.id = invitation.seller_organization_id
     JOIN seller_profiles profile ON profile.organization_id = seller.id
     WHERE invitation.request_id = $1 AND seller.business_type = $2
       AND profile.verification_status = 'approved' AND profile.accepting_requests AND ${organizationIsActive('seller')}`,
    [request.id, audience],
  );
  return result.rows.map((row) => row.seller_organization_id);
}

export async function computeTargets(db, request, { sellerIds = null } = {}) {
  const destinationIds = request.stops.map((stop) => stop.destination_id);
  const byId = new Map();
  if (['open', 'open_and_invite'].includes(request.visibility)) {
    const matched = await findAudience(db, {
      requirementType: request.requirement_type, destinationIds, hotelCategory: request.hotel_category,
      excludeOrganizationId: request.agency_organization_id, sellerIds,
      groupType: request.group_type, groupSize: Number(request.adults ?? 0) + Number(request.children ?? 0) + Number(request.infants ?? 0),
      budgetMinMinor: request.budget_min_minor == null ? null : Number(request.budget_min_minor),
      budgetMaxMinor: request.budget_max_minor == null ? null : Number(request.budget_max_minor),
      budgetCurrency: request.budget_currency, travelStartDate: request.travel_start_date,
      travelEndDate: request.travel_end_date, roomCount: request.room_count,
    });
    for (const row of matched) byId.set(row.seller_organization_id, row);
  }
  if (['invite_only', 'open_and_invite'].includes(request.visibility)) {
    const invited = (await invitedAudience(db, request)).filter((id) => !sellerIds || sellerIds.includes(id));
    const missing = invited.filter((id) => !byId.has(id));
    const hotelMatches = audienceFor(request.requirement_type) === 'hotelier' && missing.length
      ? await findAudience(db, { requirementType: request.requirement_type, destinationIds, excludeOrganizationId: request.agency_organization_id, sellerIds: missing })
      : [];
    for (const id of missing) {
      const hotel = hotelMatches.find((row) => row.seller_organization_id === id);
      byId.set(id, { seller_organization_id: id, match_type: 'invited', matching_property_ids: hotel?.matching_property_ids ?? [], business_type: audienceFor(request.requirement_type) });
    }
  }
  return [...byId.values()];
}

async function loadAlertPreferences(db, sellerIds) {
  if (!sellerIds.length) return new Map();
  const result = await db.query('SELECT * FROM seller_alert_preferences WHERE organization_id = ANY($1::uuid[])', [sellerIds]);
  return new Map(result.rows.map((row) => [row.organization_id, row]));
}

const matchOrder = { invited: 0, full: 1, partial: 2 };

async function enqueueMatchWebhook(db, organizationId, request, target, { title, message }) {
  const messageId = `msg_${randomUUID().replaceAll('-', '')}`;
  const data = {
    requestId: request.id,
    requestCode: request.request_code,
    destination: request.destination,
    requirementType: request.requirement_type,
    matchType: target.match_type,
    matchingPropertyIds: target.matching_property_ids,
    leadSnapshot: request.seller_visible_snapshot,
  };
  const endpoints = await db.query(
    `SELECT id FROM webhook_endpoints
     WHERE organization_id = $1 AND status = 'active' AND 'request_matched' = ANY(event_types)`,
    [organizationId],
  );
  const payload = JSON.stringify({
    type: 'request_matched',
    timestamp: new Date().toISOString(),
    data: { ...data, organizationId, title, message },
  });
  for (const endpoint of endpoints.rows) {
    await db.query(
      `INSERT INTO webhook_deliveries (endpoint_id, organization_id, event_type, message_id, payload)
       VALUES ($1, $2, 'request_matched', $3, $4::jsonb)
       ON CONFLICT (endpoint_id, message_id) DO NOTHING`,
      [endpoint.id, organizationId, messageId, payload],
    );
  }
}

// In-app alerts follow seller preferences (invitations stay instant); subscribed CRM webhooks receive every match.
export async function deliverMatchAlerts(db, request, targets) {
  const pending = targets.filter((target) => !target.alerted_at);
  if (!pending.length) return { instant: 0, digest: 0, skipped: 0 };
  const preferences = await loadAlertPreferences(db, pending.map((target) => target.seller_organization_id));
  const cap = await getSetting(db, 'max_instant_alerts_per_request');
  const already = await db.query('SELECT COUNT(*) AS total FROM request_targets WHERE request_id = $1 AND alerted_at IS NOT NULL AND match_type IS DISTINCT FROM \'invited\'', [request.id]);
  let instantCount = Number(already.rows[0].total);
  const stopKinds = new Set(request.stops.map((stop) => stop.kind));
  const label = routeLabel(request.stops) || request.destination;
  const counts = { instant: 0, digest: 0, skipped: 0 };
  const ordered = [...pending].sort((left, right) => (matchOrder[left.match_type] ?? 3) - (matchOrder[right.match_type] ?? 3));
  for (const target of ordered) {
    const preference = preferences.get(target.seller_organization_id);
    const invited = target.match_type === 'invited';
    let delivery = invited ? 'instant' : preference?.delivery ?? 'instant';
    if (!invited && preference) {
      if (preference.destination_kinds?.length && !preference.destination_kinds.some((kind) => stopKinds.has(kind))) delivery = 'off';
      if (target.match_type === 'partial' && !preference.include_partial) delivery = 'off';
      if (preference.property_ids?.length && !target.matching_property_ids.some((id) => preference.property_ids.includes(id))) delivery = 'off';
    }
    if (delivery === 'instant' && !invited && instantCount >= cap) delivery = 'digest';
    if (delivery === 'instant') {
      await notify(db, target.seller_organization_id, 'request_matched', invited ? 'You were invited to a request' : 'New matching request',
        `${request.request_code} / ${label} / ${request.nights} nights`,
        { requestId: request.id, requestCode: request.request_code, destination: request.destination, requirementType: request.requirement_type, matchType: target.match_type, matchingPropertyIds: target.matching_property_ids, leadSnapshot: request.seller_visible_snapshot });
      if (!invited) instantCount += 1;
      counts.instant += 1;
    } else {
      await enqueueMatchWebhook(db, target.seller_organization_id, request, target, {
        title: invited ? 'You were invited to a request' : 'New matching request',
        message: `${request.request_code} / ${label} / ${request.nights} nights`,
      });
      if (delivery === 'digest') {
        await db.query('INSERT INTO alert_digest_items (organization_id, request_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [target.seller_organization_id, request.id]);
        counts.digest += 1;
      } else {
        counts.skipped += 1;
      }
    }
    await db.query('UPDATE request_targets SET alerted_at = NOW() WHERE request_id = $1 AND seller_organization_id = $2', [request.id, target.seller_organization_id]);
  }
  return counts;
}

async function upsertTarget(db, requestId, target) {
  const result = await db.query(
    `INSERT INTO request_targets (request_id, seller_organization_id, match_type, matching_property_ids)
     VALUES ($1, $2, $3, $4::uuid[])
     ON CONFLICT (request_id, seller_organization_id) DO UPDATE SET
       match_type = EXCLUDED.match_type, matching_property_ids = EXCLUDED.matching_property_ids,
       declined_at = NULL, decline_reason = NULL, matched_at = NOW(), alerted_at = NULL
     WHERE request_targets.declined_at IS NOT NULL AND request_targets.decline_reason LIKE $5
     RETURNING request_id, seller_organization_id, match_type, matching_property_ids, alerted_at`,
    [requestId, target.seller_organization_id, target.match_type, target.matching_property_ids, `${routingDeclinePrefix}%`],
  );
  return result.rows[0] ?? null;
}

// Initial targeting at publish time; returns inserted targets and alert counts.
export async function targetPublishedRequest(db, requestId) {
  const request = await loadRoutingRequest(db, requestId);
  const targets = await computeTargets(db, request);
  const inserted = [];
  for (const target of targets) {
    const row = await upsertTarget(db, requestId, target);
    if (row) inserted.push(row);
  }
  const alerts = await deliverMatchAlerts(db, request, inserted);
  return { targets: inserted, alerts };
}

async function withdrawOffers(db, request, sellerId, reason) {
  const withdrawn = await db.query(
    `UPDATE offers SET status = 'withdrawn', outcome_reason = $3, updated_at = NOW()
     WHERE request_id = $1 AND seller_organization_id = $2 AND status IN ('submitted', 'shortlisted') RETURNING id`,
    [request.id, sellerId, reason],
  );
  for (const offer of withdrawn.rows) {
    await notify(db, request.agency_organization_id, 'offer_withdrawn', 'Offer withdrawn by lead routing', `${request.request_code} / ${reason}`, { requestId: request.id, requestCode: request.request_code, offerId: offer.id });
  }
  return withdrawn.rowCount;
}

async function declineTarget(db, request, sellerId, reason) {
  await db.query(
    'UPDATE request_targets SET declined_at = NOW(), decline_reason = $3 WHERE request_id = $1 AND seller_organization_id = $2 AND declined_at IS NULL',
    [request.id, sellerId, `${routingDeclinePrefix} ${reason}`.slice(0, 300)],
  );
  await notify(db, sellerId, 'request_no_longer_available', 'Request no longer in your area', `${request.request_code} / ${reason}`, { requestId: request.id, requestCode: request.request_code });
}

// Re-applies routing to an open request after its destinations change (or at launch).
// Rule 0 violators always lose access; same-audience sellers keep access while they hold an active offer or invitation.
export async function rerouteRequest(db, requestId, { removalReason = 'The agency changed the destination of this lead.', alertNew = true } = {}) {
  const request = await loadRoutingRequest(db, requestId);
  const audience = audienceFor(request.requirement_type);
  const computed = new Map((await computeTargets(db, request)).map((row) => [row.seller_organization_id, row]));
  const existing = await db.query(
    `SELECT t.seller_organization_id, t.match_type, t.matching_property_ids, t.alerted_at, seller.business_type,
            EXISTS (SELECT 1 FROM offers f WHERE f.request_id = t.request_id AND f.seller_organization_id = t.seller_organization_id
              AND f.status = ANY($2::text[])) AS has_offer,
            EXISTS (SELECT 1 FROM request_invitations i WHERE i.request_id = t.request_id AND i.seller_organization_id = t.seller_organization_id) AS invited,
            EXISTS (SELECT 1 FROM awards a WHERE a.request_id = t.request_id AND a.seller_organization_id = t.seller_organization_id) AS awarded
     FROM request_targets t JOIN organizations seller ON seller.id = t.seller_organization_id
     WHERE t.request_id = $1 AND t.declined_at IS NULL`,
    [requestId, activeOfferStatuses],
  );
  const summary = { stillMatching: [], newlyMatched: [], removed: [], withdrawnOffers: 0, grandfathered: [] };
  for (const row of existing.rows) {
    const match = computed.get(row.seller_organization_id);
    if (row.business_type !== audience) {
      if (row.awarded) continue;
      summary.withdrawnOffers += await withdrawOffers(db, request, row.seller_organization_id, 'This lead is not for your business type.');
      await declineTarget(db, request, row.seller_organization_id, 'This lead is not for your business type.');
      summary.removed.push(row.seller_organization_id);
    } else if (match) {
      await db.query(
        'UPDATE request_targets SET match_type = $3, matching_property_ids = $4::uuid[] WHERE request_id = $1 AND seller_organization_id = $2',
        [requestId, row.seller_organization_id, match.match_type, match.matching_property_ids],
      );
      summary.stillMatching.push(row.seller_organization_id);
    } else if (row.has_offer || row.invited || row.awarded) {
      summary.grandfathered.push(row.seller_organization_id);
      summary.stillMatching.push(row.seller_organization_id);
    } else {
      await declineTarget(db, request, row.seller_organization_id, removalReason);
      summary.removed.push(row.seller_organization_id);
    }
    computed.delete(row.seller_organization_id);
  }
  const inserted = [];
  for (const target of computed.values()) {
    const row = await upsertTarget(db, requestId, target);
    if (row) inserted.push(row);
  }
  summary.newlyMatched = inserted.map((row) => row.seller_organization_id);
  if (alertNew) {
    summary.alerts = await deliverMatchAlerts(db, request, inserted);
  } else {
    await db.query('UPDATE request_targets SET alerted_at = NOW() WHERE request_id = $1 AND seller_organization_id = ANY($2::uuid[])', [requestId, summary.newlyMatched]);
  }
  return summary;
}

async function openRequestIds(db) {
  const result = await db.query("SELECT id FROM marketplace_requests WHERE status = 'open' AND response_deadline > NOW() ORDER BY published_at");
  return result.rows.map((row) => row.id);
}

// After a seller is approved or gains area, adds it to matching open requests with one summary notification.
export async function retargetSeller(db, sellerId) {
  const added = [];
  for (const requestId of await openRequestIds(db)) {
    const request = await loadRoutingRequest(db, requestId);
    const [target] = await computeTargets(db, request, { sellerIds: [sellerId] });
    if (!target) continue;
    const row = await upsertTarget(db, requestId, target);
    if (row) {
      added.push(request);
      await db.query('UPDATE request_targets SET alerted_at = NOW() WHERE request_id = $1 AND seller_organization_id = $2', [requestId, sellerId]);
    } else {
      await db.query(
        'UPDATE request_targets SET match_type = $3, matching_property_ids = $4::uuid[] WHERE request_id = $1 AND seller_organization_id = $2 AND declined_at IS NULL',
        [requestId, sellerId, target.match_type, target.matching_property_ids],
      );
    }
  }
  if (added.length) {
    await notify(db, sellerId, 'request_matched_digest', `${added.length} open lead${added.length === 1 ? '' : 's'} match your area`,
      added.slice(0, 10).map((request) => `${request.request_code} / ${routeLabel(request.stops) || request.destination}`).join('\n'),
      { requestIds: added.map((request) => request.id), requestCodes: added.map((request) => request.request_code) });
  }
  return added.length;
}

// After a seller loses area (hotel deactivated or moved), removes it from open requests it no longer matches.
export async function pruneSellerTargets(db, sellerId, reason) {
  const result = await db.query(
    `SELECT t.request_id FROM request_targets t JOIN marketplace_requests r ON r.id = t.request_id
     WHERE t.seller_organization_id = $1 AND t.declined_at IS NULL AND r.status = 'open'`,
    [sellerId],
  );
  let removed = 0;
  for (const { request_id: requestId } of result.rows) {
    const request = await loadRoutingRequest(db, requestId);
    const [target] = await computeTargets(db, request, { sellerIds: [sellerId] });
    if (target) {
      await db.query(
        'UPDATE request_targets SET match_type = $3, matching_property_ids = $4::uuid[] WHERE request_id = $1 AND seller_organization_id = $2',
        [requestId, sellerId, target.match_type, target.matching_property_ids],
      );
      continue;
    }
    const keep = await db.query(
      `SELECT EXISTS (SELECT 1 FROM offers WHERE request_id = $1 AND seller_organization_id = $2 AND status = ANY($3::text[])) AS has_offer`,
      [requestId, sellerId, activeOfferStatuses],
    );
    if (keep.rows[0].has_offer) continue;
    await declineTarget(db, request, sellerId, reason);
    removed += 1;
  }
  return removed;
}

// Launch handling for leads that were open before destination routing existed; idempotent.
export async function launchRouting(db, { now = new Date(), minimumAlertHours = 1 } = {}) {
  const report = { requestsChecked: 0, resolvedDestinations: 0, unresolvedNotified: 0, removedTargets: 0, withdrawnOffers: 0, newlyMatched: 0, grandfathered: 0 };
  const unresolved = await db.query(
    `SELECT id, request_code, destination, destination_country, agency_organization_id, unresolved_notified_at
     FROM marketplace_requests WHERE destination_unresolved AND status IN ('draft', 'open')`,
  );
  for (const row of unresolved.rows) {
    const match = await db.query(
      `SELECT id, name, country_code FROM destinations
       WHERE active AND country_code = $2 AND (search_name = lower($1) OR lower($1) = ANY(aliases))
       ORDER BY featured DESC, population DESC NULLS LAST LIMIT 2`,
      [row.destination, row.destination_country],
    );
    if (match.rowCount === 1) {
      await db.query('UPDATE marketplace_requests SET destination_id = $2, destination_unresolved = FALSE, updated_at = NOW() WHERE id = $1', [row.id, match.rows[0].id]);
      await db.query('INSERT INTO request_destinations (request_id, sequence, destination_id) VALUES ($1, 1, $2) ON CONFLICT DO NOTHING', [row.id, match.rows[0].id]);
      report.resolvedDestinations += 1;
    } else if (!row.unresolved_notified_at) {
      await notify(db, row.agency_organization_id, 'request_destination_unresolved', 'Pick a destination for your lead',
        `${row.request_code} / Pick a destination from the list so sellers can find this lead.`, { requestId: row.id, requestCode: row.request_code });
      await db.query('UPDATE marketplace_requests SET unresolved_notified_at = $2 WHERE id = $1', [row.id, now]);
      report.unresolvedNotified += 1;
    }
  }
  const minimumDeadline = new Date(now.getTime() + minimumAlertHours * 3600000);
  const open = await db.query(
    `SELECT id, response_deadline FROM marketplace_requests r
     WHERE status = 'open' AND NOT destination_unresolved AND EXISTS (SELECT 1 FROM request_destinations rd WHERE rd.request_id = r.id)`,
  );
  for (const row of open.rows) {
    report.requestsChecked += 1;
    const result = await rerouteRequest(db, row.id, {
      removalReason: 'Lead routing now uses destinations and lead type; this lead is outside your area.',
      alertNew: new Date(row.response_deadline) > minimumDeadline,
    });
    report.removedTargets += result.removed.length;
    report.withdrawnOffers += result.withdrawnOffers;
    report.newlyMatched += result.newlyMatched.length;
    report.grandfathered += result.grandfathered.length;
  }
  return report;
}
