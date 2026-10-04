import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { recordOrganizationEvent } from '../services/organizationAudit.js';
import { windDownMarketplaceActivity } from '../services/organizationLifecycle.js';
import { parseWith } from '../utils/validation.js';
import { requireCsrf } from './auth.routes.js';

const reportStatuses = ['open', 'actioned', 'dismissed'];
const reasonSchema = z.object({ reason: z.string().trim().min(5, 'Give a reason of at least 5 characters.').max(500) });
const resolutionSchema = z.object({
  decision: z.enum(['actioned', 'dismissed'], { error: 'Decision must be actioned or dismissed.' }),
  note: z.string().trim().min(5, 'Add a resolution note of at least 5 characters.').max(1000),
});
const listSchema = z.object({
  search: z.string().trim().max(120).default(''),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

function fail(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

async function notify(client, organizationId, eventType, title, message, data) {
  await client.query(
    'INSERT INTO notifications (id, organization_id, event_type, title, message, data) VALUES ($1, $2, $3, $4, $5, $6)',
    [randomUUID(), organizationId, eventType, title, message, JSON.stringify(data)],
  );
}

export function registerModerationRoutes(router, pool) {
  router.get('/reports', async (request, response, next) => {
    const status = typeof request.query.status === 'string' && request.query.status ? request.query.status : 'open';
    if (!reportStatuses.includes(status)) return fail(response, 400, 'VALIDATION_ERROR', 'Choose a supported report status.');
    try {
      const result = await pool.query(
        `SELECT a.*, reporter.name AS reporter_name, target.name AS target_name, target.business_type AS target_business_type,
                target.suspended_at AS target_suspended_at, resolver.full_name AS resolver_name
         FROM abuse_reports a
         JOIN organizations reporter ON reporter.id = a.reporter_organization_id
         JOIN organizations target ON target.id = a.target_organization_id
         LEFT JOIN users resolver ON resolver.id = a.resolved_by_user_id
         WHERE a.status = $1 ORDER BY a.created_at ASC LIMIT 200`,
        [status],
      );
      return response.json({ reports: result.rows.map((row) => ({
        id: row.id,
        targetType: row.target_type,
        targetId: row.target_id,
        category: row.category,
        details: row.details,
        status: row.status,
        reporterName: row.reporter_name,
        target: { organizationId: row.target_organization_id, name: row.target_name, businessType: row.target_business_type, suspended: Boolean(row.target_suspended_at) },
        resolutionNote: row.resolution_note,
        resolvedBy: row.resolver_name,
        resolvedAt: row.resolved_at,
        createdAt: row.created_at,
      })) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/reports/:reportId/resolve', requireCsrf, async (request, response, next) => {
    if (!z.uuid().safeParse(request.params.reportId).success) return fail(response, 400, 'VALIDATION_ERROR', 'Choose a valid report.');
    const input = parseWith(resolutionSchema, request.body);
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    try {
      const resolved = await pool.query(
        `UPDATE abuse_reports SET status = $2, resolution_note = $3, resolved_by_user_id = $4, resolved_at = NOW()
         WHERE id = $1 AND status = 'open' RETURNING id, status, reporter_organization_id`,
        [request.params.reportId, input.data.decision, input.data.note, request.auth.user_id],
      );
      if (!resolved.rowCount) return fail(response, 404, 'REPORT_NOT_OPEN', 'Open report was not found.');
      await notify(pool, resolved.rows[0].reporter_organization_id, 'report_resolved', 'Your report was reviewed', `Outcome: ${input.data.decision}`, { reportId: resolved.rows[0].id });
      return response.json({ report: { id: resolved.rows[0].id, status: resolved.rows[0].status } });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/organizations', async (request, response, next) => {
    const input = parseWith(listSchema, request.query);
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    try {
      const result = await pool.query(
        `SELECT o.id, o.name, o.business_type, o.country_code, o.created_at, o.suspended_at, o.suspension_reason,
                p.verification_status,
                (SELECT COUNT(*) FROM abuse_reports a WHERE a.target_organization_id = o.id AND a.status = 'open') AS open_reports,
                (SELECT COUNT(*) FROM organization_memberships m WHERE m.organization_id = o.id) AS member_count
         FROM organizations o LEFT JOIN seller_profiles p ON p.organization_id = o.id
         WHERE ($1::text = '' OR o.name ILIKE '%' || $1::text || '%')
         ORDER BY (o.suspended_at IS NOT NULL) DESC, open_reports DESC, o.name ASC LIMIT $2`,
        [input.data.search, input.data.limit],
      );
      return response.json({ organizations: result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        businessType: row.business_type,
        countryCode: row.country_code,
        verificationStatus: row.verification_status ?? null,
        openReports: Number(row.open_reports),
        memberCount: Number(row.member_count),
        suspendedAt: row.suspended_at,
        suspensionReason: row.suspension_reason,
        createdAt: row.created_at,
      })) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/organizations/:organizationId/suspend', requireCsrf, async (request, response, next) => {
    const organizationId = request.params.organizationId;
    if (!z.uuid().safeParse(organizationId).success) return fail(response, 400, 'VALIDATION_ERROR', 'Choose a valid organization.');
    if (organizationId === request.auth.organization_id) return fail(response, 409, 'CANNOT_SUSPEND_OWN_ORGANIZATION', 'You cannot suspend your own organization.');
    const input = parseWith(reasonSchema, request.body);
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const suspended = await client.query(
        `UPDATE organizations SET suspended_at = NOW(), suspension_reason = $2
         WHERE id = $1 AND suspended_at IS NULL RETURNING id, name`,
        [organizationId, input.data.reason],
      );
      if (!suspended.rowCount) {
        await client.query('ROLLBACK');
        return fail(response, 409, 'ORGANIZATION_NOT_ACTIVE', 'Organization was not found or is already suspended.');
      }
      await client.query('DELETE FROM auth_sessions WHERE organization_id = $1', [organizationId]);
      const { withdrawnOffers, cancelledRequests } = await windDownMarketplaceActivity(client, organizationId, {
        offerNotice: { title: 'Seller removed from marketplace', message: 'An offer was withdrawn after a platform review' },
        requestNotice: { title: 'Request cancelled', message: 'Cancelled after a platform review' },
      });
      await recordOrganizationEvent(client, { organizationId, actorUserId: request.auth.user_id, action: 'organization.suspended', details: { reason: input.data.reason, withdrawnOffers, cancelledRequests } });
      await client.query('COMMIT');
      return response.json({ organization: { id: organizationId, suspended: true }, withdrawnOffers, cancelledRequests });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  router.post('/organizations/:organizationId/reinstate', requireCsrf, async (request, response, next) => {
    const organizationId = request.params.organizationId;
    if (!z.uuid().safeParse(organizationId).success) return fail(response, 400, 'VALIDATION_ERROR', 'Choose a valid organization.');
    const input = parseWith(reasonSchema, request.body);
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const reinstated = await client.query(
        'UPDATE organizations SET suspended_at = NULL, suspension_reason = NULL WHERE id = $1 AND suspended_at IS NOT NULL RETURNING id',
        [organizationId],
      );
      if (!reinstated.rowCount) {
        await client.query('ROLLBACK');
        return fail(response, 409, 'ORGANIZATION_NOT_SUSPENDED', 'Organization was not found or is not suspended.');
      }
      await recordOrganizationEvent(client, { organizationId, actorUserId: request.auth.user_id, action: 'organization.reinstated', details: { reason: input.data.reason } });
      await client.query('COMMIT');
      return response.json({ organization: { id: organizationId, suspended: false } });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });
}
