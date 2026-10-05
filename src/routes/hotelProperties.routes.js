import { Router } from 'express';
import { z } from 'zod';
import { loadSession, requireActiveAccount, requireCsrf, requireMfaForPlatformAdmin } from './auth.routes.js';
import { alertDeliveryModes, capabilities, destinationKinds } from '../config/referenceData.js';
import { requireCapability } from '../services/permissions.js';
import { createProperty, listProperties, propertyDto, propertyInputSchema, propertyUpdateSchema, updateProperty } from '../services/hotelProperties.js';
import { parseWith } from '../utils/validation.js';

function fail(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

function sessionRouter(pool) {
  const router = Router();
  router.use((request, response, next) => loadSession(pool, request, response, next));
  router.use(requireMfaForPlatformAdmin);
  router.use((request, response, next) => requireActiveAccount(pool, request, response, next));
  router.use((request, response, next) => request.method === 'GET' ? next() : requireCsrf(request, response, next));
  return router;
}

export function createHotelPropertyRouter({ pool }) {
  const router = sessionRouter(pool);
  router.use((request, response, next) => request.auth.business_type === 'hotelier'
    ? next()
    : fail(response, 403, 'ROLE_FORBIDDEN', 'Only hotel accounts can manage hotels.'));

  router.get('/', async (request, response, next) => {
    try {
      return response.json({ properties: await listProperties(pool, request.auth.organization_id) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/', requireCapability(capabilities.profileManage), async (request, response, next) => {
    const input = parseWith(propertyInputSchema, request.body);
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await createProperty(client, { organizationId: request.auth.organization_id, input: input.data });
      if (result.error) {
        await client.query('ROLLBACK');
        return fail(response, result.status, result.code, result.error);
      }
      await client.query('COMMIT');
      return response.status(201).json({ property: await propertyDto(client, result.property) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  router.patch('/:propertyId', requireCapability(capabilities.profileManage), async (request, response, next) => {
    if (!z.uuid().safeParse(request.params.propertyId).success) return fail(response, 404, 'PROPERTY_NOT_FOUND', 'Hotel was not found.');
    const input = parseWith(propertyUpdateSchema, request.body);
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await updateProperty(client, { organizationId: request.auth.organization_id, propertyId: request.params.propertyId, input: input.data });
      if (result.error) {
        await client.query('ROLLBACK');
        return fail(response, result.status, result.code, result.error);
      }
      await client.query('COMMIT');
      return response.json({ property: await propertyDto(client, result.property) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  return router;
}

const alertPreferenceSchema = z.object({
  delivery: z.enum(alertDeliveryModes.map((mode) => mode.value), { error: 'Choose instant, digest or no alerts.' }),
  destination_kinds: z.array(z.enum(destinationKinds.map((kind) => kind.value))).max(destinationKinds.length).nullish()
    .transform((value) => value?.length ? [...new Set(value)] : null),
  include_partial: z.boolean().default(true),
  property_ids: z.array(z.uuid()).max(5000).nullish().transform((value) => value?.length ? [...new Set(value)] : null),
});

function preferenceDto(row) {
  return {
    delivery: row?.delivery ?? 'instant',
    destinationKinds: row?.destination_kinds ?? null,
    includePartial: row?.include_partial ?? true,
    propertyIds: row?.property_ids ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

export function createAlertPreferenceRouter({ pool }) {
  const router = sessionRouter(pool);
  router.use((request, response, next) => ['dmc', 'hotelier'].includes(request.auth.business_type)
    ? next()
    : fail(response, 403, 'ROLE_FORBIDDEN', 'Lead alert preferences are only available to DMCs and hotels.'));

  router.get('/', async (request, response, next) => {
    try {
      const result = await pool.query('SELECT * FROM seller_alert_preferences WHERE organization_id = $1', [request.auth.organization_id]);
      return response.json({ preferences: preferenceDto(result.rows[0]) });
    } catch (error) {
      return next(error);
    }
  });

  router.put('/', requireCapability(capabilities.profileManage), async (request, response, next) => {
    const input = parseWith(alertPreferenceSchema, request.body);
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    const { delivery, destination_kinds: kinds, include_partial: includePartial, property_ids: propertyIds } = input.data;
    try {
      if (propertyIds) {
        if (request.auth.business_type !== 'hotelier') return fail(response, 400, 'VALIDATION_ERROR', 'Only hotel accounts can filter alerts by hotel.');
        const owned = await pool.query('SELECT COUNT(*) AS total FROM hotel_properties WHERE organization_id = $1 AND id = ANY($2::uuid[])', [request.auth.organization_id, propertyIds]);
        if (Number(owned.rows[0].total) !== propertyIds.length) return fail(response, 400, 'VALIDATION_ERROR', 'Choose hotels from your own list.');
      }
      const result = await pool.query(
        `INSERT INTO seller_alert_preferences (organization_id, delivery, destination_kinds, include_partial, property_ids, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (organization_id) DO UPDATE SET delivery = EXCLUDED.delivery, destination_kinds = EXCLUDED.destination_kinds,
           include_partial = EXCLUDED.include_partial, property_ids = EXCLUDED.property_ids, updated_by = EXCLUDED.updated_by, updated_at = NOW()
         RETURNING *`,
        [request.auth.organization_id, delivery, kinds, includePartial, propertyIds, request.auth.user_id],
      );
      return response.json({ preferences: preferenceDto(result.rows[0]) });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
