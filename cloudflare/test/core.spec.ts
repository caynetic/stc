import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import { parseBoolean, readJson, readMultipart } from "../src/http";
import { verifyTurnstile } from "../src/security";
import { seedAdmin, signInAdmin } from "./admin-auth";
import type { Env } from "../src/types";

const APP_ORIGIN = "https://servethecays.test";
const baseEnv = env as unknown as Env;

function call(request: Request, overrides: Partial<Env> = {}): Promise<Response> {
  return worker.fetch(request, { ...baseEnv, ...overrides });
}

describe("fail-closed configuration parsing", () => {
  it("uses the secure default for unrecognized boolean values", () => {
    expect(parseBoolean("tru", true)).toBe(true);
    expect(parseBoolean("false", true)).toBe(false);
    expect(parseBoolean("true", false)).toBe(true);
  });
});

type MemberAuth = { cookie: string; csrf: string; memberId: string; email: string };

function tokenFromPreview(value: string): string {
  return new URL(value).hash.replace(/^#token=/, "");
}

async function signInMember(email: string): Promise<MemberAuth> {
  const ip = "203.0.113.43";
  const requested = await call(new Request(`${APP_ORIGIN}/api/member/auth/request`, {
    method: "POST",
    headers: {
      Origin: APP_ORIGIN,
      "Content-Type": "application/json",
      "CF-Connecting-IP": ip,
    },
    body: JSON.stringify({ email, return_path: "/suggest/organization" }),
  }));
  expect(requested.status).toBe(200);
  const requestPayload = await responseJson(requested);
  const token = tokenFromPreview(String(requestPayload.development_sign_in_url || ""));
  expect(token).toMatch(/^[A-Za-z0-9_-]{40,100}$/);
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
  const payload = await responseJson(consumed);
  return {
    cookie: consumed.headers.get("Set-Cookie")!.split(";")[0],
    csrf: String(payload.csrf_token),
    memberId: String(payload.member.id),
    email,
  };
}

function memberOrganizationPost(form: FormData, auth: MemberAuth): Request {
  return new Request(`${APP_ORIGIN}/api/submissions/organizations`, {
    method: "POST",
    headers: {
      Origin: APP_ORIGIN,
      Cookie: auth.cookie,
      "X-CSRF-Token": auth.csrf,
      "CF-Connecting-IP": "203.0.113.42",
    },
    body: form,
  });
}

function memberEventPost(form: FormData, auth: MemberAuth): Request {
  return new Request(`${APP_ORIGIN}/api/submissions/events`, {
    method: "POST",
    headers: {
      Origin: APP_ORIGIN,
      Cookie: auth.cookie,
      "X-CSRF-Token": auth.csrf,
      "CF-Connecting-IP": "203.0.113.44",
    },
    body: form,
  });
}

function organizationForm(overrides: Record<string, string> = {}, image?: File): FormData {
  const form = new FormData();
  const fields = {
    name: "Community Builders Bahamas",
    description: "A volunteer organization helping neighbours through mentorship and service.",
    details: "Weekly programs and community service opportunities.",
    mission: "Make dependable community support easier to find across The Bahamas.",
    programs_services: "Youth mentoring, neighbourhood service days, and practical family support.",
    ways_to_help: "Volunteer at a service day, mentor a young person, or donate requested supplies.",
    eligibility: "Adults and supervised youth may participate; some roles require registration.",
    hours: "Weekdays from 9:00 a.m. to 5:00 p.m., with Saturday volunteer projects.",
    website: "https://example.org",
    submitter_email: "private@example.org",
    submitter_phone: "",
    public_email: "public@example.org",
    public_phone: "+1 242 555 0199",
    new_location: "",
    location_ids: "loc_nassau",
    category_ids: "cat_youth",
    image_alt: image ? "Volunteers gathering supplies for a community project." : "",
    ...overrides,
  };
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  if (image) form.set("image", image);
  return form;
}

function eventForm(overrides: Record<string, string> = {}, image?: File): FormData {
  const form = new FormData();
  const fields = {
    name: "Nassau Community Service Day",
    description: "A public service day bringing volunteers together across Nassau.",
    details: "Bring water and comfortable shoes.",
    start_at: "2026-12-05T14:00:00.000Z",
    end_at: "2026-12-05T18:00:00.000Z",
    venue_name: "Nassau Community Centre",
    location_id: "loc_nassau",
    new_location: "",
    website: "https://example.org/event",
    submitter_phone: "",
    public_email: "events@example.org",
    public_phone: "",
    image_alt: image ? "People working together outdoors." : "",
    ...overrides,
  };
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  if (image) form.set("image", image);
  return form;
}

function jpegBytes(width = 1, height = 1): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    0x00,
    0xff, 0xd9,
  ]);
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function jpegFile(name = "listing.jpg"): File {
  return new File([arrayBuffer(jpegBytes())], name, { type: "image/jpeg" });
}

