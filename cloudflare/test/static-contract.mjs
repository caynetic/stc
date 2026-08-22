import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(root, "..");

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? files(full) : [full];
  });
}

test("the public Cloudflare deployment template stays explicit and fail-closed", () => {
  const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.match(packageJson.scripts.deploy, /direct npm deployment is disabled/);
  assert.match(packageJson.scripts["build:production"], /deploy --dry-run/);
  const config = JSON.parse(readFileSync(path.join(root, "wrangler.jsonc"), "utf8"));
  const preview = config.env.preview;
  const production = config.env.production;
  const zeroId = "00000000-0000-0000-0000-000000000000";
  assert.equal(preview.d1_databases[0].database_id, zeroId);
  assert.equal(production.d1_databases[0].database_id, zeroId);
  assert.equal(preview.vars.APP_ORIGIN, "https://serve-the-cays-preview.caynetic.workers.dev");
  assert.equal(production.vars.APP_ORIGIN, "https://servethecays.com");
  assert.equal(preview.vars.REQUIRE_TURNSTILE, "true");
  assert.equal(production.vars.REQUIRE_TURNSTILE, "true");
  assert.equal(preview.vars.SESSION_TTL_SECONDS, "28800");
  assert.equal(preview.vars.SESSION_IDLE_TTL_SECONDS, "1800");
  assert.equal(production.vars.SESSION_TTL_SECONDS, "28800");
  assert.equal(production.vars.SESSION_IDLE_TTL_SECONDS, "1800");
  assert.match(preview.vars.TURNSTILE_SITE_KEY, /^REPLACE_WITH_/);
  assert.equal(preview.vars.PRIVATE_RETENTION_DAYS, "30");
  assert.equal(preview.vars.PRIVATE_SUBMISSION_RETENTION_DAYS, "90");
  assert.equal(preview.vars.SUBMISSION_MEMBER_LIMIT, "5");
  assert.match(production.vars.TURNSTILE_SITE_KEY, /^REPLACE_WITH_/);
  assert.equal(production.workers_dev, false);
  assert.equal(production.preview_urls, false);
  assert.equal(production.vars.PRIVATE_RETENTION_DAYS, "30");
  assert.equal(production.vars.PRIVATE_SUBMISSION_RETENTION_DAYS, "90");
  assert.equal(production.vars.SUBMISSION_MEMBER_LIMIT, "5");
  assert.deepEqual(config.triggers.crons, ["*/15 * * * *", "17 6 * * *"]);
  assert.equal(preview.vars.MEMBER_APPLICATION_ENABLED, "false");
  assert.equal(preview.vars.ADMIN_STEP_UP_VERIFIED, "false");
  assert.equal(preview.vars.TRANSACTIONAL_EMAIL_DELIVERY_ENABLED, "false");
  assert.equal(preview.vars.MEMBER_SCHEMA_RELEASE_READY, "false");
  assert.equal(preview.vars.EMAIL_DELIVERY_RECONCILIATION_VERIFIED, "false");
  assert.equal(production.vars.MEMBER_APPLICATION_ENABLED, "false");
  assert.equal(production.vars.ADMIN_STEP_UP_VERIFIED, "false");
  assert.equal(production.vars.TRANSACTIONAL_EMAIL_DELIVERY_ENABLED, "false");
  assert.equal(production.vars.MEMBER_SCHEMA_RELEASE_READY, "false");
  assert.equal(production.vars.EMAIL_DELIVERY_RECONCILIATION_VERIFIED, "false");
  for (const target of [preview, production]) {
    assert.equal(target.vars.NEWSLETTER_SUBSCRIPTION_ENABLED, "false");
    assert.equal(target.vars.NEWSLETTER_DELIVERY_ENABLED, "false");
    assert.equal(target.vars.NEWSLETTER_DOUBLE_OPT_IN_VERIFIED, "false");
    assert.equal(target.vars.NEWSLETTER_SUPPRESSION_INGESTION_VERIFIED, "false");
    assert.equal(target.vars.PREVIEW_MEMBER_REVIEW_ENABLED, undefined);
  }
  assert.deepEqual(production.routes, [{ pattern: "servethecays.com", custom_domain: true }]);
});

test("GitHub deployment is opt-in and production remains manually protected", () => {
  const workflow = readFileSync(
    path.join(repositoryRoot, ".github", "workflows", "deploy.yml"),
    "utf8",
  );
  const selfHosting = readFileSync(
    path.join(repositoryRoot, "docs", "SELF_HOSTING.md"),
    "utf8",
  );

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /push:\s*\n\s*branches:\s*\n\s*- main/);
  assert.doesNotMatch(workflow, /pull_request:/);
  assert.equal((workflow.match(/vars\.CLOUDFLARE_DEPLOY_ENABLED == 'true'/g) ?? []).length, 2);
  assert.match(workflow, /inputs\.production_recovery_recorded/);
  assert.match(workflow, /environment:\s*\n\s*name: production/);
  assert.match(workflow, /cloudflare\/wrangler-action@v4/);
  assert.match(workflow, /secrets\.WRANGLER_CONFIG_JSONC/);
  assert.match(workflow, /d1 migrations apply DB --remote --config wrangler\.ci\.jsonc --env preview/);
  assert.match(workflow, /d1 migrations apply DB --remote --config wrangler\.ci\.jsonc --env production/);
  assert.match(workflow, /rm -f wrangler\.ci\.jsonc/);
  assert.match(selfHosting, /disabled\s+by default/i);
  assert.match(selfHosting, /GitHub Pages\s+site/);
});

