# Serve the Cays — Cloudflare application

This directory contains the full Serve the Cays application. The Worker serves
production at `servethecays.com`; releases and recovery use versioned Worker,
D1, and R2 procedures documented in the production runbook.

## Architecture

- One TypeScript Module Worker serves dynamic HTML, JSON APIs, and approved
  media while delegating CSS, JavaScript, and SVG files to Workers Static
  Assets.
- Public pages retain the established Serve the Cays HTML structure, logo,
  CSS and image assets, responsive menu, cards, forms, and lightbox behavior.
  Worker controls such as image
  uploads, Turnstile, private/public contact separation, and submission status
  messages use a small compatibility stylesheet layered after the site CSS.
- D1 stores public organizations and events separately from private
  submissions, submitter contact information, moderation history, owner/editor
  sessions, member sessions, favorites, RSVPs, queued transactional email,
  newsletter digest and delivery state, a private outreach ledger with
  append-only activity evidence, draft and published news posts, audit events,
  subscribers, taxonomies, rate limits, keyed-request fingerprints, and
  retryable R2 cleanup jobs.
- `PRIVATE_UPLOADS` is an R2 quarantine bucket for original user images.
- `PUBLISHED_MEDIA` is a separate R2 bucket for sanitized WebP derivatives.
  Neither bucket should have an `r2.dev` URL or R2 custom domain enabled.
- Every new R2 object receives a provisional D1 cleanup record before it is
  written. A successful media commit clears that record in the same D1
  transaction; failed cleanup remains discoverable for bounded scheduled
  retries. A reviewed `quarantine/` lifecycle policy and R2 inventory remain
  operational backstops for platform-level or out-of-band failures.
- The Cloudflare Images Worker binding decodes and re-encodes an image only
  after an administrator approves the complete submission. These transformations
  use the account's Cloudflare Images billing in preview and production.
- Turnstile protects organization submissions, event submissions, newsletter
  subscriptions, and member email-link requests. Server verification checks the
  exact action and hostname.

Members sign in through single-use email links; member accounts have no
password. Only a hash of each 32-byte token is stored, links expire after 15
minutes, and the verification screen requires a deliberate Continue action.
Member sessions use a cookie distinct from administration, expire after seven
days of inactivity, and have a thirty-day absolute limit. Favorites and RSVPs
are account-backed and therefore follow the member across devices.

Administration remains a separate security boundary. An owner or editor email
is allowlisted outside the public application, then uses the same single-use
member email-link flow. Consuming a link for an active administrator also issues
a distinct `__Host-` prefixed, Secure, HttpOnly, SameSite=Strict admin cookie.
Editors may moderate submissions, while subscriber export remains owner-only.
Admin sessions expire after 30 minutes of inactivity and always expire after
eight hours; logout and session loss clear rendered private data in the current
tab and other open admin tabs. There is no administrator password endpoint, and
an unauthenticated or non-admin request to `/admin` receives the ordinary 404
page.
Preview and production enablement of the new member and email features also
requires verified external MFA or step-up protection in front of `/admin`.

The administration dashboard also manages organization outreach and news.
Outreach contacts carry a current follow-up state, while each recorded email,
reply, phone call, meeting, note, and status transition remains in an
append-only history. An email cannot be marked sent without a sent-mail link,
message ID, or provider reference. News posts begin as private drafts and
require an explicit publish action before `/news` or the homepage can show
them; unpublishing and archiving preserve the post and its audit evidence.

## Member application

- `/signin` requests a magic link, `/signin/verify` deliberately consumes it,
  and `/me` contains the member profile, saved organizations and events,
  upcoming and past RSVP history, member-owned suggestions, and notification
  settings.
- Members can narrow personalized event updates by organization focus area and
  event location. Multiple choices match within a group, while non-empty
  interest and place groups must both match. Empty groups remain unrestricted;
  these filters never create or reactivate newsletter consent.
- Public HTML is safe to cache because it renders only a **Sign in** shell.
  The browser hydrates **My STC** and item-specific state from authenticated
  `no-store` responses.
- Signed-out favorite and RSVP actions carry a restricted, server-stored
  pending intent through sign-in. Unsafe external return paths are discarded.
- Events may be standalone or linked to multiple organizations as a host,
  organizer, partner, or beneficiary, with at most one primary relationship.
- Organization profiles support ordered, labeled public email and phone
  contacts plus optional plain-text Mission, Programs & services, Ways to help,
  Eligibility, and Hours sections. Proposed profile content remains in private
  staging tables until the complete organization submission is approved.
- `/suggest/organization` and `/suggest/event` require an authenticated member
  session. The verified session email becomes the private reviewer contact and
  is never copied into the public listing.
- Public event responses include only the aggregate number of going RSVPs.
  Attendee identities are never part of public responses.
- Future directories and the sitemap omit ended events. An ended event's
  existing detail URL remains a read-only, noindex archive.
- Account deletion revokes member sessions and removes favorites and RSVPs.
  Retained submissions lose their member association and continue under their
  existing moderation and retention rules.

## Submission lifecycle

1. A signed-in member submits structured organization or event data, with an
   optional JPEG, PNG, or WebP image of at most 5 MiB.
2. The Worker enforces exact-origin submission, per-IP rate limits, the
   member-scoped submission limit, Turnstile, field constraints, file
   signatures, dimensions, and pixel-count limits.
3. Before an opaque original-image key is written to private R2, D1 records a
   provisional cleanup job. The submission and media asset then enter D1 as
   `pending`, and that atomic commit clears the provisional job.
4. An authenticated administrator previews the private submission and chooses
   approve or deny. Denied submissions can be restored to pending.
