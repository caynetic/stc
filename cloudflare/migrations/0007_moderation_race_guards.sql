PRAGMA foreign_keys = ON;

-- A moderation request first observes a submission state and then executes an
-- atomic D1 batch. Bind that batch to the exact state it observed so a stale
-- concurrent request cannot apply after another transition (including an ABA
-- denied -> restored -> denied cycle).
ALTER TABLE organization_submissions
  ADD COLUMN moderation_transition_token TEXT
  CHECK (
    moderation_transition_token IS NULL
    OR length(moderation_transition_token) BETWEEN 20 AND 200
  );

ALTER TABLE event_submissions
  ADD COLUMN moderation_transition_token TEXT
  CHECK (
    moderation_transition_token IS NULL
    OR length(moderation_transition_token) BETWEEN 20 AND 200
  );

ALTER TABLE moderation_events
  ADD COLUMN transition_token TEXT
  CHECK (transition_token IS NULL OR length(transition_token) BETWEEN 20 AND 200);

DROP TRIGGER IF EXISTS guard_moderation_event_state;

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
        AND (
          NEW.action = 'submitted'
          -- Preserve the original state guard for the currently deployed
          -- Worker while this additive migration is applied before new code.
          OR NEW.transition_token IS NULL
          OR (
            NEW.action IN ('approved', 'denied', 'restored')
            AND NEW.transition_token IS NOT NULL
            AND s.moderation_transition_token = NEW.transition_token
          )
        )
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
        AND (
          NEW.action = 'submitted'
          OR NEW.transition_token IS NULL
          OR (
            NEW.action IN ('approved', 'denied', 'restored')
            AND NEW.transition_token IS NOT NULL
            AND s.moderation_transition_token = NEW.transition_token
          )
        )
    );
END;
