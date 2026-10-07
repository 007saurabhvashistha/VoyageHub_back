CREATE TABLE IF NOT EXISTS dmc_offer_library (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  library_type VARCHAR(12) NOT NULL CHECK (library_type IN ('draft', 'template')),
  name VARCHAR(80) NOT NULL,
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS dmc_offer_library_org_idx ON dmc_offer_library(organization_id, library_type, updated_at DESC);

INSERT INTO schema_migrations(version) VALUES (29) ON CONFLICT (version) DO NOTHING;