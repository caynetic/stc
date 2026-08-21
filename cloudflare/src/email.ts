import { ApiError, json, parseBoolean, positiveInteger } from "./http";
import { RESPONSIVE_EMAIL_STYLES } from "./email-layout";
import {
  CloudflareEmailDeliveryError,
  sendTransactionalViaCloudflare,
} from "./cloudflare-email";
import { expectedOrigin, randomId, requireTrustedRequest } from "./security";
import type { Env } from "./types";

export type EmailKind =
  | "magic_link"
  | "welcome"
  | "rsvp_confirmation"
  | "rsvp_cancellation"
  | "event_reminder"
  | "submission_receipt"
  | "submission_approved"
  | "submission_denied";

export interface QueueEmailInput {
  kind: EmailKind;
  recipientEmail: string;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
  memberId?: string | null;
  subjectType?: string;
  subjectId?: string;
  availableAt?: string;
}

interface EmailJobRow {
  id: string;
  idempotency_key: string;
  kind: EmailKind;
  member_id: string | null;
  recipient_email: string;
  payload_json: string;
  status: "pending" | "processing" | "sent" | "failed";
  attempts: number;
  available_at: string;
  created_at: string;
  updated_at: string;
}

interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
  attachments?: EmailAttachment[];
  previewUrl?: string;
}

interface EmailAction {
  href: string;
  label: string;
}

interface EmailDetail {
  label: string;
  value: string;
}

interface EmailListingCard {
  href: string;
  name: string;
  type: string;
}

interface EmailLayoutOptions {
  eyebrow: string;
  title: string;
  preheader: string;
  paragraphs?: string[];
  details?: EmailDetail[];
  listing?: EmailListingCard;
  features?: string[];
  note?: string;
  action?: EmailAction;
  footer?: string;
}

