import {
  buildNewsletterConfirmationMessage,
  buildNewsletterMessage,
  findForwardEmailByReference,
  ForwardEmailDeliveryError,
  retrieveForwardEmailStatus,
  sendNewsletterConfirmationViaForwardEmail,
  sendNewsletterViaForwardEmail,
  type NewsletterDeliveryEnvironment,
  type NewsletterMessageInput,
} from "./newsletter-delivery";
import { RESPONSIVE_EMAIL_STYLES } from "./email-layout";
import { ApiError, json, parseBoolean, positiveInteger, readBoundedBody, readJson } from "./http";
import {
  bytesToBase64Url,
  clientIp,
  constantTimeEqual,
  enforceRateLimit,
  expectedOrigin,
  hmacSha256Hex,
  keyedHash,
  randomId,
  requestIpHash,
  requireSameOrigin,
  requireTrustedRequest,
  sha256Hex,
  verifyTurnstile,
} from "./security";
import type { Env } from "./types";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_DIGEST_EVENTS = 100;
const MAX_DELIVERY_ATTEMPTS = 5;
const NEWSLETTER_CONFIRMATION_MESSAGE = "Check your email to confirm your subscription.";
const HARD_BOUNCE_CATEGORIES = new Set(["block", "recipient", "spam", "virus"]);
const TERMINAL_PROVIDER_FAILURE_STATUSES = new Set(["bounced", "failed", "rejected", "undeliverable"]);

type NewsletterEnv = Env & NewsletterDeliveryEnvironment & {
  NEWSLETTER_DELIVERY_ENABLED?: string;
  NEWSLETTER_DAILY_LIMIT?: string;
};

type DeliveryMode = "general" | "personalized";
type SuppressionReason = "bounce" | "complaint" | "blocked" | "invalid_recipient" | "manual";

interface DigestRow {
  id: string;
  event_ids_json: string;
  status: "building" | "fanout" | "delivering" | "completed" | "cancelled" | "failed";
  fanout_cursor: string;
  fanout_completed_at: string | null;
}

interface SubscriberRow {
  id: string;
  email: string;
  member_id: string | null;
  personalization_enabled: number;
  customize_token_hash: string | null;
}

interface DeliveryRow {
  id: string;
  digest_id: string;
  subscriber_id: string;
  recipient_email: string;
  mode: DeliveryMode;
  status: "pending" | "processing" | "sent" | "failed" | "cancelled";
  attempts: number;
  available_at: string;
  event_ids_json: string;
  member_id: string | null;
  provider_message_id?: string | null;
  reconciliation_status?: "none" | "pending" | "resolved" | "manual_review";
  reconciliation_attempts?: number;
  reconcile_after?: string | null;
}

interface ProviderEventPayload {
  email_id?: unknown;
  recipient?: unknown;
  message?: unknown;
  response?: unknown;
  response_code?: unknown;
  feedback_id?: unknown;
  bounced_at?: unknown;
  event_type?: unknown;
  type?: unknown;
  bounce?: unknown;
  headers?: unknown;
}

interface DigestEventRow {
  id: number;
  name: string;
  description: string;
  start_at: string;
  timezone: string;
  venue_name: string;
  location_display: string;
}

interface CapturedNewsletter {
  subject: string;
  text: string;
  html: string;
  raw: string;
  unsubscribe_url: string;
  customize_url: string;
}

interface ConfirmationRequestRow {
  id: string;
  email: string;
  token_hash: string;
  status: "pending" | "processing" | "sent" | "failed" | "confirmed" | "cancelled";
  attempts: number;
  available_at: string;
  expires_at: string;
  provider_message_id: string | null;
}

function normalizedEmail(value: unknown): string {
  if (typeof value !== "string") return "";
  const email = value.trim().toLowerCase().slice(0, 254);
  return EMAIL_PATTERN.test(email) ? email : "";
}

function newsletterSecret(env: Env): string {
  const secret = env.UNSUBSCRIBE_SECRET?.trim() ?? "";
  if (secret.length < 32) {
    throw new ApiError(503, "not_configured", "Newsletter subscriptions are temporarily unavailable.");
  }
  return secret;
}

function newsletterConfirmationSecret(env: Env): string {
  const secret = env.NEWSLETTER_CONFIRMATION_SECRET?.trim() ?? "";
  if (secret.length < 32) {
    throw new ApiError(503, "not_configured", "Newsletter subscriptions are temporarily unavailable.");
  }
  return secret;
}

async function newsletterConfirmationToken(
  env: Env,
  request: Pick<ConfirmationRequestRow, "id" | "email" | "expires_at">,
): Promise<string> {
  const hex = await keyedHash(
    newsletterConfirmationSecret(env),
    "serve-the-cays/newsletter-confirm/v1",
    `${request.id}:${normalizedEmail(request.email)}:${request.expires_at}`,
  );
  const bytes = Uint8Array.from(hex.match(/.{2}/g) ?? [], (part) => Number.parseInt(part, 16));
  return bytesToBase64Url(bytes);
}

async function scopedNewsletterToken(env: Env, scope: string, email: string): Promise<string> {
  const hex = await keyedHash(newsletterSecret(env), scope, normalizedEmail(email));
  const bytes = Uint8Array.from(hex.match(/.{2}/g) ?? [], (part) => Number.parseInt(part, 16));
  return bytesToBase64Url(bytes);
}

export async function newsletterUnsubscribeToken(env: Env, email: string): Promise<string> {
  return scopedNewsletterToken(env, "serve-the-cays/unsubscribe/v1", email);
}

export async function newsletterCustomizeToken(env: Env, email: string): Promise<string> {
  return scopedNewsletterToken(env, "serve-the-cays/newsletter-customize/v1", email);
}

export async function resolveNewsletterCustomizeToken(env: Env, token: string): Promise<string | null> {
  const candidate = token.trim();
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(candidate)) return null;
  const row = await env.DB.prepare(
    `SELECT email FROM subscribers
     WHERE customize_token_hash = ? AND status = 'active'`,
  ).bind(await sha256Hex(candidate)).first<{ email: string }>();
  return row ? normalizedEmail(row.email) || null : null;
}

