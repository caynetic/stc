PRAGMA foreign_keys = ON;

-- Newsletter consent remains independent from member accounts. A subscriber
-- is linked only after an explicit subscription or customization flow, and
-- deleting a member leaves the underlying newsletter consent intact.
ALTER TABLE subscribers
  ADD COLUMN member_id TEXT REFERENCES members(id) ON DELETE SET NULL;
ALTER TABLE subscribers
  ADD COLUMN personalization_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (personalization_enabled IN (0, 1));
ALTER TABLE subscribers
  ADD COLUMN customize_token_hash TEXT;

CREATE UNIQUE INDEX ux_subscribers_member
  ON subscribers(member_id)
  WHERE member_id IS NOT NULL;
CREATE UNIQUE INDEX ux_subscribers_customize_token
  ON subscribers(customize_token_hash)
  WHERE customize_token_hash IS NOT NULL;

CREATE TRIGGER guard_subscriber_member_insert
BEFORE INSERT ON subscribers
BEGIN
  SELECT RAISE(ABORT, 'subscriber personalization requires member')
  WHERE NEW.personalization_enabled = 1 AND NEW.member_id IS NULL;

  SELECT RAISE(ABORT, 'subscriber member email mismatch')
  WHERE NEW.member_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM members
    WHERE id = NEW.member_id AND email = NEW.email COLLATE NOCASE
  );
END;

CREATE TRIGGER guard_subscriber_member_update
BEFORE UPDATE OF member_id, email, personalization_enabled ON subscribers
BEGIN
  SELECT RAISE(ABORT, 'subscriber personalization requires member')
  WHERE NEW.personalization_enabled = 1 AND NEW.member_id IS NULL;

  SELECT RAISE(ABORT, 'subscriber member email mismatch')
  WHERE NEW.member_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM members
    WHERE id = NEW.member_id AND email = NEW.email COLLATE NOCASE
  );
END;

CREATE TABLE newsletter_digests (
  id TEXT PRIMARY KEY,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  event_ids_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'building' CHECK (
    status IN ('building', 'fanout', 'delivering', 'completed', 'cancelled', 'failed')
  ),
  fanout_cursor TEXT NOT NULL DEFAULT '',
  fanout_completed_at TEXT,
  completed_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (window_start, window_end),
  CHECK (window_start < window_end),
  CHECK (length(event_ids_json) <= 65536),
  CHECK (length(fanout_cursor) <= 200),
  CHECK (length(last_error) <= 1000)
);

CREATE INDEX idx_newsletter_digests_status_window
  ON newsletter_digests(status, window_end, created_at);

CREATE TABLE newsletter_deliveries (
  id TEXT PRIMARY KEY,
  digest_id TEXT NOT NULL REFERENCES newsletter_digests(id) ON DELETE CASCADE,
  subscriber_id TEXT NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  recipient_email TEXT NOT NULL COLLATE NOCASE,
  mode TEXT NOT NULL DEFAULT 'general' CHECK (mode IN ('general', 'personalized')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'processing', 'sent', 'failed', 'cancelled')
  ),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  available_at TEXT NOT NULL,
  locked_at TEXT,
  sent_at TEXT,
  cancelled_at TEXT,
  provider TEXT NOT NULL DEFAULT '',
  provider_message_id TEXT,
  provider_metadata_json TEXT NOT NULL DEFAULT '{}',
  capture_json TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (digest_id, subscriber_id),
  CHECK (length(recipient_email) BETWEEN 3 AND 254),
  CHECK (length(provider) <= 100),
  CHECK (provider_message_id IS NULL OR length(provider_message_id) <= 500),
  CHECK (length(provider_metadata_json) <= 4096),
  CHECK (capture_json IS NULL OR length(capture_json) <= 262144),
  CHECK (length(last_error) <= 1000)
);

CREATE INDEX idx_newsletter_deliveries_pending
  ON newsletter_deliveries(status, available_at, created_at);
CREATE INDEX idx_newsletter_deliveries_digest_status
  ON newsletter_deliveries(digest_id, status, created_at);
CREATE INDEX idx_newsletter_deliveries_subscriber
  ON newsletter_deliveries(subscriber_id, created_at DESC);
CREATE INDEX idx_newsletter_deliveries_sent
  ON newsletter_deliveries(sent_at)
  WHERE sent_at IS NOT NULL;

CREATE TRIGGER guard_newsletter_delivery_recipient_insert
BEFORE INSERT ON newsletter_deliveries
BEGIN
  SELECT RAISE(ABORT, 'newsletter delivery recipient mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM subscribers
    WHERE id = NEW.subscriber_id AND email = NEW.recipient_email COLLATE NOCASE
  );
END;

CREATE TRIGGER guard_newsletter_delivery_recipient_update
BEFORE UPDATE OF subscriber_id, recipient_email ON newsletter_deliveries
BEGIN
  SELECT RAISE(ABORT, 'newsletter delivery recipient mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM subscribers
    WHERE id = NEW.subscriber_id AND email = NEW.recipient_email COLLATE NOCASE
  );
END;

CREATE TABLE newsletter_suppressions (
  subscriber_id TEXT PRIMARY KEY REFERENCES subscribers(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (
    reason IN ('bounce', 'complaint', 'blocked', 'invalid_recipient', 'manual')
  ),
  provider_event_id TEXT,
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (provider_event_id IS NULL OR length(provider_event_id) <= 500),
  CHECK (length(details) <= 1000)
);

CREATE UNIQUE INDEX ux_newsletter_suppressions_provider_event
  ON newsletter_suppressions(provider_event_id)
  WHERE provider_event_id IS NOT NULL;

-- Preserve opt-outs even if another code path updates the subscriber directly.
CREATE TRIGGER cancel_newsletter_deliveries_after_unsubscribe
AFTER UPDATE OF status ON subscribers
WHEN OLD.status <> NEW.status AND NEW.status = 'unsubscribed'
BEGIN
  UPDATE newsletter_deliveries
  SET status = 'cancelled', cancelled_at = NEW.updated_at,
      locked_at = NULL, updated_at = NEW.updated_at
  WHERE subscriber_id = NEW.id
    AND status IN ('pending', 'failed');
END;

CREATE TRIGGER cancel_newsletter_deliveries_after_suppression
AFTER INSERT ON newsletter_suppressions
BEGIN
  UPDATE newsletter_deliveries
  SET status = 'cancelled', cancelled_at = NEW.created_at,
      locked_at = NULL, updated_at = NEW.created_at
  WHERE subscriber_id = NEW.subscriber_id
    AND status IN ('pending', 'failed');
END;
