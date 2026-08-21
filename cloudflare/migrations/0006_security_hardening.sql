PRAGMA foreign_keys = ON;

-- R2 and D1 cannot commit atomically. Every newly written object is recorded
-- here until the corresponding media state commits. Failed deletions remain
-- discoverable and are retried by scheduled maintenance.
CREATE TABLE media_cleanup_jobs (
  id TEXT PRIMARY KEY,
  bucket TEXT NOT NULL CHECK (bucket IN ('private_uploads', 'published_media')),
  object_key TEXT NOT NULL,
  asset_id TEXT,
  reason TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT NOT NULL DEFAULT '',
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(object_key) BETWEEN 1 AND 1024),
  CHECK (length(asset_id) <= 200),
  CHECK (length(reason) BETWEEN 1 AND 100),
  CHECK (length(last_error) <= 500),
  UNIQUE (bucket, object_key)
);

CREATE INDEX idx_media_cleanup_due
  ON media_cleanup_jobs(next_attempt_at, created_at, id);

-- These triggers make successful media commits clear their provisional
-- cleanup entries inside the same D1 transaction. If a later statement in the
-- batch fails, both the media change and cleanup deletion roll back together.
CREATE TRIGGER clear_private_media_cleanup_after_asset_insert
AFTER INSERT ON media_assets
BEGIN
  DELETE FROM media_cleanup_jobs
  WHERE bucket = 'private_uploads' AND object_key = NEW.original_key;
END;

CREATE TRIGGER clear_published_media_cleanup_after_asset_publish
AFTER UPDATE OF status, derivative_key ON media_assets
WHEN NEW.status = 'published' AND NEW.derivative_key IS NOT NULL
BEGIN
  DELETE FROM media_cleanup_jobs
  WHERE bucket = 'published_media' AND object_key = NEW.derivative_key;
END;

-- Caller-provided idempotency keys need an independently queryable key hash
-- and payload fingerprint. This lets the Worker distinguish a safe replay
-- from reuse of the same key for different content without storing either
-- value in plaintext. Existing idempotency_hash rows remain valid for legacy
-- and keyless payload deduplication.
ALTER TABLE organization_submissions
  ADD COLUMN idempotency_key_hash TEXT
  CHECK (idempotency_key_hash IS NULL OR length(idempotency_key_hash) = 64);

ALTER TABLE organization_submissions
  ADD COLUMN payload_fingerprint_hash TEXT
  CHECK (payload_fingerprint_hash IS NULL OR length(payload_fingerprint_hash) = 64);

CREATE UNIQUE INDEX idx_organization_submission_member_idempotency_key
  ON organization_submissions(member_id, idempotency_key_hash)
  WHERE member_id IS NOT NULL AND idempotency_key_hash IS NOT NULL;

ALTER TABLE event_submissions
  ADD COLUMN idempotency_key_hash TEXT
  CHECK (idempotency_key_hash IS NULL OR length(idempotency_key_hash) = 64);

ALTER TABLE event_submissions
  ADD COLUMN payload_fingerprint_hash TEXT
  CHECK (payload_fingerprint_hash IS NULL OR length(payload_fingerprint_hash) = 64);

CREATE UNIQUE INDEX idx_event_submission_idempotency_key
  ON event_submissions(idempotency_key_hash)
  WHERE idempotency_key_hash IS NOT NULL;
