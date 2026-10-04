import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config/index.js';
import { capabilities } from '../config/referenceData.js';
import { attachmentDto } from '../services/marketplaceAttachments.js';
import { requireCapability } from '../services/permissions.js';
import { findConversation } from '../services/requestConversations.js';
import { detectAllowedFileType, displayFilename, downloadDisposition, sha256Hex } from '../services/verificationDocuments.js';
import { containsContactDetails } from '../utils/contactDetails.js';
import { createRateLimiter } from '../utils/rateLimit.js';
import { parseWith } from '../utils/validation.js';
import { loadSession, requireActiveAccount, requireCsrf, requireMfaForPlatformAdmin } from './auth.routes.js';

const uuidSchema = z.uuid();
const sellers = ['dmc', 'hotelier'];
const allowedFormats = config.documents.allowedMimeTypes.map((mime) => mime.split('/')[1].toUpperCase()).join(', ');
const multerErrors = {
  LIMIT_FILE_SIZE: [413, 'FILE_TOO_LARGE', `Files must be ${config.documents.maxBytes / (1024 * 1024)} MB or smaller.`],
  LIMIT_FILE_COUNT: [400, 'VALIDATION_ERROR', 'Upload one file at a time.'],
  LIMIT_UNEXPECTED_FILE: [400, 'VALIDATION_ERROR', 'Send the attachment in the "file" field.'],
};
const messageFieldsSchema = z.object({
  body: z.string().trim().max(4000, 'Messages must be at most 4000 characters.').optional().transform((value) => value || null),
  seller_organization_id: z.uuid().optional(),
}).refine((input) => !containsContactDetails(input.body), 'Remove contact details and external links before sending this marketplace message.');

