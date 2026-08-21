PRAGMA foreign_keys = ON;

CREATE TABLE revision_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

INSERT INTO revision_state (id, revision, updated_at)
VALUES (1, 0, '1970-01-01T00:00:00.000Z');

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'editor')),
  password_algorithm TEXT NOT NULL DEFAULT 'pbkdf2-sha256',
  password_iterations INTEGER NOT NULL DEFAULT 100000,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(email) BETWEEN 3 AND 254),
  CHECK (length(display_name) <= 120),
  CHECK (password_iterations = 100000),
  CHECK (length(password_salt) >= 16),
  CHECK (length(password_hash) >= 43)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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

CREATE INDEX idx_sessions_user_expiry ON sessions(user_id, expires_at);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE locations (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  city TEXT NOT NULL,
  island TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(slug) BETWEEN 1 AND 100),
  CHECK (length(city) BETWEEN 1 AND 100),
  CHECK (length(island) BETWEEN 1 AND 100)
);

CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(slug) BETWEEN 1 AND 80),
  CHECK (length(name) BETWEEN 1 AND 80)
);

CREATE TABLE media_assets (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (
    owner_type IN ('organization_submission', 'event_submission')
  ),
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('organization_logo', 'event_image')),
  status TEXT NOT NULL DEFAULT 'quarantined' CHECK (
    status IN ('quarantined', 'published', 'denied', 'deleted')
  ),
  alt_text TEXT NOT NULL,
  original_key TEXT NOT NULL UNIQUE,
  original_content_type TEXT NOT NULL CHECK (
    original_content_type IN ('image/jpeg', 'image/png', 'image/webp')
  ),
  original_size_bytes INTEGER NOT NULL,
  original_width INTEGER NOT NULL,
  original_height INTEGER NOT NULL,
  original_sha256 TEXT NOT NULL,
  derivative_key TEXT UNIQUE,
  derivative_content_type TEXT,
  derivative_size_bytes INTEGER,
  derivative_width INTEGER,
  derivative_height INTEGER,
  created_at TEXT NOT NULL,
  published_at TEXT,
  denied_at TEXT,
  original_deleted_at TEXT,
  deleted_at TEXT,
  CHECK (length(alt_text) BETWEEN 1 AND 300),
  CHECK (original_size_bytes BETWEEN 1 AND 5242880),
  CHECK (original_width BETWEEN 1 AND 12000),
  CHECK (original_height BETWEEN 1 AND 12000),
  CHECK (length(original_sha256) = 64),
  CHECK (
    (status = 'published' AND derivative_key IS NOT NULL AND published_at IS NOT NULL)
    OR status <> 'published'
  )
);

CREATE INDEX idx_media_owner ON media_assets(owner_type, owner_id);
CREATE INDEX idx_media_status_created ON media_assets(status, created_at);

CREATE TABLE organization_submissions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'approved', 'denied')
  ),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  submitter_email TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  submitter_phone TEXT NOT NULL DEFAULT '',
  public_email TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  public_phone TEXT NOT NULL DEFAULT '',
  new_location TEXT NOT NULL DEFAULT '',
  image_asset_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
  idempotency_hash TEXT,
  origin TEXT NOT NULL DEFAULT '',
  ip_hash TEXT NOT NULL DEFAULT '',
  reviewed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  published_organization_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(name) BETWEEN 2 AND 200),
  CHECK (length(description) BETWEEN 10 AND 500),
  CHECK (length(details) <= 5000),
  CHECK (length(website) <= 500),
  CHECK (length(submitter_email) <= 254),
  CHECK (length(submitter_phone) <= 50),
  CHECK (length(public_email) <= 254),
  CHECK (length(public_phone) <= 50),
  CHECK (length(new_location) <= 200),
  CHECK (submitter_email <> '' OR submitter_phone <> ''),
  CHECK (idempotency_hash IS NULL OR length(idempotency_hash) = 64)
);

