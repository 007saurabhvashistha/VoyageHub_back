CREATE TABLE IF NOT EXISTS organization_reviews (
  id UUID PRIMARY KEY,
  award_id UUID NOT NULL REFERENCES awards(id) ON DELETE CASCADE,
  reviewer_organization_id UUID NOT NULL REFERENCES organizations(id),
  reviewee_organization_id UUID NOT NULL REFERENCES organizations(id),
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (award_id, reviewer_organization_id),
  CHECK (reviewer_organization_id <> reviewee_organization_id)
);
CREATE INDEX IF NOT EXISTS organization_reviews_reviewee_idx ON organization_reviews(reviewee_organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS booking_disputes (
  id UUID PRIMARY KEY,
  award_id UUID NOT NULL UNIQUE REFERENCES awards(id) ON DELETE CASCADE,
  opened_by_organization_id UUID NOT NULL REFERENCES organizations(id),
  opened_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  category VARCHAR(32) NOT NULL,
  summary VARCHAR(200) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_review', 'resolved', 'rejected')),
  resolution_note VARCHAR(1000),
  resolved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS booking_disputes_status_idx ON booking_disputes(status, created_at);

CREATE TABLE IF NOT EXISTS booking_dispute_events (
  id UUID PRIMARY KEY,
  dispute_id UUID NOT NULL REFERENCES booking_disputes(id) ON DELETE CASCADE,
  actor_organization_id UUID REFERENCES organizations(id),
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type VARCHAR(24) NOT NULL CHECK (event_type IN ('opened', 'evidence_added', 'status_changed', 'resolved')),
  message VARCHAR(2000) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS booking_dispute_events_timeline_idx ON booking_dispute_events(dispute_id, created_at, id);

CREATE TABLE IF NOT EXISTS user_notification_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  in_app_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  email_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  email_frequency VARCHAR(12) NOT NULL DEFAULT 'instant' CHECK (email_frequency IN ('instant', 'daily')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE notification_outbox DROP CONSTRAINT IF EXISTS notification_outbox_status_check;
ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_status_check
  CHECK (status IN ('pending', 'processing', 'retrying', 'delivered', 'blocked_config', 'dead_letter', 'suppressed'));

CREATE TABLE IF NOT EXISTS notification_daily_summaries (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  summary_date DATE NOT NULL,
  notification_id UUID REFERENCES notifications(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, summary_date)
);

CREATE OR REPLACE FUNCTION enqueue_notification_outbox_rows()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO notification_outbox (notification_id, organization_id, recipient_user_id, event_type, allow_unverified)
  SELECT NEW.id, NEW.organization_id, membership.user_id, NEW.event_type,
         NEW.event_type IN ('email_verification', 'password_recovery')
  FROM organization_memberships membership
  LEFT JOIN user_notification_preferences preference ON preference.user_id = membership.user_id
  WHERE membership.organization_id = NEW.organization_id
    AND (NEW.event_type NOT IN ('email_verification', 'password_recovery')
      OR membership.user_id::text = NEW.data->>'recipientUserId')
    AND ((NEW.event_type IN ('email_verification', 'password_recovery'))
      OR (COALESCE(preference.email_enabled, TRUE)
        AND ((NEW.event_type = 'daily_summary' AND preference.email_frequency = 'daily')
          OR (NEW.event_type <> 'daily_summary' AND COALESCE(preference.email_frequency, 'instant') = 'instant'))))
  ON CONFLICT (notification_id, recipient_user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enqueue_notification_webhooks()
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

DROP TRIGGER IF EXISTS notifications_enqueue_outbox ON notifications;
CREATE TRIGGER notifications_enqueue_outbox AFTER INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION enqueue_notification_outbox_rows();

INSERT INTO schema_migrations(version) VALUES (27) ON CONFLICT (version) DO NOTHING;
