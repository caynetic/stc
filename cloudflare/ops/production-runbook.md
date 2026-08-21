# Deployment and recovery guide

This is the public, provider-neutral release guide for Serve the Cays. It shows
how the application is operated without publishing account identifiers,
credentials, database recovery points, message IDs, or release evidence.

This document is not an authorization record. Production remains unauthorized
by this public document. Every real release requires an explicitly approved
private change record with the exact target, rollback point, operator, and
verification evidence.

## Public and private files

The tracked `wrangler.jsonc` is a fail-closed architecture template. Its D1 IDs
and Turnstile keys are placeholders and every external-delivery release gate is
off. Copy it before adding live identifiers:

```sh
cp wrangler.jsonc wrangler.private.jsonc
mkdir -p ops/private
```

Keep these paths local; `.gitignore` already excludes them:

- `wrangler.private.jsonc` — provisioned D1 IDs, Turnstile site keys, and
  reviewed feature gates;
- `ops/private/` — approvals, Worker version IDs, D1 Time Travel bookmarks,
  provider readbacks, inventories, and production smoke-test evidence;
- `.dev.vars` — local-only development secrets;
- `.wrangler/` — local D1 and Wrangler state;
- generated imports, exports, logs, and screenshots that may contain private
  information.

Secret values do not belong in any Wrangler configuration file. Add them to
Cloudflare's secret store for the exact named environment. The
`secrets.required` arrays in the template are repository-owned checklist
metadata; they list names only.

## Infrastructure

Each non-local environment has the following bindings:

- `DB`: Cloudflare D1 for listings, members, moderation, outreach, news,
  newsletter state, email jobs, and audit evidence;
- `PRIVATE_UPLOADS`: private R2 quarantine for original uploads;
- `PUBLISHED_MEDIA`: separate R2 storage for sanitized public derivatives;
- `IMAGES`: Cloudflare Images binding used to decode and re-encode approved
  images;
- `ASSETS`: Workers Static Assets for CSS, JavaScript, fonts, and SVG files;
- `EMAIL`: Cloudflare Email Service restricted to reviewed transactional sender
  addresses: `signin@servethecays.com` and
  `notifications@servethecays.com`.

Turnstile protects public and member forms. Cloudflare Email Service sends
requested sign-in and account messages. Forward Email handles newsletter
delivery from `news@servethecays.com` and inbound human correspondence at
`hello@servethecays.com`; its API token is used only for delivery-status
readback, and its signed webhook drives bounce and complaint suppression.

The Worker also needs two schedules: a bounded email job every 15 minutes and a
separate daily maintenance job. The daily job handles retention, expired auth
records, media cleanup retries, and reminder scheduling.

## Provisioning checklist

Before a preview release:

1. Create separate preview D1 and R2 resources. Do not reuse production
   resources.
2. Disable every public URL for both R2 buckets.
3. Add the D1, R2, Images, Static Assets, and restricted Email Service bindings
   to `wrangler.private.jsonc`.
4. Create Turnstile widgets for the exact preview and production hostnames and
   add only their public site keys to the private config.
5. Add every named secret from the private config to the exact environment.
6. Protect `/admin` with external MFA or step-up authentication.
7. Verify SPF, DKIM, Return-Path, and DMARC for each enabled sender. Confirm
   Forward Email newsletter approval separately from inbound alias operation.
8. Confirm that newsletter double-opt-in, authenticated webhook ingestion,
   suppression handling, and ambiguous-delivery readback are complete before
   enabling newsletter signup or delivery.

Release flags stay `false` until their evidence exists in the private change
record. A provisioned binding is not proof that delivery, recovery, or access
controls work.

## Database migrations

Apply the migrations in order:

1. `0001_initial.sql`
2. `0002_moderation_state_guards.sql`
3. `0003_member_application.sql`
4. `0004_email_provider_split.sql`
5. `0005_organization_profiles.sql`
6. `0006_security_hardening.sql`
7. `0007_moderation_race_guards.sql`
8. `0008_member_notification_preferences.sql`
9. `0009_newsletter_delivery_integrity.sql`
10. `0010_passwordless_admin.sql`
11. `0011_outreach_and_news.sql`

