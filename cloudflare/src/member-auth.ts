import { queueEmail, queueEmailStatement, transactionalEmailDeliveryEnabled } from "./email";
import {
  adminIdentityForEmail,
  issueAdminSessionForEmail,
  revokeAdminSession,
  revokeAdminSessionBestEffort,
} from "./auth";
import { ApiError, json, positiveInteger, readJson } from "./http";
import { resolveNewsletterCustomizeToken } from "./newsletter";
import {
  clientIp,
  constantTimeEqual,
  enforceRateLimit,
  expectedOrigin,
  keyedHash,
  randomId,
  randomOpaqueToken,
  requestIpHash,
  requireSameOrigin,
  requireTrustedRequest,
  sha256Hex,
  verifyTurnstile,
} from "./security";
import type { Env } from "./types";

const LEGACY_COOKIE_NAME = "stc_member_session";
const HOST_COOKIE_NAME = "__Host-stc_member_session";

export interface MemberSessionContext {
  sessionId: string;
  memberId: string;
  email: string;
  displayName: string;
  reminderEmailsEnabled: boolean;
  csrfHash: string;
  expiresAt: string;
  createdAt: string;
}

interface MemberSessionRow {
  sessionId: string;
  memberId: string;
  email: string;
  displayName: string;
  reminderEmailsEnabled: number;
  csrfHash: string;
  expiresAt: string;
  createdAt: string;
}

interface MagicLinkRow {
  id: string;
  email: string;
  return_path: string;
  pending_action_json: string;
  expires_at: string;
}

interface PendingAction {
  type: "favorite_organization" | "favorite_event" | "rsvp_event";
  targetId: string;
}

function secureCookie(env: Env): boolean {
  return env.ENVIRONMENT !== "local" && env.ENVIRONMENT !== "test";
}

function memberSecret(env: Env): string {
  const secret = env.MEMBER_SESSION_SECRET?.trim()
    || ((env.ENVIRONMENT === "local" || env.ENVIRONMENT === "test")
      ? env.SESSION_SECRET?.trim()
      : "");
  if (!secret || secret.length < 32) {
    throw new ApiError(503, "member_auth_not_configured", "Member sign-in is temporarily unavailable.");
  }
  return secret;
}

function cookieToken(request: Request, env: Env): string {
  const wanted = secureCookie(env) ? HOST_COOKIE_NAME : LEGACY_COOKIE_NAME;
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === wanted) return value.join("=");
  }
  return "";
}

function sessionCookie(env: Env, token: string, maximumAge: number): string {
  const name = secureCookie(env) ? HOST_COOKIE_NAME : LEGACY_COOKIE_NAME;
  return `${name}=${token}; Path=/; Max-Age=${maximumAge}; HttpOnly; SameSite=Lax${secureCookie(env) ? "; Secure" : ""}`;
}

function clearCookie(env: Env, name: string): string {
  return `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax${secureCookie(env) ? "; Secure" : ""}`;
}

function memberSessionClearCookies(env: Env): string[] {
  const primaryName = secureCookie(env) ? HOST_COOKIE_NAME : LEGACY_COOKIE_NAME;
  return [
    clearCookie(env, primaryName),
    ...(secureCookie(env) ? [clearCookie(env, LEGACY_COOKIE_NAME)] : []),
  ];
}

async function memberSessionHash(env: Env, token: string): Promise<string> {
  return keyedHash(memberSecret(env), "serve-the-cays/member-session/v1", token);
}

async function memberCsrfHash(env: Env, token: string): Promise<string> {
  return keyedHash(memberSecret(env), "serve-the-cays/member-csrf/v1", token);
}

async function memberCsrfToken(env: Env, sessionToken: string): Promise<string> {
  return keyedHash(memberSecret(env), "serve-the-cays/member-csrf-token/v1", sessionToken);
}

function validEmail(value: unknown): string {
  if (typeof value !== "string") return "";
  const email = value.trim().toLowerCase().slice(0, 254);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "";
  return email;
}

export function safeMemberReturnPath(value: unknown): string {
  if (typeof value !== "string") return "/me";
  const candidate = value.trim().slice(0, 500);
  if (!candidate.startsWith("/") || candidate.startsWith("//") || /[\\\r\n]/.test(candidate)) return "/me";
  let url: URL;
  try {
    url = new URL(candidate, "https://servethecays.invalid");
  } catch {
    return "/me";
  }
  const exact = new Set([
    "/", "/me", "/admin", "/organizations", "/events", "/about", "/privacy",
    "/suggest/organization", "/suggest/event",
  ]);
  if (
    exact.has(url.pathname) ||
    /^\/organization\/[A-Za-z0-9_-]+$/.test(url.pathname) ||
    /^\/event\/\d+$/.test(url.pathname)
  ) return `${url.pathname}${url.search}`;
  return "/me";
}

