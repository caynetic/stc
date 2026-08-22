import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import {
  processNewsletterJobs,
  reconcileNewsletterDeliveries,
} from "../src/newsletter";
import { hmacSha256Hex, sha256Hex } from "../src/security";
import type { Env } from "../src/types";

const APP_ORIGIN = "https://servethecays.test";
const WEBHOOK_SECRET = "test-forward-email-webhook-secret-at-least-32-bytes";
const baseEnv = env as unknown as Env;
let deliverySequence = 0;

async function seedSubscriber(email: string, id = `subscriber_${crypto.randomUUID()}`): Promise<string> {
  const now = new Date().toISOString();
  await baseEnv.DB.prepare(
    `INSERT INTO subscribers (
       id, email, status, consent_at, unsubscribe_token_hash, ip_hash,
       personalization_enabled, created_at, updated_at
     ) VALUES (?, ?, 'active', ?, ?, '', 0, ?, ?)`,
  ).bind(id, email, now, await sha256Hex(`unsubscribe-${id}`), now, now).run();
  return id;
}

async function seedDelivery(
  email: string,
  providerMessageId: string | null,
  status: "pending" | "sent" = "sent",
): Promise<{ id: string; digestId: string }> {
  const subscriberId = await seedSubscriber(email);
  const now = new Date().toISOString();
  const windowStart = new Date(Date.UTC(2026, 0, 1 + deliverySequence++ * 8)).toISOString();
  const windowEnd = new Date(new Date(windowStart).getTime() + 7 * 24 * 60 * 60 * 1_000).toISOString();
  const deliveryId = `delivery_${crypto.randomUUID().replace(/-/g, "")}`;
  const digestId = `digest_${crypto.randomUUID().replace(/-/g, "")}`;
  await baseEnv.DB.batch([
    baseEnv.DB.prepare(
      `INSERT INTO newsletter_digests (
         id, window_start, window_end, event_ids_json, status,
         fanout_cursor, fanout_completed_at, created_at, updated_at
       ) VALUES (?, ?, ?, '[]', 'delivering', '', ?, ?, ?)`,
    ).bind(digestId, windowStart, windowEnd, now, now, now),
    baseEnv.DB.prepare(
      `INSERT INTO newsletter_deliveries (
         id, digest_id, subscriber_id, recipient_email, mode, status,
         attempts, available_at, locked_at, sent_at, provider,
         provider_message_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'general', ?, 0, ?, NULL, ?, 'forward_email', ?, ?, ?)`,
    ).bind(
      deliveryId,
      digestId,
      subscriberId,
      email,
      status,
      now,
      status === "sent" ? now : null,
      providerMessageId,
      now,
      now,
    ),
  ]);
  return { id: deliveryId, digestId };
}

