import { z } from 'zod';
import { decideProperty, propertyDto } from '../services/hotelProperties.js';
import { verificationDecisionSchema } from '../services/verificationDocuments.js';
import { parseWith } from '../utils/validation.js';
import { requireCsrf } from './auth.routes.js';

function fail(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

// Hotels added or moved after the account was approved are reviewed one by one.
export function registerHotelPropertyAdminRoutes(router, pool) {
  router.get('/hotel-properties/pending', async (_request, response, next) => {
    try {
      const result = await pool.query(
        `SELECT h.*, o.name AS organization_name, p.verification_status AS seller_status
         FROM hotel_properties h JOIN organizations o ON o.id = h.organization_id
         JOIN seller_profiles p ON p.organization_id = h.organization_id
         WHERE h.verification_status = 'pending' ORDER BY h.updated_at ASC LIMIT 200`,
      );
      const properties = [];
      for (const row of result.rows) {
        properties.push({ ...(await propertyDto(pool, row)), organizationId: row.organization_id, organizationName: row.organization_name, sellerStatus: row.seller_status });
      }
      return response.json({ properties });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/hotel-properties/:propertyId/decision', requireCsrf, async (request, response, next) => {
    if (!z.uuid().safeParse(request.params.propertyId).success) return fail(response, 404, 'PROPERTY_NOT_FOUND', 'Pending hotel was not found.');
    const input = parseWith(verificationDecisionSchema, request.body);
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const property = await decideProperty(client, { propertyId: request.params.propertyId, decision: input.data.decision, reason: input.data.reason, reviewerId: request.auth.user_id });
      if (!property) {
        await client.query('ROLLBACK');
        return fail(response, 404, 'PROPERTY_NOT_FOUND', 'Pending hotel was not found.');
      }
      await client.query('COMMIT');
      return response.json({ property: await propertyDto(client, property) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });
}
