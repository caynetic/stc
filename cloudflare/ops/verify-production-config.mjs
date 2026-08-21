#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const options = {
  configPath: path.resolve(scriptDirectory, "../wrangler.private.jsonc"),
  runbookPath: path.resolve(scriptDirectory, "private/production-runbook.md"),
  target: "",
};
const arguments_ = process.argv.slice(2);

function usage() {
  process.stderr.write("Usage: node ops/verify-production-config.mjs [--env preview|production] [--config path] [--runbook path]\n");
  process.exit(2);
}

function followingValue(index) {
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) usage();
  return value;
}

for (let index = 0; index < arguments_.length; index += 1) {
  const argument = arguments_[index];
  if (argument === "--env") {
    options.target = followingValue(index);
    index += 1;
  } else if (argument.startsWith("--env=")) {
    options.target = argument.slice("--env=".length) || usage();
  } else if (argument === "--config") {
    options.configPath = path.resolve(process.cwd(), followingValue(index));
    index += 1;
  } else if (argument.startsWith("--config=")) {
    const value = argument.slice("--config=".length) || usage();
    options.configPath = path.resolve(process.cwd(), value);
  } else if (argument === "--runbook") {
    options.runbookPath = path.resolve(process.cwd(), followingValue(index));
    index += 1;
  } else if (argument.startsWith("--runbook=")) {
    const value = argument.slice("--runbook=".length) || usage();
    options.runbookPath = path.resolve(process.cwd(), value);
  } else {
    usage();
  }
}

if (options.target && options.target !== "preview" && options.target !== "production") {
  usage();
}
if (!existsSync(options.configPath)) {
  process.stderr.write("Private deployment config is missing. Copy wrangler.jsonc to wrangler.private.jsonc, provision it, and keep it out of Git.\n");
  process.exit(1);
}
if (!existsSync(options.runbookPath)) {
  process.stderr.write("Private release record is missing. Create it under ops/private and keep it out of Git.\n");
  process.exit(1);
}

const config = JSON.parse(readFileSync(options.configPath, "utf8"));
const runbook = readFileSync(options.runbookPath, "utf8");
const failures = [];
const targetArgument = options.target;
const zeroId = "00000000-0000-0000-0000-000000000000";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const emailCron = "*/15 * * * *";
const maintenanceCron = "17 6 * * *";
const preview = config.env?.preview;
const production = config.env?.production;
const releaseTargets = targetArgument
  ? [[targetArgument, config.env?.[targetArgument]]]
  : [["preview", preview], ["production", production]];
const requiredSecrets = [
  "SESSION_SECRET",
  "MEMBER_SESSION_SECRET",
  "IP_HASH_KEY",
  "RATE_LIMIT_HASH_KEY",
  "UNSUBSCRIBE_SECRET",
  "TURNSTILE_ORGANIZATION_SECRET",
  "TURNSTILE_EVENT_SECRET",
  "TURNSTILE_NEWSLETTER_SECRET",
  "TURNSTILE_MEMBER_SECRET",
  "FORWARD_EMAIL_NEWSLETTER_PASSWORD",
  "FORWARD_EMAIL_API_TOKEN",
  "FORWARD_EMAIL_WEBHOOK_SECRET",
  "NEWSLETTER_CONFIRMATION_SECRET",
];
const requiredMemberReleaseFlags = [
  "MEMBER_APPLICATION_ENABLED",
  "TRANSACTIONAL_EMAIL_DELIVERY_ENABLED",
  "MEMBER_SCHEMA_RELEASE_READY",
  "EMAIL_DELIVERY_RECONCILIATION_VERIFIED",
  "ADMIN_STEP_UP_VERIFIED",
];
const newsletterReleaseFlags = [
  "NEWSLETTER_DELIVERY_ENABLED",
  "NEWSLETTER_SUBSCRIPTION_ENABLED",
  "NEWSLETTER_DOUBLE_OPT_IN_VERIFIED",
  "NEWSLETTER_SUPPRESSION_INGESTION_VERIFIED",
];

function d1(environment) {
  return environment?.d1_databases?.find((database) => database.binding === "DB");
}

function bucketNames(environment) {
  return new Set((environment?.r2_buckets ?? []).map((bucket) => bucket.bucket_name));
}

function cronSet(environment) {
  return new Set((environment?.triggers ?? config.triggers)?.crons ?? []);
}

function requiredSecretSet(environment) {
  return new Set(environment?.secrets?.required ?? []);
}

function transactionalEmailBinding(environment) {
  return environment?.send_email?.find((binding) => binding.name === "EMAIL");
}

