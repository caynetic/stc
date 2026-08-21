import type { Env } from "./types";

export interface CloudflareEmailResult {
  provider: "cloudflare_email_service";
  providerMessageId: string;
}

export interface CloudflareEmailInput {
  id: string;
  fromEmail: string;
  replyTo: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: EmailAttachment[];
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TRANSACTIONAL_FROM_NAME = "Serve the Cays";
const RETRYABLE_CODES = new Set([
  "E_RATE_LIMIT_EXCEEDED",
  "E_DAILY_LIMIT_EXCEEDED",
  "E_INTERNAL_SERVER_ERROR",
]);
const TERMINAL_CODES = new Set([
  "E_VALIDATION_ERROR",
  "E_FIELD_MISSING",
  "E_TOO_MANY_RECIPIENTS",
  "E_TOO_MANY_ATTACHMENTS",
  "E_SENDER_NOT_VERIFIED",
  "E_RECIPIENT_NOT_ALLOWED",
  "E_RECIPIENT_SUPPRESSED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE",
  "E_CONTENT_TOO_LARGE",
  "E_DELIVERY_FAILED",
  "E_HEADER_NOT_ALLOWED",
  "E_HEADER_USE_API_FIELD",
  "E_HEADER_VALUE_INVALID",
  "E_HEADER_VALUE_TOO_LONG",
  "E_HEADER_NAME_INVALID",
  "E_HEADERS_TOO_LARGE",
  "E_HEADERS_TOO_MANY",
]);

export class CloudflareEmailDeliveryError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly uncertain: boolean;

  constructor(message: string, code = "", retryable = false, uncertain = false) {
    super(message);
    this.name = "CloudflareEmailDeliveryError";
    this.code = code;
    this.retryable = retryable;
    this.uncertain = uncertain;
  }
}

function cleanAddress(value: string, label: string): string {
  const clean = value.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(clean) || /[\r\n]/.test(clean)) {
    throw new CloudflareEmailDeliveryError(`Invalid ${label} address`, "E_VALIDATION_ERROR");
  }
  return clean;
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error)) return "";
  return typeof error.code === "string" ? error.code.trim().slice(0, 100) : "";
}

function providerError(error: unknown): CloudflareEmailDeliveryError {
  const code = errorCode(error);
  if (RETRYABLE_CODES.has(code)) {
    return new CloudflareEmailDeliveryError(
      `Cloudflare Email Service temporarily rejected the message (${code})`,
      code,
      true,
    );
  }
  if (TERMINAL_CODES.has(code)) {
    return new CloudflareEmailDeliveryError(
      `Cloudflare Email Service rejected the message (${code})`,
      code,
    );
  }
  return new CloudflareEmailDeliveryError(
    "Cloudflare Email Service returned an unknown result",
    code,
    false,
    true,
  );
}

export async function sendTransactionalViaCloudflare(
  env: Env,
  input: CloudflareEmailInput,
): Promise<CloudflareEmailResult> {
  if (!env.EMAIL) {
    throw new CloudflareEmailDeliveryError(
      "Cloudflare Email Service binding is not configured",
      "E_BINDING_MISSING",
    );
  }
  const fromEmail = cleanAddress(input.fromEmail, "sender");
  const replyTo = cleanAddress(input.replyTo, "Reply-To");
  const to = cleanAddress(input.to, "recipient");
  const subject = input.subject.replace(/[\r\n]+/g, " ").trim().slice(0, 998);
  if (!subject) {
    throw new CloudflareEmailDeliveryError("Email subject is required", "E_VALIDATION_ERROR");
  }
  const entityReference = input.id.trim().slice(0, 200);
  if (!/^[A-Za-z0-9_-]+$/.test(entityReference)) {
    throw new CloudflareEmailDeliveryError("Invalid email job reference", "E_VALIDATION_ERROR");
  }

  try {
    const result = await env.EMAIL.send({
      to,
      from: { email: fromEmail, name: TRANSACTIONAL_FROM_NAME },
      replyTo,
      subject,
      text: input.text,
      html: input.html,
      headers: { "X-Entity-Ref-ID": entityReference },
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    });
    const providerMessageId = String(result?.messageId ?? "").trim().slice(0, 500);
    if (!providerMessageId) {
      throw new CloudflareEmailDeliveryError(
        "Cloudflare Email Service did not return a message ID",
        "E_MISSING_MESSAGE_ID",
        false,
        true,
      );
    }
    return { provider: "cloudflare_email_service", providerMessageId };
  } catch (error) {
    if (error instanceof CloudflareEmailDeliveryError) throw error;
    throw providerError(error);
  }
}
