CREATE TABLE IF NOT EXISTS offer_revisions (
  id UUID PRIMARY KEY,
  offer_id UUID NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (offer_id, revision_number)
);

CREATE INDEX IF NOT EXISTS offer_revisions_offer_idx ON offer_revisions(offer_id, revision_number DESC);
INSERT INTO schema_migrations(version) VALUES (6) ON CONFLICT (version) DO NOTHING;