CREATE UNIQUE INDEX ux_organization_submission_idempotency
  ON organization_submissions(idempotency_hash)
  WHERE idempotency_hash IS NOT NULL;
CREATE INDEX idx_organization_submission_status_created
  ON organization_submissions(status, created_at DESC, id DESC);

CREATE TABLE organization_submission_locations (
  submission_id TEXT NOT NULL REFERENCES organization_submissions(id) ON DELETE CASCADE,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  PRIMARY KEY (submission_id, location_id)
);

CREATE TABLE organization_submission_categories (
  submission_id TEXT NOT NULL REFERENCES organization_submissions(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  PRIMARY KEY (submission_id, category_id)
);

CREATE TABLE event_submissions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'approved', 'denied')
  ),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  start_at TEXT NOT NULL,
  end_at TEXT,
  timezone TEXT NOT NULL DEFAULT 'America/Nassau',
  venue_name TEXT NOT NULL,
  location_id TEXT REFERENCES locations(id) ON DELETE SET NULL,
  new_location TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  submitter_email TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  submitter_phone TEXT NOT NULL DEFAULT '',
  public_email TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  public_phone TEXT NOT NULL DEFAULT '',
  image_asset_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
  idempotency_hash TEXT,
  origin TEXT NOT NULL DEFAULT '',
  ip_hash TEXT NOT NULL DEFAULT '',
  reviewed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  published_event_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(name) BETWEEN 2 AND 200),
  CHECK (length(description) BETWEEN 10 AND 500),
  CHECK (length(details) <= 5000),
  CHECK (length(start_at) BETWEEN 16 AND 40),
  CHECK (length(timezone) BETWEEN 1 AND 80),
  CHECK (length(venue_name) BETWEEN 2 AND 200),
  CHECK (length(new_location) <= 200),
  CHECK (length(website) <= 500),
  CHECK (length(submitter_email) <= 254),
  CHECK (length(submitter_phone) <= 50),
  CHECK (length(public_email) <= 254),
  CHECK (length(public_phone) <= 50),
  CHECK (submitter_email <> '' OR submitter_phone <> ''),
  CHECK (idempotency_hash IS NULL OR length(idempotency_hash) = 64)
);

CREATE UNIQUE INDEX ux_event_submission_idempotency
  ON event_submissions(idempotency_hash)
  WHERE idempotency_hash IS NOT NULL;
CREATE INDEX idx_event_submission_status_created
  ON event_submissions(status, created_at DESC, id DESC);

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  public_email TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  public_phone TEXT NOT NULL DEFAULT '',
  custom_location TEXT NOT NULL DEFAULT '',
  image_asset_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
  source_submission_id TEXT UNIQUE REFERENCES organization_submissions(id) ON DELETE SET NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  published_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(slug) BETWEEN 1 AND 100),
  CHECK (length(name) BETWEEN 2 AND 200),
  CHECK (length(description) BETWEEN 10 AND 500),
  CHECK (length(details) <= 5000),
  CHECK (length(website) <= 500),
  CHECK (length(public_email) <= 254),
  CHECK (length(public_phone) <= 50),
  CHECK (length(custom_location) <= 200)
);

CREATE INDEX idx_organizations_active_name ON organizations(is_active, name);

CREATE TABLE organization_locations (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  PRIMARY KEY (organization_id, location_id)
);

CREATE TABLE organization_categories (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  PRIMARY KEY (organization_id, category_id)
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  start_at TEXT NOT NULL,
  end_at TEXT,
  timezone TEXT NOT NULL DEFAULT 'America/Nassau',
  venue_name TEXT NOT NULL,
  location_id TEXT REFERENCES locations(id) ON DELETE SET NULL,
  location_display TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  public_email TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  public_phone TEXT NOT NULL DEFAULT '',
  image_asset_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
  source_submission_id TEXT UNIQUE REFERENCES event_submissions(id) ON DELETE SET NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  published_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(slug) BETWEEN 1 AND 120),
  CHECK (length(name) BETWEEN 2 AND 200),
  CHECK (length(description) BETWEEN 10 AND 500),
  CHECK (length(details) <= 5000),
  CHECK (length(venue_name) BETWEEN 2 AND 200),
  CHECK (length(location_display) <= 220),
  CHECK (length(website) <= 500),
  CHECK (length(public_email) <= 254),
  CHECK (length(public_phone) <= 50)
);

