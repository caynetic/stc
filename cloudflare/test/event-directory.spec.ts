import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import worker from "../src/index";
import type { Env } from "../src/types";

const APP_ORIGIN = "https://servethecays.test";
const baseEnv = env as unknown as Env;

function call(path: string): Promise<Response> {
  return worker.fetch(new Request(`${APP_ORIGIN}${path}`), baseEnv);
}

function eventInsert(
  id: number,
  name: string,
  description: string,
  startAt: string,
): D1PreparedStatement {
  const now = new Date().toISOString();
  return baseEnv.DB.prepare(
    `INSERT INTO events (
       id, slug, name, description, details, start_at, timezone,
       venue_name, location_display, is_active, published_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'America/Nassau', ?, ?, 1, ?, ?)`,
  ).bind(
    id,
    `event-${id}`,
    name,
    description,
    "Bring a friend and confirm attendance details with the organizer.",
    startAt,
    "Nassau Community Centre",
    "Nassau, New Providence",
    now,
    now,
  );
}

describe("public event discovery", () => {
  it("shows future events with contextual icons while retaining read-only expired archives", async () => {
    const pastAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const futureAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const chaplainAt = new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString();
    const fellowshipAt = new Date(Date.now() + 42 * 60 * 60 * 1000).toISOString();
    await baseEnv.DB.batch([
      eventInsert(
        910001,
        "Expired Community Gathering",
        "A community gathering whose scheduled start time has already passed.",
        pastAt,
      ),
      eventInsert(
        910002,
        "Future Community Food Drive",
        "An upcoming volunteer food drive helping families across Nassau.",
        futureAt,
      ),
      eventInsert(
        910004,
        "Eleuthera Community Chaplain Class",
        "A community chaplain training course that runs across three service-focused sessions.",
        chaplainAt,
      ),
      eventInsert(
        910005,
        "Rotary Fellowship Night",
        "An upcoming fellowship for service-minded neighbours and Rotary volunteers.",
        fellowshipAt,
      ),
    ]);

    const listing = await call("/events");
    const listingHtml = await listing.text();
    expect(listing.status).toBe(200);
    expect(listingHtml).toContain("Future Community Food Drive");
    expect(listingHtml).not.toContain("Expired Community Gathering");
    expect(listingHtml).toContain('class="event-icon-container"');
    expect(listingHtml).toContain("fa-utensils");
    expect(listingHtml).toContain("fa-graduation-cap");
    expect(listingHtml).toContain("fa-users");
    expect(listingHtml).not.toContain("event-logo-container");
    expect(listingHtml).toContain(`<time datetime="${futureAt}">`);

    const api = await call("/api/events");
    const apiBody = await api.json<{ events: Array<{ id: number }> }>();
    expect(apiBody.events.map((event) => event.id)).toEqual([910002, 910004, 910005]);

    const sitemap = await call("/sitemap.xml");
    const sitemapXml = await sitemap.text();
    expect(sitemapXml).toContain(`${APP_ORIGIN}/event/910002`);
    expect(sitemapXml).toContain(`${APP_ORIGIN}/event/910004`);
    expect(sitemapXml).toContain(`${APP_ORIGIN}/event/910005`);
    expect(sitemapXml).not.toContain(`${APP_ORIGIN}/event/910001`);
    expect(sitemapXml).not.toContain(`${APP_ORIGIN}/suggest/event`);
    expect(sitemapXml).not.toContain(`${APP_ORIGIN}/suggest/organization`);

    const archive = await call("/event/910001");
    const archiveHtml = await archive.text();
    expect(archive.status).toBe(200);
    expect(archiveHtml).toContain("Expired Community Gathering");
    expect(archiveHtml).toMatch(/ended/i);
    expect(archiveHtml).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(archiveHtml).not.toContain("data-event-rsvp");

    const archiveApi = await call("/api/events/910001");
    const archiveBody = await archiveApi.json<{ event: { id: number; ended: boolean } }>();
    expect(archiveApi.status).toBe(200);
    expect(archiveBody.event).toMatchObject({ id: 910001, ended: true });
  });

  it("renders focused event SEO metadata and valid Event JSON-LD on leaf pages", async () => {
    const futureAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    await baseEnv.DB.batch([
      eventInsert(
        910003,
        "Nassau Volunteer Mentorship Workshop",
        "An upcoming volunteer workshop connecting mentors with community leaders.",
        futureAt,
      ),
    ]);

    const listing = await call("/events");
    const listingHtml = await listing.text();
    expect(listingHtml).toContain("<title>Upcoming Volunteer Events in The Bahamas | Serve the Cays</title>");
    expect(listingHtml).toContain("Upcoming Volunteer &amp; Community Events in The Bahamas");
    expect((listingHtml.match(/rel="canonical"/g) ?? [])).toHaveLength(1);
    expect(listingHtml).toContain(`<link rel="canonical" href="${APP_ORIGIN}/events">`);

    const detail = await call("/event/910003");
    const detailHtml = await detail.text();
    expect(detail.status).toBe(200);
    expect(detailHtml).toContain(`<time datetime="${futureAt}">`);
    expect((detailHtml.match(/rel="canonical"/g) ?? [])).toHaveLength(1);
    expect(detailHtml).toContain(`<link rel="canonical" href="${APP_ORIGIN}/event/910003">`);

    expect(detailHtml).toContain('data-rsvp-event-id="910003"');
    expect(detailHtml).toContain("Sign in to say you&rsquo;re going");
    expect(detailHtml).not.toContain('data-favorite-type="event"');

    const jsonLdMatch = detailHtml.match(
      /<script type="application\/ld\+json">([^<]+)<\/script>/,
    );
    expect(jsonLdMatch).toBeTruthy();
    const structured = JSON.parse(jsonLdMatch![1]) as Record<string, any>;
    expect(structured).toMatchObject({
      "@context": "https://schema.org",
      "@type": "Event",
      name: "Nassau Volunteer Mentorship Workshop",
      startDate: futureAt,
      eventStatus: "https://schema.org/EventScheduled",
      eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
      url: `${APP_ORIGIN}/event/910003`,
      location: {
        "@type": "Place",
        name: "Nassau Community Centre",
        address: "Nassau, New Providence",
      },
    });
  });

  it("omits unsafe legacy website schemes from public API and HTML", async () => {
    const futureAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
    await baseEnv.DB.batch([
      eventInsert(
        910006,
        "Legacy Website Safety Check",
        "A fixture proving imported website values are revalidated at the public boundary.",
        futureAt,
      ),
      baseEnv.DB.prepare("UPDATE events SET website = ? WHERE id = ?")
        .bind("javascript:alert(document.domain)", 910006),
    ]);

    const api = await call("/api/events/910006");
    const payload = await api.json<{ event: { website: string } }>();
    expect(api.status).toBe(200);
    expect(payload.event.website).toBe("");

    const page = await call("/event/910006");
    const pageHtml = await page.text();
    expect(page.status).toBe(200);
    expect(pageHtml).not.toContain("javascript:");
  });
});
