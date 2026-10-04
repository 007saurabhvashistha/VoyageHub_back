import { legalDocumentTypes } from '../config/referenceData.js';

const acceptanceByType = new Map(legalDocumentTypes.map((type) => [type.value, type.acceptance]));

export function documentRequiredFor(documentType, accessRole) {
  const acceptance = acceptanceByType.get(documentType);
  return acceptance === 'all_members' || (acceptance === 'organization_owner' && accessRole === 'owner');
}

export function legalDocumentDto(row, { includeBody = false } = {}) {
  return {
    id: row.id,
    type: row.document_type,
    version: row.version,
    title: row.title,
    changeSummary: row.change_summary ?? null,
    publishedAt: row.published_at,
    ...(includeBody ? { body: row.body } : {}),
  };
}

export async function currentLegalDocuments(db, { includeBody = false } = {}) {
  const result = await db.query(
    `SELECT DISTINCT ON (document_type) id, document_type, version, title, change_summary, published_at${includeBody ? ', body' : ''}
     FROM legal_documents ORDER BY document_type, version DESC`,
  );
  return result.rows;
}

export async function pendingLegalDocuments(db, userId, accessRole) {
  const current = await currentLegalDocuments(db);
  const required = current.filter((row) => documentRequiredFor(row.document_type, accessRole));
  if (!required.length) return [];
  const accepted = await db.query(
    'SELECT document_id FROM legal_acceptances WHERE user_id = $1 AND document_id = ANY($2::uuid[])',
    [userId, required.map((row) => row.id)],
  );
  const acceptedIds = new Set(accepted.rows.map((row) => row.document_id));
  return required.filter((row) => !acceptedIds.has(row.id));
}

// Returns the current documents the user must accept that are missing from acceptedIds.
export async function missingAcceptances(db, acceptedIds, accessRole) {
  const accepted = new Set(acceptedIds);
  const current = await currentLegalDocuments(db);
  return current.filter((row) => documentRequiredFor(row.document_type, accessRole) && !accepted.has(row.id));
}

export async function recordAcceptances(client, { userId, organizationId, documentIds }) {
  if (!documentIds.length) return;
  await client.query(
    `INSERT INTO legal_acceptances (user_id, document_id, organization_id)
     SELECT $1, id, $2 FROM legal_documents WHERE id = ANY($3::uuid[])
     ON CONFLICT (user_id, document_id) DO NOTHING`,
    [userId, organizationId, documentIds],
  );
}
