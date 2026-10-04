-- Award (decision) -> confirmation_pending (agency committed, guest details released) -> booked (seller confirmation number).
ALTER TABLE awards DROP CONSTRAINT IF EXISTS awards_status_check;
ALTER TABLE awards ALTER COLUMN status TYPE VARCHAR(24);
ALTER TABLE awards ADD CONSTRAINT awards_status_check
  CHECK (status IN ('awarded', 'confirmation_pending', 'booked', 'cancelled'));
ALTER TABLE awards ADD COLUMN IF NOT EXISTS booking_confirmed_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE awards ADD COLUMN IF NOT EXISTS seller_confirmation_number VARCHAR(64);
ALTER TABLE awards ADD COLUMN IF NOT EXISTS seller_confirmation_note VARCHAR(500);
ALTER TABLE awards ADD COLUMN IF NOT EXISTS seller_confirmed_at TIMESTAMPTZ;
ALTER TABLE awards ADD COLUMN IF NOT EXISTS seller_confirmed_by UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS awards_agency_idx ON awards(agency_organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS awards_seller_idx ON awards(seller_organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS booking_guest_details (
  award_id UUID PRIMARY KEY REFERENCES awards(id),
  -- AES-256-GCM ciphertext of the guest list; cleared when purged under retention.
  ciphertext TEXT,
  guest_count SMALLINT NOT NULL CHECK (guest_count > 0),
  trip_end_date DATE NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  released_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  revoked_reason VARCHAR(300),
  purged_at TIMESTAMPTZ,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((ciphertext IS NULL) = (purged_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS booking_guest_details_retention_idx ON booking_guest_details(trip_end_date) WHERE purged_at IS NULL;

CREATE TABLE IF NOT EXISTS booking_guest_access_log (
  id UUID PRIMARY KEY,
  award_id UUID NOT NULL REFERENCES awards(id),
  organization_id UUID REFERENCES organizations(id),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(16) NOT NULL CHECK (action IN ('released', 'viewed', 'corrected', 'revoked', 'restored', 'purged', 'voucher_opened')),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS booking_guest_access_log_award_idx ON booking_guest_access_log(award_id, created_at DESC);

CREATE TABLE IF NOT EXISTS booking_vouchers (
  id UUID PRIMARY KEY,
  award_id UUID NOT NULL REFERENCES awards(id),
  seller_organization_id UUID NOT NULL REFERENCES organizations(id),
  agency_organization_id UUID NOT NULL REFERENCES organizations(id),
  storage_provider VARCHAR(16) NOT NULL,
  storage_key VARCHAR(512) NOT NULL UNIQUE,
  original_filename VARCHAR(255) NOT NULL,
  content_type VARCHAR(100) NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  sha256 CHAR(64) NOT NULL,
  scan_status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending', 'clean', 'infected', 'failed')),
  scan_attempts SMALLINT NOT NULL DEFAULT 0,
  scan_next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scan_result VARCHAR(200),
  scanned_at TIMESTAMPTZ,
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Set when the stored file is removed (malware, retention); the row stays as the audit record.
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS booking_vouchers_award_idx ON booking_vouchers(award_id, created_at DESC);
CREATE INDEX IF NOT EXISTS booking_vouchers_scan_queue_idx
  ON booking_vouchers(scan_next_attempt_at) WHERE scan_status = 'pending' AND deleted_at IS NULL;

INSERT INTO schema_migrations(version) VALUES (17) ON CONFLICT (version) DO NOTHING;
