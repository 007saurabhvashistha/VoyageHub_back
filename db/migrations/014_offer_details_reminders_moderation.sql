ALTER TABLE offers ADD COLUMN IF NOT EXISTS deposit_percent SMALLINT CHECK (deposit_percent BETWEEN 0 AND 100);
ALTER TABLE offers ADD COLUMN IF NOT EXISTS balance_due_days_before_travel SMALLINT CHECK (balance_due_days_before_travel BETWEEN 0 AND 365);
ALTER TABLE offers ADD COLUMN IF NOT EXISTS payment_notes VARCHAR(500);
ALTER TABLE offers ADD COLUMN IF NOT EXISTS free_cancellation_until DATE;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS room_count SMALLINT CHECK (room_count BETWEEN 1 AND 50);
ALTER TABLE offers ADD COLUMN IF NOT EXISTS taxes_included BOOLEAN;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS availability_confirmed BOOLEAN;

CREATE TABLE IF NOT EXISTS offer_line_items (
  id UUID PRIMARY KEY,
  offer_id UUID NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  position SMALLINT NOT NULL,
  item_type VARCHAR(24) NOT NULL,
  description VARCHAR(200) NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_minor BIGINT NOT NULL CHECK (unit_price_minor >= 0),
  line_total_minor BIGINT NOT NULL CHECK (line_total_minor >= 0),
  UNIQUE (offer_id, position)
);

CREATE TABLE IF NOT EXISTS reminder_log (
  reminder_key VARCHAR(160) PRIMARY KEY,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS suspension_reason VARCHAR(500);

CREATE TABLE IF NOT EXISTS abuse_reports (
  id UUID PRIMARY KEY,
  reporter_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  reporter_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  target_type VARCHAR(16) NOT NULL CHECK (target_type IN ('request', 'offer', 'message', 'organization')),
  target_id UUID NOT NULL,
  target_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  category VARCHAR(32) NOT NULL,
  details VARCHAR(2000),
  status VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
  resolution_note VARCHAR(1000),
  resolved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS abuse_reports_one_open_idx
  ON abuse_reports(reporter_organization_id, target_type, target_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS abuse_reports_status_idx ON abuse_reports(status, created_at);

INSERT INTO schema_migrations(version) VALUES (14) ON CONFLICT (version) DO NOTHING;
