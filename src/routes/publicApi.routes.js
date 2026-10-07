import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config/index.js';
import { capabilities } from '../config/referenceData.js';
import { recordOrganizationEvent } from '../services/organizationAudit.js';
import { requireCapability } from '../services/permissions.js';
import { createRateLimiter } from '../utils/rateLimit.js';
import { loadSession, requireActiveAccount, requireCsrf, requireMfaForPlatformAdmin } from './auth.routes.js';

const uuidSchema = z.uuid();
const tokenNameSchema = z.object({ name: z.string().trim().min(1).max(80) });

function fail(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

function hashApiToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function tokenDto(row) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.token_prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

export function createApiTokenRouter({ pool }) {
  const router = Router();
  const manageLimiter = createRateLimiter(config.rateLimits.webhookManage, 'Too many API token changes. Try again later.');
  router.use((request, response, next) => loadSession(pool, request, response, next));
  router.use(requireMfaForPlatformAdmin);
  router.use((request, response, next) => requireActiveAccount(pool, request, response, next));
  router.use(requireCapability(capabilities.integrationManage));
  router.use((request, response, next) => request.method === 'GET' ? next() : requireCsrf(request, response, next));

  router.get('/', async (request, response, next) => {
    try {
      const result = await pool.query(
        `SELECT id, name, token_prefix, created_at, last_used_at, expires_at, revoked_at
         FROM organization_api_tokens WHERE organization_id = $1
         ORDER BY created_at DESC, id DESC`,
        [request.auth.organization_id],
      );
      return response.json({ tokens: result.rows.map(tokenDto), maxTokens: config.apiTokens.maxPerOrganization, ttlDays: config.apiTokens.ttlDays });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/', manageLimiter, async (request, response, next) => {
    const parsed = tokenNameSchema.safeParse(request.body);
    if (!parsed.success) return fail(response, 400, 'VALIDATION_ERROR', 'Enter a name up to 80 characters.');
    const client = await pool.connect();
    const token = `vh_live_${randomBytes(32).toString('base64url')}`;
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM organizations WHERE id = $1 FOR UPDATE', [request.auth.organization_id]);
      const count = await client.query(
        'SELECT COUNT(*) AS total FROM organization_api_tokens WHERE organization_id = $1 AND revoked_at IS NULL AND expires_at > NOW()',
        [request.auth.organization_id],
      );
      if (Number(count.rows[0].total) >= config.apiTokens.maxPerOrganization) {
        await client.query('ROLLBACK');
        return fail(response, 409, 'API_TOKEN_LIMIT', 'Revoke an active token before creating another.');
      }
      const created = await client.query(
        `INSERT INTO organization_api_tokens (id, organization_id, name, token_hash, token_prefix, created_by_user_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW() + make_interval(days => $7::int))
         RETURNING id, name, token_prefix, created_at, last_used_at, expires_at, revoked_at`,
        [randomUUID(), request.auth.organization_id, parsed.data.name, hashApiToken(token), token.slice(0, 16), request.auth.user_id, config.apiTokens.ttlDays],
      );
      await recordOrganizationEvent(client, { organizationId: request.auth.organization_id, actorUserId: request.auth.user_id, action: 'api_token.created', details: { name: parsed.data.name } });
      await client.query('COMMIT');
      return response.set('Cache-Control', 'no-store').status(201).json({ token, apiToken: tokenDto(created.rows[0]) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  router.delete('/:tokenId', manageLimiter, async (request, response, next) => {
    if (!uuidSchema.safeParse(request.params.tokenId).success) return fail(response, 400, 'VALIDATION_ERROR', 'Choose a valid API token.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const revoked = await client.query(
        `UPDATE organization_api_tokens SET revoked_at = NOW()
         WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL RETURNING name`,
        [request.params.tokenId, request.auth.organization_id],
      );
      if (!revoked.rowCount) {
        await client.query('ROLLBACK');
        return fail(response, 404, 'API_TOKEN_NOT_FOUND', 'Active API token was not found.');
      }
      await recordOrganizationEvent(client, { organizationId: request.auth.organization_id, actorUserId: request.auth.user_id, action: 'api_token.revoked', details: { name: revoked.rows[0].name } });
      await client.query('COMMIT');
      return response.status(204).end();
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  return router;
}

function parsePagination(query) {
  const page = query.page == null ? 1 : Number(query.page);
  const limit = query.limit == null ? config.apiTokens.maxPageSize : Number(query.limit);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > config.apiTokens.maxPageSize) return null;
  return { page, limit, offset: (page - 1) * limit };
}

function pageResult(rows, total, pagination) {
  return {
    items: rows,
    pagination: {
      page: pagination.page,
      limit: pagination.limit,
      total: Number(total),
      hasMore: pagination.offset + rows.length < Number(total),
    },
  };
}

export function createPublicApiRouter({ pool }) {
  const router = Router();
  const readLimiter = createRateLimiter(config.rateLimits.publicApi, 'Too many API requests. Try again shortly.');
  router.use(readLimiter);
  router.use(async (request, response, next) => {
    response.set('Cache-Control', 'private, no-store');
    if (!pool) return fail(response, 503, 'DATABASE_NOT_CONFIGURED', 'The public API is unavailable until the database is configured.');
    const match = /^Bearer (vh_live_[A-Za-z0-9_-]{43})$/.exec(request.get('authorization') ?? '');
    if (!match) return fail(response, 401, 'API_TOKEN_REQUIRED', 'Provide a valid API token in the Authorization bearer header.');
    try {
      const result = await pool.query(
        `UPDATE organization_api_tokens token SET last_used_at = NOW()
         FROM organizations organization
         WHERE token.token_hash = $1 AND token.organization_id = organization.id
           AND token.revoked_at IS NULL AND token.expires_at > NOW()
           AND organization.suspended_at IS NULL AND organization.closure_scheduled_for IS NULL
         RETURNING token.organization_id, organization.business_type`,
        [hashApiToken(match[1])],
      );
      if (!result.rowCount) return fail(response, 401, 'API_TOKEN_INVALID', 'The API token is invalid, expired, or revoked.');
      request.apiOrganization = result.rows[0];
      return next();
    } catch (error) {
      return next(error);
    }
  });

  router.get('/marketplace/requests', async (request, response, next) => {
    const pagination = parsePagination(request.query);
    if (!pagination) return fail(response, 400, 'VALIDATION_ERROR', 'Page and limit must be positive integers within the configured page-size limit.');
    const { organization_id: organizationId, business_type: businessType } = request.apiOrganization;
    const agency = businessType === 'agency';
    const where = agency ? 'r.agency_organization_id = $1' : "target.seller_organization_id = $1 AND r.status NOT IN ('draft', 'cancelled')";
    const from = agency ? 'FROM marketplace_requests r' : 'FROM marketplace_requests r JOIN request_targets target ON target.request_id = r.id';
    try {
      const count = await pool.query(`SELECT COUNT(*) AS total ${from} WHERE ${where}`, [organizationId]);
      const result = await pool.query(
        `SELECT r.id, r.request_code, r.status, r.destination, r.destination_country, r.travel_start_date, r.travel_end_date,
                r.travel_month, r.nights, r.adults, r.children, r.infants, r.group_type, r.hotel_category,
                r.room_count, r.meal_plan, r.services, r.budget_min_minor, r.budget_max_minor, r.budget_currency,
                r.response_deadline, r.published_at, r.created_at, r.updated_at${agency ? ', r.special_requests' : ', r.seller_visible_snapshot'}
         ${from} WHERE ${where} ORDER BY r.created_at DESC, r.id DESC LIMIT $2 OFFSET $3`,
        [organizationId, pagination.limit, pagination.offset],
      );
      return response.json(pageResult(result.rows, count.rows[0].total, pagination));
    } catch (error) {
      return next(error);
    }
  });

  router.get('/marketplace/offers', async (request, response, next) => {
    const pagination = parsePagination(request.query);
    if (!pagination) return fail(response, 400, 'VALIDATION_ERROR', 'Page and limit must be positive integers within the configured page-size limit.');
    const { organization_id: organizationId, business_type: businessType } = request.apiOrganization;
    const agency = businessType === 'agency';
    const where = agency ? 'r.agency_organization_id = $1' : 'offer.seller_organization_id = $1';
    try {
      const count = await pool.query(
        `SELECT COUNT(*) AS total FROM offers offer JOIN marketplace_requests r ON r.id = offer.request_id WHERE ${where}`,
        [organizationId],
      );
      const result = await pool.query(
        `SELECT offer.id, offer.request_id, r.request_code, r.destination, offer.seller_organization_id,
                offer.offer_kind, offer.total_minor, offer.rate_per_night_minor, offer.room_type, offer.currency,
                offer.inclusions, offer.exclusions, offer.meal_plan, offer.validity_until, offer.status,
                offer.outcome_reason, offer.created_at, offer.updated_at
         FROM offers offer JOIN marketplace_requests r ON r.id = offer.request_id
         WHERE ${where} ORDER BY offer.created_at DESC, offer.id DESC LIMIT $2 OFFSET $3`,
        [organizationId, pagination.limit, pagination.offset],
      );
      return response.json(pageResult(result.rows, count.rows[0].total, pagination));
    } catch (error) {
      return next(error);
    }
  });

  router.get('/marketplace/awards', async (request, response, next) => {
    const pagination = parsePagination(request.query);
    if (!pagination) return fail(response, 400, 'VALIDATION_ERROR', 'Page and limit must be positive integers within the configured page-size limit.');
    const { organization_id: organizationId, business_type: businessType } = request.apiOrganization;
    const organizationColumn = businessType === 'agency' ? 'award.agency_organization_id' : 'award.seller_organization_id';
    try {
      const count = await pool.query(`SELECT COUNT(*) AS total FROM awards award WHERE ${organizationColumn} = $1`, [organizationId]);
      const result = await pool.query(
        `SELECT award.id, award.request_id, request.request_code, request.destination, award.offer_id,
                offer.total_minor, offer.rate_per_night_minor, offer.currency, award.status,
                award.created_at, award.booking_confirmed_at, award.seller_confirmed_at
         FROM awards award JOIN marketplace_requests request ON request.id = award.request_id
         JOIN offers offer ON offer.id = award.offer_id
         WHERE ${organizationColumn} = $1 ORDER BY award.created_at DESC, award.id DESC LIMIT $2 OFFSET $3`,
        [organizationId, pagination.limit, pagination.offset],
      );
      return response.json(pageResult(result.rows, count.rows[0].total, pagination));
    } catch (error) {
      return next(error);
    }
  });

  return router;
}