-- Outbound signed webhooks (Standard Webhooks format) per organization.
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url VARCHAR(2048) NOT NULL,
  description VARCHAR(200),
  event_types TEXT[] NOT NULL CHECK (cardinality(event_types) > 0),
  secret_ciphertext TEXT NOT NULL,
  -- Kept during the rotation grace period so receivers can switch secrets without dropping events.
  previous_secret_ciphertext TEXT,
  previous_secret_expires_at TIMESTAMPTZ,
  status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  disabled_reason VARCHAR(24) CHECK (disabled_reason IN ('manual', 'failing')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  secret_rotated_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((status = 'disabled') = (disabled_reason IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS webhook_endpoints_org_idx ON webhook_endpoints(organization_id, created_at);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  endpoint_id UUID NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  notification_id UUID REFERENCES notifications(id) ON DELETE SET NULL,
  event_type VARCHAR(40) NOT NULL,
  -- Sent as the webhook-id header; stays the same across retries so receivers can deduplicate.
  message_id VARCHAR(64) NOT NULL,
  payload JSONB NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'retrying', 'delivered', 'dead_letter', 'cancelled')),
  attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  manual_retries SMALLINT NOT NULL DEFAULT 0 CHECK (manual_retries >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  last_status_code SMALLINT,
  last_error_code VARCHAR(80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (endpoint_id, message_id)
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_pending_idx
  ON webhook_deliveries(status, available_at, id)
  WHERE status IN ('pending', 'retrying', 'processing');
CREATE INDEX IF NOT EXISTS webhook_deliveries_endpoint_idx ON webhook_deliveries(endpoint_id, created_at DESC);
CREATE INDEX IF NOT EXISTS webhook_deliveries_retention_idx ON webhook_deliveries(updated_at)
  WHERE status IN ('delivered', 'dead_letter', 'cancelled');

-- Same transaction as the notification, so an event is never lost or sent for a rolled-back change.
-- Only event types an endpoint subscribed to are enqueued; the subscribable list is validated in the API.
CREATE OR REPLACE FUNCTION enqueue_webhook_deliveries()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO webhook_deliveries (endpoint_id, organization_id, notification_id, event_type, message_id, payload)
  SELECT endpoint.id, NEW.organization_id, NEW.id, NEW.event_type, 'msg_' || replace(NEW.id::text, '-', ''),
    jsonb_build_object(
      'type', NEW.event_type,
      'timestamp', NEW.created_at,
      'data', NEW.data || jsonb_build_object('organizationId', NEW.organization_id, 'notificationId', NEW.id, 'title', NEW.title, 'message', NEW.message)
    )
  FROM webhook_endpoints endpoint
  WHERE endpoint.organization_id = NEW.organization_id
    AND endpoint.status = 'active'
    AND NEW.event_type = ANY(endpoint.event_types)
  ON CONFLICT (endpoint_id, message_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notifications_enqueue_webhooks ON notifications;
CREATE TRIGGER notifications_enqueue_webhooks
AFTER INSERT ON notifications
FOR EACH ROW EXECUTE FUNCTION enqueue_webhook_deliveries();

-- Evidence of backups and restore drills, written by the operations scripts.
CREATE TABLE IF NOT EXISTS operation_runs (
  id UUID PRIMARY KEY,
  kind VARCHAR(24) NOT NULL CHECK (kind IN ('database_backup', 'restore_drill')),
  status VARCHAR(16) NOT NULL CHECK (status IN ('succeeded', 'failed')),
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_by VARCHAR(120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS operation_runs_kind_idx ON operation_runs(kind, finished_at DESC);

INSERT INTO schema_migrations(version) VALUES (18) ON CONFLICT (version) DO NOTHING;
