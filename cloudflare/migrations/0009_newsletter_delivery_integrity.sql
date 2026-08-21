PRAGMA foreign_keys = ON;

-- A newsletter address is not a subscriber until the recipient proves control
-- of the mailbox. Confirmation tokens are derived from a separate secret and
-- only their SHA-256 hashes are stored here.
CREATE TABLE newsletter_confirmation_requests (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  ip_hash TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'processing', 'sent', 'failed', 'confirmed', 'cancelled')
  ),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  available_at TEXT NOT NULL,
  locked_at TEXT,
  expires_at TEXT NOT NULL,
  sent_at TEXT,
  confirmed_at TEXT,
  provider TEXT NOT NULL DEFAULT '',
  provider_message_id TEXT,
  provider_metadata_json TEXT NOT NULL DEFAULT '{}',
  capture_json TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(email) BETWEEN 3 AND 254),
  CHECK (length(token_hash) = 64),
  CHECK (length(ip_hash) <= 128),
  CHECK (expires_at > created_at),
  CHECK (length(provider) <= 100),
  CHECK (provider_message_id IS NULL OR length(provider_message_id) <= 500),
  CHECK (length(provider_metadata_json) <= 4096),
  CHECK (capture_json IS NULL OR length(capture_json) <= 262144),
  CHECK (length(last_error) <= 1000)
);

CREATE INDEX idx_newsletter_confirmation_due
  ON newsletter_confirmation_requests(status, available_at, created_at);
CREATE INDEX idx_newsletter_confirmation_expiry
  ON newsletter_confirmation_requests(expires_at, status);

-- Store only the minimum replay and suppression evidence from provider events.
-- The signed raw webhook payload is hashed, not retained.
CREATE TABLE newsletter_provider_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_event_hash TEXT NOT NULL UNIQUE,
  provider_message_id TEXT NOT NULL DEFAULT '',
  recipient_email TEXT NOT NULL COLLATE NOCASE,
  event_type TEXT NOT NULL CHECK (event_type IN ('bounce', 'complaint')),
  action TEXT NOT NULL CHECK (action IN ('recorded', 'suppressed')),
  category TEXT NOT NULL DEFAULT '',
  response_code INTEGER,
  details TEXT NOT NULL DEFAULT '',
  payload_sha256 TEXT NOT NULL,
  occurred_at TEXT,
  created_at TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  CHECK (length(provider) BETWEEN 1 AND 100),
  CHECK (length(provider_event_hash) = 64),
  CHECK (length(provider_message_id) <= 500),
  CHECK (length(recipient_email) BETWEEN 3 AND 254),
  CHECK (length(category) <= 100),
  CHECK (length(details) <= 1000),
  CHECK (length(payload_sha256) = 64)
);

CREATE INDEX idx_newsletter_provider_events_message
  ON newsletter_provider_events(provider, provider_message_id, created_at DESC);
CREATE INDEX idx_newsletter_provider_events_recipient
  ON newsletter_provider_events(recipient_email, created_at DESC);

-- Ambiguous provider outcomes are never blindly retried. They enter a
-- reconciliation lane and remain there until the provider readback gives a
-- deterministic result or an operator resolves the message.
ALTER TABLE newsletter_deliveries
  ADD COLUMN reconciliation_status TEXT NOT NULL DEFAULT 'none' CHECK (
    reconciliation_status IN ('none', 'pending', 'resolved', 'manual_review')
  );
ALTER TABLE newsletter_deliveries
  ADD COLUMN reconciliation_attempts INTEGER NOT NULL DEFAULT 0 CHECK (
    reconciliation_attempts BETWEEN 0 AND 10
  );
ALTER TABLE newsletter_deliveries
  ADD COLUMN reconcile_after TEXT;
ALTER TABLE newsletter_deliveries
  ADD COLUMN last_reconciled_at TEXT;

CREATE INDEX idx_newsletter_deliveries_reconcile
  ON newsletter_deliveries(reconciliation_status, reconcile_after, updated_at);