function webpBytes(width = 1, height = 1): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  new DataView(bytes.buffer).setUint32(4, 22, true);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x58], 12);
  new DataView(bytes.buffer).setUint32(16, 10, true);
  const w = width - 1;
  const h = height - 1;
  bytes.set([w & 0xff, (w >>> 8) & 0xff, (w >>> 16) & 0xff], 24);
  bytes.set([h & 0xff, (h >>> 8) & 0xff, (h >>> 16) & 0xff], 27);
  return bytes;
}

function imagesBinding(): ImagesBinding {
  const output = webpBytes();
  const transformer = {
    transform() { return transformer; },
    draw() { return transformer; },
    async output() {
      return {
        response: () => new Response(arrayBuffer(output), { headers: { "Content-Type": "image/webp" } }),
        contentType: () => "image/webp",
        image: () => new Response(arrayBuffer(output)).body!,
      };
    },
  };
  return { input: () => transformer } as unknown as ImagesBinding;
}

async function responseJson(response: Response): Promise<Record<string, any>> {
  return response.json() as Promise<Record<string, any>>;
}

async function scalar(sql: string): Promise<number> {
  const row = await baseEnv.DB.prepare(sql).first<{ value: number }>();
  return Number(row?.value ?? 0);
}

async function seedOwner(): Promise<void> {
  await seedAdmin("user_owner", "owner@example.org", "owner");
}

async function login(): Promise<{ cookie: string; csrf: string }> {
  await seedOwner();
  const auth = await signInAdmin("owner@example.org", {}, "203.0.113.50");
  expect(auth.response.status).toBe(200);
  return { cookie: auth.adminCookie, csrf: auth.csrf };
}

function adminPost(path: string, auth: { cookie: string; csrf: string }, body: Record<string, unknown> = {}): Request {
  return new Request(`${APP_ORIGIN}${path}`, {
    method: "POST",
    headers: {
      Origin: APP_ORIGIN,
      Cookie: auth.cookie,
      "X-CSRF-Token": auth.csrf,
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.50",
    },
    body: JSON.stringify(body),
  });
}