CREATE INDEX idx_events_active_start ON events(is_active, start_at, id);

CREATE TABLE moderation_events (
  id TEXT PRIMARY KEY,
  submission_type TEXT NOT NULL CHECK (
    submission_type IN ('organization', 'event')
  ),
  submission_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (
    action IN ('submitted', 'approved', 'denied', 'restored')
  ),
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL DEFAULT '',
  private_notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  CHECK (length(reason) <= 500),
  CHECK (length(private_notes) <= 2000)
);

CREATE INDEX idx_moderation_submission
  ON moderation_events(submission_type, submission_id, created_at DESC);
CREATE INDEX idx_moderation_created ON moderation_events(created_at DESC, id DESC);

CREATE TABLE subscribers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'unsubscribed')
  ),
  consent_at TEXT NOT NULL,
  unsubscribed_at TEXT,
  unsubscribe_token_hash TEXT NOT NULL UNIQUE,
  ip_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(email) BETWEEN 3 AND 254),
  CHECK (length(unsubscribe_token_hash) = 64)
);

CREATE INDEX idx_subscribers_status_created
  ON subscribers(status, created_at DESC, id DESC);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_started_at TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  subject_type TEXT NOT NULL DEFAULT '',
  subject_id TEXT NOT NULL DEFAULT '',
  ip_hash TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_audit_created ON audit_events(created_at DESC, id DESC);
CREATE INDEX idx_audit_actor_created ON audit_events(actor_user_id, created_at DESC);

CREATE TABLE migration_map (
  source_system TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_table TEXT NOT NULL,
  target_id TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  PRIMARY KEY (source_system, source_table, source_id)
);

CREATE UNIQUE INDEX ux_migration_target ON migration_map(target_table, target_id);

INSERT INTO locations (id, slug, city, island, created_at, updated_at) VALUES
  ('loc_nassau', 'nassau-new-providence', 'Nassau', 'New Providence', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
  ('loc_freeport', 'freeport-grand-bahama', 'Freeport', 'Grand Bahama', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
  ('loc_marsh_harbour', 'marsh-harbour-abaco', 'Marsh Harbour', 'Abaco', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
  ('loc_george_town', 'george-town-exuma', 'George Town', 'Exuma', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
  ('loc_governors_harbour', 'governors-harbour-eleuthera', 'Governor''s Harbour', 'Eleuthera', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
  ('loc_alice_town', 'alice-town-bimini', 'Alice Town', 'Bimini', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
  ('loc_clarence_town', 'clarence-town-long-island', 'Clarence Town', 'Long Island', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
  ('loc_andros_town', 'andros-town-andros', 'Andros Town', 'Andros', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
  ('loc_dunmore_town', 'dunmore-town-harbour-island', 'Dunmore Town', 'Harbour Island', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
  ('loc_matthew_town', 'matthew-town-inagua', 'Matthew Town', 'Inagua', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');

INSERT INTO categories (id, slug, name, created_at, updated_at) VALUES
  ('cat_youth', 'youth-mentorship', 'Youth & Mentorship', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
  ('cat_environment', 'environment', 'Environment', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
  ('cat_education', 'education', 'Education', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
  ('cat_health', 'health-wellness', 'Health & Wellness', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
  ('cat_arts', 'arts-culture', 'Arts & Culture', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
  ('cat_support', 'community-support', 'Community Support', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
  ('cat_animals', 'animal-welfare', 'Animal Welfare', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
  ('cat_relief', 'disaster-relief', 'Disaster Relief', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
  ('cat_sports', 'sports-recreation', 'Sports & Recreation', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
  ('cat_faith', 'faith-service', 'Faith & Service', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
