PRAGMA foreign_keys = ON;

CREATE TABLE members (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  reminder_emails_enabled INTEGER NOT NULL DEFAULT 1 CHECK (reminder_emails_enabled IN (0, 1)),
  legacy_favorites_imported_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(email) BETWEEN 3 AND 254),
  CHECK (length(display_name) <= 120)
);

CREATE TABLE member_magic_links (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  token_hash TEXT NOT NULL UNIQUE,
  return_path TEXT NOT NULL DEFAULT '/',
  pending_action_json TEXT NOT NULL DEFAULT '{}',
  ip_hash TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (length(email) BETWEEN 3 AND 254),
  CHECK (length(token_hash) = 64),
  CHECK (length(return_path) BETWEEN 1 AND 500),
  CHECK (length(pending_action_json) <= 2000)
);

CREATE INDEX idx_member_magic_links_email_created
  ON member_magic_links(email, created_at DESC);
CREATE INDEX idx_member_magic_links_expiry
  ON member_magic_links(expires_at);

CREATE TABLE member_sessions (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  magic_link_id TEXT UNIQUE REFERENCES member_magic_links(id) ON DELETE SET NULL,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_hash TEXT NOT NULL,
  ip_hash TEXT NOT NULL DEFAULT '',
  user_agent_hash TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (length(token_hash) = 64),
  CHECK (length(csrf_hash) = 64)
);

CREATE INDEX idx_member_sessions_member_expiry
  ON member_sessions(member_id, expires_at);
CREATE INDEX idx_member_sessions_expiry
  ON member_sessions(expires_at);

CREATE TRIGGER guard_member_session_magic_link
BEFORE INSERT ON member_sessions
BEGIN
  SELECT RAISE(ABORT, 'magic link unavailable')
  WHERE NEW.magic_link_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM member_magic_links link
    WHERE link.id = NEW.magic_link_id
      AND link.consumed_at IS NULL
      AND link.expires_at > NEW.created_at
  );
END;

ALTER TABLE organization_submissions
  ADD COLUMN member_id TEXT REFERENCES members(id) ON DELETE SET NULL;
ALTER TABLE event_submissions
  ADD COLUMN member_id TEXT REFERENCES members(id) ON DELETE SET NULL;

CREATE INDEX idx_organization_submissions_member_created
  ON organization_submissions(member_id, created_at DESC);
CREATE INDEX idx_event_submissions_member_created
  ON event_submissions(member_id, created_at DESC);

CREATE TABLE organization_favorites (
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (member_id, organization_id)
);

CREATE INDEX idx_organization_favorites_member_created
  ON organization_favorites(member_id, created_at DESC);

CREATE TABLE event_favorites (
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (member_id, event_id)
);

CREATE INDEX idx_event_favorites_member_created
  ON event_favorites(member_id, created_at DESC);

CREATE TABLE event_rsvps (
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'going' CHECK (status IN ('going', 'cancelled')),
  transition_count INTEGER NOT NULL DEFAULT 1 CHECK (transition_count >= 1),
  reminder_sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (member_id, event_id)
);

CREATE INDEX idx_event_rsvps_event_status
  ON event_rsvps(event_id, status);
CREATE INDEX idx_event_rsvps_member_updated
  ON event_rsvps(member_id, updated_at DESC);
CREATE INDEX idx_event_rsvps_reminders
  ON event_rsvps(status, reminder_sent_at, event_id);

CREATE TABLE event_organizations (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('host', 'organizer', 'partner', 'beneficiary')),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (event_id, organization_id)
);

CREATE UNIQUE INDEX ux_event_organizations_primary
  ON event_organizations(event_id)
  WHERE is_primary = 1;
CREATE INDEX idx_event_organizations_organization
  ON event_organizations(organization_id, event_id);

CREATE TABLE event_submission_organizations (
  submission_id TEXT NOT NULL REFERENCES event_submissions(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('host', 'organizer', 'partner', 'beneficiary')),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (submission_id, organization_id)
);

CREATE UNIQUE INDEX ux_event_submission_organizations_primary
  ON event_submission_organizations(submission_id)
  WHERE is_primary = 1;
CREATE INDEX idx_event_submission_organizations_organization
  ON event_submission_organizations(organization_id, submission_id);

CREATE TRIGGER guard_event_organization_active
BEFORE INSERT ON event_organizations
BEGIN
  SELECT RAISE(ABORT, 'event organization unavailable')
  WHERE NOT EXISTS (
    SELECT 1
    FROM events e JOIN organizations o ON o.id = NEW.organization_id
    WHERE e.id = NEW.event_id AND e.is_active = 1 AND o.is_active = 1
  );
END;

CREATE TRIGGER guard_event_submission_organization_insert
BEFORE INSERT ON event_submission_organizations
BEGIN
  SELECT RAISE(ABORT, 'event submission links unavailable')
  WHERE NOT EXISTS (
    SELECT 1
    FROM event_submissions s JOIN organizations o ON o.id = NEW.organization_id
    WHERE s.id = NEW.submission_id AND s.status <> 'approved' AND o.is_active = 1
  );
END;

