CREATE TABLE IF NOT EXISTS comparison_exchange_rates (
  id UUID PRIMARY KEY,
  base_currency CHAR(3) NOT NULL,
  quote_currency CHAR(3) NOT NULL,
  rate NUMERIC(24, 12) NOT NULL CHECK (rate > 0),
  rate_date DATE NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL,
  provider VARCHAR(80) NOT NULL,
  UNIQUE (base_currency, quote_currency, rate_date)
);

CREATE INDEX IF NOT EXISTS comparison_exchange_rates_latest_idx
  ON comparison_exchange_rates(base_currency, quote_currency, rate_date DESC, fetched_at DESC);

INSERT INTO schema_migrations(version) VALUES (25) ON CONFLICT (version) DO NOTHING;