async function signedWebhook(payload: Record<string, unknown>, signature = "valid"): Promise<Response> {
  const body = JSON.stringify(payload);
  const calculated = await hmacSha256Hex(WEBHOOK_SECRET, body);
  return worker.fetch(new Request(`${APP_ORIGIN}/api/email/forward-email/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Webhook-Signature": signature === "valid" ? calculated : "0".repeat(64),
    },
    body,
  }), { ...baseEnv, FORWARD_EMAIL_WEBHOOK_SECRET: WEBHOOK_SECRET });
}

describe("newsletter provider event integrity", () => {
  it("rejects unsigned and forged events before parsing or changing suppression state", async () => {
    const unsigned = await worker.fetch(new Request(`${APP_ORIGIN}/api/email/forward-email/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    }), { ...baseEnv, FORWARD_EMAIL_WEBHOOK_SECRET: WEBHOOK_SECRET });
    expect(unsigned.status).toBe(401);

    const forged = await signedWebhook({ recipient: "victim@example.org" }, "forged");
    expect(forged.status).toBe(401);
    expect((await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS value FROM newsletter_provider_events",
    ).first<{ value: number }>())?.value).toBe(0);
    expect((await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS value FROM newsletter_suppressions",
    ).first<{ value: number }>())?.value).toBe(0);
  });

  it("idempotently suppresses documented hard bounces and only records soft bounces", async () => {
    const hard = await seedDelivery("hard-bounce@example.org", "provider-hard");
    const hardPayload = {
      email_id: "provider-hard",
      recipient: "hard-bounce@example.org",
      message: "Mailbox does not exist",
      response: "550 5.1.1 No such user",
      response_code: 550,
      bounce: { category: "recipient", action: "reject", code: 550 },
      headers: { "X-Entity-Ref-ID": hard.id },
      bounced_at: "2026-08-14T12:00:00.000Z",
    };
    expect((await signedWebhook(hardPayload)).status).toBe(200);
    expect((await signedWebhook(hardPayload)).status).toBe(200);
    expect((await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS value FROM newsletter_provider_events",
    ).first<{ value: number }>())?.value).toBe(1);
    expect(await baseEnv.DB.prepare(
      `SELECT suppression.reason, delivery.status
       FROM newsletter_suppressions suppression
       JOIN subscribers subscriber ON subscriber.id = suppression.subscriber_id
       JOIN newsletter_deliveries delivery ON delivery.subscriber_id = subscriber.id
       WHERE subscriber.email = 'hard-bounce@example.org'`,
    ).first<Record<string, unknown>>()).toMatchObject({
      reason: "invalid_recipient",
      status: "failed",
    });

    await seedDelivery("soft-bounce@example.org", "provider-soft");
    expect((await signedWebhook({
      email_id: "provider-soft",
      recipient: "soft-bounce@example.org",
      response: "552 5.2.2 Mailbox full",
      response_code: 552,
      bounce: { category: "capacity", code: 552 },
    })).status).toBe(200);
    expect((await baseEnv.DB.prepare(
      `SELECT COUNT(*) AS value FROM newsletter_suppressions suppression
       JOIN subscribers subscriber ON subscriber.id = suppression.subscriber_id
       WHERE subscriber.email = 'soft-bounce@example.org'`,
    ).first<{ value: number }>())?.value).toBe(0);
    expect(await baseEnv.DB.prepare(
      "SELECT action, category FROM newsletter_provider_events WHERE provider_message_id = 'provider-soft'",
    ).first<Record<string, unknown>>()).toMatchObject({ action: "recorded", category: "capacity" });

    const envelope = await seedDelivery("hard-envelope@example.org", "provider-envelope");
    expect((await signedWebhook({
      email_id: "provider-envelope",
      recipient: "hard-envelope@example.org",
      response: "550 5.1.1 Alias disabled",
      response_code: 550,
      bounce: { category: "envelope", action: "reject", code: 550 },
      headers: { "X-Entity-Ref-ID": envelope.id },
    })).status).toBe(200);
    expect(await baseEnv.DB.prepare(
      `SELECT suppression.reason, delivery.status
       FROM newsletter_suppressions suppression
       JOIN subscribers subscriber ON subscriber.id = suppression.subscriber_id
       JOIN newsletter_deliveries delivery ON delivery.subscriber_id = subscriber.id
       WHERE subscriber.email = 'hard-envelope@example.org'`,
    ).first<Record<string, unknown>>()).toMatchObject({
      reason: "bounce",
      status: "failed",
    });
  });

  it("acknowledges signed account-wide events without retaining unrelated messages", async () => {
    const unrelatedRecipient = await signedWebhook({
      email_id: "provider-unrelated",
      recipient: "unrelated@example.org",
      response: "421 4.4.2 Network connection timed out",
      response_code: 421,
      bounce: { category: "network", code: 421 },
    });
    expect(unrelatedRecipient.status).toBe(200);

    await seedDelivery("shared-recipient@example.org", "provider-stc-message");
    const unrelatedMessage = await signedWebhook({
      email_id: "provider-other-caynetic-message",
      recipient: "shared-recipient@example.org",
      response: "421 4.4.2 Network connection timed out",
      response_code: 421,
      bounce: { category: "network", code: 421 },
    });
    expect(unrelatedMessage.status).toBe(200);
    expect((await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS value FROM newsletter_provider_events",
    ).first<{ value: number }>())?.value).toBe(0);
    expect((await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS value FROM newsletter_suppressions",
    ).first<{ value: number }>())?.value).toBe(0);
  });
});

