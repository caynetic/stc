PRAGMA foreign_keys = ON;

INSERT INTO users (
  id, email, display_name, role, password_algorithm, password_iterations,
  password_salt, password_hash, is_active, created_at, updated_at
) VALUES (
  'user_local_owner',
  'owner@example.test',
  'Local Owner',
  'owner',
  'magic-link-only',
  100000,
  'local-magic-link-only-admin-salt',
  '0000000000000000000000000000000000000000000000000000000000000000',
  1,
  '2026-08-16T00:00:00.000Z',
  '2026-08-16T00:00:00.000Z'
)
ON CONFLICT(email) DO UPDATE SET
  display_name = excluded.display_name,
  role = 'owner',
  password_algorithm = 'magic-link-only',
  password_iterations = 100000,
  password_salt = excluded.password_salt,
  password_hash = excluded.password_hash,
  is_active = 1,
  updated_at = excluded.updated_at;

INSERT OR IGNORE INTO organizations (
  id, slug, name, description, details, website, public_email,
  public_phone, published_at, updated_at
) VALUES (
  'org_demo_hands',
  'bahamas-community-hands',
  'Bahamas Community Hands',
  'A demonstration listing showing how local volunteer and mentorship programs appear in the new directory.',
  'This record exists only in local development. Replace it with verified organization data before a production migration.',
  'https://example.com',
  'hello@example.com',
  '',
  '2026-08-01T00:00:00.000Z',
  '2026-08-01T00:00:00.000Z'
);

INSERT OR IGNORE INTO organizations (
  id, slug, name, description, details, website, public_email,
  public_phone, published_at, updated_at
) VALUES (
  'org_demo_partners',
  'cays-community-partners',
  'Cays Community Partners',
  'A second local-only organization used to demonstrate events supported by more than one community group.',
  'This record exists only in local development. It makes the multi-organization event review and member experience testable without production data.',
  'https://example.org',
  'partners@example.org',
  '',
  '2026-08-01T00:00:00.000Z',
  '2026-08-01T00:00:00.000Z'
);

INSERT OR IGNORE INTO organization_locations (organization_id, location_id)
VALUES ('org_demo_hands', 'loc_nassau');

INSERT OR IGNORE INTO organization_locations (organization_id, location_id)
VALUES ('org_demo_partners', 'loc_nassau');

INSERT OR IGNORE INTO organization_categories (organization_id, category_id)
VALUES ('org_demo_hands', 'cat_youth');

INSERT OR IGNORE INTO organization_categories (organization_id, category_id)
VALUES ('org_demo_partners', 'cat_support');

UPDATE organizations
SET details = 'Bahamas Community Hands connects residents with practical service projects and dependable mentorship across New Providence. The local-only profile demonstrates the fuller public organization layout.',
    public_phone = '+1 242 555 0142',
    updated_at = '2026-08-14T00:00:00.000Z'
WHERE id = 'org_demo_hands';