export async function enableNewsletterPersonalization(
  env: Env,
  token: string,
  memberId: string,
): Promise<boolean> {
  const candidate = token.trim();
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(candidate)) return false;
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE subscribers
     SET member_id = ?, personalization_enabled = 1, updated_at = ?
     WHERE customize_token_hash = ? AND status = 'active'
       AND email = (SELECT email FROM members WHERE id = ?)`,
  ).bind(memberId, now, await sha256Hex(candidate), memberId).run();
  return Number(result.meta.changes ?? 0) === 1;
}

export function newsletterSubscriptionEnabled(env: Env): boolean {
  if (env.ENVIRONMENT === "local" || env.ENVIRONMENT === "test") return true;
  return parseBoolean(env.MEMBER_SCHEMA_RELEASE_READY, false)
    && parseBoolean(env.NEWSLETTER_SUBSCRIPTION_ENABLED, false)
    && parseBoolean(env.NEWSLETTER_DOUBLE_OPT_IN_VERIFIED, false)
    && parseBoolean(env.NEWSLETTER_SUPPRESSION_INGESTION_VERIFIED, false)
    && parseBoolean(env.EMAIL_DELIVERY_RECONCILIATION_VERIFIED, false);
}

export function newsletterDeliveryEnabled(env: Env): boolean {
  if (env.ENVIRONMENT === "local" || env.ENVIRONMENT === "test") return true;
  return parseBoolean(env.MEMBER_SCHEMA_RELEASE_READY, false)
    && parseBoolean(env.NEWSLETTER_DELIVERY_ENABLED, false)
    && parseBoolean(env.NEWSLETTER_SUPPRESSION_INGESTION_VERIFIED, false)
    && parseBoolean(env.NEWSLETTER_DOUBLE_OPT_IN_VERIFIED, false);
}

export function newsletterReconciliationEnabled(env: Env): boolean {
  if (!env.FORWARD_EMAIL_API_TOKEN?.trim()) return false;
  if (env.ENVIRONMENT === "local" || env.ENVIRONMENT === "test") return true;
  return parseBoolean(env.MEMBER_SCHEMA_RELEASE_READY, false)
    && parseBoolean(env.EMAIL_DELIVERY_RECONCILIATION_VERIFIED, false);
}

export async function subscribe(request: Request, env: Env): Promise<Response> {
  if (!newsletterSubscriptionEnabled(env)) {
    throw new ApiError(503, "newsletter_unavailable", "Newsletter subscriptions are temporarily unavailable.");
  }
  requireSameOrigin(request, env);
  await enforceRateLimit(
    env,
    "newsletter-subscribe-ip",
    clientIp(request),
    positiveInteger(env.NEWSLETTER_IP_LIMIT, 10, 100),
  );
  const body = await readJson(request, 16 * 1024);
  const email = normalizedEmail(body.email);
  const hp = typeof body.hp === "string" ? body.hp.trim() : "";
  if (hp) return json({ status: "success", message: NEWSLETTER_CONFIRMATION_MESSAGE }, 202);
  if (!email) {
    throw new ApiError(400, "validation_error", "Enter a valid email address.", {
      email: ["Enter a valid email address."],
    });
  }
  await enforceRateLimit(
    env,
    "newsletter-subscribe-email",
    email,
    positiveInteger(env.NEWSLETTER_EMAIL_LIMIT, 3, 20),
  );
  await verifyTurnstile(
    { turnstile_token: typeof body.turnstile_token === "string" ? body.turnstile_token : "" },
    request,
    env,
    "newsletter_subscribe",
    env.TURNSTILE_NEWSLETTER_SECRET,
  );
  const existing = await env.DB.prepare(
    `SELECT subscriber.status,
            EXISTS (
              SELECT 1 FROM newsletter_suppressions suppression
              WHERE suppression.subscriber_id = subscriber.id
            ) AS suppressed
     FROM subscribers subscriber WHERE subscriber.email = ?`,
  ).bind(email).first<{ status: "active" | "unsubscribed"; suppressed: number }>();
  if (existing?.status === "active" || Number(existing?.suppressed ?? 0) === 1) {
    return json({ status: "success", message: NEWSLETTER_CONFIRMATION_MESSAGE }, 202);
  }

  const now = new Date().toISOString();
  const expiresAt = new Date(
    Date.now() + positiveInteger(env.NEWSLETTER_CONFIRMATION_TTL_SECONDS, 86_400, 604_800) * 1_000,
  ).toISOString();
  const id = randomId("newsletter_confirm");
  const candidate = { id, email, expires_at: expiresAt };
  const [token, ipHash] = await Promise.all([
    newsletterConfirmationToken(env, candidate),
    requestIpHash(env, request),
  ]);
  await env.DB.prepare(
    `INSERT INTO newsletter_confirmation_requests (
       id, email, token_hash, ip_hash, status, attempts, available_at,
       locked_at, expires_at, sent_at, confirmed_at, provider,
       provider_message_id, provider_metadata_json, capture_json,
       last_error, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL, ?, NULL, NULL, '', NULL, '{}', NULL, '', ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       id = excluded.id,
       token_hash = excluded.token_hash,
       ip_hash = excluded.ip_hash,
       status = 'pending',
       attempts = 0,
       available_at = excluded.available_at,
       locked_at = NULL,
       expires_at = excluded.expires_at,
       sent_at = NULL,
       confirmed_at = NULL,
       provider = '',
       provider_message_id = NULL,
       provider_metadata_json = '{}',
       capture_json = NULL,
       last_error = '',
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
  ).bind(
    id,
    email,
    await sha256Hex(token),
    ipHash,
    now,
    expiresAt,
    now,
    now,
  ).run();
  return json({ status: "success", message: NEWSLETTER_CONFIRMATION_MESSAGE }, 202);
}

function confirmationRetryDelaySeconds(attempt: number): number {
  return Math.min(60 * 60, 60 * (2 ** Math.max(0, attempt - 1)));
}

async function claimConfirmationRequest(env: Env, row: ConfirmationRequestRow, now: Date): Promise<boolean> {
  const nowIso = now.toISOString();
  const result = await env.DB.prepare(
    `UPDATE newsletter_confirmation_requests
     SET status = 'processing', attempts = attempts + 1, locked_at = ?, updated_at = ?
     WHERE id = ? AND status IN ('pending', 'failed') AND attempts < ?
       AND available_at <= ? AND expires_at > ?`,
  ).bind(nowIso, nowIso, row.id, MAX_DELIVERY_ATTEMPTS, nowIso, nowIso).run();
  return Number(result.meta.changes ?? 0) === 1;
}

export async function processNewsletterConfirmationJobs(
  env: Env,
  limit = 10,
  fetcher: typeof fetch = fetch,
): Promise<number> {
  if (!newsletterSubscriptionEnabled(env)) return 0;
  const now = new Date();
  const nowIso = now.toISOString();
  const staleLock = new Date(now.getTime() - 10 * 60 * 1_000).toISOString();
  await env.DB.prepare(
    `UPDATE newsletter_confirmation_requests
     SET status = 'failed', locked_at = NULL, available_at = ?, updated_at = ?
     WHERE status = 'processing' AND locked_at <= ? AND expires_at > ?`,
  ).bind(nowIso, nowIso, staleLock, nowIso).run();
  await env.DB.prepare(
    `UPDATE newsletter_confirmation_requests
     SET status = 'cancelled', locked_at = NULL,
         last_error = 'Confirmation link expired before delivery', updated_at = ?
     WHERE status IN ('pending', 'processing', 'failed', 'sent') AND expires_at <= ?`,
  ).bind(nowIso, nowIso).run();
  const rows = await env.DB.prepare(
    `SELECT id, email, token_hash, status, attempts, available_at, expires_at, provider_message_id
     FROM newsletter_confirmation_requests
     WHERE status IN ('pending', 'failed') AND attempts < ?
       AND available_at <= ? AND expires_at > ?
     ORDER BY available_at, created_at LIMIT ?`,
  ).bind(MAX_DELIVERY_ATTEMPTS, nowIso, nowIso, Math.max(1, Math.min(limit, 100))).all<ConfirmationRequestRow>();
  let processed = 0;
  for (const row of rows.results) {
    if (!await claimConfirmationRequest(env, row, now)) continue;
    const currentAttempt = Math.min(MAX_DELIVERY_ATTEMPTS, Number(row.attempts) + 1);
    try {
      const token = await newsletterConfirmationToken(env, row);
      if (await sha256Hex(token) !== row.token_hash) {
        throw new ForwardEmailDeliveryError("Confirmation token could not be verified", false);
      }
      const confirmationUrl = `${expectedOrigin(env)}/newsletter/confirm#token=${encodeURIComponent(token)}`;
      const messageInput = {
        requestId: row.id,
        recipient: row.email,
        confirmationUrl,
        expiresAt: new Date(row.expires_at),
        sentAt: now,
      };
      const localCapture = env.ENVIRONMENT === "local" || env.ENVIRONMENT === "test";
      let provider = "forward_email";
      let providerMessageId = `local:${row.id}`;
      let providerMetadata: Record<string, unknown> = { delivery_state: "captured_local", captured_at: nowIso };
      let capture: CapturedNewsletter | null = null;
      if (localCapture) {
        const built = buildNewsletterConfirmationMessage(messageInput);
        capture = {
          subject: built.subject,
          text: built.text,
          html: built.html,
          raw: built.raw,
          unsubscribe_url: "",
          customize_url: "",
        };
      } else {
        const result = await sendNewsletterConfirmationViaForwardEmail(env, messageInput, fetcher);
        provider = result.provider;
        providerMessageId = result.providerMessageId;
        providerMetadata = { accepted_at: result.acceptedAt };
      }
      await env.DB.prepare(
        `UPDATE newsletter_confirmation_requests
         SET status = 'sent', sent_at = ?, locked_at = NULL, provider = ?,
             provider_message_id = ?, provider_metadata_json = ?, capture_json = ?,
             last_error = '', updated_at = ?
         WHERE id = ? AND status = 'processing'`,
      ).bind(
        nowIso,
        provider,
        providerMessageId,
        JSON.stringify(providerMetadata),
        capture ? JSON.stringify(capture) : null,
        nowIso,
        row.id,
      ).run();
      processed += 1;
    } catch (error) {
      const retryable = error instanceof ForwardEmailDeliveryError ? error.retryable : true;
      const uncertain = error instanceof ForwardEmailDeliveryError && error.uncertain;
      const attempts = retryable ? currentAttempt : MAX_DELIVERY_ATTEMPTS;
      const retryAt = new Date(now.getTime() + confirmationRetryDelaySeconds(currentAttempt) * 1_000).toISOString();
      const message = error instanceof Error ? error.message : "Newsletter confirmation delivery failed";
      await env.DB.prepare(
        `UPDATE newsletter_confirmation_requests
         SET status = ?, attempts = ?, available_at = ?, locked_at = NULL,
             provider_metadata_json = ?, last_error = ?, updated_at = ?
         WHERE id = ? AND status = 'processing'`,
      ).bind(
        uncertain ? "sent" : "failed",
        attempts,
        retryAt,
        JSON.stringify({ delivery_state: uncertain ? "uncertain" : "failed", occurred_at: nowIso }),
        message.slice(0, 1000),
        nowIso,
        row.id,
      ).run();
    }
  }
  return processed;
}

