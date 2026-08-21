import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import worker from "../src/index";
import { sha256Hex } from "../src/security";
import type { Env } from "../src/types";

const APP_ORIGIN = "https://servethecays.test";
const baseEnv = env as unknown as Env;

function call(request: Request): Promise<Response> {
  return worker.fetch(request, baseEnv);
}

function jsonRequest(
  path: string,
  method: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${APP_ORIGIN}${path}`, {
    method,
    headers: {
      Origin: APP_ORIGIN,
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.230",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function tokenFromPreview(value: string): string {
  return new URL(value).hash.replace(/^#token=/, "");
}

async function seedSubscriber(
  email: string,
  customizeToken: string,
  status: "active" | "unsubscribed" = "active",
): Promise<void> {
  const now = new Date().toISOString();
  await baseEnv.DB.prepare(
    `INSERT INTO subscribers (
       id, email, status, consent_at, unsubscribed_at,
       unsubscribe_token_hash, customize_token_hash, personalization_enabled,
       ip_hash, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, '', ?, ?)`,
  ).bind(
    `subscriber_${await sha256Hex(email).then((value) => value.slice(0, 16))}`,
    email,
    status,
    now,
    status === "unsubscribed" ? now : null,
    await sha256Hex(`unsubscribe:${email}`),
    await sha256Hex(customizeToken),
    now,
    now,
  ).run();
}

async function consumePreview(previewUrl: string): Promise<{
  cookie: string;
  csrf: string;
  memberId: string;
}> {
  const response = await call(jsonRequest("/api/member/auth/consume", "POST", {
    token: tokenFromPreview(previewUrl),
  }));
  expect(response.status).toBe(200);
  const payload = await response.json<Record<string, any>>();
  return {
    cookie: response.headers.get("Set-Cookie")!.split(";")[0],
    csrf: String(payload.csrf_token),
    memberId: String(payload.member.id),
  };
}

function memberRequest(
  path: string,
  method: string,
  auth: { cookie: string; csrf: string },
  body?: Record<string, unknown>,
): Request {
  return new Request(`${APP_ORIGIN}${path}`, {
    method,
    headers: {
      Origin: APP_ORIGIN,
      Cookie: auth.cookie,
      "X-CSRF-Token": auth.csrf,
      "CF-Connecting-IP": "203.0.113.231",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

describe("newsletter and member separation", () => {
  it("uses an opaque newsletter selector to send a fresh magic link and attaches active consent", async () => {
    const email = "updates-member@example.org";
    const customizeToken = "newsletter-customize-token-1234567890abcdef";
    await seedSubscriber(email, customizeToken);

    const requested = await call(jsonRequest("/api/member/auth/request", "POST", {
      subscriber_token: customizeToken,
      return_path: "/me",
    }));
    expect(requested.status).toBe(200);
    const requestBody = await requested.json<Record<string, any>>();
    expect(requestBody.message).toMatch(/sign-in link/i);
    expect(JSON.stringify(requestBody)).not.toContain(email);
    expect(requestBody.development_sign_in_url).toContain("/signin/verify#token=");
    expect(await baseEnv.DB.prepare(
      "SELECT email FROM member_magic_links WHERE consumed_at IS NULL",
    ).first<{ email: string }>()).toMatchObject({ email });

    const auth = await consumePreview(String(requestBody.development_sign_in_url));
    expect(await baseEnv.DB.prepare(
      "SELECT member_id, status FROM subscribers WHERE email = ?",
    ).bind(email).first<Record<string, unknown>>()).toMatchObject({
      member_id: auth.memberId,
      status: "active",
    });

    const dashboard = await call(new Request(`${APP_ORIGIN}/api/member/dashboard`, {
      headers: { Cookie: auth.cookie },
    }));
    expect(await dashboard.json()).toMatchObject({
      notification_settings: {
        newsletter_status: "active",
        newsletter_subscribed: true,
        personalized_updates_enabled: false,
      },
    });

    const profile = await call(memberRequest("/api/member/profile", "PATCH", auth, {
      personalized_updates_enabled: true,
    }));
    expect(await profile.json()).toMatchObject({
      notification_settings: {
        newsletter_subscribed: true,
        personalized_updates_enabled: true,
      },
    });
    expect(await baseEnv.DB.prepare(
      "SELECT personalization_enabled FROM subscribers WHERE email = ?",
    ).bind(email).first<{ personalization_enabled: number }>()).toMatchObject({
      personalization_enabled: 1,
    });

    const deleted = await call(memberRequest("/api/member/account", "DELETE", auth));
    expect(deleted.status).toBe(200);
    expect(await baseEnv.DB.prepare(
      "SELECT status, member_id, personalization_enabled FROM subscribers WHERE email = ?",
    ).bind(email).first<Record<string, unknown>>()).toMatchObject({
      status: "active",
      member_id: null,
      personalization_enabled: 0,
    });
  });

  it("never resolves, attaches, reactivates, or updates an unsubscribed newsletter record", async () => {
    const email = "opted-out@example.org";
    const customizeToken = "unsubscribed-customize-token-1234567890abc";
    await seedSubscriber(email, customizeToken, "unsubscribed");

    const opaqueRequest = await call(jsonRequest("/api/member/auth/request", "POST", {
      subscriber_token: customizeToken,
    }, { "CF-Connecting-IP": "203.0.113.232" }));
    expect(opaqueRequest.status).toBe(200);
    expect(await opaqueRequest.json()).toEqual({
      status: "success",
      message: "If that address can receive mail, a sign-in link is on its way.",
    });
    expect((await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM member_magic_links",
    ).first<{ count: number }>())?.count).toBe(0);

    const typedRequest = await call(jsonRequest("/api/member/auth/request", "POST", {
      email,
      return_path: "/me",
    }, { "CF-Connecting-IP": "203.0.113.233" }));
    const typedBody = await typedRequest.json<Record<string, any>>();
    const auth = await consumePreview(String(typedBody.development_sign_in_url));
    expect(await baseEnv.DB.prepare(
      "SELECT status, member_id FROM subscribers WHERE email = ?",
    ).bind(email).first<Record<string, unknown>>()).toMatchObject({
      status: "unsubscribed",
      member_id: null,
    });

    const dashboard = await call(new Request(`${APP_ORIGIN}/api/member/dashboard`, {
      headers: { Cookie: auth.cookie },
    }));
    expect(await dashboard.json()).toMatchObject({
      notification_settings: {
        newsletter_status: "unsubscribed",
        newsletter_subscribed: false,
        personalized_updates_enabled: false,
      },
    });

    const profile = await call(memberRequest("/api/member/profile", "PATCH", auth, {
      display_name: "Still Opted Out",
      reminder_emails_enabled: false,
      personalized_updates_enabled: true,
    }));
    expect(profile.status).toBe(200);
    expect(await baseEnv.DB.prepare(
      "SELECT status, member_id, personalization_enabled FROM subscribers WHERE email = ?",
    ).bind(email).first<Record<string, unknown>>()).toMatchObject({
      status: "unsubscribed",
      member_id: null,
      personalization_enabled: 0,
    });
  });

  it("discloses the separate newsletter processor and consent lifecycle", async () => {
    const [dashboard, privacy, client] = await Promise.all([
      call(new Request(`${APP_ORIGIN}/me`)),
      call(new Request(`${APP_ORIGIN}/privacy`)),
      call(new Request(`${APP_ORIGIN}/assets/app.js`)),
    ]);
    const dashboardHtml = await dashboard.text();
    const privacyHtml = await privacy.text();
    const clientScript = await client.text();
    expect(dashboardHtml).toContain('name="personalized_updates_enabled"');
    expect(dashboardHtml).toContain("account deletion does not unsubscribe community updates");
    expect(privacyHtml).toContain("Cloudflare for application hosting");
    expect(privacyHtml).toContain("delivery of requested sign-in and account messages plus RSVP and suggestion notifications");
    expect(privacyHtml).toContain("Forward Email");
    expect(privacyHtml).toContain("separately for newsletter confirmations and general or personalized community updates");
    expect(privacyHtml).not.toContain("Forward Email</a> to deliver requested sign-in and account messages");
    expect(privacyHtml).toContain("Newsletter consent is separate from a member account");
    expect(privacyHtml).toContain("Deleting a member account disconnects the newsletter record and returns future updates to the general version, but does not unsubscribe it");
    expect(clientScript).toContain('get("subscriber")');
    expect(clientScript).toContain("subscriber_token: memberSubscriberToken");
    expect(clientScript).toContain("window.history.replaceState");
  });
});
