import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import worker from "../src/index";
import { newsletterUnsubscribeToken, processNewsletterConfirmationJobs } from "../src/newsletter";
import type { Env } from "../src/types";

const APP_ORIGIN = "https://servethecays.test";
const baseEnv = env as unknown as Env;

function call(request: Request): Promise<Response> {
  return worker.fetch(request, baseEnv);
}

async function subscribe(email: string): Promise<void> {
  const response = await call(new Request(`${APP_ORIGIN}/api/newsletter/subscribe`, {
    method: "POST",
    headers: {
      Origin: APP_ORIGIN,
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.245",
    },
    body: JSON.stringify({ email }),
  }));
  expect(response.status).toBe(202);
  await processNewsletterConfirmationJobs(baseEnv, 10);
  const inbox = await call(new Request(`${APP_ORIGIN}/api/dev/newsletters`));
  const payload = await inbox.json() as { emails: Array<{ message_type: string; text: string }> };
  const confirmation = payload.emails.find((message) => message.message_type === "newsletter_confirmation");
  const token = confirmation?.text.match(/newsletter\/confirm#token=([A-Za-z0-9_-]+)/)?.[1];
  expect(token).toBeTruthy();
  const confirmed = await call(new Request(`${APP_ORIGIN}/api/newsletter/confirm`, {
    method: "POST",
    headers: { Origin: APP_ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  }));
  expect(confirmed.status).toBe(200);
}

describe("newsletter application routes", () => {
  it("keeps unsubscribe GET read-only and accepts the standardized one-click POST", async () => {
    const email = "route-optout@example.org";
    await subscribe(email);
    const token = await newsletterUnsubscribeToken(baseEnv, email);

    const page = await call(new Request(`${APP_ORIGIN}/unsubscribe/${token}`));
    expect(page.status).toBe(200);
    expect((await baseEnv.DB.prepare(
      "SELECT status FROM subscribers WHERE email = ?",
    ).bind(email).first<{ status: string }>())?.status).toBe("active");

    const oneClick = await call(new Request(`${APP_ORIGIN}/unsubscribe/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    }));
    expect(oneClick.status).toBe(200);
    expect((await baseEnv.DB.prepare(
      "SELECT status FROM subscribers WHERE email = ?",
    ).bind(email).first<{ status: string }>())?.status).toBe("unsubscribed");
  });

  it("builds a local digest on demand and exposes the Forward Email preview", async () => {
    const email = "route-digest@example.org";
    await subscribe(email);
    const now = new Date();
    const windowEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    windowEnd.setUTCDate(windowEnd.getUTCDate() - ((windowEnd.getUTCDay() + 6) % 7));
    const publishedAt = new Date(windowEnd.getTime() - 3 * 24 * 60 * 60 * 1_000).toISOString();
    const startsAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000).toISOString();
    await baseEnv.DB.prepare(
      `INSERT INTO events (
         slug, name, description, start_at, timezone, venue_name,
         location_display, is_active, published_at, updated_at
       ) VALUES (
         'route-weekly-event', 'Route Weekly Event', 'A local digest route test.', ?,
         'America/Nassau', 'Community Centre', 'New Providence', 1, ?, ?
       )`,
    ).bind(startsAt, publishedAt, publishedAt).run();

    const processed = await call(new Request(`${APP_ORIGIN}/api/dev/newsletters/process`, {
      method: "POST",
      headers: { Origin: APP_ORIGIN },
    }));
    expect(processed.status).toBe(200);
    expect(await processed.json()).toMatchObject({ status: "success", queued: 1, processed: 1 });

    const inbox = await call(new Request(`${APP_ORIGIN}/api/dev/newsletters`));
    expect(inbox.status).toBe(200);
    const inboxPayload = await inbox.json() as { emails: Array<Record<string, unknown>> };
    const digestEmail = inboxPayload.emails.find((message) => message.message_type !== "newsletter_confirmation");
    expect(digestEmail).toMatchObject({
      recipient_email: email,
      provider: "forward_email",
      capture_state: "captured_local",
      from_email: "news@servethecays.com",
      reply_to_email: "hello@servethecays.com",
    });
  });
});
