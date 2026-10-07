ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS handled_group_types TEXT[] NOT NULL DEFAULT ARRAY[]::text[];
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS minimum_group_size SMALLINT;
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS budget_min_minor BIGINT;
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS budget_max_minor BIGINT;
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS budget_currency CHAR(3);
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS languages TEXT[] NOT NULL DEFAULT ARRAY[]::text[];
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS accepting_requests BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE seller_profiles ADD CONSTRAINT seller_profiles_budget_range_check CHECK (
  (budget_min_minor IS NULL AND budget_max_minor IS NULL AND budget_currency IS NULL)
  OR (budget_min_minor IS NOT NULL AND budget_max_minor IS NOT NULL AND budget_currency IS NOT NULL
    AND budget_min_minor >= 0 AND budget_max_minor >= budget_min_minor)
);
ALTER TABLE seller_profiles ADD CONSTRAINT seller_profiles_minimum_group_size_check CHECK (
  minimum_group_size IS NULL OR minimum_group_size BETWEEN 1 AND 32767
);
CREATE INDEX IF NOT EXISTS seller_profiles_accepting_requests_idx ON seller_profiles(accepting_requests, verification_status);

ALTER TABLE marketplace_requests ADD COLUMN IF NOT EXISTS child_ages SMALLINT[] NOT NULL DEFAULT ARRAY[]::smallint[];
ALTER TABLE marketplace_requests ADD COLUMN IF NOT EXISTS special_requests VARCHAR(2000);

CREATE TABLE IF NOT EXISTS request_deadline_changes (
  id UUID PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES marketplace_requests(id) ON DELETE CASCADE,
  changed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  previous_deadline TIMESTAMPTZ NOT NULL,
  current_deadline TIMESTAMPTZ NOT NULL,
  note VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (current_deadline > previous_deadline)
);
CREATE INDEX IF NOT EXISTS request_deadline_changes_request_idx ON request_deadline_changes(request_id, created_at DESC);

INSERT INTO schema_migrations(version) VALUES (30) ON CONFLICT (version) DO NOTHING;