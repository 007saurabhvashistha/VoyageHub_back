ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS auth_email_tokens (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose VARCHAR(24) NOT NULL CHECK (purpose IN ('verify_email', 'password_reset')),
  token_hash CHAR(64) NOT NULL UNIQUE,
  token_ciphertext TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS auth_email_tokens_one_active_idx
  ON auth_email_tokens(user_id, purpose) WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS auth_email_tokens_expiry_idx ON auth_email_tokens(expires_at);

ALTER TABLE notification_outbox
  ADD COLUMN IF NOT EXISTS allow_unverified BOOLEAN NOT NULL DEFAULT FALSE;

CREATE OR REPLACE FUNCTION enqueue_notification_outbox_rows()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO notification_outbox (notification_id, organization_id, recipient_user_id, event_type, allow_unverified)
  SELECT NEW.id, NEW.organization_id, membership.user_id, NEW.event_type,
         NEW.event_type IN ('email_verification', 'password_recovery')
  FROM organization_memberships membership
  WHERE membership.organization_id = NEW.organization_id
    AND (NEW.event_type NOT IN ('email_verification', 'password_recovery')
      OR membership.user_id::text = NEW.data->>'recipientUserId')
  ON CONFLICT (notification_id, recipient_user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

INSERT INTO notification_outbox (notification_id, organization_id, recipient_user_id, event_type, allow_unverified)
SELECT notification.id, notification.organization_id, membership.user_id, notification.event_type,
       notification.event_type IN ('email_verification', 'password_recovery')
FROM notifications notification
JOIN organization_memberships membership ON membership.organization_id = notification.organization_id
WHERE notification.event_type NOT IN ('email_verification', 'password_recovery')
   OR membership.user_id::text = notification.data->>'recipientUserId'
ON CONFLICT (notification_id, recipient_user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION requeue_verified_member_notifications()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.email_verified_at IS NULL AND NEW.email_verified_at IS NOT NULL THEN
    UPDATE notification_outbox SET status = 'pending', available_at = NOW(), locked_at = NULL,
      last_error_code = NULL, updated_at = NOW()
    WHERE recipient_user_id = NEW.id AND status = 'blocked_config'
      AND last_error_code = 'recipient_email_unverified' AND allow_unverified = FALSE;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_requeue_verified_notifications ON users;
CREATE TRIGGER users_requeue_verified_notifications
AFTER UPDATE OF email_verified_at ON users
FOR EACH ROW EXECUTE FUNCTION requeue_verified_member_notifications();

DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE email_verified_at IS NULL);

INSERT INTO schema_migrations(version) VALUES (10) ON CONFLICT (version) DO NOTHING;