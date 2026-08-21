PRAGMA foreign_keys = ON;

-- Administrator privilege is now granted only after the allowlisted address
-- consumes a member email link. Retire every stored password verifier so an
-- older Worker version cannot authenticate it, and expire existing admin
-- sessions at the release boundary.
UPDATE users
SET password_algorithm = 'magic-link-only',
    password_salt = lower(hex(randomblob(24))),
    password_hash = lower(hex(randomblob(32))),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

DELETE FROM sessions;
