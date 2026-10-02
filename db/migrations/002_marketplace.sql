ALTER TABLE organizations ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS seller_profiles (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  coverage_destinations TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  property_city VARCHAR(120),
  verification_status VARCHAR(16) NOT NULL DEFAULT 'pending'
    CHECK (verification_status IN ('pending', 'approved', 'rejected')),
  verification_reason VARCHAR(500),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS marketplace_requests (
  id UUID PRIMARY KEY,
  request_code VARCHAR(16) NOT NULL UNIQUE,
  agency_organization_id UUID NOT NULL REFERENCES organizations(id),
  destination VARCHAR(120) NOT NULL,
  destination_country CHAR(2) NOT NULL,
  travel_start_date DATE,
  travel_end_date DATE,
  travel_month VARCHAR(7),
  nights SMALLINT NOT NULL CHECK (nights BETWEEN 1 AND 90),
  adults SMALLINT NOT NULL CHECK (adults BETWEEN 1 AND 100),
  children SMALLINT NOT NULL DEFAULT 0 CHECK (children BETWEEN 0 AND 80),
  infants SMALLINT NOT NULL DEFAULT 0 CHECK (infants BETWEEN 0 AND 40),
  group_type VARCHAR(24) NOT NULL CHECK (group_type IN ('family', 'honeymoon', 'friends', 'corporate', 'school', 'seniors', 'solo', 'other')),
  hotel_category SMALLINT CHECK (hotel_category IN (3, 4, 5)),
  room_count SMALLINT CHECK (room_count BETWEEN 1 AND 50),
  meal_plan VARCHAR(24) CHECK (meal_plan IN ('room_only', 'breakfast', 'half_board', 'full_board', 'all_inclusive')),
  services TEXT[] NOT NULL,
  budget_min_minor BIGINT,
  budget_max_minor BIGINT,
  budget_currency CHAR(3),
  response_deadline TIMESTAMPTZ NOT NULL,
  visibility VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (visibility IN ('open', 'invite_only')),
  status VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'awarded', 'closed', 'cancelled')),
  seller_visible_snapshot JSONB,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (travel_start_date IS NOT NULL AND travel_end_date IS NOT NULL AND travel_month IS NULL AND travel_end_date > travel_start_date)
    OR (travel_start_date IS NULL AND travel_end_date IS NULL AND travel_month ~ '^\\d{4}-(0[1-9]|1[0-2])$')
  ),
  CHECK ((budget_min_minor IS NULL AND budget_max_minor IS NULL AND budget_currency IS NULL)
    OR (budget_min_minor IS NOT NULL AND budget_max_minor IS NOT NULL AND budget_currency IS NOT NULL AND budget_min_minor >= 0 AND budget_max_minor >= budget_min_minor))
);

CREATE TABLE IF NOT EXISTS request_targets (
  request_id UUID NOT NULL REFERENCES marketplace_requests(id) ON DELETE CASCADE,
  seller_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  matched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  viewed_at TIMESTAMPTZ,
  declined_at TIMESTAMPTZ,
  decline_reason VARCHAR(300),
  PRIMARY KEY (request_id, seller_organization_id)
);

CREATE INDEX IF NOT EXISTS request_targets_seller_idx ON request_targets(seller_organization_id, matched_at DESC);
CREATE INDEX IF NOT EXISTS marketplace_requests_agency_idx ON marketplace_requests(agency_organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS offers (
  id UUID PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES marketplace_requests(id) ON DELETE CASCADE,
  seller_organization_id UUID NOT NULL REFERENCES organizations(id),
  offer_kind VARCHAR(12) NOT NULL CHECK (offer_kind IN ('land_package', 'hotel_room')),
  total_minor BIGINT,
  rate_per_night_minor BIGINT,
  room_type VARCHAR(120),
  currency CHAR(3) NOT NULL,
  inclusions TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  exclusions TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  meal_plan VARCHAR(24),
  cancellation_policy VARCHAR(1000),
  validity_until TIMESTAMPTZ NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'shortlisted', 'accepted', 'rejected', 'withdrawn')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((offer_kind = 'land_package' AND total_minor > 0 AND rate_per_night_minor IS NULL)
    OR (offer_kind = 'hotel_room' AND rate_per_night_minor > 0 AND room_type IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS offers_one_active_per_seller_idx
  ON offers(request_id, seller_organization_id) WHERE status NOT IN ('withdrawn', 'rejected');
CREATE INDEX IF NOT EXISTS offers_request_idx ON offers(request_id, status);

CREATE TABLE IF NOT EXISTS awards (
  id UUID PRIMARY KEY,
  request_id UUID NOT NULL UNIQUE REFERENCES marketplace_requests(id),
  offer_id UUID NOT NULL UNIQUE REFERENCES offers(id),
  agency_organization_id UUID NOT NULL REFERENCES organizations(id),
  seller_organization_id UUID NOT NULL REFERENCES organizations(id),
  status VARCHAR(16) NOT NULL DEFAULT 'awarded' CHECK (status IN ('awarded', 'booked', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  booking_confirmed_at TIMESTAMPTZ
);

INSERT INTO schema_migrations(version) VALUES (2) ON CONFLICT (version) DO NOTHING;