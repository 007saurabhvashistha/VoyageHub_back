import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config/index.js';
import { documentDto, downloadDisposition, verificationDocumentStatus } from '../services/verificationDocuments.js';
import { requireCsrf } from './auth.routes.js';

const uuidSchema = z.uuid();

function fail(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

export function registerDocumentAdminRoutes(router, pool, storage) {
  router.get('/seller-profiles/:organizationId/documents', async (request, response, next) => {
    if (!uuidSchema.safeParse(request.params.organizationId).success) return fail(response, 400, 'VALIDATION_ERROR', 'Choose a valid seller organization.');
    try {
      const organization = await pool.query(
        `SELECT o.id, o.business_type, o.country_code FROM organizations o
         JOIN seller_profiles p ON p.organization_id = o.id WHERE o.id = $1`,
        [request.params.organizationId],
      );
      if (!organization.rowCount) return fail(response, 404, 'SELLER_NOT_FOUND', 'Seller organization was not found.');
      const seller = organization.rows[0];
      const status = await verificationDocumentStatus(pool, { organizationId: seller.id, businessType: seller.business_type, countryCode: seller.country_code });
      const history = await pool.query(
        'SELECT * FROM organization_documents WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 100',
        [seller.id],
      );
      return response.json({ storageConfigured: Boolean(storage), ...status, history: history.rows.map(documentDto) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/documents/:documentId/download-url', requireCsrf, async (request, response, next) => {
    if (!uuidSchema.safeParse(request.params.documentId).success) return fail(response, 400, 'VALIDATION_ERROR', 'Choose a valid document.');
    if (!storage) return fail(response, 503, 'STORAGE_NOT_CONFIGURED', 'Documents cannot be opened until private file storage is configured.');
    try {
      const result = await pool.query('SELECT * FROM organization_documents WHERE id = $1', [request.params.documentId]);
      const document = result.rows[0];
      if (!document || document.deleted_at) return fail(response, 404, 'DOCUMENT_NOT_FOUND', 'Document was not found or has been removed.');
      if (document.scan_status !== 'clean') return fail(response, 409, 'DOCUMENT_NOT_SCANNED', 'Only documents that passed the malware scan can be opened.');
      if (document.storage_provider !== storage.provider) return fail(response, 409, 'STORAGE_PROVIDER_CHANGED', 'This document is held by a storage provider that is no longer configured.');
      const expiresInSeconds = config.documents.downloadUrlTtlSeconds;
      const url = await storage.createDownloadUrl(document.storage_key, {
        expiresInSeconds,
        contentDisposition: downloadDisposition(document.original_filename),
        contentType: document.content_type,
      });
      await pool.query(
        'INSERT INTO organization_document_access_log (id, document_id, user_id) VALUES ($1, $2, $3)',
        [randomUUID(), document.id, request.auth.user_id],
      );
      return response.json({ url, expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString() });
    } catch (error) {
      return next(error);
    }
  });
}
