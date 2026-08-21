import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  fanoutNewsletterDigest,
  processNewsletterJobs,
} from "../src/newsletter";
import { sha256Hex } from "../src/security";
import type { Env } from "../src/types";

const baseEnv = env as unknown as Env;
const NOW = "2026-08-14T12:00:00.000Z";
const EVENT_START = "2099-08-20T18:00:00.000Z";

interface CapturedDelivery {
  mode: string;
  text: string;
  raw: string;
}

async function seedMemberSubscriber(
  memberId: string,
  email: string,
  personalizationEnabled = true,
): Promise<void> {
  await baseEnv.DB.prepare(
    `INSERT INTO members (id, email, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).bind(memberId, email, NOW, NOW).run();
  await baseEnv.DB.prepare(
    `INSERT INTO subscribers (
       id, email, status, consent_at, unsubscribe_token_hash, ip_hash,
       member_id, personalization_enabled, created_at, updated_at
     ) VALUES (?, ?, 'active', ?, ?, '', ?, ?, ?, ?)`,
  ).bind(
    `subscriber_${memberId}`,
    email,
    NOW,
    await sha256Hex(`unsubscribe:${email}`),
    memberId,
    personalizationEnabled ? 1 : 0,
    NOW,
    NOW,
  ).run();
}

async function seedEvent(
  key: string,
  locationId: string,
  categoryId: string | null,
): Promise<number> {
  const organizationId = `organization_${key}`;
  if (categoryId) {
    await baseEnv.DB.batch([
      baseEnv.DB.prepare(
        `INSERT INTO organizations (
           id, slug, name, description, is_active, published_at, updated_at
         ) VALUES (?, ?, ?, 'A trusted community organization.', 1, ?, ?)`,
      ).bind(organizationId, `organization-${key}`, `Organization ${key}`, NOW, NOW),
      baseEnv.DB.prepare(
        `INSERT INTO organization_categories (organization_id, category_id)
         VALUES (?, ?)`,
      ).bind(organizationId, categoryId),
    ]);
  }
  const event = await baseEnv.DB.prepare(
    `INSERT INTO events (
       slug, name, description, start_at, timezone, venue_name,
       location_id, location_display, is_active, published_at, updated_at
     ) VALUES (?, ?, 'A community event with useful local activities.', ?,
               'America/Nassau', 'Community Centre', ?, ?, 1, ?, ?)
     RETURNING id`,
  ).bind(
    `event-${key}`,
    `Event ${key}`,
    EVENT_START,
    locationId,
    locationId,
    NOW,
    NOW,
  ).first<{ id: number }>();
  if (!event) throw new Error("Test event was not created");
  if (categoryId) {
    await baseEnv.DB.prepare(
      `INSERT INTO event_organizations (
         event_id, organization_id, role, is_primary, created_at
       ) VALUES (?, ?, 'host', 1, ?)`,
    ).bind(event.id, organizationId, NOW).run();
  }
  return Number(event.id);
}

async function setPreferences(
  memberId: string,
  categoryIds: string[],
  locationIds: string[],
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (const categoryId of categoryIds) {
    statements.push(baseEnv.DB.prepare(
      `INSERT INTO member_notification_categories (member_id, category_id, created_at)
       VALUES (?, ?, ?)`,
    ).bind(memberId, categoryId, NOW));
  }
  for (const locationId of locationIds) {
    statements.push(baseEnv.DB.prepare(
      `INSERT INTO member_notification_locations (member_id, location_id, created_at)
       VALUES (?, ?, ?)`,
    ).bind(memberId, locationId, NOW));
  }
  if (statements.length) await baseEnv.DB.batch(statements);
}

async function queueDigest(digestId: string, eventIds: number[]): Promise<void> {
  await baseEnv.DB.prepare(
    `INSERT INTO newsletter_digests (
       id, window_start, window_end, event_ids_json, status,
       fanout_cursor, created_at, updated_at
     ) VALUES (?, '2026-08-03T00:00:00.000Z', '2026-08-10T00:00:00.000Z',
               ?, 'fanout', '', ?, ?)`,
  ).bind(digestId, JSON.stringify(eventIds), NOW, NOW).run();
  expect(await fanoutNewsletterDigest(baseEnv, digestId)).toBe(1);
}

async function capturedDelivery(digestId: string): Promise<CapturedDelivery> {
  const row = await baseEnv.DB.prepare(
    `SELECT mode, capture_json FROM newsletter_deliveries WHERE digest_id = ?`,
  ).bind(digestId).first<{ mode: string; capture_json: string }>();
  if (!row) throw new Error("Test newsletter was not captured");
  const capture = JSON.parse(row.capture_json) as { text: string; raw: string };
  return { mode: row.mode, text: capture.text, raw: capture.raw };
}

async function deliverDigest(digestId: string, eventIds: number[]): Promise<CapturedDelivery> {
  await queueDigest(digestId, eventIds);
  expect(await processNewsletterJobs(baseEnv)).toBe(1);
  return capturedDelivery(digestId);
}

describe("newsletter preference filters", () => {
  it("uses OR within each dimension and AND across selected dimensions", async () => {
    await seedMemberSubscriber("member_combined", "combined@example.org");
    await setPreferences(
      "member_combined",
      ["cat_youth", "cat_health"],
      ["loc_nassau", "loc_freeport"],
    );
    const youthNassau = await seedEvent("youth-nassau", "loc_nassau", "cat_youth");
    const healthFreeport = await seedEvent("health-freeport", "loc_freeport", "cat_health");
    const environmentNassau = await seedEvent("environment-nassau", "loc_nassau", "cat_environment");
    const youthExuma = await seedEvent("youth-exuma", "loc_george_town", "cat_youth");

    const capture = await deliverDigest("digest_combined", [
      youthNassau,
      healthFreeport,
      environmentNassau,
      youthExuma,
    ]);

    expect(capture.mode).toBe("personalized");
    expect(capture.text).toContain("Event youth-nassau");
    expect(capture.text).toContain("Event health-freeport");
    expect(capture.text).not.toContain("Event environment-nassau");
    expect(capture.text).not.toContain("Event youth-exuma");
    expect(capture.raw).not.toContain("member_combined");
    expect(capture.raw).not.toContain("cat_youth");
    expect(capture.raw).not.toContain("loc_nassau");
  });

  it("treats an empty category selection as unfiltered", async () => {
    await seedMemberSubscriber("member_location", "location@example.org");
    await setPreferences("member_location", [], ["loc_nassau"]);
    const unclassifiedNassau = await seedEvent("unclassified-nassau", "loc_nassau", null);
    const youthExuma = await seedEvent("location-youth-exuma", "loc_george_town", "cat_youth");

    const capture = await deliverDigest("digest_location", [unclassifiedNassau, youthExuma]);

    expect(capture.text).toContain("Event unclassified-nassau");
    expect(capture.text).not.toContain("Event location-youth-exuma");
  });

  it("treats an empty location selection as unfiltered", async () => {
    await seedMemberSubscriber("member_category", "category@example.org");
    await setPreferences("member_category", ["cat_youth", "cat_health"], []);
    const youthExuma = await seedEvent("category-youth-exuma", "loc_george_town", "cat_youth");
    const healthNassau = await seedEvent("category-health-nassau", "loc_nassau", "cat_health");
    const environmentFreeport = await seedEvent(
      "category-environment-freeport",
      "loc_freeport",
      "cat_environment",
    );

    const capture = await deliverDigest("digest_category", [
      youthExuma,
      healthNassau,
      environmentFreeport,
    ]);

    expect(capture.text).toContain("Event category-youth-exuma");
    expect(capture.text).toContain("Event category-health-nassau");
    expect(capture.text).not.toContain("Event category-environment-freeport");
  });

  it("ignores saved category and location choices after their taxonomy is deactivated", async () => {
    await seedMemberSubscriber("member_inactive", "inactive@example.org");
    await setPreferences("member_inactive", ["cat_arts"], ["loc_marsh_harbour"]);
    await baseEnv.DB.batch([
      baseEnv.DB.prepare(
        "UPDATE categories SET is_active = 0, updated_at = ? WHERE id = 'cat_arts'",
      ).bind(NOW),
      baseEnv.DB.prepare(
        "UPDATE locations SET is_active = 0, updated_at = ? WHERE id = 'loc_marsh_harbour'",
      ).bind(NOW),
    ]);

    try {
      const outsideInactiveChoices = await seedEvent(
        "outside-inactive-choices",
        "loc_freeport",
        "cat_environment",
      );
      const capture = await deliverDigest("digest_inactive", [outsideInactiveChoices]);

      expect(capture.mode).toBe("personalized");
      expect(capture.text).toContain("Event outside-inactive-choices");
    } finally {
      await baseEnv.DB.batch([
        baseEnv.DB.prepare(
          "UPDATE categories SET is_active = 1, updated_at = ? WHERE id = 'cat_arts'",
        ).bind(NOW),
        baseEnv.DB.prepare(
          "UPDATE locations SET is_active = 1, updated_at = ? WHERE id = 'loc_marsh_harbour'",
        ).bind(NOW),
      ]);
    }
  });

  it("stops applying member filters if personalized updates are disabled before delivery", async () => {
    await seedMemberSubscriber("member_general", "general@example.org");
    await setPreferences("member_general", ["cat_youth"], ["loc_nassau"]);
    const selected = await seedEvent("general-selected", "loc_nassau", "cat_youth");
    const outsidePreferences = await seedEvent(
      "general-outside-preferences",
      "loc_george_town",
      "cat_environment",
    );

    await queueDigest("digest_general", [selected, outsidePreferences]);
    expect((await baseEnv.DB.prepare(
      "SELECT mode FROM newsletter_deliveries WHERE digest_id = 'digest_general'",
    ).first<{ mode: string }>())?.mode).toBe("personalized");
    await baseEnv.DB.prepare(
      `UPDATE subscribers SET personalization_enabled = 0, updated_at = ?
       WHERE member_id = 'member_general'`,
    ).bind(NOW).run();
    expect(await processNewsletterJobs(baseEnv)).toBe(1);
    const capture = await capturedDelivery("digest_general");

    expect(capture.mode).toBe("general");
    expect(capture.text).toContain("Event general-selected");
    expect(capture.text).toContain("Event general-outside-preferences");
  });
});
