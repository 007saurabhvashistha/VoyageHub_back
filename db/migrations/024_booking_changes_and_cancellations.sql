-- A booking change is an auditable proposal; amendments do not silently rewrite the original marketplace request.
CREATE TABLE IF NOT EXISTS booking_change_requests (
  id UUID PRIMARY KEY,
  award_id UUID NOT NULL REFERENCES awards(id) ON DELETE CASCADE,
  initiated_by_organization_id UUID NOT NULL REFERENCES organizations(id),
  initiated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  change_type VARCHAR(16) NOT NULL CHECK (change_type IN ('amendment', 'cancellation')),
  proposed_changes JSONB NOT NULL DEFAULT '{}'::jsonb,
  message VARCHAR(1000) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'withdrawn')),
  response_note VARCHAR(1000),
  responded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  responded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS booking_change_one_pending_idx
  ON booking_change_requests(award_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS booking_change_award_idx ON booking_change_requests(award_id, created_at DESC);

INSERT INTO schema_migrations(version) VALUES (24) ON CONFLICT (version) DO NOTHING;
