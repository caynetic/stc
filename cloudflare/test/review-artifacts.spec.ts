import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

import { developmentEmailInbox, queueEmail, type EmailKind } from "../src/email";
import { buildNewsletterConfirmationMessage } from "../src/newsletter-delivery";
import {
  confirmNewsletterSubscription,
  enableNewsletterPersonalization,
  fanoutNewsletterDigest,
  generateWeeklyDigest,
  newsletterCustomizeToken,
  processNewsletterConfirmationJobs,
  processNewsletterJobs,
  subscribe,
} from "../src/newsletter";
import type { Env } from "../src/types";

const APP_ORIGIN = "https://servethecays.test";
const baseEnv = env as unknown as Env;
const reviewFiles: Record<string, string> = {};

const filenameByKind: Record<EmailKind, string> = {
  magic_link: "sign-in",
  welcome: "welcome",
  rsvp_confirmation: "rsvp-confirmed",
  rsvp_cancellation: "rsvp-cancelled",
  event_reminder: "event-reminder",
  submission_receipt: "submission-receipt",
  submission_approved: "listing-approved",
  submission_denied: "submission-denied",
};

function reviewHtml(html: string): string {
  return html
    .replaceAll(`${APP_ORIGIN}/static/images/email-logo.5a81761f5371.png`, "../assets/logo.png")
    .replace(/href="https:\/\/servethecays\.test[^"]*"/g, (value) => {
      const target = value.slice(6, -1);
      return `href="../index.html#external-link-note" data-original-href="${target}" title="External action disabled in this offline review copy"`;
    });
}

function writeEmail(filename: string, message: { subject: string; text: string; html: string }, source: string): void {
  const evidence = `<!-- Review evidence: ${source}; subject: ${message.subject}; clickable external actions are redirected to the offline review note. -->\n`;
  reviewFiles[`emails/${filename}.html`] = `${evidence}${reviewHtml(message.html)}\n`;
  reviewFiles[`emails/${filename}.txt`] = `Subject: ${message.subject}\nEvidence source: ${source}\n\n${message.text}\n`;
}

