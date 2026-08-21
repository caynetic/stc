import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import worker from "../src/index";
import type { Env } from "../src/types";

const APP_ORIGIN = "https://servethecays.test";
const baseEnv = env as unknown as Env;

function call(request: Request): Promise<Response> {
  return worker.fetch(request, baseEnv);
}

function jsonRequest(
  path: string,
  method: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${APP_ORIGIN}${path}`, {
    method,
    headers: {
      Origin: APP_ORIGIN,
      "Content-Type": "application/json",
      "CF-Connecting-IP": headers["CF-Connecting-IP"] ?? "203.0.113.220",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function tokenFromPreview(value: string): string {
  return new URL(value).hash.replace(/^#token=/, "");
}

async function requestLink(
  email: string,
  options: Record<string, unknown> = {},
  ip = "203.0.113.220",
): Promise<string> {
  const response = await call(jsonRequest("/api/member/auth/request", "POST", {
    email,
    return_path: "/me",
    ...options,
  }, { "CF-Connecting-IP": ip }));
  expect(response.status).toBe(200);
  const body = await response.json<{ development_sign_in_url?: string }>();
  const token = tokenFromPreview(String(body.development_sign_in_url ?? ""));
  expect(token).toMatch(/^[A-Za-z0-9_-]{40,100}$/);
  return token;
}

async function consumeLink(
  token: string,
  ip = "203.0.113.220",
): Promise<{ cookie: string; csrf: string; memberId: string }> {
  const response = await call(jsonRequest(
    "/api/member/auth/consume",
    "POST",
    { token },
    { "CF-Connecting-IP": ip },
  ));
  expect(response.status).toBe(200);
  const body = await response.json<Record<string, any>>();
  return {
    cookie: response.headers.get("Set-Cookie")!.split(";")[0],
    csrf: String(body.csrf_token),
    memberId: String(body.member.id),
  };
}

async function signIn(
  email: string,
): Promise<{ cookie: string; csrf: string; memberId: string }> {
  return consumeLink(await requestLink(email));
}

function memberRequest(
  path: string,
  method: string,
  auth: { cookie: string; csrf: string },
): Request {
  return new Request(`${APP_ORIGIN}${path}`, {
    method,
    headers: {
      Origin: APP_ORIGIN,
      Cookie: auth.cookie,
      "X-CSRF-Token": auth.csrf,
      "CF-Connecting-IP": "203.0.113.221",
    },
  });
}

async function seedEvent(id: number): Promise<Record<string, string | number | null>> {
  const now = new Date();
  const startAt = new Date(now.getTime() + 48 * 60 * 60 * 1_000).toISOString();
  const endAt = new Date(now.getTime() + 50 * 60 * 60 * 1_000).toISOString();
  const event = {
    event_id: id,
    name: `RSVP Email Event ${id}`,
    start_at: startAt,
    end_at: endAt,
    timezone: "America/Nassau",
    venue_name: "Community Hall",
    location_display: "Nassau, New Providence",
  };
  await baseEnv.DB.prepare(
    `INSERT INTO events (
       id, slug, name, description, details, start_at, end_at, timezone,
       venue_name, location_display, is_active, published_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).bind(
    id,
    `rsvp-email-event-${id}`,
    event.name,
    "A future event used to verify transactional RSVP email behavior.",
    "Bring water and review the event page before attending.",
    startAt,
    endAt,
    event.timezone,
    event.venue_name,
    event.location_display,
    now.toISOString(),
    now.toISOString(),
  ).run();
  return event;
}

async function rsvpJobs(): Promise<Array<{
  kind: string;
  idempotency_key: string;
  payload_json: string;
}>> {
  const result = await baseEnv.DB.prepare(
    `SELECT kind, idempotency_key, payload_json
     FROM email_jobs
     WHERE kind IN ('rsvp_confirmation', 'rsvp_cancellation')
     ORDER BY created_at, idempotency_key`,
  ).all<{
    kind: string;
    idempotency_key: string;
    payload_json: string;
  }>();
  return result.results;
}

