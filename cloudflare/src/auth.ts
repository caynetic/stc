import { ApiError, json, positiveInteger } from "./http";
import {
  constantTimeEqual,
  csrfTokenHash,
  randomId,
  randomOpaqueToken,
  requestIpHash,
  requireSameOrigin,
  requireTrustedRequest,
  sessionTokenHash,
  userAgentHash,
} from "./security";
import type { Env, SessionContext } from "./types";

const LEGACY_COOKIE_NAME = "stc_admin_session";
const HOST_COOKIE_NAME = "__Host-stc_admin_session";

function nowIso(): string {
  return new Date().toISOString();
}

function cookieToken(request: Request, env: Env): string {
  const cookie = request.headers.get("Cookie") ?? "";
  const values = new Map<string, string>();
  for (const part of cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    values.set(name, value.join("="));
  }
  if (secureCookie(env)) {
    return values.get(HOST_COOKIE_NAME) || "";
  }
  return values.get(LEGACY_COOKIE_NAME) || "";
}

function secureCookie(env: Env): boolean {
  return env.ENVIRONMENT !== "local" && env.ENVIRONMENT !== "test";
}

function requiredAdminSecret(value: string | undefined): string {
  const secret = value ?? "";
  if (secret.length < 32) {
    throw new ApiError(503, "auth_not_configured", "Authentication is temporarily unavailable.");
  }
  return secret;
}

function sessionCookie(env: Env, token: string, maxAge: number): string {
  const name = secureCookie(env) ? HOST_COOKIE_NAME : LEGACY_COOKIE_NAME;
  return `${name}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secureCookie(env) ? "; Secure" : ""}`;
}

async function stableCsrfToken(env: Env, sessionToken: string): Promise<string> {
  return csrfTokenHash(requiredAdminSecret(env.SESSION_SECRET), `serve-the-cays/admin-csrf/v1:${sessionToken}`);
}

function clearSessionCookie(env: Env, name: string): string {
  return `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict${secureCookie(env) ? "; Secure" : ""}`;
}

export interface AdminIdentity {
  id: string;
  email: string;
  displayName: string;
  role: "owner" | "editor";
}

export interface IssuedAdminSession {
  cookie: string;
  csrfToken: string;
  user: AdminIdentity;
}

export async function adminIdentityForEmail(env: Env, email: string): Promise<AdminIdentity | null> {
  const row = await env.DB.prepare(
    `SELECT id, email, display_name AS displayName, role
     FROM users WHERE email = ? COLLATE NOCASE AND is_active = 1`,
  ).bind(email.trim().toLowerCase()).first<AdminIdentity>();
  return row ?? null;
}

export async function audit(
  env: Env,
  request: Request | null,
  eventType: string,
  actorUserId: string | null,
  subjectType = "",
  subjectId = "",
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_events (
       id, actor_user_id, event_type, subject_type, subject_id,
       ip_hash, metadata_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      randomId("audit"),
      actorUserId,
      eventType,
      subjectType,
      subjectId,
      request ? await requestIpHash(env, request) : "",
      JSON.stringify(metadata),
      nowIso(),
    )
    .run();
}

async function readSessionRecord(request: Request, env: Env): Promise<SessionContext> {
  const sessionSecret = requiredAdminSecret(env.SESSION_SECRET);
  const token = cookieToken(request, env);
  if (!token) throw new ApiError(401, "authentication_required", "Sign in to continue.");
  const hash = await sessionTokenHash(sessionSecret, token);
  const now = new Date();
  const nowValue = now.toISOString();
  const idleTtl = positiveInteger(env.SESSION_IDLE_TTL_SECONDS, 1_800, 28_800);
  const idleCutoff = new Date(now.getTime() - idleTtl * 1_000).toISOString();
  const row = await env.DB.prepare(
    `SELECT
       s.id AS sessionId,
       s.user_id AS userId,
       u.email,
       u.display_name AS displayName,
       u.role,
       s.csrf_hash AS csrfHash,
       s.expires_at AS expiresAt
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?
       AND s.expires_at > ?
       AND s.last_seen_at > ?
       AND u.is_active = 1`,
  )
    .bind(hash, nowValue, idleCutoff)
    .first<SessionContext>();
  if (!row) throw new ApiError(401, "authentication_required", "Sign in to continue.");
  await env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?")
    .bind(nowValue, row.sessionId)
    .run();
  return row;
}

export async function readSession(request: Request, env: Env): Promise<SessionContext> {
  requireTrustedRequest(request, env);
  return readSessionRecord(request, env);
}

