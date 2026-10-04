import { randomUUID } from 'node:crypto';
import { config } from '../config/index.js';
import { recordOrganizationEvent } from '../services/organizationAudit.js';
import { getSetting } from '../services/platformSettings.js';
import { documentDto, sha256Hex } from '../services/verificationDocuments.js';

const scanBatchSize = 10;
const retentionBatchSize = 100;
const dayMs = 24 * 60 * 60 * 1000;

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
