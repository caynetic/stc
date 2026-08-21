-- Fail closed if concurrent moderation requests observe stale submission state.
-- D1 batch execution is atomic, and these trigger failures roll back the full
-- publication or moderation batch.

CREATE TRIGGER guard_organization_publication_insert
BEFORE INSERT ON organizations
WHEN NEW.source_submission_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'organization publication state mismatch')
  WHERE NOT EXISTS (
    SELECT 1
    FROM organization_submissions s
    WHERE s.id = NEW.source_submission_id
      AND s.status = 'approved'
      AND s.published_organization_id = NEW.id
  );

  SELECT RAISE(ABORT, 'organization media state mismatch')
  WHERE NEW.image_asset_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM media_assets m
      WHERE m.id = NEW.image_asset_id
        AND m.status = 'published'
        AND m.owner_type = 'organization_submission'
        AND m.owner_id = NEW.source_submission_id
    );
END;

CREATE TRIGGER guard_event_publication_insert
BEFORE INSERT ON events
WHEN NEW.source_submission_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'event publication state mismatch')
  WHERE NOT EXISTS (
    SELECT 1
    FROM event_submissions s
    WHERE s.id = NEW.source_submission_id
      AND s.status = 'approved'
      AND s.published_event_id = NEW.id
  );

  SELECT RAISE(ABORT, 'event media state mismatch')
  WHERE NEW.image_asset_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM media_assets m
      WHERE m.id = NEW.image_asset_id
        AND m.status = 'published'
        AND m.owner_type = 'event_submission'
        AND m.owner_id = NEW.source_submission_id
    );
END;

CREATE TRIGGER guard_moderation_event_state
BEFORE INSERT ON moderation_events
BEGIN
  SELECT RAISE(ABORT, 'organization moderation state mismatch')
  WHERE NEW.submission_type = 'organization'
    AND NOT EXISTS (
      SELECT 1
      FROM organization_submissions s
      WHERE s.id = NEW.submission_id
        AND s.status = CASE
          WHEN NEW.action IN ('submitted', 'restored') THEN 'pending'
          ELSE NEW.action
        END
    );

  SELECT RAISE(ABORT, 'event moderation state mismatch')
  WHERE NEW.submission_type = 'event'
    AND NOT EXISTS (
      SELECT 1
      FROM event_submissions s
      WHERE s.id = NEW.submission_id
        AND s.status = CASE
          WHEN NEW.action IN ('submitted', 'restored') THEN 'pending'
          ELSE NEW.action
        END
    );
END;
