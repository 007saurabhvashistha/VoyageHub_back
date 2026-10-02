CREATE TABLE IF NOT EXISTS notification_outbox (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type VARCHAR(32) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'retrying', 'delivered', 'blocked_config', 'dead_letter')),
  attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  manual_retries SMALLINT NOT NULL DEFAULT 0 CHECK (manual_retries >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  last_error_code VARCHAR(80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (notification_id, recipient_user_id)
);

CREATE INDEX IF NOT EXISTS notification_outbox_pending_idx
  ON notification_outbox(status, available_at, id)
  WHERE status IN ('pending', 'retrying', 'processing');

CREATE OR REPLACE FUNCTION enqueue_notification_outbox_rows()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO notification_outbox (notification_id, organization_id, recipient_user_id, event_type)
  SELECT NEW.id, NEW.organization_id, membership.user_id, NEW.event_type
  FROM organization_memberships membership
  WHERE membership.organization_id = NEW.organization_id
  ON CONFLICT (notification_id, recipient_user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notifications_enqueue_outbox ON notifications;
CREATE TRIGGER notifications_enqueue_outbox
AFTER INSERT ON notifications
FOR EACH ROW EXECUTE FUNCTION enqueue_notification_outbox_rows();

INSERT INTO notification_outbox (notification_id, organization_id, recipient_user_id, event_type)
SELECT notification.id, notification.organization_id, membership.user_id, notification.event_type
FROM notifications notification
JOIN organization_memberships membership ON membership.organization_id = notification.organization_id
ON CONFLICT (notification_id, recipient_user_id) DO NOTHING;

INSERT INTO schema_migrations(version) VALUES (9) ON CONFLICT (version) DO NOTHING;