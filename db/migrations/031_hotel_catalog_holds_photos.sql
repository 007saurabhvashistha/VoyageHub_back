ALTER TABLE hotel_properties ADD COLUMN IF NOT EXISTS room_types TEXT[] NOT NULL DEFAULT ARRAY[]::text[];
ALTER TABLE hotel_properties ADD COLUMN IF NOT EXISTS meal_plans TEXT[] NOT NULL DEFAULT ARRAY[]::text[];
ALTER TABLE hotel_properties ADD COLUMN IF NOT EXISTS facilities TEXT[] NOT NULL DEFAULT ARRAY[]::text[];
ALTER TABLE hotel_properties ADD COLUMN IF NOT EXISTS ownership_check_status VARCHAR(16) NOT NULL DEFAULT 'pending';
ALTER TABLE hotel_properties ADD CONSTRAINT hotel_properties_ownership_check_status_check
  CHECK (ownership_check_status IN ('pending', 'evidence_ready', 'verified', 'rejected'));
UPDATE hotel_properties SET ownership_check_status = CASE
  WHEN verification_status = 'approved' THEN 'verified'
  WHEN verification_status = 'rejected' THEN 'rejected'
  ELSE 'pending'
END;

CREATE TABLE IF NOT EXISTS hotel_property_photos (
  id UUID PRIMARY KEY,
  property_id UUID NOT NULL REFERENCES hotel_properties(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  storage_provider VARCHAR(16) NOT NULL,
  storage_key VARCHAR(512) NOT NULL UNIQUE,
  original_filename VARCHAR(255) NOT NULL,
  content_type VARCHAR(100) NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  sha256 CHAR(64) NOT NULL,
  scan_status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending', 'clean', 'infected', 'failed')),
  scan_attempts SMALLINT NOT NULL DEFAULT 0,
  scan_next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scan_result VARCHAR(200),
  scanned_at TIMESTAMPTZ,
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS hotel_property_photos_property_idx ON hotel_property_photos(property_id, created_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS hotel_property_photos_scan_idx ON hotel_property_photos(scan_next_attempt_at) WHERE scan_status = 'pending' AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS hotel_room_holds (
  id UUID PRIMARY KEY,
  award_id UUID NOT NULL UNIQUE REFERENCES awards(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  property_id UUID NOT NULL REFERENCES hotel_properties(id),
  request_id UUID NOT NULL REFERENCES marketplace_requests(id),
  offer_id UUID NOT NULL REFERENCES offers(id),
  room_type VARCHAR(120) NOT NULL,
  rooms SMALLINT NOT NULL CHECK (rooms BETWEEN 1 AND 50),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'confirmed', 'booked', 'released', 'expired')),
  expires_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_date > start_date),
  CHECK ((status = 'held') = (expires_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS hotel_room_holds_capacity_idx ON hotel_room_holds(organization_id, room_type, start_date, end_date) WHERE status IN ('held', 'confirmed', 'booked');
CREATE INDEX IF NOT EXISTS hotel_room_holds_expiry_idx ON hotel_room_holds(expires_at) WHERE status = 'held';

INSERT INTO schema_migrations(version) VALUES (31) ON CONFLICT (version) DO NOTHING;