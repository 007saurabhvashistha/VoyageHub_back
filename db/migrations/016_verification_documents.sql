CREATE TABLE IF NOT EXISTS organization_documents (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  document_type VARCHAR(32) NOT NULL CHECK (document_type IN (
    'gst_certificate', 'pan_card', 'business_registration', 'tax_registration', 'property_proof', 'tourism_recognition'
  )),
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
  superseded_at TIMESTAMPTZ,
  -- Set when the stored file is removed (malware, retention); the row stays as the audit record.
  deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS organization_documents_current_idx
  ON organization_documents(organization_id, document_type) WHERE superseded_at IS NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS organization_documents_org_idx ON organization_documents(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS organization_documents_scan_queue_idx
  ON organization_documents(scan_next_attempt_at) WHERE scan_status = 'pending' AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS organization_document_access_log (
  id UUID PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES organization_documents(id),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS organization_document_access_log_document_idx ON organization_document_access_log(document_id, accessed_at DESC);

INSERT INTO schema_migrations(version) VALUES (16) ON CONFLICT (version) DO NOTHING;