export async function confirmNewsletterSubscription(request: Request, env: Env): Promise<Response> {
  if (!newsletterSubscriptionEnabled(env)) {
    throw new ApiError(503, "newsletter_unavailable", "Newsletter subscriptions are temporarily unavailable.");
  }
  requireSameOrigin(request, env);
  const body = await readJson(request, 4096);
  const token = typeof body.token === "string" ? body.token.trim().slice(0, 200) : "";
  if (!/^[A-Za-z0-9_-]{32,200}$/.test(token)) {
    throw new ApiError(400, "confirmation_invalid", "This confirmation link is not valid.");
  }
  const tokenHash = await sha256Hex(token);
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `SELECT id, email, token_hash, status, attempts, available_at, expires_at, provider_message_id
     FROM newsletter_confirmation_requests WHERE token_hash = ?`,
  ).bind(tokenHash).first<ConfirmationRequestRow>();
  if (!row || row.expires_at <= now || row.status === "cancelled") {
    throw new ApiError(400, "confirmation_invalid", "This confirmation link is invalid or has expired.");
  }
  if (row.status === "confirmed") {
    return json({ status: "success", message: "Your community updates are already confirmed." });
  }
  const suppressed = await env.DB.prepare(
    `SELECT 1 AS found FROM newsletter_suppressions suppression
     JOIN subscribers subscriber ON subscriber.id = suppression.subscriber_id
     WHERE subscriber.email = ?`,
  ).bind(row.email).first<{ found: number }>();
  if (suppressed) {
    await env.DB.prepare(
      `UPDATE newsletter_confirmation_requests
       SET status = 'cancelled', locked_at = NULL,
           last_error = 'Address is suppressed', updated_at = ?
       WHERE id = ? AND status <> 'confirmed'`,
    ).bind(now, row.id).run();
    throw new ApiError(409, "confirmation_unavailable", "This address cannot be subscribed right now.");
  }
  const [unsubscribeToken, customizeToken] = await Promise.all([
    newsletterUnsubscribeToken(env, row.email),
    newsletterCustomizeToken(env, row.email),
  ]);
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO subscribers (
         id, email, status, consent_at, unsubscribed_at,
         unsubscribe_token_hash, ip_hash, member_id,
         personalization_enabled, customize_token_hash, created_at, updated_at
       )
       SELECT ?, confirmation.email, 'active', ?, NULL, ?, confirmation.ip_hash,
              (SELECT id FROM members WHERE email = confirmation.email), 0, ?, ?, ?
       FROM newsletter_confirmation_requests confirmation
       WHERE confirmation.id = ? AND confirmation.token_hash = ?
         AND confirmation.status IN ('pending', 'processing', 'sent', 'failed')
         AND confirmation.expires_at > ?
       ON CONFLICT(email) DO UPDATE SET
         status = 'active',
         consent_at = excluded.consent_at,
         unsubscribed_at = NULL,
         unsubscribe_token_hash = excluded.unsubscribe_token_hash,
         ip_hash = excluded.ip_hash,
         member_id = excluded.member_id,
         personalization_enabled = 0,
         customize_token_hash = excluded.customize_token_hash,
         updated_at = excluded.updated_at`,
    ).bind(
      randomId("subscriber"),
      now,
      await sha256Hex(unsubscribeToken),
      await sha256Hex(customizeToken),
      now,
      now,
      row.id,
      tokenHash,
      now,
    ),
    env.DB.prepare(
      `UPDATE newsletter_confirmation_requests
       SET status = 'confirmed', confirmed_at = ?, locked_at = NULL,
           capture_json = NULL, last_error = '', updated_at = ?
       WHERE id = ? AND token_hash = ?
         AND status IN ('pending', 'processing', 'sent', 'failed')
         AND expires_at > ?`,
    ).bind(now, now, row.id, tokenHash, now),
  ]);
  if (Number(results[1].meta.changes ?? 0) !== 1) {
    throw new ApiError(409, "confirmation_conflict", "This confirmation link has already been used.");
  }
  return json({ status: "success", message: "You’re confirmed. Community updates are now active." });
}

function boundedString(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function providerHeader(headers: unknown, name: string): string {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return "";
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() !== expected) continue;
    if (typeof value === "string") return value.trim().slice(0, 500);
    if (Array.isArray(value)) {
      const first = value.find((item) => typeof item === "string");
      return typeof first === "string" ? first.trim().slice(0, 500) : "";
    }
  }
  return "";
}

function validOccurredAt(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function providerResponseCode(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed >= 100 && parsed <= 599 ? parsed : null;
}

function forwardEmailWebhookSecret(env: Env): string {
  const secret = env.FORWARD_EMAIL_WEBHOOK_SECRET?.trim() ?? "";
  if (secret.length < 32) {
    throw new ApiError(503, "webhook_not_configured", "Email event processing is not configured.");
  }
  return secret;
}

export async function ingestForwardEmailEvent(request: Request, env: Env): Promise<Response> {
  const signature = (request.headers.get("X-Webhook-Signature") ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(signature)) {
    throw new ApiError(401, "webhook_unauthorized", "The email event could not be authenticated.");
  }
  const secret = forwardEmailWebhookSecret(env);
  const contentType = request.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new ApiError(415, "unsupported_media_type", "Send JSON for this request.");
  }
  const bytes = await readBoundedBody(
    request,
    64 * 1024,
    "The email event is too large.",
    "The email event body could not be read.",
  );
  const exactBody = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const expectedSignature = await hmacSha256Hex(secret, exactBody);
  if (!constantTimeEqual(signature, expectedSignature)) {
    throw new ApiError(401, "webhook_unauthorized", "The email event could not be authenticated.");
  }

  let payload: ProviderEventPayload;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    payload = parsed as ProviderEventPayload;
  } catch {
    throw new ApiError(400, "invalid_event", "The email event is not valid JSON.");
  }

  const recipient = normalizedEmail(payload.recipient);
  if (!recipient) throw new ApiError(400, "invalid_event", "The email event recipient is invalid.");
  const providerMessageId = boundedString(payload.email_id, 500);
  const feedbackId = boundedString(payload.feedback_id, 500);
  const explicitType = boundedString(payload.event_type ?? payload.type, 50).toLowerCase();
  const eventType: "bounce" | "complaint" = explicitType === "complaint" || Boolean(feedbackId)
    ? "complaint"
    : "bounce";
  const bounce = payload.bounce && typeof payload.bounce === "object" && !Array.isArray(payload.bounce)
    ? payload.bounce as Record<string, unknown>
    : {};
  const category = boundedString(bounce.category, 100).toLowerCase();
  const responseCode = providerResponseCode(payload.response_code ?? bounce.code);
  // Forward Email labels an intentionally disabled alias with its permanent
  // SMTP 550 rejection as an "envelope" bounce. A 552 capacity bounce remains
  // non-suppressing, so recognize only this documented permanent combination.
  const shouldSuppress = eventType === "complaint"
    || HARD_BOUNCE_CATEGORIES.has(category)
    || (category === "envelope" && responseCode === 550);
  const reason: SuppressionReason = eventType === "complaint"
    ? "complaint"
    : category === "block"
      ? "blocked"
      : category === "recipient"
        ? "invalid_recipient"
        : "bounce";
  const details = [
    boundedString(payload.message, 500),
    boundedString(payload.response, 500),
    boundedString(bounce.message, 500),
  ].filter(Boolean).join(" | ").slice(0, 1000);
  const entityReference = providerHeader(payload.headers, "x-entity-ref-id")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 100);
  const now = new Date().toISOString();
  const payloadSha = await sha256Hex(exactBody);
  const providerEventHash = await keyedHash(
    secret,
    "serve-the-cays/forward-email-event/v1",
    payloadSha,
  );
  const occurredAt = validOccurredAt(payload.bounced_at);

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT OR IGNORE INTO newsletter_provider_events (
         id, provider, provider_event_hash, provider_message_id, recipient_email,
         event_type, action, category, response_code, details, payload_sha256,
         occurred_at, created_at, processed_at
       ) VALUES (?, 'forward_email', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      randomId("newsletter_event"),
      providerEventHash,
      providerMessageId,
      recipient,
      eventType,
      shouldSuppress ? "suppressed" : "recorded",
      category,
      responseCode,
      details,
      payloadSha,
      occurredAt,
      now,
      now,
    ),
  ];
  if (shouldSuppress) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO newsletter_suppressions (
           subscriber_id, reason, provider_event_id, details, created_at, updated_at
         )
         SELECT subscriber.id, ?, ?, ?, ?, ?
         FROM subscribers subscriber WHERE subscriber.email = ?
         ON CONFLICT(subscriber_id) DO UPDATE SET
           reason = excluded.reason,
           provider_event_id = excluded.provider_event_id,
           details = excluded.details,
           updated_at = excluded.updated_at`,
      ).bind(reason, providerEventHash, details, now, now, recipient),
    );
  }
  statements.push(
    env.DB.prepare(
      `UPDATE newsletter_deliveries
       SET status = CASE
             WHEN ? = 1 THEN 'failed'
             WHEN status = 'processing' AND reconciliation_status = 'pending' THEN 'sent'
             ELSE status
           END,
           attempts = CASE WHEN ? = 1 THEN ? ELSE attempts END,
           sent_at = CASE
             WHEN ? = 0 AND status = 'processing' AND reconciliation_status = 'pending'
               THEN COALESCE(sent_at, ?)
             ELSE sent_at
           END,
           locked_at = NULL,
           provider = 'forward_email',
           provider_message_id = CASE WHEN ? <> '' THEN ? ELSE provider_message_id END,
           reconciliation_status = CASE
             WHEN reconciliation_status = 'pending' THEN 'resolved'
             ELSE reconciliation_status
           END,
           last_reconciled_at = ?,
           last_error = CASE WHEN ? = 1 THEN ? ELSE last_error END,
           updated_at = ?
       WHERE (? <> '' AND provider_message_id = ?)
          OR (? <> '' AND id = ?)`,
    ).bind(
      shouldSuppress ? 1 : 0,
      shouldSuppress ? 1 : 0,
      MAX_DELIVERY_ATTEMPTS,
      shouldSuppress ? 1 : 0,
      now,
      providerMessageId,
      providerMessageId,
      now,
      shouldSuppress ? 1 : 0,
      details || `${eventType} reported by provider`,
      now,
      providerMessageId,
      providerMessageId,
      entityReference,
      entityReference,
    ),
  );
  await env.DB.batch(statements);
  return json({ status: "success" });
}

