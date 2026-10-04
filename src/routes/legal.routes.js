import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config/index.js';
import { legalDocumentTypes } from '../config/referenceData.js';
import { currentLegalDocuments, documentRequiredFor, legalDocumentDto, pendingLegalDocuments, recordAcceptances } from '../services/legal.js';
import { parseWith } from '../utils/validation.js';
import { loadSession, requireCsrf } from './auth.routes.js';

const acceptanceSchema = z.object({ document_ids: z.array(z.uuid()).min(1).max(20) });
const documentTypes = legalDocumentTypes.map((type) => type.value);

function fail(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

function publisher() {
  return { entityName: config.legal.entityName, grievanceOfficer: config.legal.grievanceOfficer };
}

export function createLegalRouter({ pool }) {
  const router = Router();

  router.get('/documents', async (_request, response, next) => {
    if (!pool) return fail(response, 503, 'DATABASE_NOT_CONFIGURED', 'Legal documents are unavailable until the database is configured.');
    try {
      const current = await currentLegalDocuments(pool);
      response.set('cache-control', 'public, max-age=300');
      return response.json({
        documents: current.map((row) => ({ ...legalDocumentDto(row), acceptance: legalDocumentTypes.find((type) => type.value === row.document_type).acceptance })),
        ...publisher(),
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/documents/:type', async (request, response, next) => {
    if (!documentTypes.includes(request.params.type)) return fail(response, 404, 'DOCUMENT_NOT_FOUND', 'This legal document does not exist.');
    if (!pool) return fail(response, 503, 'DATABASE_NOT_CONFIGURED', 'Legal documents are unavailable until the database is configured.');
    try {
      const current = (await currentLegalDocuments(pool, { includeBody: true })).find((row) => row.document_type === request.params.type);
      if (!current) return fail(response, 404, 'DOCUMENT_NOT_PUBLISHED', 'This document has not been published yet.');
      response.set('cache-control', 'public, max-age=300');
      return response.json({ document: legalDocumentDto(current, { includeBody: true }), ...publisher() });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/acceptances', (request, response, next) => loadSession(pool, request, response, next), requireCsrf, async (request, response, next) => {
    const input = parseWith(acceptanceSchema, request.body);
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    try {
      const current = await currentLegalDocuments(pool);
      const acceptable = new Set(current.filter((row) => documentRequiredFor(row.document_type, request.auth.access_role)).map((row) => row.id));
      if (input.data.document_ids.some((id) => !acceptable.has(id))) return fail(response, 409, 'DOCUMENT_NOT_CURRENT', 'A newer version was published. Reload and review the current documents.');
      await recordAcceptances(pool, { userId: request.auth.user_id, organizationId: request.auth.organization_id, documentIds: input.data.document_ids });
      const pending = await pendingLegalDocuments(pool, request.auth.user_id, request.auth.access_role);
      return response.json({ pendingLegalDocuments: pending.map((row) => legalDocumentDto(row)) });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
