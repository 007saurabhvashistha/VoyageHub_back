ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_admin BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS seller_verification_reviews (
  id UUID PRIMARY KEY,
  seller_organization_id UUID NOT NULL REFERENCES organizations(id),
  admin_user_id UUID NOT NULL REFERENCES users(id),
  decision VARCHAR(16) NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reason VARCHAR(500) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS seller_verification_pending_idx
  ON seller_profiles(verification_status, updated_at DESC);

INSERT INTO schema_migrations(version) VALUES (3) ON CONFLICT (version) DO NOTHING;