CREATE TABLE IF NOT EXISTS organization_api_tokens (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(80) NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  token_prefix VARCHAR(16) NOT NULL,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS organization_api_tokens_active_idx
  ON organization_api_tokens(organization_id, created_at DESC)
  WHERE revoked_at IS NULL;

INSERT INTO schema_migrations(version) VALUES (32) ON CONFLICT (version) DO NOTHING;