describe("Serve the Cays Cloudflare backend", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("limits Turnstile test metadata bypass to the explicit preview test key", async () => {
    const request = new Request(`${APP_ORIGIN}/api/test`, {
      method: "POST",
      headers: { "CF-Connecting-IP": "203.0.113.90" },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({
      success: true,
      hostname: "example.com",
      action: null,
    })));
    await expect(verifyTurnstile(
      { turnstile_token: "preview-test-token" },
      request,
      {
        ...baseEnv,
        ENVIRONMENT: "preview",
        APP_ORIGIN,
        REQUIRE_TURNSTILE: "true",
        TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
      },
      "admin_login",
      "preview-test-secret",
    )).resolves.toBeUndefined();
    await expect(verifyTurnstile(
      { turnstile_token: "production-test-token" },
      request,
      {
        ...baseEnv,
        ENVIRONMENT: "production",
        APP_ORIGIN,
        REQUIRE_TURNSTILE: "true",
        TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
      },
      "admin_login",
      "production-secret",
    )).rejects.toMatchObject({ code: "turnstile_denied" });
  });

  it("rejects Turnstile responses for the wrong action or hostname", async () => {
    const request = new Request(`${APP_ORIGIN}/api/test`, {
      method: "POST",
      headers: { "CF-Connecting-IP": "203.0.113.91" },
    });
    const strictEnv = {
      ...baseEnv,
      ENVIRONMENT: "production",
      APP_ORIGIN,
      REQUIRE_TURNSTILE: "true",
      TURNSTILE_SITE_KEY: "0x4AAAAAA-real-site-key",
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      success: true,
      hostname: new URL(APP_ORIGIN).hostname,
      action: "newsletter_subscribe",
    })));
    await expect(verifyTurnstile(
      { turnstile_token: "wrong-action-token" }, request, strictEnv,
      "admin_login", "production-secret",
    )).rejects.toMatchObject({ code: "turnstile_denied" });
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      success: true,
      hostname: "evil.example",
      action: "admin_login",
    })));
    await expect(verifyTurnstile(
      { turnstile_token: "wrong-host-token" }, request, strictEnv,
      "admin_login", "production-secret",
    )).rejects.toMatchObject({ code: "turnstile_denied" });
  });

  it("renders the public shell while keeping an empty catalog usable", async () => {
    const home = await call(new Request(`${APP_ORIGIN}/`));
    const organizations = await call(new Request(`${APP_ORIGIN}/organizations`));
    const organizationSuggestion = await call(new Request(`${APP_ORIGIN}/suggest/organization`));
    const eventSuggestion = await call(new Request(`${APP_ORIGIN}/suggest/event`));
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("Welcome to Serve the Cays");
    expect(organizations.status).toBe(200);
    expect(await organizations.text()).not.toContain("Suggest an Organization");
    expect(organizationSuggestion.status).toBe(303);
    expect(organizationSuggestion.headers.get("Location")).toBe("/signin?return=%2Fsuggest%2Forganization");
    expect(organizationSuggestion.headers.get("Cache-Control")).toContain("no-store");
    expect(eventSuggestion.status).toBe(303);
    expect(eventSuggestion.headers.get("Location")).toBe("/signin?return=%2Fsuggest%2Fevent");
    expect(eventSuggestion.headers.get("Cache-Control")).toContain("no-store");
    expect(home.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(home.headers.get("Content-Security-Policy")).toContain(
      "img-src 'self' data: https://img.buymeacoffee.com",
    );
  });

  it("links organization categories and locations to matching directory filters", async () => {
    const now = new Date().toISOString();
    await baseEnv.DB.batch([
      baseEnv.DB.prepare(
        `INSERT INTO organizations (
           id, slug, name, description, details, published_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        "org_filter_links",
        "filter-link-organization",
        "Filter Link Organization",
        "A public organization used to verify linked category and location filters.",
        "This organization provides enough detail for its public directory profile.",
        now,
        now,
      ),
      baseEnv.DB.prepare(
        "INSERT INTO organization_locations (organization_id, location_id) VALUES (?, ?)",
      ).bind("org_filter_links", "loc_nassau"),
      baseEnv.DB.prepare(
        "INSERT INTO organization_categories (organization_id, category_id) VALUES (?, ?)",
      ).bind("org_filter_links", "cat_youth"),
    ]);

    const profile = await call(new Request(`${APP_ORIGIN}/organization/filter-link-organization`));
    const profileHtml = await profile.text();
    expect(profile.status).toBe(200);
    expect(profileHtml).not.toContain("Community organization");
    expect(profileHtml).toContain('href="/organizations?category=youth-mentorship"');
    expect(profileHtml).toContain('href="/organizations?city=Nassau"');

    const categoryListing = await call(new Request(`${APP_ORIGIN}/organizations?category=youth-mentorship`));
    expect(await categoryListing.text()).toContain("Filter Link Organization");
    const locationListing = await call(new Request(`${APP_ORIGIN}/organizations?city=Nassau`));
    expect(await locationListing.text()).toContain("Filter Link Organization");
  });

  it("stores organization suggestions privately and never exposes pending details", async () => {
    const auth = await signInMember("core-private-review@example.org");
    const response = await call(memberOrganizationPost(organizationForm(), auth));
    expect(response.status).toBe(200);
    const body = await responseJson(response);
    expect(body.message).toContain("private review");
    const stored = await baseEnv.DB.prepare("SELECT * FROM organization_submissions").first<Record<string, unknown>>();
    expect(stored).toMatchObject({
      status: "pending",
      submitter_email: auth.email,
      member_id: auth.memberId,
      public_email: "public@example.org",
    });
    expect(await scalar("SELECT COUNT(*) AS value FROM organization_submission_public_contacts")).toBe(2);
    expect(await scalar("SELECT COUNT(*) AS value FROM organization_submission_sections")).toBe(5);
    expect(await scalar("SELECT COUNT(*) AS value FROM organizations")).toBe(0);
    const listing = await call(new Request(`${APP_ORIGIN}/organizations`));
    expect(await listing.text()).not.toContain("Community Builders Bahamas");
  });

  it("requires an event ending time to be later than its starting time", async () => {
    const auth = await signInMember("core-event-time@example.org");
    const response = await call(memberEventPost(eventForm({
      end_at: "2026-12-05T14:00:00.000Z",
    }), auth));
    expect(response.status).toBe(400);
    expect((await responseJson(response)).errors?.end_at).toContain("The ending time must be after the starting time.");
  });

  it("accepts an untouched live-runtime image control but rejects text in its place", async () => {
    const auth = await signInMember("core-image-controls@example.org");
    const emptyImage = organizationForm();
    emptyImage.set("image", "");
    const accepted = await call(memberOrganizationPost(emptyImage, auth));
    expect(accepted.status).toBe(200);
    const textImage = organizationForm({ name: "Text Image Injection Test" });
    textImage.set("image", "not-a-file");
    const rejected = await call(memberOrganizationPost(textImage, auth));
    expect(rejected.status).toBe(400);
    expect((await responseJson(rejected)).code).toBe("unexpected_attachment");
  });

  it("accepts a validated image only into private R2 quarantine", async () => {
    const auth = await signInMember("core-private-image@example.org");
    const response = await call(memberOrganizationPost(organizationForm({}, jpegFile()), auth));
    expect(response.status).toBe(200);
    const asset = await baseEnv.DB.prepare("SELECT * FROM media_assets").first<Record<string, any>>();
    expect(asset).toBeTruthy();
    expect(asset).toMatchObject({ status: "quarantined", original_content_type: "image/jpeg" });
    expect(asset!.original_key).toMatch(/^quarantine\//);
    expect((await baseEnv.PRIVATE_UPLOADS.list()).objects).toHaveLength(1);
    expect((await baseEnv.PUBLISHED_MEDIA.list()).objects).toHaveLength(0);
    const publicAttempt = await call(new Request(`${APP_ORIGIN}/media/${asset!.id}`));
    expect(publicAttempt.status).toBe(404);
  });

  it("rejects unsafe and mismatched attachments before storage", async () => {
    const auth = await signInMember("core-unsafe-images@example.org");
    const svg = new File(["<svg/>"] , "listing.svg", { type: "image/svg+xml" });
    const mismatch = new File(["not a jpeg"], "listing.jpg", { type: "image/jpeg" });
    const svgResponse = await call(memberOrganizationPost(organizationForm({}, svg), auth));
    const mismatchResponse = await call(memberOrganizationPost(organizationForm({}, mismatch), auth));
    expect((await responseJson(svgResponse)).code).toBe("unsupported_image_type");
    expect((await responseJson(mismatchResponse)).code).toBe("image_signature_mismatch");
    expect(await scalar("SELECT COUNT(*) AS value FROM media_assets")).toBe(0);
    expect((await baseEnv.PRIVATE_UPLOADS.list()).objects).toHaveLength(0);
  });

  it("enforces actual JSON and form body limits when Content-Length is absent", async () => {
    const jsonRequest = new Request(`${APP_ORIGIN}/api/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(128) }),
    });
    const formRequest = new Request(`${APP_ORIGIN}/api/test`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ value: "x".repeat(128) }),
    });
    expect(jsonRequest.headers.get("Content-Length")).toBeNull();
    expect(formRequest.headers.get("Content-Length")).toBeNull();
    await expect(readJson(jsonRequest, 64)).rejects.toMatchObject({ code: "request_too_large" });
    await expect(readMultipart(formRequest, 64)).rejects.toMatchObject({ code: "request_too_large" });
  });

  it("requires valid owner credentials, an exact origin, and CSRF for moderation", async () => {
    const auth = await login();
    const session = await call(new Request(`${APP_ORIGIN}/api/admin/session`, {
      headers: { Cookie: auth.cookie, Origin: APP_ORIGIN },
    }));
    expect(session.status).toBe(200);
    const deniedOrigin = await call(new Request(`${APP_ORIGIN}/api/admin/logout`, {
      method: "POST",
      headers: { Cookie: auth.cookie, Origin: "https://evil.example", "X-CSRF-Token": auth.csrf },
    }));
    expect(deniedOrigin.status).toBe(403);
    const missingCsrf = await call(new Request(`${APP_ORIGIN}/api/admin/logout`, {
      method: "POST",
      headers: { Cookie: auth.cookie, Origin: APP_ORIGIN },
    }));
    expect(missingCsrf.status).toBe(403);
  });

  it("atomically approves an organization and publishes only its intended public fields", async () => {
    const member = await signInMember("core-approval@example.org");
    const form = organizationForm();
    form.append("contact_type", "email");
    form.append("contact_label", "Volunteer team");
    form.append("contact_value", "volunteer@example.org");
    form.append("contact_type", "phone");
    form.append("contact_label", "Programs");
    form.append("contact_value", "+1 242 555 0112");
    const submitted = await responseJson(await call(memberOrganizationPost(form, member)));
    const auth = await login();
    const review = await responseJson(await call(new Request(
      `${APP_ORIGIN}/api/admin/submissions/organization/${submitted.submission_id}`,
      { headers: { Cookie: auth.cookie, Origin: APP_ORIGIN } },
    )));
    expect(review.submission.public_contacts).toHaveLength(4);
    expect(review.submission.sections).toHaveLength(5);
    expect(review.submission.submitter_email).toBe(member.email);
    const approved = await call(adminPost(`/api/admin/submissions/organization/${submitted.submission_id}/approve`, auth));
    expect(approved.status).toBe(200);
    const publicRow = await baseEnv.DB.prepare("SELECT * FROM organizations").first<Record<string, any>>();
    expect(publicRow).toBeTruthy();
    expect(publicRow).toMatchObject({ public_email: "public@example.org", public_phone: "+1 242 555 0199" });
    expect(JSON.stringify(publicRow)).not.toContain(member.email);
    const contacts = await baseEnv.DB.prepare(
      "SELECT contact_type, label, value, is_primary FROM organization_public_contacts ORDER BY sort_order",
    ).all<Record<string, unknown>>();
    expect(contacts.results).toEqual([
      { contact_type: "email", label: "General inquiries", value: "public@example.org", is_primary: 1 },
      { contact_type: "phone", label: "General inquiries", value: "+1 242 555 0199", is_primary: 1 },
      { contact_type: "email", label: "Volunteer team", value: "volunteer@example.org", is_primary: 0 },
      { contact_type: "phone", label: "Programs", value: "+1 242 555 0112", is_primary: 0 },
    ]);
    expect(await scalar("SELECT COUNT(*) AS value FROM organization_sections")).toBe(5);
    expect(JSON.stringify(contacts.results)).not.toContain(member.email);
    const publicApi = await responseJson(await call(new Request(`${APP_ORIGIN}/api/organizations/${publicRow!.slug}`)));
    expect(publicApi.organization.public_contacts).toHaveLength(4);
    expect(publicApi.organization.sections.map((section: Record<string, unknown>) => section.kind)).toEqual([
      "mission", "programs_services", "ways_to_help", "eligibility", "hours",
    ]);
    const detail = await call(new Request(`${APP_ORIGIN}/organization/${publicRow!.slug}`));
    const html = await detail.text();
    expect(html).toContain("Community Builders Bahamas");
    expect(html).toContain("public@example.org");
    expect(html).toContain("volunteer@example.org");
    expect(html).toContain("Programs &amp; services");
    expect(html).toContain("Who can participate");
    expect(html).not.toContain(member.email);
  });

  it("rejects invalid or duplicate additional public organization contacts", async () => {
    const auth = await signInMember("core-contact-validation@example.org");
    const duplicate = organizationForm();
    duplicate.append("contact_type", "email");
    duplicate.append("contact_label", "Another inbox");
    duplicate.append("contact_value", "PUBLIC@example.org");
    const duplicateResponse = await call(memberOrganizationPost(duplicate, auth));
    expect(duplicateResponse.status).toBe(400);
    expect((await responseJson(duplicateResponse)).errors?.contact_value).toContain("Remove duplicate public contact details.");

    const invalid = organizationForm({ name: "Invalid Contact Organization" });
    invalid.append("contact_type", "phone");
    invalid.append("contact_label", "Volunteer team");
    invalid.append("contact_value", "call us soon");
    const invalidResponse = await call(memberOrganizationPost(invalid, auth));
    expect(invalidResponse.status).toBe(400);
    expect((await responseJson(invalidResponse)).errors?.contact_value).toContain("Enter a valid public phone number.");
  });

  it("prevents public rows and moderation history from bypassing submission state", async () => {
    const auth = await signInMember("core-state-guards@example.org");
    const submitted = await responseJson(await call(memberOrganizationPost(organizationForm(), auth)));
    const now = new Date().toISOString();
    await expect(baseEnv.DB.prepare(
      `INSERT INTO organizations (
         id, slug, name, description, details, website, public_email,
         public_phone, custom_location, image_asset_id, source_submission_id,
         is_active, published_at, updated_at
       ) VALUES ('org_guard_test', 'guard-test', 'Guard Test Organization',
         'This row must not bypass the pending review state.', '', '', '', '',
         '', NULL, ?, 1, ?, ?)`,
    ).bind(submitted.submission_id, now, now).run()).rejects.toBeTruthy();
    await expect(baseEnv.DB.prepare(
      `INSERT INTO moderation_events (
         id, submission_type, submission_id, action, created_at
       ) VALUES ('moderation_guard_test', 'organization', ?, 'approved', ?)`,
    ).bind(submitted.submission_id, now).run()).rejects.toBeTruthy();
    expect(await scalar("SELECT COUNT(*) AS value FROM organizations")).toBe(0);
    expect(await scalar("SELECT COUNT(*) AS value FROM moderation_events WHERE action = 'approved'")).toBe(0);
  });

  it("sanitizes an approved image into a separate public derivative", async () => {
    const member = await signInMember("core-image-approval@example.org");
    const submitted = await responseJson(await call(memberOrganizationPost(organizationForm({}, jpegFile()), member)));
    const auth = await login();
    const approved = await call(
      adminPost(`/api/admin/submissions/organization/${submitted.submission_id}/approve`, auth),
      { IMAGES: imagesBinding() },
    );
    expect(approved.status).toBe(200);
    const asset = await baseEnv.DB.prepare("SELECT * FROM media_assets").first<Record<string, any>>();
    expect(asset).toBeTruthy();
    expect(asset).toMatchObject({ status: "published", derivative_content_type: "image/webp" });
    expect(asset!.derivative_key).toMatch(/^published\//);
    expect((await baseEnv.PRIVATE_UPLOADS.list()).objects).toHaveLength(1);
    expect((await baseEnv.PUBLISHED_MEDIA.list()).objects).toHaveLength(1);
    const image = await call(new Request(`${APP_ORIGIN}/media/${asset!.id}`));
    expect(image.status).toBe(200);
    expect(image.headers.get("Content-Type")).toBe("image/webp");
    expect(image.headers.get("Cache-Control")).toContain("immutable");
  });

  it("denies and restores event submissions without publication", async () => {
    const member = await signInMember("core-event-moderation@example.org");
    const submitted = await responseJson(await call(memberEventPost(eventForm(), member)));
    const auth = await login();
    const denied = await call(adminPost(`/api/admin/submissions/event/${submitted.submission_id}/deny`, auth, {
      reason: "The organizer could not be verified.",
      private_notes: "Check again if they provide a current contact.",
    }));
    expect(denied.status).toBe(200);
    expect(await scalar("SELECT COUNT(*) AS value FROM events")).toBe(0);
    const restored = await call(adminPost(`/api/admin/submissions/event/${submitted.submission_id}/restore`, auth));
    expect(restored.status).toBe(200);
    const row = await baseEnv.DB.prepare("SELECT status FROM event_submissions").first<{ status: string }>();
    expect(row?.status).toBe("pending");
  });

  it("supports private newsletter subscription and explicit unsubscribe", async () => {
    const subscribe = await call(new Request(`${APP_ORIGIN}/api/newsletter/subscribe`, {
      method: "POST",
      headers: { Origin: APP_ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.61" },
      body: JSON.stringify({ email: "reader@example.org" }),
    }));
    expect(subscribe.status).toBe(202);
    expect(await scalar("SELECT COUNT(*) AS value FROM subscribers WHERE email = 'reader@example.org'")).toBe(0);
    await call(new Request(`${APP_ORIGIN}/api/dev/newsletters/process`, {
      method: "POST",
      headers: { Origin: APP_ORIGIN },
    }));
    const confirmation = await baseEnv.DB.prepare(
      "SELECT capture_json FROM newsletter_confirmation_requests WHERE email = 'reader@example.org'",
    ).first<{ capture_json: string }>();
    const token = (JSON.parse(confirmation!.capture_json) as { text: string }).text
      .match(/newsletter\/confirm#token=([A-Za-z0-9_-]+)/)?.[1];
    const confirmed = await call(new Request(`${APP_ORIGIN}/api/newsletter/confirm`, {
      method: "POST",
      headers: { Origin: APP_ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }));
    expect(confirmed.status).toBe(200);
    const row = await baseEnv.DB.prepare("SELECT status FROM subscribers WHERE email = 'reader@example.org'").first<{ status: string }>();
    expect(row?.status).toBe("active");
  });

  it("keeps sitemap and detail APIs approved-only", async () => {
    const auth = await signInMember("core-sitemap@example.org");
    await call(memberOrganizationPost(organizationForm(), auth));
    const sitemap = await call(new Request(`${APP_ORIGIN}/sitemap.xml`));
    const xml = await sitemap.text();
    expect(xml).not.toContain("Community Builders Bahamas");
    expect(xml).not.toContain("orgsub_");
    const missing = await call(new Request(`${APP_ORIGIN}/organization/not-approved`));
    expect(missing.status).toBe(404);
  });
});