Capture a D1 Time Travel bookmark before applying a migration and store the
bookmark outside Git. Rehearse the migration and rollback in preview first.
Owner allowlist records must be created through `ops/create-owner.mjs`; its
legacy verifier columns contain random unusable values, and administrator entry
still requires a single-use email link. Never put a real owner address in the
development seed.

## Verification gates

Run the full local suite:

```sh
npm ci
npm run verify
```

Then verify the private environment configuration:

```sh
npm run config:verify -- --env preview
npm run config:verify -- --env production
```

The verifier intentionally fails when private files are absent, identifiers
remain placeholders, a required secret name or binding is missing, a feature
gate lacks evidence, or the private change record does not contain the required
authorization.

Preview acceptance should cover:

- signed-out, member, editor, and owner access boundaries;
- Turnstile hostname and action checks;
- private upload quarantine, image re-encoding, published delivery, and source
  isolation;
- moderation race handling and audit evidence;
- magic-link consumption, session expiry, favorites, RSVPs, and submissions;
- Cloudflare Email Service provider acceptance and D1 reconciliation;
- Forward Email confirmation, status readback, webhook replay protection,
  suppression, and no-blind-retry behavior;
- outreach evidence requirements and draft/publish/unpublish news behavior;
- scheduled retention and failed-cleanup retry behavior.

Provider acceptance is not the same as inbox delivery. Record both separately
when inbox delivery matters to the release.

## Release sequence

After explicit authorization in the private change record:

1. Record the active Worker version, D1 Time Travel bookmark, D1 counts, and R2
   inventories.
2. Re-run `npm run verify` and the exact environment configuration gate.
3. Apply pending D1 migrations with the project-pinned Wrangler version and the
   private config.
4. Deploy the named environment with the same private config.
5. Confirm the new Worker version before changing any feature gate.
6. Run the approved public and authenticated smoke checks.
7. Reconcile queued email and provider results; do not resend an ambiguous
   delivery merely because the first request timed out.
8. Attach redacted results to the private change record.

`npm run deploy` remains disabled so that a generic package command cannot
publish the application accidentally.

## GitHub release workflow

The repository's `.github/workflows/deploy.yml` is an optional release runner,
not an authorization source. It remains inert unless the repository-level
`CLOUDFLARE_DEPLOY_ENABLED` variable is exactly `true` and the matching GitHub
environment contains its private configuration and least-privilege Cloudflare
credential.

An enabled push to `main` targets preview only. Production requires a manual
workflow dispatch, an explicit acknowledgement that the rollback Worker
version and D1 recovery bookmark were recorded, and any protection rules on the
GitHub `production` environment. The workflow reruns local verification,
materializes the private Wrangler configuration only for the job, performs a
dry run, applies ordered D1 migrations, deploys, smoke-tests the configured
URL, and removes the materialized file.

See the [self-hosting guide](../../docs/SELF_HOSTING.md) for the environment
variables and secrets. Keep Worker application secrets in Cloudflare; the
GitHub workflow does not replace them.

## Rollback

Rollback is a coordinated application-and-data decision:

1. Disable the affected feature gate if doing so is safe for the observed
   failure.
2. Roll the Worker back to the exact previously recorded version.
3. Restore D1 only when the approved recovery plan requires it; a Worker
   rollback alone does not reverse migrations or writes.
4. Reconcile R2 objects and D1 media state instead of deleting broad prefixes.
5. Hold uncertain email jobs for provider readback rather than blindly
   resending them.
6. Repeat the access, data, media, and email smoke checks and record the result
   privately.

Never publish secrets, raw provider payloads, personal submissions, subscriber
exports, exact recovery bookmarks, or credential-bearing commands in an issue,
pull request, CI log, or this repository.