async function subscribeAndConfirm(email: string, ip: string): Promise<void> {
  const response = await subscribe(new Request(`${APP_ORIGIN}/api/newsletter/subscribe`, {
    method: "POST",
    headers: {
      Origin: APP_ORIGIN,
      "Content-Type": "application/json",
      "CF-Connecting-IP": ip,
    },
    body: JSON.stringify({ email }),
  }), baseEnv);
  expect(response.status).toBe(202);
  await processNewsletterConfirmationJobs(baseEnv, 10);
  const row = await baseEnv.DB.prepare(
    "SELECT capture_json FROM newsletter_confirmation_requests WHERE email = ?",
  ).bind(email).first<{ capture_json: string }>();
  const capture = JSON.parse(row!.capture_json) as { text: string };
  const token = capture.text.match(/newsletter\/confirm#token=([A-Za-z0-9_-]+)/)?.[1] ?? "";
  const confirmed = await confirmNewsletterSubscription(new Request(`${APP_ORIGIN}/api/newsletter/confirm`, {
    method: "POST",
    headers: { Origin: APP_ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  }), baseEnv);
  expect(confirmed.status).toBe(200);
}

async function seedDigestEvent(
  slug: string,
  publishedAt: string,
  startAt: string,
): Promise<number> {
  const result = await baseEnv.DB.prepare(
    `INSERT INTO events (
       slug, name, description, start_at, timezone, venue_name,
       location_display, is_active, published_at, updated_at
     ) VALUES (?, ?, ?, ?, 'America/Nassau', 'Clifton Heritage Park',
               'New Providence', 1, ?, ?)
     RETURNING id`,
  ).bind(
    slug,
    slug === "community-shoreline-day" ? "Community Shoreline Day" : "Family Service Fair",
    "A community event with volunteering and family activities.",
    startAt,
    publishedAt,
    publishedAt,
  ).first<{ id: number }>();
  return Number(result!.id);
}

it("exports every implemented email variant from the real builders without sending", async () => {
  const event = {
    event_id: 42,
    name: "Community Shoreline Day",
    start_at: "2026-09-12T13:00:00.000Z",
    end_at: "2026-09-12T17:00:00.000Z",
    timezone: "America/Nassau",
    venue_name: "Clifton Heritage Park",
    location_display: "New Providence",
    event_url: `${APP_ORIGIN}/event/42`,
  };
  const jobs: Array<{ kind: EmailKind; payload: Record<string, unknown> }> = [
    { kind: "magic_link", payload: { sign_in_url: `${APP_ORIGIN}/signin/verify#token=review-token`, expires_minutes: 15 } },
    { kind: "welcome", payload: {} },
    { kind: "rsvp_confirmation", payload: event },
    { kind: "rsvp_cancellation", payload: event },
    { kind: "event_reminder", payload: event },
    { kind: "submission_receipt", payload: { name: "Harbour Youth Collective", submission_type: "organization" } },
    { kind: "submission_approved", payload: { name: "Harbour Youth Collective", submission_type: "organization", event_url: `${APP_ORIGIN}/organization/harbour-youth-collective` } },
    { kind: "submission_denied", payload: { name: "Harbour Youth Collective", submission_type: "organization", reason: "The participation pathway needs a current official source." } },
  ];
  for (const [index, job] of jobs.entries()) {
    await queueEmail(baseEnv, {
      kind: job.kind,
      recipientEmail: "review@example.org",
      idempotencyKey: `review:${job.kind}:${index}`,
      payload: job.payload,
    });
  }
  const inboxResponse = await developmentEmailInbox(new Request(`${APP_ORIGIN}/api/dev/emails`, {
    headers: { Origin: APP_ORIGIN },
  }), baseEnv);
  const inbox = await inboxResponse.json() as {
    emails: Array<{ kind: EmailKind; subject: string; text: string; html: string }>;
  };
  expect(new Set(inbox.emails.map((email) => email.kind))).toEqual(new Set(Object.keys(filenameByKind)));
  for (const email of inbox.emails) {
    writeEmail(filenameByKind[email.kind], email, `src/email.ts:${email.kind}`);
  }

  const confirmation = buildNewsletterConfirmationMessage({
    recipient: "review@example.org",
    confirmationUrl: `${APP_ORIGIN}/newsletter/confirm#token=review-confirmation-token`,
    requestId: "review-newsletter-confirmation",
    expiresAt: new Date("2026-08-21T12:00:00.000Z"),
    sentAt: new Date("2026-08-20T12:00:00.000Z"),
  });
  writeEmail("newsletter-confirmation", confirmation, "src/newsletter-delivery.ts:buildNewsletterConfirmationMessage");

  const now = "2026-08-20T12:00:00.000Z";
  await baseEnv.DB.prepare(
    `INSERT INTO members (id, email, created_at, updated_at)
     VALUES ('member_review_personal', 'personal-review@example.org', ?, ?)`,
  ).bind(now, now).run();
  await subscribeAndConfirm("general-review@example.org", "203.0.113.91");
  await subscribeAndConfirm("personal-review@example.org", "203.0.113.92");
  const customizeToken = await newsletterCustomizeToken(baseEnv, "personal-review@example.org");
  expect(await enableNewsletterPersonalization(baseEnv, customizeToken, "member_review_personal")).toBe(true);
  const favoriteId = await seedDigestEvent(
    "community-shoreline-day",
    "2026-08-11T14:00:00.000Z",
    "2026-09-12T13:00:00.000Z",
  );
  await seedDigestEvent(
    "family-service-fair",
    "2026-08-12T14:00:00.000Z",
    "2026-10-03T15:00:00.000Z",
  );
  await baseEnv.DB.prepare(
    `INSERT INTO event_favorites (member_id, event_id, created_at)
     VALUES ('member_review_personal', ?, ?)`,
  ).bind(favoriteId, now).run();
  const digestId = await generateWeeklyDigest(baseEnv, new Date(now));
  expect(await fanoutNewsletterDigest(baseEnv, digestId)).toBe(2);
  expect(await processNewsletterJobs(baseEnv, 10)).toBe(2);
  const deliveries = await baseEnv.DB.prepare(
    `SELECT mode, capture_json FROM newsletter_deliveries
     WHERE digest_id = ? ORDER BY mode`,
  ).bind(digestId).all<{ mode: "general" | "personalized"; capture_json: string }>();
  expect(deliveries.results.map((delivery) => delivery.mode)).toEqual(["general", "personalized"]);
  for (const delivery of deliveries.results) {
    const capture = JSON.parse(delivery.capture_json) as { subject: string; text: string; html: string };
    writeEmail(
      delivery.mode === "general" ? "weekly-digest-general" : "weekly-digest-personalized",
      capture,
      `src/newsletter.ts:${delivery.mode}`,
    );
  }

  const manifest = {
    generated_at: now,
    sent: false,
    transactional_kinds: Object.keys(filenameByKind),
    newsletter_kinds: ["confirmation", "general_digest", "personalized_digest"],
    total_variants: 11,
  };
  reviewFiles["emails/manifest.json"] = `${JSON.stringify(manifest, null, 2)}\n`;
  expect(Object.keys(reviewFiles).filter((path) => path.endsWith(".html"))).toHaveLength(11);
  expect(Object.keys(reviewFiles).filter((path) => path.endsWith(".txt"))).toHaveLength(11);
  expect(Object.keys(reviewFiles)).toHaveLength(23);
  expect(reviewFiles["emails/manifest.json"]).toContain('"total_variants": 11');
});