describe("newsletter uncertain delivery reconciliation", () => {
  it("holds an ambiguous send, reads it back from the provider, and never sends it twice", async () => {
    const subscriberId = await seedSubscriber("uncertain@example.org", "subscriber_uncertain");
    const now = new Date();
    const publishedAt = new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString();
    const startAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000).toISOString();
    const event = await baseEnv.DB.prepare(
      `INSERT INTO events (
         slug, name, description, start_at, timezone, venue_name,
         location_display, is_active, published_at, updated_at
       ) VALUES ('uncertain-event', 'Uncertain Event', 'A delivery test.', ?,
                 'America/Nassau', 'Community Centre', 'Nassau', 1, ?, ?)
       RETURNING id`,
    ).bind(startAt, publishedAt, publishedAt).first<{ id: number }>();
    const digestId = "digest_uncertain";
    const deliveryId = "delivery_uncertain";
    const nowIso = now.toISOString();
    await baseEnv.DB.batch([
      baseEnv.DB.prepare(
        `INSERT INTO newsletter_digests (
           id, window_start, window_end, event_ids_json, status,
           fanout_cursor, fanout_completed_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'delivering', '', ?, ?, ?)`,
      ).bind(
        digestId,
        new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000).toISOString(),
        nowIso,
        JSON.stringify([event!.id]),
        nowIso,
        nowIso,
        nowIso,
      ),
      baseEnv.DB.prepare(
        `INSERT INTO newsletter_deliveries (
           id, digest_id, subscriber_id, recipient_email, mode, status,
           attempts, available_at, provider, created_at, updated_at
         ) VALUES (?, ?, ?, 'uncertain@example.org', 'general', 'pending',
                   0, ?, '', ?, ?)`,
      ).bind(deliveryId, digestId, subscriberId, nowIso, nowIso, nowIso),
    ]);

    const productionEnv = {
      ...baseEnv,
      ENVIRONMENT: "production",
      MEMBER_SCHEMA_RELEASE_READY: "true",
      NEWSLETTER_DELIVERY_ENABLED: "true",
      NEWSLETTER_SUPPRESSION_INGESTION_VERIFIED: "true",
      NEWSLETTER_DOUBLE_OPT_IN_VERIFIED: "true",
      EMAIL_DELIVERY_RECONCILIATION_VERIFIED: "true",
      FORWARD_EMAIL_NEWSLETTER_PASSWORD: "newsletter-alias-password",
      FORWARD_EMAIL_API_TOKEN: "forward-email-api-token",
    } as Env;
    const uncertainSend = vi.fn<typeof fetch>(async () => {
      throw new Error("connection reset after request upload");
    });
    expect(await processNewsletterJobs(productionEnv, 10, uncertainSend)).toBe(0);
    expect(await baseEnv.DB.prepare(
      `SELECT status, attempts, reconciliation_status, reconciliation_attempts,
              provider_message_id, locked_at
       FROM newsletter_deliveries WHERE id = ?`,
    ).bind(deliveryId).first<Record<string, unknown>>()).toMatchObject({
      status: "processing",
      attempts: 1,
      reconciliation_status: "pending",
      reconciliation_attempts: 0,
      provider_message_id: null,
      locked_at: null,
    });
    await baseEnv.DB.prepare(
      "UPDATE newsletter_deliveries SET reconcile_after = '2000-01-01T00:00:00.000Z' WHERE id = ?",
    ).bind(deliveryId).run();

    const readback = vi.fn<typeof fetch>(async (input) => {
      expect(String(input)).toContain("https://api.forwardemail.net/v1/emails?q=delivery_uncertain");
      return new Response(JSON.stringify([{ _id: "provider-confirmed", status: "queued", reference: deliveryId }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    expect(await reconcileNewsletterDeliveries(productionEnv, 10, readback)).toBe(1);
    expect(await baseEnv.DB.prepare(
      `SELECT status, provider_message_id, reconciliation_status,
              reconciliation_attempts, reconcile_after, last_error
       FROM newsletter_deliveries WHERE id = ?`,
    ).bind(deliveryId).first<Record<string, unknown>>()).toMatchObject({
      status: "sent",
      provider_message_id: "provider-confirmed",
      reconciliation_status: "resolved",
      reconciliation_attempts: 1,
      reconcile_after: null,
      last_error: "",
    });
    expect(await processNewsletterJobs(productionEnv, 10, uncertainSend)).toBe(0);
    expect(uncertainSend).toHaveBeenCalledTimes(1);
  });

  it("escalates repeated not-found readbacks for manual review without resending", async () => {
    const delivery = await seedDelivery("manual-review@example.org", null, "pending");
    await baseEnv.DB.prepare(
      `UPDATE newsletter_deliveries
       SET status = 'processing', attempts = 1, reconciliation_status = 'pending',
           reconciliation_attempts = 4, reconcile_after = '2000-01-01T00:00:00.000Z'
       WHERE id = ?`,
    ).bind(delivery.id).run();
    const productionEnv = {
      ...baseEnv,
      ENVIRONMENT: "production",
      MEMBER_SCHEMA_RELEASE_READY: "true",
      EMAIL_DELIVERY_RECONCILIATION_VERIFIED: "true",
      FORWARD_EMAIL_API_TOKEN: "forward-email-api-token",
    } as Env;
    const notFound = vi.fn<typeof fetch>(async () => new Response(JSON.stringify([]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    expect(await reconcileNewsletterDeliveries(productionEnv, 10, notFound)).toBe(1);
    expect(await baseEnv.DB.prepare(
      `SELECT status, reconciliation_status, reconciliation_attempts, reconcile_after
       FROM newsletter_deliveries WHERE id = ?`,
    ).bind(delivery.id).first<Record<string, unknown>>()).toMatchObject({
      status: "processing",
      reconciliation_status: "manual_review",
      reconciliation_attempts: 5,
      reconcile_after: null,
    });
  });

  it("marks a provider-reported terminal bounce failed without resending", async () => {
    const delivery = await seedDelivery("reconciled-bounce@example.org", "provider-bounced", "pending");
    await baseEnv.DB.prepare(
      `UPDATE newsletter_deliveries
       SET status = 'processing', attempts = 1, reconciliation_status = 'pending',
           reconciliation_attempts = 0, reconcile_after = '2000-01-01T00:00:00.000Z'
       WHERE id = ?`,
    ).bind(delivery.id).run();
    const productionEnv = {
      ...baseEnv,
      ENVIRONMENT: "production",
      MEMBER_SCHEMA_RELEASE_READY: "true",
      EMAIL_DELIVERY_RECONCILIATION_VERIFIED: "true",
      FORWARD_EMAIL_API_TOKEN: "forward-email-api-token",
    } as Env;
    const readback = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      _id: "provider-bounced",
      status: "bounced",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    expect(await reconcileNewsletterDeliveries(productionEnv, 10, readback)).toBe(1);
    expect(await baseEnv.DB.prepare(
      `SELECT status, attempts, reconciliation_status, reconcile_after, last_error
       FROM newsletter_deliveries WHERE id = ?`,
    ).bind(delivery.id).first<Record<string, unknown>>()).toMatchObject({
      status: "failed",
      attempts: 5,
      reconciliation_status: "resolved",
      reconcile_after: null,
      last_error: "Provider status readback reported bounced.",
    });
  });
});