function pendingAction(body: Record<string, unknown>): PendingAction | null {
  const type = typeof body.intent_type === "string" ? body.intent_type : "";
  const targetId = typeof body.target_id === "string" ? body.target_id.trim().slice(0, 100) : "";
  if (!targetId || !["favorite_organization", "favorite_event", "rsvp_event"].includes(type)) return null;
  if (type === "favorite_organization" && /^[A-Za-z0-9_-]+$/.test(targetId)) {
    return { type, targetId };
  }
  if ((type === "favorite_event" || type === "rsvp_event") && /^\d+$/.test(targetId)) {
    return { type, targetId };
  }
  return null;
}

function parsedPendingAction(value: string): PendingAction | null {
  try {
    const candidate = JSON.parse(value) as Record<string, unknown>;
    return pendingAction({ intent_type: candidate.type, target_id: candidate.targetId });
  } catch {
    return null;
  }
}

function genericMagicLinkResponse(developmentSignInUrl?: string): Response {
  return json({
    status: "success",
    message: "If that address can receive mail, a sign-in link is on its way.",
    ...(developmentSignInUrl ? { development_sign_in_url: developmentSignInUrl } : {}),
  });
}

export async function requestMemberMagicLink(request: Request, env: Env): Promise<Response> {
  requireSameOrigin(request, env);
  memberSecret(env);
  const body = await readJson(request);
  const typedEmail = validEmail(body.email);
  const rawSubscriberToken = typeof body.subscriber_token === "string"
    ? body.subscriber_token.trim().slice(0, 256)
    : "";
  const subscriberToken = /^[A-Za-z0-9_-]{32,256}$/.test(rawSubscriberToken)
    ? rawSubscriberToken
    : "";
  const turnstileToken = typeof body.turnstile_token === "string" ? body.turnstile_token : "";
  await enforceRateLimit(
    env,
    "member-login-ip",
    clientIp(request),
    positiveInteger(env.MEMBER_LOGIN_IP_LIMIT, 10, 100),
  );
  await verifyTurnstile(
    { turnstile_token: turnstileToken },
    request,
    env,
    "member_signin",
    env.TURNSTILE_MEMBER_SECRET,
  );
  const email = subscriberToken
    ? validEmail(await resolveNewsletterCustomizeToken(env, subscriberToken))
    : typedEmail;
  await enforceRateLimit(
    env,
    "member-login-email",
    email || (subscriberToken ? await sha256Hex(subscriberToken) : "invalid"),
    positiveInteger(env.MEMBER_LOGIN_EMAIL_LIMIT, 5, 100),
  );
  if (!email) return genericMagicLinkResponse();
  if (!transactionalEmailDeliveryEnabled(env)) {
    throw new ApiError(503, "email_unavailable", "Email delivery is not enabled in this environment.");
  }

  const token = randomOpaqueToken(32);
  const now = new Date();
  const ttl = positiveInteger(env.MEMBER_MAGIC_LINK_TTL_SECONDS, 900, 3_600);
  const id = randomId("magic");
  const returnPath = safeMemberReturnPath(body.return_path);
  const action = pendingAction(body);
  const previewUrl = `${expectedOrigin(env)}/signin/verify#token=${encodeURIComponent(token)}`;
  await env.DB.prepare(
    `INSERT INTO member_magic_links (
       id, email, token_hash, return_path, pending_action_json, ip_hash,
       expires_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    email,
    await sha256Hex(token),
    returnPath,
    JSON.stringify(action ?? {}),
    await requestIpHash(env, request),
    new Date(now.getTime() + ttl * 1_000).toISOString(),
    now.toISOString(),
  ).run();
  await queueEmail(env, {
    kind: "magic_link",
    recipientEmail: email,
    subjectType: "member_magic_link",
    subjectId: id,
    idempotencyKey: `magic-link:${id}`,
    payload: { sign_in_url: previewUrl, expires_minutes: Math.ceil(ttl / 60) },
  });
  return genericMagicLinkResponse(
    env.ENVIRONMENT === "local" || env.ENVIRONMENT === "test" ? previewUrl : undefined,
  );
}

async function applyPendingActionStatements(
  env: Env,
  memberEmail: string,
  action: PendingAction | null,
  now: string,
): Promise<D1PreparedStatement[]> {
  if (!action) return [];
  if (action.type === "favorite_organization") {
    return [env.DB.prepare(
      `INSERT INTO organization_favorites (member_id, organization_id, created_at)
       SELECT m.id, o.id, ?
       FROM members m JOIN organizations o ON o.id = ? AND o.is_active = 1
       WHERE m.email = ?
       ON CONFLICT(member_id, organization_id) DO NOTHING`,
    ).bind(now, action.targetId, memberEmail)];
  }
  const eventId = Number(action.targetId);
  if (action.type === "favorite_event") {
    return [env.DB.prepare(
      `INSERT INTO event_favorites (member_id, event_id, created_at)
       SELECT m.id, e.id, ?
       FROM members m JOIN events e
         ON e.id = ? AND e.is_active = 1 AND COALESCE(e.end_at, e.start_at) > ?
       WHERE m.email = ?
       ON CONFLICT(member_id, event_id) DO NOTHING`,
    ).bind(now, eventId, now, memberEmail)];
  }
  const event = await env.DB.prepare(
    `SELECT id, name, start_at, end_at, timezone, venue_name, location_display
     FROM events
     WHERE id = ? AND is_active = 1
       AND COALESCE(end_at, start_at) > ?`,
  ).bind(eventId, now).first<Record<string, unknown>>();
  if (!event) return [];
  return [
    env.DB.prepare(
      `INSERT INTO event_rsvps (
         member_id, event_id, status, reminder_sent_at, created_at, updated_at
       ) SELECT id, ?, 'going', NULL, ?, ? FROM members WHERE email = ?
       ON CONFLICT(member_id, event_id) DO UPDATE SET
         status = 'going',
         transition_count = CASE
           WHEN event_rsvps.status <> 'going' THEN event_rsvps.transition_count + 1
           ELSE event_rsvps.transition_count
         END,
         reminder_sent_at = CASE
           WHEN event_rsvps.status <> 'going' THEN NULL
           ELSE event_rsvps.reminder_sent_at
         END,
         updated_at = CASE
           WHEN event_rsvps.status <> 'going' THEN excluded.updated_at
           ELSE event_rsvps.updated_at
         END`,
    ).bind(eventId, now, now, memberEmail),
  ];
}

export async function consumeMemberMagicLink(request: Request, env: Env): Promise<Response> {
  requireSameOrigin(request, env);
  const secret = memberSecret(env);
  const body = await readJson(request);
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) {
    throw new ApiError(400, "magic_link_invalid", "This sign-in link is invalid or has expired.");
  }
  const now = new Date();
  const nowIso = now.toISOString();
  const row = await env.DB.prepare(
    `SELECT id, email, return_path, pending_action_json, expires_at
     FROM member_magic_links
     WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
  ).bind(await sha256Hex(token), nowIso).first<MagicLinkRow>();
  if (!row) throw new ApiError(400, "magic_link_invalid", "This sign-in link is invalid or has expired.");
  const existing = await env.DB.prepare("SELECT id FROM members WHERE email = ?")
    .bind(row.email)
    .first<{ id: string }>();
  const proposedMemberId = existing?.id ?? randomId("member");
  const firstLogin = !existing;
  const sessionToken = randomOpaqueToken(32);
  const csrfToken = await memberCsrfToken(env, sessionToken);
  const absoluteTtl = positiveInteger(env.MEMBER_SESSION_TTL_SECONDS, 2_592_000, 2_592_000);
  const sessionId = randomId("membersession");
  const action = parsedPendingAction(row.pending_action_json);
  const actionAllowed = action?.type === "favorite_organization"
    ? Boolean(await env.DB.prepare(
        "SELECT 1 AS found FROM organizations WHERE id = ? AND is_active = 1",
      ).bind(action.targetId).first())
    : action
      ? Boolean(await env.DB.prepare(
          `SELECT 1 AS found FROM events
           WHERE id = ? AND is_active = 1 AND COALESCE(end_at, start_at) > ?`,
        ).bind(Number(action.targetId), nowIso).first())
      : false;
  const actionStatements = await applyPendingActionStatements(
    env,
    row.email,
    actionAllowed ? action : null,
    nowIso,
  );
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO members (id, email, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET updated_at = excluded.updated_at`,
      ).bind(proposedMemberId, row.email, nowIso, nowIso),
      env.DB.prepare(
        `INSERT INTO member_sessions (
           id, member_id, magic_link_id, token_hash, csrf_hash, ip_hash, user_agent_hash,
           expires_at, last_seen_at, created_at
         ) SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, ? FROM members WHERE email = ?`,
      ).bind(
        sessionId,
        row.id,
        await memberSessionHash(env, sessionToken),
        await memberCsrfHash(env, csrfToken),
        await requestIpHash(env, request),
        await keyedHash(secret, "serve-the-cays/member-user-agent/v1", request.headers.get("User-Agent") ?? ""),
        new Date(now.getTime() + absoluteTtl * 1_000).toISOString(),
        nowIso,
        nowIso,
        row.email,
      ),
      env.DB.prepare(
        `UPDATE subscribers
         SET member_id = (SELECT id FROM members WHERE email = ? COLLATE NOCASE),
             updated_at = ?
         WHERE email = ? COLLATE NOCASE AND status = 'active'
           AND (
             member_id IS NULL
             OR member_id = (SELECT id FROM members WHERE email = ? COLLATE NOCASE)
           )`,
      ).bind(row.email, nowIso, row.email, row.email),
      ...(firstLogin ? [queueEmailStatement(env, {
        kind: "welcome",
        recipientEmail: row.email,
        subjectType: "member",
        subjectId: await sha256Hex(row.email),
        idempotencyKey: `welcome:${await sha256Hex(row.email)}`,
        payload: {},
      })] : []),
      ...actionStatements,
      env.DB.prepare(
        `UPDATE member_magic_links SET consumed_at = ?
         WHERE id = ? AND consumed_at IS NULL AND expires_at > ?`,
      ).bind(nowIso, row.id, nowIso),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("magic link unavailable") || message.includes("member_sessions.magic_link_id")) {
      throw new ApiError(400, "magic_link_invalid", "This sign-in link is invalid or has expired.");
    }
    throw error;
  }

  const member = await env.DB.prepare(
    "SELECT id, email, display_name, reminder_emails_enabled, legacy_favorites_imported_at FROM members WHERE email = ?",
  ).bind(row.email).first<Record<string, unknown>>();
  if (!member?.id) throw new ApiError(500, "member_session_failed", "Member sign-in could not be completed.");
  const memberId = String(member.id);
  const adminSession = await issueAdminSessionForEmail(request, env, row.email);
  const requestedReturnPath = safeMemberReturnPath(row.return_path);
  const redirectTo = requestedReturnPath === "/admin" && !adminSession
    ? "/me"
    : requestedReturnPath;
  const response = json({
    authenticated: true,
    member,
    admin: adminSession
      ? { authorized: true, role: adminSession.user.role, display_name: adminSession.user.displayName }
      : { authorized: false },
    csrf_token: csrfToken,
    redirect_to: redirectTo,
    pending_action_completed: Boolean(action && actionAllowed),
  }, 200, { "Set-Cookie": sessionCookie(env, sessionToken, absoluteTtl) });
  if (adminSession) response.headers.append("Set-Cookie", adminSession.cookie);
  return response;
}

async function readMemberSessionRecord(request: Request, env: Env): Promise<MemberSessionContext> {
  const token = cookieToken(request, env);
  if (!token) throw new ApiError(401, "authentication_required", "Sign in to continue.");
  const now = new Date();
  const nowIso = now.toISOString();
  const idleTtl = positiveInteger(env.MEMBER_SESSION_IDLE_TTL_SECONDS, 604_800, 604_800);
  const idleCutoff = new Date(now.getTime() - idleTtl * 1_000).toISOString();
  const row = await env.DB.prepare(
    `SELECT
       s.id AS sessionId, s.member_id AS memberId, m.email,
       m.display_name AS displayName,
       m.reminder_emails_enabled AS reminderEmailsEnabled,
       s.csrf_hash AS csrfHash, s.expires_at AS expiresAt, s.created_at AS createdAt
     FROM member_sessions s
     JOIN members m ON m.id = s.member_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND s.last_seen_at > ?`,
  ).bind(await memberSessionHash(env, token), nowIso, idleCutoff).first<MemberSessionRow>();
  if (!row) throw new ApiError(401, "authentication_required", "Sign in to continue.");
  await env.DB.prepare("UPDATE member_sessions SET last_seen_at = ? WHERE id = ?")
    .bind(nowIso, row.sessionId)
    .run();
  return {
    ...row,
    reminderEmailsEnabled: Boolean(row.reminderEmailsEnabled),
  };
}

export async function readMemberSession(request: Request, env: Env): Promise<MemberSessionContext> {
  requireTrustedRequest(request, env);
  return readMemberSessionRecord(request, env);
}

export async function optionalMemberSession(request: Request, env: Env): Promise<MemberSessionContext | null> {
  if (!cookieToken(request, env)) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    requireTrustedRequest(request, env);
  }
  try {
    return await readMemberSessionRecord(request, env);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export const requireMemberSession = readMemberSession;

export async function requireMemberCsrf(
  request: Request,
  env: Env,
  session: MemberSessionContext,
): Promise<void> {
  requireSameOrigin(request, env);
  const token = request.headers.get("X-CSRF-Token")?.trim() ?? "";
  if (!token) throw new ApiError(403, "csrf_required", "The CSRF token is required.");
  if (!constantTimeEqual(await memberCsrfHash(env, token), session.csrfHash)) {
    throw new ApiError(403, "csrf_denied", "The CSRF token is invalid.");
  }
}

async function sessionPayload(
  request: Request,
  env: Env,
  current: MemberSessionContext,
): Promise<Record<string, unknown>> {
  const csrfToken = await memberCsrfToken(env, cookieToken(request, env));
  const admin = await adminIdentityForEmail(env, current.email);
  return {
    authenticated: true,
    member: {
      id: current.memberId,
      email: current.email,
      display_name: current.displayName,
      reminder_emails_enabled: current.reminderEmailsEnabled,
    },
    admin: admin
      ? { authorized: true, role: admin.role, display_name: admin.displayName }
      : { authorized: false },
    csrf_token: csrfToken,
  };
}

export async function memberSession(request: Request, env: Env): Promise<Response> {
  if (!cookieToken(request, env)) return json({ authenticated: false });
  return json(await sessionPayload(request, env, await readMemberSession(request, env)));
}

export async function logoutMember(request: Request, env: Env): Promise<Response> {
  const current = await readMemberSession(request, env);
  await requireMemberCsrf(request, env, current);
  await env.DB.prepare("DELETE FROM member_sessions WHERE id = ?").bind(current.sessionId).run();
  const adminCookies = await revokeAdminSession(request, env);
  const primaryName = secureCookie(env) ? HOST_COOKIE_NAME : LEGACY_COOKIE_NAME;
  const response = json({ authenticated: false }, 200, {
    "Set-Cookie": clearCookie(env, primaryName),
  });
  if (secureCookie(env)) response.headers.append("Set-Cookie", clearCookie(env, LEGACY_COOKIE_NAME));
  for (const cookie of adminCookies) response.headers.append("Set-Cookie", cookie);
  return response;
}

export async function logoutStcSessions(request: Request, env: Env): Promise<Response> {
  requireSameOrigin(request, env);
  const memberCookies = memberSessionClearCookies(env);
  const memberToken = cookieToken(request, env);
  try {
    if (memberToken) {
      await env.DB.prepare("DELETE FROM member_sessions WHERE token_hash = ?")
        .bind(await memberSessionHash(env, memberToken))
        .run();
    }
  } catch (error) {
    console.error(JSON.stringify({
      event: "member_session_revocation_failed_during_signout",
      message: error instanceof Error ? error.message : "Unknown member session revocation failure",
    }));
  }
  const adminCookies = await revokeAdminSessionBestEffort(request, env);
  const response = json({ authenticated: false });
  for (const cookie of [...memberCookies, ...adminCookies]) response.headers.append("Set-Cookie", cookie);
  return response;
}

export async function purgeExpiredMemberAuth(env: Env, now = new Date()): Promise<number> {
  const nowIso = now.toISOString();
  const magicCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString();
  const idleTtl = positiveInteger(env.MEMBER_SESSION_IDLE_TTL_SECONDS, 604_800, 604_800);
  const idleCutoff = new Date(now.getTime() - idleTtl * 1_000).toISOString();
  const [links, sessions] = await env.DB.batch([
    env.DB.prepare("DELETE FROM member_magic_links WHERE expires_at <= ?").bind(magicCutoff),
    env.DB.prepare("DELETE FROM member_sessions WHERE expires_at <= ? OR last_seen_at <= ?")
      .bind(nowIso, idleCutoff),
  ]);
  return Number(links.meta.changes ?? 0) + Number(sessions.meta.changes ?? 0);
}
