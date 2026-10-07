ALTER TABLE organization_documents ADD COLUMN IF NOT EXISTS expires_at DATE;

CREATE INDEX IF NOT EXISTS organization_documents_expiry_idx
  ON organization_documents(expires_at, id)
  WHERE expires_at IS NOT NULL AND superseded_at IS NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS organization_document_expiry_notices (
  id UUID PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES organization_documents(id) ON DELETE CASCADE,
  notice_kind VARCHAR(12) NOT NULL CHECK (notice_kind IN ('upcoming', 'expired')),
  reminder_days_before INTEGER NOT NULL CHECK (reminder_days_before >= 0),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_id, notice_kind, reminder_days_before)
);

INSERT INTO schema_migrations(version) VALUES (33) ON CONFLICT (version) DO NOTHING;