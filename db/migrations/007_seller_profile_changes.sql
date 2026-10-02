CREATE TABLE IF NOT EXISTS seller_profile_changes (
  id UUID PRIMARY KEY,
  seller_organization_id UUID NOT NULL REFERENCES organizations(id),
  changed_by_user_id UUID NOT NULL REFERENCES users(id),
  previous_profile JSONB NOT NULL,
  updated_profile JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS seller_profile_changes_org_idx
  ON seller_profile_changes(seller_organization_id, created_at DESC);

INSERT INTO schema_migrations(version) VALUES (7) ON CONFLICT (version) DO NOTHING;