CREATE TRIGGER guard_event_submission_organization_delete
BEFORE DELETE ON event_submission_organizations
WHEN EXISTS (SELECT 1 FROM event_submissions WHERE id = OLD.submission_id)
BEGIN
  SELECT RAISE(ABORT, 'event submission links unavailable')
  WHERE NOT EXISTS (
    SELECT 1 FROM event_submissions
    WHERE id = OLD.submission_id AND status <> 'approved'
  );
END;

CREATE TABLE email_jobs (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (
    kind IN (
      'magic_link',
      'welcome',
      'rsvp_confirmation',
      'rsvp_cancellation',
      'event_reminder',
      'submission_receipt',
      'submission_approved',
      'submission_denied'
    )
  ),
  member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  recipient_email TEXT NOT NULL COLLATE NOCASE,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'processing', 'sent', 'failed')
  ),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL,
  locked_at TEXT,
  sent_at TEXT,
  provider_message_id TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(recipient_email) BETWEEN 3 AND 254),
  CHECK (length(payload_json) <= 65536),
  CHECK (length(last_error) <= 1000)
);

CREATE INDEX idx_email_jobs_pending
  ON email_jobs(status, available_at, created_at);
CREATE INDEX idx_email_jobs_member_created
  ON email_jobs(member_id, created_at DESC);
CREATE INDEX idx_email_jobs_sent_at
  ON email_jobs(sent_at);

CREATE TRIGGER queue_rsvp_confirmation_after_insert
AFTER INSERT ON event_rsvps
WHEN NEW.status = 'going'
BEGIN
  INSERT INTO email_jobs (
    id, idempotency_key, kind, member_id, recipient_email, payload_json,
    status, attempts, available_at, created_at, updated_at
  )
  SELECT
    'email_' || lower(hex(randomblob(16))),
    'rsvp-confirmation:' || NEW.member_id || ':' || NEW.event_id || ':' || NEW.transition_count,
    'rsvp_confirmation',
    NEW.member_id,
    m.email,
    json_object(
      'event_id', e.id,
      'name', e.name,
      'start_at', e.start_at,
      'end_at', e.end_at,
      'timezone', e.timezone,
      'venue_name', e.venue_name,
      'location_display', e.location_display,
      'subject_type', 'event',
      'subject_id', CAST(e.id AS TEXT)
    ),
    'pending', 0, NEW.updated_at, NEW.updated_at, NEW.updated_at
  FROM members m JOIN events e ON e.id = NEW.event_id
  WHERE m.id = NEW.member_id
  ON CONFLICT(idempotency_key) DO NOTHING;
END;

CREATE TRIGGER queue_rsvp_email_after_status_change
AFTER UPDATE OF status ON event_rsvps
WHEN OLD.status <> NEW.status
BEGIN
  INSERT INTO email_jobs (
    id, idempotency_key, kind, member_id, recipient_email, payload_json,
    status, attempts, available_at, created_at, updated_at
  )
  SELECT
    'email_' || lower(hex(randomblob(16))),
    CASE NEW.status
      WHEN 'going' THEN 'rsvp-confirmation:'
      ELSE 'rsvp-cancellation:'
    END || NEW.member_id || ':' || NEW.event_id || ':' || NEW.transition_count,
    CASE NEW.status
      WHEN 'going' THEN 'rsvp_confirmation'
      ELSE 'rsvp_cancellation'
    END,
    NEW.member_id,
    m.email,
    json_object(
      'event_id', e.id,
      'name', e.name,
      'start_at', e.start_at,
      'end_at', e.end_at,
      'timezone', e.timezone,
      'venue_name', e.venue_name,
      'location_display', e.location_display,
      'subject_type', 'event',
      'subject_id', CAST(e.id AS TEXT)
    ),
    'pending', 0, NEW.updated_at, NEW.updated_at, NEW.updated_at
  FROM members m JOIN events e ON e.id = NEW.event_id
  WHERE m.id = NEW.member_id
  ON CONFLICT(idempotency_key) DO NOTHING;
END;

CREATE TRIGGER guard_member_pending_action_organization_favorite
BEFORE INSERT ON organization_favorites
BEGIN
  SELECT RAISE(ABORT, 'organization favorite unavailable')
  WHERE NOT EXISTS (
    SELECT 1 FROM organizations o
    WHERE o.id = NEW.organization_id AND o.is_active = 1
  );
END;

CREATE TRIGGER guard_member_pending_action_event_favorite
BEFORE INSERT ON event_favorites
BEGIN
  SELECT RAISE(ABORT, 'event favorite unavailable')
  WHERE NOT EXISTS (
    SELECT 1 FROM events e
    WHERE e.id = NEW.event_id
      AND e.is_active = 1
      AND COALESCE(e.end_at, e.start_at) > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER guard_member_pending_action_event_rsvp
BEFORE INSERT ON event_rsvps
WHEN NEW.status = 'going'
BEGIN
  SELECT RAISE(ABORT, 'event RSVP unavailable')
  WHERE NOT EXISTS (
    SELECT 1 FROM events e
    WHERE e.id = NEW.event_id
      AND e.is_active = 1
      AND COALESCE(e.end_at, e.start_at) > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;