async function markUnsubscribed(env: Env, token: string): Promise<boolean> {
  const candidate = token.trim();
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(candidate)) return false;
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE subscribers
     SET status = 'unsubscribed', unsubscribed_at = COALESCE(unsubscribed_at, ?), updated_at = ?
     WHERE unsubscribe_token_hash = ?`,
  ).bind(now, now, await sha256Hex(candidate)).run();
  return Number(result.meta.changes ?? 0) >= 1;
}

async function readSmallFormBody(request: Request, maximumBytes = 4096): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel("newsletter form body too large");
        throw new ApiError(413, "request_too_large", "The request is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function unsubscribe(request: Request, env: Env): Promise<Response> {
  requireSameOrigin(request, env);
  const body = await readJson(request);
  const token = typeof body.token === "string" ? body.token.trim().slice(0, 200) : "";
  if (!await markUnsubscribed(env, token)) {
    throw new ApiError(404, "unsubscribe_not_found", "This unsubscribe link is not valid.");
  }
  return json({ status: "success", message: "You have been unsubscribed." });
}

export async function oneClickUnsubscribe(
  request: Request,
  env: Env,
  token = "",
): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") {
    throw new ApiError(405, "method_not_allowed", "Use POST for one-click unsubscribe.");
  }
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declared) && declared > 4096) {
    throw new ApiError(413, "request_too_large", "The request is too large.");
  }
  const type = request.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!type.startsWith("application/x-www-form-urlencoded")) {
    throw new ApiError(415, "unsupported_media_type", "Send form data for one-click unsubscribe.");
  }
  const raw = await readSmallFormBody(request);
  const form = new URLSearchParams(raw);
  if (form.get("List-Unsubscribe") !== "One-Click") {
    throw new ApiError(400, "invalid_unsubscribe_request", "The one-click unsubscribe request is invalid.");
  }
  const supplied = token || new URL(request.url).pathname.split("/").filter(Boolean).at(-1) || "";
  if (!await markUnsubscribed(env, supplied)) {
    throw new ApiError(404, "unsubscribe_not_found", "This unsubscribe link is not valid.");
  }
  return json({ status: "success", message: "You have been unsubscribed." });
}

function completedWeeklyWindow(now: Date): { start: string; end: string } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysSinceMonday = (end.getUTCDay() + 6) % 7;
  end.setUTCDate(end.getUTCDate() - daysSinceMonday);
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1_000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function parsedEventIds(value: string): number[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed
      .map(Number)
      .filter((id) => Number.isSafeInteger(id) && id > 0))]
      .slice(0, MAX_DIGEST_EVENTS);
  } catch {
    return [];
  }
}

export async function generateWeeklyDigest(env: Env, now = new Date()): Promise<string> {
  const window = completedWeeklyWindow(now);
  const existing = await env.DB.prepare(
    "SELECT id FROM newsletter_digests WHERE window_start = ? AND window_end = ?",
  ).bind(window.start, window.end).first<{ id: string }>();
  if (existing) return existing.id;
  const events = await env.DB.prepare(
    `SELECT id FROM events
     WHERE is_active = 1
       AND published_at >= ? AND published_at < ?
       AND COALESCE(end_at, start_at) > ?
     ORDER BY published_at, id
     LIMIT ?`,
  ).bind(window.start, window.end, now.toISOString(), MAX_DIGEST_EVENTS).all<{ id: number }>();
  const eventIds = events.results.map((event) => Number(event.id));
  const id = randomId("digest");
  const nowIso = now.toISOString();
  const status = eventIds.length ? "fanout" : "completed";
  await env.DB.prepare(
    `INSERT INTO newsletter_digests (
       id, window_start, window_end, event_ids_json, status,
       fanout_cursor, fanout_completed_at, completed_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?)
     ON CONFLICT(window_start, window_end) DO NOTHING`,
  ).bind(
    id,
    window.start,
    window.end,
    JSON.stringify(eventIds),
    status,
    eventIds.length ? null : nowIso,
    eventIds.length ? null : nowIso,
    nowIso,
    nowIso,
  ).run();
  const row = await env.DB.prepare(
    "SELECT id FROM newsletter_digests WHERE window_start = ? AND window_end = ?",
  ).bind(window.start, window.end).first<{ id: string }>();
  if (!row) throw new Error("Newsletter digest could not be created");
  return row.id;
}

export async function fanoutNewsletterDigest(env: Env, digestId: string, limit = 250): Promise<number> {
  const digest = await env.DB.prepare(
    `SELECT id, event_ids_json, status, fanout_cursor, fanout_completed_at
     FROM newsletter_digests WHERE id = ?`,
  ).bind(digestId).first<DigestRow>();
  if (!digest || !["fanout", "delivering"].includes(digest.status) || digest.fanout_completed_at) return 0;
  if (!parsedEventIds(digest.event_ids_json).length) {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE newsletter_digests
       SET status = 'completed', fanout_completed_at = ?, completed_at = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(now, now, now, digest.id).run();
    return 0;
  }
  const bounded = Math.max(1, Math.min(limit, 500));
  const subscribers = await env.DB.prepare(
    `SELECT s.id, s.email, s.member_id, s.personalization_enabled, s.customize_token_hash
     FROM subscribers s
     LEFT JOIN newsletter_suppressions suppression ON suppression.subscriber_id = s.id
     WHERE s.status = 'active' AND suppression.subscriber_id IS NULL AND s.id > ?
     ORDER BY s.id
     LIMIT ?`,
  ).bind(digest.fanout_cursor, bounded + 1).all<SubscriberRow>();
  const hasMore = subscribers.results.length > bounded;
  const page = subscribers.results.slice(0, bounded);
  if (!page.length) {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE newsletter_digests
       SET status = 'delivering', fanout_completed_at = ?, updated_at = ?
       WHERE id = ? AND fanout_completed_at IS NULL`,
    ).bind(now, now, digest.id).run();
    await finishDigest(env, digest.id, now);
    return 0;
  }
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  for (const subscriber of page) {
    const mode: DeliveryMode = subscriber.personalization_enabled && subscriber.member_id
      ? "personalized"
      : "general";
    if (!subscriber.customize_token_hash) {
      statements.push(env.DB.prepare(
        `UPDATE subscribers SET customize_token_hash = ?, updated_at = ?
         WHERE id = ? AND customize_token_hash IS NULL`,
      ).bind(
        await sha256Hex(await newsletterCustomizeToken(env, subscriber.email)),
        now,
        subscriber.id,
      ));
    }
    statements.push(env.DB.prepare(
      `INSERT INTO newsletter_deliveries (
         id, digest_id, subscriber_id, recipient_email, mode, status,
         attempts, available_at, created_at, updated_at
       )
       SELECT ?, ?, id, email, ?, 'pending', 0, ?, ?, ?
       FROM subscribers
       WHERE id = ? AND status = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM newsletter_suppressions WHERE subscriber_id = subscribers.id
         )
       ON CONFLICT(digest_id, subscriber_id) DO NOTHING`,
    ).bind(
      randomId("newsletter"),
      digest.id,
      mode,
      now,
      now,
      now,
      subscriber.id,
    ));
  }
  const cursor = page.at(-1)!.id;
  statements.push(env.DB.prepare(
    `UPDATE newsletter_digests
     SET status = 'delivering', fanout_cursor = ?,
         fanout_completed_at = CASE WHEN ? = 1 THEN NULL ELSE ? END,
         updated_at = ?
     WHERE id = ? AND fanout_completed_at IS NULL`,
  ).bind(cursor, hasMore ? 1 : 0, now, now, digest.id));
  await env.DB.batch(statements);
  if (!hasMore) await finishDigest(env, digest.id, now);
  // Count authoritative delivery rows created for this page; this also avoids
  // coupling the result to whether a token backfill statement was necessary.
  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS value FROM newsletter_deliveries
     WHERE digest_id = ? AND subscriber_id > ? AND subscriber_id <= ?`,
  ).bind(digest.id, digest.fanout_cursor, cursor).first<{ value: number }>();
  return Number(count?.value ?? 0);
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function readableEventDate(event: DigestEventRow): string {
  const date = new Date(event.start_at);
  if (Number.isNaN(date.getTime())) return "Date to be confirmed";
  try {
    return new Intl.DateTimeFormat("en-BS", {
      dateStyle: "full",
      timeStyle: "short",
      timeZone: event.timezone || "America/Nassau",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

async function deliveryEvents(env: Env, delivery: DeliveryRow, now: string): Promise<DigestEventRow[]> {
  const ids = parsedEventIds(delivery.event_ids_json);
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const memberId = delivery.mode === "personalized" ? delivery.member_id : null;
  const rows = memberId
    ? await env.DB.prepare(
      `SELECT event.id, event.name, event.description, event.start_at,
              event.timezone, event.venue_name, event.location_display
       FROM events event
       WHERE event.id IN (${placeholders}) AND event.is_active = 1
         AND COALESCE(event.end_at, event.start_at) > ?
         AND (
           NOT EXISTS (
             SELECT 1
             FROM member_notification_categories selected_category
             JOIN categories active_category
               ON active_category.id = selected_category.category_id
              AND active_category.is_active = 1
             WHERE selected_category.member_id = ?
           )
           OR EXISTS (
             SELECT 1
             FROM event_organizations event_organization
             JOIN organization_categories organization_category
               ON organization_category.organization_id = event_organization.organization_id
             JOIN member_notification_categories selected_category
               ON selected_category.member_id = ?
              AND selected_category.category_id = organization_category.category_id
             JOIN categories active_category
               ON active_category.id = selected_category.category_id
              AND active_category.is_active = 1
             WHERE event_organization.event_id = event.id
           )
         )
         AND (
           NOT EXISTS (
             SELECT 1
             FROM member_notification_locations selected_location
             JOIN locations active_location
               ON active_location.id = selected_location.location_id
              AND active_location.is_active = 1
             WHERE selected_location.member_id = ?
           )
           OR EXISTS (
             SELECT 1
             FROM member_notification_locations selected_location
             JOIN locations active_location
               ON active_location.id = selected_location.location_id
              AND active_location.is_active = 1
             WHERE selected_location.member_id = ?
               AND selected_location.location_id = event.location_id
           )
         )
       ORDER BY event.start_at, event.id`,
    ).bind(...ids, now, memberId, memberId, memberId, memberId).all<DigestEventRow>()
    : await env.DB.prepare(
      `SELECT id, name, description, start_at, timezone, venue_name, location_display
       FROM events
       WHERE id IN (${placeholders}) AND is_active = 1
         AND COALESCE(end_at, start_at) > ?
       ORDER BY start_at, id`,
    ).bind(...ids, now).all<DigestEventRow>();
  if (!memberId || !rows.results.length) {
    return rows.results;
  }
  const filteredIds = rows.results.map((event) => Number(event.id));
  const filteredPlaceholders = filteredIds.map(() => "?").join(",");
  const matches = await env.DB.prepare(
    `SELECT event_id FROM event_favorites
     WHERE member_id = ? AND event_id IN (${filteredPlaceholders})
     UNION
     SELECT eo.event_id
     FROM event_organizations eo
     JOIN organization_favorites favorite
       ON favorite.organization_id = eo.organization_id AND favorite.member_id = ?
     WHERE eo.event_id IN (${filteredPlaceholders})`,
  ).bind(memberId, ...filteredIds, memberId, ...filteredIds).all<{ event_id: number }>();
  const preferred = new Set(matches.results.map((row) => Number(row.event_id)));
  if (!preferred.size) return rows.results;
  return [
    ...rows.results.filter((event) => preferred.has(Number(event.id))),
    ...rows.results.filter((event) => !preferred.has(Number(event.id))),
  ];
}

async function renderDelivery(env: Env, delivery: DeliveryRow, now: Date): Promise<NewsletterMessageInput | null> {
  const events = await deliveryEvents(env, delivery, now.toISOString());
  if (!events.length) return null;
  const unsubscribeToken = await newsletterUnsubscribeToken(env, delivery.recipient_email);
  const customizeToken = await newsletterCustomizeToken(env, delivery.recipient_email);
  const origin = expectedOrigin(env);
  const unsubscribeUrl = `${origin}/unsubscribe/${encodeURIComponent(unsubscribeToken)}`;
  const customizeUrl = `${origin}/signin#subscriber=${encodeURIComponent(customizeToken)}`;
  const personalized = delivery.mode === "personalized";
  const subject = personalized ? "Events picked for you by Serve The Cays" : "New events from Serve The Cays";
  const heading = personalized ? "Your event updates" : "New events across the cays";
  const textItems = events.map((event) => [
    event.name,
    readableEventDate(event),
    [event.venue_name, event.location_display].filter(Boolean).join(" · "),
    `${origin}/event/${event.id}`,
  ].filter(Boolean).join("\n"));
  const htmlItems = events.map((event) => {
    const place = [event.venue_name, event.location_display].filter(Boolean).join(" · ");
    return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 14px;border:1px solid #d7e7e4;border-radius:8px;background:#ffffff">
      <tr><td class="stc-event-card-cell" style="padding:18px 18px 17px;border-left:3px solid #00b6a8">
        <p style="margin:0 0 6px;color:#007f75;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;letter-spacing:.11em;text-transform:uppercase">Upcoming community event</p>
        <h2 class="stc-event-title" style="margin:0 0 8px;color:#173c38;font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:1.28;letter-spacing:-.01em"><a href="${origin}/event/${event.id}" style="color:#173c38;text-decoration:none">${escapeHtml(event.name)}</a></h2>
        <p style="margin:0 0 5px;color:#354d49;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5"><strong>${escapeHtml(readableEventDate(event))}</strong></p>
        ${place ? `<p style="margin:0 0 10px;color:#61716e;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5">${escapeHtml(place)}</p>` : ""}
        <p style="margin:0 0 12px;color:#41514f;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.58">${escapeHtml(event.description)}</p>
        <a href="${origin}/event/${event.id}" style="color:#006c65;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;text-decoration:underline;text-decoration-color:#bde5df;text-underline-offset:3px">View event →</a>
      </td></tr>
    </table>`;
  }).join("");
  const text = `${heading}\n\n${textItems.join("\n\n")}\n\nServe The Cays · Community in action`;
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="x-apple-disable-message-reformatting">
    <meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no">
    <title>${escapeHtml(heading)}</title>
    ${RESPONSIVE_EMAIL_STYLES}
  </head>
  <body id="body" style="margin:0;padding:0;background:#f4f7f6;color:#173c38;font-family:Arial,Helvetica,sans-serif">
    <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;opacity:0;color:transparent">A fresh round-up of community opportunities from Serve the Cays.</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;margin:0;background:#f4f7f6">
      <tr><td class="stc-email-gutter" align="center" style="padding:32px 16px 18px">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;max-width:620px;margin:0 auto;border:1px solid #d6e3e1;border-radius:10px;background:#ffffff;overflow:hidden">
          <tr><td height="4" style="height:4px;background:#00b6a8;font-size:0;line-height:0">&nbsp;</td></tr>
          <tr><td class="stc-email-content" style="padding:24px 28px 12px">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
              <td width="58" valign="middle" style="width:58px;vertical-align:middle">
                <a href="${origin}" style="display:inline-block;text-decoration:none">
                  <img src="${origin}/static/images/logo.png" width="48" height="48" alt="" style="display:block;width:48px;height:48px;border:0;outline:none;text-decoration:none">
                </a>
              </td>
              <td valign="middle" style="vertical-align:middle">
                <a href="${origin}" style="color:#153c38;text-decoration:none">
                  <span style="display:block;color:#153c38;font-size:20px;font-weight:700;line-height:1.2;letter-spacing:-.02em">Serve the Cays</span>
                  <span style="display:block;margin-top:4px;color:#6d7c79;font-size:10px;font-weight:700;line-height:1.2;letter-spacing:.13em;text-transform:uppercase">Community in action</span>
                </a>
              </td>
            </tr></table>
            <div style="width:28px;height:3px;margin:24px 0 14px;background:#ff66a1;font-size:0;line-height:0">&nbsp;</div>
            <p style="margin:0 0 8px;color:#007f75;font-size:11px;font-weight:700;letter-spacing:.13em;text-transform:uppercase">Weekly event update</p>
            <h1 class="stc-email-title" style="margin:0 0 10px;color:#102c29;font-size:30px;line-height:1.18;letter-spacing:-.03em">${escapeHtml(heading)}</h1>
            <p class="stc-email-copy" style="margin:0 0 24px;color:#50615e;font-size:16px;line-height:1.6">A few community opportunities worth knowing about this week.</p>
            ${htmlItems}
          </td></tr>
          <tr><td class="stc-email-footer" style="padding:16px 28px 18px;border-top:1px solid #e2ecea;background:#fafcfb">
            <p style="margin:0;color:#687875;font-size:12px;line-height:1.55">Save organizations and events in My STC to help tailor future updates.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
  return {
    deliveryId: delivery.id,
    recipient: delivery.recipient_email,
    subject,
    text,
    html,
    unsubscribeUrl,
    customizeUrl,
    sentAt: now,
  };
}

function retryDelaySeconds(attempt: number): number {
  return Math.min(6 * 60 * 60, 60 * (2 ** Math.max(0, attempt - 1)));
}

function utcDayStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

async function claimDelivery(env: NewsletterEnv, delivery: DeliveryRow, now: Date): Promise<boolean> {
  const nowIso = now.toISOString();
  const cap = positiveInteger(env.NEWSLETTER_DAILY_LIMIT, 90, 100_000);
  const result = await env.DB.prepare(
    `UPDATE newsletter_deliveries
     SET status = 'processing', attempts = attempts + 1, locked_at = ?, updated_at = ?,
         mode = CASE
           WHEN mode = 'personalized' AND EXISTS (
             SELECT 1 FROM subscribers current_preference
             WHERE current_preference.id = newsletter_deliveries.subscriber_id
               AND current_preference.member_id IS NOT NULL
               AND current_preference.personalization_enabled = 1
           ) THEN 'personalized'
           ELSE 'general'
         END
     WHERE id = ? AND status IN ('pending', 'failed')
       AND reconciliation_status = 'none'
       AND attempts < ? AND available_at <= ?
       AND EXISTS (
         SELECT 1 FROM subscribers s
         WHERE s.id = newsletter_deliveries.subscriber_id
           AND s.email = newsletter_deliveries.recipient_email COLLATE NOCASE
           AND s.status = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM newsletter_suppressions suppression
             WHERE suppression.subscriber_id = s.id
           )
       )
       AND (
         SELECT COUNT(*) FROM newsletter_deliveries daily
         WHERE (daily.status = 'sent' AND daily.sent_at >= ?)
            OR (daily.status = 'processing' AND daily.locked_at >= ?)
       ) < ?`,
  ).bind(
    nowIso,
    nowIso,
    delivery.id,
    MAX_DELIVERY_ATTEMPTS,
    nowIso,
    utcDayStart(now),
    utcDayStart(now),
    cap,
  ).run();
  return Number(result.meta.changes ?? 0) === 1;
}

async function finishDigest(env: Env, digestId: string, now = new Date().toISOString()): Promise<void> {
  const outstanding = await env.DB.prepare(
    `SELECT COUNT(*) AS value FROM newsletter_deliveries
     WHERE digest_id = ?
       AND (status IN ('pending', 'processing') OR (status = 'failed' AND attempts < ?))`,
  ).bind(digestId, MAX_DELIVERY_ATTEMPTS).first<{ value: number }>();
  const digest = await env.DB.prepare(
    "SELECT fanout_completed_at FROM newsletter_digests WHERE id = ?",
  ).bind(digestId).first<{ fanout_completed_at: string | null }>();
  if (!digest?.fanout_completed_at || Number(outstanding?.value ?? 0) > 0) return;
  const failures = await env.DB.prepare(
    `SELECT COUNT(*) AS value FROM newsletter_deliveries
     WHERE digest_id = ? AND status = 'failed' AND attempts >= ?`,
  ).bind(digestId, MAX_DELIVERY_ATTEMPTS).first<{ value: number }>();
  await env.DB.prepare(
    `UPDATE newsletter_digests
     SET status = ?, completed_at = ?, updated_at = ?
     WHERE id = ? AND status NOT IN ('completed', 'cancelled')`,
  ).bind(Number(failures?.value ?? 0) ? "failed" : "completed", now, now, digestId).run();
}

async function processDelivery(
  env: NewsletterEnv,
  delivery: DeliveryRow,
  fetcher: typeof fetch,
): Promise<boolean> {
  const now = new Date();
  const nowIso = now.toISOString();
  if (!await claimDelivery(env, delivery, now)) return false;
  try {
    const current = await env.DB.prepare(
      `SELECT d.id, d.digest_id, d.subscriber_id, d.recipient_email, d.mode,
              d.status, d.attempts, d.available_at, digest.event_ids_json,
              subscriber.member_id
       FROM newsletter_deliveries d
       JOIN newsletter_digests digest ON digest.id = d.digest_id
       JOIN subscribers subscriber ON subscriber.id = d.subscriber_id
       LEFT JOIN newsletter_suppressions suppression ON suppression.subscriber_id = subscriber.id
       WHERE d.id = ? AND d.status = 'processing'
         AND subscriber.status = 'active' AND suppression.subscriber_id IS NULL
         AND subscriber.email = d.recipient_email COLLATE NOCASE`,
    ).bind(delivery.id).first<DeliveryRow>();
    if (!current) {
      await env.DB.prepare(
        `UPDATE newsletter_deliveries
         SET status = 'cancelled', cancelled_at = ?, locked_at = NULL,
             last_error = 'Subscriber became unavailable before delivery', updated_at = ?
         WHERE id = ? AND status = 'processing'`,
      ).bind(nowIso, nowIso, delivery.id).run();
      await finishDigest(env, delivery.digest_id, nowIso);
      return false;
    }
    const rendered = await renderDelivery(env, current, now);
    if (!rendered) {
      await env.DB.prepare(
        `UPDATE newsletter_deliveries
         SET status = 'cancelled', cancelled_at = ?, locked_at = NULL,
             last_error = 'No active upcoming events remained in this digest', updated_at = ?
         WHERE id = ? AND status = 'processing'`,
      ).bind(nowIso, nowIso, current.id).run();
      await finishDigest(env, current.digest_id, nowIso);
      return false;
    }
    const localCapture = env.ENVIRONMENT === "local" || env.ENVIRONMENT === "test";
    let provider = "forward_email";
    let providerMessageId = `local:${current.id}`;
    let providerMetadata: Record<string, unknown> = {
      delivery_state: "captured_local",
      captured_at: nowIso,
    };
    let capture: CapturedNewsletter | null = null;
    if (localCapture) {
      const built = buildNewsletterMessage(rendered);
      capture = {
        subject: built.subject,
        text: built.text,
        html: built.html,
        raw: built.raw,
        unsubscribe_url: rendered.unsubscribeUrl,
        customize_url: rendered.customizeUrl ?? "",
      };
    } else {
      const result = await sendNewsletterViaForwardEmail(env, rendered, fetcher);
      provider = result.provider;
      providerMessageId = result.providerMessageId;
      providerMetadata = { accepted_at: result.acceptedAt };
    }
    await env.DB.prepare(
      `UPDATE newsletter_deliveries
       SET status = 'sent', sent_at = ?, locked_at = NULL, provider = ?,
           provider_message_id = ?, provider_metadata_json = ?, capture_json = ?,
           last_error = '', updated_at = ?
       WHERE id = ? AND status = 'processing'`,
    ).bind(
      nowIso,
      provider,
      providerMessageId,
      JSON.stringify(providerMetadata),
      capture ? JSON.stringify(capture) : null,
      nowIso,
      current.id,
    ).run();
    await finishDigest(env, current.digest_id, nowIso);
    return true;
  } catch (error) {
    const attempt = Math.min(MAX_DELIVERY_ATTEMPTS, Number(delivery.attempts) + 1);
    const retryable = error instanceof ForwardEmailDeliveryError ? error.retryable : true;
    const uncertain = error instanceof ForwardEmailDeliveryError && error.uncertain;
    const attempts = retryable ? attempt : MAX_DELIVERY_ATTEMPTS;
    const retryAt = new Date(now.getTime() + retryDelaySeconds(attempt) * 1_000).toISOString();
    const message = error instanceof Error ? error.message : "Newsletter delivery failed";
    if (uncertain) {
      const reconcileAt = new Date(now.getTime() + 5 * 60 * 1_000).toISOString();
      await env.DB.prepare(
        `UPDATE newsletter_deliveries
         SET status = 'processing', locked_at = NULL,
             reconciliation_status = 'pending', reconciliation_attempts = 0,
             reconcile_after = ?, last_reconciled_at = NULL,
             provider_metadata_json = ?, last_error = ?, updated_at = ?
         WHERE id = ? AND status = 'processing'`,
      ).bind(
        reconcileAt,
        JSON.stringify({ delivery_state: "uncertain", occurred_at: nowIso }),
        message.slice(0, 1000),
        nowIso,
        delivery.id,
      ).run();
      await finishDigest(env, delivery.digest_id, nowIso);
      return false;
    }
    await env.DB.prepare(
      `UPDATE newsletter_deliveries
       SET status = 'failed', attempts = ?, available_at = ?, locked_at = NULL,
           last_error = ?, updated_at = ?
       WHERE id = ? AND status = 'processing'`,
    ).bind(attempts, retryAt, message.slice(0, 1000), nowIso, delivery.id).run();
    await finishDigest(env, delivery.digest_id, nowIso);
    return false;
  }
}

export async function processNewsletterJobs(
  env: Env,
  limit = 25,
  fetcher: typeof fetch = fetch,
): Promise<number> {
  const newsletterEnv = env as NewsletterEnv;
  if (!newsletterDeliveryEnabled(env)) return 0;
  const now = new Date();
  const nowIso = now.toISOString();
  const staleLock = new Date(now.getTime() - 10 * 60 * 1_000).toISOString();
  const staleDigests = await env.DB.prepare(
    `SELECT DISTINCT digest_id FROM newsletter_deliveries
     WHERE status = 'processing' AND reconciliation_status = 'none' AND locked_at <= ?`,
  ).bind(staleLock).all<{ digest_id: string }>();
  await env.DB.prepare(
    `UPDATE newsletter_deliveries
     SET status = 'failed', locked_at = NULL, available_at = ?, updated_at = ?
     WHERE status = 'processing' AND reconciliation_status = 'none' AND locked_at <= ?`,
  ).bind(nowIso, nowIso, staleLock).run();
  for (const row of staleDigests.results) await finishDigest(env, row.digest_id, nowIso);
  const bounded = Math.max(1, Math.min(limit, 100));
  const rows = await env.DB.prepare(
    `SELECT delivery.id, delivery.digest_id, delivery.subscriber_id,
            delivery.recipient_email, delivery.mode, delivery.status,
            delivery.attempts, delivery.available_at, digest.event_ids_json,
            subscriber.member_id
     FROM newsletter_deliveries delivery
     JOIN newsletter_digests digest ON digest.id = delivery.digest_id
     JOIN subscribers subscriber ON subscriber.id = delivery.subscriber_id
     LEFT JOIN newsletter_suppressions suppression ON suppression.subscriber_id = subscriber.id
     WHERE delivery.status IN ('pending', 'failed')
       AND delivery.reconciliation_status = 'none'
       AND delivery.attempts < ? AND delivery.available_at <= ?
       AND subscriber.status = 'active' AND suppression.subscriber_id IS NULL
     ORDER BY delivery.available_at, delivery.created_at
     LIMIT ?`,
  ).bind(MAX_DELIVERY_ATTEMPTS, nowIso, bounded).all<DeliveryRow>();
  let processed = 0;
  for (const delivery of rows.results) {
    if (await processDelivery(newsletterEnv, delivery, fetcher)) processed += 1;
  }
  return processed;
}

function reconciliationDelaySeconds(attempt: number): number {
  return Math.min(6 * 60 * 60, 5 * 60 * (2 ** Math.max(0, attempt - 1)));
}

export async function reconcileNewsletterDeliveries(
  env: Env,
  limit = 25,
  fetcher: typeof fetch = fetch,
): Promise<number> {
  if (!newsletterReconciliationEnabled(env)) return 0;
  const now = new Date();
  const nowIso = now.toISOString();
  const rows = await env.DB.prepare(
    `SELECT id, digest_id, subscriber_id, recipient_email, mode, status, attempts,
            available_at, '' AS event_ids_json, NULL AS member_id,
            provider_message_id, reconciliation_status, reconciliation_attempts,
            reconcile_after
     FROM newsletter_deliveries
     WHERE status = 'processing' AND reconciliation_status = 'pending'
       AND reconcile_after <= ?
     ORDER BY reconcile_after, updated_at
     LIMIT ?`,
  ).bind(nowIso, Math.max(1, Math.min(limit, 100))).all<DeliveryRow>();
  let processed = 0;
  for (const delivery of rows.results) {
    const attempt = Math.min(10, Number(delivery.reconciliation_attempts ?? 0) + 1);
    try {
      let result = delivery.provider_message_id
        ? await retrieveForwardEmailStatus(env, delivery.provider_message_id, fetcher)
        : { found: false, providerMessageId: "", status: "not_found" };
      if (!result.found) result = await findForwardEmailByReference(env, delivery.id, fetcher);
      if (result.found) {
        const providerFailure = TERMINAL_PROVIDER_FAILURE_STATUSES.has(result.status);
        const updated = await env.DB.prepare(
          `UPDATE newsletter_deliveries
           SET status = ?, attempts = CASE WHEN ? = 1 THEN ? ELSE attempts END,
               sent_at = CASE WHEN ? = 1 THEN sent_at ELSE COALESCE(sent_at, ?) END,
               locked_at = NULL,
               provider = 'forward_email', provider_message_id = ?,
               provider_metadata_json = ?, reconciliation_status = 'resolved',
               reconciliation_attempts = ?, reconcile_after = NULL,
               last_reconciled_at = ?,
               last_error = CASE WHEN ? = 1 THEN ? ELSE '' END,
               updated_at = ?
           WHERE id = ? AND status = 'processing' AND reconciliation_status = 'pending'`,
        ).bind(
          providerFailure ? "failed" : "sent",
          providerFailure ? 1 : 0,
          MAX_DELIVERY_ATTEMPTS,
          providerFailure ? 1 : 0,
          nowIso,
          result.providerMessageId,
          JSON.stringify({ delivery_state: "provider_confirmed", provider_status: result.status }),
          attempt,
          nowIso,
          providerFailure ? 1 : 0,
          providerFailure ? `Provider status readback reported ${result.status}.` : "",
          nowIso,
          delivery.id,
        ).run();
        if (Number(updated.meta.changes ?? 0) === 1) {
          processed += 1;
          await finishDigest(env, delivery.digest_id, nowIso);
        }
        continue;
      }
      const manualReview = attempt >= MAX_DELIVERY_ATTEMPTS;
      const nextAttempt = manualReview
        ? null
        : new Date(now.getTime() + reconciliationDelaySeconds(attempt) * 1_000).toISOString();
      const updated = await env.DB.prepare(
        `UPDATE newsletter_deliveries
         SET reconciliation_status = ?, reconciliation_attempts = ?,
             reconcile_after = ?, last_reconciled_at = ?,
             last_error = ?, updated_at = ?
         WHERE id = ? AND status = 'processing' AND reconciliation_status = 'pending'`,
      ).bind(
        manualReview ? "manual_review" : "pending",
        attempt,
        nextAttempt,
        nowIso,
        manualReview
          ? "Provider readback could not establish whether this message was accepted; manual review is required."
          : "Provider readback has not found this message yet.",
        nowIso,
        delivery.id,
      ).run();
      if (Number(updated.meta.changes ?? 0) === 1) processed += 1;
    } catch (error) {
      const manualReview = attempt >= MAX_DELIVERY_ATTEMPTS;
      const nextAttempt = manualReview
        ? null
        : new Date(now.getTime() + reconciliationDelaySeconds(attempt) * 1_000).toISOString();
      const message = error instanceof Error ? error.message : "Provider readback failed";
      const updated = await env.DB.prepare(
        `UPDATE newsletter_deliveries
         SET reconciliation_status = ?, reconciliation_attempts = ?,
             reconcile_after = ?, last_reconciled_at = ?,
             last_error = ?, updated_at = ?
         WHERE id = ? AND status = 'processing' AND reconciliation_status = 'pending'`,
      ).bind(
        manualReview ? "manual_review" : "pending",
        attempt,
        nextAttempt,
        nowIso,
        message.slice(0, 1000),
        nowIso,
        delivery.id,
      ).run();
      if (Number(updated.meta.changes ?? 0) === 1) processed += 1;
    }
  }
  return processed;
}

export async function newsletterMaintenance(env: Env, now = new Date()): Promise<number> {
  const retentionDays = positiveInteger(env.EMAIL_METADATA_RETENTION_DAYS, 90, 365);
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1_000).toISOString();
  const [confirmations, providerEvents, deliveries, digests] = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM newsletter_confirmation_requests
       WHERE updated_at <= ? AND status IN ('confirmed', 'cancelled', 'failed')`,
    ).bind(cutoff),
    env.DB.prepare(
      `DELETE FROM newsletter_provider_events WHERE processed_at <= ?`,
    ).bind(cutoff),
    env.DB.prepare(
      `DELETE FROM newsletter_deliveries
       WHERE updated_at <= ?
         AND (
           status IN ('sent', 'cancelled')
           OR (status = 'failed' AND attempts >= ?)
         )`,
    ).bind(cutoff, MAX_DELIVERY_ATTEMPTS),
    env.DB.prepare(
      `DELETE FROM newsletter_digests
       WHERE updated_at <= ? AND status IN ('completed', 'failed', 'cancelled')
         AND NOT EXISTS (
           SELECT 1 FROM newsletter_deliveries
           WHERE newsletter_deliveries.digest_id = newsletter_digests.id
         )`,
    ).bind(cutoff),
  ]);
  return Number(confirmations.meta.changes ?? 0)
    + Number(providerEvents.meta.changes ?? 0)
    + Number(deliveries.meta.changes ?? 0)
    + Number(digests.meta.changes ?? 0);
}

