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
      "CF-Connecting-IP": "203.0.113.240",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function memberRequest(
  path: string,
  method: string,
  auth: { cookie: string; csrf: string },
  body?: Record<string, unknown>,
): Request {
  return new Request(`${APP_ORIGIN}${path}`, {
    method,
    headers: {
      Origin: APP_ORIGIN,
      Cookie: auth.cookie,
      "X-CSRF-Token": auth.csrf,
      "CF-Connecting-IP": "203.0.113.241",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function signIn(email: string): Promise<{
  cookie: string;
  csrf: string;
  memberId: string;
}> {
  const requested = await call(jsonRequest("/api/member/auth/request", "POST", {
    email,
    return_path: "/me",
  }));
  expect(requested.status).toBe(200);
  const requestBody = await requested.json<Record<string, unknown>>();
  const preview = new URL(String(requestBody.development_sign_in_url));
  const token = preview.hash.replace(/^#token=/, "");
  const consumed = await call(jsonRequest("/api/member/auth/consume", "POST", { token }));
  expect(consumed.status).toBe(200);
  const body = await consumed.json<Record<string, any>>();
  return {
    cookie: consumed.headers.get("Set-Cookie")!.split(";")[0],
    csrf: String(body.csrf_token),
    memberId: String(body.member.id),
  };
}

async function seedInactiveTaxonomy(suffix: string): Promise<{
  categoryId: string;
  locationId: string;
}> {
  const categoryId = `cat_notification_inactive_${suffix}`;
  const locationId = `loc_notification_inactive_${suffix}`;
  const now = new Date().toISOString();
  await baseEnv.DB.batch([
    baseEnv.DB.prepare(
      `INSERT INTO categories (id, slug, name, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?)
       ON CONFLICT(id) DO UPDATE SET is_active = 0, updated_at = excluded.updated_at`,
    ).bind(categoryId, categoryId, `Inactive notification category ${suffix}`, now, now),
    baseEnv.DB.prepare(
      `INSERT INTO locations (id, slug, city, island, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(id) DO UPDATE SET is_active = 0, updated_at = excluded.updated_at`,
    ).bind(locationId, locationId, `Inactive city ${suffix}`, "Test Island", now, now),
  ]);
  return { categoryId, locationId };
}

async function dashboard(auth: { cookie: string }): Promise<Record<string, any>> {
  const response = await call(new Request(`${APP_ORIGIN}/api/member/dashboard`, {
    headers: { Cookie: auth.cookie },
  }));
  expect(response.status).toBe(200);
  return response.json<Record<string, any>>();
}

describe("member event-notification preferences", () => {
  it("returns active taxonomy and atomically replaces ordered member selections", async () => {
    const inactive = await seedInactiveTaxonomy("dashboard");
    const auth = await signIn("notification-filters@example.org");

    const initial = await dashboard(auth);
    expect(initial.notification_settings).toMatchObject({
      personalized_updates_enabled: false,
      event_category_ids: [],
      event_location_ids: [],
    });
    const availableCategoryIds = initial.notification_taxonomy.categories
      .map((category: { id: string }) => category.id);
    const availableLocationIds = initial.notification_taxonomy.locations
      .map((location: { id: string }) => location.id);
    expect(availableCategoryIds).toContain("cat_arts");
    expect(availableLocationIds).toContain("loc_nassau");
    expect(availableCategoryIds).not.toContain(inactive.categoryId);
    expect(availableLocationIds).not.toContain(inactive.locationId);
    expect(availableCategoryIds.indexOf("cat_arts"))
      .toBeLessThan(availableCategoryIds.indexOf("cat_youth"));
    expect(availableLocationIds.indexOf("loc_marsh_harbour"))
      .toBeLessThan(availableLocationIds.indexOf("loc_nassau"));

    const updated = await call(memberRequest("/api/member/profile", "PATCH", auth, {
      display_name: "Island Volunteer",
      reminder_emails_enabled: false,
      personalized_updates_enabled: true,
      event_category_ids: ["cat_youth", "cat_arts"],
      event_location_ids: ["loc_nassau", "loc_marsh_harbour"],
    }));
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      member: {
        display_name: "Island Volunteer",
        reminder_emails_enabled: false,
      },
      notification_settings: {
        personalized_updates_enabled: false,
        event_category_ids: ["cat_arts", "cat_youth"],
        event_location_ids: ["loc_marsh_harbour", "loc_nassau"],
      },
    });
    expect((await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM subscribers WHERE member_id = ?",
    ).bind(auth.memberId).first<{ count: number }>())?.count).toBe(0);

    const secondMember = await signIn("notification-filters-second@example.org");
    expect((await dashboard(secondMember)).notification_settings).toMatchObject({
      event_category_ids: [],
      event_location_ids: [],
    });

    const clearedCategories = await call(memberRequest("/api/member/profile", "PATCH", auth, {
      event_category_ids: [],
    }));
    expect(clearedCategories.status).toBe(200);
    expect(await clearedCategories.json()).toMatchObject({
      member: { display_name: "Island Volunteer", reminder_emails_enabled: false },
      notification_settings: {
        event_category_ids: [],
        event_location_ids: ["loc_marsh_harbour", "loc_nassau"],
      },
    });
    const finalDashboard = await dashboard(auth);
    expect(finalDashboard.notification_settings).toMatchObject({
      event_category_ids: [],
      event_location_ids: ["loc_marsh_harbour", "loc_nassau"],
    });
  });

  it("rejects malformed, duplicate, excessive, unknown, and inactive selections without partial writes", async () => {
    const inactive = await seedInactiveTaxonomy("validation");
    const auth = await signIn("notification-validation@example.org");
    const initial = await call(memberRequest("/api/member/profile", "PATCH", auth, {
      display_name: "Original profile",
      event_category_ids: ["cat_arts"],
      event_location_ids: ["loc_nassau"],
    }));
    expect(initial.status).toBe(200);

    const invalidCases: Array<{
      body: Record<string, unknown>;
      field: "event_category_ids" | "event_location_ids";
    }> = [
      { body: { event_category_ids: "cat_arts" }, field: "event_category_ids" },
      { body: { event_category_ids: ["cat_arts", "cat_arts"] }, field: "event_category_ids" },
      {
        body: { event_category_ids: Array.from({ length: 21 }, (_, index) => `cat_${index}`) },
        field: "event_category_ids",
      },
      { body: { event_category_ids: ["cat_notification_unknown"] }, field: "event_category_ids" },
      { body: { event_category_ids: [inactive.categoryId] }, field: "event_category_ids" },
      { body: { event_location_ids: { id: "loc_nassau" } }, field: "event_location_ids" },
      { body: { event_location_ids: ["loc_nassau", "loc_nassau"] }, field: "event_location_ids" },
      {
        body: { event_location_ids: Array.from({ length: 21 }, (_, index) => `loc_${index}`) },
        field: "event_location_ids",
      },
      { body: { event_location_ids: ["loc_notification_unknown"] }, field: "event_location_ids" },
      {
        body: {
          display_name: "Must not be saved",
          event_category_ids: [],
          event_location_ids: [inactive.locationId],
        },
        field: "event_location_ids",
      },
    ];

    for (const testCase of invalidCases) {
      const response = await call(memberRequest("/api/member/profile", "PATCH", auth, testCase.body));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "validation_error",
        errors: { [testCase.field]: expect.any(Array) },
      });
    }

    expect(await baseEnv.DB.prepare(
      "SELECT display_name FROM members WHERE id = ?",
    ).bind(auth.memberId).first<{ display_name: string }>()).toEqual({
      display_name: "Original profile",
    });
    expect((await dashboard(auth)).notification_settings).toMatchObject({
      event_category_ids: ["cat_arts"],
      event_location_ids: ["loc_nassau"],
    });
  });

  it("guards inactive taxonomy at the database boundary and cascades preferences on member deletion", async () => {
    const inactive = await seedInactiveTaxonomy("database");
    const auth = await signIn("notification-cascade@example.org");
    const now = new Date().toISOString();

    await expect(baseEnv.DB.prepare(
      `INSERT INTO member_notification_categories (member_id, category_id, created_at)
       VALUES (?, ?, ?)`,
    ).bind(auth.memberId, inactive.categoryId, now).run())
      .rejects.toThrow(/notification category unavailable/);
    await expect(baseEnv.DB.prepare(
      `INSERT INTO member_notification_locations (member_id, location_id, created_at)
       VALUES (?, ?, ?)`,
    ).bind(auth.memberId, inactive.locationId, now).run())
      .rejects.toThrow(/notification location unavailable/);

    const saved = await call(memberRequest("/api/member/profile", "PATCH", auth, {
      event_category_ids: ["cat_environment"],
      event_location_ids: ["loc_freeport"],
    }));
    expect(saved.status).toBe(200);
    expect((await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM member_notification_categories WHERE member_id = ?",
    ).bind(auth.memberId).first<{ count: number }>())?.count).toBe(1);
    expect((await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM member_notification_locations WHERE member_id = ?",
    ).bind(auth.memberId).first<{ count: number }>())?.count).toBe(1);

    const deleted = await call(memberRequest("/api/member/account", "DELETE", auth));
    expect(deleted.status).toBe(200);
    expect((await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM member_notification_categories WHERE member_id = ?",
    ).bind(auth.memberId).first<{ count: number }>())?.count).toBe(0);
    expect((await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM member_notification_locations WHERE member_id = ?",
    ).bind(auth.memberId).first<{ count: number }>())?.count).toBe(0);
  });
});
