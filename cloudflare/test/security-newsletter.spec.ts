import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import worker from "../src/index";
import { processNewsletterConfirmationJobs } from "../src/newsletter";
import type { Env } from "../src/types";

const APP_ORIGIN = "https://servethecays.test";
const baseEnv = env as unknown as Env;

function call(request: Request): Promise<Response> {
  return worker.fetch(request, baseEnv);
}

function subscribeRequest(email: string, ip: string): Request {
  return new Request(`${APP_ORIGIN}/api/newsletter/subscribe`, {
    method: "POST",
    headers: {
      Origin: APP_ORIGIN,
      "Content-Type": "application/json",
      "CF-Connecting-IP": ip,
    },
    body: JSON.stringify({ email }),
  });
}

describe("newsletter consent hardening", () => {
  it("creates consent only after mailbox confirmation and requires a fresh confirmation to reactivate", async () => {
    const initialResponse = await call(subscribeRequest("privacy@example.org", "203.0.113.71"));
    expect(initialResponse.status).toBe(202);
    const genericSuccess = await initialResponse.json();
    expect(genericSuccess).toEqual({
      status: "success",
      message: "Check your email to confirm your subscription.",
    });

    expect((await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS value FROM subscribers WHERE email = ?",
    ).bind("privacy@example.org").first<{ value: number }>())?.value).toBe(0);
    const pending = await baseEnv.DB.prepare(
      `SELECT token_hash, status, capture_json
       FROM newsletter_confirmation_requests WHERE email = ?`,
    ).bind("privacy@example.org").first<Record<string, unknown>>();
    expect(pending).toMatchObject({ status: "pending", capture_json: null });
    expect(String(pending?.token_hash)).toMatch(/^[a-f0-9]{64}$/);

    await processNewsletterConfirmationJobs(baseEnv, 10);
    const sent = await baseEnv.DB.prepare(
      `SELECT status, capture_json FROM newsletter_confirmation_requests WHERE email = ?`,
    ).bind("privacy@example.org").first<{ status: string; capture_json: string }>();
    expect(sent?.status).toBe("sent");
    const capture = JSON.parse(sent!.capture_json) as { text: string; html: string; raw: string };
    const token = capture.text.match(/newsletter\/confirm#token=([A-Za-z0-9_-]+)/)?.[1];
    expect(token).toBeTruthy();
    expect(capture.html).toContain("/static/images/email-logo.5a81761f5371.png");
    expect(capture.html).toContain("@media only screen and (max-width: 520px)");
    expect(capture.html).toContain("a[x-apple-data-detectors]");
    expect(capture.raw).not.toContain("List-Unsubscribe:");

    const confirmationPage = await call(new Request(`${APP_ORIGIN}/newsletter/confirm#token=${token}`));
    const confirmationHtml = await confirmationPage.text();
    expect(confirmationPage.headers.get("Cache-Control")).toBe("no-store");
    expect(confirmationPage.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(confirmationHtml).not.toContain(token);
    const confirmation = await call(new Request(`${APP_ORIGIN}/api/newsletter/confirm`, {
      method: "POST",
      headers: { Origin: APP_ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }));
    expect(confirmation.status).toBe(200);

    const initial = await baseEnv.DB.prepare(
      "SELECT id, status FROM subscribers WHERE email = ?",
    ).bind("privacy@example.org").first<{ id: string; status: string }>();
    expect(initial?.status).toBe("active");

    const beforeActiveRetry = await baseEnv.DB.prepare(
      `SELECT status, consent_at, unsubscribed_at, unsubscribe_token_hash, ip_hash, updated_at
       FROM subscribers WHERE id = ?`,
    ).bind(initial!.id).first<Record<string, unknown>>();
    const activeRetry = await call(subscribeRequest("privacy@example.org", "203.0.113.73"));
    expect(activeRetry.status).toBe(202);
    expect(await activeRetry.json()).toEqual(genericSuccess);
    expect(await baseEnv.DB.prepare(
      `SELECT status, consent_at, unsubscribed_at, unsubscribe_token_hash, ip_hash, updated_at
       FROM subscribers WHERE id = ?`,
    ).bind(initial!.id).first<Record<string, unknown>>()).toEqual(beforeActiveRetry);

    const unsubscribedAt = "2026-08-01T12:00:00.000Z";
    await baseEnv.DB.prepare(
      `UPDATE subscribers
       SET status = 'unsubscribed', unsubscribed_at = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(unsubscribedAt, unsubscribedAt, initial!.id).run();
    const beforeRetry = await baseEnv.DB.prepare(
      `SELECT status, consent_at, unsubscribed_at, unsubscribe_token_hash, ip_hash, updated_at
       FROM subscribers WHERE id = ?`,
    ).bind(initial!.id).first<Record<string, unknown>>();

    const retryResponse = await call(subscribeRequest("privacy@example.org", "203.0.113.72"));
    expect(retryResponse.status).toBe(202);
    expect(await retryResponse.json()).toEqual(genericSuccess);

    const beforeConfirmation = await baseEnv.DB.prepare(
      `SELECT status, consent_at, unsubscribed_at, unsubscribe_token_hash, ip_hash, updated_at
       FROM subscribers WHERE id = ?`,
    ).bind(initial!.id).first<Record<string, unknown>>();
    expect(beforeConfirmation).toEqual(beforeRetry);
    expect(beforeConfirmation).toMatchObject({ status: "unsubscribed", unsubscribed_at: unsubscribedAt });

    await processNewsletterConfirmationJobs(baseEnv, 10);
    const replacement = await baseEnv.DB.prepare(
      "SELECT capture_json FROM newsletter_confirmation_requests WHERE email = ?",
    ).bind("privacy@example.org").first<{ capture_json: string }>();
    const replacementToken = (JSON.parse(replacement!.capture_json) as { text: string }).text
      .match(/newsletter\/confirm#token=([A-Za-z0-9_-]+)/)?.[1];
    const reconfirmed = await call(new Request(`${APP_ORIGIN}/api/newsletter/confirm`, {
      method: "POST",
      headers: { Origin: APP_ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ token: replacementToken }),
    }));
    expect(reconfirmed.status).toBe(200);
    expect((await baseEnv.DB.prepare(
      "SELECT status, unsubscribed_at FROM subscribers WHERE id = ?",
    ).bind(initial!.id).first<Record<string, unknown>>())).toMatchObject({
      status: "active",
      unsubscribed_at: null,
    });
  });

  it("prevents unsubscribe tokens from being sent in referrer headers", async () => {
    const token = "private-unsubscribe-token-1234567890";
    const response = await call(new Request(`${APP_ORIGIN}/unsubscribe/${token}`));

    expect(response.status).toBe(200);
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("identifies the operator and accurately explains privacy choices and retention", async () => {
    const response = await call(new Request(`${APP_ORIGIN}/privacy`));
    const page = await response.text();

    expect(response.status).toBe(200);
    expect(page).toContain('operated by <a href="https://caynetic.ltd"');
    expect(page).toContain("Cloudflare processes IP addresses, browser and request signals");
    expect(page).toContain("Separate keyed submission fingerprints help prevent duplicate suggestions");
    expect(page).toContain("We record consent time and activate the address only after you confirm control of it");
    expect(page).toContain("keep only bounded delivery evidence rather than the raw provider payload");
    expect(page).toContain("do not blindly resend a message when provider acceptance is uncertain");
    expect(page).not.toContain("fonts.googleapis.com");
    expect(page).not.toContain("Google Fonts");
    expect(page).toContain("personal information described above may be processed outside The Bahamas");
    expect(page).toContain("approved and denied original images are scheduled for removal after 30 days");
    expect(page).toContain(
      "proposed public email and phone values, staged repeatable organization contacts, and staged profile sections are removed or anonymized after 90 days",
    );
    expect(page).toContain(
      "Approved public listings, sanitized image derivatives, and moderation or security evidence may remain",
    );
    expect(page).toContain("suppression record so the address is not accidentally reactivated");
    expect(page).toContain("Newsletter confirmation links expire after 24 hours");
    expect(page).toContain("request access to it");
    expect(page).toContain("Office of the Data Protection Commissioner of The Bahamas");
  });
});
