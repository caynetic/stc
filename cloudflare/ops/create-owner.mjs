#!/usr/bin/env node

import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";

function readInput() {
  if (process.stdin.isTTY) {
    throw new Error("Pass a JSON object on standard input; credentials are never accepted as command-line arguments.");
  }
  const raw = readFileSync(0, "utf8");
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Input must be a JSON object.");
  return value;
}

function required(value, label, maximum) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${label} is required.`);
  if (text.length > maximum) throw new Error(`${label} is too long.`);
  return text;
}

function sql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

try {
  const input = readInput();
  const email = required(input.email, "email", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("email is invalid.");
  const displayName = typeof input.display_name === "string" ? input.display_name.trim().slice(0, 120) : "";
  const output = required(input.output, "output", 4096);
  const salt = randomBytes(24).toString("base64url");
  const disabledVerifier = randomBytes(32).toString("base64url");
  const userId = `user_${randomUUID().replaceAll("-", "")}`;
  const now = new Date().toISOString();
  const statement = `PRAGMA foreign_keys = ON;

-- Restricted owner allowlist record. The legacy verifier columns contain
-- random unusable values only; administrator entry requires an email link.
INSERT INTO users (
  id, email, display_name, role, password_algorithm, password_iterations,
  password_salt, password_hash, is_active, created_at, updated_at
) VALUES (
  ${sql(userId)}, ${sql(email)}, ${sql(displayName)}, 'owner',
  'magic-link-only', 100000, ${sql(salt)}, ${sql(disabledVerifier)}, 1,
  ${sql(now)}, ${sql(now)}
)
ON CONFLICT(email) DO UPDATE SET
  display_name = excluded.display_name,
  role = 'owner',
  password_algorithm = excluded.password_algorithm,
  password_iterations = excluded.password_iterations,
  password_salt = excluded.password_salt,
  password_hash = excluded.password_hash,
  is_active = 1,
  updated_at = excluded.updated_at;

-- Allowlist changes invalidate every administrator session for this owner.
DELETE FROM sessions
WHERE user_id = (SELECT id FROM users WHERE email = ${sql(email)});
`;
  writeFileSync(output, statement, { encoding: "utf8", mode: 0o600, flag: input.force ? "w" : "wx" });
  chmodSync(output, 0o600);
  process.stderr.write("Prepared one passwordless owner allowlist SQL record.\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Owner provisioning failed."}\n`);
  process.exitCode = 1;
}
