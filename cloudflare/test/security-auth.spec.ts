import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import type { Env } from "../src/types";
import { seedAdmin, setCookieValues, signInAdmin } from "./admin-auth";

const APP_ORIGIN = "https://servethecays.test";
const baseEnv = env as unknown as Env;

function call(request: Request, overrides: Partial<Env> = {}): Promise<Response> {
  return worker.fetch(request, { ...baseEnv, ...overrides });
}

async function scalar(sql: string): Promise<number> {
  const row = await baseEnv.DB.prepare(sql).first<{ value: number }>();
  return Number(row?.value ?? 0);
}

async function seedUser(
  id: string,
  email: string,
  role: "owner" | "editor",
): Promise<void> {
  await seedAdmin(id, email, role);
}

async function loginUser(
  email: string,
  overrides: Partial<Env> = {},
  ip = "203.0.113.80",
): Promise<{ cookie: string; csrf: string; response: Response }> {
  const auth = await signInAdmin(email, overrides, ip);
  expect(auth.response.status).toBe(200);
  return { cookie: auth.adminCookie, csrf: auth.csrf, response: auth.response };
}

describe("administrator authentication hardening", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("removes the password endpoint instead of leaving a compatibility login", async () => {
    const denied = await call(new Request(`${APP_ORIGIN}/api/admin/login`, {
      method: "POST",
      headers: {
        Origin: APP_ORIGIN,
        "Content-Type": "application/json",
        "CF-Connecting-IP": "203.0.113.81",
      },
      body: JSON.stringify({ email: "owner@example.org", password: "unused" }),
    }));
    expect(denied.status).toBe(404);
    expect(await denied.json()).toMatchObject({ code: "not_found" });
    expect(await scalar("SELECT COUNT(*) AS value FROM sessions")).toBe(0);
  });

  it("grants the separate admin session only to active allowlisted email-link users", async () => {
    await seedUser("user_owner", "owner@example.org", "owner");
    const anonymousAdmin = await call(new Request(`${APP_ORIGIN}/admin`));
    expect(anonymousAdmin.status).toBe(404);
    expect(await anonymousAdmin.text()).toContain("We couldn't find the cay you were looking for.");

    const owner = await signInAdmin("owner@example.org", {}, "203.0.113.141");
    expect(owner.response.status).toBe(200);
    expect(owner.adminCookie).toMatch(/^stc_admin_session=/);
    expect(owner.memberCookie).toMatch(/^stc_member_session=/);
    expect(owner.payload).toMatchObject({
      admin: { authorized: true, role: "owner" },
      redirect_to: "/admin",
    });
    const memberSession = await call(new Request(`${APP_ORIGIN}/api/member/session`, {
      headers: { Cookie: owner.memberCookie, Origin: APP_ORIGIN },
    }));
    expect(await memberSession.json()).toMatchObject({ admin: { authorized: true, role: "owner" } });
    const adminPage = await call(new Request(`${APP_ORIGIN}/admin`, {
      headers: {
        Cookie: owner.adminCookie,
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
        Referer: "https://mail.example.org/",
      },
    }));
    expect(adminPage.status).toBe(200);
    const adminHtml = await adminPage.text();
    expect(adminHtml).toContain("Manage Serve the Cays");
    expect(adminHtml).toContain("Outreach ledger");
    expect(adminHtml).toContain("News posts");
    expect(adminHtml).not.toContain('type="password"');

    const crossSiteAdminApiRead = await call(new Request(`${APP_ORIGIN}/api/admin/session`, {
      headers: {
        Cookie: owner.adminCookie,
        "Sec-Fetch-Site": "cross-site",
        Origin: "https://mail.example.org",
      },
    }));
    expect(crossSiteAdminApiRead.status).toBe(403);
    expect(await crossSiteAdminApiRead.json()).toMatchObject({ code: "origin_denied" });

    const ordinary = await signInAdmin("member@example.org", {}, "203.0.113.142");
    expect(ordinary.response.status).toBe(200);
    expect(ordinary.adminCookie).toBe("");
    expect(ordinary.payload).toMatchObject({ admin: { authorized: false }, redirect_to: "/me" });
    const hidden = await call(new Request(`${APP_ORIGIN}/admin`, {
      headers: { Cookie: ordinary.memberCookie, Origin: APP_ORIGIN },
    }));
    expect(hidden.status).toBe(404);
  });

  it("fails closed when the administrator session secret is shorter than 32 characters", async () => {
    await seedUser("user_owner", "owner@example.org", "owner");
    const auth = await signInAdmin("owner@example.org", { SESSION_SECRET: "too-short" }, "203.0.113.143");
    expect(auth.response.status).toBe(503);
    expect(auth.payload).toMatchObject({ code: "auth_not_configured" });
    expect(await scalar("SELECT COUNT(*) AS value FROM sessions")).toBe(0);
  });

  it("clears both member and administrator sessions when an admin signs out of My STC", async () => {
    await seedUser("user_owner", "owner@example.org", "owner");
    const auth = await signInAdmin("owner@example.org", {}, "203.0.113.144");
    const logout = await call(new Request(`${APP_ORIGIN}/api/member/logout`, {
      method: "POST",
      headers: {
        Origin: APP_ORIGIN,
        Cookie: auth.cookieHeader,
        "X-CSRF-Token": String(auth.payload.csrf_token),
      },
    }));
    expect(logout.status).toBe(200);
    const cleared = setCookieValues(logout).join("\n");
    expect(cleared).toContain("stc_member_session=;");
    expect(cleared).toContain("stc_admin_session=;");
    expect(await scalar("SELECT COUNT(*) AS value FROM member_sessions")).toBe(0);
    expect(await scalar("SELECT COUNT(*) AS value FROM sessions")).toBe(0);
    const hidden = await call(new Request(`${APP_ORIGIN}/admin`, {
      headers: { Origin: APP_ORIGIN, Cookie: auth.adminCookie },
    }));
    expect(hidden.status).toBe(404);
  });

  it("clears an admin-email STC session without requiring the protected admin logout route", async () => {
    await seedUser("user_owner", "owner@example.org", "owner");
    const auth = await signInAdmin("owner@example.org", {}, "203.0.113.145");
    await baseEnv.DB.prepare("DELETE FROM member_sessions").run();

    const logout = await call(new Request(`${APP_ORIGIN}/api/session/logout`, {
      method: "POST",
      headers: {
        Origin: APP_ORIGIN,
        Cookie: auth.cookieHeader,
      },
    }), {
      MEMBER_APPLICATION_ENABLED: "false",
      MEMBER_SCHEMA_RELEASE_READY: "false",
      ADMIN_STEP_UP_VERIFIED: "false",
      TRANSACTIONAL_EMAIL_DELIVERY_ENABLED: "false",
      EMAIL_DELIVERY_RECONCILIATION_VERIFIED: "false",
    });

    expect(logout.status).toBe(200);
    expect(await logout.json()).toMatchObject({ authenticated: false });
    const cleared = setCookieValues(logout).join("\n");
    expect(cleared).toContain("stc_member_session=;");
    expect(cleared).toContain("stc_admin_session=;");
    expect(await scalar("SELECT COUNT(*) AS value FROM member_sessions")).toBe(0);
    expect(await scalar("SELECT COUNT(*) AS value FROM sessions")).toBe(0);
    const hidden = await call(new Request(`${APP_ORIGIN}/admin`, {
      headers: { Origin: APP_ORIGIN, Cookie: auth.adminCookie },
    }));
    expect(hidden.status).toBe(404);
  });

  it("rejects cross-origin recovery sign-out without clearing STC sessions", async () => {
    await seedUser("user_owner", "owner@example.org", "owner");
    const auth = await signInAdmin("owner@example.org", {}, "203.0.113.146");
    const logout = await call(new Request(`${APP_ORIGIN}/api/session/logout`, {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        Cookie: auth.cookieHeader,
      },
    }));
    expect(logout.status).toBe(403);
    expect(await scalar("SELECT COUNT(*) AS value FROM member_sessions")).toBe(1);
    expect(await scalar("SELECT COUNT(*) AS value FROM sessions")).toBe(1);
  });

  it("uses only a __Host- cookie in production and clears the retired cookie name", async () => {
    await seedUser("user_owner", "owner@example.org", "owner");
    const productionEnv: Partial<Env> = {
      ENVIRONMENT: "production",
      APP_ORIGIN,
      REQUIRE_TURNSTILE: "false",
      MEMBER_APPLICATION_ENABLED: "true",
      MEMBER_SCHEMA_RELEASE_READY: "true",
      ADMIN_STEP_UP_VERIFIED: "true",
      TRANSACTIONAL_EMAIL_DELIVERY_ENABLED: "true",
      EMAIL_DELIVERY_RECONCILIATION_VERIFIED: "true",
    };
    const auth = await loginUser("owner@example.org", productionEnv);
    const setCookie = setCookieValues(auth.response).find((value) => value.startsWith("__Host-stc_admin_session=")) ?? "";
    expect(setCookie).toMatch(/^__Host-stc_admin_session=/);
    expect(setCookie).toContain("; Path=/");
    expect(setCookie).toContain("; Secure");
    expect(setCookie).toContain("; HttpOnly");
    expect(setCookie).toContain("; SameSite=Strict");
    expect(setCookie).not.toContain("Domain=");

    const legacyCookie = auth.cookie.replace(/^__Host-/, "");
    const legacySession = await call(new Request(`${APP_ORIGIN}/api/admin/session`, {
      headers: { Cookie: legacyCookie, Origin: APP_ORIGIN },
    }), productionEnv);
    expect(legacySession.status).toBe(401);

    const currentSession = await call(new Request(`${APP_ORIGIN}/api/admin/session`, {
      headers: { Cookie: auth.cookie, Origin: APP_ORIGIN },
    }), productionEnv);
    expect(currentSession.status).toBe(200);
    const authenticated = await currentSession.json<{ csrf_token: string }>();

    const logout = await call(new Request(`${APP_ORIGIN}/api/admin/logout`, {
      method: "POST",
      headers: {
        Cookie: auth.cookie,
        Origin: APP_ORIGIN,
        "X-CSRF-Token": authenticated.csrf_token,
      },
    }), productionEnv);
    expect(logout.status).toBe(200);
    const cleared = setCookieValues(logout).join("\n");
    expect(cleared).toContain("__Host-stc_admin_session=;");
    expect(cleared).toContain("stc_admin_session=;");
    expect(await scalar("SELECT COUNT(*) AS value FROM sessions")).toBe(0);
  });

  it("keeps the unprefixed cookie for local and test HTTP environments", async () => {
    await seedUser("user_owner", "owner@example.org", "owner");
    const auth = await loginUser("owner@example.org");
    const setCookie = setCookieValues(auth.response).find((value) => value.startsWith("stc_admin_session=")) ?? "";
    expect(setCookie).toMatch(/^stc_admin_session=/);
    expect(setCookie).not.toContain("__Host-");
    expect(setCookie).not.toContain("; Secure");
  });

  it("keeps the administrator CSRF token stable across parallel tabs", async () => {
    await seedUser("user_owner", "owner@example.org", "owner");
    const auth = await loginUser("owner@example.org");
    const first = await call(new Request(`${APP_ORIGIN}/api/admin/session`, {
      headers: { Cookie: auth.cookie, Origin: APP_ORIGIN },
    }));
    const second = await call(new Request(`${APP_ORIGIN}/api/admin/session`, {
      headers: { Cookie: auth.cookie, Origin: APP_ORIGIN },
    }));
    const firstPayload = await first.json<{ csrf_token: string }>();
    const secondPayload = await second.json<{ csrf_token: string }>();
    expect(firstPayload.csrf_token).toBe(secondPayload.csrf_token);
    const logout = await call(new Request(`${APP_ORIGIN}/api/admin/logout`, {
      method: "POST",
      headers: {
        Cookie: auth.cookie,
        Origin: APP_ORIGIN,
        "X-CSRF-Token": firstPayload.csrf_token,
      },
    }));
    expect(logout.status).toBe(200);
  });

  it("rejects a session that exceeded the idle lifetime without extending it", async () => {
    await seedUser("user_owner", "owner@example.org", "owner");
    const auth = await loginUser("owner@example.org");
    const idleAt = new Date(Date.now() - 31 * 60 * 1_000).toISOString();
    await baseEnv.DB.prepare("UPDATE sessions SET last_seen_at = ?")
      .bind(idleAt)
      .run();

    const response = await call(new Request(`${APP_ORIGIN}/api/admin/session`, {
      headers: { Cookie: auth.cookie, Origin: APP_ORIGIN },
    }), { SESSION_IDLE_TTL_SECONDS: "1800" });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "authentication_required" });
    const stored = await baseEnv.DB.prepare("SELECT last_seen_at FROM sessions")
      .first<{ last_seen_at: string }>();
    expect(stored?.last_seen_at).toBe(idleAt);
  });

  it("refreshes an active session without extending its absolute expiry", async () => {
    await seedUser("user_owner", "owner@example.org", "owner");
    const auth = await loginUser("owner@example.org");
    const activeAt = new Date(Date.now() - 20 * 60 * 1_000).toISOString();
    await baseEnv.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE user_id = 'user_owner'")
      .bind(activeAt)
      .run();
    const before = await baseEnv.DB.prepare(
      "SELECT expires_at, last_seen_at FROM sessions WHERE user_id = 'user_owner'",
    ).first<{ expires_at: string; last_seen_at: string }>();

    const requestedAt = new Date().toISOString();
    const response = await call(new Request(`${APP_ORIGIN}/api/admin/summary`, {
      headers: { Cookie: auth.cookie, Origin: APP_ORIGIN },
    }), { SESSION_IDLE_TTL_SECONDS: "1800" });

    expect(response.status).toBe(200);
    const after = await baseEnv.DB.prepare(
      "SELECT expires_at, last_seen_at FROM sessions WHERE user_id = 'user_owner'",
    ).first<{ expires_at: string; last_seen_at: string }>();
    expect(before).toBeTruthy();
    expect(after).toBeTruthy();
    expect(before!.last_seen_at).toBe(activeAt);
    expect(after!.last_seen_at >= requestedAt).toBe(true);
    expect(after!.expires_at).toBe(before!.expires_at);
  });

  it("allows editors to moderate but reserves subscriber export for owners", async () => {
    await seedUser("user_owner", "owner@example.org", "owner");
    await seedUser("user_editor", "editor@example.org", "editor");
    const now = new Date().toISOString();
    await baseEnv.DB.batch([
      baseEnv.DB.prepare(
        `INSERT INTO event_submissions (
           id, name, description, start_at, venue_name, submitter_email,
           origin, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        "eventsub_editor_test",
        "Editor moderation test",
        "A pending submission for the editor authorization test.",
        "2026-12-05T14:00:00.000Z",
        "Community Hall",
        "submitter@example.org",
        APP_ORIGIN,
        now,
        now,
      ),
      baseEnv.DB.prepare(
        `INSERT INTO subscribers (
           id, email, status, consent_at, unsubscribe_token_hash, created_at, updated_at
         ) VALUES (?, ?, 'active', ?, ?, ?, ?)`,
      ).bind("subscriber_test", "reader@example.org", now, "a".repeat(64), now, now),
    ]);

    const editor = await loginUser("editor@example.org", {}, "203.0.113.82");
    const moderated = await call(new Request(
      `${APP_ORIGIN}/api/admin/submissions/event/eventsub_editor_test/deny`,
      {
        method: "POST",
        headers: {
          Cookie: editor.cookie,
          Origin: APP_ORIGIN,
          "X-CSRF-Token": editor.csrf,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ reason: "Could not verify the organizer." }),
      },
    ));
    expect(moderated.status).toBe(200);
    const submission = await baseEnv.DB.prepare(
      "SELECT status FROM event_submissions WHERE id = 'eventsub_editor_test'",
    ).first<{ status: string }>();
    expect(submission?.status).toBe("denied");

    const editorExport = await call(new Request(`${APP_ORIGIN}/api/admin/subscribers.csv`, {
      headers: { Cookie: editor.cookie, Origin: APP_ORIGIN },
    }));
    expect(editorExport.status).toBe(403);
    expect(await editorExport.json()).toMatchObject({ code: "owner_required" });

    const owner = await loginUser("owner@example.org", {}, "203.0.113.83");
    const ownerExport = await call(new Request(`${APP_ORIGIN}/api/admin/subscribers.csv`, {
      headers: { Cookie: owner.cookie, Origin: APP_ORIGIN },
    }));
    expect(ownerExport.status).toBe(200);
    expect(await ownerExport.text()).toContain("reader@example.org");
  });
});
