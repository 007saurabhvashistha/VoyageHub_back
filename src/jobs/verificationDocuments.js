import { randomUUID } from 'node:crypto';
import { config } from '../config/index.js';
import { recordOrganizationEvent } from '../services/organizationAudit.js';
import { getSetting } from '../services/platformSettings.js';
import { documentDto, documentRequirementsFor, sha256Hex } from '../services/verificationDocuments.js';

const scanBatchSize = 10;
const retentionBatchSize = 100;
const dayMs = 24 * 60 * 60 * 1000;

function dateOnly(value) {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

async function inTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function notify(client, organizationId, eventType, title, message, data) {
  await client.query(
    'INSERT INTO notifications (id, organization_id, event_type, title, message, data) VALUES ($1, $2, $3, $4, $5, $6)',
    [randomUUID(), organizationId, eventType, title, message, JSON.stringify(data)],
  );
}

// Every stored upload goes through the same scan; each source says who is told about the outcome.
const scanSources = [
  {
    table: 'organization_documents',
    ownerId: (row) => row.organization_id,
    label: (row) => documentDto(row).label,
    data: (row) => ({ documentId: row.id, documentType: row.document_type }),
  },
  {
    table: 'booking_vouchers',
    ownerId: (row) => row.seller_organization_id,
    label: (row) => `Booking voucher ${row.original_filename}`,
    data: (row) => ({ voucherId: row.id, awardId: row.award_id }),
    onClean: (client, row) => notify(client, row.agency_organization_id, 'booking_voucher_ready', 'Booking voucher available', `${row.original_filename} passed the malware scan and can be opened.`, { voucherId: row.id, awardId: row.award_id }),
  },
  {
    table: 'marketplace_attachments',
    ownerId: (row) => row.owner_organization_id,
    label: (row) => `Attachment ${row.original_filename}`,
    data: (row) => ({ attachmentId: row.id, requestId: row.request_id, offerId: row.offer_id, messageId: row.message_id }),
  },
  {
    table: 'hotel_property_photos',
    ownerId: (row) => row.organization_id,
    label: (row) => `Hotel photo ${row.original_filename}`,
    data: (row) => ({ photoId: row.id, propertyId: row.property_id }),
  },
];

async function finishScan(pool, source, document, { status, result, deleteFile, current, notice }) {
  await inTransaction(pool, async (client) => {
    const updated = await client.query(
      `UPDATE ${source.table} SET scan_status = $2, scan_result = $3, scanned_at = $4,
         deleted_at = CASE WHEN $5 THEN $4 ELSE deleted_at END
       WHERE id = $1 AND scan_status = 'pending'`,
      [document.id, status, result, current, deleteFile],
    );
    if (!updated.rowCount) return;
    if (status === 'clean') {
      await source.onClean?.(client, document);
      return;
    }
    if (!notice) return;
    const organizationId = source.ownerId(document);
    const data = source.data(document);
    await notify(client, organizationId, notice.eventType, notice.title, `${source.label(document)}: ${notice.message}`, data);
    await recordOrganizationEvent(client, { organizationId, actorUserId: null, action: notice.auditAction, details: { ...data, result } });
  });
}

// Every upload stays unreadable until this job marks it clean.
export async function processDocumentScans(pool, {
  storage,
  scanner,
  now = () => new Date(),
  maxAttempts = config.documents.scanMaxAttempts,
  retryBaseMs = config.documents.scanIntervalMs,
} = {}) {
  const summary = { clean: 0, infected: 0, retrying: 0, failed: 0 };
  if (!storage || !scanner) return summary;
  const current = now();
  for (const source of scanSources) {
    // Claiming pushes the next attempt out with exponential backoff, so a crash mid-scan simply retries later.
    const claimed = await pool.query(
      `UPDATE ${source.table} SET scan_attempts = scan_attempts + 1,
         scan_next_attempt_at = $2::timestamptz + make_interval(secs => $3::double precision * power(2, scan_attempts))
       WHERE id IN (
         SELECT id FROM ${source.table}
         WHERE scan_status = 'pending' AND deleted_at IS NULL AND scan_next_attempt_at <= $2
         ORDER BY scan_next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [scanBatchSize, current, retryBaseMs / 1000],
    );

    for (const document of claimed.rows) {
      try {
        if (document.storage_provider !== storage.provider) throw new Error('Document is held by a storage provider that is not configured.');
        const body = await storage.getObject(document.storage_key);
        if (sha256Hex(body) !== document.sha256) {
          await finishScan(pool, source, document, {
            status: 'failed', result: 'Stored file does not match the uploaded checksum.', deleteFile: false, current,
            notice: { eventType: 'document_scan_failed', title: 'Document needs re-upload', message: 'the stored file could not be verified. Upload it again.', auditAction: 'document.scan_failed' },
          });
          summary.failed += 1;
          continue;
        }
        const verdict = await scanner.scan(body);
        if (verdict.infected) {
          await storage.deleteObject(document.storage_key);
          await finishScan(pool, source, document, {
            status: 'infected', result: verdict.signature, deleteFile: true, current,
            notice: { eventType: 'document_blocked', title: 'Document blocked', message: 'malware was detected and the file was deleted. Upload a clean copy.', auditAction: 'document.malware_detected' },
          });
          summary.infected += 1;
        } else {
          await finishScan(pool, source, document, { status: 'clean', result: null, deleteFile: false, current });
          summary.clean += 1;
        }
      } catch {
        if (document.scan_attempts < maxAttempts) {
          summary.retrying += 1;
          continue;
        }
        await finishScan(pool, source, document, {
          status: 'failed', result: `Malware scan did not complete after ${document.scan_attempts} attempts.`, deleteFile: false, current,
          notice: { eventType: 'document_scan_failed', title: 'Document needs re-upload', message: 'the malware scan could not be completed. Upload it again.', auditAction: 'document.scan_failed' },
        }).catch(() => {});
        summary.failed += 1;
      }
    }
  }
  return summary;
}

// Decision 2: rejected applications keep documents for a set period after rejection; closed organizations for a set period after closure.
export async function processDocumentRetention(pool, { storage, now = () => new Date() } = {}) {
  const summary = { deletedDocuments: 0, failures: 0 };
  if (!storage) return summary;
  const current = now();
  const rejectedDays = await getSetting(pool, 'rejected_document_retention_days');
  const closedDays = await getSetting(pool, 'closed_organization_document_retention_days');
  const due = await pool.query(
    `SELECT 'organization_documents' AS source, d.id, d.storage_key, d.storage_provider, d.created_at FROM organization_documents d
     JOIN organizations o ON o.id = d.organization_id
     LEFT JOIN seller_profiles p ON p.organization_id = o.id
     LEFT JOIN agency_verifications agency ON agency.organization_id = o.id
     WHERE d.deleted_at IS NULL AND (
       (o.closed_at IS NOT NULL AND o.closed_at <= $1)
       OR (o.closed_at IS NULL AND p.verification_status = 'rejected' AND (
         SELECT MAX(review.created_at) FROM seller_verification_reviews review
         WHERE review.seller_organization_id = o.id AND review.decision = 'rejected'
       ) <= $2)
       OR (o.closed_at IS NULL AND agency.status = 'rejected' AND agency.decided_at <= $2)
     )
     UNION ALL
     SELECT 'marketplace_attachments', a.id, a.storage_key, a.storage_provider, a.created_at FROM marketplace_attachments a
     JOIN organizations o ON o.id = a.owner_organization_id
     WHERE a.deleted_at IS NULL AND o.closed_at IS NOT NULL AND o.closed_at <= $1
    UNION ALL
    SELECT 'hotel_property_photos', photo.id, photo.storage_key, photo.storage_provider, photo.created_at FROM hotel_property_photos photo
    JOIN organizations o ON o.id = photo.organization_id
    WHERE photo.deleted_at IS NULL AND o.closed_at IS NOT NULL AND o.closed_at <= $1
     ORDER BY created_at LIMIT $3`,
    [new Date(current.getTime() - closedDays * dayMs), new Date(current.getTime() - rejectedDays * dayMs), retentionBatchSize],
  );
  for (const document of due.rows) {
    try {
      if (document.storage_provider !== storage.provider) throw new Error('Document is held by a storage provider that is not configured.');
      await storage.deleteObject(document.storage_key);
      await pool.query(`UPDATE ${document.source} SET deleted_at = $2 WHERE id = $1 AND deleted_at IS NULL`, [document.id, current]);
      summary.deletedDocuments += 1;
    } catch {
      summary.failures += 1;
    }
  }
  return summary;
}

export async function processDocumentExpiryReminders(pool, {
  now = () => new Date(),
  reminderDays = config.documents.expiryReminderDays,
  batchSize = config.documents.expiryBatchSize,
} = {}) {
  const currentDate = now().toISOString().slice(0, 10);
  const schedule = [...new Set(reminderDays)].sort((left, right) => left - right);
  const summary = { reminders: 0, expired: 0, verificationResets: 0, failures: 0 };
  if (!schedule.length) return summary;

  const due = await pool.query(
    `WITH due_documents AS (
       SELECT document.id, document.expires_at, organization.business_type, organization.country_code,
              CASE WHEN document.expires_at < $1::date THEN 0
                ELSE (SELECT MIN(offset_days) FROM UNNEST($2::int[]) AS offsets(offset_days)
                      WHERE offset_days >= document.expires_at - $1::date
                        AND NOT EXISTS (
                          SELECT 1 FROM organization_document_expiry_notices existing_notice
                          WHERE existing_notice.document_id = document.id
                            AND existing_notice.notice_kind = 'upcoming'
                            AND existing_notice.reminder_days_before <= offset_days
                        ))
              END AS reminder_days_before
       FROM organization_documents document
       JOIN organizations organization ON organization.id = document.organization_id
       WHERE document.expires_at IS NOT NULL AND document.superseded_at IS NULL
         AND document.deleted_at IS NULL AND document.scan_status = 'clean'
         AND document.expires_at <= $1::date + $3::int
     )
     SELECT due_documents.* FROM due_documents
     WHERE due_documents.reminder_days_before IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM organization_document_expiry_notices notice
         WHERE notice.document_id = due_documents.id
           AND notice.notice_kind = CASE WHEN due_documents.expires_at < $1::date THEN 'expired' ELSE 'upcoming' END
           AND notice.reminder_days_before = due_documents.reminder_days_before
       )
     ORDER BY due_documents.expires_at, due_documents.id LIMIT $4`,
    [currentDate, schedule, schedule.at(-1), batchSize],
  );

  for (const dueDocument of due.rows) {
    try {
      const handled = await inTransaction(pool, async (client) => {
        const selected = await client.query(
          `SELECT document.*, organization.business_type, organization.country_code, organization.name AS organization_name
           FROM organization_documents document JOIN organizations organization ON organization.id = document.organization_id
           WHERE document.id = $1 AND document.superseded_at IS NULL AND document.deleted_at IS NULL
             AND document.scan_status = 'clean' FOR UPDATE OF document`,
          [dueDocument.id],
        );
        const document = selected.rows[0];
        if (!document) return null;
        const expiresAt = dateOnly(document.expires_at);
        const expired = expiresAt < currentDate;
        const noticeKind = expired ? 'expired' : 'upcoming';
        const reminderDaysBefore = expired ? 0 : Number(dueDocument.reminder_days_before);
        const recorded = await client.query(
          `INSERT INTO organization_document_expiry_notices (id, document_id, notice_kind, reminder_days_before)
           VALUES ($1, $2, $3, $4) ON CONFLICT (document_id, notice_kind, reminder_days_before) DO NOTHING RETURNING id`,
          [randomUUID(), document.id, noticeKind, reminderDaysBefore],
        );
        if (!recorded.rowCount) return null;

        const requirement = documentRequirementsFor(document.business_type, document.country_code).find((item) => item.type === document.document_type);
        const isRequired = Boolean(requirement?.required);
        let verificationReset = false;
        if (expired && isRequired && document.business_type === 'agency') {
          const updated = await client.query(
            `UPDATE agency_verifications SET status = 'unsubmitted', reason = $2,
               submitted_at = NULL, decided_at = NULL, updated_at = NOW()
             WHERE organization_id = $1 AND status IN ('approved', 'pending') RETURNING organization_id`,
            [document.organization_id, 'A required verification document expired. Upload a current replacement and submit for review.'],
          );
          if (updated.rowCount) {
            await client.query('UPDATE organizations SET verified_at = NULL WHERE id = $1', [document.organization_id]);
            verificationReset = true;
          }
        } else if (expired && isRequired) {
          const updated = await client.query(
            `UPDATE seller_profiles SET verification_status = 'pending',
               verification_reason = 'A required verification document expired. Upload a current replacement for re-review.', updated_at = NOW()
             WHERE organization_id = $1 AND verification_status = 'approved' RETURNING organization_id`,
            [document.organization_id],
          );
          if (updated.rowCount) {
            await client.query(
              `UPDATE hotel_properties SET verification_status = 'pending', reviewed_by = NULL, reviewed_at = NULL, updated_at = NOW()
               WHERE organization_id = $1 AND verification_status = 'approved'`,
              [document.organization_id],
            );
            verificationReset = true;
          }
        }

        const label = documentDto(document).label;
        const eventType = expired ? 'verification_document_expired' : 'verification_document_expiring';
        const title = expired ? 'Verification document expired' : 'Verification document expiring';
        const message = expired
          ? `${label} expired on ${expiresAt}. Upload a current replacement${isRequired ? ' to restore verification' : ''}.`
          : reminderDaysBefore === 0
            ? `${label} expires today. Upload a current replacement before it expires.`
            : `${label} expires in ${reminderDaysBefore} day${reminderDaysBefore === 1 ? '' : 's'} on ${expiresAt}.`;
          const data = { documentId: document.id, documentType: document.document_type, expiresAt, required: isRequired };
        await notify(client, document.organization_id, eventType, title, message, data);
        if (expired) {
          await recordOrganizationEvent(client, { organizationId: document.organization_id, actorUserId: null, action: 'document.expired', details: { ...data, verificationReset } });
        }
        return { expired, verificationReset };
      });
      if (!handled) continue;
      if (handled.expired) summary.expired += 1;
      else summary.reminders += 1;
      if (handled.verificationReset) summary.verificationResets += 1;
    } catch {
      summary.failures += 1;
    }
  }
  return summary;
}

export function startDocumentExpiryWorker(pool, { intervalMs = config.documents.expiryIntervalMs, logger = console } = {}) {
  let active = false;
  let stopped = false;
  const run = async () => {
    if (active || stopped) return;
    active = true;
    try {
      const result = await processDocumentExpiryReminders(pool);
      if (result.failures) logger.error(`Document expiry reminders left ${result.failures} record(s) for the next run.`);
    } catch {
      logger.error('Document expiry reminder processing failed.');
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

export function startDocumentScanWorker(pool, { storage, scanner, intervalMs = config.documents.scanIntervalMs, logger = console } = {}) {
  if (!storage || !scanner) return () => {};
  let active = false;
  let stopped = false;
  const run = async () => {
    if (active || stopped) return;
    active = true;
    try {
      const result = await processDocumentScans(pool, { storage, scanner });
      if (result.failed) logger.error(`Malware scanning gave up on ${result.failed} document(s).`);
    } catch {
      logger.error('Document scan processing failed.');
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
