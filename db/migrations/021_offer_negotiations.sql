-- Agency asks a seller to revise an offer or proposes a counter price; one open round per offer at a time.
CREATE TABLE IF NOT EXISTS offer_negotiations (
  id UUID PRIMARY KEY,
  offer_id UUID NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  offer_option_id UUID REFERENCES offer_options(id) ON DELETE SET NULL,
  option_label VARCHAR(80),
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('revision_request', 'counter_offer')),
  message VARCHAR(1000),
  counter_price_minor BIGINT CHECK (counter_price_minor > 0),
  status VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'revised', 'declined', 'withdrawn', 'closed')),
  requested_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  response_note VARCHAR(1000),
  responded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  responded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((kind = 'counter_offer') = (counter_price_minor IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS offer_negotiations_one_open_idx ON offer_negotiations(offer_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS offer_negotiations_offer_idx ON offer_negotiations(offer_id, created_at DESC);

INSERT INTO schema_migrations(version) VALUES (21) ON CONFLICT (version) DO NOTHING;