export async function optionalAdminSession(request: Request, env: Env): Promise<SessionContext | null> {
  if (!cookieToken(request, env)) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    requireTrustedRequest(request, env);
  }
  try {
    return await readSessionRecord(request, env);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export async function requireCsrf(request: Request, env: Env, session: SessionContext): Promise<void> {
  requireSameOrigin(request, env);
  const sessionSecret = requiredAdminSecret(env.SESSION_SECRET);
  const token = request.headers.get("X-CSRF-Token")?.trim() ?? "";
  if (!token) throw new ApiError(403, "csrf_required", "The CSRF token is required.");
  const hash = await csrfTokenHash(sessionSecret, token);
  if (!constantTimeEqual(hash, session.csrfHash)) {
    throw new ApiError(403, "csrf_denied", "The CSRF token is invalid.");
  }
}

async function sessionPayload(
  request: Request,
  env: Env,
  session: SessionContext,
): Promise<Record<string, unknown>> {
  const sessionSecret = requiredAdminSecret(env.SESSION_SECRET);
  const csrfToken = await stableCsrfToken(env, cookieToken(request, env));
  const csrfHash = await csrfTokenHash(sessionSecret, csrfToken);
  if (!constantTimeEqual(csrfHash, session.csrfHash)) {
    await env.DB.prepare("UPDATE sessions SET csrf_hash = ? WHERE id = ?")
      .bind(csrfHash, session.sessionId)
      .run();
  }
  return {
    authenticated: true,
    user: { email: session.email, display_name: session.displayName, role: session.role },
    csrf_token: csrfToken,
  };
}

export async function issueAdminSessionForEmail(
  request: Request,
  env: Env,
  email: string,
): Promise<IssuedAdminSession | null> {
  requireTrustedRequest(request, env);
  const user = await adminIdentityForEmail(env, email);
  if (!user) return null;
  const sessionSecret = requiredAdminSecret(env.SESSION_SECRET);
  const token = randomOpaqueToken();
  const csrfToken = await stableCsrfToken(env, token);
  const ttl = positiveInteger(env.SESSION_TTL_SECONDS, 28_800, 604_800);
  const now = new Date();
  const sessionId = randomId("session");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO sessions (
         id, user_id, token_hash, csrf_hash, ip_hash, user_agent_hash,
         expires_at, last_seen_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      sessionId,
      user.id,
      await sessionTokenHash(sessionSecret, token),
      await csrfTokenHash(sessionSecret, csrfToken),
      await requestIpHash(env, request),
      await userAgentHash(env, request),
      new Date(now.getTime() + ttl * 1000).toISOString(),
      now.toISOString(),
      now.toISOString(),
    ),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now.toISOString()),
  ]);
  await audit(env, request, "auth.magic_link_succeeded", user.id, "session", sessionId);
  return {
    cookie: sessionCookie(env, token, ttl),
    csrfToken,
    user,
  };
}

export async function revokeAdminSession(request: Request, env: Env): Promise<string[]> {
  const token = cookieToken(request, env);
  if (token) {
    const hash = await sessionTokenHash(requiredAdminSecret(env.SESSION_SECRET), token);
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(hash).run();
  }
  return adminSessionClearCookies(env);
}

export function adminSessionClearCookies(env: Env): string[] {
  const primaryName = secureCookie(env) ? HOST_COOKIE_NAME : LEGACY_COOKIE_NAME;
  return [
    clearSessionCookie(env, primaryName),
    ...(secureCookie(env) ? [clearSessionCookie(env, LEGACY_COOKIE_NAME)] : []),
  ];
}

export async function revokeAdminSessionBestEffort(request: Request, env: Env): Promise<string[]> {
  const cookies = adminSessionClearCookies(env);
  try {
    const token = cookieToken(request, env);
    if (token) {
      const hash = await sessionTokenHash(requiredAdminSecret(env.SESSION_SECRET), token);
      await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(hash).run();
    }
  } catch (error) {
    console.error(JSON.stringify({
      event: "admin_session_revocation_failed_during_signout",
      message: error instanceof Error ? error.message : "Unknown admin session revocation failure",
    }));
  }
  return cookies;
}

export async function session(request: Request, env: Env): Promise<Response> {
  const current = await readSession(request, env);
  return json(await sessionPayload(request, env, current));
}

export async function logout(request: Request, env: Env): Promise<Response> {
  const current = await readSession(request, env);
  await requireCsrf(request, env, current);
  await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(current.sessionId).run();
  await audit(env, request, "auth.logout", current.userId, "session", current.sessionId);
  const primaryName = secureCookie(env) ? HOST_COOKIE_NAME : LEGACY_COOKIE_NAME;
  const response = json(
    { authenticated: false },
    200,
    { "Set-Cookie": clearSessionCookie(env, primaryName) },
  );
  if (secureCookie(env)) {
    response.headers.append("Set-Cookie", clearSessionCookie(env, LEGACY_COOKIE_NAME));
  }
  return response;
}
