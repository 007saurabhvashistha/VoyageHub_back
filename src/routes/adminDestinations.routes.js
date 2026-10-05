import multer from 'multer';
import { z } from 'zod';
import { config, isCountryCode } from '../config/index.js';
import { destinationKinds } from '../config/referenceData.js';
import { createDestination, destinationDto, findDestination, listChildren, loadLevelLabels, loadSecondaryParents, moveDestination, normalizeSearchText, refreshProfileDisplayNames, replaceSecondaryParents, searchDestinations } from '../services/destinations.js';
import { importFeaturedDestinations } from '../services/featuredDestinations.js';
import { recordOperationRun } from '../services/databaseBackup.js';
import { parseWith } from '../utils/validation.js';
import { requireCsrf } from './auth.routes.js';

const kindValues = destinationKinds.map((kind) => kind.value);
const nameSchema = z.string().trim().min(2, 'Enter a name of at least 2 characters.').max(120);
const aliasesSchema = z.array(z.string().trim().min(2).max(120)).max(config.geonames.maxAliases).default([]);
const countrySchema = z.string().trim().toUpperCase().refine(isCountryCode, 'Choose a valid ISO country code.');
const listSchema = z.object({
  q: z.string().trim().max(120).default(''),
  country: countrySchema.optional(),
  kind: z.enum(kindValues).optional(),
  featured: z.stringbool().optional(),
});
const createSchema = z.object({
  kind: z.enum(kindValues, { error: 'Choose a destination level.' }),
  name: nameSchema.optional(),
  country_code: countrySchema,
  parent_id: z.uuid().nullish(),
  aliases: aliasesSchema,
  featured: z.boolean().default(false),
});
const updateSchema = z.object({
  name: nameSchema.optional(),
  aliases: z.array(z.string().trim().min(2).max(120)).max(config.geonames.maxAliases).optional(),
  active: z.boolean().optional(),
  featured: z.boolean().optional(),
  parent_id: z.uuid().optional(),
  secondary_parent_ids: z.array(z.uuid()).max(10).optional(),
}).refine((value) => Object.keys(value).length > 0, 'Change at least one field.');
const levelsSchema = z.object({
  levels: z.array(z.object({
    kind: z.enum(kindValues),
    label: z.string().trim().min(2, 'Each level label needs at least 2 characters.').max(60),
    enabled: z.boolean().default(true),
  })).min(1).max(kindValues.length),
});
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } }).single('file');

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
        featuredOnly: input.data.featured ?? false,
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
        featured: input.data.featured,
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
           featured = COALESCE($6, featured),
           admin_edited_at = NOW(),
           updated_at = NOW()
         WHERE id = $1 RETURNING id`,
        [
          request.params.destinationId,
          input.data.name ?? null,
          input.data.name ? normalizeSearchText(input.data.name) : null,
          input.data.aliases ? input.data.aliases.map(normalizeSearchText) : null,
          input.data.active ?? null,
          input.data.featured ?? null,
        ],
      );
      if (!updated.rowCount) {
        await client.query('ROLLBACK');
        return fail(response, 404, 'DESTINATION_NOT_FOUND', 'Destination was not found.');
      }
      if (input.data.parent_id) await moveDestination(client, request.params.destinationId, input.data.parent_id);
      if (input.data.secondary_parent_ids) await replaceSecondaryParents(client, request.params.destinationId, input.data.secondary_parent_ids, { createdBy: request.auth.user_id });
      if (input.data.name) await refreshProfileDisplayNames(client, { destinationId: request.params.destinationId });
      await client.query('COMMIT');
      return response.json({ destination: await destinationDetail(client, request.params.destinationId) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (['INVALID_PARENT', 'DESTINATION_NOT_FOUND'].includes(error.code)) return fail(response, 400, 'VALIDATION_ERROR', error.message);
      return next(error);
    } finally {
      client.release();
    }
  });

  router.get('/destinations/:destinationId', async (request, response, next) => {
    if (!z.uuid().safeParse(request.params.destinationId).success) return fail(response, 404, 'DESTINATION_NOT_FOUND', 'Destination was not found.');
    try {
      const destination = await destinationDetail(pool, request.params.destinationId);
      if (!destination) return fail(response, 404, 'DESTINATION_NOT_FOUND', 'Destination was not found.');
      const children = await listChildren(pool, request.params.destinationId, { limit: config.destinationChildrenLimit, includeInactive: true });
      return response.json({ destination, children: children.map(destinationDto) });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/destination-levels', async (request, response, next) => {
    const country = countrySchema.safeParse(request.query.country);
    if (!country.success) return fail(response, 400, 'VALIDATION_ERROR', 'Choose a valid ISO country code.');
    try {
      const [labels] = await loadLevelLabels(pool, [country.data]);
      return response.json(labels);
    } catch (error) {
      return next(error);
    }
  });

  router.put('/destination-levels/:countryCode', requireCsrf, async (request, response, next) => {
    const country = countrySchema.safeParse(request.params.countryCode);
    if (!country.success) return fail(response, 400, 'VALIDATION_ERROR', 'Choose a valid ISO country code.');
    const input = parseWith(levelsSchema, request.body);
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const level of input.data.levels) {
        await client.query(
          `INSERT INTO country_destination_levels (country_code, kind, label, enabled, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (country_code, kind) DO UPDATE SET label = EXCLUDED.label, enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
          [country.data, level.kind, level.label, level.enabled, request.auth.user_id],
        );
      }
      await client.query('COMMIT');
      const [labels] = await loadLevelLabels(client, [country.data]);
      return response.json(labels);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  router.post('/destinations/featured-import', (request, response, next) => csvUpload(request, response, (error) => {
    if (error) return fail(response, 400, 'VALIDATION_ERROR', 'Upload one CSV file of up to 2 MB.');
    return next();
  }), requireCsrf, async (request, response, next) => {
    if (!request.file) return fail(response, 400, 'VALIDATION_ERROR', 'Choose a CSV file to upload.');
    const defaultCountry = request.body?.country_code ? countrySchema.safeParse(request.body.country_code) : null;
    if (defaultCountry && !defaultCountry.success) return fail(response, 400, 'VALIDATION_ERROR', 'Choose a valid default country code.');
    const startedAt = new Date();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await importFeaturedDestinations(client, {
        csvText: request.file.buffer.toString('utf8'),
        defaultCountryCode: defaultCountry?.data ?? null,
        maxRows: config.routing.featuredImportMaxRows,
        maxAliases: config.geonames.maxAliases,
      });
      if (result.error) {
        await client.query('ROLLBACK');
        return fail(response, 400, 'VALIDATION_ERROR', result.error);
      }
      await recordOperationRun(client, { kind: 'featured_import', status: 'succeeded', startedAt, finishedAt: new Date(), details: { ...result.totals, file: request.file.originalname?.slice(0, 200) ?? null } });
      await client.query('COMMIT');
      return response.json(result);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });
}

async function destinationDetail(db, id) {
  const row = await findDestination(db, id);
  if (!row) return null;
  return { ...destinationDto(row), secondaryParents: (await loadSecondaryParents(db, id)).map(destinationDto), leadCount: Number(row.lead_count ?? 0) };
}
