import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { config } from '../config/index.js';
import { capabilities } from '../config/referenceData.js';
import { capabilitiesFor } from '../services/permissions.js';
import { deletionDate } from '../services/accountLifecycle.js';
import { recordOrganizationEvent } from '../services/organizationAudit.js';
import { windDownMarketplaceActivity } from '../services/organizationLifecycle.js';
import { getSetting } from '../services/platformSettings.js';
import { createRateLimiter } from '../utils/rateLimit.js';
import { parseWith } from '../utils/validation.js';
import { loadSession, requireCsrf } from './auth.routes.js';

const deletionSchema = z.object({ password: z.string().min(1, 'Enter your password to confirm.').max(200) });

function fail(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

async function buildExport(pool, auth) {
  const userId = auth.user_id;
  const organizationId = auth.organization_id;
  const [user, memberships, sessions, acceptances, messages, reports, auditEvents] = await Promise.all([
    pool.query(
      `SELECT u.id, u.full_name, u.email, u.created_at, u.email_verified_at, u.deletion_scheduled_for,
              COALESCE(mfa.enabled, FALSE) AS mfa_enabled
       FROM users u LEFT JOIN user_mfa mfa ON mfa.user_id = u.id WHERE u.id = $1`,
      [userId],
    ),
    pool.query(
      `SELECT o.id, o.name, o.business_type, o.country_code, m.access_role, m.created_at
       FROM organization_memberships m JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = $1`,
      [userId],
    ),
    pool.query('SELECT created_at, expires_at FROM auth_sessions WHERE user_id = $1 ORDER BY created_at DESC', [userId]),
    pool.query(
      `SELECT d.document_type, d.version, d.title, a.accepted_at FROM legal_acceptances a
       JOIN legal_documents d ON d.id = a.document_id WHERE a.user_id = $1 ORDER BY a.accepted_at`,
      [userId],
    ),
    pool.query(
      `SELECT r.request_code, m.body, m.created_at FROM request_messages m
       JOIN marketplace_requests r ON r.id = m.request_id WHERE m.sender_user_id = $1 ORDER BY m.created_at`,
      [userId],
    ),
    pool.query(
      'SELECT target_type, category, details, status, created_at FROM abuse_reports WHERE reporter_user_id = $1 ORDER BY created_at',
      [userId],
    ),
    pool.query(
      `SELECT action, details, created_at FROM organization_audit_events
       WHERE actor_user_id = $1 OR target_user_id = $1 ORDER BY created_at`,
      [userId],
    ),
  ]);
  const profile = user.rows[0];
  const data = {
    format: 'voyagehub-account-export',
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    user: {
      id: profile.id,
      fullName: profile.full_name,
      email: profile.email,
      createdAt: profile.created_at,
      emailVerifiedAt: profile.email_verified_at,
      mfaEnabled: Boolean(profile.mfa_enabled),
      deletionScheduledFor: profile.deletion_scheduled_for,
    },
    memberships: memberships.rows.map((row) => ({ organizationId: row.id, organizationName: row.name, businessType: row.business_type, countryCode: row.country_code, role: row.access_role, joinedAt: row.created_at })),
    sessions: sessions.rows.map((row) => ({ createdAt: row.created_at, expiresAt: row.expires_at })),
    legalAcceptances: acceptances.rows.map((row) => ({ documentType: row.document_type, version: row.version, title: row.title, acceptedAt: row.accepted_at })),
    messagesSent: messages.rows.map((row) => ({ requestCode: row.request_code, body: row.body, createdAt: row.created_at })),
    reportsFiled: reports.rows.map((row) => ({ targetType: row.target_type, category: row.category, details: row.details, status: row.status, createdAt: row.created_at })),
    auditEvents: auditEvents.rows.map((row) => ({ action: row.action, details: row.details, createdAt: row.created_at })),
  };

  // Organization records are business data; only owners and managers may export them.
  if (capabilitiesFor(auth.access_role).includes(capabilities.profileManage)) {
    const [requests, offers, lineItems, options, attachments, awards, sellerProfile, coverage, inventory, documents] = await Promise.all([
      pool.query('SELECT * FROM marketplace_requests WHERE agency_organization_id = $1 ORDER BY created_at', [organizationId]),
      pool.query('SELECT f.*, r.request_code FROM offers f JOIN marketplace_requests r ON r.id = f.request_id WHERE f.seller_organization_id = $1 ORDER BY f.created_at', [organizationId]),
      pool.query(
        `SELECT li.* FROM offer_line_items li JOIN offers f ON f.id = li.offer_id
         WHERE f.seller_organization_id = $1 ORDER BY li.offer_id, li.position`,
        [organizationId],
      ),
      pool.query(
        `SELECT o.* FROM offer_options o JOIN offers f ON f.id = o.offer_id
         WHERE f.seller_organization_id = $1 ORDER BY o.offer_id, o.position`,
        [organizationId],
      ),
      pool.query(
        `SELECT offer_id, message_id, original_filename, content_type, size_bytes, scan_status, created_at, deleted_at
         FROM marketplace_attachments WHERE owner_organization_id = $1 ORDER BY created_at`,
        [organizationId],
      ),
      pool.query('SELECT * FROM awards WHERE agency_organization_id = $1 OR seller_organization_id = $1 ORDER BY created_at', [organizationId]),
      pool.query('SELECT verification_status, verification_reason, property_city, updated_at FROM seller_profiles WHERE organization_id = $1', [organizationId]),
      pool.query(
        `SELECT d.name, d.kind, d.country_code FROM seller_coverage c JOIN destinations d ON d.id = c.destination_id
         WHERE c.organization_id = $1 ORDER BY d.name`,
        [organizationId],
      ),
      pool.query('SELECT inventory_date, room_type, available_rooms, nightly_rate_minor, currency FROM hotel_room_inventory WHERE organization_id = $1 ORDER BY inventory_date', [organizationId]),
      pool.query(
        `SELECT document_type, original_filename, content_type, size_bytes, scan_status, created_at, superseded_at, deleted_at
         FROM organization_documents WHERE organization_id = $1 ORDER BY created_at`,
        [organizationId],
      ),
    ]);
    const itemsByOffer = new Map();
    for (const item of lineItems.rows) itemsByOffer.set(item.offer_id, [...(itemsByOffer.get(item.offer_id) ?? []), item]);
    const optionsByOffer = new Map();
    for (const option of options.rows) optionsByOffer.set(option.offer_id, [...(optionsByOffer.get(option.offer_id) ?? []), option]);
    data.organization = {
      id: organizationId,
      name: auth.organization_name,
      businessType: auth.business_type,
      countryCode: auth.country_code,
      sellerProfile: sellerProfile.rows[0] ?? null,
      coverage: coverage.rows,
      requests: requests.rows,
      offers: offers.rows.map((row) => ({ ...row, line_items: itemsByOffer.get(row.id) ?? [], options: optionsByOffer.get(row.id) ?? [] })),
      awards: awards.rows,
      attachments: attachments.rows,
      hotelInventory: inventory.rows,
      verificationDocuments: documents.rows,
    };
  }
  return data;
}

export function createAccountRouter({ pool, cookieName, secureCookies }) {
  const router = Router();
  const exportLimiter = createRateLimiter(config.rateLimits.accountExport, 'Too many exports. Try again later.');
  const passwordLimiter = createRateLimiter(config.rateLimits.auth, 'Too many failed attempts. Try again later.', { skipSuccessfulRequests: true });
  router.use((request, response, next) => loadSession(pool, request, response, next));
  router.use((request, response, next) => request.method === 'GET' ? next() : requireCsrf(request, response, next));

  router.get('/export', exportLimiter, async (request, response, next) => {
    try {
      const data = await buildExport(pool, request.auth);
      await recordOrganizationEvent(pool, { organizationId: request.auth.organization_id, actorUserId: request.auth.user_id, action: 'account.exported', targetUserId: request.auth.user_id });
      response.set('cache-control', 'no-store');
      response.attachment(`voyagehub-export-${data.exportedAt.slice(0, 10)}.json`);
      return response.json(data);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/deletion', passwordLimiter, async (request, response, next) => {
    const input = parseWith(deletionSchema, request.body);
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    if (request.auth.is_platform_admin) return fail(response, 409, 'ADMIN_ACCOUNT', 'Platform administrators must be demoted before their account can be deleted.');
    if (request.auth.deletion_requested_at) return fail(response, 409, 'DELETION_ALREADY_SCHEDULED', 'Account deletion is already scheduled.');
    const client = await pool.connect();
    try {
      const credentials = await client.query('SELECT password_hash FROM users WHERE id = $1', [request.auth.user_id]);
      if (!(await bcrypt.compare(input.data.password, credentials.rows[0].password_hash))) {
        return fail(response, 401, 'INVALID_PASSWORD', 'The password is incorrect.');
      }
      await client.query('BEGIN');
      const members = await client.query(
        'SELECT user_id, access_role FROM organization_memberships WHERE organization_id = $1 FOR UPDATE',
        [request.auth.organization_id],
      );
      const otherMembers = members.rows.filter((row) => row.user_id !== request.auth.user_id);
      const otherOwners = otherMembers.filter((row) => row.access_role === 'owner');
      if (request.auth.access_role === 'owner' && otherMembers.length && !otherOwners.length) {
        await client.query('ROLLBACK');
        return fail(response, 409, 'OWNERSHIP_TRANSFER_REQUIRED', 'Make another team member an owner, or remove the other members, before deleting your account.');
      }
      const graceDays = await getSetting(client, 'account_deletion_grace_days');
      const scheduledFor = deletionDate(new Date(), graceDays);
      await client.query('UPDATE users SET deletion_requested_at = NOW(), deletion_scheduled_for = $2 WHERE id = $1', [request.auth.user_id, scheduledFor]);
      let windDown = { withdrawnOffers: 0, cancelledRequests: 0 };
      const closesOrganization = otherMembers.length === 0;
      if (closesOrganization) {
        await client.query(
          'UPDATE organizations SET closure_requested_at = NOW(), closure_scheduled_for = $2 WHERE id = $1',
          [request.auth.organization_id, scheduledFor],
        );
        await client.query(
          'UPDATE organization_invitations SET revoked_at = NOW() WHERE organization_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL',
          [request.auth.organization_id],
        );
        windDown = await windDownMarketplaceActivity(client, request.auth.organization_id, {
          offerNotice: { title: 'Offer withdrawn', message: 'The seller closed their account' },
          requestNotice: { title: 'Request cancelled', message: 'The agency closed their account' },
        });
      }
      await client.query('DELETE FROM auth_sessions WHERE user_id = $1', [request.auth.user_id]);
      await recordOrganizationEvent(client, {
        organizationId: request.auth.organization_id,
        actorUserId: request.auth.user_id,
        action: 'account.deletion_requested',
        targetUserId: request.auth.user_id,
        details: { scheduledFor: scheduledFor.toISOString(), closesOrganization, ...windDown },
      });
      await client.query('COMMIT');
      response.clearCookie(cookieName, { httpOnly: true, secure: secureCookies, sameSite: 'lax', path: '/' });
      return response.status(202).json({ scheduledFor, closesOrganization, ...windDown });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  router.post('/deletion/cancel', async (request, response, next) => {
    if (!request.auth.deletion_requested_at) return fail(response, 409, 'DELETION_NOT_SCHEDULED', 'Account deletion is not scheduled.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE users SET deletion_requested_at = NULL, deletion_scheduled_for = NULL WHERE id = $1 AND anonymized_at IS NULL',
        [request.auth.user_id],
      );
      await client.query(
        'UPDATE organizations SET closure_requested_at = NULL, closure_scheduled_for = NULL WHERE id = $1 AND closed_at IS NULL',
        [request.auth.organization_id],
      );
      await recordOrganizationEvent(client, { organizationId: request.auth.organization_id, actorUserId: request.auth.user_id, action: 'account.deletion_cancelled', targetUserId: request.auth.user_id });
      await client.query('COMMIT');
      return response.json({ cancelled: true });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  return router;
}
