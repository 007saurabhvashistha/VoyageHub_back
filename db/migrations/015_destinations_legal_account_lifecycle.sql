CREATE TABLE IF NOT EXISTS destinations (
  id UUID PRIMARY KEY,
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('country', 'region', 'city')),
  name VARCHAR(120) NOT NULL,
  search_name VARCHAR(120) NOT NULL,
  country_code CHAR(2) NOT NULL,
  parent_id UUID REFERENCES destinations(id),
  -- Ancestor ids from the country down to this row, so coverage of a parent matches every descendant.
  path UUID[] NOT NULL,
  aliases TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  geonames_id BIGINT UNIQUE,
  population BIGINT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((kind = 'country' AND parent_id IS NULL) OR (kind <> 'country' AND parent_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS destinations_one_country_idx ON destinations(country_code) WHERE kind = 'country';
CREATE INDEX IF NOT EXISTS destinations_search_idx ON destinations(search_name text_pattern_ops);
CREATE INDEX IF NOT EXISTS destinations_country_idx ON destinations(country_code, kind);
CREATE INDEX IF NOT EXISTS destinations_parent_idx ON destinations(parent_id);

CREATE TABLE IF NOT EXISTS seller_coverage (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  destination_id UUID NOT NULL REFERENCES destinations(id),
  PRIMARY KEY (organization_id, destination_id)
);

CREATE INDEX IF NOT EXISTS seller_coverage_destination_idx ON seller_coverage(destination_id);

ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS property_destination_id UUID REFERENCES destinations(id);
ALTER TABLE marketplace_requests ADD COLUMN IF NOT EXISTS destination_id UUID REFERENCES destinations(id);
CREATE INDEX IF NOT EXISTS marketplace_requests_destination_idx ON marketplace_requests(destination_id);

ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_scheduled_for TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS users_deletion_due_idx ON users(deletion_scheduled_for)
  WHERE deletion_scheduled_for IS NOT NULL AND anonymized_at IS NULL;
CREATE INDEX IF NOT EXISTS users_unverified_idx ON users(created_at) WHERE email_verified_at IS NULL;

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS closure_requested_at TIMESTAMPTZ;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS closure_scheduled_for TIMESTAMPTZ;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS organizations_closure_due_idx ON organizations(closure_scheduled_for)
  WHERE closure_scheduled_for IS NOT NULL AND closed_at IS NULL;

CREATE TABLE IF NOT EXISTS legal_documents (
  id UUID PRIMARY KEY,
  document_type VARCHAR(32) NOT NULL CHECK (document_type IN ('terms', 'privacy', 'dpa', 'cookies')),
  version INTEGER NOT NULL CHECK (version > 0),
  title VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  change_summary VARCHAR(500),
  published_by UUID REFERENCES users(id) ON DELETE SET NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_type, version)
);

CREATE TABLE IF NOT EXISTS legal_acceptances (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES legal_documents(id),
  organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, document_id)
);

INSERT INTO schema_migrations(version) VALUES (15) ON CONFLICT (version) DO NOTHING;
