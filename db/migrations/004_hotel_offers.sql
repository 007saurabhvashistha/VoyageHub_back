CREATE TABLE IF NOT EXISTS hotel_room_inventory (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  inventory_date DATE NOT NULL,
  room_type VARCHAR(120) NOT NULL,
  available_rooms SMALLINT NOT NULL CHECK (available_rooms BETWEEN 0 AND 100),
  nightly_rate_minor BIGINT CHECK (nightly_rate_minor >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, inventory_date, room_type)
);

CREATE INDEX IF NOT EXISTS hotel_inventory_date_idx ON hotel_room_inventory(organization_id, inventory_date);

INSERT INTO schema_migrations(version) VALUES (4) ON CONFLICT (version) DO NOTHING;