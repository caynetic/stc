import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import worker, { memberApplicationEnabled } from "../src/index";
import { queueEmail, transactionalEmailDeliveryEnabled } from "../src/email";
import type { Env } from "../src/types";

const APP_ORIGIN = "https://servethecays.test";
const TRANSACTIONAL_EMAIL_CRON = "*/15 * * * *";
const DAILY_MAINTENANCE_CRON = "17 6 * * *";
const SCHEDULED_EMAIL_BATCH_SIZE = 10;
const baseEnv = env as unknown as Env;

function scheduledController(cron: string): ScheduledController {
  return {
    cron,
    scheduledTime: Date.now(),
    noRetry() {},
  };
}

async function invokeScheduled(cron: string, targetEnv: Env = baseEnv): Promise<void> {
  const promises: Promise<unknown>[] = [];
  const context = {
    waitUntil(promise: Promise<unknown>) {
      promises.push(promise);
    },
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  await worker.scheduled(scheduledController(cron), targetEnv, context);
  await Promise.all(promises);
}

async function queueWelcome(index: number): Promise<void> {
  await queueEmail(baseEnv, {
    kind: "welcome",
    recipientEmail: `scheduled-${index}@example.org`,
    idempotencyKey: `scheduled-welcome-${index}`,
  });
}

describe("scheduled work isolation", () => {
  it("lets preview prove transactional delivery without unlocking member routes", () => {
    const previewEnv: Env = {
      ...baseEnv,
      ENVIRONMENT: "preview",
      MEMBER_APPLICATION_ENABLED: "false",
      MEMBER_SCHEMA_RELEASE_READY: "false",
      ADMIN_STEP_UP_VERIFIED: "false",
      TRANSACTIONAL_EMAIL_DELIVERY_ENABLED: "true",
      EMAIL_DELIVERY_RECONCILIATION_VERIFIED: "false",
    };

    expect(transactionalEmailDeliveryEnabled(previewEnv)).toBe(true);
    expect(memberApplicationEnabled(previewEnv)).toBe(false);
    expect(transactionalEmailDeliveryEnabled({
      ...previewEnv,
      TRANSACTIONAL_EMAIL_DELIVERY_ENABLED: "false",
    })).toBe(false);
  });

  it("does not drain pending email from a public fetch and bounds the email cron", async () => {
    for (let index = 0; index < SCHEDULED_EMAIL_BATCH_SIZE + 2; index += 1) {
      await queueWelcome(index);
    }

    const background: Promise<unknown>[] = [];
    const legacyContext = {
      waitUntil(promise: Promise<unknown>) {
        background.push(promise);
      },
    };
    await Reflect.apply(worker.fetch, worker, [
      new Request(`${APP_ORIGIN}/assets/app.js`),
      baseEnv,
      legacyContext,
    ]);
    await Promise.all(background);
    expect(await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS value FROM email_jobs WHERE status = 'pending'",
    ).first<{ value: number }>()).toEqual({ value: SCHEDULED_EMAIL_BATCH_SIZE + 2 });

    await invokeScheduled(TRANSACTIONAL_EMAIL_CRON);
    expect((await baseEnv.DB.prepare(
      "SELECT status, COUNT(*) AS value FROM email_jobs GROUP BY status ORDER BY status",
    ).all<{ status: string; value: number }>()).results).toEqual([
      { status: "pending", value: 2 },
      { status: "sent", value: SCHEDULED_EMAIL_BATCH_SIZE },
    ]);
  });

  it("keeps email processing separate from daily maintenance", async () => {
    await queueWelcome(100);
    await baseEnv.DB.prepare(
      `INSERT INTO rate_limits (key, window_started_at, count, updated_at)
       VALUES ('scheduled-stale', '2000-01-01T00:00:00.000Z', 1, '2000-01-01T00:00:00.000Z')`,
    ).run();

    await invokeScheduled(TRANSACTIONAL_EMAIL_CRON);
    expect(await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS value FROM rate_limits WHERE key = 'scheduled-stale'",
    ).first<{ value: number }>()).toEqual({ value: 1 });

    await invokeScheduled(DAILY_MAINTENANCE_CRON);
    expect(await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS value FROM rate_limits WHERE key = 'scheduled-stale'",
    ).first<{ value: number }>()).toEqual({ value: 0 });
  });

  it("continues independent daily tasks when one task fails", async () => {
    await baseEnv.DB.prepare(
      `INSERT INTO rate_limits (key, window_started_at, count, updated_at)
       VALUES ('scheduled-isolation', '2000-01-01T00:00:00.000Z', 1, '2000-01-01T00:00:00.000Z')`,
    ).run();
    const failingDb = new Proxy(baseEnv.DB, {
      get(target, property) {
        if (property === "prepare") {
          return (query: string) => {
            if (query.includes("SELECT * FROM media_assets")) throw new Error("simulated media cleanup failure");
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await invokeScheduled(DAILY_MAINTENANCE_CRON, { ...baseEnv, DB: failingDb });
    } finally {
      error.mockRestore();
    }

    expect(await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS value FROM rate_limits WHERE key = 'scheduled-isolation'",
    ).first<{ value: number }>()).toEqual({ value: 0 });
  });

  it("fails member-only event paths closed outside local/test while preserving public event discovery", async () => {
    const previewEnv: Env = {
      ...baseEnv,
      ENVIRONMENT: "preview",
      MEMBER_APPLICATION_ENABLED: "true",
      MEMBER_SCHEMA_RELEASE_READY: "true",
      ADMIN_STEP_UP_VERIFIED: "true",
      TRANSACTIONAL_EMAIL_DELIVERY_ENABLED: "false",
      EMAIL_DELIVERY_RECONCILIATION_VERIFIED: "true",
    };
    expect(memberApplicationEnabled(previewEnv)).toBe(false);
    expect(memberApplicationEnabled({
      ...previewEnv,
      TRANSACTIONAL_EMAIL_DELIVERY_ENABLED: "true",
      EMAIL_DELIVERY_RECONCILIATION_VERIFIED: "false",
    })).toBe(false);
    expect(memberApplicationEnabled({
      ...previewEnv,
      TRANSACTIONAL_EMAIL_DELIVERY_ENABLED: "true",
    })).toBe(true);
    expect((await worker.fetch(new Request(`${APP_ORIGIN}/api/member/session`), previewEnv)).status).toBe(404);
    expect((await worker.fetch(new Request(`${APP_ORIGIN}/suggest/organization`), previewEnv)).status).toBe(404);
    expect((await worker.fetch(new Request(`${APP_ORIGIN}/suggest/event`), previewEnv)).status).toBe(404);
    expect((await worker.fetch(new Request(`${APP_ORIGIN}/api/submissions/events`, {
      method: "POST",
      headers: { Origin: APP_ORIGIN, "Content-Type": "text/plain" },
      body: "the feature gate must run before request parsing",
    }), previewEnv)).status).toBe(404);

    const now = new Date();
    const start = new Date(now.getTime() + 48 * 60 * 60 * 1_000).toISOString();
    const end = new Date(now.getTime() + 50 * 60 * 60 * 1_000).toISOString();
    const timestamp = now.toISOString();
    await baseEnv.DB.prepare(
      `INSERT INTO events (
         id, slug, name, description, start_at, end_at, venue_name,
         location_display, is_active, published_at, updated_at
       ) VALUES (940001, 'public-event-gate-check', 'Public Event Gate Check',
         'A published event proving discovery stays available while member features are gated.',
         ?, ?, 'Community Hall', 'Nassau, New Providence', 1, ?, ?)`,
    ).bind(start, end, timestamp, timestamp).run();

    expect((await worker.fetch(new Request(`${APP_ORIGIN}/events`), previewEnv)).status).toBe(200);
    expect((await worker.fetch(new Request(`${APP_ORIGIN}/api/events`), previewEnv)).status).toBe(200);
    expect((await worker.fetch(new Request(`${APP_ORIGIN}/event/940001`), previewEnv)).status).toBe(200);
    expect((await worker.fetch(new Request(`${APP_ORIGIN}/api/events/940001`), previewEnv)).status).toBe(200);
  });

  it("allows a preview-only member UI review without enabling email delivery", async () => {
    const previewReviewEnv: Env = {
      ...baseEnv,
      ENVIRONMENT: "preview",
      MEMBER_APPLICATION_ENABLED: "true",
      PREVIEW_MEMBER_REVIEW_ENABLED: "true",
      MEMBER_SCHEMA_RELEASE_READY: "true",
      ADMIN_STEP_UP_VERIFIED: "true",
      TRANSACTIONAL_EMAIL_DELIVERY_ENABLED: "false",
      EMAIL_DELIVERY_RECONCILIATION_VERIFIED: "false",
    };

    expect(memberApplicationEnabled(previewReviewEnv)).toBe(true);
    expect(transactionalEmailDeliveryEnabled(previewReviewEnv)).toBe(false);
    expect((await worker.fetch(new Request(`${APP_ORIGIN}/signin`), previewReviewEnv)).status).toBe(200);
    const anonymousSession = await worker.fetch(
      new Request(`${APP_ORIGIN}/api/member/session`),
      previewReviewEnv,
    );
    expect(anonymousSession.status).toBe(200);
    await expect(anonymousSession.json()).resolves.toEqual({ authenticated: false });

    const beforeMagicLinks = await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS value FROM member_magic_links",
    ).first<{ value: number }>();
    const unavailableRequest = await worker.fetch(new Request(`${APP_ORIGIN}/api/member/auth/request`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: APP_ORIGIN,
      },
      body: JSON.stringify({ email: "preview-review@example.org" }),
    }), previewReviewEnv);
    expect(unavailableRequest.status).toBe(503);
    await expect(unavailableRequest.json()).resolves.toMatchObject({ code: "email_unavailable" });
    expect(await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS value FROM member_magic_links",
    ).first<{ value: number }>()).toEqual(beforeMagicLinks);

    expect(memberApplicationEnabled({
      ...previewReviewEnv,
      ENVIRONMENT: "production",
    })).toBe(false);
    expect(memberApplicationEnabled({
      ...previewReviewEnv,
      PREVIEW_MEMBER_REVIEW_ENABLED: "false",
    })).toBe(false);
  });
});
