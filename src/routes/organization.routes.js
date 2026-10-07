import { randomBytes, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { createRateLimiter } from '../utils/rateLimit.js';
import { z } from 'zod';
import { config } from '../config/index.js';
import { capabilities, memberRoles } from '../config/referenceData.js';
import { requireCapability } from '../services/permissions.js';
import { recordOrganizationEvent } from '../services/organizationAudit.js';
import { hashEmailActionToken } from '../utils/emailActionTokens.js';
import { parseWith } from '../utils/validation.js';
import { loadSession, requireActiveAccount, requireCsrf, requireMfaForPlatformAdmin } from './auth.routes.js';

const roleValues = memberRoles.map((role) => role.value);
const invitableRoles = roleValues.filter((role) => role !== 'owner');
const invitationSchema = z.object({
  email: z.email('Enter a valid business email address.').max(254).transform((value) => value.trim().toLowerCase()),
  role: z.enum(invitableRoles, { error: 'Choose a supported team role.' }),
});
const roleChangeSchema = z.object({ role: z.enum(roleValues, { error: 'Choose a supported team role.' }) });
const uuidSchema = z.uuid();

function fail(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

function invitationDto(row) {
  return { id: row.id, email: row.email, role: row.access_role, expiresAt: row.expires_at, createdAt: row.created_at, invitedBy: row.invited_by_name ?? null };
}

export function createOrganizationRouter({ pool }) {
  const router = Router();
  const invitationLimiter = createRateLimiter(config.rateLimits.invitation, 'Too many invitations. Try again later.');
  router.use((request, response, next) => loadSession(pool, request, response, next));
  router.use(requireMfaForPlatformAdmin);
  router.use((request, response, next) => requireActiveAccount(pool, request, response, next));
  router.use((request, response, next) => request.method === 'GET' ? next() : requireCsrf(request, response, next));

  router.get('/members', async (request, response, next) => {
    try {
      const members = await pool.query(
        `SELECT u.id, u.full_name, u.email, m.access_role, m.created_at
         FROM organization_memberships m JOIN users u ON u.id = m.user_id
         WHERE m.organization_id = $1 ORDER BY m.created_at, u.full_name`,
        [request.auth.organization_id],
      );
      return response.json({
        members: members.rows.map((row) => ({ userId: row.id, fullName: row.full_name, email: row.email, role: row.access_role, joinedAt: row.created_at, isYou: row.id === request.auth.user_id })),
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/invitations', requireCapability(capabilities.teamManage), async (request, response, next) => {
    try {
      const result = await pool.query(
        `SELECT i.*, u.full_name AS invited_by_name FROM organization_invitations i
         LEFT JOIN users u ON u.id = i.invited_by_user_id
         WHERE i.organization_id = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > NOW()
         ORDER BY i.created_at DESC`,
        [request.auth.organization_id],
      );
      return response.json({ invitations: result.rows.map(invitationDto) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/invitations', invitationLimiter, requireCapability(capabilities.teamManage), async (request, response, next) => {
    const input = parseWith(invitationSchema, request.body);
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    const { email, role } = input.data;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM organizations WHERE id = $1 FOR UPDATE', [request.auth.organization_id]);
      const existingMember = await client.query(
        `SELECT 1 FROM organization_memberships membership JOIN users user_account ON user_account.id = membership.user_id
         WHERE membership.organization_id = $1 AND user_account.email = $2`,
        [request.auth.organization_id, email],
      );
      if (existingMember.rowCount) {
        await client.query('ROLLBACK');
        return fail(response, 409, 'ALREADY_MEMBER', 'This person is already a member of your organization.');
      }
      await client.query(
        `UPDATE organization_invitations SET revoked_at = NOW()
         WHERE organization_id = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= NOW()`,
        [request.auth.organization_id, email],
      );
      const pending = await client.query(
        `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE email = $2) AS same_email FROM organization_invitations
         WHERE organization_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
        [request.auth.organization_id, email],
      );
      if (Number(pending.rows[0].same_email)) {
        await client.query('ROLLBACK');
        return fail(response, 409, 'INVITATION_PENDING', 'This email already has a pending invitation. Revoke it to send a new one.');
      }
      if (Number(pending.rows[0].total) >= config.maxPendingInvitations) {
        await client.query('ROLLBACK');
        return fail(response, 409, 'TOO_MANY_PENDING_INVITATIONS', `Revoke an invitation first. At most ${config.maxPendingInvitations} can be pending.`);
      }
      const token = randomBytes(32).toString('base64url');
      const created = await client.query(
        `INSERT INTO organization_invitations (id, organization_id, email, access_role, token_hash, invited_by_user_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW() + make_interval(hours => $7::int)) RETURNING *`,
        [randomUUID(), request.auth.organization_id, email, role, hashEmailActionToken(token), request.auth.user_id, config.invitationTtlHours],
      );
      await recordOrganizationEvent(client, { organizationId: request.auth.organization_id, actorUserId: request.auth.user_id, action: 'invitation.created', details: { email, role } });
      await client.query('COMMIT');
      const acceptPath = `/accept-invite?${new URLSearchParams({ token })}`;
      return response.status(201).json({ invitation: invitationDto({ ...created.rows[0], invited_by_name: request.auth.full_name }), acceptPath });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  router.delete('/invitations/:invitationId', requireCapability(capabilities.teamManage), async (request, response, next) => {
    if (!uuidSchema.safeParse(request.params.invitationId).success) return fail(response, 400, 'VALIDATION_ERROR', 'Choose a valid invitation.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const revoked = await client.query(
        `UPDATE organization_invitations SET revoked_at = NOW()
         WHERE id = $1 AND organization_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING email, access_role`,
        [request.params.invitationId, request.auth.organization_id],
      );
      if (!revoked.rowCount) {
        await client.query('ROLLBACK');
        return fail(response, 404, 'INVITATION_NOT_FOUND', 'Pending invitation was not found.');
      }
      await recordOrganizationEvent(client, { organizationId: request.auth.organization_id, actorUserId: request.auth.user_id, action: 'invitation.revoked', details: { email: revoked.rows[0].email, role: revoked.rows[0].access_role } });
      await client.query('COMMIT');
      return response.status(204).end();
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  async function loadTargetMember(client, request, response) {
    if (!uuidSchema.safeParse(request.params.userId).success) {
      fail(response, 400, 'VALIDATION_ERROR', 'Choose a valid team member.');
      return null;
    }
    if (request.params.userId === request.auth.user_id) {
      fail(response, 409, 'CANNOT_CHANGE_SELF', 'Ask another owner or manager to change your own access.');
      return null;
    }
    const members = await client.query(
      'SELECT user_id, access_role FROM organization_memberships WHERE organization_id = $1 FOR UPDATE',
      [request.auth.organization_id],
    );
    const target = members.rows.find((row) => row.user_id === request.params.userId);
    if (!target) {
      fail(response, 404, 'MEMBER_NOT_FOUND', 'Team member was not found.');
      return null;
    }
    if (target.access_role === 'owner' && request.auth.access_role !== 'owner') {
      fail(response, 403, 'PERMISSION_DENIED', 'Only an owner can change another owner.');
      return null;
    }
    return { target, ownerCount: members.rows.filter((row) => row.access_role === 'owner').length };
  }

  router.patch('/members/:userId', requireCapability(capabilities.teamManage), async (request, response, next) => {
    const input = parseWith(roleChangeSchema, request.body);
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    if (input.data.role === 'owner' && request.auth.access_role !== 'owner') return fail(response, 403, 'PERMISSION_DENIED', 'Only an owner can grant owner access.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const loaded = await loadTargetMember(client, request, response);
      if (!loaded) {
        await client.query('ROLLBACK');
        return undefined;
      }
      if (loaded.target.access_role === 'owner' && input.data.role !== 'owner' && loaded.ownerCount <= 1) {
        await client.query('ROLLBACK');
        return fail(response, 409, 'LAST_OWNER', 'An organization must keep at least one owner.');
      }
      await client.query('UPDATE organization_memberships SET access_role = $3 WHERE organization_id = $1 AND user_id = $2', [request.auth.organization_id, request.params.userId, input.data.role]);
      await recordOrganizationEvent(client, { organizationId: request.auth.organization_id, actorUserId: request.auth.user_id, action: 'member.role_changed', targetUserId: request.params.userId, details: { from: loaded.target.access_role, to: input.data.role } });
      await client.query('COMMIT');
      return response.json({ member: { userId: request.params.userId, role: input.data.role } });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  router.delete('/members/:userId', requireCapability(capabilities.teamManage), async (request, response, next) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const loaded = await loadTargetMember(client, request, response);
      if (!loaded) {
        await client.query('ROLLBACK');
        return undefined;
      }
      if (loaded.target.access_role === 'owner' && loaded.ownerCount <= 1) {
        await client.query('ROLLBACK');
        return fail(response, 409, 'LAST_OWNER', 'An organization must keep at least one owner.');
      }
      await client.query('DELETE FROM organization_memberships WHERE organization_id = $1 AND user_id = $2', [request.auth.organization_id, request.params.userId]);
      await recordOrganizationEvent(client, { organizationId: request.auth.organization_id, actorUserId: request.auth.user_id, action: 'member.removed', targetUserId: request.params.userId, details: { role: loaded.target.access_role } });
      await client.query('COMMIT');
      return response.status(204).end();
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  router.get('/audit-events', requireCapability(capabilities.teamManage), async (request, response, next) => {
    try {
      const result = await pool.query(
        `SELECT e.id, e.action, e.details, e.created_at, actor.full_name AS actor_name, target.full_name AS target_name
         FROM organization_audit_events e
         LEFT JOIN users actor ON actor.id = e.actor_user_id
         LEFT JOIN users target ON target.id = e.target_user_id
         WHERE e.organization_id = $1 ORDER BY e.created_at DESC, e.id DESC LIMIT 100`,
        [request.auth.organization_id],
      );
      return response.json({ events: result.rows.map((row) => ({ id: row.id, action: row.action, details: row.details, actorName: row.actor_name, targetName: row.target_name, createdAt: row.created_at })) });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