5. Approval transforms an image to WebP at a maximum of 1600 by 1600 pixels.
   WebP output discards invisible EXIF metadata. The derivative is stored in
   the separate published-media bucket before one D1 batch publishes the
   listing, moderation event, and media state. D1 triggers reject stale or
   contradictory state if moderation requests race each other.
6. Only active records in `organizations` and `events` and media assets in
   `published` state are accessible through public routes.
7. A daily scheduled handler retries failed R2 cleanup, purges approved and
   denied originals after 30 days by default, removes stale pending originals,
   staged organization
   contacts and profile sections, and anonymizes private submitter identifiers
   after 90 days by default, and deletes expired
   rate-limit rows. It also expires member auth records, trims email-delivery
   metadata after 90 days, schedules enabled 24-hour RSVP reminders, and
   retries due transactional messages. Published derivatives and moderation
   evidence remain.

Submission rate limiting uses `RATE_LIMIT_WINDOW_SECONDS` (300 seconds by
default) and `SUBMISSION_IP_LIMIT` for both forms. `SUBMISSION_MEMBER_LIMIT`
additionally limits each authenticated member to five organization submissions
in that same window; it complements rather than replaces the per-IP limit.

## Local development

Requirements: a current Node.js runtime and npm. Local development does not
use production Cloudflare resources.

```sh
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run db:seed:local
npm run dev
```

Replace every value in `.dev.vars`; the file is ignored by Git. The local
Wrangler configuration intentionally has no Images binding. Image intake and
private review work locally, while approval of an image is verified by the
mocked Images binding in integration tests. Preview is the required human test
environment for the real Cloudflare Images transformation.

The local application runs at `http://127.0.0.1:8787`. Demonstration listings
and the passwordless `owner@example.test` owner allowlist entry from
`ops/seed-development.sql` are explicitly local-only. Local transactional
messages and the weekly event digest are captured in the D1 development inbox;
magic-link requests provide an on-screen local preview URL. The inbox identifies
the intended provider, From address, and Reply-To address for inspection. Local
mode does not invoke the Cloudflare Email Service binding or use a real Forward
Email credential, never contacts a recipient, and does not print tokens to
ordinary logs.

Complete [member-local-acceptance.md](ops/member-local-acceptance.md) for the
full first-time and returning-member journey.

For a new Cloudflare account or public fork, follow the repository-level
[self-hosting guide](../docs/SELF_HOSTING.md). It separates local testing,
provider provisioning, GitHub configuration, preview acceptance, and
production authorization.

## Verification

```sh
npm run check
npm test
npm run verify
```

The test suite runs inside Cloudflare's Workers runtime and covers D1, R2,
authentication, origin and CSRF controls, constrained uploads, private media,
durable cleanup retries, keyed idempotency conflicts, moderation state
transitions, atomic audit evidence, approved-only publication, and static
security contracts. Static contracts also verify that the Worker-owned
presentation assets and expected routes remain present.

## Routes

Public route compatibility is retained:

- `/`, `/about`, `/privacy`
- `/organizations`, `/organization/:slug`
- `/events`, `/event/:id`
- `/news`, `/news/:slug`
- `/sitemap.xml`, `/robots.txt`
- `/unsubscribe/:token`

Member routes are `/signin`, `/signin/verify`, `/me`, and the authenticated
`/suggest/organization` and `/suggest/event` pages; authenticated member APIs are under
`/api/member/`. Development-inbox access is available only when `ENVIRONMENT`
is `local` or `test`.

The administration interface is at `/admin`; its APIs are under `/api/admin/`.

## Email boundary

Subscription, unsubscribe-token storage, active/unsubscribed state, private
administrator counts, protected CSV export, and a local weekly event digest are
implemented. Member transactional messages use idempotent D1 jobs so an email
failure never reverses an RSVP or submission. Cloudflare Email Service is the
transactional provider: its restricted Worker binding permits only
`signin@servethecays.com` for sign-in links and
`notifications@servethecays.com` for other member notifications. Forward Email
remains the newsletter provider for `news@servethecays.com` and the inbound
human-correspondence provider for `hello@servethecays.com`. All application
messages use `hello@servethecays.com` as Reply-To. The Forward Email
account-wide API token is reserved for newsletter delivery-status readback and
is never used to send.

Newsletter consent and member accounts remain separate. Subscribing does not
create a member, signing in does not subscribe an address, and unsubscribing
from newsletters does not block requested sign-in, RSVP, or submission-status
messages. If an active subscriber later creates a member with the same email,
STC may use that member's saved preferences to customize future digests without
changing the subscriber's consent state.

Newsletter signup now creates an expiring confirmation request, not an active
subscriber. The confirmation token is stored only as a hash, is carried in the
URL fragment so it is not sent in the initial request, and requires a deliberate
confirmation action before consent becomes active. Local/test captures the
branded confirmation message in the development inbox; preview and production
remain fail-closed until the real provider flow is verified.

The tracked `wrangler.jsonc` is a public, fail-closed architecture template:
live resource identifiers are placeholders and all external-delivery release
gates are off. Provisioned identifiers, production state, approvals, recovery
points, and provider evidence belong in the ignored `wrangler.private.jsonc`
and `ops/private/` paths. Forward Email newsletter approval, signed replay-safe
bounce and complaint ingestion, provider status readback, double opt-in,
suppression verification, and the no-blind-retry reconciliation lane remain
release prerequisites. Ambiguous outcomes stay held for provider readback and
eventual manual review rather than being resent.

See [production-runbook.md](ops/production-runbook.md) for provisioning and
cutover, and [data-migration.md](ops/data-migration.md) for legacy inventory and
import controls.
