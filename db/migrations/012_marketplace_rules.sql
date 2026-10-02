CREATE TABLE IF NOT EXISTS platform_settings (
  setting_key VARCHAR(64) PRIMARY KEY,
  setting_value JSONB NOT NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS platform_setting_changes (
  id UUID PRIMARY KEY,
  setting_key VARCHAR(64) NOT NULL,
  old_value JSONB,
  new_value JSONB NOT NULL,
  changed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO platform_settings (setting_key, setting_value)
VALUES ('max_offers_per_request', '10'::jsonb)
ON CONFLICT (setting_key) DO NOTHING;

ALTER TABLE marketplace_requests DROP CONSTRAINT IF EXISTS marketplace_requests_status_check;
ALTER TABLE marketplace_requests ADD CONSTRAINT marketplace_requests_status_check
  CHECK (status IN ('draft', 'open', 'closed', 'awarded', 'expired', 'cancelled'));
ALTER TABLE marketplace_requests DROP CONSTRAINT IF EXISTS marketplace_requests_visibility_check;
ALTER TABLE marketplace_requests ADD CONSTRAINT marketplace_requests_visibility_check
  CHECK (visibility IN ('open', 'invite_only', 'open_and_invite'));
ALTER TABLE marketplace_requests ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS marketplace_requests_open_deadline_idx
  ON marketplace_requests(response_deadline) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS request_invitations (
  request_id UUID NOT NULL REFERENCES marketplace_requests(id) ON DELETE CASCADE,
  seller_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (request_id, seller_organization_id)
);

CREATE INDEX IF NOT EXISTS request_invitations_seller_idx ON request_invitations(seller_organization_id);

ALTER TABLE offers ADD COLUMN IF NOT EXISTS outcome_reason VARCHAR(300);

INSERT INTO schema_migrations(version) VALUES (12) ON CONFLICT (version) DO NOTHING;
