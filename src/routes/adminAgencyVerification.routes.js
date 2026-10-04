import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { agencyVerificationDto, requirementLabels, verificationDecisionSchema, verificationDocumentStatus } from '../services/verificationDocuments.js';
import { parseWith } from '../utils/validation.js';
import { requireCsrf } from './auth.routes.js';

const uuidSchema = z.uuid();

function fail(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

export function registerAgencyVerificationAdminRoutes(router, pool) {
  router.get('/agency-verifications/pending', async (_request, response, next) => {
    try {
      const result = await pool.query(
        `SELECT v.*, o.name AS organization_name, o.country_code
         FROM agency_verifications v JOIN organizations o ON o.id = v.organization_id
         WHERE v.status = 'pending' AND o.business_type = 'agency' AND o.closed_at IS NULL
         ORDER BY v.submitted_at ASC`,
      );
      const agencies = [];
      for (const agency of result.rows) {
        agencies.push({
          organizationId: agency.organization_id,
          organizationName: agency.organization_name,
          countryCode: agency.country_code,
          ...agencyVerificationDto(agency),
          documents: await verificationDocumentStatus(pool, { organizationId: agency.organization_id, businessType: 'agency', countryCode: agency.country_code }),
        });
      }
      return response.json({ agencies });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/agency-verifications/:organizationId/decision', requireCsrf, async (request, response, next) => {
    if (!uuidSchema.safeParse(request.params.organizationId).success) return fail(response, 400, 'VALIDATION_ERROR', 'Choose a valid agency.');
    const input = parseWith(verificationDecisionSchema, request.body);
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    const { decision, reason } = input.data;
    const organizationId = request.params.organizationId;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pending = await client.query(
        `SELECT o.country_code FROM agency_verifications v JOIN organizations o ON o.id = v.organization_id
         WHERE v.organization_id = $1 AND v.status = 'pending' FOR UPDATE OF v`,
        [organizationId],
      );
      if (!pending.rowCount) {
        await client.query('ROLLBACK');
        return fail(response, 404, 'PENDING_AGENCY_NOT_FOUND', 'Pending agency verification was not found.');
      }
      if (decision === 'approved') {
        const documents = await verificationDocumentStatus(client, { organizationId, businessType: 'agency', countryCode: pending.rows[0].country_code });
        if (!documents.complete) {
          await client.query('ROLLBACK');
          return fail(response, 409, 'DOCUMENTS_INCOMPLETE', `Approval needs every required document uploaded and scanned clean. Missing: ${requirementLabels(documents, documents.missing).join('; ')}.`);
        }
      }
      const updated = await client.query(
        `UPDATE agency_verifications SET status = $2, reason = $3, decided_at = NOW(), updated_at = NOW()
         WHERE organization_id = $1 RETURNING *`,
        [organizationId, decision, reason],
      );
      await client.query(
        'INSERT INTO agency_verification_reviews (id, agency_organization_id, admin_user_id, decision, reason) VALUES ($1, $2, $3, $4, $5)',
        [randomUUID(), organizationId, request.auth.user_id, decision, reason],
      );
      const verified = decision === 'approved';
      await client.query(`UPDATE organizations SET verified_at = ${verified ? 'NOW()' : 'NULL'} WHERE id = $1`, [organizationId]);
      // Published snapshots carry the badge, so sellers see the new state without a republish.
      await client.query(
        `UPDATE marketplace_requests SET seller_visible_snapshot = jsonb_set(seller_visible_snapshot, '{agencyVerified}', to_jsonb($2::boolean))
         WHERE agency_organization_id = $1 AND seller_visible_snapshot IS NOT NULL`,
        [organizationId, verified],
      );
      await client.query(
        'INSERT INTO notifications (id, organization_id, event_type, title, message, data) VALUES ($1, $2, $3, $4, $5, $6)',
        [randomUUID(), organizationId, 'agency_verification_decided', verified ? 'Agency verified' : 'Agency verification not approved', reason, JSON.stringify({ decision })],
      );
      await client.query('COMMIT');
      return response.json({ organizationId, verification: agencyVerificationDto(updated.rows[0]) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });
}
