-- One request may be awarded to several sellers (for example hotel from a hotelier, ground package from a DMC), one award per seller.
ALTER TABLE awards DROP CONSTRAINT IF EXISTS awards_request_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS awards_request_seller_idx ON awards(request_id, seller_organization_id);

-- An award undone within the undo window is deleted; this keeps what was decided and who reversed it.
CREATE TABLE IF NOT EXISTS award_reversals (
  id UUID PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES marketplace_requests(id) ON DELETE CASCADE,
  agency_organization_id UUID NOT NULL REFERENCES organizations(id),
  undone_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reason VARCHAR(300),
  awards JSONB NOT NULL,
  awarded_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS award_reversals_request_idx ON award_reversals(request_id, created_at DESC);

INSERT INTO schema_migrations(version) VALUES (23) ON CONFLICT (version) DO NOTHING;