test("Cloudflare transactional email and Forward Email newsletters remain gated", () => {
  const deploymentConfig = readFileSync(path.join(root, "wrangler.jsonc"), "utf8");
  const localConfig = readFileSync(path.join(root, "wrangler.local.jsonc"), "utf8");
  const deployment = JSON.parse(deploymentConfig);
  const local = JSON.parse(localConfig);
  const runbook = readFileSync(path.join(root, "ops", "production-runbook.md"), "utf8");
  const productionVerifier = readFileSync(
    path.join(root, "ops", "verify-production-config.mjs"),
    "utf8",
  );
  const email = readFileSync(path.join(root, "src", "email.ts"), "utf8");
  const cloudflareEmail = readFileSync(path.join(root, "src", "cloudflare-email.ts"), "utf8");
  const memberMigration = readFileSync(
    path.join(root, "migrations", "0003_member_application.sql"),
    "utf8",
  );
  const providerMigration = readFileSync(
    path.join(root, "migrations", "0004_email_provider_split.sql"),
    "utf8",
  );
  const securityMigration = readFileSync(
    path.join(root, "migrations", "0006_security_hardening.sql"),
    "utf8",
  );
  const moderationRaceMigration = readFileSync(
    path.join(root, "migrations", "0007_moderation_race_guards.sql"),
    "utf8",
  );
  const memberNotificationMigration = readFileSync(
    path.join(root, "migrations", "0008_member_notification_preferences.sql"),
    "utf8",
  );
  const newsletterIntegrityMigration = readFileSync(
    path.join(root, "migrations", "0009_newsletter_delivery_integrity.sql"),
    "utf8",
  );
  const passwordlessAdminMigration = readFileSync(
    path.join(root, "migrations", "0010_passwordless_admin.sql"),
    "utf8",
  );
  const outreachNewsMigration = readFileSync(
    path.join(root, "migrations", "0011_outreach_and_news.sql"),
    "utf8",
  );

  assert.doesNotMatch(localConfig, /send_email|send-email|EMAIL_SERVICE/i);
  assert.doesNotMatch(localConfig, /FORWARD_EMAIL_(?:SIGNIN|NOTIFICATIONS|NEWSLETTER)_PASSWORD/);
  for (const target of [deployment.env.preview, deployment.env.production]) {
    assert.deepEqual(target.send_email, [{
      name: "EMAIL",
      allowed_sender_addresses: [
        "signin@servethecays.com",
        "notifications@servethecays.com",
      ],
    }]);
    assert.equal(target.vars.NEWSLETTER_DELIVERY_ENABLED, "false");
    assert.equal(target.vars.FORWARD_EMAIL_SIGNIN_PASSWORD, undefined);
    assert.equal(target.vars.FORWARD_EMAIL_NOTIFICATIONS_PASSWORD, undefined);
    assert.equal(target.vars.FORWARD_EMAIL_NEWSLETTER_PASSWORD, undefined);
    assert.ok(target.secrets.required.includes("MEMBER_SESSION_SECRET"));
    assert.ok(target.secrets.required.includes("TURNSTILE_MEMBER_SECRET"));
    assert.ok(!target.secrets.required.includes("FORWARD_EMAIL_SIGNIN_PASSWORD"));
    assert.ok(!target.secrets.required.includes("FORWARD_EMAIL_NOTIFICATIONS_PASSWORD"));
    assert.ok(target.secrets.required.includes("FORWARD_EMAIL_NEWSLETTER_PASSWORD"));
    assert.ok(target.secrets.required.includes("FORWARD_EMAIL_API_TOKEN"));
    assert.ok(target.secrets.required.includes("FORWARD_EMAIL_WEBHOOK_SECRET"));
    assert.ok(target.secrets.required.includes("NEWSLETTER_CONFIRMATION_SECRET"));
  }

  assert.equal(local.vars.EMAIL_FROM_SIGNIN, "signin@servethecays.com");
  assert.equal(local.vars.EMAIL_FROM_NOTIFICATIONS, "notifications@servethecays.com");
  assert.equal(local.vars.EMAIL_REPLY_TO, "hello@servethecays.com");
  assert.equal(local.vars.NEWSLETTER_DELIVERY_ENABLED, "true");
  assert.equal(local.vars.NEWSLETTER_SUBSCRIPTION_ENABLED, "true");
  assert.equal(local.vars.NEWSLETTER_DOUBLE_OPT_IN_VERIFIED, "false");
  assert.equal(local.vars.NEWSLETTER_FROM_EMAIL, "news@servethecays.com");
  assert.equal(local.vars.NEWSLETTER_DAILY_LIMIT, "90");
  assert.match(email, /signin@servethecays\.com/);
  assert.match(email, /notifications@servethecays\.com/);
  assert.match(email, /sendTransactionalViaCloudflare/);
  assert.doesNotMatch(email, /FORWARD_EMAIL_(?:SIGNIN|NOTIFICATIONS)_PASSWORD/);
  assert.match(email, /replyTo:\s*env\.EMAIL_REPLY_TO\s*\|\|\s*"hello@servethecays\.com"/);
  assert.match(cloudflareEmail, /env\.EMAIL\.send/);
  assert.match(cloudflareEmail, /X-Entity-Ref-ID/);
  assert.match(cloudflareEmail, /E_RATE_LIMIT_EXCEEDED/);
  assert.match(cloudflareEmail, /E_RECIPIENT_SUPPRESSED/);
  assert.match(memberMigration, /CREATE TABLE email_jobs/);
  assert.match(providerMigration, /CREATE TABLE newsletter_digests/);
  assert.match(providerMigration, /CREATE TABLE newsletter_deliveries/);
  assert.match(providerMigration, /CREATE TABLE newsletter_suppressions/);
  assert.match(securityMigration, /CREATE TABLE media_cleanup_jobs/);
  assert.match(securityMigration, /idempotency_key_hash/);
  assert.match(moderationRaceMigration, /moderation_transition_token/);
  assert.match(moderationRaceMigration, /transition_token/);
  assert.match(memberNotificationMigration, /CREATE TABLE member_notification_categories/);
  assert.match(memberNotificationMigration, /CREATE TABLE member_notification_locations/);
  assert.match(newsletterIntegrityMigration, /CREATE TABLE newsletter_confirmation_requests/);
  assert.match(newsletterIntegrityMigration, /CREATE TABLE newsletter_provider_events/);
  assert.match(newsletterIntegrityMigration, /reconciliation_status/);
  assert.match(passwordlessAdminMigration, /password_algorithm = 'magic-link-only'/);
  assert.match(passwordlessAdminMigration, /DELETE FROM sessions/);
  assert.match(outreachNewsMigration, /CREATE TABLE outreach_contacts/);
  assert.match(outreachNewsMigration, /CREATE TABLE outreach_activities/);
  assert.match(outreachNewsMigration, /outreach activities are append-only/);
  assert.match(outreachNewsMigration, /CREATE TABLE news_posts/);
  assert.match(runbook, /not an authorization record/i);
  assert.match(runbook, /Production remains\s+unauthorized\s+by this public document/i);
  assert.match(runbook, /wrangler\.private\.jsonc/);
  assert.match(runbook, /private change record/i);
  assert.match(runbook, /0003_member_application\.sql/);
  assert.match(runbook, /0004_email_provider_split\.sql/);
  assert.match(runbook, /0006_security_hardening\.sql/);
  assert.match(runbook, /0007_moderation_race_guards\.sql/);
  assert.match(runbook, /0008_member_notification_preferences\.sql/);
  assert.match(runbook, /0009_newsletter_delivery_integrity\.sql/);
  assert.match(runbook, /0010_passwordless_admin\.sql/);
  assert.match(runbook, /0011_outreach_and_news\.sql/);
  assert.match(productionVerifier, /0006_security_hardening\.sql/);
  assert.match(productionVerifier, /0007_moderation_race_guards\.sql/);
  assert.match(productionVerifier, /0008_member_notification_preferences\.sql/);
  assert.match(productionVerifier, /0009_newsletter_delivery_integrity\.sql/);
  assert.match(productionVerifier, /0010_passwordless_admin\.sql/);
  assert.match(productionVerifier, /0011_outreach_and_news\.sql/);
  assert.match(runbook, /news@servethecays\.com/);
  assert.match(runbook, /SPF.*DKIM.*Return-Path.*DMARC/s);
  assert.match(runbook, /double-opt-in/i);
  assert.match(runbook, /MFA or step-up/i);
  assert.match(runbook, /single-use email link/i);

  const gateArguments = [
    path.join(root, "ops", "verify-production-config.mjs"),
    "--config",
    path.join(root, "wrangler.jsonc"),
    "--runbook",
    path.join(root, "ops", "production-runbook.md"),
  ];
  const gate = spawnSync(process.execPath, gateArguments, { encoding: "utf8" });
  assert.equal(gate.status, 1);
  assert.match(gate.stderr, /Member\/email release remains blocked/);
  assert.doesNotMatch(gate.stdout, /release configuration gate passed/);

  const previewGate = spawnSync(
    process.execPath,
    [...gateArguments, "--env", "preview"],
    { encoding: "utf8" },
  );
  assert.equal(previewGate.status, 1);
  assert.match(previewGate.stderr, /preview release gate MEMBER_APPLICATION_ENABLED/);
  assert.doesNotMatch(previewGate.stderr, /production release gate/);

  const productionGate = spawnSync(
    process.execPath,
    [...gateArguments, "--env", "production"],
    { encoding: "utf8" },
  );
  assert.equal(productionGate.status, 1);
  assert.match(productionGate.stderr, /production D1 database ID is not provisioned/);
  assert.match(productionGate.stderr, /final production cutover approval/);
  assert.doesNotMatch(productionGate.stdout, /release configuration gate passed/);
});

