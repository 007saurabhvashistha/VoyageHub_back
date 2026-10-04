-- The offer row stays the main option; sellers may add alternatives (for example 3/4/5 star) and the agency awards one.
ALTER TABLE offers ADD COLUMN IF NOT EXISTS hotel_category SMALLINT CHECK (hotel_category IN (3, 4, 5));
ALTER TABLE offers ADD COLUMN IF NOT EXISTS option_label VARCHAR(80);

CREATE TABLE IF NOT EXISTS offer_options (
  id UUID PRIMARY KEY,
  offer_id UUID NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  position SMALLINT NOT NULL,
  label VARCHAR(80) NOT NULL,
  hotel_category SMALLINT CHECK (hotel_category IN (3, 4, 5)),
  total_minor BIGINT CHECK (total_minor > 0),
  rate_per_night_minor BIGINT CHECK (rate_per_night_minor > 0),
  room_type VARCHAR(120),
  meal_plan VARCHAR(24),
  notes VARCHAR(500),
  UNIQUE (offer_id, position),
  CHECK ((total_minor IS NULL) <> (rate_per_night_minor IS NULL)),
  CHECK (rate_per_night_minor IS NULL OR room_type IS NOT NULL)
);

ALTER TABLE awards ADD COLUMN IF NOT EXISTS offer_option_id UUID REFERENCES offer_options(id);

INSERT INTO schema_migrations(version) VALUES (20) ON CONFLICT (version) DO NOTHING;
