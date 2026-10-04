// Closed requests stay visible to sellers whose offer is still under review; awarded ones only to the winner.
export const sellerCanSeeRequest = `(r.status = 'open'
  OR (r.status = 'closed' AND EXISTS (SELECT 1 FROM offers own WHERE own.request_id = r.id
    AND own.seller_organization_id = t.seller_organization_id AND own.status IN ('submitted', 'shortlisted')))
  OR (r.status = 'awarded' AND EXISTS (SELECT 1 FROM awards a WHERE a.request_id = r.id
    AND a.seller_organization_id = t.seller_organization_id)))`;

// The agency-seller thread on one request, if the caller is one of the two parties and the seller may still see it.
export async function findConversation(db, { requestId, sellerOrganizationId, organizationId, lock = false }) {
  const result = await db.query(
    `SELECT r.request_code, r.agency_organization_id, r.status,
            seller.id AS seller_organization_id, seller.name AS seller_name, agency.name AS agency_name
     FROM marketplace_requests r
     JOIN request_targets t ON t.request_id = r.id AND t.seller_organization_id = $2 AND t.declined_at IS NULL
     JOIN organizations seller ON seller.id = t.seller_organization_id
     JOIN organizations agency ON agency.id = r.agency_organization_id
     WHERE r.id = $1
       AND ($3 = r.agency_organization_id OR $3 = t.seller_organization_id)
       AND ${sellerCanSeeRequest}${lock ? ' FOR UPDATE OF r' : ''}`,
    [requestId, sellerOrganizationId, organizationId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const agencyIsCaller = organizationId === row.agency_organization_id;
  return {
    ...row,
    agencyIsCaller,
    peerOrganizationId: agencyIsCaller ? row.seller_organization_id : row.agency_organization_id,
    callerName: agencyIsCaller ? row.agency_name : row.seller_name,
    peerName: agencyIsCaller ? row.seller_name : row.agency_name,
  };
}
