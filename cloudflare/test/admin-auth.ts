import { env } from "cloudflare:workers";
import { expect } from "vitest";

import worker from "../src/index";
import type { Env } from "../src/types";

export const TEST_APP_ORIGIN = "https://servethecays.test";
const baseEnv = env as unknown as Env;

export async function seedAdmin(
  id: string,
  email: string,
  role: "owner" | "editor" = "owner",
  active = true,
): Promise<void> {
  const now = new Date().toISOString();
  await baseEnv.DB.prepare(
    `INSERT INTO users (
       id, email, display_name, role, password_algorithm, password_iterations,
       password_salt, password_hash, is_active, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'magic-link-only', 100000, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    email,
    role === "owner" ? "Directory Owner" : "Directory Editor",
    role,
    `test-magic-link-only-salt-${id}`,
    "0".repeat(64),
    active ? 1 : 0,
    now,
    now,
  ).run();
}

export function setCookieValues(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  return headers.getSetCookie?.() ?? [headers.get("Set-Cookie") ?? ""];
}

function cookiePair(response: Response, name: string): string {
  const value = setCookieValues(response).find((cookie) => cookie.startsWith(`${name}=`)) ?? "";
  return value.split(";")[0];
}

export async function signInAdmin(
  email: string,
  overrides: Partial<Env> = {},
  ip = "203.0.113.80",
): Promise<{
  adminCookie: string;
  memberCookie: string;
  cookieHeader: string;
  csrf: string;
  response: Response;
  payload: Record<string, any>;
}> {
  const requestResponse = await worker.fetch(new Request(`${TEST_APP_ORIGIN}/api/member/auth/request`, {
    method: "POST",
    headers: {
      Origin: TEST_APP_ORIGIN,
      "Content-Type": "application/json",
      "CF-Connecting-IP": ip,
    },
    body: JSON.stringify({ email, return_path: "/admin" }),
  }), baseEnv);
  expect(requestResponse.status).toBe(200);
  const requestPayload = await requestResponse.json<Record<string, any>>();
  const token = new URL(String(requestPayload.development_sign_in_url)).hash.replace(/^#token=/, "");
  expect(token).toMatch(/^[A-Za-z0-9_-]{40,100}$/);

  const response = await worker.fetch(new Request(`${TEST_APP_ORIGIN}/api/member/auth/consume`, {
    method: "POST",
    headers: {
      Origin: TEST_APP_ORIGIN,
      "Content-Type": "application/json",
      "CF-Connecting-IP": ip,
    },
    body: JSON.stringify({ token }),
  }), { ...baseEnv, ...overrides });
  const payload = await response.clone().json<Record<string, any>>().catch(() => ({}));
  if (!response.ok) {
    return { adminCookie: "", memberCookie: "", cookieHeader: "", csrf: "", response, payload };
  }

  const secure = overrides.ENVIRONMENT === "production" || overrides.ENVIRONMENT === "preview";
  const adminCookie = cookiePair(response, secure ? "__Host-stc_admin_session" : "stc_admin_session");
  const memberCookie = cookiePair(response, secure ? "__Host-stc_member_session" : "stc_member_session");
  const cookieHeader = [memberCookie, adminCookie].filter(Boolean).join("; ");
  if (!adminCookie) {
    return { adminCookie, memberCookie, cookieHeader, csrf: "", response, payload };
  }
  const sessionResponse = await worker.fetch(new Request(`${TEST_APP_ORIGIN}/api/admin/session`, {
    headers: { Origin: TEST_APP_ORIGIN, Cookie: adminCookie },
  }), { ...baseEnv, ...overrides });
  expect(sessionResponse.status).toBe(200);
  const session = await sessionResponse.json<{ csrf_token: string }>();
  return { adminCookie, memberCookie, cookieHeader, csrf: session.csrf_token, response, payload };
}