if (!preview || !production) failures.push("Preview or production named environment is missing.");
for (const [name, environment] of releaseTargets) {
  if (!environment) {
    failures.push(`${name} named environment is missing.`);
    continue;
  }
  const databaseId = d1(environment)?.database_id ?? "";
  const vars = environment?.vars ?? {};
  if (!uuid.test(databaseId) || databaseId === zeroId) failures.push(`${name} D1 database ID is not provisioned.`);
  if (vars.ENVIRONMENT !== name) failures.push(`${name} ENVIRONMENT does not exactly match its named environment.`);
  if (vars.REQUIRE_TURNSTILE !== "true") failures.push(`${name} Turnstile enforcement is disabled.`);
  if (vars.SESSION_TTL_SECONDS !== "28800") failures.push(`${name} absolute session lifetime is not explicitly 8 hours.`);
  if (vars.SESSION_IDLE_TTL_SECONDS !== "1800") failures.push(`${name} idle session lifetime is not explicitly 30 minutes.`);
  if (!/^0x4A[A-Za-z0-9_-]+$/.test(vars.TURNSTILE_SITE_KEY ?? "")) {
    failures.push(`${name} does not use a real Turnstile site key.`);
  }
  if (vars.PRIVATE_RETENTION_DAYS !== "30") failures.push(`${name} private retention is not explicitly 30 days.`);
  if (vars.PRIVATE_SUBMISSION_RETENTION_DAYS !== "90") {
    failures.push(`${name} private submission retention is not explicitly 90 days.`);
  }

  const crons = cronSet(environment);
  if (!crons.has(emailCron) || !crons.has(maintenanceCron)) {
    failures.push(`${name} must configure the bounded 15-minute email cron and separate daily maintenance cron.`);
  }
  for (const flag of requiredMemberReleaseFlags) {
    if (vars[flag] !== "true") failures.push(`${name} release gate ${flag} is not explicitly verified.`);
  }
  const newsletterEnabled = vars.NEWSLETTER_DELIVERY_ENABLED === "true"
    || vars.NEWSLETTER_SUBSCRIPTION_ENABLED === "true";
  for (const flag of newsletterReleaseFlags) {
    if (vars[flag] !== "true" && vars[flag] !== "false") {
      failures.push(`${name} newsletter gate ${flag} is not an explicit boolean.`);
    }
  }
  if (newsletterEnabled) {
    for (const flag of newsletterReleaseFlags) {
      if (vars[flag] !== "true") failures.push(`${name} newsletter release gate ${flag} is not explicitly verified.`);
    }
  } else if (vars.NEWSLETTER_DELIVERY_ENABLED !== "false" || vars.NEWSLETTER_SUBSCRIPTION_ENABLED !== "false") {
    failures.push(`${name} newsletter subscription and delivery must be disabled together for a member-only release.`);
  }
  for (const variable of [
    "MEMBER_SESSION_TTL_SECONDS",
    "MEMBER_SESSION_IDLE_TTL_SECONDS",
    "MEMBER_MAGIC_LINK_TTL_SECONDS",
    "MEMBER_LOGIN_IP_LIMIT",
    "MEMBER_LOGIN_EMAIL_LIMIT",
    "EMAIL_METADATA_RETENTION_DAYS",
    "EMAIL_FROM_SIGNIN",
    "EMAIL_FROM_NOTIFICATIONS",
    "EMAIL_REPLY_TO",
    "NEWSLETTER_FROM_EMAIL",
    "NEWSLETTER_DAILY_LIMIT",
    "NEWSLETTER_EMAIL_LIMIT",
    "NEWSLETTER_CONFIRMATION_TTL_SECONDS",
  ]) {
    if (!String(vars[variable] ?? "").trim()) failures.push(`${name} member/email variable ${variable} is missing.`);
  }
  const expectedMemberEmailVars = {
    MEMBER_SESSION_TTL_SECONDS: "2592000",
    MEMBER_SESSION_IDLE_TTL_SECONDS: "604800",
    MEMBER_MAGIC_LINK_TTL_SECONDS: "900",
    MEMBER_LOGIN_IP_LIMIT: "10",
    MEMBER_LOGIN_EMAIL_LIMIT: "5",
    EMAIL_METADATA_RETENTION_DAYS: "90",
    EMAIL_FROM_SIGNIN: "signin@servethecays.com",
    EMAIL_FROM_NOTIFICATIONS: "notifications@servethecays.com",
    EMAIL_REPLY_TO: "hello@servethecays.com",
    NEWSLETTER_FROM_EMAIL: "news@servethecays.com",
    NEWSLETTER_DAILY_LIMIT: "90",
    NEWSLETTER_EMAIL_LIMIT: "3",
    NEWSLETTER_CONFIRMATION_TTL_SECONDS: "86400",
  };
  for (const [variable, expected] of Object.entries(expectedMemberEmailVars)) {
    if (vars[variable] !== expected) {
      failures.push(`${name} ${variable} is not explicitly set to the reviewed value ${expected}.`);
    }
  }

  const declaredSecrets = requiredSecretSet(environment);
  for (const secret of requiredSecrets) {
    if (!declaredSecrets.has(secret)) failures.push(`${name} does not declare required secret ${secret}.`);
  }
  for (const retiredSecret of ["FORWARD_EMAIL_SIGNIN_PASSWORD", "FORWARD_EMAIL_NOTIFICATIONS_PASSWORD"]) {
    if (declaredSecrets.has(retiredSecret)) {
      failures.push(`${name} still declares retired transactional secret ${retiredSecret}.`);
    }
  }
  const emailBinding = transactionalEmailBinding(environment);
  if (!emailBinding) {
    failures.push(`${name} Cloudflare Email Service binding EMAIL is missing.`);
  } else {
    const allowedSenders = new Set(emailBinding.allowed_sender_addresses ?? []);
    for (const sender of ["signin@servethecays.com", "notifications@servethecays.com"]) {
      if (!allowedSenders.has(sender)) failures.push(`${name} email binding does not allow reviewed sender ${sender}.`);
    }
    if (allowedSenders.size !== 2) failures.push(`${name} email binding permits an unreviewed sender.`);
    if (emailBinding.destination_address || (emailBinding.allowed_destination_addresses ?? []).length) {
      failures.push(`${name} transactional email binding unexpectedly restricts member recipients.`);
    }
  }
  const requiredBuckets = name === "preview"
    ? ["serve-the-cays-private-preview", "serve-the-cays-media-preview"]
    : ["serve-the-cays-private-production", "serve-the-cays-media-production"];
  for (const bucket of requiredBuckets) {
    if (!bucketNames(environment).has(bucket)) failures.push(`${name} R2 binding ${bucket} is missing.`);
  }
  if (environment?.images?.binding !== "IMAGES") failures.push(`${name} Cloudflare Images binding IMAGES is missing.`);
}

