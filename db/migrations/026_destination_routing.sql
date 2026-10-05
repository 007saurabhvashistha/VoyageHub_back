-- Destination hierarchy gains a second administrative level; all geography stays data (GeoNames import + admin edits).
ALTER TABLE destinations DROP CONSTRAINT IF EXISTS destinations_kind_check;
ALTER TABLE destinations ADD CONSTRAINT destinations_kind_check CHECK (kind IN ('country', 'region', 'district', 'city'));
ALTER TABLE destinations ADD COLUMN IF NOT EXISTS match_path UUID[];
ALTER TABLE destinations ADD COLUMN IF NOT EXISTS featured BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE destinations ADD COLUMN IF NOT EXISTS lead_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE destinations ADD COLUMN IF NOT EXISTS admin1_code VARCHAR(20);
ALTER TABLE destinations ADD COLUMN IF NOT EXISTS admin2_code VARCHAR(80);
ALTER TABLE destinations ADD COLUMN IF NOT EXISTS feature_code VARCHAR(10);
ALTER TABLE destinations ADD COLUMN IF NOT EXISTS admin_edited_at TIMESTAMPTZ;
UPDATE destinations SET match_path = path WHERE match_path IS NULL;
ALTER TABLE destinations ALTER COLUMN match_path SET NOT NULL;
CREATE INDEX IF NOT EXISTS destinations_path_gin_idx ON destinations USING GIN (path);
CREATE INDEX IF NOT EXISTS destinations_match_path_gin_idx ON destinations USING GIN (match_path);
CREATE INDEX IF NOT EXISTS destinations_admin_codes_idx ON destinations(country_code, kind, admin1_code, admin2_code);
CREATE INDEX IF NOT EXISTS destinations_ranking_idx ON destinations(featured DESC, lead_count DESC);

-- Extra parents for places that span more than one district or region.
CREATE TABLE IF NOT EXISTS destination_parents (
  destination_id UUID NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
  parent_id UUID NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (destination_id, parent_id),
  CHECK (destination_id <> parent_id)
);
CREATE INDEX IF NOT EXISTS destination_parents_parent_idx ON destination_parents(parent_id);

CREATE OR REPLACE VIEW destination_edges AS
  SELECT id AS child_id, parent_id FROM destinations WHERE parent_id IS NOT NULL
  UNION ALL
  SELECT destination_id, parent_id FROM destination_parents;

-- Every ancestor through primary and secondary parents, including the destination itself.
CREATE OR REPLACE FUNCTION destination_match_path(target UUID) RETURNS UUID[] LANGUAGE sql STABLE AS $$
  WITH RECURSIVE up(id) AS (
    SELECT target
    UNION
    SELECT edge.parent_id FROM up JOIN destination_edges edge ON edge.child_id = up.id
  )
  SELECT array_agg(id) FROM up
$$;

CREATE OR REPLACE FUNCTION destinations_set_match_path()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.match_path IS NULL THEN
    NEW.match_path := COALESCE((SELECT parent.match_path FROM destinations parent WHERE parent.id = NEW.parent_id), ARRAY[]::uuid[]) || NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS destinations_match_path_default ON destinations;
CREATE TRIGGER destinations_match_path_default
BEFORE INSERT ON destinations
FOR EACH ROW EXECUTE FUNCTION destinations_set_match_path();

-- Per-country display labels for each level ("State / UT", "District", ...), set by an admin.
CREATE TABLE IF NOT EXISTS country_destination_levels (
  country_code CHAR(2) NOT NULL,
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('country', 'region', 'district', 'city')),
  label VARCHAR(60) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (country_code, kind)
);

-- Lead requirement type decides the audience: hotel-only leads reach hotels, itinerary leads reach DMCs.
ALTER TABLE marketplace_requests ADD COLUMN IF NOT EXISTS requirement_type VARCHAR(16);
UPDATE marketplace_requests SET requirement_type = CASE WHEN services = ARRAY['hotel']::text[] THEN 'hotel_only' ELSE 'itinerary' END
  WHERE requirement_type IS NULL;
ALTER TABLE marketplace_requests ALTER COLUMN requirement_type SET NOT NULL;
ALTER TABLE marketplace_requests DROP CONSTRAINT IF EXISTS marketplace_requests_requirement_type_check;
ALTER TABLE marketplace_requests ADD CONSTRAINT marketplace_requests_requirement_type_check CHECK (requirement_type IN ('hotel_only', 'itinerary'));
ALTER TABLE marketplace_requests ADD COLUMN IF NOT EXISTS destination_unresolved BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE marketplace_requests ADD COLUMN IF NOT EXISTS unresolved_notified_at TIMESTAMPTZ;
ALTER TABLE marketplace_requests ADD COLUMN IF NOT EXISTS reposted_from_request_id UUID REFERENCES marketplace_requests(id);
UPDATE marketplace_requests SET destination_unresolved = TRUE WHERE destination_id IS NULL;

