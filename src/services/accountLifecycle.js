import { randomBytes } from 'node:crypto';
import { recordOrganizationEvent } from './organizationAudit.js';

const deletedUserName = 'Deleted user';
const closedOrganizationName = 'Closed organization';
const dayMs = 24 * 60 * 60 * 1000;

export function anonymizedEmail(userId) {
  // RFC 2606 reserves .invalid, so this address can never receive mail or collide with a real one.
  return `deleted-${userId}@deleted.invalid`;
}

export function deletionDate(from, graceDays) {
  return new Date(from.getTime() + graceDays * dayMs);
}

export async function anonymizeUser(client, userId) {
  const current = await client.query('SELECT email FROM users WHERE id = $1 AND anonymized_at IS NULL FOR UPDATE', [userId]);
  if (!current.rowCount) return false;
  const previousEmail = current.rows[0].email;
  const memberships = await client.query('DELETE FROM organization_memberships WHERE user_id = $1 RETURNING organization_id', [userId]);
  await client.query('DELETE FROM auth_sessions WHERE user_id = $1', [userId]);
  await client.query('DELETE FROM user_mfa WHERE user_id = $1', [userId]);
  await client.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [userId]);
  await client.query('DELETE FROM mfa_login_challenges WHERE user_id = $1', [userId]);
  await client.query('DELETE FROM auth_email_tokens WHERE user_id = $1', [userId]);
  await client.query('DELETE FROM notification_outbox WHERE recipient_user_id = $1', [userId]);
  await client.query(
    `UPDATE organization_invitations SET email = $2, revoked_at = COALESCE(revoked_at, NOW())
     WHERE lower(email) = lower($1) AND accepted_at IS NULL`,
    [previousEmail, anonymizedEmail(userId)],
  );
  await client.query(
    `UPDATE organization_audit_events SET details = details - 'email'
     WHERE lower(details->>'email') = lower($1)`,
    [previousEmail],
  );
  await client.query(
    `UPDATE users SET full_name = $2, email = $3, password_hash = $4, is_platform_admin = FALSE,
       anonymized_at = NOW(), deletion_scheduled_for = NULL
     WHERE id = $1`,
    [userId, deletedUserName, anonymizedEmail(userId), `!${randomBytes(24).toString('hex')}`],
  );
  for (const { organization_id: organizationId } of memberships.rows) {
    await recordOrganizationEvent(client, { organizationId, actorUserId: null, action: 'account.anonymized', targetUserId: userId, details: {} });
  }
  return true;
}

export async function closeOrganization(client, organizationId) {
  const closing = await client.query(
    'SELECT id FROM organizations WHERE id = $1 AND closed_at IS NULL FOR UPDATE',
    [organizationId],
  );
  if (!closing.rowCount) return false;
  const remaining = await client.query('SELECT user_id FROM organization_memberships WHERE organization_id = $1', [organizationId]);
  for (const member of remaining.rows) await anonymizeUser(client, member.user_id);
  await client.query('DELETE FROM seller_coverage WHERE organization_id = $1', [organizationId]);
  await client.query('DELETE FROM hotel_room_inventory WHERE organization_id = $1', [organizationId]);
  await client.query('DELETE FROM webhook_endpoints WHERE organization_id = $1', [organizationId]);
  // A closing agency is the controller of its guest data, so released guest details go with it; voucher files follow in the retention job.
  await client.query(
    `WITH purged AS (
       UPDATE booking_guest_details g SET ciphertext = NULL, purged_at = NOW(), updated_at = NOW()
       FROM awards a WHERE a.id = g.award_id AND a.agency_organization_id = $1 AND g.purged_at IS NULL
       RETURNING g.award_id
     )
     INSERT INTO booking_guest_access_log (id, award_id, organization_id, action)
     SELECT gen_random_uuid(), award_id, $1, 'purged' FROM purged`,
    [organizationId],
  );
  await client.query(
    'UPDATE organization_invitations SET revoked_at = COALESCE(revoked_at, NOW()) WHERE organization_id = $1 AND accepted_at IS NULL',
    [organizationId],
  );
  await client.query(
    `UPDATE seller_profiles SET coverage_destinations = ARRAY[]::text[], property_destination_id = NULL, property_city = NULL,
       verification_status = 'rejected', verification_reason = 'Organization closed.', updated_at = NOW()
     WHERE organization_id = $1`,
    [organizationId],
  );
  await client.query("UPDATE hotel_properties SET active = FALSE, name = 'Closed hotel', updated_at = NOW() WHERE organization_id = $1", [organizationId]);
  await client.query(
    'UPDATE organizations SET name = $2, closed_at = NOW(), closure_requested_at = COALESCE(closure_requested_at, NOW()) WHERE id = $1',
    [organizationId, closedOrganizationName],
  );
  await recordOrganizationEvent(client, { organizationId, actorUserId: null, action: 'organization.closed', details: {} });
  return true;
}

// Deletes an unverified sign-up and any organization it was the only member of.
export async function purgeUnverifiedUser(client, userId) {
  const user = await client.query('SELECT id FROM users WHERE id = $1 AND email_verified_at IS NULL FOR UPDATE', [userId]);
  if (!user.rowCount) return false;
  const soleOrganizations = await client.query(
    `SELECT m.organization_id FROM organization_memberships m
     WHERE m.user_id = $1 AND NOT EXISTS (
       SELECT 1 FROM organization_memberships other WHERE other.organization_id = m.organization_id AND other.user_id <> $1)`,
    [userId],
  );
  await client.query('DELETE FROM users WHERE id = $1', [userId]);
  for (const { organization_id: organizationId } of soleOrganizations.rows) {
    await client.query('DELETE FROM seller_verification_reviews WHERE seller_organization_id = $1', [organizationId]);
    await client.query('DELETE FROM seller_profile_changes WHERE seller_organization_id = $1', [organizationId]);
    await client.query('DELETE FROM organizations WHERE id = $1', [organizationId]);
  }
  return true;
}
