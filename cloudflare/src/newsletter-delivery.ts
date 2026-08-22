import { EMAIL_LOGO_PATH, RESPONSIVE_EMAIL_STYLES } from "./email-layout";
import {
  ForwardEmailDeliveryError,
  providerIdentifier,
  sendRawViaForwardEmail,
  type ForwardEmailResult,
} from "./forward-email";

export { ForwardEmailDeliveryError, type ForwardEmailResult } from "./forward-email";

const FORWARD_EMAIL_ENDPOINT = "https://api.forwardemail.net/v1/emails";
const NEWSLETTER_FROM_ADDRESS = "news@servethecays.com";
const NEWSLETTER_FROM_NAME = "Serve The Cays Updates";
const NEWSLETTER_REPLY_TO = "hello@servethecays.com";
const NEWSLETTER_LIST_ID = "updates.servethecays.com";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface NewsletterDeliveryEnvironment {
  FORWARD_EMAIL_NEWSLETTER_PASSWORD?: string;
  FORWARD_EMAIL_API_TOKEN?: string;
}

export interface NewsletterMessageInput {
  deliveryId: string;
  recipient: string;
  subject: string;
  text: string;
  html: string;
  unsubscribeUrl: string;
  customizeUrl?: string;
  sentAt?: Date;
}

export interface BuiltNewsletterMessage {
  raw: string;
  subject: string;
  text: string;
  html: string;
}

export interface NewsletterConfirmationMessageInput {
  requestId: string;
  recipient: string;
  confirmationUrl: string;
  expiresAt: Date;
  sentAt?: Date;
}

