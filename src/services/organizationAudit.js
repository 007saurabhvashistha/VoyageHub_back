import { randomUUID } from 'node:crypto';

export async function recordOrganizationEvent(client, { organizationId, actorUserId, action, targetUserId = null, details = {} }) {
  await client.query(
    `INSERT INTO organization_audit_events (id, organization_id, actor_user_id, action, target_user_id, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), organizationId, actorUserId, action, targetUserId, JSON.stringify(details)],
  );
}
