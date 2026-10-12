ALTER TABLE hotel_properties ADD COLUMN IF NOT EXISTS property_proof_document_id UUID REFERENCES organization_documents(id) ON DELETE SET NULL;
ALTER TABLE hotel_properties ADD COLUMN IF NOT EXISTS ownership_proof_type VARCHAR(32);
ALTER TABLE hotel_properties ADD COLUMN IF NOT EXISTS ownership_reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE hotel_properties ADD COLUMN IF NOT EXISTS ownership_reviewed_at TIMESTAMPTZ;
ALTER TABLE hotel_properties ADD COLUMN IF NOT EXISTS ownership_rejection_reason VARCHAR(500);

CREATE INDEX IF NOT EXISTS hotel_properties_ownership_status_idx ON hotel_properties(ownership_check_status);

INSERT INTO schema_migrations(version) VALUES (35) ON CONFLICT (version) DO NOTHING;
