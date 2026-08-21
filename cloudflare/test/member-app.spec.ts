import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { memberMaintenance, processEmailJobs, queueEmail } from "../src/email";
import worker from "../src/index";
import { constantTimeEqual } from "../src/security";
import type { Env } from "../src/types";

const APP_ORIGIN = "https://servethecays.test";
const baseEnv = env as unknown as Env;

afterEach(() => {
  vi.restoreAllMocks();
});

function call(request: Request, overrides: Partial<Env> = {}): Promise<Response> {
  return worker.fetch(request, { ...baseEnv, ...overrides });
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
      "CF-Connecting-IP": headers["CF-Connecting-IP"] || "203.0.113.180",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function tokenFromPreview(value: string): string {
  return new URL(value).hash.replace(/^#token=/, "");
}

async function requestLink(
  email: string,
  options: Record<string, unknown> = {},
  ip = "203.0.113.180",
  overrides: Partial<Env> = {},
): Promise<{ response: Response; body: Record<string, any>; token: string }> {
  const response = await call(jsonRequest("/api/member/auth/request", "POST", {
    email,
    return_path: "/me",
    ...options,
  }, { "CF-Connecting-IP": ip }), overrides);
  const body = await response.json<Record<string, any>>();
  const preview = String(body.development_sign_in_url || "");
  return { response, body, token: preview ? tokenFromPreview(preview) : "" };
}

async function signIn(
  email: string,
  options: Record<string, unknown> = {},
  ip = "203.0.113.180",
): Promise<{ cookie: string; csrf: string; memberId: string; token: string }> {
  const requested = await requestLink(email, options, ip);
  expect(requested.response.status).toBe(200);
  expect(requested.token).toMatch(/^[A-Za-z0-9_-]{40,100}$/);
  const consumed = await call(jsonRequest(
    "/api/member/auth/consume",
    "POST",
    { token: requested.token },
    { "CF-Connecting-IP": ip },
  ));
  expect(consumed.status).toBe(200);
  const payload = await consumed.json<Record<string, any>>();
  return {
    cookie: consumed.headers.get("Set-Cookie")!.split(";")[0],
    csrf: String(payload.csrf_token),
    memberId: String(payload.member.id),
    token: requested.token,
  };
}

function memberRequest(
  path: string,
  method: string,
  auth: { cookie: string; csrf: string },
  body?: Record<string, unknown>,
): Request {
  const headers: Record<string, string> = {
    Origin: APP_ORIGIN,
    Cookie: auth.cookie,
    "X-CSRF-Token": auth.csrf,
    "CF-Connecting-IP": "203.0.113.181",
  };
  if (body) headers["Content-Type"] = "application/json";
  return new Request(`${APP_ORIGIN}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function seedOrganization(id: string, name: string, active = true): Promise<void> {
  const now = new Date().toISOString();
  await baseEnv.DB.prepare(
    `INSERT INTO organizations (
       id, slug, name, description, is_active, published_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    id,
    name,
    `${name} provides volunteer and community-service opportunities in The Bahamas.`,
    active ? 1 : 0,
    now,
    now,
  ).run();
}

async function seedEvent(id: number, offsetHours = 48, active = true): Promise<void> {
  const now = new Date();
  const start = new Date(now.getTime() + offsetHours * 60 * 60 * 1_000).toISOString();
  const end = new Date(now.getTime() + (offsetHours + 2) * 60 * 60 * 1_000).toISOString();
  await baseEnv.DB.prepare(
    `INSERT INTO events (
       id, slug, name, description, details, start_at, end_at, timezone,
       venue_name, location_display, is_active, published_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'America/Nassau', ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    `member-event-${id}`,
    `Member Event ${id}`,
    "A member application event for local integration and privacy verification.",
    "Bring water and confirm details on the event page.",
    start,
    end,
    "Community Hall",
    "Nassau, New Providence",
    active ? 1 : 0,
    now.toISOString(),
    now.toISOString(),
  ).run();
}

function memberOrganizationSubmission(
  name: string,
  overrides: Record<string, string> = {},
): FormData {
  const form = new FormData();
  const fields = {
    name,
    description: "A member-owned organization suggestion for local application verification.",
    details: "Community programs and volunteer opportunities.",
    website: "https://example.org/member-suggestion",
    submitter_phone: "",
    public_email: "public-owned-submission@example.org",
    location_ids: "loc_nassau",
    category_ids: "cat_youth",
    ...overrides,
  };
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}

function memberOrganizationRequest(
  auth: { cookie: string; csrf: string },
  form: FormData,
  options: {
    csrf?: string | null;
    idempotencyKey?: string;
    ip?: string;
    origin?: string;
  } = {},
): Request {
  const headers: Record<string, string> = {
    Origin: options.origin || APP_ORIGIN,
    Cookie: auth.cookie,
    "CF-Connecting-IP": options.ip || "203.0.113.203",
  };
  const csrf = options.csrf === undefined ? auth.csrf : options.csrf;
  if (csrf !== null) headers["X-CSRF-Token"] = csrf;
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
  return new Request(`${APP_ORIGIN}/api/submissions/organizations`, {
    method: "POST",
    headers,
    body: form,
  });
}

function memberEventSubmission(name: string, overrides: Record<string, string> = {}): FormData {
  const form = new FormData();
  const fields = {
    name,
    description: "A member-owned community event suggestion for private review.",
    details: "Bring water and comfortable shoes.",
    start_at: "2026-12-05T14:00:00.000Z",
    end_at: "2026-12-05T18:00:00.000Z",
    venue_name: "Nassau Community Centre",
    location_id: "loc_nassau",
    website: "https://example.org/member-event",
    public_email: "events@example.org",
    ...overrides,
  };
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}

function memberEventRequest(
  auth: { cookie: string; csrf: string },
  form: FormData,
  options: {
    csrf?: string | null;
    idempotencyKey?: string;
    ip?: string;
    origin?: string;
  } = {},
): Request {
  const headers: Record<string, string> = {
    Origin: options.origin || APP_ORIGIN,
    Cookie: auth.cookie,
    "CF-Connecting-IP": options.ip || "203.0.113.204",
  };
  const csrf = options.csrf === undefined ? auth.csrf : options.csrf;
  if (csrf !== null) headers["X-CSRF-Token"] = csrf;
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
  return new Request(`${APP_ORIGIN}/api/submissions/events`, {
    method: "POST",
    headers,
    body: form,
  });
}

async function rateLimitAttemptTotal(): Promise<number> {
  const row = await baseEnv.DB.prepare(
    "SELECT COALESCE(SUM(count), 0) AS total FROM rate_limits",
  ).first<{ total: number }>();
  return Number(row?.total ?? 0);
}

describe("passwordless member authentication", () => {
  it("compares authentication values safely for equal and unequal lengths", () => {
    expect(constantTimeEqual("fixed-length-value", "fixed-length-value")).toBe(true);
    expect(constantTimeEqual("fixed-length-value", "fixed-length-other")).toBe(false);
    expect(constantTimeEqual("short", "a-longer-value")).toBe(false);
  });

  it("reports a signed-out public session without an error response", async () => {
    const response = await call(new Request(`${APP_ORIGIN}/api/member/session`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authenticated: false });
  });

  it("creates a member only after explicit consume, stores only the token hash, and rejects replay", async () => {
    const requested = await requestLink("First.Member@example.org");
    expect(requested.response.status).toBe(200);
    expect(requested.body.message).toMatch(/sign-in link/i);
    expect(requested.body.development_sign_in_url).toContain("/signin/verify#token=");
    expect(await baseEnv.DB.prepare("SELECT COUNT(*) AS count FROM members").first<{ count: number }>())
      .toMatchObject({ count: 0 });
    const link = await baseEnv.DB.prepare(
      "SELECT token_hash, consumed_at FROM member_magic_links",
    ).first<{ token_hash: string; consumed_at: string | null }>();
    expect(link?.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(link?.token_hash).not.toContain(requested.token);
    expect(link?.consumed_at).toBeNull();

    const verifyPage = await call(new Request(`${APP_ORIGIN}/signin/verify`));
    expect(verifyPage.status).toBe(200);
    expect(await verifyPage.text()).toMatch(/opening this page does not use the link/i);
    expect((await baseEnv.DB.prepare("SELECT consumed_at FROM member_magic_links").first<{ consumed_at: string | null }>())?.consumed_at).toBeNull();

    const consumed = await call(jsonRequest("/api/member/auth/consume", "POST", { token: requested.token }));
    expect(consumed.status).toBe(200);
    expect(consumed.headers.get("Set-Cookie")).toMatch(/stc_member_session=.*HttpOnly; SameSite=Lax/);
    expect(await baseEnv.DB.prepare("SELECT email FROM members").first<{ email: string }>())
      .toMatchObject({ email: "first.member@example.org" });
    expect((await call(jsonRequest("/api/member/auth/consume", "POST", { token: requested.token }))).status).toBe(400);
  });

  it("allows only one concurrent consumer for a magic link", async () => {
    const requested = await requestLink("concurrent-consume@example.org", {}, "203.0.113.214");
    const responses = await Promise.all([
      call(jsonRequest(
        "/api/member/auth/consume",
        "POST",
        { token: requested.token },
        { "CF-Connecting-IP": "203.0.113.215" },
      )),
      call(jsonRequest(
        "/api/member/auth/consume",
        "POST",
        { token: requested.token },
        { "CF-Connecting-IP": "203.0.113.216" },
      )),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    expect((await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM members WHERE email = 'concurrent-consume@example.org'",
    ).first<{ count: number }>())?.count).toBe(1);
    expect((await baseEnv.DB.prepare(
      `SELECT COUNT(*) AS count FROM member_sessions s
       JOIN members m ON m.id = s.member_id
       WHERE m.email = 'concurrent-consume@example.org'`,
    ).first<{ count: number }>())?.count).toBe(1);
  });

  it("uses a Secure __Host- cookie for production member sessions", async () => {
    const requested = await requestLink("production-cookie@example.org", {}, "203.0.113.217");
    const consumed = await call(jsonRequest(
      "/api/member/auth/consume",
      "POST",
      { token: requested.token },
      { "CF-Connecting-IP": "203.0.113.218" },
    ), {
      ENVIRONMENT: "production",
      MEMBER_APPLICATION_ENABLED: "true",
      MEMBER_SCHEMA_RELEASE_READY: "true",
      ADMIN_STEP_UP_VERIFIED: "true",
      TRANSACTIONAL_EMAIL_DELIVERY_ENABLED: "true",
      EMAIL_DELIVERY_RECONCILIATION_VERIFIED: "true",
    });
    expect(consumed.status).toBe(200);
    const cookie = consumed.headers.get("Set-Cookie") ?? "";
    expect(cookie).toMatch(/^__Host-stc_member_session=/);
    expect(cookie).toContain("; Path=/;");
    expect(cookie).toContain("; Secure");
    expect(cookie).toContain("; HttpOnly;");
    expect(cookie).not.toMatch(/;\s*Domain=/i);
  });

  it("uses a generic request response, restricts return paths, and rate-limits keyed identities", async () => {
    const invalid = await requestLink("not-an-email", {}, "203.0.113.182");
    const valid = await requestLink("generic@example.org", {}, "203.0.113.183");
    expect(invalid.response.status).toBe(200);
    expect(invalid.body.message).toBe(valid.body.message);

    const unsafe = await requestLink("return@example.org", {
      return_path: "https://evil.example/steal",
      intent_type: "rsvp_event",
      target_id: "not-a-number",
    }, "203.0.113.184");
    const consumed = await call(jsonRequest("/api/member/auth/consume", "POST", { token: unsafe.token }));
    expect((await consumed.json<{ redirect_to: string }>()).redirect_to).toBe("/me");

    const overrides = { MEMBER_LOGIN_EMAIL_LIMIT: "1" };
    expect((await requestLink("limited@example.org", {}, "203.0.113.185", overrides)).response.status).toBe(200);
    expect((await requestLink("limited@example.org", {}, "203.0.113.186", overrides)).response.status).toBe(429);
  });

  it("supports returning sign-in, logout, idle expiry, and CSRF protection", async () => {
    const first = await signIn("returning@example.org", {}, "203.0.113.187");
    const second = await signIn("returning@example.org", {}, "203.0.113.188");
    expect(second.memberId).toBe(first.memberId);
    expect((await baseEnv.DB.prepare("SELECT COUNT(*) AS count FROM members").first<{ count: number }>())?.count).toBe(1);

    const firstSessionRead = await call(new Request(`${APP_ORIGIN}/api/member/session`, {
      headers: { Cookie: first.cookie },
    }));
    const secondSessionRead = await call(new Request(`${APP_ORIGIN}/api/member/session`, {
      headers: { Cookie: first.cookie },
    }));
    const firstSessionPayload = await firstSessionRead.json<{ csrf_token: string }>();
    const secondSessionPayload = await secondSessionRead.json<{ csrf_token: string }>();
    expect(firstSessionPayload.csrf_token).toBe(secondSessionPayload.csrf_token);
    const stableCsrfMutation = await call(memberRequest(
      "/api/member/profile",
      "PATCH",
      { cookie: first.cookie, csrf: firstSessionPayload.csrf_token },
      { display_name: "Stable across tabs", reminder_emails_enabled: true },
    ));
    expect(stableCsrfMutation.status).toBe(200);

    const missingCsrf = await call(new Request(`${APP_ORIGIN}/api/member/logout`, {
      method: "POST",
      headers: { Origin: APP_ORIGIN, Cookie: second.cookie },
    }));
    expect(missingCsrf.status).toBe(403);
    const wrongOrigin = await call(new Request(`${APP_ORIGIN}/api/member/logout`, {
      method: "POST",
      headers: { Origin: "https://evil.example", Cookie: second.cookie, "X-CSRF-Token": second.csrf },
    }));
    expect(wrongOrigin.status).toBe(403);

    await baseEnv.DB.prepare(
      `UPDATE member_sessions SET last_seen_at = ?
       WHERE id = (
         SELECT id FROM member_sessions WHERE member_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
       )`,
    ).bind(new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000).toISOString(), first.memberId).run();
    const expired = await call(new Request(`${APP_ORIGIN}/api/member/session`, {
      headers: { Cookie: second.cookie },
    }));
    expect(expired.status).toBe(401);
    const logout = await call(memberRequest("/api/member/logout", "POST", first));
    expect(logout.status).toBe(200);
    expect(logout.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });

  it("keeps public recovery sign-out idempotent for ordinary and expired member sessions", async () => {
    const auth = await signIn("recovery-signout@example.org", {}, "203.0.113.189");
    await baseEnv.DB.prepare(
      "UPDATE member_sessions SET expires_at = ? WHERE member_id = ?",
    ).bind(new Date(Date.now() - 60_000).toISOString(), auth.memberId).run();

    const logout = await call(new Request(`${APP_ORIGIN}/api/session/logout`, {
      method: "POST",
      headers: { Origin: APP_ORIGIN, Cookie: auth.cookie },
    }));
    expect(logout.status).toBe(200);
    expect(await logout.json()).toMatchObject({ authenticated: false });
    expect(logout.headers.get("Set-Cookie")).toContain("stc_member_session=;");
    expect((await baseEnv.DB.prepare("SELECT COUNT(*) AS count FROM member_sessions").first<{ count: number }>())?.count)
      .toBe(0);

    const repeated = await call(new Request(`${APP_ORIGIN}/api/session/logout`, {
      method: "POST",
      headers: { Origin: APP_ORIGIN },
    }));
    expect(repeated.status).toBe(200);
    expect(repeated.headers.get("Set-Cookie")).toContain("Max-Age=0");

    const protectedRoute = await call(new Request(`${APP_ORIGIN}/api/member/dashboard`, {
      headers: { Origin: APP_ORIGIN, Cookie: auth.cookie },
    }));
    expect(protectedRoute.status).toBe(401);
  });

  it("rejects expired links before creating a member", async () => {
    const requested = await requestLink("expired@example.org", {}, "203.0.113.198");
    await baseEnv.DB.prepare(
      "UPDATE member_magic_links SET expires_at = ? WHERE email = ?",
    ).bind(new Date(Date.now() - 60_000).toISOString(), "expired@example.org").run();
    const response = await call(jsonRequest("/api/member/auth/consume", "POST", {
      token: requested.token,
    }));
    expect(response.status).toBe(400);
    expect((await baseEnv.DB.prepare("SELECT COUNT(*) AS count FROM members").first<{ count: number }>())?.count)
      .toBe(0);
  });

  it("enforces the absolute member-session expiry", async () => {
    const auth = await signIn("absolute-expiry@example.org", {}, "203.0.113.204");
    await baseEnv.DB.prepare(
      "UPDATE member_sessions SET expires_at = ? WHERE member_id = ?",
    ).bind(new Date(Date.now() - 60_000).toISOString(), auth.memberId).run();
    const response = await call(new Request(`${APP_ORIGIN}/api/member/session`, {
      headers: { Cookie: auth.cookie },
    }));
    expect(response.status).toBe(401);
  });
});

describe("member favorites, RSVPs, dashboard, and deletion", () => {
  it("rejects signed-out, forged-session, and invalid-CSRF submissions before parsing or rate limiting", async () => {
    const malformedRequest = (path: string, headers: Record<string, string>) => new Request(
      `${APP_ORIGIN}${path}`,
      {
        method: "POST",
        headers: {
          Origin: APP_ORIGIN,
          "Content-Type": "text/plain",
          "CF-Connecting-IP": "203.0.113.201",
          ...headers,
        },
        body: "this is deliberately not multipart form data",
      },
    );

    for (const path of ["/api/submissions/organizations", "/api/submissions/events"]) {
      const signedOut = await call(malformedRequest(path, {}));
      expect(signedOut.status).toBe(401);
      expect(await signedOut.json()).toMatchObject({ code: "authentication_required" });
      const forged = await call(malformedRequest(path, {
        Cookie: "stc_member_session=forged-session-token",
        "X-CSRF-Token": "forged-csrf-token",
      }));
      expect(forged.status).toBe(401);
      expect(await forged.json()).toMatchObject({ code: "authentication_required" });
    }
    expect((await baseEnv.DB.prepare("SELECT COUNT(*) AS count FROM rate_limits").first<{ count: number }>())?.count).toBe(0);

    const auth = await signIn("submission-guard@example.org", {}, "203.0.113.202");
    const rateLimitRows = (await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM rate_limits",
    ).first<{ count: number }>())?.count;
    const emailJobRows = (await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM email_jobs",
    ).first<{ count: number }>())?.count;
    for (const path of ["/api/submissions/organizations", "/api/submissions/events"]) {
      const missingCsrf = await call(malformedRequest(path, { Cookie: auth.cookie }));
      expect(missingCsrf.status).toBe(403);
      expect(await missingCsrf.json()).toMatchObject({ code: "csrf_required" });
      const wrongCsrf = await call(malformedRequest(path, {
        Cookie: auth.cookie,
        "X-CSRF-Token": "wrong-member-csrf",
      }));
      expect(wrongCsrf.status).toBe(403);
      expect(await wrongCsrf.json()).toMatchObject({ code: "csrf_denied" });
    }
    const wrongOrigin = await call(memberOrganizationRequest(
      auth,
      memberOrganizationSubmission("Wrong Origin Suggestion"),
      { origin: "https://evil.example" },
    ));
    expect(wrongOrigin.status).toBe(403);
    expect(await wrongOrigin.json()).toMatchObject({ code: "origin_denied" });
    const wrongEventOrigin = await call(memberEventRequest(
      auth,
      memberEventSubmission("Wrong Origin Event Suggestion"),
      { origin: "https://evil.example" },
    ));
    expect(wrongEventOrigin.status).toBe(403);
    expect(await wrongEventOrigin.json()).toMatchObject({ code: "origin_denied" });
    expect((await baseEnv.DB.prepare("SELECT COUNT(*) AS count FROM rate_limits").first<{ count: number }>())?.count)
      .toBe(rateLimitRows);
    expect((await baseEnv.DB.prepare("SELECT COUNT(*) AS count FROM email_jobs").first<{ count: number }>())?.count)
      .toBe(emailJobRows);
    expect((await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM organization_submissions",
    ).first<{ count: number }>())?.count).toBe(0);
    expect((await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM organization_submission_public_contacts",
    ).first<{ count: number }>())?.count).toBe(0);
    expect((await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM organization_submission_sections",
    ).first<{ count: number }>())?.count).toBe(0);
    expect((await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM event_submissions",
    ).first<{ count: number }>())?.count).toBe(0);
    expect((await baseEnv.PRIVATE_UPLOADS.list()).objects).toHaveLength(0);
  });

  it("charges malformed and honeypot organization attempts before parsing or validation", async () => {
    const auth = await signIn("admission-order-organization@example.org", {}, "203.0.113.219");
    const baseline = await rateLimitAttemptTotal();
    const overrides = { SUBMISSION_MEMBER_LIMIT: "2", SUBMISSION_IP_LIMIT: "2" };
    const ip = "203.0.113.220";

    const malformed = await call(new Request(`${APP_ORIGIN}/api/submissions/organizations`, {
      method: "POST",
      headers: {
        Origin: APP_ORIGIN,
        Cookie: auth.cookie,
        "X-CSRF-Token": auth.csrf,
        "CF-Connecting-IP": ip,
        "Content-Type": "text/plain",
      },
      body: "this authenticated request is deliberately not form data",
    }), overrides);
    expect(malformed.status).toBe(415);
    expect(await malformed.json()).toMatchObject({ code: "unsupported_media_type" });
    expect(await rateLimitAttemptTotal()).toBe(baseline + 2);

    const honeypot = await call(memberOrganizationRequest(
      auth,
      memberOrganizationSubmission("Honeypot Organization Attempt", { hp: "automated" }),
      { ip },
    ), overrides);
    expect(honeypot.status).toBe(200);
    expect(await rateLimitAttemptTotal()).toBe(baseline + 4);

    const limited = await call(memberOrganizationRequest(
      auth,
      memberOrganizationSubmission("Quota Exhausted Organization Attempt"),
      { ip },
    ), overrides);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: "rate_limited" });
    expect((await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM organization_submissions",
    ).first<{ count: number }>())?.count).toBe(0);
  });

  it("charges malformed and honeypot member event attempts after authentication", async () => {
    const auth = await signIn("admission-order-event@example.org", {}, "203.0.113.221");
    const baseline = await rateLimitAttemptTotal();
    const overrides = { SUBMISSION_MEMBER_LIMIT: "2", SUBMISSION_IP_LIMIT: "2" };
    const ip = "203.0.113.222";

    const malformed = await call(new Request(`${APP_ORIGIN}/api/submissions/events`, {
      method: "POST",
      headers: {
        Origin: APP_ORIGIN,
        Cookie: auth.cookie,
        "X-CSRF-Token": auth.csrf,
        "CF-Connecting-IP": ip,
        "Content-Type": "text/plain",
      },
      body: "this authenticated request is deliberately not form data",
    }), overrides);
    expect(malformed.status).toBe(415);
    expect(await malformed.json()).toMatchObject({ code: "unsupported_media_type" });
    expect(await rateLimitAttemptTotal()).toBe(baseline + 2);

    const honeypot = await call(memberEventRequest(
      auth,
      memberEventSubmission("Honeypot Member Event Attempt", { hp: "automated" }),
      { ip },
    ), overrides);
    expect(honeypot.status).toBe(200);
    expect(await rateLimitAttemptTotal()).toBe(baseline + 4);

    const limited = await call(memberEventRequest(
      auth,
      memberEventSubmission("Quota Exhausted Member Event Attempt"),
      { ip },
    ), overrides);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: "rate_limited" });
    expect((await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM event_submissions",
    ).first<{ count: number }>())?.count).toBe(0);
  });

  it("bounds Turnstile tokens and fails closed when verification is unavailable", async () => {
    const auth = await signIn("turnstile-event@example.org", {}, "203.0.113.223");
    const turnstileEnv = {
      REQUIRE_TURNSTILE: "true",
      TURNSTILE_EVENT_SECRET: "test-event-turnstile-secret",
      SUBMISSION_MEMBER_LIMIT: "100",
      SUBMISSION_IP_LIMIT: "100",
    };
    const oversizedFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not fetch"));
    const oversized = await call(memberEventRequest(
      auth,
      memberEventSubmission("Oversized Turnstile Token Event", {
        turnstile_token: "x".repeat(2_049),
      }),
      { ip: "203.0.113.224" },
    ), turnstileEnv);
    expect(oversized.status).toBe(400);
    expect(await oversized.json()).toMatchObject({ code: "turnstile_invalid" });
    expect(oversizedFetch).not.toHaveBeenCalled();

    vi.restoreAllMocks();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    let observedSignal: AbortSignal | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      observedSignal = init?.signal ?? null;
      throw new DOMException("Turnstile timed out", "TimeoutError");
    });
    const unavailable = await call(memberEventRequest(
      auth,
      memberEventSubmission("Timed Out Turnstile Event", {
        turnstile_token: "valid-sized-token",
      }),
      { ip: "203.0.113.225" },
    ), turnstileEnv);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ code: "turnstile_unavailable" });
    expect(timeoutSpy).toHaveBeenCalledWith(5_000);
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect((await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM event_submissions",
    ).first<{ count: number }>())?.count).toBe(0);
  });

  it("sanitizes unexpected multipart field names without logging visitor values", async () => {
    const auth = await signIn("safe-submission-logging@example.org", {}, "203.0.113.224");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const unsafeFieldName = `<unexpected-field>${"x".repeat(120)}`;
    const form = memberOrganizationSubmission("Unexpected Field Logging Attempt");
    form.set(unsafeFieldName, "visitor-private-value-must-not-be-logged");
    const response = await call(memberOrganizationRequest(auth, form, { ip: "203.0.113.225" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "unexpected_form_field" });
    expect(warning).toHaveBeenCalledTimes(1);
    const metadata = warning.mock.calls[0]?.[1] as { field?: string } | undefined;
    expect(metadata?.field).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(metadata?.field?.length).toBeLessThanOrEqual(80);
    expect(JSON.stringify(warning.mock.calls)).not.toContain("<unexpected-field>");
    expect(JSON.stringify(warning.mock.calls)).not.toContain("visitor-private-value-must-not-be-logged");

    const unsafeFileField = `<unexpected-file>${"y".repeat(120)}`;
    const fileForm = memberOrganizationSubmission("Unexpected File Field Attempt");
    fileForm.set(unsafeFileField, new File(["not-an-image"], "visitor.txt", { type: "text/plain" }));
    const fileResponse = await call(memberOrganizationRequest(auth, fileForm, { ip: "203.0.113.225" }));
    expect(fileResponse.status).toBe(400);
    const fileBody = await fileResponse.json<{ errors: Record<string, string[]> }>();
    expect(Object.keys(fileBody.errors)).toHaveLength(1);
    expect(Object.keys(fileBody.errors)[0]).toMatch(/^[A-Za-z0-9_.-]{1,80}$/);
    expect(JSON.stringify(fileBody)).not.toContain("<unexpected-file>");
  });

  it("rejects anonymous event suggestions and uses a signed-in member's verified email", async () => {
    const anonymous = await call(new Request(`${APP_ORIGIN}/api/submissions/events`, {
      method: "POST",
      headers: { Origin: APP_ORIGIN, "CF-Connecting-IP": "203.0.113.226" },
      body: memberEventSubmission("Anonymous Event Without Receipt", {
        submitter_email: "unverified-victim@example.net",
      }),
    }));
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ code: "authentication_required" });
    expect((await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM email_jobs WHERE kind = 'submission_receipt'",
    ).first<{ count: number }>())?.count).toBe(0);

    const auth = await signIn("verified-event-member@example.org", {}, "203.0.113.227");
    const authenticated = await call(memberEventRequest(
      auth,
      memberEventSubmission("Authenticated Event With Verified Receipt", {
        submitter_email: "replacement-victim@example.net",
      }),
      { ip: "203.0.113.228" },
    ));
    expect(authenticated.status).toBe(200);
    expect(await baseEnv.DB.prepare(
      `SELECT member_id, submitter_email FROM event_submissions
       WHERE name = 'Authenticated Event With Verified Receipt'`,
    ).first<{ member_id: string; submitter_email: string }>()).toEqual({
      member_id: auth.memberId,
      submitter_email: "verified-event-member@example.org",
    });
    const receipts = await baseEnv.DB.prepare(
      "SELECT recipient_email FROM email_jobs WHERE kind = 'submission_receipt'",
    ).all<{ recipient_email: string }>();
    expect(receipts.results).toEqual([{ recipient_email: "verified-event-member@example.org" }]);
  });

  it("stores organization ownership and the trusted member email instead of a submitted email", async () => {
    const auth = await signIn("Trusted.Submitter@Example.org", {}, "203.0.113.203");
    const response = await call(memberOrganizationRequest(
      auth,
      memberOrganizationSubmission("Owned Member Suggestion", {
        submitter_email: "forged-private-contact@example.net",
        submitter_phone: "+1 242 555 0142",
      }),
      { idempotencyKey: "member-owned-submission" },
    ));
    expect(response.status).toBe(200);
    const stored = await baseEnv.DB.prepare(
      `SELECT member_id, submitter_email, submitter_phone
       FROM organization_submissions WHERE name = 'Owned Member Suggestion'`,
    ).first<{ member_id: string; submitter_email: string; submitter_phone: string }>();
    expect(stored).toEqual({
      member_id: auth.memberId,
      submitter_email: "trusted.submitter@example.org",
      submitter_phone: "+1 242 555 0142",
    });
    expect((await baseEnv.DB.prepare(
      "SELECT recipient_email FROM email_jobs WHERE kind = 'submission_receipt'",
    ).first<{ recipient_email: string }>())?.recipient_email).toBe("trusted.submitter@example.org");
    const second = await signIn("another-member@example.org", {}, "203.0.113.212");
    const firstDashboard = await (await call(new Request(`${APP_ORIGIN}/api/member/dashboard`, {
      headers: { Cookie: auth.cookie },
    }))).json<Record<string, any>>();
    const secondDashboard = await (await call(new Request(`${APP_ORIGIN}/api/member/dashboard`, {
      headers: { Cookie: second.cookie },
    }))).json<Record<string, any>>();
    expect(firstDashboard.submissions.map((submission: { name: string }) => submission.name))
      .toContain("Owned Member Suggestion");
    expect(secondDashboard.submissions).toEqual([]);
  });

  it("redirects signed-out suggestion pages and renders noindex forms only for members", async () => {
    const signedOutOrganization = await call(new Request(`${APP_ORIGIN}/suggest/organization`));
    expect(signedOutOrganization.status).toBe(303);
    expect(signedOutOrganization.headers.get("Location")).toBe("/signin?return=%2Fsuggest%2Forganization");
    expect(signedOutOrganization.headers.get("Cache-Control")).toContain("no-store");
    const signedOutEvent = await call(new Request(`${APP_ORIGIN}/suggest/event`));
    expect(signedOutEvent.status).toBe(303);
    expect(signedOutEvent.headers.get("Location")).toBe("/signin?return=%2Fsuggest%2Fevent");
    expect(signedOutEvent.headers.get("Cache-Control")).toContain("no-store");

    const auth = await signIn("organization-page@example.org", {}, "203.0.113.204");
    const signedInOrganization = await call(new Request(`${APP_ORIGIN}/suggest/organization`, {
      headers: {
        Cookie: auth.cookie,
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
        Referer: "https://mail.example.org/",
      },
    }));
    expect(signedInOrganization.status).toBe(200);
    const organizationHtml = await signedInOrganization.text();
    expect(organizationHtml).toContain("data-member-suggestion-page");
    expect(organizationHtml).toContain("data-member-required");
    expect(organizationHtml).toContain("verified email address attached to your My STC account");
    expect(organizationHtml).toContain('name="location_ids" type="checkbox"');
    expect(organizationHtml).toContain('name="category_ids" type="checkbox"');
    expect(organizationHtml).toContain("Each checkbox can be selected independently on desktop or mobile.");
    expect(organizationHtml).not.toMatch(/name="(?:location_ids|category_ids)" multiple/);
    expect(organizationHtml).toContain("member-secondary-button organization-contact-add");
    expect(organizationHtml).not.toContain('name="submitter_email"');
    expect(organizationHtml).toContain('<meta name="robots" content="noindex, nofollow">');

    const crossSiteApiRead = await call(new Request(`${APP_ORIGIN}/api/member/session`, {
      headers: {
        Cookie: auth.cookie,
        "Sec-Fetch-Site": "cross-site",
        Origin: "https://mail.example.org",
      },
    }));
    expect(crossSiteApiRead.status).toBe(403);
    expect(await crossSiteApiRead.json()).toMatchObject({ code: "origin_denied" });

    const signedInEvent = await call(new Request(`${APP_ORIGIN}/suggest/event`, {
      headers: { Cookie: auth.cookie },
    }));
    expect(signedInEvent.status).toBe(200);
    expect(signedInEvent.headers.get("Cache-Control")).toContain("no-store");
    const eventHtml = await signedInEvent.text();
    expect(eventHtml).toContain("data-member-suggestion-page");
    expect(eventHtml).toContain("data-member-required");
    expect(eventHtml).toContain("data-submission-success-link hidden");
    expect(eventHtml).not.toContain('name="submitter_email"');
    expect(eventHtml).toContain('<meta name="robots" content="noindex, nofollow">');

    await baseEnv.DB.prepare(
      "UPDATE member_sessions SET expires_at = ? WHERE member_id = ?",
    ).bind(new Date(Date.now() - 60_000).toISOString(), auth.memberId).run();
    const expiredOrganization = await call(new Request(`${APP_ORIGIN}/suggest/organization`, {
      headers: { Cookie: auth.cookie },
    }));
    expect(expiredOrganization.status).toBe(303);
    expect(expiredOrganization.headers.get("Location")).toBe("/signin?return=%2Fsuggest%2Forganization");
    const expiredEvent = await call(new Request(`${APP_ORIGIN}/suggest/event`, {
      headers: { Cookie: auth.cookie },
    }));
    expect(expiredEvent.status).toBe(303);
    expect(expiredEvent.headers.get("Location")).toBe("/signin?return=%2Fsuggest%2Fevent");
  });

  it("deduplicates event payloads per member and rejects key reuse for different content", async () => {
    const firstMember = await signIn("event-key-one@example.org", {}, "203.0.113.229");
    const secondMember = await signIn("event-key-two@example.org", {}, "203.0.113.230");
    const eventRequest = (auth: { cookie: string; csrf: string }, name: string, ip: string) => memberEventRequest(
      auth,
      memberEventSubmission(name),
      { ip, idempotencyKey: "payload-bound-event-key" },
    );
    const first = await call(eventRequest(firstMember, "Payload-Bound Event Suggestion", "203.0.113.231"));
    expect(first.status).toBe(200);
    const firstId = (await first.json<{ submission_id: string }>()).submission_id;
    const replay = await call(eventRequest(firstMember, "Payload-Bound Event Suggestion", "203.0.113.231"));
    expect(replay.status).toBe(200);
    expect((await replay.json<{ submission_id: string }>()).submission_id).toBe(firstId);
    const conflict = await call(eventRequest(firstMember, "Different Event Payload", "203.0.113.231"));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "idempotency_conflict" });
    const crossMember = await call(eventRequest(secondMember, "Payload-Bound Event Suggestion", "203.0.113.232"));
    expect(crossMember.status).toBe(200);
    expect((await crossMember.json<{ submission_id: string }>()).submission_id).not.toBe(firstId);
    expect((await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM event_submissions",
    ).first<{ count: number }>())?.count).toBe(2);
  });

  it("deduplicates organization suggestions per member without colliding across members", async () => {
    const first = await signIn("idempotency-one@example.org", {}, "203.0.113.206");
    const second = await signIn("idempotency-two@example.org", {}, "203.0.113.207");
    const key = "shared-member-idempotency-key";
    const firstResponse = await call(memberOrganizationRequest(
      first,
      memberOrganizationSubmission("First Member Suggestion"),
      { idempotencyKey: key, ip: "203.0.113.208" },
    ));
    expect(firstResponse.status).toBe(200);
    const firstBody = await firstResponse.json<{ submission_id: string }>();
    const replayResponse = await call(memberOrganizationRequest(
      first,
      memberOrganizationSubmission("First Member Suggestion"),
      { idempotencyKey: key, ip: "203.0.113.208" },
    ));
    expect(replayResponse.status).toBe(200);
    expect((await replayResponse.json<{ submission_id: string }>()).submission_id).toBe(firstBody.submission_id);

    const changedPayloadResponse = await call(memberOrganizationRequest(
      first,
      memberOrganizationSubmission("Changed Payload Suggestion"),
      { idempotencyKey: key, ip: "203.0.113.208" },
    ));
    expect(changedPayloadResponse.status).toBe(409);
    expect(await changedPayloadResponse.json()).toMatchObject({ code: "idempotency_conflict" });

    const crossMemberResponse = await call(memberOrganizationRequest(
      second,
      memberOrganizationSubmission("First Member Suggestion"),
      { idempotencyKey: key, ip: "203.0.113.208" },
    ));
    expect(crossMemberResponse.status).toBe(200);
    const crossMemberId = (await crossMemberResponse.json<{ submission_id: string }>()).submission_id;
    expect(crossMemberId).not.toBe(firstBody.submission_id);
    const owners = await baseEnv.DB.prepare(
      "SELECT member_id, name FROM organization_submissions ORDER BY member_id, name",
    ).all<{ member_id: string; name: string }>();
    expect(owners.results).toHaveLength(2);
    expect(owners.results.filter((row) => row.member_id === first.memberId).map((row) => row.name).sort())
      .toEqual(["First Member Suggestion"]);
    expect(owners.results.filter((row) => row.member_id === second.memberId).map((row) => row.name))
      .toEqual(["First Member Suggestion"]);
  });

  it("honors the configurable organization submission limit per member", async () => {
    const first = await signIn("limited-submitter-one@example.org", {}, "203.0.113.209");
    const second = await signIn("limited-submitter-two@example.org", {}, "203.0.113.210");
    const overrides = { SUBMISSION_MEMBER_LIMIT: "1", SUBMISSION_IP_LIMIT: "100" };
    const firstAccepted = await call(memberOrganizationRequest(
      first,
      memberOrganizationSubmission("First Limited Suggestion"),
      { idempotencyKey: "limited-first", ip: "203.0.113.211" },
    ), overrides);
    expect(firstAccepted.status).toBe(200);
    const firstLimited = await call(memberOrganizationRequest(
      first,
      memberOrganizationSubmission("Rejected Limited Suggestion"),
      { idempotencyKey: "limited-second", ip: "203.0.113.211" },
    ), overrides);
    expect(firstLimited.status).toBe(429);
    expect(await firstLimited.json()).toMatchObject({ code: "rate_limited" });

    const secondAccepted = await call(memberOrganizationRequest(
      second,
      memberOrganizationSubmission("Second Member Limited Suggestion"),
      { idempotencyKey: "limited-third", ip: "203.0.113.211" },
    ), overrides);
    expect(secondAccepted.status).toBe(200);
    expect((await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM organization_submissions",
    ).first<{ count: number }>())?.count).toBe(2);
  });

  it("persists isolated favorites, applies a pending intent, and imports legacy names once", async () => {
    await seedOrganization("org_member_one", "Member Helpers");
    await seedOrganization("org_member_duplicate_a", "Duplicate Helpers");
    await seedOrganization("org_member_duplicate_b", "Duplicate Helpers");
    await seedOrganization("org_member_inactive", "Inactive Helpers", false);
    await seedOrganization("org_member_legacy", "Legacy Helpers");
    await seedEvent(930001);
    const first = await signIn("favorites-one@example.org", {
      return_path: "/organization/org_member_one",
      intent_type: "favorite_organization",
      target_id: "org_member_one",
    }, "203.0.113.189");
    const dashboard = await call(new Request(`${APP_ORIGIN}/api/member/dashboard`, {
      headers: { Cookie: first.cookie },
    }));
    const firstBody = await dashboard.json<Record<string, any>>();
    expect(firstBody.favorite_organizations.map((item: { id: string }) => item.id)).toEqual(["org_member_one"]);

    expect((await call(memberRequest("/api/member/favorites/events/930001", "PUT", first))).status).toBe(200);
    expect((await call(memberRequest("/api/member/favorites/events/930001", "PUT", first))).status).toBe(200);
    expect((await call(memberRequest("/api/member/favorites/organizations/org_member_inactive", "PUT", first))).status).toBe(404);
    const imported = await call(memberRequest("/api/member/favorites/import", "POST", first, {
      names: ["Member Helpers", "Legacy Helpers", "Duplicate Helpers", "Missing Helpers"],
    }));
    expect(await imported.json()).toMatchObject({
      imported_count: 1,
      ambiguous_count: 1,
      unmatched_count: 1,
      imported_names: ["Legacy Helpers"],
      already_saved_names: ["Member Helpers"],
    });
    expect(await (await call(memberRequest("/api/member/favorites/import", "POST", first, {
      names: ["Member Helpers"],
    }))).json()).toMatchObject({ already_imported: true, imported_count: 0 });

    const second = await signIn("favorites-two@example.org", {}, "203.0.113.190");
    const secondDashboard = await (await call(new Request(`${APP_ORIGIN}/api/member/dashboard`, {
      headers: { Cookie: second.cookie },
    }))).json<Record<string, any>>();
    expect(secondDashboard.favorite_organizations).toEqual([]);
    expect(secondDashboard.favorite_events).toEqual([]);
  });

  it("creates and cancels an RSVP idempotently, rejects past events, and exposes only a public aggregate", async () => {
    await seedEvent(930002, 48);
    await seedEvent(930003, -48);
    const auth = await signIn("rsvp@example.org", {}, "203.0.113.191");
    const going = await call(memberRequest("/api/member/events/930002/rsvp", "PUT", auth));
    expect(await going.json()).toMatchObject({ rsvp: { status: "going" }, rsvp_count: 1 });
    const duplicate = await call(memberRequest("/api/member/events/930002/rsvp", "PUT", auth));
    expect(await duplicate.json()).toMatchObject({ duplicate: true, rsvp_count: 1 });
    expect((await call(memberRequest("/api/member/events/930003/rsvp", "PUT", auth))).status).toBe(409);

    const publicEvent = await (await call(new Request(`${APP_ORIGIN}/api/events/930002`)))
      .json<Record<string, any>>();
    expect(publicEvent.event.rsvp_count).toBe(1);
    expect(JSON.stringify(publicEvent)).not.toContain("rsvp@example.org");
    expect(JSON.stringify(publicEvent)).not.toContain(auth.memberId);

    const cancelled = await call(memberRequest("/api/member/events/930002/rsvp", "DELETE", auth));
    expect(await cancelled.json()).toMatchObject({ rsvp: { status: "cancelled" }, rsvp_count: 0 });
    const cancelledAgain = await call(memberRequest("/api/member/events/930002/rsvp", "DELETE", auth));
    expect(await cancelledAgain.json()).toMatchObject({ duplicate: true, rsvp_count: 0 });
    const history = await (await call(new Request(`${APP_ORIGIN}/api/member/dashboard`, {
      headers: { Cookie: auth.cookie },
    }))).json<Record<string, any>>();
    expect(history.upcoming_rsvps).toEqual([]);
    expect(history.past_rsvps).toHaveLength(1);
    expect(history.past_rsvps[0].status).toBe("cancelled");
  });

  it("creates exactly one email for each concurrent RSVP state transition", async () => {
    await seedEvent(930008, 48);
    const auth = await signIn("rsvp-race@example.org", {}, "203.0.113.199");
    const going = await Promise.all([
      call(memberRequest("/api/member/events/930008/rsvp", "PUT", auth)),
      call(memberRequest("/api/member/events/930008/rsvp", "PUT", auth)),
    ]);
    expect(going.every((response) => response.status === 200)).toBe(true);
    expect((await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM email_jobs WHERE kind = 'rsvp_confirmation'",
    ).first<{ count: number }>())?.count).toBe(1);
    const cancelled = await Promise.all([
      call(memberRequest("/api/member/events/930008/rsvp", "DELETE", auth)),
      call(memberRequest("/api/member/events/930008/rsvp", "DELETE", auth)),
    ]);
    expect(cancelled.every((response) => response.status === 200)).toBe(true);
    expect((await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM email_jobs WHERE kind = 'rsvp_cancellation'",
    ).first<{ count: number }>())?.count).toBe(1);
  });

  it("updates profile preferences and deletes account data while detaching retained submissions", async () => {
    await seedOrganization("org_delete", "Delete Test Helpers");
    await seedEvent(930004);
    const auth = await signIn("delete@example.org", {}, "203.0.113.192");
    const profile = await call(memberRequest("/api/member/profile", "PATCH", auth, {
      display_name: "Community Member",
      reminder_emails_enabled: false,
    }));
    expect(await profile.json()).toMatchObject({
      member: { display_name: "Community Member", reminder_emails_enabled: false },
    });
    await call(memberRequest("/api/member/favorites/organizations/org_delete", "PUT", auth));
    await call(memberRequest("/api/member/events/930004/rsvp", "PUT", auth));
    await requestLink("delete@example.org", {}, "203.0.113.200");
    const now = new Date().toISOString();
    await baseEnv.DB.prepare(
      `INSERT INTO organization_submissions (
         id, member_id, name, description, submitter_email, created_at, updated_at
       ) VALUES ('member_retained_submission', ?, 'Retained Suggestion',
         'A retained suggestion used to verify account detachment.', ?, ?, ?)`,
    ).bind(auth.memberId, "delete@example.org", now, now).run();
    const deleted = await call(memberRequest("/api/member/account", "DELETE", auth));
    expect(deleted.status).toBe(200);
    expect((await baseEnv.DB.prepare("SELECT COUNT(*) AS count FROM members").first<{ count: number }>())?.count).toBe(0);
    expect((await baseEnv.DB.prepare("SELECT COUNT(*) AS count FROM event_rsvps").first<{ count: number }>())?.count).toBe(0);
    expect((await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM member_magic_links WHERE email = 'delete@example.org' AND consumed_at IS NULL",
    ).first<{ count: number }>())?.count).toBe(0);
    expect((await baseEnv.DB.prepare(
      `SELECT COUNT(*) AS count FROM email_jobs
       WHERE recipient_email = 'delete@example.org' AND status <> 'sent'`,
    ).first<{ count: number }>())?.count).toBe(0);
    expect((await baseEnv.DB.prepare("SELECT member_id FROM organization_submissions WHERE id = 'member_retained_submission'").first<{ member_id: string | null }>())?.member_id).toBeNull();
  });
});

describe("transactional member email", () => {
  it("renders confirmations with calendar metadata in the local inbox", async () => {
    await seedEvent(930005);
    const auth = await signIn("calendar@example.org", {}, "203.0.113.193");
    await call(memberRequest("/api/member/events/930005/rsvp", "PUT", auth));
    await processEmailJobs(baseEnv);
    const inbox = await call(new Request(`${APP_ORIGIN}/api/dev/emails`));
    expect(inbox.status).toBe(200);
    const body = await inbox.json<{ emails: Array<Record<string, any>> }>();
    const confirmation = body.emails.find((item) => item.kind === "rsvp_confirmation");
    expect(confirmation).toMatchObject({
      recipient_email: "calendar@example.org",
      attachments: [{ filename: "serve-the-cays-event.ics", type: "text/calendar; charset=utf-8; method=PUBLISH" }],
    });
    expect(confirmation?.text).toContain(`${APP_ORIGIN}/event/930005`);
    expect(confirmation?.html).toContain("Your event plans");
    expect(confirmation?.html).toContain("A calendar file is attached");
    expect(confirmation?.html).toContain("@media only screen and (max-width: 520px)");
    expect(confirmation?.html).toContain("a[x-apple-data-detectors]");
    expect(confirmation?.html).toContain('class="stc-detail-row"');
  });

  it("preserves primary data when Cloudflare Email Service is unavailable", async () => {
    await seedEvent(930006);
    const auth = await signIn("provider@example.org", {}, "203.0.113.194");
    await call(memberRequest("/api/member/events/930006/rsvp", "PUT", auth));
    const failingEmail: SendEmail = {
      async send(): Promise<EmailSendResult> {
        throw Object.assign(new Error("provider unavailable"), { code: "E_INTERNAL_SERVER_ERROR" });
      },
    };
    expect(await processEmailJobs({
      ...baseEnv,
      ENVIRONMENT: "preview",
      MEMBER_APPLICATION_ENABLED: "true",
      MEMBER_SCHEMA_RELEASE_READY: "true",
      ADMIN_STEP_UP_VERIFIED: "true",
      TRANSACTIONAL_EMAIL_DELIVERY_ENABLED: "true",
      EMAIL_DELIVERY_RECONCILIATION_VERIFIED: "true",
      EMAIL: failingEmail,
    }, 25)).toBe(0);
    expect((await baseEnv.DB.prepare(
      "SELECT status FROM event_rsvps WHERE member_id = ? AND event_id = 930006",
    ).bind(auth.memberId).first<{ status: string }>())?.status).toBe("going");
    expect((await baseEnv.DB.prepare(
      "SELECT status FROM email_jobs WHERE kind = 'rsvp_confirmation'",
    ).first<{ status: string }>())?.status).toBe("failed");
  });

  it("sends every transactional message type through the scoped Cloudflare binding", async () => {
    await seedEvent(930009, 20);
    const now = new Date().toISOString();
    await baseEnv.DB.batch([
      baseEnv.DB.prepare(
        `INSERT INTO members (id, email, created_at, updated_at)
         VALUES ('member_email_matrix', 'matrix@example.org', ?, ?)`,
      ).bind(now, now),
      baseEnv.DB.prepare(
        `INSERT INTO event_rsvps (
           member_id, event_id, status, created_at, updated_at
         ) VALUES ('member_email_matrix', 930009, 'going', ?, ?)`,
      ).bind(now, now),
    ]);
    await baseEnv.DB.prepare("DELETE FROM email_jobs").run();
    const sent: EmailMessageBuilder[] = [];
    const fakeEmail: SendEmail = {
      async send(message: EmailMessage | EmailMessageBuilder): Promise<EmailSendResult> {
        if (!("subject" in message)) throw new Error("Expected structured email");
        sent.push(message);
        return { messageId: `cloudflare-${sent.length}` };
      },
    };
    const previewEnv = {
      ...baseEnv,
      ENVIRONMENT: "preview",
      MEMBER_APPLICATION_ENABLED: "true",
      MEMBER_SCHEMA_RELEASE_READY: "true",
      ADMIN_STEP_UP_VERIFIED: "true",
      TRANSACTIONAL_EMAIL_DELIVERY_ENABLED: "true",
      EMAIL_DELIVERY_RECONCILIATION_VERIFIED: "true",
      EMAIL: fakeEmail,
    };
    const eventPayload = await baseEnv.DB.prepare(
      `SELECT id AS event_id, name, start_at, end_at, timezone, venue_name, location_display
       FROM events WHERE id = 930009`,
    ).first<Record<string, unknown>>();
    expect(eventPayload).toBeTruthy();
    eventPayload!.name = "A very long community service event name with vibrant Bahamian characters like Eleuthera and Andros that requires calendar line folding";
    await queueEmail(previewEnv, {
      kind: "magic_link",
      recipientEmail: "matrix@example.org",
      idempotencyKey: "matrix-magic",
      payload: { sign_in_url: `${APP_ORIGIN}/signin/verify#token=development-token`, expires_minutes: 15 },
    });
    const matrix = [
      { kind: "welcome", payload: {} },
      { kind: "rsvp_confirmation", payload: eventPayload! },
      { kind: "rsvp_cancellation", payload: eventPayload! },
      { kind: "event_reminder", payload: eventPayload! },
      { kind: "submission_receipt", payload: { submission_type: "event", name: "Matrix suggestion" } },
      { kind: "submission_approved", payload: { submission_type: "event", name: "Matrix suggestion", public_url: "/event/930009" } },
      { kind: "submission_denied", payload: { submission_type: "event", name: "Matrix suggestion", reason: "Not enough public detail" } },
    ] as const;
    for (const item of matrix) {
      await queueEmail(previewEnv, {
        kind: item.kind,
        memberId: item.kind === "event_reminder" ? "member_email_matrix" : null,
        recipientEmail: "matrix@example.org",
        idempotencyKey: `matrix-${item.kind}`,
        payload: item.payload,
      });
    }
    expect(await processEmailJobs(previewEnv, 25)).toBe(7);
    expect(sent).toHaveLength(8);
    expect(sent[0].from).toEqual({ email: "signin@servethecays.com", name: "Serve the Cays" });
    expect(sent.slice(1).every((message) => (
      typeof message.from === "object" && message.from.email === "notifications@servethecays.com"
    ))).toBe(true);
    const receipt = sent.find((message) => message.subject === "We received your event suggestion");
    expect(receipt?.html).toContain("Suggestion received");
    expect(receipt?.html).toContain("Nothing is published until it has been reviewed");
    expect(receipt?.html).toContain("@media only screen and (max-width: 520px)");
    const approval = sent.find((message) => message.subject === "Your event is now listed on Serve the Cays");
    expect(approval?.text).toContain("is now listed on Serve the Cays");
    expect(approval?.html).toContain("Now listed · Event");
    expect(approval?.html).toContain("View your published listing");
    expect(approval?.html).toContain(`${APP_ORIGIN}/event/930009`);
    expect(approval?.html).toContain("@media only screen and (max-width: 520px)");
    expect(approval?.html).toContain("stc-listing-card-cell");
    expect(approval?.html).toContain("stc-listing-title");
    const confirmation = sent.find((message) => message.subject.startsWith("You're going to"));
    const calendarFile = confirmation?.attachments?.find((attachment) => attachment.filename === "serve-the-cays-event.ics");
    expect(calendarFile).toMatchObject({
      disposition: "attachment",
      type: "text/calendar; charset=utf-8; method=PUBLISH",
    });
    const calendar = new TextDecoder().decode(calendarFile?.content as ArrayBuffer);
    expect(calendar).toContain("\r\n ");
    expect(calendar.split("\r\n").every((line) => new TextEncoder().encode(line).byteLength <= 75)).toBe(true);
    expect((await baseEnv.DB.prepare(
      "SELECT payload_json FROM email_jobs WHERE kind = 'rsvp_confirmation'",
    ).first<{ payload_json: string }>())?.payload_json).toBe("{}");
  });

  it("schedules one enabled reminder within 24 hours", async () => {
    await seedEvent(930007, 20);
    const auth = await signIn("reminder@example.org", {}, "203.0.113.195");
    await call(memberRequest("/api/member/events/930007/rsvp", "PUT", auth));
    const changed = await memberMaintenance(baseEnv, new Date());
    expect(changed).toBeGreaterThan(0);
    const reminders = await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM email_jobs WHERE kind = 'event_reminder'",
    ).first<{ count: number }>();
    expect(reminders?.count).toBe(1);
    await memberMaintenance(baseEnv, new Date());
    expect((await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM email_jobs WHERE kind = 'event_reminder'",
    ).first<{ count: number }>())?.count).toBe(1);

    const disabled = await call(memberRequest("/api/member/profile", "PATCH", auth, {
      display_name: "",
      reminder_emails_enabled: false,
    }));
    expect(disabled.status).toBe(200);
    expect((await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM email_jobs WHERE kind = 'event_reminder'",
    ).first<{ count: number }>())?.count).toBe(0);
    await call(memberRequest("/api/member/profile", "PATCH", auth, {
      display_name: "",
      reminder_emails_enabled: true,
    }));
    await memberMaintenance(baseEnv, new Date());
    expect((await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM email_jobs WHERE kind = 'event_reminder'",
    ).first<{ count: number }>())?.count).toBe(1);
  });
});