CREATE TABLE IF NOT EXISTS request_destinations (
  request_id UUID NOT NULL REFERENCES marketplace_requests(id) ON DELETE CASCADE,
  sequence SMALLINT NOT NULL CHECK (sequence BETWEEN 1 AND 50),
  destination_id UUID NOT NULL REFERENCES destinations(id),
  nights SMALLINT CHECK (nights BETWEEN 1 AND 90),
  PRIMARY KEY (request_id, sequence),
  UNIQUE (request_id, destination_id)
);
CREATE INDEX IF NOT EXISTS request_destinations_destination_idx ON request_destinations(destination_id);
INSERT INTO request_destinations (request_id, sequence, destination_id)
  SELECT id, 1, destination_id FROM marketplace_requests WHERE destination_id IS NOT NULL
  ON CONFLICT DO NOTHING;

-- DMC coverage rules: the most specific rule (deepest destination) wins.
ALTER TABLE seller_coverage ADD COLUMN IF NOT EXISTS mode VARCHAR(8) NOT NULL DEFAULT 'include';
ALTER TABLE seller_coverage DROP CONSTRAINT IF EXISTS seller_coverage_mode_check;
ALTER TABLE seller_coverage ADD CONSTRAINT seller_coverage_mode_check CHECK (mode IN ('include', 'exclude'));

-- A hotel account can list many properties; only approved, active properties are matched to leads.
CREATE TABLE IF NOT EXISTS hotel_properties (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(160) NOT NULL,
  destination_id UUID NOT NULL REFERENCES destinations(id),
  star_category SMALLINT CHECK (star_category BETWEEN 1 AND 7),
  room_count SMALLINT CHECK (room_count BETWEEN 1 AND 5000),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  verification_status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending', 'approved', 'rejected')),
  verification_reason VARCHAR(500),
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS hotel_properties_organization_idx ON hotel_properties(organization_id, created_at);
CREATE INDEX IF NOT EXISTS hotel_properties_destination_idx ON hotel_properties(destination_id) WHERE active;
CREATE INDEX IF NOT EXISTS hotel_properties_pending_idx ON hotel_properties(created_at) WHERE verification_status = 'pending';
INSERT INTO hotel_properties (id, organization_id, name, destination_id, verification_status)
  SELECT gen_random_uuid(), p.organization_id, o.name, p.property_destination_id,
         CASE WHEN p.verification_status = 'approved' THEN 'approved' ELSE 'pending' END
  FROM seller_profiles p JOIN organizations o ON o.id = p.organization_id
  WHERE o.business_type = 'hotelier' AND p.property_destination_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM hotel_properties h WHERE h.organization_id = p.organization_id);

ALTER TABLE offers ADD COLUMN IF NOT EXISTS hotel_property_id UUID REFERENCES hotel_properties(id);
UPDATE offers f SET hotel_property_id = (SELECT h.id FROM hotel_properties h WHERE h.organization_id = f.seller_organization_id ORDER BY h.created_at, h.id LIMIT 1)
  WHERE f.offer_kind = 'hotel_room' AND f.hotel_property_id IS NULL;
DROP INDEX IF EXISTS offers_one_active_per_seller_idx;
CREATE UNIQUE INDEX IF NOT EXISTS offers_one_active_per_seller_property_idx
  ON offers(request_id, seller_organization_id, COALESCE(hotel_property_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status NOT IN ('withdrawn', 'rejected');

-- How each targeted seller matched, which of its hotels matched, and whether it was already alerted.
ALTER TABLE request_targets ADD COLUMN IF NOT EXISTS match_type VARCHAR(12);
ALTER TABLE request_targets DROP CONSTRAINT IF EXISTS request_targets_match_type_check;
ALTER TABLE request_targets ADD CONSTRAINT request_targets_match_type_check CHECK (match_type IS NULL OR match_type IN ('full', 'partial', 'invited'));
ALTER TABLE request_targets ADD COLUMN IF NOT EXISTS matching_property_ids UUID[] NOT NULL DEFAULT ARRAY[]::uuid[];
ALTER TABLE request_targets ADD COLUMN IF NOT EXISTS alerted_at TIMESTAMPTZ;
UPDATE request_targets SET alerted_at = matched_at WHERE alerted_at IS NULL;

CREATE TABLE IF NOT EXISTS seller_alert_preferences (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  delivery VARCHAR(8) NOT NULL DEFAULT 'instant' CHECK (delivery IN ('instant', 'digest', 'off')),
  destination_kinds TEXT[],
  include_partial BOOLEAN NOT NULL DEFAULT TRUE,
  property_ids UUID[],
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS alert_digest_items (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  request_id UUID NOT NULL REFERENCES marketplace_requests(id) ON DELETE CASCADE,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  PRIMARY KEY (organization_id, request_id)
);
CREATE INDEX IF NOT EXISTS alert_digest_items_unsent_idx ON alert_digest_items(organization_id) WHERE sent_at IS NULL;

ALTER TABLE operation_runs DROP CONSTRAINT IF EXISTS operation_runs_kind_check;
ALTER TABLE operation_runs ADD CONSTRAINT operation_runs_kind_check CHECK (kind IN ('database_backup', 'restore_drill', 'destination_import', 'routing_launch', 'featured_import'));