test("public fetches cannot drain email and cron workloads remain separate and bounded", () => {
  const worker = readFileSync(path.join(root, "src", "index.ts"), "utf8");
  const fetchHandler = worker.slice(
    worker.indexOf("async fetch(request:"),
    worker.indexOf("async scheduled(controller:"),
  );
  const scheduledHandler = worker.slice(worker.indexOf("async scheduled(controller:"));

  assert.doesNotMatch(fetchHandler, /processEmailJobs/);
  assert.match(worker, /TRANSACTIONAL_EMAIL_CRON = "\*\/15 \* \* \* \*"/);
  assert.match(worker, /DAILY_MAINTENANCE_CRON = "17 6 \* \* \*"/);
  assert.match(worker, /SCHEDULED_EMAIL_BATCH_SIZE = 10/);
  assert.match(scheduledHandler, /controller\.cron === TRANSACTIONAL_EMAIL_CRON/);
  assert.match(scheduledHandler, /controller\.cron === DAILY_MAINTENANCE_CRON/);
  assert.match(worker, /event: "scheduled_task_failed"/);
  assert.match(worker, /env\.ENVIRONMENT === "preview"[\s\S]*?PREVIEW_MEMBER_REVIEW_ENABLED/);
  assert.match(worker, /previewReviewEnabled \|\| deliveryReady/);
});

test("newsletter consent requires confirmation and provider failures are authenticated and reconciled", () => {
  const newsletter = readFileSync(path.join(root, "src", "newsletter.ts"), "utf8");
  const subscriptionFlow = newsletter.slice(
    newsletter.indexOf("export function newsletterSubscriptionEnabled"),
    newsletter.indexOf("async function markUnsubscribed"),
  );
  const confirmationClient = readFileSync(path.join(root, "public", "assets", "app.js"), "utf8");
  const worker = readFileSync(path.join(root, "src", "index.ts"), "utf8");

  assert.match(subscriptionFlow, /NEWSLETTER_SUBSCRIPTION_ENABLED/);
  assert.match(subscriptionFlow, /NEWSLETTER_DOUBLE_OPT_IN_VERIFIED/);
  assert.match(subscriptionFlow, /NEWSLETTER_SUPPRESSION_INGESTION_VERIFIED/);
  assert.match(subscriptionFlow, /EMAIL_DELIVERY_RECONCILIATION_VERIFIED/);
  assert.match(subscriptionFlow, /INSERT INTO newsletter_confirmation_requests/);
  assert.match(subscriptionFlow, /sha256Hex\(token\)/);
  const subscribeOnly = subscriptionFlow.slice(
    subscriptionFlow.indexOf("export async function subscribe"),
    subscriptionFlow.indexOf("function confirmationRetryDelaySeconds"),
  );
  assert.doesNotMatch(subscribeOnly, /INSERT INTO subscribers/);
  assert.match(subscriptionFlow, /export async function confirmNewsletterSubscription/);
  assert.match(subscriptionFlow, /INSERT INTO subscribers/);
  assert.match(confirmationClient, /window\.location\.hash\.slice\(1\)/);
  assert.match(confirmationClient, /window\.history\.replaceState/);
  assert.match(confirmationClient, /data-newsletter-confirm-continue/);

  const webhook = newsletter.slice(
    newsletter.indexOf("export async function ingestForwardEmailEvent"),
    newsletter.indexOf("async function markUnsubscribed"),
  );
  assert.match(webhook, /X-Webhook-Signature/);
  assert.ok(webhook.indexOf("readBoundedBody") < webhook.indexOf("JSON.parse"));
  assert.ok(webhook.indexOf("hmacSha256Hex") < webhook.indexOf("JSON.parse"));
  assert.match(webhook, /constantTimeEqual/);
  assert.match(webhook, /INSERT OR IGNORE INTO newsletter_provider_events/);
  assert.match(webhook, /newsletter_suppressions/);
  assert.match(newsletter, /reconciliation_status = 'pending'/);
  assert.match(newsletter, /reconciliation_status = 'none'/);
  assert.match(newsletter, /manual_review/);
  assert.match(worker, /\/api\/email\/forward-email\/events/);
});

test("R2 buckets have no direct public-domain configuration", () => {
  const content = [
    readFileSync(path.join(root, "wrangler.jsonc"), "utf8"),
    ...files(path.join(root, "src")).map((file) => readFileSync(file, "utf8")),
  ].join("\n");
  assert.doesNotMatch(content, /r2\.dev|public_bucket|custom_domain.*R2/i);
  assert.match(content, /PRIVATE_UPLOADS/);
  assert.match(content, /PUBLISHED_MEDIA/);
});

test("public and private contacts remain distinct in schema and publication", () => {
  const migration = readFileSync(path.join(root, "migrations", "0001_initial.sql"), "utf8");
  const admin = readFileSync(path.join(root, "src", "admin.ts"), "utf8");
  assert.match(migration, /submitter_email/);
  assert.match(migration, /public_email/);
  assert.match(admin, /row\.public_email/);
  assert.doesNotMatch(admin, /row\.submitter_email, row\.submitter_phone, row\.image_asset_id/);
});