if (!targetArgument || targetArgument === "preview") {
  if (preview?.vars?.APP_ORIGIN !== "https://serve-the-cays-preview.caynetic.workers.dev") failures.push("Preview origin is not canonical.");
  if (preview?.workers_dev !== true) failures.push("Preview workers.dev access is disabled.");
}
if (!targetArgument || targetArgument === "production") {
  if (production?.vars?.APP_ORIGIN !== "https://servethecays.com") failures.push("Production origin is not canonical.");
  if (production?.workers_dev !== false || production?.preview_urls !== false) failures.push("Production preview exposure is not disabled.");
  const productionRoutes = production?.routes ?? [];
  if (!productionRoutes.some((route) => route?.pattern === "servethecays.com" && route?.custom_domain === true)) {
    failures.push("Production Worker Custom Domain is not configured.");
  }
  if (productionRoutes.some((route) => route?.pattern === "servethecays.com/*")) {
    failures.push("Temporary production catch-all route is still configured.");
  }
}

for (const migration of [
  "0003_member_application.sql",
  "0004_email_provider_split.sql",
  "0005_organization_profiles.sql",
  "0006_security_hardening.sql",
  "0007_moderation_race_guards.sql",
  "0008_member_notification_preferences.sql",
  "0009_newsletter_delivery_integrity.sql",
  "0010_passwordless_admin.sql",
  "0011_outreach_and_news.sql",
]) {
  if (!existsSync(new URL(`../migrations/${migration}`, import.meta.url))) failures.push(`Required migration ${migration} is missing.`);
}
if ((!targetArgument || targetArgument === "preview") && !/preview preparation and release are authorized/i.test(runbook)) {
  failures.push("The production runbook does not authorize the gated preview release.");
}
if ((!targetArgument || targetArgument === "production") && /production remains\s+unauthorized/i.test(runbook)) {
  failures.push("The production runbook still requires explicit go-live authorization.");
}
if ((!targetArgument || targetArgument === "production") && !/final production cutover approval/i.test(runbook)) {
  failures.push("The private change record does not contain final production cutover approval.");
}

if (failures.length) {
  process.stderr.write(`Member/email release remains blocked:\n- ${failures.join("\n- ")}\n`);
  process.exitCode = 1;
} else {
  const newsletterEnabled = releaseTargets.every(([, environment]) => (
    environment?.vars?.NEWSLETTER_DELIVERY_ENABLED === "true"
      && environment?.vars?.NEWSLETTER_SUBSCRIPTION_ENABLED === "true"
  ));
  process.stdout.write(newsletterEnabled
    ? "Static member and newsletter release configuration gate passed; complete live pre- and post-deployment verification before activation.\n"
    : "Static member release configuration gate passed; newsletter subscription and delivery remain disabled for this staged release. Complete live pre- and post-deployment verification before activation.\n");
}
