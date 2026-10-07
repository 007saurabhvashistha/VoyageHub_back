import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { create as contentDisposition } from 'content-disposition';
import { fileTypeFromBuffer } from 'file-type';
import { z } from 'zod';
import { config } from '../config/index.js';
import { verificationDocumentRequirements, verificationDocumentTypes } from '../config/referenceData.js';

const documentLabels = new Map(verificationDocumentTypes.map((type) => [type.value, type.label]));

function dateOnly(value) {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

export const verificationDecisionSchema = z.object({
  decision: z.enum(['approved', 'rejected'], { error: 'Decision must be approved or rejected.' }),
  reason: z.string({ error: 'Provide a review reason between 5 and 500 characters.' }).trim()
    .min(5, 'Provide a review reason between 5 and 500 characters.')
    .max(500, 'Provide a review reason between 5 and 500 characters.'),
});

export function agencyVerificationDto(row) {
  return {
    status: row?.status ?? 'unsubmitted',
    reason: row?.reason ?? null,
    submittedAt: row?.submitted_at ?? null,
    decidedAt: row?.decided_at ?? null,
  };
}

// Agencies get their verification row on first use; the caller must be inside a transaction.
export async function lockAgencyVerification(client, organizationId) {
  await client.query('INSERT INTO agency_verifications (organization_id) VALUES ($1) ON CONFLICT (organization_id) DO NOTHING', [organizationId]);
  const result = await client.query('SELECT * FROM agency_verifications WHERE organization_id = $1 FOR UPDATE', [organizationId]);
  return result.rows[0];
}

export async function verificationStateFor(db, { organizationId, businessType }) {
  if (businessType === 'agency') {
    const result = await db.query('SELECT * FROM agency_verifications WHERE organization_id = $1', [organizationId]);
    return agencyVerificationDto(result.rows[0]);
  }
  const result = await db.query('SELECT verification_status, verification_reason FROM seller_profiles WHERE organization_id = $1', [organizationId]);
  return { status: result.rows[0]?.verification_status ?? null, reason: result.rows[0]?.verification_reason ?? null, submittedAt: null, decidedAt: null };
}

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
  const expiresAt = dateOnly(row.expires_at);
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
    expiresAt,
    expired: Boolean(expiresAt && expiresAt < new Date().toISOString().slice(0, 10)),
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
    .filter((item) => item.required && !(item.document?.scanStatus === 'clean' && !item.document.removedAt && !item.document.expired))
    .map((item) => item.type);
  // Submitting for review only needs a usable upload; approval still waits for a clean scan.
  const notUploaded = requirements
    .filter((item) => item.required && !(['pending', 'clean'].includes(item.document?.scanStatus) && !item.document.removedAt && !item.document.expired))
    .map((item) => item.type);
  return { requirements, complete: missing.length === 0, missing, notUploaded };
}

export function requirementLabels(status, types) {
  return status.requirements.filter((item) => types.includes(item.type)).map((item) => item.label);
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
