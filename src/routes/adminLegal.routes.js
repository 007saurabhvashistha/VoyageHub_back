import { z } from 'zod';
import { legalDocumentTypes } from '../config/referenceData.js';
import { legalDocumentDto } from '../services/legal.js';
import { parseWith } from '../utils/validation.js';
import { requireCsrf } from './auth.routes.js';
import { randomUUID } from 'node:crypto';

const publishSchema = z.object({
  document_type: z.enum(legalDocumentTypes.map((type) => type.value), { error: 'Choose a supported document type.' }),
  title: z.string().trim().min(3, 'Add a title of at least 3 characters.').max(200),
  body: z.string().trim().min(50, 'The document body must be at least 50 characters.').max(200000),
  change_summary: z.string().trim().max(500).nullish().transform((value) => value || null),
});

function fail(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

export function registerLegalAdminRoutes(router, pool) {
  router.get('/legal/documents', async (_request, response, next) => {
    try {
      const result = await pool.query(
        `SELECT d.id, d.document_type, d.version, d.title, d.change_summary, d.published_at, u.full_name AS published_by_name,
                (SELECT COUNT(*) FROM legal_acceptances a WHERE a.document_id = d.id) AS acceptance_count
         FROM legal_documents d LEFT JOIN users u ON u.id = d.published_by
         ORDER BY d.document_type, d.version DESC`,
      );
      return response.json({ documents: result.rows.map((row) => ({ ...legalDocumentDto(row), publishedBy: row.published_by_name, acceptanceCount: Number(row.acceptance_count) })) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/legal/documents', requireCsrf, async (request, response, next) => {
    const input = parseWith(publishSchema, request.body);
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`legal:${input.data.document_type}`]);
      const latest = await client.query('SELECT COALESCE(MAX(version), 0) AS version FROM legal_documents WHERE document_type = $1', [input.data.document_type]);
      const inserted = await client.query(
        `INSERT INTO legal_documents (id, document_type, version, title, body, change_summary, published_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [randomUUID(), input.data.document_type, Number(latest.rows[0].version) + 1, input.data.title, input.data.body, input.data.change_summary, request.auth.user_id],
      );
      await client.query('COMMIT');
      return response.status(201).json({ document: legalDocumentDto(inserted.rows[0], { includeBody: true }) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });
}