describe("RSVP transactional email transitions", () => {
  it("queues one complete confirmation and cancellation for each real state transition", async () => {
    const event = await seedEvent(940001);
    const auth = await signIn("rsvp-transition@example.org");

    const going = await Promise.all([
      call(memberRequest("/api/member/events/940001/rsvp", "PUT", auth)),
      call(memberRequest("/api/member/events/940001/rsvp", "PUT", auth)),
      call(memberRequest("/api/member/events/940001/rsvp", "PUT", auth)),
    ]);
    expect(going.every((response) => response.status === 200)).toBe(true);

    let jobs = await rsvpJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      kind: "rsvp_confirmation",
      idempotency_key: `rsvp-confirmation:${auth.memberId}:940001:1`,
    });
    expect(JSON.parse(jobs[0].payload_json)).toMatchObject({
      ...event,
      subject_type: "event",
      subject_id: "940001",
    });

    const cancelled = await Promise.all([
      call(memberRequest("/api/member/events/940001/rsvp", "DELETE", auth)),
      call(memberRequest("/api/member/events/940001/rsvp", "DELETE", auth)),
      call(memberRequest("/api/member/events/940001/rsvp", "DELETE", auth)),
    ]);
    expect(cancelled.every((response) => response.status === 200)).toBe(true);

    jobs = await rsvpJobs();
    expect(jobs).toHaveLength(2);
    expect(jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "rsvp_confirmation",
        idempotency_key: `rsvp-confirmation:${auth.memberId}:940001:1`,
      }),
      expect.objectContaining({
        kind: "rsvp_cancellation",
        idempotency_key: `rsvp-cancellation:${auth.memberId}:940001:2`,
      }),
    ]));
    const cancellation = jobs.find((job) => job.kind === "rsvp_cancellation");
    expect(JSON.parse(cancellation!.payload_json)).toMatchObject({
      ...event,
      subject_type: "event",
      subject_id: "940001",
    });
    expect(await baseEnv.DB.prepare(
      "SELECT status, transition_count FROM event_rsvps WHERE member_id = ? AND event_id = 940001",
    ).bind(auth.memberId).first()).toMatchObject({
      status: "cancelled",
      transition_count: 2,
    });
  });

  it("queues the pending sign-in RSVP confirmation once and does not repeat it on later sign-in", async () => {
    const event = await seedEvent(940002);
    const email = "pending-rsvp@example.org";
    const firstToken = await requestLink(email, {
      return_path: "/event/940002",
      intent_type: "rsvp_event",
      target_id: "940002",
    }, "203.0.113.222");
    const first = await consumeLink(firstToken, "203.0.113.222");

    expect(await baseEnv.DB.prepare(
      "SELECT status, transition_count FROM event_rsvps WHERE member_id = ? AND event_id = 940002",
    ).bind(first.memberId).first()).toMatchObject({
      status: "going",
      transition_count: 1,
    });
    let jobs = await rsvpJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      kind: "rsvp_confirmation",
      idempotency_key: `rsvp-confirmation:${first.memberId}:940002:1`,
    });
    expect(JSON.parse(jobs[0].payload_json)).toMatchObject({
      ...event,
      subject_type: "event",
      subject_id: "940002",
    });

    const secondToken = await requestLink(email, {
      return_path: "/event/940002",
      intent_type: "rsvp_event",
      target_id: "940002",
    }, "203.0.113.223");
    const second = await consumeLink(secondToken, "203.0.113.223");
    expect(second.memberId).toBe(first.memberId);
    jobs = await rsvpJobs();
    expect(jobs).toHaveLength(1);
    expect(await baseEnv.DB.prepare(
      "SELECT status, transition_count FROM event_rsvps WHERE member_id = ? AND event_id = 940002",
    ).bind(first.memberId).first()).toMatchObject({
      status: "going",
      transition_count: 1,
    });
  });
});
