PRAGMA foreign_keys = ON;

-- Public contact points are staged separately from the submitter's private
-- verification details. Scalar public_email/public_phone columns remain for
-- compatibility while consumers move to these ordered, labeled records.
CREATE TABLE organization_submission_public_contacts (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES organization_submissions(id) ON DELETE CASCADE,
  contact_type TEXT NOT NULL CHECK (contact_type IN ('email', 'phone')),
  label TEXT NOT NULL,
  value TEXT NOT NULL,
  normalized_value TEXT NOT NULL COLLATE NOCASE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  created_at TEXT NOT NULL,
  CHECK (length(label) BETWEEN 1 AND 80),
  CHECK (
    (contact_type = 'email' AND length(value) BETWEEN 3 AND 254)
    OR (contact_type = 'phone' AND length(value) BETWEEN 7 AND 50)
  ),
  CHECK (length(normalized_value) BETWEEN 3 AND 254),
  CHECK (sort_order BETWEEN 0 AND 99),
  UNIQUE (submission_id, contact_type, normalized_value)
);

CREATE UNIQUE INDEX ux_organization_submission_public_contact_primary
  ON organization_submission_public_contacts(submission_id, contact_type)
  WHERE is_primary = 1;
CREATE INDEX idx_organization_submission_public_contact_order
  ON organization_submission_public_contacts(submission_id, sort_order, id);

CREATE TABLE organization_public_contacts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_type TEXT NOT NULL CHECK (contact_type IN ('email', 'phone')),
  label TEXT NOT NULL,
  value TEXT NOT NULL,
  normalized_value TEXT NOT NULL COLLATE NOCASE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  source_submission_contact_id TEXT UNIQUE
    REFERENCES organization_submission_public_contacts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(label) BETWEEN 1 AND 80),
  CHECK (
    (contact_type = 'email' AND length(value) BETWEEN 3 AND 254)
    OR (contact_type = 'phone' AND length(value) BETWEEN 7 AND 50)
  ),
  CHECK (length(normalized_value) BETWEEN 3 AND 254),
  CHECK (sort_order BETWEEN 0 AND 99),
  UNIQUE (organization_id, contact_type, normalized_value)
);

CREATE UNIQUE INDEX ux_organization_public_contact_primary
  ON organization_public_contacts(organization_id, contact_type)
  WHERE is_primary = 1;
CREATE INDEX idx_organization_public_contact_order
  ON organization_public_contacts(organization_id, sort_order, id);

-- Profile sections are controlled plain-text blocks. This keeps the public
-- page flexible without accepting arbitrary HTML or unbounded custom markup.
CREATE TABLE organization_submission_sections (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES organization_submissions(id) ON DELETE CASCADE,
  section_kind TEXT NOT NULL CHECK (
    section_kind IN ('mission', 'programs_services', 'ways_to_help', 'eligibility', 'hours')
  ),
  heading TEXT NOT NULL,
  body_text TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  CHECK (length(heading) BETWEEN 1 AND 120),
  CHECK (length(body_text) BETWEEN 1 AND 5000),
  CHECK (sort_order BETWEEN 0 AND 20),
  UNIQUE (submission_id, section_kind)
);

CREATE INDEX idx_organization_submission_section_order
  ON organization_submission_sections(submission_id, sort_order, id);

CREATE TABLE organization_sections (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  section_kind TEXT NOT NULL CHECK (
    section_kind IN ('mission', 'programs_services', 'ways_to_help', 'eligibility', 'hours')
  ),
  heading TEXT NOT NULL,
  body_text TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  source_submission_section_id TEXT UNIQUE
    REFERENCES organization_submission_sections(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(heading) BETWEEN 1 AND 120),
  CHECK (length(body_text) BETWEEN 1 AND 5000),
  CHECK (sort_order BETWEEN 0 AND 20),
  UNIQUE (organization_id, section_kind)
);

CREATE INDEX idx_organization_section_order
  ON organization_sections(organization_id, sort_order, id);

-- Existing explicitly-public scalar contacts are the only values backfilled.
-- Private submitter_email and submitter_phone values are deliberately absent.
INSERT INTO organization_submission_public_contacts (
  id, submission_id, contact_type, label, value, normalized_value,
  sort_order, is_primary, created_at
)
SELECT
  'orgsubcontact_email_' || id, id, 'email', 'General inquiries',
  public_email, lower(trim(public_email)), 0, 1, created_at
FROM organization_submissions
WHERE trim(public_email) <> '';

INSERT INTO organization_submission_public_contacts (
  id, submission_id, contact_type, label, value, normalized_value,
  sort_order, is_primary, created_at
)
SELECT
  'orgsubcontact_phone_' || id, id, 'phone', 'General inquiries',
  public_phone,
  replace(replace(replace(replace(replace(replace(trim(public_phone), ' ', ''), '-', ''), '(', ''), ')', ''), '.', ''), '+', ''),
  1, 1, created_at
FROM organization_submissions
WHERE trim(public_phone) <> '';

INSERT INTO organization_public_contacts (
  id, organization_id, contact_type, label, value, normalized_value,
  sort_order, is_primary, created_at, updated_at
)
SELECT
  'orgcontact_email_' || id, id, 'email', 'General inquiries',
  public_email, lower(trim(public_email)), 0, 1, published_at, updated_at
FROM organizations
WHERE trim(public_email) <> '';

INSERT INTO organization_public_contacts (
  id, organization_id, contact_type, label, value, normalized_value,
  sort_order, is_primary, created_at, updated_at
)
SELECT
  'orgcontact_phone_' || id, id, 'phone', 'General inquiries',
  public_phone,
  replace(replace(replace(replace(replace(replace(trim(public_phone), ' ', ''), '-', ''), '(', ''), ')', ''), '.', ''), '+', ''),
  1, 1, published_at, updated_at
FROM organizations
WHERE trim(public_phone) <> '';

-- Child rows with submission lineage may only be published after the parent
-- submission and organization have completed the guarded approval transition.
CREATE TRIGGER guard_organization_public_contact_publication
BEFORE INSERT ON organization_public_contacts
WHEN NEW.source_submission_contact_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'organization public contact state mismatch')
  WHERE NOT EXISTS (
    SELECT 1
    FROM organization_submission_public_contacts staged
    JOIN organization_submissions submission ON submission.id = staged.submission_id
    WHERE staged.id = NEW.source_submission_contact_id
      AND submission.status = 'approved'
      AND submission.published_organization_id = NEW.organization_id
      AND staged.contact_type = NEW.contact_type
      AND staged.label = NEW.label
      AND staged.value = NEW.value
      AND staged.normalized_value = NEW.normalized_value
      AND staged.sort_order = NEW.sort_order
      AND staged.is_primary = NEW.is_primary
  );
END;

CREATE TRIGGER guard_organization_section_publication
BEFORE INSERT ON organization_sections
WHEN NEW.source_submission_section_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'organization section state mismatch')
  WHERE NOT EXISTS (
    SELECT 1
    FROM organization_submission_sections staged
    JOIN organization_submissions submission ON submission.id = staged.submission_id
    WHERE staged.id = NEW.source_submission_section_id
      AND submission.status = 'approved'
      AND submission.published_organization_id = NEW.organization_id
      AND staged.section_kind = NEW.section_kind
      AND staged.heading = NEW.heading
      AND staged.body_text = NEW.body_text
      AND staged.sort_order = NEW.sort_order
  );
END;
