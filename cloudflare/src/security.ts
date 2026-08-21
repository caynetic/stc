import { ApiError, parseBoolean, positiveInteger } from "./http";
import type { Env } from "./types";

interface TurnstileResult {
  success?: boolean;
  hostname?: string;
  action?: string;
}

const encoder = new TextEncoder();
const TURNSTILE_ALWAYS_PASS_TEST_SITE_KEY = "1x00000000000000000000AA";
const TURNSTILE_TOKEN_MAX_LENGTH = 2_048;
const TURNSTILE_TIMEOUT_MS = 5_000;

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmacBytes(key: string, value: string | ArrayBuffer): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const input = typeof value === "string" ? encoder.encode(value) : value;
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, input));
}

export async function hmacSha256Hex(key: string, value: string | ArrayBuffer): Promise<string> {
  return bytesToHex(await hmacBytes(key, value));
}

export async function keyedHash(key: string, context: string, value: string): Promise<string> {
  return bytesToHex(await hmacBytes(key, `${context}:${value}`));
}

export async function sha256Hex(value: ArrayBuffer | string): Promise<string> {
  const input = typeof value === "string" ? encoder.encode(value) : value;
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", input)));
}

export async function sessionTokenHash(secret: string, token: string): Promise<string> {
  return keyedHash(secret, "serve-the-cays/session/v1", token);
}

export async function csrfTokenHash(secret: string, token: string): Promise<string> {
  return keyedHash(secret, "serve-the-cays/csrf/v1", token);
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  const workersSubtle = crypto.subtle as typeof crypto.subtle & {
    timingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean;
  };
  return workersSubtle.timingSafeEqual(leftBytes, rightBytes);
}

export function randomOpaqueToken(bytes = 32): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP")?.trim() || "unknown";
}

export function expectedOrigin(env: Env): string {
  const origin = env.APP_ORIGIN?.trim();
  if (!origin) throw new ApiError(503, "not_configured", "The application is temporarily unavailable.");
  return origin.replace(/\/$/, "");
}

export function requireSameOrigin(request: Request, env: Env): void {
  const expected = expectedOrigin(env);
  const origin = request.headers.get("Origin")?.trim() ?? "";
  if (origin !== expected) {
    throw new ApiError(403, "origin_denied", "This request must come from Serve the Cays.");
  }
}

export function requireTrustedRequest(request: Request, env: Env): void {
  const expected = expectedOrigin(env);
  const origin = request.headers.get("Origin")?.trim() ?? "";
  if (origin && origin !== expected) {
    throw new ApiError(403, "origin_denied", "This request must come from Serve the Cays.");
  }
  const fetchSite = request.headers.get("Sec-Fetch-Site")?.trim().toLowerCase() ?? "";
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new ApiError(403, "origin_denied", "This request must come from Serve the Cays.");
  }
  const referer = request.headers.get("Referer")?.trim() ?? "";
  if (referer) {
    try {
      if (new URL(referer).origin !== expected) throw new Error();
    } catch {
      throw new ApiError(403, "origin_denied", "This request must come from Serve the Cays.");
    }
  }
}

export async function requestIpHash(env: Env, request: Request): Promise<string> {
  if (!env.IP_HASH_KEY) throw new ApiError(503, "not_configured", "The form is temporarily unavailable.");
  return keyedHash(env.IP_HASH_KEY, "serve-the-cays/ip/v1", clientIp(request));
}

export async function userAgentHash(env: Env, request: Request): Promise<string> {
  if (!env.SESSION_SECRET) return "";
  return keyedHash(
    env.SESSION_SECRET,
    "serve-the-cays/user-agent/v1",
    request.headers.get("User-Agent") ?? "",
  );
}