export async function suppressNewsletterSubscriber(
  env: Env,
  email: string,
  reason: SuppressionReason,
  providerEventId: string | null = null,
  details = "",
): Promise<boolean> {
  const normalized = normalizedEmail(email);
  if (!normalized) return false;
  const subscriber = await env.DB.prepare(
    "SELECT id FROM subscribers WHERE email = ?",
  ).bind(normalized).first<{ id: string }>();
  if (!subscriber) return false;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO newsletter_suppressions (
       subscriber_id, reason, provider_event_id, details, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(subscriber_id) DO UPDATE SET
       reason = excluded.reason,
       provider_event_id = COALESCE(excluded.provider_event_id, newsletter_suppressions.provider_event_id),
       details = excluded.details,
       updated_at = excluded.updated_at`,
  ).bind(
    subscriber.id,
    reason,
    providerEventId?.slice(0, 500) ?? null,
    details.slice(0, 1000),
    now,
    now,
  ).run();
  return true;
}

function parsedCapture(value: string | null): CapturedNewsletter | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as CapturedNewsletter;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export async function developmentNewsletterInbox(request: Request, env: Env): Promise<Response> {
  if (env.ENVIRONMENT !== "local" && env.ENVIRONMENT !== "test") {
    throw new ApiError(404, "not_found", "Not found.");
  }
  requireTrustedRequest(request, env);
  const [rows, confirmations] = await Promise.all([
    env.DB.prepare(
      `SELECT id, digest_id, recipient_email, mode, status, attempts,
              sent_at, provider, provider_metadata_json, last_error,
              capture_json, created_at, updated_at
       FROM newsletter_deliveries
       ORDER BY created_at DESC LIMIT 100`,
    ).all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT id, email AS recipient_email, status, attempts, sent_at,
              provider, provider_metadata_json, last_error, capture_json,
              created_at, updated_at
       FROM newsletter_confirmation_requests
       ORDER BY created_at DESC LIMIT 100`,
    ).all<Record<string, unknown>>(),
  ]);
  return json({
    emails: [
      ...confirmations.results.map((row) => ({
        id: row.id,
        digest_id: null,
        recipient_email: row.recipient_email,
        delivery_mode: "confirmation",
        message_type: "newsletter_confirmation",
        status: row.status,
        attempts: row.attempts,
        sent_at: row.sent_at,
        provider: row.provider || "forward_email",
        capture_state: row.capture_json ? "captured_local" : "not_captured",
        from_email: "news@servethecays.com",
        reply_to_email: "hello@servethecays.com",
        last_error: row.last_error,
        created_at: row.created_at,
        ...parsedCapture(typeof row.capture_json === "string" ? row.capture_json : null),
      })),
      ...rows.results.map((row) => ({
      id: row.id,
      digest_id: row.digest_id,
      recipient_email: row.recipient_email,
      delivery_mode: row.mode,
      status: row.status,
      attempts: row.attempts,
      sent_at: row.sent_at,
      provider: row.provider || "forward_email",
      capture_state: row.capture_json ? "captured_local" : "not_captured",
      from_email: "news@servethecays.com",
      reply_to_email: "hello@servethecays.com",
      last_error: row.last_error,
      created_at: row.created_at,
      ...parsedCapture(typeof row.capture_json === "string" ? row.capture_json : null),
      })),
    ].sort((left, right) => String(right.created_at ?? "").localeCompare(String(left.created_at ?? ""))).slice(0, 100),
  });
}
