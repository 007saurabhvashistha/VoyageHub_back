import { z } from 'zod';
import { config, isCountryCode } from '../config/index.js';
import { destinationKinds } from '../config/referenceData.js';
import { createDestination, destinationDto, findDestination, normalizeSearchText, refreshProfileDisplayNames, searchDestinations } from '../services/destinations.js';
import { parseWith } from '../utils/validation.js';
import { requireCsrf } from './auth.routes.js';

const kindValues = destinationKinds.map((kind) => kind.value);
const nameSchema = z.string().trim().min(2, 'Enter a name of at least 2 characters.').max(120);
const aliasesSchema = z.array(z.string().trim().min(2).max(120)).max(20).default([]);
const countrySchema = z.string().trim().toUpperCase().refine(isCountryCode, 'Choose a valid ISO country code.');
const listSchema = z.object({
  q: z.string().trim().max(120).default(''),
  country: countrySchema.optional(),
  kind: z.enum(kindValues).optional(),
});
const createSchema = z.object({
  kind: z.enum(kindValues, { error: 'Choose country, region or city.' }),
  name: nameSchema.optional(),
  country_code: countrySchema,
  parent_id: z.uuid().nullish(),
  aliases: aliasesSchema,
});
const updateSchema = z.object({
  name: nameSchema.optional(),
  aliases: aliasesSchema.optional(),
  active: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, 'Change at least one field.');

function fail(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

export function registerDestinationAdminRoutes(router, pool) {
  router.get('/destinations', async (request, response, next) => {
    const input = parseWith(listSchema, request.query);
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    try {
      const rows = await searchDestinations(pool, {
        query: input.data.q,
        countryCode: input.data.country ?? null,
        kinds: input.data.kind ? [input.data.kind] : null,
        limit: config.destinationSearchLimit * 5,
        includeInactive: true,
      });
      const total = await pool.query('SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE active) AS active FROM destinations');
      return response.json({ destinations: rows.map(destinationDto), totals: { all: Number(total.rows[0].total), active: Number(total.rows[0].active) } });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/destinations', requireCsrf, async (request, response, next) => {
    const input = parseWith(createSchema, request.body);
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    if (input.data.kind !== 'country' && !input.data.name) return fail(response, 400, 'VALIDATION_ERROR', 'Enter the destination name.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = await createDestination(client, {
        kind: input.data.kind,
        name: input.data.name,
        countryCode: input.data.country_code,
        parentId: input.data.parent_id ?? null,
        aliases: input.data.aliases,
        createdBy: request.auth.user_id,
      });
      await client.query('COMMIT');
      return response.status(201).json({ destination: destinationDto(row) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (['INVALID_PARENT', 'INVALID_COUNTRY'].includes(error.code)) return fail(response, 400, 'VALIDATION_ERROR', error.message);
      if (error.code === 'DUPLICATE_DESTINATION') return fail(response, 409, 'DUPLICATE_DESTINATION', error.message);
      return next(error);
    } finally {
      client.release();
    }
  });

  router.patch('/destinations/:destinationId', requireCsrf, async (request, response, next) => {
    if (!z.uuid().safeParse(request.params.destinationId).success) return fail(response, 400, 'VALIDATION_ERROR', 'Choose a valid destination.');
    const input = parseWith(updateSchema, request.body);
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query(
        `UPDATE destinations SET
           name = COALESCE($2, name),
           search_name = COALESCE($3, search_name),
           aliases = COALESCE($4::text[], aliases),
           active = COALESCE($5, active),
           updated_at = NOW()
         WHERE id = $1 RETURNING id`,
        [
          request.params.destinationId,
          input.data.name ?? null,
          input.data.name ? normalizeSearchText(input.data.name) : null,
          input.data.aliases ? input.data.aliases.map(normalizeSearchText) : null,
          input.data.active ?? null,
        ],
      );
      if (!updated.rowCount) {
        await client.query('ROLLBACK');
        return fail(response, 404, 'DESTINATION_NOT_FOUND', 'Destination was not found.');
      }
      if (input.data.name) await refreshProfileDisplayNames(client, { destinationId: request.params.destinationId });
      await client.query('COMMIT');
      return response.json({ destination: destinationDto(await findDestination(client, request.params.destinationId)) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });
}
