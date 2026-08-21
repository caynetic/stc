PRAGMA foreign_keys = ON;

CREATE TABLE outreach_contacts (
  id TEXT PRIMARY KEY,
  organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  organization_name TEXT NOT NULL,
  contact_name TEXT NOT NULL DEFAULT '',
  contact_email TEXT NOT NULL DEFAULT '',
  contact_phone TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'not_contacted'
    CHECK (status IN ('not_contacted', 'contacted', 'responded', 'follow_up', 'closed')),
  last_contacted_at TEXT,
  next_follow_up_at TEXT,
  private_notes TEXT NOT NULL DEFAULT '',
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(organization_name) BETWEEN 1 AND 200),
  CHECK (length(contact_name) <= 200),
  CHECK (length(contact_email) <= 254),
  CHECK (length(contact_phone) <= 100),
  CHECK (length(private_notes) <= 5000)
);

CREATE INDEX idx_outreach_status_follow_up
  ON outreach_contacts(status, next_follow_up_at, updated_at DESC, id DESC);
CREATE INDEX idx_outreach_organization
  ON outreach_contacts(organization_id, updated_at DESC, id DESC);
CREATE INDEX idx_outreach_email
  ON outreach_contacts(contact_email, updated_at DESC, id DESC);
CREATE UNIQUE INDEX ux_outreach_listed_contact_email
  ON outreach_contacts(organization_id, contact_email)
  WHERE organization_id IS NOT NULL AND contact_email <> '';
CREATE UNIQUE INDEX ux_outreach_unlisted_contact_email
  ON outreach_contacts(organization_name COLLATE NOCASE, contact_email)
  WHERE organization_id IS NULL AND contact_email <> '';

CREATE TABLE outreach_activities (
  id TEXT PRIMARY KEY,
  outreach_contact_id TEXT NOT NULL REFERENCES outreach_contacts(id) ON DELETE RESTRICT,
  activity_type TEXT NOT NULL
    CHECK (activity_type IN ('email_sent', 'email_received', 'phone_call', 'meeting', 'note', 'status_change')),
  occurred_at TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '',
  evidence_reference TEXT NOT NULL DEFAULT '',
  previous_status TEXT
    CHECK (previous_status IS NULL OR previous_status IN ('not_contacted', 'contacted', 'responded', 'follow_up', 'closed')),
  new_status TEXT
    CHECK (new_status IS NULL OR new_status IN ('not_contacted', 'contacted', 'responded', 'follow_up', 'closed')),
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  CHECK (length(subject) <= 500),
  CHECK (length(details) <= 5000),
  CHECK (length(evidence_reference) <= 1000),
  CHECK (
    activity_type = 'status_change'
      OR (previous_status IS NULL AND new_status IS NULL)
  ),
  CHECK (
    activity_type <> 'status_change'
      OR (previous_status IS NOT NULL AND new_status IS NOT NULL)
  )
);

CREATE INDEX idx_outreach_activity_contact
  ON outreach_activities(outreach_contact_id, occurred_at DESC, created_at DESC, id DESC);
CREATE INDEX idx_outreach_activity_type
  ON outreach_activities(activity_type, occurred_at DESC, id DESC);

CREATE TRIGGER outreach_activities_append_only_update
BEFORE UPDATE ON outreach_activities
BEGIN
  SELECT RAISE(ABORT, 'outreach activities are append-only');
END;

CREATE TRIGGER outreach_activities_append_only_delete
BEFORE DELETE ON outreach_activities
BEGIN
  SELECT RAISE(ABORT, 'outreach activities are append-only');
END;

CREATE TABLE news_posts (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  body_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'archived')),
  published_at TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(slug) BETWEEN 1 AND 120),
  CHECK (length(title) BETWEEN 1 AND 200),
  CHECK (length(summary) BETWEEN 1 AND 500),
  CHECK (length(body_text) BETWEEN 1 AND 50000),
  CHECK (
    (status = 'published' AND published_at IS NOT NULL)
      OR (status <> 'published')
  )
);

CREATE INDEX idx_news_publication
  ON news_posts(status, published_at DESC, id DESC);
CREATE INDEX idx_news_updated
  ON news_posts(updated_at DESC, id DESC);