test("the organization profile upgrade backfills only explicitly public contacts", () => {
  const database = new DatabaseSync(":memory:");
  try {
    for (const migration of [
      "0001_initial.sql",
      "0002_moderation_state_guards.sql",
      "0003_member_application.sql",
      "0004_email_provider_split.sql",
    ]) {
      database.exec(readFileSync(path.join(root, "migrations", migration), "utf8"));
    }
    database.exec(`
      INSERT INTO organization_submissions (
        id, name, description, submitter_email, public_email, public_phone,
        created_at, updated_at
      ) VALUES (
        'upgrade_submission', 'Upgrade Test Organization',
        'A sufficiently detailed organization used to test the profile upgrade.',
        'private-canary@example.org', 'public-canary@example.org',
        '+1 242 555 0101', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
      );
      INSERT INTO organizations (
        id, slug, name, description, public_email, public_phone,
        published_at, updated_at
      ) VALUES (
        'upgrade_organization', 'upgrade-test-organization',
        'Upgrade Test Organization',
        'A sufficiently detailed published organization used to test the profile upgrade.',
        'listed-canary@example.org', '+1 242 555 0102',
        '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
      );
    `);
    database.exec(readFileSync(path.join(root, "migrations", "0005_organization_profiles.sql"), "utf8"));

    const staged = database.prepare(
      "SELECT contact_type, value FROM organization_submission_public_contacts ORDER BY sort_order",
    ).all().map((row) => ({ ...row }));
    const published = database.prepare(
      "SELECT contact_type, value FROM organization_public_contacts ORDER BY sort_order",
    ).all().map((row) => ({ ...row }));
    assert.deepEqual(staged, [
      { contact_type: "email", value: "public-canary@example.org" },
      { contact_type: "phone", value: "+1 242 555 0101" },
    ]);
    assert.deepEqual(published, [
      { contact_type: "email", value: "listed-canary@example.org" },
      { contact_type: "phone", value: "+1 242 555 0102" },
    ]);
    assert.doesNotMatch(JSON.stringify({ staged, published }), /private-canary/);
  } finally {
    database.close();
  }
});

test("the browser dashboard treats visitor content as text", () => {
  const dashboard = readFileSync(path.join(root, "public", "assets", "admin.js"), "utf8");
  assert.match(dashboard, /textContent/);
  assert.doesNotMatch(dashboard, /innerHTML\s*=/);
  assert.match(dashboard, /Visitor content is untrusted/);
});

test("the local email preview permits branded images without enabling scripts", () => {
  const member = readFileSync(path.join(root, "public", "assets", "app.js"), "utf8");
  assert.match(member, /frame\.setAttribute\("sandbox", "allow-same-origin"\)/);
  assert.doesNotMatch(member, /frame\.setAttribute\("sandbox", "[^"]*allow-scripts/);
});

