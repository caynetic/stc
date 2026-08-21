import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import worker from "../src/index";
import type { Env } from "../src/types";
import { seedAdmin, signInAdmin } from "./admin-auth";

const APP_ORIGIN = "https://servethecays.test";
const baseEnv = env as unknown as Env;

function call(request: Request): Promise<Response> {
  return worker.fetch(request, baseEnv);
}

async function memberSession(): Promise<{ cookie: string; csrf: string }> {
  const ip = "203.0.113.126";
  const requested = await call(new Request(`${APP_ORIGIN}/api/member/auth/request`, {
    method: "POST",
    headers: {
      Origin: APP_ORIGIN,
      "Content-Type": "application/json",
      "CF-Connecting-IP": ip,
    },
    body: JSON.stringify({
      email: "event-links-member@example.org",
      return_path: "/suggest/event",
    }),
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
  const payload = await consumed.json<{ csrf_token: string }>();
  return {
    cookie: consumed.headers.get("Set-Cookie")!.split(";")[0],
    csrf: payload.csrf_token,
  };
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
    `${name} supports volunteers and community programs across The Bahamas.`,
    now,
    now,
  ).run();
}

async function seedEvent(id: number, startAt: string, endAt: string | null = null): Promise<void> {
  const now = new Date().toISOString();
  await baseEnv.DB.prepare(
    `INSERT INTO events (
       id, slug, name, description, start_at, end_at, venue_name,
       location_display, published_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    `event-${id}`,
    `Community Event ${id}`,
    "A community event connecting volunteers with a local service project.",
    startAt,
    endAt,
    "Community Hall",
    "Nassau, New Providence",
    now,
    now,
  ).run();
}

async function ownerSession(): Promise<{ cookie: string; csrf: string }> {
  await seedAdmin("event_links_owner", "event-links-owner@example.org", "owner");
  const auth = await signInAdmin("event-links-owner@example.org", {}, "203.0.113.125");
  return { cookie: auth.adminCookie, csrf: auth.csrf };
}

function adminPut(
  path: string,
  session: { cookie: string; csrf: string },
  organizations: Array<Record<string, unknown>>,
): Request {
  return new Request(`${APP_ORIGIN}${path}`, {
    method: "PUT",
    headers: {
      Origin: APP_ORIGIN,
      Cookie: session.cookie,
      "X-CSRF-Token": session.csrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ organizations }),
  });
}

function eventForm(organizationIds: string[]): FormData {
  const form = new FormData();
  const fields = {
    name: "Linked Community Service Day",
    description: "A public service day bringing volunteers and community partners together.",
    details: "Bring water and comfortable shoes.",
    start_at: new Date(Date.now() + 48 * 60 * 60 * 1_000).toISOString(),
    end_at: new Date(Date.now() + 52 * 60 * 60 * 1_000).toISOString(),
    venue_name: "Nassau Community Centre",
    location_id: "loc_nassau",
  };
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  for (const id of organizationIds) form.append("organization_ids", id);
  return form;
}

describe("event organization relationships", () => {
  it("keeps standalone events valid and exposes linked organizations with only an aggregate RSVP count", async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
    await Promise.all([
      seedOrganization("org_host", "Primary Host"),
      seedOrganization("org_partner", "Community Partner"),
    ]);
    await seedEvent(920001, future);
    await baseEnv.DB.batch([
      baseEnv.DB.prepare(
        `INSERT INTO event_organizations (
           event_id, organization_id, role, is_primary, created_at
         ) VALUES (920001, 'org_host', 'host', 1, ?)`,
      ).bind(new Date().toISOString()),
      baseEnv.DB.prepare(
        `INSERT INTO event_organizations (
           event_id, organization_id, role, is_primary, created_at
         ) VALUES (920001, 'org_partner', 'partner', 0, ?)`,
      ).bind(new Date().toISOString()),
    ]);

    const linkedResponse = await call(new Request(`${APP_ORIGIN}/api/events/920001`));
    expect(linkedResponse.status).toBe(200);
    const linked = await linkedResponse.json<{ event: Record<string, any> }>();
    expect(linked.event.organizations).toEqual([
      { id: "org_host", slug: "org_host", name: "Primary Host", role: "host", is_primary: true },
      { id: "org_partner", slug: "org_partner", name: "Community Partner", role: "partner", is_primary: false },
    ]);
    expect(linked.event.rsvp_count).toBe(0);
    expect(JSON.stringify(linked)).not.toContain("member_id");

    await seedEvent(920002, future);
    const standalone = await (await call(new Request(`${APP_ORIGIN}/api/events/920002`)))
      .json<{ event: Record<string, any> }>();
    expect(standalone.event.organizations).toEqual([]);
  });

  it("keeps past details as ended archives while excluding them from listings and the sitemap", async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
    await seedEvent(920003, past);

    const detailResponse = await call(new Request(`${APP_ORIGIN}/api/events/920003`));
    expect(detailResponse.status).toBe(200);
    expect(detailResponse.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect((await detailResponse.json<{ event: { ended: boolean } }>()).event.ended).toBe(true);
    const listing = await (await call(new Request(`${APP_ORIGIN}/api/events`)))
      .json<{ events: Array<{ id: number }> }>();
    expect(listing.events.some((event) => event.id === 920003)).toBe(false);
    expect(await (await call(new Request(`${APP_ORIGIN}/sitemap.xml`))).text())
      .not.toContain("/event/920003");
  });

  it("preserves proposed links through moderation and supports reviewed link changes", async () => {
    await Promise.all([
      seedOrganization("org_alpha", "Alpha Organization"),
      seedOrganization("org_beta", "Beta Organization"),
    ]);
    const member = await memberSession();
    const submittedResponse = await call(new Request(`${APP_ORIGIN}/api/submissions/events`, {
      method: "POST",
      headers: {
        Origin: APP_ORIGIN,
        Cookie: member.cookie,
        "X-CSRF-Token": member.csrf,
        "CF-Connecting-IP": "203.0.113.127",
      },
      body: eventForm(["org_alpha", "org_beta"]),
    }));
    expect(submittedResponse.status).toBe(200);
    const submitted = await submittedResponse.json<{ submission_id: string }>();
    const session = await ownerSession();

    const revised = await call(adminPut(
      `/api/admin/submissions/event/${encodeURIComponent(submitted.submission_id)}/organizations`,
      session,
      [
        { organization_id: "org_beta", role: "beneficiary", is_primary: false },
        { organization_id: "org_alpha", role: "host", is_primary: true },
      ],
    ));
    expect(revised.status).toBe(200);

    const approved = await call(new Request(
      `${APP_ORIGIN}/api/admin/submissions/event/${encodeURIComponent(submitted.submission_id)}/approve`,
      {
        method: "POST",
        headers: {
          Origin: APP_ORIGIN,
          Cookie: session.cookie,
          "X-CSRF-Token": session.csrf,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    ));
    expect(approved.status).toBe(200);
    const publication = await approved.json<{ public_id: number }>();
    const publicEvent = await (await call(new Request(`${APP_ORIGIN}/api/events/${publication.public_id}`)))
      .json<{ event: { organizations: Array<Record<string, unknown>> } }>();
    expect(publicEvent.event.organizations).toEqual([
      { id: "org_alpha", slug: "org_alpha", name: "Alpha Organization", role: "host", is_primary: true },
      { id: "org_beta", slug: "org_beta", name: "Beta Organization", role: "beneficiary", is_primary: false },
    ]);

    const publishedUpdate = await call(adminPut(
      `/api/admin/events/${publication.public_id}/organizations`,
      session,
      [{ organization_id: "org_beta", role: "organizer", is_primary: true }],
    ));
    expect(publishedUpdate.status).toBe(200);
    const reviewDetail = await call(new Request(
      `${APP_ORIGIN}/api/admin/submissions/event/${encodeURIComponent(submitted.submission_id)}`,
      { headers: { Cookie: session.cookie, Origin: APP_ORIGIN } },
    ));
    expect(reviewDetail.status).toBe(200);
    const review = await reviewDetail.json<{ submission: Record<string, any> }>();
    expect(review.submission.organization_links_source).toBe("published");
    expect(review.submission.available_organizations.map((organization: { id: string }) => organization.id))
      .toEqual(["org_alpha", "org_beta"]);
    expect(review.submission.organizations).toEqual([
      {
        id: "org_beta",
        slug: "org_beta",
        name: "Beta Organization",
        role: "organizer",
        is_primary: true,
        is_active: true,
      },
    ]);

    const publishedList = await call(new Request(`${APP_ORIGIN}/api/admin/events`, {
      headers: { Cookie: session.cookie, Origin: APP_ORIGIN },
    }));
    expect(publishedList.status).toBe(200);
    const listed = await publishedList.json<{ events: Array<Record<string, any>> }>();
    expect(listed.events).toContainEqual(expect.objectContaining({
      id: publication.public_id,
      organization_count: 1,
    }));
    const directDetail = await call(new Request(
      `${APP_ORIGIN}/api/admin/events/${publication.public_id}/organizations`,
      { headers: { Cookie: session.cookie, Origin: APP_ORIGIN } },
    ));
    expect(directDetail.status).toBe(200);
    expect(await directDetail.json()).toMatchObject({
      event: {
        id: publication.public_id,
        organizations: [{ id: "org_beta", role: "organizer", is_primary: true }],
      },
    });
  });

  it("rejects duplicate organizations and more than one primary link", async () => {
    await seedOrganization("org_validation", "Validation Organization");
    await seedEvent(920004, new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString());
    const session = await ownerSession();
    const duplicate = await call(adminPut("/api/admin/events/920004/organizations", session, [
      { organization_id: "org_validation", role: "host", is_primary: true },
      { organization_id: "org_validation", role: "partner", is_primary: false },
    ]));
    expect(duplicate.status).toBe(400);

    await seedOrganization("org_validation_two", "Second Validation Organization");
    const multiplePrimary = await call(adminPut("/api/admin/events/920004/organizations", session, [
      { organization_id: "org_validation", role: "host", is_primary: true },
      { organization_id: "org_validation_two", role: "partner", is_primary: true },
    ]));
    expect(multiplePrimary.status).toBe(400);
  });
});
