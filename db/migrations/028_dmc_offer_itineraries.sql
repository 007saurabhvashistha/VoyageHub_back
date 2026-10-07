ALTER TABLE offers ADD COLUMN IF NOT EXISTS itinerary JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE offers DROP CONSTRAINT IF EXISTS offers_itinerary_array_check;
ALTER TABLE offers ADD CONSTRAINT offers_itinerary_array_check CHECK (jsonb_typeof(itinerary) = 'array');

INSERT INTO schema_migrations(version) VALUES (28) ON CONFLICT (version) DO NOTHING;