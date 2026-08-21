# Member application local acceptance

This checklist is intentionally local-only. Do not point the local Worker at
preview or production D1, R2, Turnstile, or email resources. Do not add real
Cloudflare Email Service or Forward Email credentials while completing it.

## Start with isolated local data

```sh
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run db:seed:local
npm run dev
```

Set every placeholder in `.dev.vars` to a long local-only value. The local
Worker runs at `http://127.0.0.1:8787`. Its development inbox stores messages
in local D1 and its sign-in request response exposes a local preview URL; it
does not contact the recipient. The local configuration enables digest logic
only so the weekly newsletter can be inspected in that same development inbox.

## Member journey

1. Open `/signin`, enter a test email address, and submit the form.
2. Open the development sign-in URL, confirm that the token is removed from
   the address bar, and choose **Continue**.
3. Confirm that the first sign-in creates the member and opens `/me`.
4. Edit the display name and reminder preference. Choose one or more event
   interests and places, save, reload `/me`, and confirm they persist.
5. Save the seeded organization and event. Confirm both appear under **My
   STC**, then reload and confirm the hearts remain selected.
6. Choose **I'm Going** on the seeded event. Confirm the RSVP appears in My
   STC, the public aggregate increases, and no attendee identity is present in
   a public response.
7. Inspect the development inbox for the welcome and RSVP confirmations. The
   RSVP message must include event details, a local event URL, and calendar
   attachment metadata. Confirm sign-in messages show Cloudflare Email Service
   as the intended provider with `signin@servethecays.com`; other notifications
   use `notifications@servethecays.com`, and both reply to
   `hello@servethecays.com`.
8. Cancel the RSVP. Confirm the dashboard history and cancellation message,
   and confirm a duplicate cancellation is harmless.
9. Sign out, use a heart or RSVP control, complete sign-in, and confirm the
   pending action completes only after explicit verification.
10. Sign in with a second email and confirm it cannot see the first member's
    favorites, RSVP history, profile, or submissions.
11. From **My suggestions**, open both dedicated suggestion actions. Confirm a
    signed-out tab returns to the exact organization or event form after magic
    link verification, and neither form accepts a client-supplied private email.

## Newsletter journey

1. Subscribe a new test address and confirm it creates a pending confirmation
   request, not an active subscriber or member account.
2. Open the development confirmation message and deliberately confirm the
   address. Confirm only that action creates the active subscriber and that a
   replay does not duplicate or reactivate consent.
3. Run the local weekly digest and inspect it in the development inbox. Confirm
   it uses Forward Email as the intended provider, From
   `news@servethecays.com`, Reply-To `hello@servethecays.com`, and includes the
   applicable new or upcoming events only once.
4. Confirm the general digest includes a safe route for requesting a fresh
   private sign-in link to customize updates; an old newsletter must not be a
   permanent member session.
5. Sign in with that same address. Confirm the subscriber and member remain
   separate records, existing newsletter consent remains active, and member
   preferences can customize later digests without changing consent.
6. Turn on personalization, select an interest and a place, and rebuild the
   digest. Confirm interests match categories on connected organizations,
   places match the event location, and selecting both requires both to match.
   Clear either group and confirm that dimension becomes unrestricted.
7. Confirm signing in with an address that never subscribed does not subscribe
   it automatically.
8. Unsubscribe the first address, rerun the digest, and confirm it is excluded
   while requested sign-in and other transactional messages still work.
9. Confirm duplicate digest scheduling, retry, and repeated maintenance runs do
   not create duplicate logical deliveries or exceed the local daily limit.

## Event relationships and moderation

1. Open the seeded **Community Service Day**. It should show both local-only
   organizations, with one primary host and one partner.
2. Submit a new event from My STC with no organization and confirm it remains a valid
   standalone proposal.
3. Submit another event linked to two organizations. In `/admin`, change a
   role and the primary organization before approval.
4. Approve it and confirm both event-to-organization links appear on the
   public event page and the event appears on each linked organization page.
5. Edit the links on the published event and confirm the one-primary rule,
   duplicate rejection, and inactive-organization rejection.
6. Confirm an ended event remains available at its detail URL with an ended
   label, cannot be favorited or RSVP'd to, and is absent from `/events` and
   `/sitemap.xml`.

## Failure and privacy checks

- Invalid, expired, and replayed magic links fail without creating a session.
- Merely loading `/signin/verify` never consumes the token.
- Sign-in request responses are generic for new and returning addresses.
- Unsafe external return paths and unsupported pending actions are discarded.
- Missing or invalid CSRF tokens and cross-origin mutations are rejected.
- The seven-day inactivity and thirty-day absolute session limits are enforced.
- Authentication throttles both normalized email and network identities.
- Email provider failure leaves favorites, RSVPs, and submissions committed;
  retrying a job cannot duplicate a logical message.
- Account deletion revokes every member session, deletes favorites and RSVPs,
  and detaches retained submissions from the member.

## Automated gate

Run the complete local verification suite before considering local acceptance
complete:

```sh
npm run verify
```

This local checklist does not authorize remote changes. Preview and production
work require explicit approval in the ignored private change record described
by the public deployment guide. The remote sequence requires a D1 recovery
bookmark and migrations `0001_initial.sql` through
`0011_outreach_and_news.sql`, Cloudflare Email Service onboarding and a
restricted transactional binding for `signin@servethecays.com` and
`notifications@servethecays.com`, Forward Email newsletter approval for
`news@servethecays.com`, SPF/DKIM/DMARC, real-delivery and confirmation, signed
suppression, and reconciliation tests, policy publication, external admin MFA,
private-R2 lifecycle readback, monitoring, and rollback rehearsal.
