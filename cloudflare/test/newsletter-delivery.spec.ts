import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { sha256Hex } from "../src/security";
import {
  buildNewsletterMessage,
  sendNewsletterViaForwardEmail,
} from "../src/newsletter-delivery";
import {
  confirmNewsletterSubscription,
  developmentNewsletterInbox,
  enableNewsletterPersonalization,
  fanoutNewsletterDigest,
  generateWeeklyDigest,
  newsletterMaintenance,
  newsletterDeliveryEnabled,
  newsletterCustomizeToken,
  newsletterUnsubscribeToken,
  oneClickUnsubscribe,
  processNewsletterConfirmationJobs,
  processNewsletterJobs,
  resolveNewsletterCustomizeToken,
  subscribe,
} from "../src/newsletter";
import type { Env } from "../src/types";

const APP_ORIGIN = "https://servethecays.test";
const baseEnv = env as unknown as Env;
let testIpOctet = 1;

async function subscribeEmail(email: string): Promise<void> {
  const response = await subscribe(new Request(`${APP_ORIGIN}/api/newsletter/subscribe`, {
    method: "POST",
    headers: {
      Origin: APP_ORIGIN,
      "Content-Type": "application/json",
      "CF-Connecting-IP": `203.0.113.${testIpOctet++}`,
    },
    body: JSON.stringify({ email }),
  }), baseEnv);
  expect(response.status).toBe(202);
  await processNewsletterConfirmationJobs(baseEnv, 10);
  const row = await baseEnv.DB.prepare(
    "SELECT capture_json FROM newsletter_confirmation_requests WHERE email = ?",
  ).bind(email.trim().toLowerCase()).first<{ capture_json: string }>();
  const capture = JSON.parse(row!.capture_json) as { text: string };
  const token = capture.text.match(/newsletter\/confirm#token=([A-Za-z0-9_-]+)/)?.[1];
  expect(token).toBeTruthy();
  const confirmed = await confirmNewsletterSubscription(new Request(`${APP_ORIGIN}/api/newsletter/confirm`, {
    method: "POST",
    headers: { Origin: APP_ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  }), baseEnv);
  expect(confirmed.status).toBe(200);
}

async function seedEvent(
  slug: string,
  publishedAt = "2026-08-05T14:00:00.000Z",
  startAt = "2099-08-20T22:00:00.000Z",
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
    `Community Day ${slug}`,
    "A community event with volunteering and family activities.",
    startAt,
    publishedAt,
    publishedAt,
  ).first<{ id: number }>();
  return Number(result!.id);
}

describe("newsletter provider split", () => {
  it("does not let one delivery toggle bypass schema, suppression, or double-opt-in readiness", () => {
    expect(newsletterDeliveryEnabled({
      ...baseEnv,
      ENVIRONMENT: "production",
      NEWSLETTER_DELIVERY_ENABLED: "true",
      MEMBER_SCHEMA_RELEASE_READY: "true",
      NEWSLETTER_SUPPRESSION_INGESTION_VERIFIED: "false",
      NEWSLETTER_DOUBLE_OPT_IN_VERIFIED: "true",
    })).toBe(false);
  });

  it("does not create direct-active consent outside local/test", async () => {
    const previewEnv = {
      ...baseEnv,
      ENVIRONMENT: "preview",
    } as Env;
    await expect(subscribe(new Request(`${APP_ORIGIN}/api/newsletter/subscribe`, {
      method: "POST",
      headers: {
        Origin: APP_ORIGIN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: "unconfirmed@example.org" }),
    }), previewEnv)).rejects.toMatchObject({ status: 503, code: "newsletter_unavailable" });
    expect(await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS value FROM subscribers WHERE email = 'unconfirmed@example.org'",
    ).first<{ value: number }>()).toEqual({ value: 0 });
  });

  it("creates distinct deterministic tokens and links a new subscriber to a matching member", async () => {
    const now = "2026-08-10T12:00:00.000Z";
    await baseEnv.DB.prepare(
      `INSERT INTO members (id, email, created_at, updated_at)
       VALUES ('member_news', 'reader@example.org', ?, ?)`,
    ).bind(now, now).run();

    await subscribeEmail("Reader@Example.org");
    const unsubscribeToken = await newsletterUnsubscribeToken(baseEnv, "reader@example.org");
    const customizeToken = await newsletterCustomizeToken(baseEnv, "reader@example.org");
    expect(unsubscribeToken).toHaveLength(43);
    expect(customizeToken).toHaveLength(43);
    expect(customizeToken).not.toBe(unsubscribeToken);
    expect(await newsletterUnsubscribeToken(baseEnv, "reader@example.org")).toBe(unsubscribeToken);

    const row = await baseEnv.DB.prepare(
      `SELECT member_id, personalization_enabled, unsubscribe_token_hash, customize_token_hash
       FROM subscribers WHERE email = 'reader@example.org'`,
    ).first<Record<string, unknown>>();
    expect(row).toMatchObject({
      member_id: "member_news",
      personalization_enabled: 0,
      unsubscribe_token_hash: await sha256Hex(unsubscribeToken),
      customize_token_hash: await sha256Hex(customizeToken),
    });
    expect(await resolveNewsletterCustomizeToken(baseEnv, customizeToken)).toBe("reader@example.org");
    expect(await resolveNewsletterCustomizeToken(baseEnv, unsubscribeToken)).toBeNull();
    expect(await enableNewsletterPersonalization(baseEnv, customizeToken, "member_news")).toBe(true);
    const enabled = await baseEnv.DB.prepare(
      "SELECT personalization_enabled FROM subscribers WHERE email = 'reader@example.org'",
    ).first<{ personalization_enabled: number }>();
    expect(enabled?.personalization_enabled).toBe(1);
  });

  it("rejects mismatched member links, invalid personalization, and changed delivery recipients", async () => {
    const now = "2026-08-10T12:00:00.000Z";
    await baseEnv.DB.prepare(
      `INSERT INTO members (id, email, created_at, updated_at)
       VALUES ('member_guard', 'member@example.org', ?, ?)`,
    ).bind(now, now).run();
    await expect(baseEnv.DB.prepare(
      `INSERT INTO subscribers (
         id, email, status, consent_at, unsubscribe_token_hash, ip_hash,
         member_id, personalization_enabled, created_at, updated_at
       ) VALUES (
         'subscriber_mismatch', 'different@example.org', 'active', ?, ?, '',
         'member_guard', 0, ?, ?
       )`,
    ).bind(now, "a".repeat(64), now, now).run()).rejects.toThrow(/subscriber member email mismatch/);
    await expect(baseEnv.DB.prepare(
      `INSERT INTO subscribers (
         id, email, status, consent_at, unsubscribe_token_hash, ip_hash,
         personalization_enabled, created_at, updated_at
       ) VALUES (
         'subscriber_personal_without_member', 'orphan@example.org', 'active', ?, ?, '',
         1, ?, ?
       )`,
    ).bind(now, "b".repeat(64), now, now).run()).rejects.toThrow(/personalization requires member/);

    await subscribeEmail("guarded@example.org");
    const subscriber = await baseEnv.DB.prepare(
      "SELECT id FROM subscribers WHERE email = 'guarded@example.org'",
    ).first<{ id: string }>();
    await baseEnv.DB.prepare(
      `INSERT INTO newsletter_digests (
         id, window_start, window_end, event_ids_json, status,
         fanout_cursor, fanout_completed_at, created_at, updated_at
       ) VALUES ('digest_guard', '2026-08-03T00:00:00.000Z',
                 '2026-08-10T00:00:00.000Z', '[1]', 'delivering', '', ?, ?, ?)`,
    ).bind(now, now, now).run();
    await expect(baseEnv.DB.prepare(
      `INSERT INTO newsletter_deliveries (
         id, digest_id, subscriber_id, recipient_email, mode, status,
         attempts, available_at, created_at, updated_at
       ) VALUES ('newsletter_guard', 'digest_guard', ?, 'changed@example.org',
                 'general', 'pending', 0, ?, ?, ?)`,
    ).bind(subscriber!.id, now, now, now).run()).rejects.toThrow(/delivery recipient mismatch/);
  });

  it("keeps GET unsubscribe scanner-safe and cancels pending mail on one-click POST", async () => {
    await subscribeEmail("optout@example.org");
    const token = await newsletterUnsubscribeToken(baseEnv, "optout@example.org");
    const subscriber = await baseEnv.DB.prepare(
      "SELECT id FROM subscribers WHERE email = 'optout@example.org'",
    ).first<{ id: string }>();
    const now = new Date().toISOString();
    await baseEnv.DB.batch([
      baseEnv.DB.prepare(
        `INSERT INTO newsletter_digests (
           id, window_start, window_end, event_ids_json, status,
           fanout_cursor, fanout_completed_at, created_at, updated_at
         ) VALUES ('digest_optout', '2026-08-03T00:00:00.000Z',
                   '2026-08-10T00:00:00.000Z', '[1]', 'delivering',
                   '', ?, ?, ?)`,
      ).bind(now, now, now),
      baseEnv.DB.prepare(
        `INSERT INTO newsletter_deliveries (
           id, digest_id, subscriber_id, recipient_email, mode, status,
           attempts, available_at, created_at, updated_at
         ) VALUES ('newsletter_optout', 'digest_optout', ?, 'optout@example.org',
                   'general', 'pending', 0, ?, ?, ?)`,
      ).bind(subscriber!.id, now, now, now),
    ]);

    await expect(oneClickUnsubscribe(
      new Request(`${APP_ORIGIN}/unsubscribe/${token}`),
      baseEnv,
      token,
    )).rejects.toMatchObject({ status: 405 });
    expect((await baseEnv.DB.prepare(
      "SELECT status FROM subscribers WHERE id = ?",
    ).bind(subscriber!.id).first<{ status: string }>())?.status).toBe("active");

    const response = await oneClickUnsubscribe(new Request(`${APP_ORIGIN}/unsubscribe/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    }), baseEnv, token);
    expect(response.status).toBe(200);
    expect((await baseEnv.DB.prepare(
      "SELECT status FROM subscribers WHERE id = ?",
    ).bind(subscriber!.id).first<{ status: string }>())?.status).toBe("unsubscribed");
    expect((await baseEnv.DB.prepare(
      "SELECT status FROM newsletter_deliveries WHERE id = 'newsletter_optout'",
    ).first<{ status: string }>())?.status).toBe("cancelled");
    expect(await resolveNewsletterCustomizeToken(
      baseEnv,
      await newsletterCustomizeToken(baseEnv, "optout@example.org"),
    )).toBeNull();
  });

  it("snapshots a completed week, fans out idempotently, and captures exact local mail", async () => {
    await subscribeEmail("digest@example.org");
    const eventId = await seedEvent("weekly-digest");
    const runAt = new Date("2026-08-10T12:00:00.000Z");
    const digestId = await generateWeeklyDigest(baseEnv, runAt);
    expect(await generateWeeklyDigest(baseEnv, runAt)).toBe(digestId);
    const digest = await baseEnv.DB.prepare(
      "SELECT window_start, window_end, event_ids_json, status FROM newsletter_digests WHERE id = ?",
    ).bind(digestId).first<Record<string, unknown>>();
    expect(digest).toMatchObject({
      window_start: "2026-08-03T00:00:00.000Z",
      window_end: "2026-08-10T00:00:00.000Z",
      event_ids_json: JSON.stringify([eventId]),
      status: "fanout",
    });

    expect(await fanoutNewsletterDigest(baseEnv, digestId)).toBe(1);
    expect(await fanoutNewsletterDigest(baseEnv, digestId)).toBe(0);
    expect(await processNewsletterJobs(baseEnv)).toBe(1);
    const delivery = await baseEnv.DB.prepare(
      `SELECT status, provider, provider_message_id, capture_json
       FROM newsletter_deliveries WHERE digest_id = ?`,
    ).bind(digestId).first<Record<string, unknown>>();
    expect(delivery).toMatchObject({ status: "sent", provider: "forward_email" });
    expect(String(delivery?.provider_message_id)).toMatch(/^local:newsletter_/);
    const capture = JSON.parse(String(delivery?.capture_json)) as Record<string, string>;
    expect(capture.raw).toContain("From: Serve The Cays Updates <news@servethecays.com>");
    expect(capture.raw).toContain("Reply-To: hello@servethecays.com");
    expect(capture.raw).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    expect(capture.raw).toContain(`List-Unsubscribe: <${APP_ORIGIN}/unsubscribe/`);
    expect(capture.customize_url).toContain(`${APP_ORIGIN}/signin#subscriber=`);
    expect(capture.text).toContain("Unsubscribe:");
    expect(capture.html).toContain("Weekly event update");
    expect(capture.html).toContain("Upcoming community event");
    expect(capture.html).toContain("Community in action");
    expect(capture.html).toContain("/static/images/logo.png");
    expect(capture.html).toContain("@media only screen and (max-width: 520px)");
    expect(capture.html).toContain('class="stc-event-card-cell"');

    const inboxResponse = await developmentNewsletterInbox(
      new Request(`${APP_ORIGIN}/api/dev/newsletters`),
      baseEnv,
    );
    const inbox = await inboxResponse.json() as { emails: Array<Record<string, unknown>> };
    expect(inbox.emails[0]).toMatchObject({
      provider: "forward_email",
      capture_state: "captured_local",
      from_email: "news@servethecays.com",
      reply_to_email: "hello@servethecays.com",
      delivery_mode: "general",
    });
    expect((await baseEnv.DB.prepare(
      "SELECT status FROM newsletter_digests WHERE id = ?",
    ).bind(digestId).first<{ status: string }>())?.status).toBe("completed");
  });

  it("enforces the configured daily newsletter limit", async () => {
    await subscribeEmail("cap-one@example.org");
    await subscribeEmail("cap-two@example.org");
    await seedEvent("daily-cap");
    const digestId = await generateWeeklyDigest(baseEnv, new Date("2026-08-10T12:00:00.000Z"));
    expect(await fanoutNewsletterDigest(baseEnv, digestId)).toBe(2);
    expect(await processNewsletterJobs({
      ...baseEnv,
      NEWSLETTER_DAILY_LIMIT: "1",
    } as Env, 10)).toBe(1);
    const statuses = await baseEnv.DB.prepare(
      "SELECT status, COUNT(*) AS count FROM newsletter_deliveries GROUP BY status ORDER BY status",
    ).all<{ status: string; count: number }>();
    expect(statuses.results).toEqual([
      { status: "pending", count: 1 },
      { status: "sent", count: 1 },
    ]);
  });

  it("orders favorite matches first without dropping the remaining new events", async () => {
    const now = "2026-08-10T12:00:00.000Z";
    await baseEnv.DB.prepare(
      `INSERT INTO members (id, email, created_at, updated_at)
       VALUES ('member_personal', 'personal@example.org', ?, ?)`,
    ).bind(now, now).run();
    await subscribeEmail("personal@example.org");
    const customizeToken = await newsletterCustomizeToken(baseEnv, "personal@example.org");
    expect(await enableNewsletterPersonalization(baseEnv, customizeToken, "member_personal")).toBe(true);
    const ordinaryId = await seedEvent(
      "ordinary-event",
      "2026-08-05T14:00:00.000Z",
      "2099-08-19T22:00:00.000Z",
    );
    const favoriteId = await seedEvent(
      "favorite-event",
      "2026-08-06T14:00:00.000Z",
      "2099-08-21T22:00:00.000Z",
    );
    await baseEnv.DB.prepare(
      `INSERT INTO event_favorites (member_id, event_id, created_at)
       VALUES ('member_personal', ?, ?)`,
    ).bind(favoriteId, now).run();

    const digestId = await generateWeeklyDigest(baseEnv, new Date(now));
    expect(await fanoutNewsletterDigest(baseEnv, digestId)).toBe(1);
    expect(await processNewsletterJobs(baseEnv)).toBe(1);
    const row = await baseEnv.DB.prepare(
      "SELECT mode, capture_json FROM newsletter_deliveries WHERE digest_id = ?",
    ).bind(digestId).first<{ mode: string; capture_json: string }>();
    expect(row?.mode).toBe("personalized");
    const capture = JSON.parse(row!.capture_json) as { text: string };
    expect(capture.text).toContain(`Community Day ordinary-event`);
    expect(capture.text).toContain(`Community Day favorite-event`);
    expect(capture.text.indexOf(`Community Day favorite-event`))
      .toBeLessThan(capture.text.indexOf(`Community Day ordinary-event`));
    expect(ordinaryId).not.toBe(favoriteId);
  });

  it("uses Forward Email's fixed alias through HTTPS without exposing a second recipient", async () => {
    let requestBody = "";
    const fakeFetch = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://api.forwardemail.net/v1/emails");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("manual");
      const headers = new Headers(init?.headers);
      expect(atob(headers.get("Authorization")!.slice("Basic ".length)))
        .toBe("news@servethecays.com:alias-password");
      requestBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ _id: "forward-email-id" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const input = {
      deliveryId: "newsletter_adapter",
      recipient: "one@example.org",
      subject: "New events",
      text: "An event update.",
      html: "<!doctype html><html><body><p>An event update.</p></body></html>",
      unsubscribeUrl: `${APP_ORIGIN}/unsubscribe/private-token`,
      customizeUrl: `${APP_ORIGIN}/signin#subscriber=private-customize-token`,
      sentAt: new Date("2026-08-10T12:00:00.000Z"),
    };
    const built = buildNewsletterMessage(input);
    expect(built.text).toContain("Customize your updates:");
    const result = await sendNewsletterViaForwardEmail(
      {
        FORWARD_EMAIL_NEWSLETTER_PASSWORD: "alias-password",
        FORWARD_EMAIL_API_TOKEN: "account-wide-token-must-not-send",
      },
      input,
      fakeFetch,
    );
    expect(result).toMatchObject({ provider: "forward_email", providerMessageId: "forward-email-id" });
    const raw = new URLSearchParams(requestBody).get("raw") ?? "";
    expect(raw).toContain("To: one@example.org\r\n");
    expect(raw).toContain("Message-ID: <newsletter_adapter@servethecays.com>");
    expect(raw).toContain("X-Entity-Ref-ID: newsletter_adapter");
    expect(raw).not.toContain("two@example.org");
  });

  it("refuses to follow a provider redirect with newsletter credentials", async () => {
    const fakeFetch = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.redirect).toBe("manual");
      return new Response(null, {
        status: 302,
        headers: { Location: "https://redirected.example/v1/emails" },
      });
    });
    await expect(sendNewsletterViaForwardEmail(
      { FORWARD_EMAIL_NEWSLETTER_PASSWORD: "alias-password" },
      {
        deliveryId: "newsletter_redirect_guard",
        recipient: "one@example.org",
        subject: "New events",
        text: "An event update.",
        html: "<!doctype html><html><body><p>An event update.</p></body></html>",
        unsubscribeUrl: `${APP_ORIGIN}/unsubscribe/private-token`,
      },
      fakeFetch,
    )).rejects.toMatchObject({
      status: 302,
      retryable: false,
      uncertain: false,
    });
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("never falls back to the account-wide API token for newsletter sends", async () => {
    const fakeFetch = vi.fn<typeof fetch>();
    await expect(sendNewsletterViaForwardEmail(
      { FORWARD_EMAIL_API_TOKEN: "account-wide-token" },
      {
        deliveryId: "newsletter_alias_required",
        recipient: "one@example.org",
        subject: "New events",
        text: "An event update.",
        html: "<!doctype html><html><body><p>An event update.</p></body></html>",
        unsubscribeUrl: `${APP_ORIGIN}/unsubscribe/private-token`,
      },
      fakeFetch,
    )).rejects.toMatchObject({
      message: "Forward Email alias credentials are not configured",
      retryable: false,
      uncertain: false,
    });
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("records an accepted in-flight send even if the subscriber opts out during provider delivery", async () => {
    await subscribeEmail("inflight@example.org");
    await seedEvent("inflight-delivery");
    const digestId = await generateWeeklyDigest(baseEnv, new Date("2026-08-10T12:00:00.000Z"));
    expect(await fanoutNewsletterDigest(baseEnv, digestId)).toBe(1);
    const fakeFetch = vi.fn<typeof fetch>(async () => {
      const now = new Date().toISOString();
      await baseEnv.DB.prepare(
        `UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = ?, updated_at = ?
         WHERE email = 'inflight@example.org'`,
      ).bind(now, now).run();
      return new Response(JSON.stringify({ id: "accepted-inflight" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const productionEnv = {
      ...baseEnv,
      ENVIRONMENT: "production",
      MEMBER_SCHEMA_RELEASE_READY: "true",
      NEWSLETTER_DELIVERY_ENABLED: "true",
      NEWSLETTER_SUPPRESSION_INGESTION_VERIFIED: "true",
      NEWSLETTER_DOUBLE_OPT_IN_VERIFIED: "true",
      FORWARD_EMAIL_NEWSLETTER_PASSWORD: "alias-password",
    } as Env;
    expect(await processNewsletterJobs(productionEnv, 10, fakeFetch)).toBe(1);
    expect((await baseEnv.DB.prepare(
      "SELECT status, provider_message_id FROM newsletter_deliveries WHERE digest_id = ?",
    ).bind(digestId).first<Record<string, unknown>>())).toMatchObject({
      status: "sent",
      provider_message_id: "accepted-inflight",
    });
  });

  it("keeps production disabled by default and bounds retryable provider failures", async () => {
    await subscribeEmail("retry@example.org");
    await seedEvent("provider-retry");
    const digestId = await generateWeeklyDigest(baseEnv, new Date("2026-08-10T12:00:00.000Z"));
    expect(await fanoutNewsletterDigest(baseEnv, digestId)).toBe(1);
    const fakeFetch = vi.fn<typeof fetch>(async () => new Response("rate limited", { status: 429 }));
    const productionEnv = {
      ...baseEnv,
      ENVIRONMENT: "production",
      MEMBER_SCHEMA_RELEASE_READY: "true",
      NEWSLETTER_DELIVERY_ENABLED: "false",
      NEWSLETTER_SUPPRESSION_INGESTION_VERIFIED: "true",
      NEWSLETTER_DOUBLE_OPT_IN_VERIFIED: "true",
      FORWARD_EMAIL_NEWSLETTER_PASSWORD: "alias-password",
    } as Env;
    expect(await processNewsletterJobs(productionEnv, 10, fakeFetch)).toBe(0);
    expect(fakeFetch).not.toHaveBeenCalled();
    expect((await baseEnv.DB.prepare(
      "SELECT status FROM newsletter_deliveries WHERE digest_id = ?",
    ).bind(digestId).first<{ status: string }>())?.status).toBe("pending");

    (productionEnv as Env & { NEWSLETTER_DELIVERY_ENABLED: string }).NEWSLETTER_DELIVERY_ENABLED = "true";
    expect(await processNewsletterJobs(productionEnv, 10, fakeFetch)).toBe(0);
    let failed = await baseEnv.DB.prepare(
      "SELECT id, status, attempts FROM newsletter_deliveries WHERE digest_id = ?",
    ).bind(digestId).first<{ id: string; status: string; attempts: number }>();
    expect(failed).toMatchObject({ status: "failed", attempts: 1 });
    await baseEnv.DB.prepare(
      `UPDATE newsletter_deliveries
       SET attempts = 4, available_at = '2000-01-01T00:00:00.000Z'
       WHERE id = ?`,
    ).bind(failed!.id).run();
    expect(await processNewsletterJobs(productionEnv, 10, fakeFetch)).toBe(0);
    failed = await baseEnv.DB.prepare(
      "SELECT id, status, attempts FROM newsletter_deliveries WHERE id = ?",
    ).bind(failed!.id).first<{ id: string; status: string; attempts: number }>();
    expect(failed).toMatchObject({ status: "failed", attempts: 5 });
    expect((await baseEnv.DB.prepare(
      "SELECT status FROM newsletter_digests WHERE id = ?",
    ).bind(digestId).first<{ status: string }>())?.status).toBe("failed");
    expect(await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS value FROM events",
    ).first<{ value: number }>()).toEqual({ value: 1 });
  });

  it("recovers attempt-five stale claims, finalizes their digest, and purges only old delivery metadata", async () => {
    await subscribeEmail("retention@example.org");
    await seedEvent("stale-claim");
    const digestId = await generateWeeklyDigest(baseEnv, new Date("2026-08-10T12:00:00.000Z"));
    expect(await fanoutNewsletterDigest(baseEnv, digestId)).toBe(1);
    const subscriber = await baseEnv.DB.prepare(
      "SELECT id FROM subscribers WHERE email = 'retention@example.org'",
    ).first<{ id: string }>();
    await baseEnv.DB.prepare(
      `UPDATE newsletter_deliveries
       SET status = 'processing', attempts = 5, locked_at = '2000-01-01T00:00:00.000Z'
       WHERE digest_id = ?`,
    ).bind(digestId).run();
    expect(await processNewsletterJobs(baseEnv)).toBe(0);
    expect((await baseEnv.DB.prepare(
      "SELECT status, attempts, locked_at FROM newsletter_deliveries WHERE digest_id = ?",
    ).bind(digestId).first<Record<string, unknown>>())).toMatchObject({
      status: "failed",
      attempts: 5,
      locked_at: null,
    });
    expect((await baseEnv.DB.prepare(
      "SELECT status FROM newsletter_digests WHERE id = ?",
    ).bind(digestId).first<{ status: string }>())?.status).toBe("failed");

    const old = "2026-01-01T00:00:00.000Z";
    await baseEnv.DB.batch([
      baseEnv.DB.prepare(
        `UPDATE newsletter_deliveries SET updated_at = ? WHERE digest_id = ?`,
      ).bind(old, digestId),
      baseEnv.DB.prepare(
        `UPDATE newsletter_digests SET updated_at = ? WHERE id = ?`,
      ).bind(old, digestId),
      baseEnv.DB.prepare(
        `INSERT INTO newsletter_suppressions (
           subscriber_id, reason, details, created_at, updated_at
         ) VALUES (?, 'manual', 'Keep consent suppression', ?, ?)`,
      ).bind(subscriber!.id, old, old),
    ]);
    expect(await newsletterMaintenance(baseEnv, new Date("2026-08-10T12:00:00.000Z"))).toBe(2);
    expect((await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS value FROM newsletter_deliveries",
    ).first<{ value: number }>())?.value).toBe(0);
    expect((await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS value FROM newsletter_digests",
    ).first<{ value: number }>())?.value).toBe(0);
    expect((await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS value FROM subscribers",
    ).first<{ value: number }>())?.value).toBe(1);
    expect((await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS value FROM newsletter_suppressions",
    ).first<{ value: number }>())?.value).toBe(1);
  });
});
