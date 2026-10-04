import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { create as contentDisposition } from 'content-disposition';
import { fileTypeFromBuffer } from 'file-type';
import { config } from '../config/index.js';
import { verificationDocumentRequirements, verificationDocumentTypes } from '../config/referenceData.js';

const documentLabels = new Map(verificationDocumentTypes.map((type) => [type.value, type.label]));

export function documentRequirementsFor(businessType, countryCode) {
  const rule = verificationDocumentRequirements.find((row) => row.businessType === businessType && row.countryCode === countryCode)
    ?? verificationDocumentRequirements.find((row) => row.businessType === businessType && row.countryCode === null);
  if (!rule) return [];
  return [
    ...rule.required.map((type) => ({ type, label: documentLabels.get(type), required: true })),
    ...rule.optional.map((type) => ({ type, label: documentLabels.get(type), required: false })),
  ];
}

export function documentDto(row) {
  return {
    id: row.id,
    type: row.document_type,
    label: documentLabels.get(row.document_type) ?? row.document_type,
    filename: row.original_filename,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    scanStatus: row.scan_status,
    scanResult: row.scan_result,
    scannedAt: row.scanned_at,
    uploadedAt: row.created_at,
    supersededAt: row.superseded_at,
    removedAt: row.deleted_at,
  };
}

// Latest upload per type, including ones whose file was removed, so sellers can see why a slot is empty.
export async function currentDocuments(db, organizationId) {
  const result = await db.query(
    `SELECT DISTINCT ON (document_type) * FROM organization_documents
     WHERE organization_id = $1 AND superseded_at IS NULL
     ORDER BY document_type, created_at DESC`,
    [organizationId],
  );
  return result.rows;
}

export async function verificationDocumentStatus(db, { organizationId, businessType, countryCode }) {
  const byType = new Map((await currentDocuments(db, organizationId)).map((row) => [row.document_type, documentDto(row)]));
  const requirements = documentRequirementsFor(businessType, countryCode).map((item) => ({ ...item, document: byType.get(item.type) ?? null }));
  const missing = requirements
    .filter((item) => item.required && !(item.document?.scanStatus === 'clean' && !item.document.removedAt))
    .map((item) => item.type);
  return { requirements, complete: missing.length === 0, missing };
}

// Identifies the file from its content; the client-supplied type and extension are ignored.
export async function detectAllowedFileType(buffer) {
  const detected = await fileTypeFromBuffer(buffer);
  return detected && config.documents.allowedMimeTypes.includes(detected.mime) ? detected : null;
}

export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function displayFilename(originalName, fallback) {
  const cleaned = basename(String(originalName ?? '').replaceAll('\\', '/'))
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim()
    .slice(0, 255);
  return cleaned || fallback;
}

export function downloadDisposition(filename) {
  return contentDisposition(filename, { type: 'attachment' });
}
