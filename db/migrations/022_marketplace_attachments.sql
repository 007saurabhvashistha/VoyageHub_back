-- Files on offers (itineraries, photos) and on request messages; unreadable until the malware scan marks them clean.
CREATE TABLE IF NOT EXISTS marketplace_attachments (
  id UUID PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES marketplace_requests(id) ON DELETE CASCADE,
  offer_id UUID REFERENCES offers(id) ON DELETE CASCADE,
  message_id UUID REFERENCES request_messages(id) ON DELETE CASCADE,
  owner_organization_id UUID NOT NULL REFERENCES organizations(id),
  storage_provider VARCHAR(16) NOT NULL,
  storage_key VARCHAR(512) NOT NULL UNIQUE,
  original_filename VARCHAR(255) NOT NULL,
  content_type VARCHAR(100) NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  sha256 CHAR(64) NOT NULL,
  scan_status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending', 'clean', 'infected', 'failed')),
  scan_attempts SMALLINT NOT NULL DEFAULT 0,
  scan_next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scan_result VARCHAR(200),
  scanned_at TIMESTAMPTZ,
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Set when the stored file is removed (by the seller, or for malware); the row stays as the audit record.
  deleted_at TIMESTAMPTZ,
  CHECK ((offer_id IS NULL) <> (message_id IS NULL))
);

CREATE INDEX IF NOT EXISTS marketplace_attachments_offer_idx ON marketplace_attachments(offer_id, created_at) WHERE offer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS marketplace_attachments_message_idx ON marketplace_attachments(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS marketplace_attachments_scan_queue_idx
  ON marketplace_attachments(scan_next_attempt_at) WHERE scan_status = 'pending' AND deleted_at IS NULL;

INSERT INTO schema_migrations(version) VALUES (22) ON CONFLICT (version) DO NOTHING;
