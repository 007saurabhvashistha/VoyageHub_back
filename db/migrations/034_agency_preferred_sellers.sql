CREATE TABLE IF NOT EXISTS agency_preferred_sellers (
  agency_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  seller_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agency_organization_id, seller_organization_id),
  CHECK (agency_organization_id <> seller_organization_id)
);

CREATE INDEX IF NOT EXISTS agency_preferred_sellers_seller_idx
  ON agency_preferred_sellers(seller_organization_id, agency_organization_id);

INSERT INTO schema_migrations(version) VALUES (34) ON CONFLICT (version) DO NOTHING;