import { randomUUID } from 'node:crypto';

async function notify(client, organizationId, eventType, title, message, data) {
  await client.query(
    'INSERT INTO notifications (id, organization_id, event_type, title, message, data) VALUES ($1, $2, $3, $4, $5, $6)',
    [randomUUID(), organizationId, eventType, title, message, JSON.stringify(data)],
  );
}

// SQL predicate for organizations that may take part in the marketplace.
export const organizationIsActive = (alias) => `${alias}.suspended_at IS NULL AND ${alias}.closure_requested_at IS NULL`;

// Withdraws active offers and cancels open requests, notifying the counterparties.
export async function windDownMarketplaceActivity(client, organizationId, { offerNotice, requestNotice }) {
  const withdrawn = await client.query(
    `UPDATE offers f SET status = 'withdrawn', updated_at = NOW()
     FROM marketplace_requests r WHERE f.request_id = r.id AND f.seller_organization_id = $1
       AND f.status IN ('submitted', 'shortlisted') AND r.status IN ('open', 'closed')
     RETURNING f.id, r.id AS request_id, r.request_code, r.agency_organization_id`,
    [organizationId],
  );
  for (const offer of withdrawn.rows) {
    await notify(client, offer.agency_organization_id, 'offer_withdrawn', offerNotice.title, `${offer.request_code} / ${offerNotice.message}`, { offerId: offer.id, requestId: offer.request_id, requestCode: offer.request_code });
  }
  const cancelled = await client.query(
    `UPDATE marketplace_requests SET status = 'cancelled', closed_at = NOW(), updated_at = NOW()
     WHERE agency_organization_id = $1 AND status IN ('draft', 'open', 'closed') RETURNING id, request_code`,
    [organizationId],
  );
  for (const requestRow of cancelled.rows) {
    const sellers = await client.query('SELECT seller_organization_id FROM request_targets WHERE request_id = $1 AND declined_at IS NULL', [requestRow.id]);
    for (const seller of sellers.rows) {
      await notify(client, seller.seller_organization_id, 'request_cancelled', requestNotice.title, `${requestRow.request_code} / ${requestNotice.message}`, { requestId: requestRow.id, requestCode: requestRow.request_code });
    }
  }
  return { withdrawnOffers: withdrawn.rowCount, cancelledRequests: cancelled.rowCount };
}
