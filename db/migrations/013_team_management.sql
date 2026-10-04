ALTER TABLE organization_memberships DROP CONSTRAINT IF EXISTS organization_memberships_access_role_check;
ALTER TABLE organization_memberships ADD CONSTRAINT organization_memberships_access_role_check
  CHECK (access_role IN ('owner', 'admin', 'member', 'viewer'));

CREATE TABLE IF NOT EXISTS organization_invitations (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email VARCHAR(254) NOT NULL,
  access_role VARCHAR(16) NOT NULL CHECK (access_role IN ('admin', 'member', 'viewer')),
  token_hash CHAR(64) NOT NULL UNIQUE,
  invited_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  accepted_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS organization_invitations_one_pending_idx
  ON organization_invitations(organization_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS organization_audit_events (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(64) NOT NULL,
  target_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS organization_audit_events_org_idx ON organization_audit_events(organization_id, created_at DESC);

INSERT INTO schema_migrations(version) VALUES (13) ON CONFLICT (version) DO NOTHING;
