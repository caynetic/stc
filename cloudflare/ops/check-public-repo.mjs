#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cloudflareRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(cloudflareRoot, "..");
const failures = [];

const inventory = spawnSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: repositoryRoot, encoding: "utf8" },
);
if (inventory.status !== 0) {
  process.stderr.write("Unable to inventory the public repository candidate.\n");
  process.exit(1);
}

const files = [...new Set(inventory.stdout.split("\0").filter(Boolean))]
  .filter((file) => existsSync(path.join(repositoryRoot, file)))
  .sort();
const forbiddenPathPatterns = [
  /(?:^|\/)\.DS_Store$/,
  /(?:^|\/)design-previews(?:\/|$)/,
  /^cloudflare\/\.dev\.vars$/,
  /^cloudflare\/\.wrangler(?:\/|$)/,
  /^cloudflare\/node_modules(?:\/|$)/,
  /^cloudflare\/wrangler\.private\.jsonc$/,
  /^cloudflare\/wrangler\.ci\.jsonc$/,
  /^cloudflare\/ops\/private(?:\/|$)/,
  /^cloudflare\/ops\/editorial-.*\.sql$/,
  /(?:^|\/)\.env(?:\..*)?$/,
  /\.(?:db|sqlite|sqlite3|pem|p12|key|log|zip)$/i,
];

for (const file of files) {
  const envExample = /(?:^|\/)\.env\.example$/.test(file);
  const devVarsExample = file === "cloudflare/.dev.vars.example";
  if (!envExample && !devVarsExample && forbiddenPathPatterns.some((pattern) => pattern.test(file))) {
    failures.push(`${file}: private or generated path would be published`);
  }
}

const secretPatterns = [
  { label: "private key material", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "GitHub token", pattern: /\b(?:gh[oprsu]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/ },
  { label: "JWT-like credential", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { label: "payment secret", pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { label: "private owner address", pattern: /\bchristopher@caynetic\.com\b/i },
];

for (const file of files) {
  const absolute = path.join(repositoryRoot, file);
  let size;
  try {
    size = statSync(absolute).size;
  } catch {
    continue;
  }
  if (size > 2_000_000) continue;
  const content = readFileSync(absolute);
  if (content.includes(0)) continue;
  const text = content.toString("utf8");
  for (const secret of secretPatterns) {
    if (secret.pattern.test(text)) failures.push(`${file}: possible ${secret.label}`);
  }
}

const publicConfigPath = path.join(cloudflareRoot, "wrangler.jsonc");
try {
  const config = JSON.parse(readFileSync(publicConfigPath, "utf8"));
  const zeroId = "00000000-0000-0000-0000-000000000000";
  const releaseFlags = [
    "MEMBER_APPLICATION_ENABLED",
    "TRANSACTIONAL_EMAIL_DELIVERY_ENABLED",
    "NEWSLETTER_DELIVERY_ENABLED",
    "NEWSLETTER_SUBSCRIPTION_ENABLED",
    "NEWSLETTER_DOUBLE_OPT_IN_VERIFIED",
    "MEMBER_SCHEMA_RELEASE_READY",
    "EMAIL_DELIVERY_RECONCILIATION_VERIFIED",
    "NEWSLETTER_SUPPRESSION_INGESTION_VERIFIED",
    "ADMIN_STEP_UP_VERIFIED",
  ];
  for (const environmentName of ["preview", "production"]) {
    const environment = config.env?.[environmentName];
    if (environment?.d1_databases?.[0]?.database_id !== zeroId) {
      failures.push(`cloudflare/wrangler.jsonc: ${environmentName} D1 identifier is not a placeholder`);
    }
    if (!String(environment?.vars?.TURNSTILE_SITE_KEY ?? "").startsWith("REPLACE_WITH_")) {
      failures.push(`cloudflare/wrangler.jsonc: ${environmentName} Turnstile site key is not a placeholder`);
    }
    for (const flag of releaseFlags) {
      if (environment?.vars?.[flag] !== "false") {
        failures.push(`cloudflare/wrangler.jsonc: ${environmentName} ${flag} is not fail-closed`);
      }
    }
  }
} catch {
  failures.push("cloudflare/wrangler.jsonc: public template is missing or invalid JSON");
}

const cloudflareIgnore = readFileSync(path.join(cloudflareRoot, ".gitignore"), "utf8");
for (const required of [".dev.vars", ".wrangler/", "wrangler.private.jsonc", "wrangler.ci.jsonc", "ops/private/"]) {
  if (!cloudflareIgnore.split(/\r?\n/).includes(required)) {
    failures.push(`cloudflare/.gitignore: missing ${required}`);
  }
}

if (failures.length) {
  process.stderr.write(`Public-repository check failed:\n- ${[...new Set(failures)].join("\n- ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Public-repository check passed for ${files.length} visible files.\n`);
}
