import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config/index.js';
import { loadSession, requireActiveAccount, requireCsrf, requireMfaForPlatformAdmin } from './auth.routes.js';
import { alertDeliveryModes, capabilities, destinationKinds } from '../config/referenceData.js';
import { requireCapability } from '../services/permissions.js';
import { createProperty, listProperties, propertyDto, propertyInputSchema, propertyUpdateSchema, updateProperty } from '../services/hotelProperties.js';
import { detectAllowedFileType, displayFilename, downloadDisposition, sha256Hex } from '../services/verificationDocuments.js';
import { createRateLimiter } from '../utils/rateLimit.js';
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

export function createHotelPropertyRouter({ pool, storage = null }) {
  const router = sessionRouter(pool);
  const uploadLimiter = createRateLimiter(config.rateLimits.documentUpload, 'Too many hotel photo uploads. Try again later.');
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.documents.maxBytes, files: 1 } }).single('file');
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

  router.post('/:propertyId/photos', requireCapability(capabilities.profileManage), uploadLimiter, (request, response, next) => {
    if (!storage) return fail(response, 503, 'STORAGE_NOT_CONFIGURED', 'Hotel photos need private file storage.');
    return upload(request, response, (error) => error ? fail(response, error.code === 'LIMIT_FILE_SIZE' ? 413 : 400, error.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : 'VALIDATION_ERROR', 'Upload one supported hotel photo within the configured file-size limit.') : next());
  }, async (request, response, next) => {
    if (!z.uuid().safeParse(request.params.propertyId).success) return fail(response, 404, 'PROPERTY_NOT_FOUND', 'Hotel was not found.');
    if (!request.file?.buffer?.length) return fail(response, 400, 'VALIDATION_ERROR', 'Attach a hotel photo.');
    const detected = await detectAllowedFileType(request.file.buffer).catch(() => null);
    if (!detected || !['image/jpeg', 'image/png'].includes(detected.mime)) return fail(response, 415, 'UNSUPPORTED_FILE_TYPE', 'Hotel photos must be JPEG or PNG images that pass the malware scan.');
    const client = await pool.connect();
    let storageKey;
    try {
      await client.query('BEGIN');
      const property = await client.query('SELECT id FROM hotel_properties WHERE id = $1 AND organization_id = $2 FOR UPDATE', [request.params.propertyId, request.auth.organization_id]);
      if (!property.rowCount) {
        await client.query('ROLLBACK');
        return fail(response, 404, 'PROPERTY_NOT_FOUND', 'Hotel was not found.');
      }
      const count = await client.query('SELECT COUNT(*)::int AS total FROM hotel_property_photos WHERE property_id = $1 AND deleted_at IS NULL', [property.rows[0].id]);
      if (count.rows[0].total >= config.hotels.maxPropertyPhotos) {
        await client.query('ROLLBACK');
        return fail(response, 409, 'PHOTO_LIMIT_REACHED', `This hotel can have up to ${config.hotels.maxPropertyPhotos} photos.`);
      }
      const id = randomUUID();
      const filename = displayFilename(request.file.originalname, `hotel-photo.${detected.ext}`);
      storageKey = `${storage.keyPrefix}/hotel-properties/${property.rows[0].id}/${id}.${detected.ext}`;
      await storage.putObject({ key: storageKey, body: request.file.buffer, contentType: detected.mime });
      const inserted = await client.query(
        `INSERT INTO hotel_property_photos (id, property_id, organization_id, storage_provider, storage_key, original_filename, content_type, size_bytes, sha256, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [id, property.rows[0].id, request.auth.organization_id, storage.provider, storageKey, filename, detected.mime, request.file.size, sha256Hex(request.file.buffer), request.auth.user_id],
      );
      await client.query('COMMIT');
      return response.status(201).json({ photo: { id, filename, contentType: detected.mime, sizeBytes: request.file.size, scanStatus: 'pending', createdAt: inserted.rows[0].created_at } });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (storageKey) await storage.deleteObject(storageKey).catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  router.post('/:propertyId/photos/:photoId/download-url', async (request, response, next) => {
    if (!storage) return fail(response, 503, 'STORAGE_NOT_CONFIGURED', 'Hotel photos need private file storage.');
    if (!z.uuid().safeParse(request.params.propertyId).success || !z.uuid().safeParse(request.params.photoId).success) return fail(response, 404, 'PHOTO_NOT_FOUND', 'Photo was not found.');
    try {
      const result = await pool.query(
        `SELECT photo.*, property.organization_id AS property_organization_id, property.active, property.verification_status
         FROM hotel_property_photos photo JOIN hotel_properties property ON property.id = photo.property_id
         WHERE photo.id = $1 AND photo.property_id = $2 AND photo.deleted_at IS NULL`,
        [request.params.photoId, request.params.propertyId],
      );
      const photo = result.rows[0];
      const owner = photo?.property_organization_id === request.auth.organization_id;
      const publicProperty = request.auth.business_type === 'agency' && photo?.active && photo?.verification_status === 'approved';
      if (!photo || (!owner && !publicProperty) || photo.scan_status !== 'clean') return fail(response, 404, 'PHOTO_NOT_FOUND', 'Photo is not available.');
      if (photo.storage_provider !== storage.provider) return fail(response, 409, 'STORAGE_PROVIDER_CHANGED', 'This photo belongs to a storage provider that is no longer configured.');
      const expiresInSeconds = config.documents.downloadUrlTtlSeconds;
      const url = await storage.createDownloadUrl(photo.storage_key, { expiresInSeconds, contentDisposition: downloadDisposition(photo.original_filename), contentType: photo.content_type });
      return response.json({ url, expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString() });
    } catch (error) {
      return next(error);
    }
  });

  router.delete('/:propertyId/photos/:photoId', requireCapability(capabilities.profileManage), async (request, response, next) => {
    if (!storage) return fail(response, 503, 'STORAGE_NOT_CONFIGURED', 'Hotel photos need private file storage.');
    try {
      const photo = await pool.query('SELECT * FROM hotel_property_photos WHERE id = $1 AND property_id = $2 AND organization_id = $3 AND deleted_at IS NULL', [request.params.photoId, request.params.propertyId, request.auth.organization_id]);
      if (!photo.rowCount) return fail(response, 404, 'PHOTO_NOT_FOUND', 'Photo was not found.');
      if (photo.rows[0].storage_provider !== storage.provider) return fail(response, 409, 'STORAGE_PROVIDER_CHANGED', 'This photo belongs to a storage provider that is no longer configured.');
      await storage.deleteObject(photo.rows[0].storage_key);
      await pool.query('UPDATE hotel_property_photos SET deleted_at = NOW() WHERE id = $1', [request.params.photoId]);
      return response.status(204).end();
    } catch (error) {
      return next(error);
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
