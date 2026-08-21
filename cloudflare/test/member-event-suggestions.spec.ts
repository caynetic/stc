import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import worker from "../src/index";
import type { Env } from "../src/types";

const APP_ORIGIN = "https://servethecays.test";
const baseEnv = env as unknown as Env;

interface MemberAuth {
  cookie: string;
  csrf: string;
  memberId: string;
  email: string;
}

function call(request: Request, overrides: Partial<Env> = {}): Promise<Response> {
  return worker.fetch(request, { ...baseEnv, ...overrides });
}

async function signIn(email: string, ip: string): Promise<MemberAuth> {
  const requested = await call(new Request(`${APP_ORIGIN}/api/member/auth/request`, {
    method: "POST",
    headers: {
      Origin: APP_ORIGIN,
      "Content-Type": "application/json",
      "CF-Connecting-IP": ip,
    },
    body: JSON.stringify({ email, return_path: "/suggest/event" }),
  }));
  expect(requested.status).toBe(200);
  const requestPayload = await requested.json<{ development_sign_in_url: string }>();
  const token = new URL(requestPayload.development_sign_in_url).hash.replace(/^#token=/, "");
  const consumed = await call(new Request(`${APP_ORIGIN}/api/member/auth/consume`, {
    method: "POST",
    headers: {
      Origin: APP_ORIGIN,
      "Content-Type": "application/json",
      "CF-Connecting-IP": ip,
    },
    body: JSON.stringify({ token }),
  }));
  expect(consumed.status).toBe(200);
  const payload = await consumed.json<{ csrf_token: string; member: { id: string; email: string } }>();
  return {
    cookie: consumed.headers.get("Set-Cookie")!.split(";")[0],
    csrf: payload.csrf_token,
    memberId: payload.member.id,
    email: payload.member.email,
  };
}

function eventRequest(
  auth: MemberAuth,
  body: BodyInit,
  options: {
    csrf?: string | null;
    idempotencyKey?: string;
    ip?: string;
    contentType?: string;
  } = {},
): Request {
  const headers: Record<string, string> = {
    Origin: APP_ORIGIN,
    Cookie: auth.cookie,
    "CF-Connecting-IP": options.ip ?? "203.0.113.241",
  };
  const csrf = options.csrf === undefined ? auth.csrf : options.csrf;
  if (csrf !== null) headers["X-CSRF-Token"] = csrf;
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
  if (options.contentType) headers["Content-Type"] = options.contentType;
  return new Request(`${APP_ORIGIN}/api/submissions/events`, {
    method: "POST",
    headers,
    body,
  });
}

function jpegFile(): File {
  const bytes = new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    0x00, 0x01, 0x00, 0x01,
    0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    0x00,
    0xff, 0xd9,
  ]);
  return new File([bytes.buffer as ArrayBuffer], "community-event.jpg", { type: "image/jpeg" });
}

function eventForm(
  name: string,
  overrides: Record<string, string> = {},
  organizationIds: string[] = [],
  image?: File,
): FormData {
  const form = new FormData();
  const fields = {
    name,
    description: "A member-owned community event suggestion for backend security verification.",
    details: "Bring water and comfortable shoes for the volunteer activity.",
    start_at: "2026-12-05T14:00:00.000Z",
    end_at: "2026-12-05T18:00:00.000Z",
    venue_name: "Nassau Community Centre",
    location_id: "loc_nassau",
    website: "https://example.org/member-event",
    submitter_email: "attacker-controlled-not-an-email",
    submitter_phone: "+1 242 555 0140",
    public_email: "events@example.org",
    image_alt: image ? "Volunteers preparing supplies for a community event." : "",
    ...overrides,
  };
  for (const [field, value] of Object.entries(fields)) form.set(field, value);
  for (const organizationId of organizationIds) form.append("organization_ids", organizationId);
  if (image) form.set("image", image);
  return form;
}