test("the member client keeps private state in no-store APIs and treats it as text", () => {
  const member = readFileSync(path.join(root, "public", "assets", "app.js"), "utf8");
  assert.match(member, /cache:\s*"no-store"/);
  assert.match(member, /credentials:\s*"same-origin"/);
  assert.match(member, /textContent/);
  assert.doesNotMatch(member, /innerHTML\s*=/);
  assert.match(member, /history\.replaceState\(null, "", `\$\{window\.location\.pathname\}/);
  assert.match(member, /data-member-verify-continue/);
  assert.match(member, /X-CSRF-Token/);
  assert.match(member, /localStorage\.getItem\("stc_favorites"\)/);
  assert.match(member, /localStorage\.removeItem\("stc_favorites"\)/);
});

test("favorite controls use an accessible animated pixel heart", () => {
  const pages = readFileSync(path.join(root, "src", "pages.ts"), "utf8");
  const member = readFileSync(path.join(root, "public", "assets", "app.js"), "utf8");
  const styles = readFileSync(path.join(root, "public", "assets", "legacy-cloudflare.css"), "utf8");
  const favoriteHelper = pages.slice(
    pages.indexOf("function pixelHeartMarkup"),
    pages.indexOf("function safeReturnPath"),
  );

  assert.match(favoriteHelper, /member-pixel-heart-svg/);
  assert.match(favoriteHelper, /shape-rendering="crispEdges"/);
  assert.match(favoriteHelper, /aria-pressed="false"/);
  assert.doesNotMatch(favoriteHelper, /fa-heart/);
  assert.match(member, /function animateFavoriteButton/);
  assert.match(member, /is-heart-beating/);
  assert.match(member, /is-heart-breaking/);
  assert.match(member, /Remove this \$\{noun\} from My STC/);
  assert.match(member, /wasSaved \? 3000 : 0/);
  assert.match(member, /status\.classList\.add\("is-dismissing"\)/);
  assert.match(member, /status\.hidden = true/);
  assert.match(styles, /@keyframes member-pixel-heart-beat/);
  assert.match(styles, /@keyframes member-pixel-heart-break/);
  assert.match(styles, /\.member-global-status\.is-dismissing/);
  assert.match(styles, /min-height:\s*44px/);
  assert.match(styles, /width:\s*44px/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});

test("organization and event suggestions require member state while event discovery stays public", () => {
  const pages = readFileSync(path.join(root, "src", "pages.ts"), "utf8");
  const submissions = readFileSync(path.join(root, "src", "submissions.ts"), "utf8");
  const client = readFileSync(path.join(root, "public", "assets", "app.js"), "utf8");
  const worker = readFileSync(path.join(root, "src", "index.ts"), "utf8");
  const organizationPage = pages.slice(
    pages.indexOf("export async function suggestOrganizationPage"),
    pages.indexOf("export async function suggestEventPage"),
  );
  const eventPage = pages.slice(
    pages.indexOf("export async function suggestEventPage"),
    pages.indexOf("export function signInPage"),
  );
  const directoryPage = pages.slice(
    pages.indexOf("export async function organizationsPage"),
    pages.indexOf("export async function organizationPage"),
  );
  const organizationSubmission = submissions.slice(
    submissions.indexOf("export async function submitOrganization"),
    submissions.indexOf("export async function submitEvent"),
  );
  const eventSubmission = submissions.slice(
    submissions.indexOf("export async function submitEvent"),
    submissions.indexOf("export async function taxonomy"),
  );
  const memberPaths = worker.slice(
    worker.indexOf("function memberApplicationPath"),
    worker.indexOf("async function scheduledTask"),
  );
  const protectedReturnPath = client.slice(
    client.indexOf("function protectedSubmissionSignInUrl"),
    client.indexOf("function protectedSubmissionForms"),
  );

  for (const [kind, submission] of [
    ["organization", organizationSubmission],
    ["event", eventSubmission],
  ]) {
    const sameOrigin = submission.indexOf("requireSameOrigin(request, env)");
    const memberSession = submission.indexOf("requireMemberSession(request, env)");
    const memberCsrf = submission.indexOf("requireMemberCsrf(request, env, member)");
    const memberLimit = submission.indexOf(`\"${kind}-submission-member\"`);
    const ipLimit = submission.indexOf(`\"${kind}-submission-ip\"`);
    const multipart = submission.indexOf("readMultipart(request)");
    assert.ok(
      sameOrigin >= 0
        && sameOrigin < memberSession
        && memberSession < memberCsrf
        && memberCsrf < memberLimit
        && memberLimit < ipLimit
        && ipLimit < multipart,
      `${kind} submission admission checks must precede multipart parsing`,
    );
    assert.match(submission, new RegExp(`${kind}-member-\\$\\{member\\.memberId\\}`));
    assert.match(submission, /SUBMISSION_MEMBER_LIMIT/);
    assert.match(submission, /submissionId, member\.memberId/);
  }

  assert.match(organizationPage, /optionalMemberSession\(request, env\)/);
  assert.match(organizationPage, /redirect\("\/signin\?return=%2Fsuggest%2Forganization", 303\)/);
  assert.match(organizationPage, /data-member-required/);
  assert.match(pages, /function wizardReview[\s\S]*data-submission-success-link hidden/);
  assert.match(organizationPage, /wizardReview\("Send organization for review"/);
  assert.match(organizationPage, /multiChoiceGroup\("Locations", "location_ids"/);
  assert.match(organizationPage, /multiChoiceGroup\("Categories", "category_ids"/);
  assert.doesNotMatch(organizationPage, /name="(?:location_ids|category_ids)" multiple/);
  assert.match(pages, /class="member-multi-choice-option"/);
  assert.match(pages, /name="\$\{escapeHtml\(name\)\}" type="checkbox"/);
  assert.match(pages, /member-secondary-button organization-contact-add/);
  assert.doesNotMatch(organizationPage, /name="submitter_email"/);
  assert.match(organizationPage, /noindex:\s*true/);
  assert.match(eventPage, /optionalMemberSession\(request, env\)/);
  assert.match(eventPage, /redirect\("\/signin\?return=%2Fsuggest%2Fevent", 303\)/);
  assert.match(eventPage, /data-member-required/);
  assert.match(eventPage, /wizardReview\("Send event for review"/);
  assert.doesNotMatch(eventPage, /name="submitter_email"/);
  assert.match(eventPage, /noindex:\s*true/);
  assert.doesNotMatch(directoryPage, /href="\/suggest\/organization"/);
  assert.match(eventSubmission, /eventInput\(input, member\.email\)/);
  assert.match(eventSubmission, /recipientEmail:\s*member\.email/);
  assert.match(memberPaths, /path === "\/api\/submissions\/events"/);
  assert.match(memberPaths, /path === "\/suggest\/event"/);
  assert.doesNotMatch(memberPaths, /path === "\/events"/);
  assert.doesNotMatch(memberPaths, /path === "\/api\/events"/);
  assert.match(worker, /if \(path === "\/events"\) return eventsPage\(request, env\)/);
  assert.match(worker, /if \(path === "\/api\/events"\) return method === "GET" \? eventsApi\(request, env\)/);
  assert.match(worker, /const eventApiMatch = path\.match\(\/\^\\\/api\\\/events\\\/\(\\d\+\)\$\//);
  assert.match(client, /protectedSubmissionForms/);
  assert.match(client, /BroadcastChannel\("serve-the-cays-member-auth"\)/);
  assert.match(client, /function revalidateMemberSessionForCurrentView\(\)[\s\S]*?revalidateProtectedSubmissionForms\(\)/);
  assert.match(client, /pageshow[\s\S]*?revalidateMemberSessionForCurrentView\(\)/);
  assert.match(protectedReturnPath, /window\.location\.pathname === "\/suggest\/event"/);
  assert.match(protectedReturnPath, /\? "\/suggest\/event"/);
  assert.match(protectedReturnPath, /: "\/suggest\/organization"/);
  assert.match(protectedReturnPath, /new URLSearchParams\(\{ return: returnPath \}\)/);
  assert.doesNotMatch(client, /MEMBER_SUGGESTION_SIGNIN/);
});

test("public member markup is cache-safe and never embeds account state", () => {
  const pages = readFileSync(path.join(root, "src", "pages.ts"), "utf8");
  const client = readFileSync(path.join(root, "public", "assets", "app.js"), "utf8");
  const styles = readFileSync(path.join(root, "styles", "tailwind.css"), "utf8");
  const entityStyles = readFileSync(path.join(root, "public", "static", "css", "entity.css"), "utf8");
  assert.match(pages, /data-member-nav data-member-context="\$\{activeSection === "member" \? "member" : "public"\}" data-member-state="checking" aria-busy="true" aria-label="Checking sign-in status" hidden/);
  assert.match(pages, /<span data-member-nav-label><\/span><span class="sr-only" data-member-nav-status>Checking sign-in status<\/span>/);
  assert.match(client, /status\.textContent = resolved \? "" : loadingText/);
  assert.doesNotMatch(pages, />Account<|data-member-nav[^>]*>Account/);
  assert.match(pages, /data-member-session-loading role="status" aria-live="polite"/);
  assert.match(pages, /data-member-session-spinner/);
  assert.match(pages, /data-member-protected hidden inert/);
  assert.doesNotMatch(pages, /member_email|attendee_email|attendee_name/);
  assert.match(pages, /data-member-verify-continue disabled/);
  assert.match(pages, /opening this page does not use the link/i);
  assert.doesNotMatch(pages, /member-workspace-sidebar|member-sidebar-nav/);
  assert.doesNotMatch(pages, />Member access</);
  assert.equal((pages.match(/data-member-logout(?=[\s>])/g) ?? []).length, 1);
  assert.match(pages, /data-member-logout-dialog aria-labelledby="member-logout-title" aria-describedby="member-logout-description"/);
  assert.match(pages, /data-member-logout-cancel>Cancel<\/button>/);
  assert.match(pages, /data-member-logout-confirm>Sign out<\/button>/);
  assert.match(pages, /data-size="flexible"/);
  assert.doesNotMatch(pages, /data-member-admin-link|href="\/admin"[^>]*>[^<]*Admin panel/i);
  assert.doesNotMatch(client, /data-member-admin-link/);
  assert.match(client, /function setButtonBusy\(button, busy\)/);
  assert.match(client, /logoutDialog\.showModal\(\)/);
  assert.match(client, /logoutCancel\.focus\(\)/);
  assert.match(client, /logoutDialog\?\.addEventListener\("cancel", \(event\) => \{[\s\S]*?event\.preventDefault\(\)[\s\S]*?logoutDialog\.close\("cancel"\)/);
  assert.match(client, /logoutDialog\?\.addEventListener\("keydown", \(event\) => \{[\s\S]*?event\.key !== "Escape"[\s\S]*?logoutDialog\.close\("cancel"\)/);
  assert.match(client, /await apiRequest\("\/api\/session\/logout", \{ method: "POST" \}\)/);
  assert.match(client, /const MEMBER_SESSION_STATUS = Object\.freeze\(\{[\s\S]*?checking: "checking"[\s\S]*?authenticated: "authenticated"[\s\S]*?anonymous: "anonymous"[\s\S]*?recoverableFailure: "recoverable-failure"[\s\S]*?terminalFailure: "terminal-failure"/);
  assert.match(client, /function setMemberSessionStatus\(status, message = ""\)[\s\S]*?protectedContent\.hidden = !authenticated[\s\S]*?loading\.hidden = authenticated \|\| anonymous[\s\S]*?spinner\.hidden = !checking[\s\S]*?retry\.hidden = !recoverableFailure/);
  assert.match(client, /function renderMemberDashboard\(dashboard, generation = memberViewGeneration\)[\s\S]*?setMemberSessionStatus\(MEMBER_SESSION_STATUS\.authenticated\)/);
  assert.match(client, /function renderMemberDashboard[\s\S]*?generation !== memberViewGeneration \|\| !memberState\.authenticated \|\| memberSessionFailed\(\)/);
  assert.match(client, /memberSessionGeneration/);
  assert.match(client, /dashboardRequestGeneration/);
  assert.match(client, /memberViewGeneration/);
  assert.match(client, /function resolveMemberDashboard[\s\S]*?generation !== memberViewGeneration[\s\S]*?renderMemberDashboard\(dashboard, generation\)/);
  assert.match(client, /if \(error && error\.status === 401\)[\s\S]*?setMemberSessionStatus\(MEMBER_SESSION_STATUS\.anonymous\)/);
  assert.match(styles, /\.member-session-loading\[hidden\],[\s\S]*?\[data-member-protected\]\[hidden\][\s\S]*?display: none !important/);
  assert.match(styles, /\[data-member-nav\]\[hidden\][\s\S]*?display: none !important/);
  assert.match(entityStyles, /\.contact-list li > a \{[\s\S]*?overflow-wrap: anywhere/);
  assert.match(client, /link\.hidden = !resolved/);
  assert.match(client, /visibilitychange/);
  assert.match(client, /revalidateMemberSessionForCurrentView/);
  assert.doesNotMatch(client, /pageshow[\s\S]{0,500}window\.location\.reload\(\)/);
  assert.match(pages, /noindex: ended/);
});

test("admin moderation actions require an explicit confirmation before mutation", () => {
  const admin = readFileSync(path.join(root, "public", "assets", "admin.js"), "utf8");
  assert.match(admin, /action === "approve"[\s\S]*?Approve and publish/);
  assert.match(admin, /action === "deny"[\s\S]*?The submitter will be notified/);
  assert.match(admin, /Restore[^\n]*pending review queue/);
  assert.match(admin, /if \(!window\.confirm\(confirmation\)\) return;[\s\S]*?const buttons = container\.querySelectorAll\("button"\)/);
});

test("primary navigation exposes and synchronizes an accessible current-page indicator", () => {
  const pages = readFileSync(path.join(root, "src", "pages.ts"), "utf8");
  const client = readFileSync(path.join(root, "public", "assets", "app.js"), "utf8");
  const styles = readFileSync(path.join(root, "styles", "tailwind.css"), "utf8");
  assert.match(pages, /data-nav-section="\$\{section\}"\$\{activeSection === section \? ' aria-current="page"'/);
  assert.match(client, /function syncCurrentNavigation\(\)/);
  assert.match(client, /link\.setAttribute\("aria-current", "page"\)/);
  assert.match(client, /addEventListener\?\.\("popstate", syncCurrentNavigation\)/);
  assert.match(client, /pageshow[\s\S]*?syncCurrentNavigation\(\)/);
  assert.match(styles, /\[data-nav-section\]\[aria-current="page"\]::after/);
  assert.match(styles, /\[data-nav-section\]::after[\s\S]*?background: #FF66A1/);
  assert.doesNotMatch(styles.match(/\.stc-simple-header \[data-nav-section\]::after \{[\s\S]*?\n  \}/)?.[0] ?? "", /#00b8a9/i);
  assert.doesNotMatch(styles, /\[data-member-nav\]\[aria-busy="true"\][\s\S]*?min-inline-size/);
  assert.doesNotMatch(styles, /data-member-context="public"\]\[aria-busy="true"\][\s\S]*?background:/);
  assert.match(client, /label\.textContent = authenticated \? "My STC" : anonymous \? "Sign in" : ""/);
  assert.match(client, /link\.hidden = !resolved/);
  assert.doesNotMatch(client, /link\.textContent = [^;]*"Account"/);
  assert.match(styles, /prefers-reduced-motion:\s*reduce/);
});

test("public STC sign-out clears member and admin cookies without using an Access-protected API", () => {
  const worker = readFileSync(path.join(root, "src", "index.ts"), "utf8");
  const memberAuth = readFileSync(path.join(root, "src", "member-auth.ts"), "utf8");
  const admin = readFileSync(path.join(root, "public", "assets", "admin.js"), "utf8");
  const pages = readFileSync(path.join(root, "src", "pages.ts"), "utf8");
  assert.match(worker, /path === "\/api\/session\/logout"/);
  assert.match(worker, /path === "\/signout"/);
  const memberGate = worker.slice(worker.indexOf("function memberApplicationPath"), worker.indexOf("async function scheduledTask"));
  assert.doesNotMatch(memberGate, /\/api\/session\/logout|\/signout/);
  assert.match(memberAuth, /export async function logoutStcSessions/);
  assert.match(memberAuth, /revokeAdminSessionBestEffort/);
  assert.match(admin, /fetch\("\/api\/session\/logout"/);
  assert.doesNotMatch(admin, /fetch\("\/api\/admin\/logout"/);
  assert.match(pages, /data-stc-signout-confirm>Sign out<\/button>/);
});

test("the admin dashboard has no password surface and remains hideable on session loss", () => {
  const dashboard = readFileSync(path.join(root, "public", "assets", "admin.js"), "utf8");
  const pages = readFileSync(path.join(root, "src", "pages.ts"), "utf8");
  const worker = readFileSync(path.join(root, "src", "index.ts"), "utf8");
  const styles = readFileSync(path.join(root, "public", "assets", "styles.css"), "utf8");
  assert.match(dashboard, /appPanel\.hidden\s*=\s*false/);
  assert.doesNotMatch(dashboard, /api\/admin\/login|data-login-form|loginPanel/);
  assert.doesNotMatch(pages, /data-admin-login|type="password"|admin_login/);
  assert.match(worker, /path === "\/api\/admin\/login"\) throw new ApiError\(404/);
  assert.match(worker, /path === "\/admin"[\s\S]*?optionalAdminSession\(request, env\)[\s\S]*?notFoundPage\(env\)/);
  assert.match(
    styles,
    /\.admin-login\[hidden\],\s*\.admin-app\[hidden\]\s*\{[^}]*display:\s*none\s*!important;/s,
  );
});

test("the admin client clears private data and rejects stale session responses", () => {
  const dashboard = readFileSync(path.join(root, "public", "assets", "admin.js"), "utf8");
  assert.match(dashboard, /let sessionGeneration = 0;/);
  assert.match(
    dashboard,
    /function clearPrivateState\(\)\s*\{[\s\S]*?identity\.textContent = "";[\s\S]*?summaryRoot\.replaceChildren\(\);[\s\S]*?listRoot\.replaceChildren\(\);[\s\S]*?detailRoot\.replaceChildren\(emptyDetail\(\)\);[\s\S]*?\}/,
  );
  assert.match(
    dashboard,
    /function leaveAdmin\([^)]*\)\s*\{[\s\S]*?sessionGeneration \+= 1;[\s\S]*?authenticated = false;[\s\S]*?clearPrivateState\(\);[\s\S]*?window\.location\.replace\("\/admin"\);/,
  );
  assert.match(
    dashboard,
    /async function authenticatedPayload\([^)]*\)\s*\{[\s\S]*?const generation = sessionGeneration;[\s\S]*?isCurrentSession\(generation\)[\s\S]*?await fetch\(input, init\)[\s\S]*?isCurrentSession\(generation\)/,
  );
  assert.match(
    dashboard,
    /async function restoreSession\([^)]*\)\s*\{[\s\S]*?const generation = sessionGeneration;[\s\S]*?if \(generation !== sessionGeneration\) return;[\s\S]*?showApp\(session\);/,
  );
  assert.doesNotMatch(
    dashboard,
    /fetch\((?:"|'|`)\/api\/admin\/(?:summary|submissions)/,
  );
  assert.match(
    dashboard,
    /logoutButton\?\.addEventListener\("click", async \(\) => \{[\s\S]*?fetch\("\/api\/session\/logout"/,
  );
  assert.match(dashboard, /new globalThis\.BroadcastChannel\("serve-the-cays-admin-auth"\)/);
  assert.match(
    dashboard,
    /if \(notifyPeers && wasAuthenticated\) broadcastAuthenticationLoss\(\);/,
  );
  assert.match(
    dashboard,
    /authChannel\?\.addEventListener\("message", \(event\) => \{[\s\S]*?authentication-lost[\s\S]*?leaveAdmin\(false\);/,
  );
  assert.match(
    dashboard,
    /addEventListener\?\.\("pageshow", \(event\) => \{[\s\S]*?if \(!event\.persisted\) return;[\s\S]*?clearPrivateState\(\);[\s\S]*?restoreSession\(notifyPeersOnFailure\);/,
  );
  assert.match(
    dashboard,
    /if \(notifyPeersOnFailure && error\.status === 401\) broadcastAuthenticationLoss\(\);/,
  );
});

test("public forms disclose private review and constrained image rules", () => {
  const pages = readFileSync(path.join(root, "src", "pages.ts"), "utf8");
  assert.match(pages, /stays private until the complete listing is approved/);
  assert.match(pages, /JPEG, PNG, or WebP/);
  assert.match(pages, /up to 5 MiB/);
  assert.match(pages, /Public contact information/);
});

test("public attribution identifies Caynetic Ltd. and uses its current website", () => {
  const pages = readFileSync(path.join(root, "src", "pages.ts"), "utf8");
  assert.match(pages, /href="https:\/\/caynetic\.ltd"/);
  assert.match(pages, /Caynetic Ltd\./);
  assert.doesNotMatch(pages, /https:\/\/caynetic\.com|canyetic\.com/i);
  assert.match(pages, /Serve the Cays is an initiative of/);
  assert.match(pages, /Caynetic Ltd\. is the data controller responsible for the personal information described in this policy/);
});

test("organization pages describe listed organizations without implying affiliation", () => {
  const pages = readFileSync(path.join(root, "src", "pages.ts"), "utf8");
  assert.match(pages, /<h2>About \$\{escapeHtml\(name\)\}<\/h2>/);
  assert.match(pages, /Confirm current opportunities and participation requirements directly with the organization/);
  assert.match(pages, /href="#contact" class="btn organization-contact-action">Contact organization/);
  assert.match(pages, /<section id="contact" class="organization-sidebar-panel organization-contact-panel">/);
  assert.doesNotMatch(pages, /class="btn organization-secondary-action">Call<\/a>/);
  assert.match(pages, /organization-meta-label">Focus/);
  assert.match(pages, /organization-meta-label">Location/);
  assert.doesNotMatch(pages, /<h2>Focus areas<\/h2>/);
  assert.doesNotMatch(pages, /<h2>Areas served<\/h2>/);
  assert.doesNotMatch(pages, /websiteContactMarkup/);
  assert.doesNotMatch(pages, /<h2>About Us<\/h2>/);
  assert.doesNotMatch(pages, /We welcome volunteers of all backgrounds and skill levels/);
});

test("directory cards pin every Learn More link to the bottom", () => {
  const pages = readFileSync(path.join(root, "src", "pages.ts"), "utf8");
  const compatibility = readFileSync(
    path.join(root, "public", "assets", "legacy-cloudflare.css"),
    "utf8",
  );
  assert.equal((pages.match(/class="card-cta"/g) ?? []).length, 2);
  assert.match(
    compatibility,
    /\.org-card,\s*\.event-card\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s,
  );
  assert.match(
    compatibility,
    /\.org-card > \.card-cta,\s*\.event-card > \.card-cta\s*\{[^}]*margin-top:\s*auto;/s,
  );
});

test("event icons use the organization logo entrance animation", () => {
  const compatibility = readFileSync(
    path.join(root, "public", "assets", "legacy-cloudflare.css"),
    "utf8",
  );
  const directory = readFileSync(
    path.join(root, "public", "static", "css", "list.css"),
    "utf8",
  );
  assert.match(
    compatibility,
    /\.event-icon-container\s*\{[^}]*animation:\s*logoFadeIn 1\.2s ease-out forwards;/s,
  );
  assert.match(
    directory,
    /\.org-logo-container,\s*\.event-logo-container\s*\{[^}]*animation:\s*logoFadeIn 1\.2s ease-out forwards;/s,
  );
});

test("the Worker public presentation includes its owned design assets", () => {
  const cloudflareStatic = path.join(root, "public", "static");
  const exactFiles = [
    "css/style.css",
    "css/list.css",
    "css/entity.css",
    "css/flash.css",
    "images/logo.svg",
    "images/logo.png",
    "images/email-logo.5a81761f5371.png",
    "images/favicon.ico",
    "images/favicon-16x16.png",
    "images/favicon-32x32.png",
    "images/apple-touch-icon.png",
    "images/android-chrome-192x192.png",
    "images/android-chrome-512x512.png",
    "images/site.webmanifest",
    "robots.txt",
  ];
  for (const relative of exactFiles) {
    assert.ok(readFileSync(path.join(cloudflareStatic, relative)).length > 0, `${relative} is empty`);
  }
  const emailLogo = readFileSync(path.join(cloudflareStatic, "images", "email-logo.5a81761f5371.png"));
  assert.equal(emailLogo.readUInt32BE(16), 96, "email logo width must remain 96 pixels");
  assert.equal(emailLogo.readUInt32BE(20), 96, "email logo height must remain 96 pixels");
  assert.ok(emailLogo.length <= 10_000, "email logo must remain at or below 10 KB");
  assert.deepEqual(
    readFileSync(path.join(root, "public", "assets", "logo.svg")),
    readFileSync(path.join(cloudflareStatic, "images", "logo.svg")),
  );
  const pages = readFileSync(path.join(root, "src", "pages.ts"), "utf8");
  assert.match(pages, /Welcome to Serve the Cays/);
  assert.match(pages, /class=\"nav-links\"/);
  assert.match(pages, /\/static\/css\/style\.css/);
  assert.match(pages, /\/static\/images\/logo\.svg/);
});

test("the home hero uses an animated logo with a static reduced-motion fallback", () => {
  const pages = readFileSync(path.join(root, "src", "pages.ts"), "utf8");
  const compatibility = readFileSync(
    path.join(root, "public", "assets", "legacy-cloudflare.css"),
    "utf8",
  );
  const animatedLogo = readFileSync(
    path.join(root, "public", "assets", "logo-animated-v1.svg"),
    "utf8",
  );

  assert.match(pages, /<picture class="home-logo">/);
  assert.match(pages, /media="\(prefers-reduced-motion: no-preference\)"/);
  assert.match(pages, /srcset="\/assets\/logo-animated-v1\.svg"/);
  assert.match(pages, /<img src="\/static\/images\/logo\.svg"[^>]*width="200" height="200">/);
  assert.match(animatedLogo, /@keyframes heart-beat/);
  assert.match(animatedLogo, /id="water-only-mask"/);
  assert.match(animatedLogo, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(compatibility, /\.home-logo \.logo\s*\{[\s\S]*?height:\s*auto;/);
  assert.match(
    compatibility,
    /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.stc-simple-hero \.logo\s*\{[\s\S]*?animation:\s*none;/,
  );
});

test("the home How We Help section presents four service cards", () => {
  const pages = readFileSync(path.join(root, "src", "pages.ts"), "utf8");

  assert.equal((pages.match(/class="feature-card"/g) ?? []).length, 4);
  assert.match(pages, /<h3>Engage<\/h3><p>Save organizations, RSVP to events, and stay connected with the causes you care about\.<\/p>/);
});

test("the About and Privacy pages explain public source and external services", () => {
  const pages = readFileSync(path.join(root, "src", "pages.ts"), "utf8");

  assert.match(pages, /Serve the Cays is an initiative of <a href="https:\/\/caynetic\.ltd"/);
  assert.match(pages, /source code and self-hosting documentation on GitHub/);
  assert.match(pages, /Live member, submission, outreach, email, and operational records remain outside the public repository/);
  assert.match(pages, /Administrator identities are not shown with public news articles/);
  assert.match(pages, /Turnstile evaluates browser and request signals, normally runs in the background/);
  assert.match(pages, /href="https:\/\/buymeacoffee\.com\/privacy-policy"/);
  assert.match(pages, /Serve the Cays does not collect full payment-card or bank-account details/);
  assert.match(pages, /Live account, submission, newsletter, outreach, email, audit, and security records are not included in the public repository/);
});

test("Tailwind is compiled locally without resetting the site presentation", () => {
  const pages = readFileSync(path.join(root, "src", "pages.ts"), "utf8");
  const source = readFileSync(path.join(root, "styles", "tailwind.css"), "utf8");
  const compiled = readFileSync(path.join(root, "public", "assets", "tailwind.css"), "utf8");
  const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

  assert.match(pages, /href="\/assets\/tailwind\.css"/);
  assert.doesNotMatch(pages, /cdn\.tailwindcss\.com/);
  assert.match(source, /prefix\(tw\)/);
  assert.doesNotMatch(source, /preflight\.css/);
  assert.match(compiled, /\.stc-simple-header\{/);
  assert.match(compiled, /\.member-delete-dialog\{/);
  assert.match(source, /\.btn\[aria-busy="true"\]::before/);
  assert.match(source, /@keyframes stc-button-spin/);
  assert.match(source, /\.member-multi-choice-grid/);
  assert.match(source, /\.cf-turnstile/);
  assert.equal(packageJson.devDependencies.tailwindcss, "4.3.3");
  assert.equal(packageJson.devDependencies["@tailwindcss/cli"], "4.3.3");
});

test("the public footer credits Cloudflare accessibly", () => {
  const pages = readFileSync(path.join(root, "src", "pages.ts"), "utf8");
  const source = readFileSync(path.join(root, "styles", "tailwind.css"), "utf8");
  const legacySource = readFileSync(path.join(root, "public", "static", "css", "style.css"), "utf8");
  const http = readFileSync(path.join(root, "src", "http.ts"), "utf8");
  const funding = readFileSync(path.join(repositoryRoot, ".github", "FUNDING.yml"), "utf8");

  assert.doesNotMatch(pages, /<img[^>]*class="footer-logo"/);
  assert.match(pages, /<div class="footer-section">\s*<h3>Serve the Cays<\/h3>/);
  assert.match(
    pages,
    /<p>Operated by <a href="https:\/\/caynetic\.ltd"[^>]*>Caynetic Ltd\.<\/a><\/p>/,
  );
  assert.match(
    pages,
    /<p class="footer-cloudflare-credit"><span>Powered by<\/span><a href="https:\/\/www\.cloudflare\.com\/"[^>]*><i class="fab fa-cloudflare" aria-hidden="true"><\/i><span>Cloudflare<\/span><\/a><\/p>/,
  );
  assert.doesNotMatch(pages, /<a[^>]*><span>Powered by<\/span>/);
  assert.match(pages, /class="fab fa-cloudflare" aria-hidden="true"/);
  assert.match(pages, /href="https:\/\/www\.cloudflare\.com\/"/);
  assert.equal(
    (pages.match(/<a class="footer-source-link" href="https:\/\/github\.com\/caynetic\/stc" target="_blank" rel="noopener noreferrer"><svg class="footer-github-icon"[^>]*aria-hidden="true" focusable="false">[\s\S]*?<\/svg><span>Source code<\/span><\/a>/g) ?? []).length,
    2,
  );
  assert.match(legacySource, /\.footer-section ul li a\.footer-source-link\s*\{/);
  assert.match(legacySource, /\.footer-github-icon\s*\{[\s\S]*?fill:\s*currentColor;/);
  assert.equal(
    (pages.match(/<a class="footer-sponsor-button" href="https:\/\/www\.buymeacoffee\.com\/caynetic" target="_blank" rel="noopener noreferrer" aria-label="Buy Serve the Cays a Kalik through Buy Me a Coffee \(opens in a new tab\)"><img src="https:\/\/img\.buymeacoffee\.com\/button-api\/\?text=Buy%20STC%20a%20kalik&amp;emoji=%F0%9F%8D%BA&amp;slug=caynetic&amp;button_colour=FFDD00&amp;font_colour=000000&amp;font_family=Lato&amp;outline_colour=000000&amp;coffee_colour=ffffff" width="235" height="50" alt="Buy STC a Kalik" loading="lazy" decoding="async" referrerpolicy="no-referrer"><\/a>/g) ?? []).length,
    2,
  );
  assert.match(legacySource, /\.footer-section a\.footer-sponsor-button img\s*\{[\s\S]*?width:\s*235px;[\s\S]*?max-width:\s*100%;[\s\S]*?height:\s*auto;/);
  assert.match(legacySource, /\.footer-section a\.footer-sponsor-button:focus-visible\s*\{[\s\S]*?outline:\s*3px solid #ff66a1;/);
  assert.match(http, /img-src 'self' data: https:\/\/img\.buymeacoffee\.com;/);
  assert.match(funding, /^buy_me_a_coffee:\s*caynetic$/m);
  assert.match(source, /\.footer-cloudflare-credit a\s*\{/);
  assert.match(source, /\.footer-cloudflare-credit \.fa-cloudflare/);
});
