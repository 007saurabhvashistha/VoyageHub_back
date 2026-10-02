CREATE TABLE IF NOT EXISTS request_messages (
  id UUID PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES marketplace_requests(id) ON DELETE CASCADE,
  sender_organization_id UUID NOT NULL REFERENCES organizations(id),
  recipient_organization_id UUID NOT NULL REFERENCES organizations(id),
  sender_user_id UUID NOT NULL REFERENCES users(id),
  body VARCHAR(4000) NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (sender_organization_id <> recipient_organization_id)
);

CREATE INDEX IF NOT EXISTS request_messages_thread_idx
  ON request_messages(request_id, created_at DESC, id DESC);

INSERT INTO schema_migrations(version) VALUES (8) ON CONFLICT (version) DO NOTHING;