async function seedOrganization(id: string, name: string): Promise<void> {
  const now = new Date().toISOString();
  await baseEnv.DB.prepare(
    `INSERT INTO organizations (
       id, slug, name, description, published_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    id,
    name,
    `${name} supports community service and volunteer opportunities in The Bahamas.`,
    now,
    now,
  ).run();
}

describe("member-only event suggestions", () => {
  it("rejects unauthenticated or CSRF-less requests before multipart and rate-limit work", async () => {
    const signedOut = await call(new Request(`${APP_ORIGIN}/api/submissions/events`, {
      method: "POST",
      headers: {
        Origin: APP_ORIGIN,
        "Content-Type": "text/plain",
        "CF-Connecting-IP": "203.0.113.242",
      },
      body: "this is deliberately not multipart",
    }));
    expect(signedOut.status).toBe(401);
    expect((await signedOut.json<{ code: string }>()).code).toBe("authentication_required");
    expect((await baseEnv.DB.prepare("SELECT COUNT(*) AS count FROM rate_limits")
      .first<{ count: number }>())?.count).toBe(0);

    const auth = await signIn("event-csrf@example.org", "203.0.113.243");
    await baseEnv.DB.prepare("DELETE FROM rate_limits").run();
    const noCsrf = await call(eventRequest(
      auth,
      "this is still deliberately not multipart",
      { csrf: null, contentType: "text/plain", ip: "203.0.113.244" },
    ));
    expect(noCsrf.status).toBe(403);
    expect((await noCsrf.json<{ code: string }>()).code).toBe("csrf_required");
    expect((await baseEnv.DB.prepare("SELECT COUNT(*) AS count FROM rate_limits")
      .first<{ count: number }>())?.count).toBe(0);
    expect((await baseEnv.DB.prepare("SELECT COUNT(*) AS count FROM event_submissions")
      .first<{ count: number }>())?.count).toBe(0);
    expect((await baseEnv.PRIVATE_UPLOADS.list()).objects).toHaveLength(0);
  });

  it("stores only the verified member identity while preserving links, limits, receipts, and quarantine", async () => {
    const auth = await signIn("Verified.Event.Member@Example.org", "203.0.113.245");
    await baseEnv.DB.prepare("DELETE FROM rate_limits").run();
    await Promise.all([
      seedOrganization("org_event_host", "Event Host"),
      seedOrganization("org_event_partner", "Event Partner"),
    ]);

    const response = await call(eventRequest(
      auth,
      eventForm(
        "Member-linked service day",
        {},
        ["org_event_host", "org_event_partner"],
        jpegFile(),
      ),
      { idempotencyKey: "member-event-contract", ip: "203.0.113.246" },
    ));
    expect(response.status).toBe(200);
    const body = await response.json<{ submission_id: string }>();

    const submission = await baseEnv.DB.prepare(
      `SELECT member_id, submitter_email, submitter_phone, image_asset_id
       FROM event_submissions WHERE id = ?`,
    ).bind(body.submission_id).first<{
      member_id: string;
      submitter_email: string;
      submitter_phone: string;
      image_asset_id: string;
    }>();
    expect(submission).toEqual({
      member_id: auth.memberId,
      submitter_email: "verified.event.member@example.org",
      submitter_phone: "+1 242 555 0140",
      image_asset_id: expect.any(String),
    });
    expect(await baseEnv.DB.prepare(
      `SELECT status, owner_type, owner_id FROM media_assets WHERE id = ?`,
    ).bind(submission!.image_asset_id).first()).toEqual({
      status: "quarantined",
      owner_type: "event_submission",
      owner_id: body.submission_id,
    });
    expect(await baseEnv.DB.prepare(
      `SELECT organization_id, role, is_primary
       FROM event_submission_organizations WHERE submission_id = ?
       ORDER BY is_primary DESC, organization_id`,
    ).bind(body.submission_id).all()).toMatchObject({
      results: [
        { organization_id: "org_event_host", role: "organizer", is_primary: 1 },
        { organization_id: "org_event_partner", role: "organizer", is_primary: 0 },
      ],
    });
    expect(await baseEnv.DB.prepare(
      `SELECT recipient_email FROM email_jobs
       WHERE kind = 'submission_receipt'
         AND json_extract(payload_json, '$.subject_id') = ?`,
    ).bind(body.submission_id).first()).toEqual({
      recipient_email: "verified.event.member@example.org",
    });
    expect(await baseEnv.DB.prepare(
      "SELECT count FROM rate_limits ORDER BY key",
    ).all()).toMatchObject({ results: [{ count: 1 }, { count: 1 }] });
    expect((await baseEnv.PRIVATE_UPLOADS.list()).objects).toHaveLength(1);
  });

  it("scopes caller idempotency keys per member and rejects changed payload replays", async () => {
    const first = await signIn("first-event-member@example.org", "203.0.113.247");
    const second = await signIn("second-event-member@example.org", "203.0.113.248");
    const key = "shared-member-event-key";

    const initial = await call(eventRequest(
      first,
      eventForm("First member keyed event"),
      { idempotencyKey: key, ip: "203.0.113.249" },
    ));
    expect(initial.status).toBe(200);
    const initialBody = await initial.json<{ submission_id: string }>();
    const replay = await call(eventRequest(
      first,
      eventForm("First member keyed event"),
      { idempotencyKey: key, ip: "203.0.113.249" },
    ));
    expect(replay.status).toBe(200);
    expect((await replay.json<{ submission_id: string }>()).submission_id).toBe(initialBody.submission_id);

    const conflict = await call(eventRequest(
      first,
      eventForm("Changed payload under the same key"),
      { idempotencyKey: key, ip: "203.0.113.249" },
    ));
    expect(conflict.status).toBe(409);
    expect((await conflict.json<{ code: string }>()).code).toBe("idempotency_conflict");

    const otherMember = await call(eventRequest(
      second,
      eventForm("First member keyed event"),
      { idempotencyKey: key, ip: "203.0.113.250" },
    ));
    expect(otherMember.status).toBe(200);
    const otherBody = await otherMember.json<{ submission_id: string }>();
    expect(otherBody.submission_id).not.toBe(initialBody.submission_id);

    const rows = await baseEnv.DB.prepare(
      `SELECT member_id, idempotency_key_hash FROM event_submissions
       ORDER BY member_id`,
    ).all<{ member_id: string; idempotency_key_hash: string }>();
    expect(rows.results).toHaveLength(2);
    expect(new Set(rows.results.map((row) => row.member_id))).toEqual(new Set([first.memberId, second.memberId]));
    expect(rows.results[0].idempotency_key_hash).not.toBe(rows.results[1].idempotency_key_hash);
  });

  it("charges both member and IP limits before honoring a honeypot response", async () => {
    const auth = await signIn("event-honeypot@example.org", "203.0.113.251");
    await baseEnv.DB.prepare("DELETE FROM rate_limits").run();
    const response = await call(eventRequest(
      auth,
      eventForm("Honeypot event", { hp: "automated visitor value" }),
      { ip: "203.0.113.252" },
    ));
    expect(response.status).toBe(200);
    expect((await baseEnv.DB.prepare("SELECT COUNT(*) AS count FROM event_submissions")
      .first<{ count: number }>())?.count).toBe(0);
    expect(await baseEnv.DB.prepare("SELECT count FROM rate_limits ORDER BY key").all())
      .toMatchObject({ results: [{ count: 1 }, { count: 1 }] });
  });

  it("enforces the member submission limit before attempting to parse another body", async () => {
    const auth = await signIn("event-limit@example.org", "203.0.113.253");
    await baseEnv.DB.prepare("DELETE FROM rate_limits").run();
    const overrides = { SUBMISSION_MEMBER_LIMIT: "1", SUBMISSION_IP_LIMIT: "100" };
    expect((await call(eventRequest(
      auth,
      eventForm("Allowed member event"),
      { ip: "203.0.113.254" },
    ), overrides)).status).toBe(200);

    const limited = await call(eventRequest(
      auth,
      "not multipart and must never be parsed",
      { ip: "203.0.113.255", contentType: "text/plain" },
    ), overrides);
    expect(limited.status).toBe(429);
    expect((await limited.json<{ code: string }>()).code).toBe("rate_limited");
    expect((await baseEnv.DB.prepare("SELECT COUNT(*) AS count FROM event_submissions")
      .first<{ count: number }>())?.count).toBe(1);
  });
});
