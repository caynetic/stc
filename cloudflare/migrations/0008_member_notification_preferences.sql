PRAGMA foreign_keys = ON;

CREATE TABLE member_notification_categories (
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (member_id, category_id)
);

CREATE INDEX idx_member_notification_categories_category
  ON member_notification_categories(category_id, member_id);

CREATE TRIGGER guard_member_notification_category_insert
BEFORE INSERT ON member_notification_categories
BEGIN
  SELECT RAISE(ABORT, 'notification category unavailable')
  WHERE NOT EXISTS (
    SELECT 1 FROM categories
    WHERE id = NEW.category_id AND is_active = 1
  );
END;

CREATE TRIGGER guard_member_notification_category_update
BEFORE UPDATE OF category_id ON member_notification_categories
BEGIN
  SELECT RAISE(ABORT, 'notification category unavailable')
  WHERE NOT EXISTS (
    SELECT 1 FROM categories
    WHERE id = NEW.category_id AND is_active = 1
  );
END;

CREATE TABLE member_notification_locations (
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (member_id, location_id)
);

CREATE INDEX idx_member_notification_locations_location
  ON member_notification_locations(location_id, member_id);

CREATE TRIGGER guard_member_notification_location_insert
BEFORE INSERT ON member_notification_locations
BEGIN
  SELECT RAISE(ABORT, 'notification location unavailable')
  WHERE NOT EXISTS (
    SELECT 1 FROM locations
    WHERE id = NEW.location_id AND is_active = 1
  );
END;

CREATE TRIGGER guard_member_notification_location_update
BEFORE UPDATE OF location_id ON member_notification_locations
BEGIN
  SELECT RAISE(ABORT, 'notification location unavailable')
  WHERE NOT EXISTS (
    SELECT 1 FROM locations
    WHERE id = NEW.location_id AND is_active = 1
  );
END;