function fail(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

// Uses the detected type, never the client's; a filename carrying contact details is replaced.
async function prepareFile(file, fallbackName) {
  const detected = await detectAllowedFileType(file.buffer).catch(() => null);
  if (!detected) return null;
  const name = displayFilename(file.originalname, `${fallbackName}.${detected.ext}`);
  return { detected, filename: containsContactDetails(name) ? `${fallbackName}.${detected.ext}` : name };
}

async function inTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query(result?.error ? 'ROLLBACK' : 'COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function createAttachmentRouter({ pool, storage = null }) {
  const router = Router();
  const uploadLimiter = createRateLimiter(config.rateLimits.documentUpload, 'Too many uploads. Try again later.');
  const upload = multer({
    storage: multer.memoryStorage(),
    defParamCharset: 'utf8',
    limits: { fileSize: config.documents.maxBytes, files: 1, fields: 2, fieldSize: 16 * 1024, parts: 3 },
  }).single('file');
  const receiveFile = (request, response, next) => upload(request, response, (error) => {
    if (!error) return next();
    const [status, code, message] = multerErrors[error.code] ?? [400, 'VALIDATION_ERROR', 'The upload could not be read. Try again with a single file.'];
    return fail(response, status, code, message);
  });
  const requireStorage = (_request, response, next) => storage
    ? next()
    : fail(response, 503, 'STORAGE_NOT_CONFIGURED', 'Attachments are unavailable until private file storage is configured.');

  router.use((request, response, next) => loadSession(pool, request, response, next));
  router.use(requireMfaForPlatformAdmin);
  router.use((request, response, next) => requireActiveAccount(pool, request, response, next));
  router.use((request, response, next) => request.method === 'GET' ? next() : requireCsrf(request, response, next));
  for (const name of ['offerId', 'attachmentId', 'requestId']) {
    router.param(name, (request, response, next, value) => uuidSchema.safeParse(value).success ? next() : fail(response, 404, 'NOT_FOUND', 'The requested item was not found.'));
  }

  // Stores the file, then runs the database write; the stored object is removed again if that write fails.
  async function storeAndRecord({ requestId, prepared, file, record }) {
    const attachmentId = randomUUID();
    const storageKey = `${config.attachments.keyPrefix}/${requestId}/${attachmentId}.${prepared.detected.ext}`;
    await storage.putObject({ key: storageKey, body: file.buffer, contentType: prepared.detected.mime });
    try {
      const outcome = await inTransaction(pool, (client) => record(client, async (columns) => {
        const inserted = await client.query(
          `INSERT INTO marketplace_attachments (id, request_id, offer_id, message_id, owner_organization_id, storage_provider, storage_key,
             original_filename, content_type, size_bytes, sha256, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
          [attachmentId, requestId, columns.offerId ?? null, columns.messageId ?? null, columns.ownerOrganizationId, storage.provider, storageKey,
            prepared.filename, prepared.detected.mime, file.size, sha256Hex(file.buffer), columns.userId],
        );
        return attachmentDto(inserted.rows[0]);
      }));
      if (outcome.error) await storage.deleteObject(storageKey).catch(() => {});
      return outcome;
    } catch (error) {
      await storage.deleteObject(storageKey).catch(() => {});
      throw error;
    }
  }

  // An offer's files change under the same rule as its price: before the deadline, or while answering an agency's negotiation.
  async function lockEditableOffer(client, offerId, organizationId) {
    const result = await client.query(
      `SELECT f.id, f.request_id, r.request_code,
              (r.status = 'open' AND r.response_deadline > NOW())
                OR (r.status IN ('open', 'closed') AND EXISTS (SELECT 1 FROM offer_negotiations n WHERE n.offer_id = f.id AND n.status = 'open')) AS editable,
              (SELECT COUNT(*)::int FROM marketplace_attachments a WHERE a.offer_id = f.id AND a.deleted_at IS NULL) AS attachment_count
       FROM offers f JOIN marketplace_requests r ON r.id = f.request_id
       WHERE f.id = $1 AND f.seller_organization_id = $2 AND f.status IN ('submitted', 'shortlisted') FOR UPDATE OF f`,
      [offerId, organizationId],
    );
    const offer = result.rows[0];
    if (!offer) return { error: [404, 'OFFER_NOT_EDITABLE', 'This active offer was not found.'] };
    if (!offer.editable) return { error: [409, 'RESPONSE_DEADLINE_PASSED', 'Offer files cannot change after the response deadline.'] };
    return { offer };
  }

  router.post('/offers/:offerId', requireCapability(capabilities.offerWrite), (request, response, next) => sellers.includes(request.auth.business_type)
    ? next()
    : fail(response, 403, 'ROLE_FORBIDDEN', 'Only the seller can attach files to its offer.'), requireStorage, uploadLimiter, receiveFile, async (request, response, next) => {
    if (!request.file?.buffer?.length) return fail(response, 400, 'VALIDATION_ERROR', 'Attach a file.');
    try {
      const prepared = await prepareFile(request.file, 'offer-attachment');
      if (!prepared) return fail(response, 415, 'UNSUPPORTED_FILE_TYPE', `Upload a ${allowedFormats} file. The file content must match a supported format.`);
      const me = request.auth.organization_id;
      const offer = await lockEditableOffer(pool, request.params.offerId, me);
      if (offer.error) return fail(response, ...offer.error);
      const outcome = await storeAndRecord({
        requestId: offer.offer.request_id,
        prepared,
        file: request.file,
        record: async (client, insert) => {
          const locked = await lockEditableOffer(client, request.params.offerId, me);
          if (locked.error) return locked;
          if (locked.offer.attachment_count >= config.attachments.maxPerOffer) return { error: [409, 'ATTACHMENT_LIMIT_REACHED', `An offer can carry up to ${config.attachments.maxPerOffer} files.`] };
          return { attachment: await insert({ offerId: locked.offer.id, ownerOrganizationId: me, userId: request.auth.user_id }) };
        },
      });
      if (outcome.error) return fail(response, ...outcome.error);
      return response.status(201).json({ attachment: outcome.attachment });
    } catch (error) {
      return next(error);
    }
  });

  router.delete('/:attachmentId', requireCapability(capabilities.offerWrite), requireStorage, async (request, response, next) => {
    try {
      const outcome = await inTransaction(pool, async (client) => {
        const found = await client.query('SELECT * FROM marketplace_attachments WHERE id = $1 AND owner_organization_id = $2 AND offer_id IS NOT NULL AND deleted_at IS NULL FOR UPDATE', [request.params.attachmentId, request.auth.organization_id]);
        const attachment = found.rows[0];
        if (!attachment) return { error: [404, 'ATTACHMENT_NOT_FOUND', 'Only files attached to your own offers can be removed.'] };
        const offer = await lockEditableOffer(client, attachment.offer_id, request.auth.organization_id);
        if (offer.error) return offer;
        if (attachment.storage_provider !== storage.provider) return { error: [409, 'STORAGE_PROVIDER_CHANGED', 'This file is held by a storage provider that is no longer configured.'] };
        await storage.deleteObject(attachment.storage_key);
        await client.query('UPDATE marketplace_attachments SET deleted_at = NOW() WHERE id = $1', [attachment.id]);
        return {};
      });
      if (outcome.error) return fail(response, ...outcome.error);
      return response.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  router.post('/requests/:requestId/messages', requireCapability(capabilities.messageWrite), requireStorage, uploadLimiter, receiveFile, async (request, response, next) => {
    if (!request.file?.buffer?.length) return fail(response, 400, 'VALIDATION_ERROR', 'Attach a file.');
    const fields = parseWith(messageFieldsSchema, request.body ?? {});
    if (fields.error) return fail(response, 400, 'VALIDATION_ERROR', fields.error);
    const me = request.auth.organization_id;
    const sellerOrganizationId = request.auth.business_type === 'agency' ? fields.data.seller_organization_id : me;
    if (!sellerOrganizationId) return fail(response, 400, 'VALIDATION_ERROR', 'Choose a matched seller conversation.');
    const { requestId } = request.params;
    try {
      const prepared = await prepareFile(request.file, 'shared-file');
      if (!prepared) return fail(response, 415, 'UNSUPPORTED_FILE_TYPE', `Upload a ${allowedFormats} file. The file content must match a supported format.`);
      if (!await findConversation(pool, { requestId, sellerOrganizationId, organizationId: me })) return fail(response, 404, 'CONVERSATION_NOT_FOUND', 'This request conversation is not available to your organization.');
      const outcome = await storeAndRecord({
        requestId,
        prepared,
        file: request.file,
        record: async (client, insert) => {
          const participant = await findConversation(client, { requestId, sellerOrganizationId, organizationId: me, lock: true });
          if (!participant) return { error: [404, 'CONVERSATION_NOT_FOUND', 'This request conversation is not available to your organization.'] };
          const shared = await client.query(
            `SELECT COUNT(*)::int AS total FROM marketplace_attachments a JOIN request_messages m ON m.id = a.message_id
             WHERE m.request_id = $1 AND ((m.sender_organization_id = $2 AND m.recipient_organization_id = $3)
               OR (m.sender_organization_id = $3 AND m.recipient_organization_id = $2))`,
            [requestId, me, participant.peerOrganizationId],
          );
          if (shared.rows[0].total >= config.attachments.maxPerConversation) return { error: [409, 'ATTACHMENT_LIMIT_REACHED', `A conversation can hold up to ${config.attachments.maxPerConversation} files.`] };
          const messageId = randomUUID();
          const body = fields.data.body ?? `Shared a file: ${prepared.filename}`;
          await client.query(
            `INSERT INTO request_messages (id, request_id, sender_organization_id, recipient_organization_id, sender_user_id, body)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [messageId, requestId, me, participant.peerOrganizationId, request.auth.user_id, body],
          );
          const attachment = await insert({ messageId, ownerOrganizationId: me, userId: request.auth.user_id });
          await client.query(
            'INSERT INTO notifications (id, organization_id, event_type, title, message, data) VALUES ($1, $2, $3, $4, $5, $6)',
            [randomUUID(), participant.peerOrganizationId, 'request_message', 'New marketplace message', `${participant.request_code} / New file from ${participant.callerName}`, JSON.stringify({ requestId, requestCode: participant.request_code, messageId })],
          );
          return { message: { id: messageId, requestId, senderName: participant.callerName, body, createdAt: new Date().toISOString(), isMine: true, attachments: [attachment] } };
        },
      });
      if (outcome.error) return fail(response, ...outcome.error);
      return response.status(201).json({ message: outcome.message });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:attachmentId/download-url', requireStorage, async (request, response, next) => {
    const me = request.auth.organization_id;
    try {
      const result = await pool.query(
        `SELECT a.*, r.agency_organization_id, f.seller_organization_id AS offer_seller_id,
                m.sender_organization_id, m.recipient_organization_id
         FROM marketplace_attachments a JOIN marketplace_requests r ON r.id = a.request_id
         LEFT JOIN offers f ON f.id = a.offer_id LEFT JOIN request_messages m ON m.id = a.message_id
         WHERE a.id = $1`,
        [request.params.attachmentId],
      );
      const attachment = result.rows[0];
      let allowed = false;
      if (attachment?.offer_id) allowed = [attachment.offer_seller_id, attachment.agency_organization_id].includes(me);
      else if (attachment?.message_id && [attachment.sender_organization_id, attachment.recipient_organization_id].includes(me)) {
        const sellerOrganizationId = attachment.sender_organization_id === attachment.agency_organization_id ? attachment.recipient_organization_id : attachment.sender_organization_id;
        allowed = Boolean(await findConversation(pool, { requestId: attachment.request_id, sellerOrganizationId, organizationId: me }));
      }
      if (!allowed || attachment.deleted_at) return fail(response, 404, 'ATTACHMENT_NOT_FOUND', 'Attachment was not found or has been removed.');
      if (attachment.scan_status !== 'clean') return fail(response, 409, 'DOCUMENT_NOT_SCANNED', 'Only files that passed the malware scan can be opened.');
      if (attachment.storage_provider !== storage.provider) return fail(response, 409, 'STORAGE_PROVIDER_CHANGED', 'This file is held by a storage provider that is no longer configured.');
      const expiresInSeconds = config.documents.downloadUrlTtlSeconds;
      const url = await storage.createDownloadUrl(attachment.storage_key, {
        expiresInSeconds,
        contentDisposition: downloadDisposition(attachment.original_filename),
        contentType: attachment.content_type,
      });
      return response.json({ url, expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString() });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
