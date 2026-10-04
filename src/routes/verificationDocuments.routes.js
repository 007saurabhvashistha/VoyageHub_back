import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { config } from '../config/index.js';
import { capabilities } from '../config/referenceData.js';
import { requireCapability } from '../services/permissions.js';
import { recordOrganizationEvent } from '../services/organizationAudit.js';
import { agencyVerificationDto, detectAllowedFileType, displayFilename, documentDto, documentRequirementsFor, lockAgencyVerification, requirementLabels, sha256Hex, verificationDocumentStatus, verificationStateFor } from '../services/verificationDocuments.js';
import { createRateLimiter } from '../utils/rateLimit.js';
import { loadSession, requireActiveAccount, requireCsrf, requireMfaForPlatformAdmin } from './auth.routes.js';

function fail(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

const allowedFormats = config.documents.allowedMimeTypes.map((mime) => mime.split('/')[1].toUpperCase()).join(', ');
const multerErrors = {
  LIMIT_FILE_SIZE: [413, 'FILE_TOO_LARGE', `Files must be ${config.documents.maxBytes / (1024 * 1024)} MB or smaller.`],
  LIMIT_FILE_COUNT: [400, 'VALIDATION_ERROR', 'Upload one file at a time.'],
  LIMIT_UNEXPECTED_FILE: [400, 'VALIDATION_ERROR', 'Send the document in the "file" field.'],
};

export function createVerificationDocumentsRouter({ pool, storage }) {
  const router = Router();
  const uploadLimiter = createRateLimiter(config.rateLimits.documentUpload, 'Too many document uploads. Try again later.');
  const upload = multer({
    storage: multer.memoryStorage(),
    defParamCharset: 'utf8',
    limits: { fileSize: config.documents.maxBytes, files: 1, fields: 4, fieldSize: 1024, parts: 5 },
  }).single('file');

  router.use((request, response, next) => loadSession(pool, request, response, next));
  router.use(requireMfaForPlatformAdmin);
  router.use((request, response, next) => requireActiveAccount(pool, request, response, next));
  router.use((request, response, next) => documentRequirementsFor(request.auth.business_type, request.auth.country_code).length
    ? next()
    : fail(response, 403, 'ROLE_FORBIDDEN', 'Verification documents are not used for this account type.'));

  router.get('/', async (request, response, next) => {
    try {
      const scope = { organizationId: request.auth.organization_id, businessType: request.auth.business_type, countryCode: request.auth.country_code };
      const [status, verification] = await Promise.all([verificationDocumentStatus(pool, scope), verificationStateFor(pool, scope)]);
      return response.json({ storageConfigured: Boolean(storage), ...status, verification });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/submit', requireCsrf, requireCapability(capabilities.profileManage), async (request, response, next) => {
    if (request.auth.business_type !== 'agency') return fail(response, 403, 'ROLE_FORBIDDEN', 'Seller profiles are queued for review automatically.');
    const organizationId = request.auth.organization_id;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const verification = await lockAgencyVerification(client, organizationId);
      if (verification.status === 'pending' || verification.status === 'approved') {
        await client.query('ROLLBACK');
        return verification.status === 'pending'
          ? fail(response, 409, 'VERIFICATION_ALREADY_SUBMITTED', 'Your documents are already waiting for review.')
          : fail(response, 409, 'AGENCY_ALREADY_VERIFIED', 'Your agency is already verified.');
      }
      const status = await verificationDocumentStatus(client, { organizationId, businessType: 'agency', countryCode: request.auth.country_code });
      if (status.notUploaded.length) {
        await client.query('ROLLBACK');
        return fail(response, 409, 'DOCUMENTS_INCOMPLETE', `Upload every required document before submitting. Missing: ${requirementLabels(status, status.notUploaded).join('; ')}.`);
      }
      const updated = await client.query(
        `UPDATE agency_verifications SET status = 'pending', submitted_at = NOW(), updated_at = NOW()
         WHERE organization_id = $1 RETURNING *`,
        [organizationId],
      );
      await recordOrganizationEvent(client, { organizationId, actorUserId: request.auth.user_id, action: 'verification.submitted', details: {} });
      await client.query('COMMIT');
      return response.json({ verification: agencyVerificationDto(updated.rows[0]) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  router.post('/', requireCsrf, requireCapability(capabilities.profileManage), (request, response, next) => {
    if (!storage) return fail(response, 503, 'STORAGE_NOT_CONFIGURED', 'Document upload is unavailable until private file storage is configured.');
    return next();
  }, uploadLimiter, (request, response, next) => upload(request, response, (error) => {
    if (!error) return next();
    const [status, code, message] = multerErrors[error.code] ?? [400, 'VALIDATION_ERROR', 'The upload could not be read. Try again with a single file.'];
    return fail(response, status, code, message);
  }), async (request, response, next) => {
    const documentType = typeof request.body?.document_type === 'string' ? request.body.document_type : '';
    const allowedTypes = new Set(documentRequirementsFor(request.auth.business_type, request.auth.country_code).map((item) => item.type));
    if (!allowedTypes.has(documentType)) return fail(response, 400, 'VALIDATION_ERROR', 'Choose a document type listed for your business.');
    if (!request.file?.buffer?.length) return fail(response, 400, 'VALIDATION_ERROR', 'Attach the document file.');

    const detected = await detectAllowedFileType(request.file.buffer).catch(() => null);
    if (!detected) return fail(response, 415, 'UNSUPPORTED_FILE_TYPE', `Upload a ${allowedFormats} file. The file content must match a supported format.`);

    const organizationId = request.auth.organization_id;
    const documentId = randomUUID();
    const storageKey = `${storage.keyPrefix}/${organizationId}/${documentId}.${detected.ext}`;
    const filename = displayFilename(request.file.originalname, `${documentType}.${detected.ext}`);

    try {
      const stored = await pool.query('SELECT COUNT(*)::int AS count FROM organization_documents WHERE organization_id = $1 AND deleted_at IS NULL', [organizationId]);
      if (stored.rows[0].count >= config.documents.maxPerOrganization) return fail(response, 409, 'DOCUMENT_LIMIT_REACHED', 'This organization has reached its stored document limit. Contact platform support.');
      await storage.putObject({ key: storageKey, body: request.file.buffer, contentType: detected.mime });
    } catch (error) {
      return next(error);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let verificationStatus;
      if (request.auth.business_type === 'agency') {
        verificationStatus = (await lockAgencyVerification(client, organizationId)).status;
        // A rejected agency resubmits explicitly once its replacement files are in place.
        if (verificationStatus === 'rejected') {
          await client.query("UPDATE agency_verifications SET status = 'unsubmitted', updated_at = NOW() WHERE organization_id = $1", [organizationId]);
          verificationStatus = 'unsubmitted';
        }
      } else {
        const profile = await client.query('SELECT verification_status FROM seller_profiles WHERE organization_id = $1 FOR UPDATE', [organizationId]);
        if (!profile.rowCount) {
          await client.query('ROLLBACK');
          await storage.deleteObject(storageKey).catch(() => {});
          return fail(response, 404, 'PROFILE_NOT_FOUND', 'Seller profile was not found.');
        }
        verificationStatus = profile.rows[0].verification_status;
        if (verificationStatus === 'rejected') {
          await client.query(
            `UPDATE seller_profiles SET verification_status = 'pending', verification_reason = 'Documents updated and awaiting review.', updated_at = NOW()
             WHERE organization_id = $1`,
            [organizationId],
          );
          verificationStatus = 'pending';
        }
      }
      await client.query(
        `UPDATE organization_documents SET superseded_at = NOW()
         WHERE organization_id = $1 AND document_type = $2 AND superseded_at IS NULL`,
        [organizationId, documentType],
      );
      const inserted = await client.query(
        `INSERT INTO organization_documents (id, organization_id, document_type, storage_provider, storage_key, original_filename, content_type, size_bytes, sha256, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [documentId, organizationId, documentType, storage.provider, storageKey, filename, detected.mime, request.file.size, sha256Hex(request.file.buffer), request.auth.user_id],
      );
      await recordOrganizationEvent(client, { organizationId, actorUserId: request.auth.user_id, action: 'document.uploaded', details: { documentId, documentType } });
      await client.query('COMMIT');
      return response.status(201).json({ document: documentDto(inserted.rows[0]), verificationStatus });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      await storage.deleteObject(storageKey).catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  return router;
}
