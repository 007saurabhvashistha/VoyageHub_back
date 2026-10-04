-- Trip details on an open request can change; offers confirmed for an older trip version must be re-confirmed before award.
ALTER TABLE marketplace_requests ADD COLUMN IF NOT EXISTS trip_version INTEGER NOT NULL DEFAULT 1 CHECK (trip_version >= 1);
ALTER TABLE marketplace_requests ADD COLUMN IF NOT EXISTS trip_changed_at TIMESTAMPTZ;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS confirmed_trip_version INTEGER NOT NULL DEFAULT 1 CHECK (confirmed_trip_version >= 1);
ALTER TABLE offers ADD COLUMN IF NOT EXISTS reconfirmed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS request_trip_changes (
  id UUID PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES marketplace_requests(id) ON DELETE CASCADE,
  trip_version INTEGER NOT NULL,
  changed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  previous_trip JSONB NOT NULL,
  current_trip JSONB NOT NULL,
  note VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (request_id, trip_version)
);

CREATE TABLE IF NOT EXISTS agency_verifications (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  status VARCHAR(16) NOT NULL DEFAULT 'unsubmitted' CHECK (status IN ('unsubmitted', 'pending', 'approved', 'rejected')),
  reason VARCHAR(500),
  submitted_at TIMESTAMPTZ,
  decided_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS agency_verifications_queue_idx ON agency_verifications(status, submitted_at);

CREATE TABLE IF NOT EXISTS agency_verification_reviews (
  id UUID PRIMARY KEY,
  agency_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  admin_user_id UUID NOT NULL REFERENCES users(id),
  decision VARCHAR(16) NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reason VARCHAR(500) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS agency_verification_reviews_org_idx ON agency_verification_reviews(agency_organization_id, created_at DESC);

-- Agencies already carrying the badge keep it as an approved verification.
INSERT INTO agency_verifications (organization_id, status, decided_at, updated_at)
SELECT id, 'approved', verified_at, verified_at FROM organizations
WHERE business_type = 'agency' AND verified_at IS NOT NULL
ON CONFLICT (organization_id) DO NOTHING;

INSERT INTO schema_migrations(version) VALUES (19) ON CONFLICT (version) DO NOTHING;