export async function enforceRateLimit(
  env: Env,
  scope: string,
  identity: string,
  limit: number,
): Promise<void> {
  if (!env.RATE_LIMIT_HASH_KEY) {
    throw new ApiError(503, "not_configured", "The service is temporarily unavailable.");
  }
  const windowSeconds = positiveInteger(env.RATE_LIMIT_WINDOW_SECONDS, 300, 86_400);
  const now = new Date();
  const nowIso = now.toISOString();
  const cutoff = new Date(now.getTime() - windowSeconds * 1000).toISOString();
  const key = `stc:${await keyedHash(env.RATE_LIMIT_HASH_KEY, scope, identity || "unknown")}`;
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, window_started_at, count, updated_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_started_at <= ? THEN 1 ELSE rate_limits.count + 1 END,
       window_started_at = CASE WHEN rate_limits.window_started_at <= ? THEN excluded.window_started_at ELSE rate_limits.window_started_at END,
       updated_at = excluded.updated_at
     RETURNING count`,
  )
    .bind(key, nowIso, nowIso, cutoff, cutoff)
    .first<{ count: number }>();
  if (Number(row?.count ?? 1) > limit) {
    throw new ApiError(429, "rate_limited", "There have been too many attempts. Please wait and try again.");
  }
}

export async function purgeExpiredRateLimits(env: Env, now = new Date()): Promise<number> {
  const windowSeconds = positiveInteger(env.RATE_LIMIT_WINDOW_SECONDS, 300, 86_400);
  const cutoff = new Date(now.getTime() - windowSeconds * 2 * 1000).toISOString();
  const result = await env.DB.prepare("DELETE FROM rate_limits WHERE updated_at <= ?")
    .bind(cutoff)
    .run();
  return Number(result.meta.changes ?? 0);
}

export async function verifyTurnstile(
  fields: Record<string, string>,
  request: Request,
  env: Env,
  action: string,
  secret: string | undefined,
): Promise<void> {
  if (!parseBoolean(env.REQUIRE_TURNSTILE, true)) return;
  if (!secret) throw new ApiError(503, "turnstile_not_configured", "The form is temporarily unavailable.");
  const token = (fields["cf-turnstile-response"] ?? fields.turnstile_token ?? "").trim();
  if (!token) throw new ApiError(400, "turnstile_required", "Complete the security check.");
  if (token.length > TURNSTILE_TOKEN_MAX_LENGTH) {
    throw new ApiError(400, "turnstile_invalid", "The security check response is invalid.");
  }
  const body = new FormData();
  body.set("secret", secret);
  body.set("response", token);
  body.set("remoteip", clientIp(request));
  body.set("idempotency_key", crypto.randomUUID());
  let response: Response;
  try {
    response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
      signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
    });
  } catch (error) {
    console.error("Turnstile verification request failed", {
      name: error instanceof Error ? error.name : "unknown",
      message: error instanceof Error ? error.message : "unknown",
    });
    throw new ApiError(503, "turnstile_unavailable", "The security check is temporarily unavailable.");
  }
  if (!response.ok) {
    let errorCodes: string[] = [];
    try {
      const payload = (await response.json()) as { "error-codes"?: unknown };
      if (Array.isArray(payload["error-codes"])) {
        errorCodes = payload["error-codes"].filter((value): value is string => typeof value === "string").slice(0, 3);
      }
    } catch {
      // The external response status remains the diagnostic if its expected JSON cannot be decoded.
    }
    console.error("Turnstile verification response was not successful", { status: response.status, errorCodes });
    throw new ApiError(503, "turnstile_unavailable", "The security check is temporarily unavailable.");
  }
  let result: TurnstileResult;
  try {
    result = (await response.json()) as TurnstileResult;
  } catch (error) {
    console.error("Turnstile verification response could not be decoded", {
      name: error instanceof Error ? error.name : "unknown",
      message: error instanceof Error ? error.message : "unknown",
    });
    throw new ApiError(503, "turnstile_unavailable", "The security check is temporarily unavailable.");
  }
  const hostname = new URL(expectedOrigin(env)).hostname.toLowerCase();
  const automatedPreview =
    env.ENVIRONMENT === "preview" &&
    env.TURNSTILE_SITE_KEY === TURNSTILE_ALWAYS_PASS_TEST_SITE_KEY;
  if (
    !result.success ||
    (!automatedPreview && (result.action !== action || result.hostname?.toLowerCase() !== hostname))
  ) {
    throw new ApiError(403, "turnstile_denied", "The security check could not be verified.");
  }
}

export function slugify(value: string, maximum = 100): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maximum)
    .replace(/-+$/g, "");
  return normalized || "listing";
}

export async function idempotencyHash(
  env: Env,
  scope: string,
  supplied: string,
  fingerprint: string,
): Promise<string> {
  if (!env.RATE_LIMIT_HASH_KEY) throw new ApiError(503, "not_configured", "The form is temporarily unavailable.");
  const value = supplied.trim().slice(0, 200) || fingerprint;
  return keyedHash(env.RATE_LIMIT_HASH_KEY, `serve-the-cays/idempotency/${scope}`, value);
}

export interface SubmissionIdempotency {
  dedupeHash: string | null;
  keyHash: string | null;
  payloadFingerprintHash: string | null;
}

export async function submissionIdempotency(
  env: Env,
  scope: string,
  supplied: string,
  fingerprint: string,
): Promise<SubmissionIdempotency> {
  if (!env.RATE_LIMIT_HASH_KEY) {
    throw new ApiError(503, "not_configured", "The form is temporarily unavailable.");
  }
  const callerKey = supplied.trim().slice(0, 200);
  if (!callerKey) {
    return {
      dedupeHash: await idempotencyHash(env, scope, "", fingerprint),
      keyHash: null,
      payloadFingerprintHash: null,
    };
  }
  const context = `serve-the-cays/idempotency/${scope}`;
  const [keyHash, payloadFingerprintHash] = await Promise.all([
    keyedHash(env.RATE_LIMIT_HASH_KEY, `${context}/key`, callerKey),
    keyedHash(env.RATE_LIMIT_HASH_KEY, `${context}/payload`, fingerprint),
  ]);
  return { dedupeHash: null, keyHash, payloadFingerprintHash };
}
