const FORWARD_EMAIL_ENDPOINT = "https://api.forwardemail.net/v1/emails";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ForwardEmailResult {
  provider: "forward_email";
  providerMessageId: string;
  acceptedAt: string;
}

export interface ForwardEmailAttachment {
  content: string | ArrayBuffer | ArrayBufferView;
  disposition?: "attachment" | "inline";
  filename: string;
  type: string;
}

export interface ForwardEmailMessageInput {
  attachments?: ForwardEmailAttachment[];
  date?: Date;
  fromEmail: string;
  fromName: string;
  html: string;
  messageId: string;
  replyTo: string;
  subject: string;
  text: string;
  to: string;
}

export class ForwardEmailDeliveryError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status: number | null = null,
    readonly uncertain = false,
  ) {
    super(message);
  }
}

function cleanHeader(value: string, maximum: number): string {
  return value.replace(/[\r\n]+/g, " ").trim().slice(0, maximum);
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function encodedHeader(value: string): string {
  const clean = cleanHeader(value, 300);
  return /^[\x20-\x7e]*$/.test(clean)
    ? clean
    : `=?UTF-8?B?${base64(new TextEncoder().encode(clean))}?=`;
}

function encodedBody(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const encoded = base64(bytes);
  return encoded.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

function attachmentBytes(value: ForwardEmailAttachment["content"]): Uint8Array {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function emailAddress(value: string, label: string): string {
  const clean = cleanHeader(value.toLowerCase(), 254);
  if (!EMAIL_PATTERN.test(clean)) {
    throw new ForwardEmailDeliveryError(`Invalid ${label} address`, false);
  }
  return clean;
}

function safeToken(value: string, fallback: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 100) || fallback;
}

function attachmentPart(boundary: string, attachment: ForwardEmailAttachment): string[] {
  const filename = cleanHeader(attachment.filename, 180).replace(/["\\]/g, "_") || "attachment";
  const type = cleanHeader(attachment.type, 180) || "application/octet-stream";
  const disposition = attachment.disposition === "inline" ? "inline" : "attachment";
  return [
    `--${boundary}`,
    `Content-Type: ${type}; name="${filename}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: ${disposition}; filename="${filename}"`,
    "",
    encodedBody(attachmentBytes(attachment.content)),
  ];
}

export function buildForwardEmailMessage(input: ForwardEmailMessageInput): string {
  const fromEmail = emailAddress(input.fromEmail, "sender");
  const to = emailAddress(input.to, "recipient");
  const replyTo = emailAddress(input.replyTo, "reply-to");
  const fromName = cleanHeader(input.fromName, 120) || "Serve the Cays";
  const subject = cleanHeader(input.subject, 200);
  if (!subject) throw new ForwardEmailDeliveryError("Email subject is required", false);
  const messageKey = safeToken(input.messageId, crypto.randomUUID());
  const alternativeBoundary = `stc-alt-${messageKey}`;
  const attachments = input.attachments ?? [];
  const mixedBoundary = `stc-mixed-${messageKey}`;
  const headers = [
    `From: ${encodedHeader(fromName)} <${fromEmail}>`,
    `To: ${to}`,
    `Reply-To: ${replyTo}`,
    `Subject: ${encodedHeader(subject)}`,
    `Date: ${(input.date ?? new Date()).toUTCString()}`,
    `Message-ID: <${messageKey}@servethecays.com>`,
    `X-Entity-Ref-ID: ${messageKey}`,
    "Auto-Submitted: auto-generated",
    "MIME-Version: 1.0",
  ];
  const alternative = [
    `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
    "",
    `--${alternativeBoundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    encodedBody(input.text),
    `--${alternativeBoundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    encodedBody(input.html),
    `--${alternativeBoundary}--`,
  ];
  if (!attachments.length) return [...headers, ...alternative, ""].join("\r\n");
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
    "",
    `--${mixedBoundary}`,
    ...alternative,
    ...attachments.flatMap((attachment) => attachmentPart(mixedBoundary, attachment)),
    `--${mixedBoundary}--`,
    "",
  ].join("\r\n");
}

function basicAuthorization(username: string, password: string): string {
  return `Basic ${base64(new TextEncoder().encode(`${username}:${password}`))}`;
}

export function providerIdentifier(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  for (const candidate of [record.id, record._id, record.email_id]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim().slice(0, 500);
  }
  if (record.data && typeof record.data === "object" && !Array.isArray(record.data)) {
    return providerIdentifier(record.data);
  }
  return "";
}

export async function sendRawViaForwardEmail(
  username: string,
  password: string,
  raw: string,
  fetcher: typeof fetch = fetch,
): Promise<ForwardEmailResult> {
  const cleanUsername = emailAddress(username, "sender");
  const cleanPassword = password.trim();
  if (!cleanPassword) {
    throw new ForwardEmailDeliveryError("Forward Email alias credentials are not configured", false);
  }
  const body = new URLSearchParams({ raw });
  let response: Response;
  try {
    response = await fetcher(FORWARD_EMAIL_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: basicAuthorization(cleanUsername, cleanPassword),
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Accept: "application/json",
      },
      body,
      // Workers does not implement `redirect: "error"`. Manual mode keeps
      // credentials on this request while letting us reject any 3xx below.
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ForwardEmailDeliveryError("Forward Email could not be reached", true, null, true);
  }
  if (!response.ok) {
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    const uncertain = response.status === 408 || response.status >= 500;
    throw new ForwardEmailDeliveryError(
      `Forward Email returned HTTP ${response.status}`,
      retryable,
      response.status,
      uncertain,
    );
  }
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new ForwardEmailDeliveryError("Forward Email returned an invalid response", false, response.status, true);
  }
  const providerMessageId = providerIdentifier(result);
  if (!providerMessageId) {
    throw new ForwardEmailDeliveryError("Forward Email did not return an email ID", false, response.status, true);
  }
  return {
    provider: "forward_email",
    providerMessageId,
    acceptedAt: new Date().toISOString(),
  };
}