export interface ForwardEmailStatus {
  found: boolean;
  providerMessageId: string;
  status: string;
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

function encodedBody(value: string): string {
  const encoded = base64(new TextEncoder().encode(value));
  return encoded.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

function safeHttpUrl(value: string, label: string): string {
  const clean = value.trim();
  if (/[\r\n]/.test(clean)) throw new ForwardEmailDeliveryError(`Invalid ${label} URL`, false);
  try {
    const parsed = new URL(clean);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error();
    return parsed.toString();
  } catch {
    throw new ForwardEmailDeliveryError(`Invalid ${label} URL`, false);
  }
}

function withVisibleFooter(
  text: string,
  html: string,
  unsubscribeUrl: string,
  customizeUrl?: string,
): { text: string; html: string } {
  const textLinks = [
    customizeUrl ? `Customize your updates: ${customizeUrl}` : "",
    `Unsubscribe: ${unsubscribeUrl}`,
  ].filter(Boolean).join("\n");
  const htmlLinks = [
    customizeUrl ? `<a href="${customizeUrl}" style="color:#006c65;text-decoration:underline">Customize your updates</a>` : "",
    `<a href="${unsubscribeUrl}" style="color:#006c65;text-decoration:underline">Unsubscribe</a>`,
  ].filter(Boolean).join(" &nbsp;·&nbsp; ");
  const footer = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;margin:0;background:#f4f7f6">
    <tr><td align="center" style="padding:4px 16px 32px">
      <p style="max-width:620px;margin:0 auto;color:#6c7d79;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.55;text-align:center">You are receiving these updates because you subscribed to Serve the Cays community news.<br>${htmlLinks}</p>
    </td></tr>
  </table>`;
  return {
    text: `${text.trim()}\n\n${textLinks}\n`,
    html: /<\/body>/i.test(html)
      ? html.replace(/<\/body>/i, `${footer}</body>`)
      : `${html}${footer}`,
  };
}

export function buildNewsletterMessage(input: NewsletterMessageInput): BuiltNewsletterMessage {
  const recipient = cleanHeader(input.recipient.toLowerCase(), 254);
  if (!EMAIL_PATTERN.test(recipient)) {
    throw new ForwardEmailDeliveryError("Invalid newsletter recipient", false);
  }
  const subject = cleanHeader(input.subject, 200);
  if (!subject) throw new ForwardEmailDeliveryError("Newsletter subject is required", false);
  const unsubscribeUrl = safeHttpUrl(input.unsubscribeUrl, "unsubscribe");
  const customizeUrl = input.customizeUrl
    ? safeHttpUrl(input.customizeUrl, "customization")
    : undefined;
  const body = withVisibleFooter(input.text, input.html, unsubscribeUrl, customizeUrl);
  const messageKey = input.deliveryId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 100) || crypto.randomUUID();
  const boundary = `stc-${messageKey}`;
  const sentAt = input.sentAt ?? new Date();
  const raw = [
    `From: ${NEWSLETTER_FROM_NAME} <${NEWSLETTER_FROM_ADDRESS}>`,
    `To: ${recipient}`,
    `Reply-To: ${NEWSLETTER_REPLY_TO}`,
    `Subject: ${encodedHeader(subject)}`,
    `Date: ${sentAt.toUTCString()}`,
    `Message-ID: <${messageKey}@servethecays.com>`,
    `List-ID: Serve The Cays Updates <${NEWSLETTER_LIST_ID}>`,
    `List-Unsubscribe: <${unsubscribeUrl}>`,
    "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
    "Precedence: bulk",
    `X-Entity-Ref-ID: ${messageKey}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    encodedBody(body.text),
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    encodedBody(body.html),
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return { raw, subject, text: body.text, html: body.html };
}

export function buildNewsletterConfirmationMessage(
  input: NewsletterConfirmationMessageInput,
): BuiltNewsletterMessage {
  const recipient = cleanHeader(input.recipient.toLowerCase(), 254);
  if (!EMAIL_PATTERN.test(recipient)) {
    throw new ForwardEmailDeliveryError("Invalid newsletter recipient", false);
  }
  const confirmationUrl = safeHttpUrl(input.confirmationUrl, "confirmation");
  const origin = new URL(confirmationUrl).origin;
  const messageKey = input.requestId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 100) || crypto.randomUUID();
  const boundary = `stc-${messageKey}`;
  const sentAt = input.sentAt ?? new Date();
  const subject = "Confirm your Serve the Cays updates";
  const expiry = input.expiresAt.toLocaleString("en-BS", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Nassau",
  });
  const text = `Confirm your community updates\n\nUse this private link to confirm that you want event and community updates from Serve the Cays:\n${confirmationUrl}\n\nThis link expires ${expiry}. If you did not request this, you can ignore this message. You are not subscribed until you confirm.`;
  const html = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no"><title>${subject}</title>${RESPONSIVE_EMAIL_STYLES}</head>
  <body id="body" style="margin:0;padding:0;background:#f4f7f6;color:#173c38;font-family:Arial,Helvetica,sans-serif">
    <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;opacity:0;color:transparent">One more step to receive Serve the Cays community updates.</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;margin:0;background:#f4f7f6">
      <tr><td class="stc-email-gutter" align="center" style="padding:32px 16px">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;max-width:620px;margin:0 auto;border:1px solid #d6e3e1;border-radius:10px;background:#ffffff;overflow:hidden">
          <tr><td height="4" style="height:4px;background:#00b6a8;font-size:0;line-height:0">&nbsp;</td></tr>
          <tr><td class="stc-email-content" style="padding:26px 28px 30px">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
              <td width="58" valign="middle" style="width:58px;vertical-align:middle"><img src="${origin}${EMAIL_LOGO_PATH}" width="48" height="48" alt="" style="display:block;width:48px;height:48px;border:0"></td>
              <td valign="middle" style="vertical-align:middle"><span style="display:block;color:#153c38;font-size:20px;font-weight:700;line-height:1.2">Serve the Cays</span><span style="display:block;margin-top:4px;color:#6d7c79;font-size:10px;font-weight:700;line-height:1.2;letter-spacing:.13em;text-transform:uppercase">Community in action</span></td>
            </tr></table>
            <div style="width:28px;height:3px;margin:24px 0 14px;background:#ff66a1;font-size:0;line-height:0">&nbsp;</div>
            <p style="margin:0 0 8px;color:#007f75;font-size:11px;font-weight:700;letter-spacing:.13em;text-transform:uppercase">Confirm your subscription</p>
            <h1 class="stc-email-title" style="margin:0 0 12px;color:#102c29;font-size:30px;line-height:1.18;letter-spacing:-.03em">Stay connected to your community</h1>
            <p class="stc-email-copy" style="margin:0 0 22px;color:#50615e;font-size:16px;line-height:1.6">Confirm your email address to receive upcoming events, volunteer opportunities, and community updates from Serve the Cays.</p>
            <table class="stc-email-button" role="presentation" cellspacing="0" cellpadding="0"><tr><td class="stc-email-button-cell" style="border-radius:6px;background:#000000"><a class="stc-email-button-link" href="${confirmationUrl}" style="display:inline-block;padding:14px 22px;color:#ffffff;font-size:16px;font-weight:700;line-height:1.2;text-decoration:none">Confirm community updates</a></td></tr></table>
            <p style="margin:22px 0 0;color:#6c7d79;font-size:13px;line-height:1.55">This private link expires ${expiry}. If you did not request these updates, ignore this message. You will not be subscribed.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
  const raw = [
    `From: ${NEWSLETTER_FROM_NAME} <${NEWSLETTER_FROM_ADDRESS}>`,
    `To: ${recipient}`,
    `Reply-To: ${NEWSLETTER_REPLY_TO}`,
    `Subject: ${encodedHeader(subject)}`,
    `Date: ${sentAt.toUTCString()}`,
    `Message-ID: <${messageKey}@servethecays.com>`,
    `X-Entity-Ref-ID: ${messageKey}`,
    "Auto-Submitted: auto-generated",
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    encodedBody(text),
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    encodedBody(html),
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return { raw, subject, text, html };
}

function basicAuthorization(username: string, password: string): string {
  return `Basic ${base64(new TextEncoder().encode(`${username}:${password}`))}`;
}

function forwardEmailAuthorization(env: NewsletterDeliveryEnvironment): string {
  const apiToken = env.FORWARD_EMAIL_API_TOKEN?.trim() ?? "";
  if (apiToken) return basicAuthorization(apiToken, "");
  throw new ForwardEmailDeliveryError("Forward Email API credentials are not configured", false);
}

export async function sendNewsletterViaForwardEmail(
  env: NewsletterDeliveryEnvironment,
  input: NewsletterMessageInput,
  fetcher: typeof fetch = fetch,
): Promise<ForwardEmailResult> {
  const message = buildNewsletterMessage(input);
  return sendRawViaForwardEmail(
    NEWSLETTER_FROM_ADDRESS,
    env.FORWARD_EMAIL_NEWSLETTER_PASSWORD ?? "",
    message.raw,
    fetcher,
  );
}

export async function sendNewsletterConfirmationViaForwardEmail(
  env: NewsletterDeliveryEnvironment,
  input: NewsletterConfirmationMessageInput,
  fetcher: typeof fetch = fetch,
): Promise<ForwardEmailResult> {
  const message = buildNewsletterConfirmationMessage(input);
  return sendRawViaForwardEmail(
    NEWSLETTER_FROM_ADDRESS,
    env.FORWARD_EMAIL_NEWSLETTER_PASSWORD ?? "",
    message.raw,
    fetcher,
  );
}

function providerRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.data && typeof record.data === "object" && !Array.isArray(record.data)) {
    return providerRecord(record.data) ?? record;
  }
  return record;
}

function providerRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.map(providerRecord).filter((record): record is Record<string, unknown> => Boolean(record));
  const record = providerRecord(value);
  if (!record) return [];
  for (const key of ["emails", "results", "items", "data"]) {
    if (Array.isArray(record[key])) return providerRecords(record[key]);
  }
  return [record];
}

function providerStatus(value: Record<string, unknown>): string {
  for (const candidate of [value.status, value.state, value.delivery_status]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim().toLowerCase().slice(0, 100);
  }
  return "unknown";
}

async function forwardEmailJson(
  env: NewsletterDeliveryEnvironment,
  url: string,
  fetcher: typeof fetch,
): Promise<{ response: Response; value: unknown }> {
  const authorization = forwardEmailAuthorization(env);
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: { Authorization: authorization, Accept: "application/json" },
      // Workers does not implement `redirect: "error"`. Manual mode prevents
      // following a redirect with the account authorization header attached.
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ForwardEmailDeliveryError("Forward Email status could not be reached", true);
  }
  if (response.status === 404) return { response, value: null };
  if (!response.ok) {
    throw new ForwardEmailDeliveryError(
      `Forward Email status returned HTTP ${response.status}`,
      response.status === 408 || response.status === 429 || response.status >= 500,
      response.status,
    );
  }
  try {
    return { response, value: await response.json() };
  } catch {
    throw new ForwardEmailDeliveryError("Forward Email status returned an invalid response", true, response.status);
  }
}

export async function retrieveForwardEmailStatus(
  env: NewsletterDeliveryEnvironment,
  providerMessageId: string,
  fetcher: typeof fetch = fetch,
): Promise<ForwardEmailStatus> {
  const id = providerMessageId.trim().slice(0, 500);
  if (!id) return { found: false, providerMessageId: "", status: "not_found" };
  const { value } = await forwardEmailJson(env, `${FORWARD_EMAIL_ENDPOINT}/${encodeURIComponent(id)}`, fetcher);
  if (!value) return { found: false, providerMessageId: id, status: "not_found" };
  const record = providerRecords(value)[0];
  return record
    ? { found: true, providerMessageId: providerIdentifier(record) || id, status: providerStatus(record) }
    : { found: false, providerMessageId: id, status: "not_found" };
}

export async function findForwardEmailByReference(
  env: NewsletterDeliveryEnvironment,
  reference: string,
  fetcher: typeof fetch = fetch,
): Promise<ForwardEmailStatus> {
  const clean = reference.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 100);
  if (!clean) return { found: false, providerMessageId: "", status: "not_found" };
  const url = `${FORWARD_EMAIL_ENDPOINT}?q=${encodeURIComponent(clean)}&limit=10&sort=-created_at`;
  const { value } = await forwardEmailJson(env, url, fetcher);
  const match = providerRecords(value).find((record) => {
    const serialized = JSON.stringify(record);
    return serialized.includes(clean);
  });
  return match
    ? { found: true, providerMessageId: providerIdentifier(match), status: providerStatus(match) }
    : { found: false, providerMessageId: "", status: "not_found" };
}

export const NEWSLETTER_SENDER = Object.freeze({
  from: NEWSLETTER_FROM_ADDRESS,
  replyTo: NEWSLETTER_REPLY_TO,
  listId: NEWSLETTER_LIST_ID,
});