INSERT OR IGNORE INTO organization_public_contacts (
  id, organization_id, contact_type, label, value, normalized_value,
  sort_order, is_primary, created_at, updated_at
) VALUES
  ('orgcontact_demo_hands_general_email', 'org_demo_hands', 'email', 'General inquiries', 'hello@example.com', 'hello@example.com', 0, 1, '2026-08-01T00:00:00.000Z', '2026-08-14T00:00:00.000Z'),
  ('orgcontact_demo_hands_general_phone', 'org_demo_hands', 'phone', 'Main office', '+1 242 555 0142', '12425550142', 1, 1, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'),
  ('orgcontact_demo_hands_volunteer_email', 'org_demo_hands', 'email', 'Volunteer team', 'volunteer@example.com', 'volunteer@example.com', 2, 0, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'),
  ('orgcontact_demo_hands_programs_phone', 'org_demo_hands', 'phone', 'Programs', '+1 242 555 0188', '12425550188', 3, 0, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'),
  ('orgcontact_demo_partners_general_email', 'org_demo_partners', 'email', 'General inquiries', 'partners@example.org', 'partners@example.org', 0, 1, '2026-08-01T00:00:00.000Z', '2026-08-14T00:00:00.000Z');

INSERT OR IGNORE INTO organization_sections (
  id, organization_id, section_kind, heading, body_text, sort_order,
  created_at, updated_at
) VALUES
  ('orgsection_demo_hands_mission', 'org_demo_hands', 'mission', 'Mission', 'To make community service easier to find, easier to join, and more consistent for residents who want to help.', 0, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'),
  ('orgsection_demo_hands_programs', 'org_demo_hands', 'programs_services', 'Programs & services', 'Weekly youth mentorship, neighbourhood supply drives, and volunteer matching for local community projects.', 1, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'),
  ('orgsection_demo_hands_help', 'org_demo_hands', 'ways_to_help', 'Ways to help', 'Volunteer at a service day, mentor a young person, donate requested supplies, or help the team coordinate outreach.', 2, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'),
  ('orgsection_demo_hands_eligibility', 'org_demo_hands', 'eligibility', 'Who can participate', 'Adults and supervised youth are welcome. Some mentorship roles may require advance registration and safeguarding checks.', 3, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'),
  ('orgsection_demo_hands_hours', 'org_demo_hands', 'hours', 'Hours & availability', 'General inquiries are answered Monday through Friday. Volunteer activities are usually held on weekday afternoons and Saturday mornings.', 4, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');

INSERT OR IGNORE INTO events (
  slug, name, description, details, start_at, timezone, venue_name,
  location_id, location_display, website, public_email, published_at, updated_at
) VALUES (
  'community-service-day',
  'Community Service Day',
  'A demonstration event showing the approved event experience in local development.',
  'This record exists only in local development and must not be migrated to production.',
  '2026-12-05T09:00:00-05:00',
  'America/Nassau',
  'Nassau Community Centre',
  'loc_nassau',
  'Nassau, New Providence',
  'https://example.com',
  'events@example.com',
  '2026-08-01T00:00:00.000Z',
  '2026-08-01T00:00:00.000Z'
);

INSERT OR IGNORE INTO events (
  slug, name, description, details, start_at, timezone, venue_name,
  location_id, location_display, website, public_email, published_at, updated_at
) VALUES (
  'volunteer-orientation',
  'Island Volunteer Orientation',
  'A standalone demonstration event that is not connected to an organization.',
  'This local-only record proves that organization relationships remain optional.',
  '2026-12-12T10:00:00-05:00',
  'America/Nassau',
  'Nassau Community Centre',
  'loc_nassau',
  'Nassau, New Providence',
  'https://example.net',
  'orientation@example.net',
  '2026-08-01T00:00:00.000Z',
  '2026-08-01T00:00:00.000Z'
);

INSERT OR IGNORE INTO events (
  slug, name, description, details, start_at, end_at, timezone, venue_name,
  location_id, location_display, website, public_email, published_at, updated_at
) VALUES (
  'past-community-cleanup',
  'Past Community Cleanup',
  'An ended local-only event used to verify read-only archive behavior.',
  'This local-only record must remain absent from future directories and the sitemap.',
  '2026-01-10T09:00:00-05:00',
  '2026-01-10T12:00:00-05:00',
  'America/Nassau',
  'Nassau Community Centre',
  'loc_nassau',
  'Nassau, New Providence',
  'https://example.edu',
  'archive@example.edu',
  '2026-01-01T00:00:00.000Z',
  '2026-01-10T17:00:00.000Z'
);

INSERT OR IGNORE INTO event_organizations (
  event_id, organization_id, role, is_primary, created_at
)
SELECT id, 'org_demo_hands', 'host', 1, '2026-08-01T00:00:00.000Z'
FROM events
WHERE slug = 'community-service-day';

INSERT OR IGNORE INTO event_organizations (
  event_id, organization_id, role, is_primary, created_at
)
SELECT id, 'org_demo_partners', 'partner', 0, '2026-08-01T00:00:00.000Z'
FROM events
WHERE slug = 'community-service-day';
