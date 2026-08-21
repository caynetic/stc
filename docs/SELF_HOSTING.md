# Self-hosting Serve the Cays

Serve the Cays is a Cloudflare Worker application, not a static GitHub Pages
site. The Worker renders the public website and administration interface and
uses D1, R2, Images, Turnstile, Workers Static Assets, and email bindings.
GitHub can test and release the application, while Cloudflare remains the
runtime.

This guide starts locally and keeps every cloud release opt-in. Provider
accounts, billing terms, and product availability can change, so review them
before creating or enabling a resource.

## 1. Run everything locally first

Requirements:

- a current Node.js release supported by the pinned Wrangler version;
- npm;
- Git.

From the repository root:

```sh
cd cloudflare
npm ci
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run db:seed:local
npm run verify
npm run dev
```

Open `http://127.0.0.1:8787`. Local D1 and R2 state stays under the ignored
`.wrangler/` directory. Local email is captured by the development inbox and
does not contact Cloudflare Email Service or Forward Email. Image approval is
covered by the mocked Images binding in the automated tests; a real Images
transformation requires a preview environment.

Do not copy production credentials into `.dev.vars`. Use development-only
random values and keep the file ignored.

## 2. Understand the public configuration

[`cloudflare/wrangler.jsonc`](../cloudflare/wrangler.jsonc) documents the
binding structure but cannot release Serve the Cays as-is. Its D1 identifiers
and Turnstile site keys are placeholders, and every preview and production
feature gate is off.

Create an ignored deployment copy:

```sh
cd cloudflare
cp wrangler.jsonc wrangler.private.jsonc
```

In `wrangler.private.jsonc`, review each named environment and replace only the
values for resources you control:

- Worker name, `APP_ORIGIN`, and the production custom domain;
- D1 database names and identifiers;
- private-upload and published-media R2 bucket names;
- Turnstile site keys and exact allowed hostnames;
- transactional sender and Reply-To addresses;
- retention periods, schedules, and feature gates.

If you are adapting the project under another name or domain, also update the
application copy, verification scripts, tests, and email policy. Do not make a
configuration-only rename that leaves Serve the Cays security assumptions in
place.

## 3. Provision isolated preview resources

Authenticate Wrangler only when you are ready to create cloud resources. Use
unique names in place of these examples:

```sh
npx wrangler login
npx wrangler d1 create your-project-preview
npx wrangler r2 bucket create your-project-private-preview
npx wrangler r2 bucket create your-project-media-preview
```

Copy the returned D1 identifier into the preview environment of
`wrangler.private.jsonc`. Keep both R2 buckets private: do not enable an
`r2.dev` URL or R2 custom domain.

Then configure the remaining products in the Cloudflare dashboard and reflect
their bindings in the private configuration:

- an `IMAGES` binding for approved image re-encoding;
- an `EMAIL` binding restricted to the intended transactional senders;
- Turnstile widgets restricted to the exact preview and production hostnames;
- the `ASSETS` binding already described by the tracked template;
- separate production D1 and R2 resources when production is actually
  authorized.

The [deployment and recovery guide](../cloudflare/ops/production-runbook.md)
contains the complete binding, isolation, recovery, and release checks.

## 4. Add Worker secrets

The `secrets.required` lists in `wrangler.jsonc` are name-only checklists. Real
values must live in Cloudflare's secret store for the exact environment, never
in source control or a Wrangler configuration file.

Use the same pattern for each required secret:

```sh
npx wrangler secret put SESSION_SECRET --env preview --config wrangler.private.jsonc
```

Required names are:

- `SESSION_SECRET`
- `MEMBER_SESSION_SECRET`
- `IP_HASH_KEY`
- `RATE_LIMIT_HASH_KEY`
- `UNSUBSCRIBE_SECRET`
- `TURNSTILE_ORGANIZATION_SECRET`
- `TURNSTILE_EVENT_SECRET`
- `TURNSTILE_NEWSLETTER_SECRET`
- `TURNSTILE_MEMBER_SECRET`
- `FORWARD_EMAIL_NEWSLETTER_PASSWORD`
- `FORWARD_EMAIL_API_TOKEN`
- `FORWARD_EMAIL_WEBHOOK_SECRET`
- `NEWSLETTER_CONFIRMATION_SECRET`

Generate independent, high-entropy values for application secrets. Obtain
provider credentials only from the corresponding provider. Do not reuse values
between preview and production.

Leave transactional delivery, newsletter delivery, newsletter signup, and
their verification gates set to `false` until the matching provider flow has
been proven. Inbound aliases do not prove newsletter sending approval, and
provider acceptance does not prove inbox delivery.

## 5. Migrate and validate preview

Run the local suite again, verify the private release configuration, apply
migrations to preview, and perform a deployment dry run:

```sh
npm run verify
npm run config:verify -- --env preview
npx wrangler d1 migrations apply DB --remote --env preview --config wrangler.private.jsonc
npx wrangler deploy --dry-run --env preview --config wrangler.private.jsonc
```

The configuration verifier also expects an ignored private change record under
`ops/private/`. That record is where authorization, rollback information, and
provider evidence belong.

An authorized preview deployment uses:

```sh
npx wrangler deploy --env preview --config wrangler.private.jsonc
```

Complete the preview checks in the production runbook before preparing
production. Production uses separate resources and the same sequence with
`--env production`; it is not authorized merely because preview works.

## 6. Configure GitHub deployment

The tracked [deployment workflow](../.github/workflows/deploy.yml) is disabled
by default. A fork without repository variables or environment secrets can run
CI but cannot contact Cloudflare.

Create two GitHub deployment environments named `preview` and `production`.
For each environment, configure:

| Kind | Name | Purpose |
| --- | --- | --- |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account containing that environment |
| Variable | `DEPLOYMENT_URL` | URL used by the post-deployment smoke check |
| Secret | `CLOUDFLARE_API_TOKEN` | Least-privilege token allowed to deploy and migrate the required resources |
| Secret | `WRANGLER_CONFIG_JSONC` | Complete contents of the reviewed, ignored `wrangler.private.jsonc` |

Protect the `production` GitHub environment with a required reviewer. Keep
Cloudflare Worker secrets in Cloudflare; the workflow does not copy or replace
them.

Only after preview is provisioned and reviewed, add the repository-level
variable `CLOUDFLARE_DEPLOY_ENABLED=true`. With that explicit opt-in:

- a push to `main` that changes the Worker or deployment workflow verifies,
  migrates, and deploys preview;
- production runs only through a manual workflow dispatch;
- the production operator must confirm that the rollback Worker version and D1
  recovery bookmark were recorded;
- GitHub environment protection must pass before production secrets are
  available to the job.

Removing or changing `CLOUDFLARE_DEPLOY_ENABLED` immediately returns the
workflow to test-only behavior.

## 7. Keep the cost boundary explicit

- Prefer `npm run verify` and Wrangler `--dry-run` locally.
- Do not enable GitHub deployment until the provider account and billing state
  have been reviewed.
- Keep optional email and newsletter gates off until they are needed and
  approved.
- Review Images, R2, D1, Workers, Turnstile, email, domain, and GitHub usage in
  their provider dashboards before relying on any free allowance.
- Never treat a successful local test as proof of DNS, provider delivery,
  Cloudflare bindings, or production rollback.

No step in this guide authorizes spending or a production release.