export function transactionalEmailDeliveryEnabled(env: Env): boolean {
  if (env.ENVIRONMENT === "local" || env.ENVIRONMENT === "test") return true;
  return parseBoolean(env.TRANSACTIONAL_EMAIL_DELIVERY_ENABLED, false);
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cleanLine(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.replace(/[\r\n]+/g, " ").trim().slice(0, 500) : fallback;
}

function payload(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function eventUrl(env: Env, data: Record<string, unknown>): string {
  const supplied = cleanLine(data.event_url || data.public_url);
  if (supplied.startsWith("/")) return `${expectedOrigin(env)}${supplied}`;
  if (supplied.startsWith(`${expectedOrigin(env)}/`)) return supplied;
  const id = Number(data.event_id ?? data.id);
  return Number.isSafeInteger(id) && id > 0 ? `${expectedOrigin(env)}/event/${id}` : expectedOrigin(env);
}

function readableEvent(data: Record<string, unknown>): string {
  const start = new Date(String(data.start_at ?? ""));
  const date = Number.isNaN(start.getTime())
    ? cleanLine(data.start_at, "Date to be confirmed")
    : new Intl.DateTimeFormat("en-BS", {
        dateStyle: "full",
        timeStyle: "short",
        timeZone: cleanLine(data.timezone, "America/Nassau"),
      }).format(start);
  return [date, cleanLine(data.venue_name), cleanLine(data.location_display)].filter(Boolean).join(" · ");
}

function icsTimestamp(value: unknown): string {
  const date = new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function icsEscape(value: unknown): string {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function foldIcsLine(line: string): string[] {
  const encoder = new TextEncoder();
  const folded: string[] = [];
  let segment = "";
  let byteLimit = 75;

  for (const character of line) {
    if (segment && encoder.encode(segment + character).byteLength > byteLimit) {
      folded.push(folded.length ? ` ${segment}` : segment);
      segment = character;
      byteLimit = 74;
    } else {
      segment += character;
    }
  }
  folded.push(folded.length ? ` ${segment}` : segment);
  return folded;
}

function calendarAttachment(env: Env, data: Record<string, unknown>): EmailAttachment | undefined {
  const startDate = new Date(String(data.start_at ?? ""));
  const start = icsTimestamp(startDate);
  if (!start) return undefined;
  const endDate = new Date(String(data.end_at ?? ""));
  const end = !Number.isNaN(endDate.getTime()) && endDate.getTime() > startDate.getTime()
    ? icsTimestamp(endDate)
    : "";
  const eventId = String(data.event_id ?? data.id ?? "event");
  const content = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Serve the Cays//Member RSVP//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:event-${icsEscape(eventId)}@servethecays.com`,
    `DTSTAMP:${icsTimestamp(new Date().toISOString())}`,
    `DTSTART:${start}`,
    ...(end ? [`DTEND:${end}`] : []),
    `SUMMARY:${icsEscape(data.name || "Serve the Cays event")}`,
    `LOCATION:${icsEscape([data.venue_name, data.location_display].filter(Boolean).join(", "))}`,
    `DESCRIPTION:${icsEscape(`Event details: ${eventUrl(env, data)}`)}`,
    `URL:${icsEscape(eventUrl(env, data))}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].flatMap(foldIcsLine).join("\r\n") + "\r\n";
  return {
    disposition: "attachment",
    filename: "serve-the-cays-event.ics",
    type: "text/calendar; charset=utf-8; method=PUBLISH",
    content: new TextEncoder().encode(content).buffer,
  };
}

function detailCard(details: EmailDetail[]): string {
  const rows = details
    .filter((detail) => detail.label && detail.value)
    .map((detail) => `<tr class="stc-detail-row">
      <td class="stc-detail-label" width="110" style="width:110px;padding:0 14px 9px 0;color:#697774;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;vertical-align:top">${escapeHtml(detail.label)}</td>
      <td class="stc-detail-value" style="padding:0 0 9px;color:#183936;font-size:15px;font-weight:600;line-height:1.45">${escapeHtml(detail.value)}</td>
    </tr>`)
    .join("");
  if (!rows) return "";
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:24px 0 0;border:1px solid #cde8e4;border-radius:8px;background:#f4fbfa">
    <tr><td class="stc-detail-card-cell" style="padding:16px 18px 7px">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0">${rows}</table>
    </td></tr>
  </table>`;
}

function listingCard(listing?: EmailListingCard): string {
  if (!listing?.href || !listing.name) return "";
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:24px 0 0;border:1px solid #b9ddd8;border-radius:9px;background:#f4fbfa">
    <tr><td class="stc-listing-card-cell" style="padding:18px 20px">
      <p style="margin:0 0 7px;color:#007f75;font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase">Now listed · ${escapeHtml(listing.type)}</p>
      <p class="stc-listing-title" style="margin:0;color:#102c29;font-size:20px;font-weight:700;line-height:1.35">${escapeHtml(listing.name)}</p>
      <p style="margin:12px 0 0;font-size:14px;line-height:1.45"><a href="${escapeHtml(listing.href)}" style="color:#007f75;font-weight:700;text-decoration:underline">Open this listing <span aria-hidden="true">→</span></a></p>
    </td></tr>
  </table>`;
}

function featureList(features: string[]): string {
  const items = features.filter(Boolean).map((feature) => `<tr>
    <td width="20" style="padding:0 9px 10px 0;color:#007f75;font-size:18px;line-height:1.15;vertical-align:top">•</td>
    <td style="padding:0 0 10px;color:#334c49;font-size:15px;line-height:1.55">${escapeHtml(feature)}</td>
  </tr>`).join("");
  if (!items) return "";
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:20px 0 0"><tbody>${items}</tbody></table>`;
}

function emailButton(action?: EmailAction): string {
  if (!action?.href || !action.label) return "";
  return `<table class="stc-email-button" role="presentation" cellspacing="0" cellpadding="0" style="margin:26px 0 0">
    <tr><td class="stc-email-button-cell" align="center" bgcolor="#000000" style="border-radius:6px">
      <a class="stc-email-button-link" href="${escapeHtml(action.href)}" style="display:inline-block;padding:13px 20px;border:1px solid #000000;border-radius:6px;color:#ffffff;font-size:15px;font-weight:700;line-height:1.2;text-decoration:none">${escapeHtml(action.label)} <span aria-hidden="true">→</span></a>
    </td></tr>
  </table>`;
}

function messageShell(env: Env, options: EmailLayoutOptions): string {
  const origin = expectedOrigin(env);
  const logoUrl = `${origin}/static/images/logo.png`;
  const paragraphs = (options.paragraphs ?? [])
    .filter(Boolean)
    .map((paragraph) => `<p class="stc-email-copy" style="margin:0 0 14px;color:#41514f;font-size:16px;line-height:1.65">${escapeHtml(paragraph)}</p>`)
    .join("");
  const note = options.note
    ? `<p style="margin:22px 0 0;padding:13px 14px;border-left:3px solid #ff66a1;background:#fff7fa;color:#5f4a51;font-size:13px;line-height:1.55">${escapeHtml(options.note)}</p>`
    : "";
  const footer = options.footer || "Serve the Cays brings community opportunities together across The Bahamas.";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="x-apple-disable-message-reformatting">
    <meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no">
    <title>${escapeHtml(options.title)}</title>
    ${RESPONSIVE_EMAIL_STYLES}
  </head>
  <body id="body" style="margin:0;padding:0;background:#f4f7f6;color:#183936;font-family:Arial,Helvetica,sans-serif">
    <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;opacity:0;color:transparent">${escapeHtml(options.preheader)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;margin:0;padding:0;background:#f4f7f6">
      <tr><td class="stc-email-gutter" align="center" style="padding:32px 16px">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;max-width:620px;margin:0 auto;border:1px solid #d6e3e1;border-radius:10px;background:#ffffff;overflow:hidden">
          <tr><td height="4" style="height:4px;background:#00b6a8;font-size:0;line-height:0">&nbsp;</td></tr>
          <tr><td class="stc-email-content" style="padding:24px 28px 26px">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
              <tr>
                <td width="58" valign="middle" style="width:58px;vertical-align:middle">
                  <a href="${escapeHtml(origin)}" style="display:inline-block;text-decoration:none">
                    <img src="${escapeHtml(logoUrl)}" width="48" height="48" alt="" style="display:block;width:48px;height:48px;border:0;outline:none;text-decoration:none">
                  </a>
                </td>
                <td valign="middle" style="vertical-align:middle">
                  <a href="${escapeHtml(origin)}" style="color:#153c38;text-decoration:none">
                    <span style="display:block;color:#153c38;font-size:20px;font-weight:700;line-height:1.2;letter-spacing:-.02em">Serve the Cays</span>
                    <span style="display:block;margin-top:4px;color:#6d7c79;font-size:10px;font-weight:700;line-height:1.2;letter-spacing:.13em;text-transform:uppercase">Community in action</span>
                  </a>
                </td>
              </tr>
            </table>
            <div style="width:28px;height:3px;margin:24px 0 14px;background:#ff66a1;font-size:0;line-height:0">&nbsp;</div>
            <p style="margin:0 0 8px;color:#007f75;font-size:11px;font-weight:700;letter-spacing:.13em;text-transform:uppercase">${escapeHtml(options.eyebrow)}</p>
            <h1 class="stc-email-title" style="margin:0;color:#102c29;font-size:30px;line-height:1.18;letter-spacing:-.03em">${escapeHtml(options.title)}</h1>
            <div style="margin-top:20px">${paragraphs}</div>
            ${listingCard(options.listing)}
            ${detailCard(options.details ?? [])}
            ${featureList(options.features ?? [])}
            ${emailButton(options.action)}
            ${note}
          </td></tr>
          <tr><td class="stc-email-footer" style="padding:17px 28px 19px;border-top:1px solid #e2ecea;background:#fafcfb">
            <p style="margin:0;color:#687875;font-size:12px;line-height:1.55">${escapeHtml(footer)}</p>
            <p style="margin:7px 0 0;color:#84918e;font-size:12px;line-height:1.55">Need help? Reply to this email and our team will be glad to assist.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

function renderEmail(env: Env, kind: EmailKind, data: Record<string, unknown>): RenderedEmail {
  const name = cleanLine(data.name, "your event");
  if (kind === "magic_link") {
    const url = cleanLine(data.sign_in_url);
    const minutes = Number(data.expires_minutes) || 15;
    const text = `Use this secure link to sign in to Serve the Cays:\n\n${url}\n\nThe link expires in ${minutes} minutes and works once. Opening the page does not sign you in until you choose Continue.`;
    return {
      subject: "Your Serve the Cays sign-in link",
      text,
      html: messageShell(env, {
        eyebrow: "Member access",
        title: "Your secure sign-in link",
        preheader: `Use this one-time link within ${minutes} minutes to access My STC.`,
        paragraphs: ["Use this one-time link to sign in to My STC. No password is needed."],
        details: [
          { label: "Expires", value: `${minutes} minutes` },
          { label: "Use", value: "One time" },
        ],
        action: { href: url, label: "Sign in to My STC" },
        note: "For your security, the link opens a confirmation page before it signs you in. If you did not request it, you can safely ignore this email.",
      }),
      previewUrl: url,
    };
  }
  if (kind === "welcome") {
    return {
      subject: "Welcome to My STC",
      text: "Welcome to My STC. You can now save organizations and events, manage RSVPs, and review your suggestions.",
      html: messageShell(env, {
        eyebrow: "Member account",
        title: "Welcome to My STC",
        preheader: "Your personal home for community organizations, events, and plans.",
        paragraphs: ["Your account is ready. Keep the people, organizations, and events that matter to you in one place."],
        features: [
          "Save organizations and events to revisit anytime.",
          "Manage your RSVPs and optional event reminders.",
          "Track community suggestions you submit for review.",
        ],
        action: { href: `${expectedOrigin(env)}/me`, label: "Open My STC" },
      }),
    };
  }
  if (kind === "rsvp_confirmation" || kind === "rsvp_cancellation" || kind === "event_reminder") {
    const detail = readableEvent(data);
    const url = eventUrl(env, data);
    const title = kind === "rsvp_confirmation"
      ? `You're going to ${name}`
      : kind === "rsvp_cancellation"
        ? `Your RSVP for ${name} was cancelled`
        : `${name} is coming up`;
    const lead = kind === "rsvp_confirmation"
      ? "Your RSVP is confirmed."
      : kind === "rsvp_cancellation"
        ? "Your RSVP cancellation is confirmed."
        : "This is the event reminder you requested.";
    const attachment = kind === "rsvp_confirmation" ? calendarAttachment(env, data) : undefined;
    return {
      subject: title,
      text: `${lead}\n\n${name}\n${detail}\n${url}`,
      html: messageShell(env, {
        eyebrow: kind === "event_reminder" ? "Event reminder" : "Your event plans",
        title,
        preheader: `${name} · ${detail}`,
        paragraphs: [lead],
        details: [
          { label: "Event", value: name },
          { label: "When & where", value: detail },
        ],
        action: { href: url, label: "View event" },
        ...(kind === "rsvp_confirmation" ? { note: "A calendar file is attached so you can add this event to your calendar." } : {}),
      }),
      ...(attachment ? { attachments: [attachment] } : {}),
    };
  }
  const type = cleanLine(data.submission_type, "listing");
  if (kind === "submission_receipt") {
    return {
      subject: `We received your ${type} suggestion`,
      text: `Thank you. We received “${name}” for private review. We will contact you when a decision is recorded.`,
      html: messageShell(env, {
        eyebrow: "Community contribution",
        title: "Suggestion received",
        preheader: `We received your ${type} suggestion for private review.`,
        paragraphs: ["Thank you for helping make community opportunities easier to discover. Your suggestion is now with our private review team."],
        details: [
          { label: "Suggestion", value: name },
          { label: "Status", value: "Private review" },
        ],
        action: { href: `${expectedOrigin(env)}/me#suggestions`, label: "View My suggestions" },
        note: "Nothing is published until it has been reviewed. We will email you when there is an update.",
      }),
    };
  }
  if (kind === "submission_approved") {
    const url = eventUrl(env, data);
    const listingType = type === "organization" ? "Organization" : type === "event" ? "Event" : "Community listing";
    return {
      subject: `Your ${type} is now listed on Serve the Cays`,
      text: `Great news — “${name}” has been approved and is now listed on Serve the Cays.\n\nView the published listing:\n${url}`,
      html: messageShell(env, {
        eyebrow: "Published listing",
        title: `Your ${type} is now listed`,
        preheader: `“${name}” is now live on Serve the Cays.`,
        paragraphs: ["Great news — your submission has been approved and the public listing is live."],
        listing: { href: url, name, type: listingType },
        action: { href: url, label: "View your published listing" },
        note: "Thank you for helping people discover ways to connect and serve across The Bahamas.",
      }),
    };
  }
  const reason = cleanLine(data.reason);
  return {
    subject: `An update about your ${type} suggestion`,
    text: `“${name}” was not approved.${reason ? `\n\nReason: ${reason}` : ""}`,
    html: messageShell(env, {
      eyebrow: "Community contribution",
      title: "An update on your suggestion",
      preheader: `There is an update about “${name}”.`,
      paragraphs: ["This suggestion was not approved for publication at this time."],
      details: [
        { label: "Suggestion", value: name },
        ...(reason ? [{ label: "Review note", value: reason }] : []),
      ],
      action: { href: `${expectedOrigin(env)}/me#suggestions`, label: "View My suggestions" },
      note: "You are always welcome to share another suggestion with more information when it is available.",
    }),
  };
}

function queuePayload(input: QueueEmailInput): string {
  return JSON.stringify({
    ...(input.payload ?? {}),
    ...(input.subjectType ? { subject_type: input.subjectType } : {}),
    ...(input.subjectId ? { subject_id: input.subjectId } : {}),
  });
}

async function sendTransactionalEmail(
  env: Env,
  id: string,
  kind: EmailKind,
  recipient: string,
  rendered: RenderedEmail,
): Promise<string> {
  const signIn = kind === "magic_link";
  const fromEmail = signIn
    ? (env.EMAIL_FROM_SIGNIN || "signin@servethecays.com")
    : (env.EMAIL_FROM_NOTIFICATIONS || "notifications@servethecays.com");
  return (await sendTransactionalViaCloudflare(env, {
    id,
    fromEmail,
    replyTo: env.EMAIL_REPLY_TO || "hello@servethecays.com",
    to: recipient,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    attachments: rendered.attachments,
  })).providerMessageId;
}

function queueEmailStatementWithId(env: Env, input: QueueEmailInput, id: string, now: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO email_jobs (
       id, idempotency_key, kind, member_id, recipient_email, payload_json,
       status, attempts, available_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
     ON CONFLICT(idempotency_key) DO NOTHING`,
  ).bind(
    id,
    input.idempotencyKey.slice(0, 500),
    input.kind,
    input.memberId ?? null,
    input.recipientEmail.trim().toLowerCase().slice(0, 254),
    queuePayload(input),
    input.availableAt ?? now,
    now,
    now,
  );
}

export function queueEmailStatement(env: Env, input: QueueEmailInput): D1PreparedStatement {
  const now = new Date().toISOString();
  return queueEmailStatementWithId(env, input, randomId("email"), now);
}

export async function queueEmail(
  env: Env,
  input: QueueEmailInput,
): Promise<string> {
  if (!transactionalEmailDeliveryEnabled(env)) {
    throw new ApiError(503, "email_unavailable", "Email delivery is not enabled in this environment.");
  }
  const id = randomId("email");
  const now = new Date().toISOString();
  const localCapture = env.ENVIRONMENT === "local" || env.ENVIRONMENT === "test";
  if (input.kind === "magic_link" && !localCapture) {
    const rendered = renderEmail(env, input.kind, input.payload ?? {});
    let providerMessageId = "";
    try {
      providerMessageId = await sendTransactionalEmail(
        env,
        id,
        input.kind,
        input.recipientEmail,
        rendered,
      );
    } catch (error) {
      if (error instanceof CloudflareEmailDeliveryError && error.uncertain) {
        const safeInput: QueueEmailInput = {
          ...input,
          payload: { expires_minutes: input.payload?.expires_minutes, delivery_metadata_only: true },
        };
        await env.DB.batch([
          queueEmailStatementWithId(env, safeInput, id, now),
          env.DB.prepare(
            `UPDATE email_jobs
             SET status = 'failed', attempts = 5, locked_at = NULL,
                 last_error = ?, updated_at = ? WHERE id = ?`,
          ).bind(
            "Cloudflare Email Service acceptance was uncertain; this sign-in message was not retried automatically.",
            now,
            id,
          ),
        ]);
        return id;
      }
      // Authentication must remain generic. Keep no raw token in durable retry
      // state if the immediate production send fails.
      throw new ApiError(503, "email_unavailable", "A sign-in link could not be sent right now.");
    }
    const safeInput: QueueEmailInput = {
      ...input,
      payload: { expires_minutes: input.payload?.expires_minutes, delivery_metadata_only: true },
    };
    await env.DB.batch([
      queueEmailStatementWithId(env, safeInput, id, now),
      env.DB.prepare(
        `UPDATE email_jobs
         SET status = 'sent', attempts = 1, sent_at = ?, provider_message_id = ?,
             last_error = '', updated_at = ? WHERE id = ?`,
      ).bind(
        now,
        providerMessageId,
        now,
        id,
      ),
    ]);
    return id;
  }
  await queueEmailStatementWithId(env, input, id, now).run();
  if (input.kind === "magic_link") await processEmailJobs(env, 1, id);
  return id;
}

function retryDelay(attempt: number, error?: CloudflareEmailDeliveryError | null): number {
  if (error?.code === "E_DAILY_LIMIT_EXCEEDED") return 24 * 60 * 60;
  return Math.min(60 * 60, 30 * (2 ** Math.max(0, attempt - 1)));
}

async function processJob(env: Env, job: EmailJobRow): Promise<boolean> {
  const now = new Date();
  const nowIso = now.toISOString();
  const claim = await env.DB.prepare(
    `UPDATE email_jobs
     SET status = 'processing', attempts = attempts + 1, locked_at = ?, updated_at = ?
     WHERE id = ? AND status IN ('pending', 'failed') AND available_at <= ?`,
  ).bind(nowIso, nowIso, job.id, nowIso).run();
  if (Number(claim.meta.changes ?? 0) !== 1) return false;
  let providerAccepted = false;
  try {
    const data = payload(job.payload_json);
    if (job.kind === "event_reminder") {
      const valid = await env.DB.prepare(
        `SELECT 1 AS found
         FROM event_rsvps r
         JOIN members m ON m.id = r.member_id AND m.reminder_emails_enabled = 1
         JOIN events e ON e.id = r.event_id AND e.is_active = 1
         WHERE r.member_id = ? AND r.event_id = ? AND r.status = 'going'
           AND e.start_at > ?`,
      ).bind(job.member_id, Number(data.event_id), nowIso).first<{ found: number }>();
      if (!valid) {
        await env.DB.prepare("DELETE FROM email_jobs WHERE id = ? AND status = 'processing'")
          .bind(job.id)
          .run();
        return false;
      }
    }
    const rendered = renderEmail(env, job.kind, data);
    let providerMessageId = "local-development-inbox";
    const localCapture = env.ENVIRONMENT === "local" || env.ENVIRONMENT === "test";
    if (!localCapture) {
      providerMessageId = await sendTransactionalEmail(
        env,
        job.id,
        job.kind,
        job.recipient_email,
        rendered,
      );
      providerAccepted = true;
    }
    await env.DB.prepare(
      `UPDATE email_jobs
       SET status = 'sent', sent_at = ?, locked_at = NULL,
           provider_message_id = ?, last_error = '',
           payload_json = CASE WHEN ? = 1 THEN payload_json ELSE '{}' END,
           updated_at = ?
       WHERE id = ? AND status = 'processing'`,
    ).bind(
      nowIso,
      providerMessageId.slice(0, 500),
      localCapture ? 1 : 0,
      nowIso,
      job.id,
    ).run();
    return true;
  } catch (error) {
    const attempt = Number(job.attempts) + 1;
    const message = error instanceof Error ? error.message : "Email delivery failed";
    const providerError = error instanceof CloudflareEmailDeliveryError ? error : null;
    const retryAt = new Date(now.getTime() + retryDelay(attempt, providerError) * 1_000).toISOString();
    const uncertain = providerAccepted || providerError?.uncertain === true;
    const retryable = providerError ? providerError.retryable : !providerAccepted;
    const attempts = uncertain || !retryable ? 5 : attempt;
    await env.DB.prepare(
      `UPDATE email_jobs
       SET status = 'failed', attempts = ?, available_at = ?, locked_at = NULL,
           last_error = ?, updated_at = ?
       WHERE id = ? AND status = 'processing'`,
    ).bind(
      attempts,
      retryAt,
      (uncertain
        ? `${message}; provider acceptance was uncertain, so automatic retry is blocked.`
        : message).slice(0, 1_000),
      nowIso,
      job.id,
    ).run();
    return false;
  }
}

export async function processEmailJobs(
  env: Env,
  limit = 25,
  onlyId = "",
): Promise<number> {
  if (!transactionalEmailDeliveryEnabled(env)) return 0;
  const now = new Date().toISOString();
  // Recover a job if an isolate stopped after claiming it.
  const staleLock = new Date(Date.now() - 10 * 60 * 1_000).toISOString();
  await env.DB.prepare(
    `UPDATE email_jobs
     SET status = 'failed', attempts = 5, locked_at = NULL, available_at = ?,
         last_error = 'A stale provider attempt requires manual review and was not retried automatically.',
         updated_at = ?
     WHERE status = 'processing' AND locked_at <= ?`,
  ).bind(now, now, staleLock).run();
  const bounded = Math.max(1, Math.min(limit, 100));
  const query = onlyId
    ? `SELECT * FROM email_jobs WHERE id = ? AND status IN ('pending', 'failed') AND available_at <= ? AND attempts < 5 LIMIT 1`
    : `SELECT * FROM email_jobs WHERE status IN ('pending', 'failed') AND available_at <= ? AND attempts < 5 ORDER BY available_at, created_at LIMIT ?`;
  const rows = onlyId
    ? await env.DB.prepare(query).bind(onlyId, now).all<EmailJobRow>()
    : await env.DB.prepare(query).bind(now, bounded).all<EmailJobRow>();
  let processed = 0;
  for (const job of rows.results) {
    if (await processJob(env, job)) processed += 1;
  }
  return processed;
}

export async function memberMaintenance(env: Env, now = new Date()): Promise<number> {
  const nowIso = now.toISOString();
  const reminderCutoff = new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString();
  const reminders = await env.DB.prepare(
    `SELECT er.member_id, er.event_id, m.email, e.name, e.start_at, e.end_at,
            e.timezone, e.venue_name, e.location_display
     FROM event_rsvps er
     JOIN members m ON m.id = er.member_id AND m.reminder_emails_enabled = 1
     JOIN events e ON e.id = er.event_id AND e.is_active = 1
     WHERE er.status = 'going' AND er.reminder_sent_at IS NULL
       AND e.start_at > ? AND e.start_at <= ?
     ORDER BY e.start_at
     LIMIT 500`,
  ).bind(nowIso, reminderCutoff).all<Record<string, unknown>>();
  const statements: D1PreparedStatement[] = [];
  for (const reminder of reminders.results) {
    const memberId = String(reminder.member_id);
    const eventId = Number(reminder.event_id);
    statements.push(
      queueEmailStatement(env, {
        kind: "event_reminder",
        memberId,
        recipientEmail: String(reminder.email),
        subjectType: "event",
        subjectId: String(eventId),
        idempotencyKey: `event-reminder:${memberId}:${eventId}`,
        payload: reminder,
      }),
      env.DB.prepare(
        `UPDATE event_rsvps SET reminder_sent_at = ?, updated_at = ?
         WHERE member_id = ? AND event_id = ? AND status = 'going' AND reminder_sent_at IS NULL`,
      ).bind(nowIso, nowIso, memberId, eventId),
    );
  }
  const retentionDays = positiveInteger(env.EMAIL_METADATA_RETENTION_DAYS, 90, 365);
  const retentionCutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1_000).toISOString();
  statements.push(
    env.DB.prepare(
      `DELETE FROM email_jobs
       WHERE status IN ('sent', 'failed') AND updated_at <= ?`,
    ).bind(retentionCutoff),
  );
  if (!statements.length) return 0;
  const results = await env.DB.batch(statements);
  return results.reduce((sum, result) => sum + Number(result.meta.changes ?? 0), 0);
}

export async function developmentEmailInbox(request: Request, env: Env): Promise<Response> {
  if (env.ENVIRONMENT !== "local" && env.ENVIRONMENT !== "test") {
    throw new ApiError(404, "not_found", "Not found.");
  }
  requireTrustedRequest(request, env);
  const rows = await env.DB.prepare(
    `SELECT id, kind, recipient_email, payload_json, status, attempts,
            available_at, sent_at, last_error, created_at, updated_at
     FROM email_jobs ORDER BY created_at DESC LIMIT 100`,
  ).all<EmailJobRow & { sent_at: string | null; last_error: string }>();
  const emails = rows.results.map((row) => {
    const data = payload(row.payload_json);
    const rendered = renderEmail(env, row.kind, data);
    const fromEmail = row.kind === "magic_link"
      ? (env.EMAIL_FROM_SIGNIN || "signin@servethecays.com")
      : (env.EMAIL_FROM_NOTIFICATIONS || "notifications@servethecays.com");
    return {
      id: row.id,
      kind: row.kind,
      provider: "cloudflare_email_service",
      from_email: fromEmail,
      reply_to_email: env.EMAIL_REPLY_TO || "hello@servethecays.com",
      recipient_email: row.recipient_email,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      status: row.status,
      attempts: row.attempts,
      created_at: row.created_at,
      sent_at: row.sent_at,
      ...(rendered.previewUrl ? { development_sign_in_url: rendered.previewUrl } : {}),
      attachments: rendered.attachments?.map((attachment) => ({
        filename: attachment.filename,
        type: attachment.type,
      })) ?? [],
    };
  });
  return json({ emails });
}
