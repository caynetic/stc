import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import worker from "../src/index";
import type { Env } from "../src/types";
import { seedAdmin, signInAdmin, TEST_APP_ORIGIN } from "./admin-auth";

const baseEnv = env as unknown as Env;

function call(request: Request): Promise<Response> {
  return worker.fetch(request, baseEnv);
}

function adminRequest(
  path: string,
  auth: { adminCookie: string; csrf: string },
  method = "GET",
  body?: Record<string, unknown>,
): Request {
  return new Request(`${TEST_APP_ORIGIN}${path}`, {
    method,
    headers: {
      Origin: TEST_APP_ORIGIN,
      Cookie: auth.adminCookie,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json", "X-CSRF-Token": auth.csrf } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function ownerSession(): Promise<{ adminCookie: string; csrf: string }> {
  await seedAdmin("owner_content", "content-owner@example.org", "owner");
  const auth = await signInAdmin("content-owner@example.org");
  expect(auth.response.status).toBe(200);
  return { adminCookie: auth.adminCookie, csrf: auth.csrf };
}

describe("outreach ledger and public news", () => {
  it("keeps outreach private, requires sent-message evidence, and preserves append-only history", async () => {
    const auth = await ownerSession();
    const now = new Date().toISOString();
    await baseEnv.DB.prepare(
      `INSERT INTO organizations (
         id, slug, name, description, published_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      "org_outreach_test",
      "outreach-test-organization",
      "Outreach Test Organization",
      "A sufficiently detailed organization used to verify the outreach ledger.",
      now,
      now,
    ).run();

    const anonymous = await call(new Request(`${TEST_APP_ORIGIN}/api/admin/outreach`));
    expect(anonymous.status).toBe(401);

    const created = await call(adminRequest("/api/admin/outreach", auth, "POST", {
      organization_id: "org_outreach_test",
      organization_name: "Ignored snapshot",
      contact_name: "Community Coordinator",
      contact_email: "COORDINATOR@example.org",
      contact_phone: "",
      status: "not_contacted",
      next_follow_up_at: "",
      private_notes: "Private planning note",
    }));
    expect(created.status).toBe(201);
    const createdPayload = await created.json<{ id: string }>();

    const duplicate = await call(adminRequest("/api/admin/outreach", auth, "POST", {
      organization_id: "org_outreach_test",
      organization_name: "Ignored snapshot",
      contact_name: "Duplicate Coordinator",
      contact_email: "coordinator@example.org",
      contact_phone: "",
      status: "not_contacted",
      next_follow_up_at: "",
      private_notes: "",
    }));
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ code: "outreach_duplicate" });

    const missingEvidence = await call(adminRequest(
      `/api/admin/outreach/${createdPayload.id}/activities`,
      auth,
      "POST",
      {
        activity_type: "email_sent",
        occurred_at: now,
        subject: "Introduction",
        details: "Initial organization introduction.",
        evidence_reference: "",
      },
    ));
    expect(missingEvidence.status).toBe(400);
    expect(await missingEvidence.json()).toMatchObject({ code: "validation_error" });

    const activity = await call(adminRequest(
      `/api/admin/outreach/${createdPayload.id}/activities`,
      auth,
      "POST",
      {
        activity_type: "email_sent",
        occurred_at: now,
        subject: "Introduction",
        details: "Initial organization introduction.",
        evidence_reference: "provider-message-id-123",
      },
    ));
    expect(activity.status).toBe(201);
    const activityPayload = await activity.json<{ activity_id: string }>();

    const detail = await call(adminRequest(`/api/admin/outreach/${createdPayload.id}`, auth));
    expect(detail.status).toBe(200);
    const detailPayload = await detail.json<Record<string, any>>();
    expect(detailPayload.contact).toMatchObject({
      organization_name: "Outreach Test Organization",
      contact_email: "coordinator@example.org",
      status: "contacted",
      last_contacted_at: now,
    });
    expect(detailPayload.activities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: activityPayload.activity_id,
        activity_type: "email_sent",
        evidence_reference: "provider-message-id-123",
      }),
      expect.objectContaining({
        activity_type: "status_change",
        previous_status: "not_contacted",
        new_status: "contacted",
      }),
    ]));

    await expect(baseEnv.DB.prepare(
      "UPDATE outreach_activities SET details = 'rewritten' WHERE id = ?",
    ).bind(activityPayload.activity_id).run()).rejects.toThrow(/append-only/);
    const audit = await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE subject_type = 'outreach_contact' AND subject_id = ?",
    ).bind(createdPayload.id).first<{ count: number }>();
    expect(Number(audit?.count ?? 0)).toBe(2);
  });

  it("keeps drafts private and publishes safe news pages only after explicit approval", async () => {
    const auth = await ownerSession();
    const created = await call(adminRequest("/api/admin/news", auth, "POST", {
      title: "A New Community Update",
      summary: "A concise summary of a new community update across The Bahamas.",
      body_text: "First paragraph.\n\nSecond paragraph with <script>alert('no')</script> text.",
    }));
    expect(created.status).toBe(201);
    const post = await created.json<{ id: string; slug: string }>();

    const draftIndex = await call(new Request(`${TEST_APP_ORIGIN}/news`));
    expect(await draftIndex.text()).not.toContain("A New Community Update");
    const draftDetail = await call(new Request(`${TEST_APP_ORIGIN}/news/${post.slug}`));
    expect(draftDetail.status).toBe(404);

    const published = await call(adminRequest(`/api/admin/news/${post.id}/publish`, auth, "POST", {}));
    expect(published.status).toBe(200);
    expect(await published.json()).toMatchObject({ post_status: "published" });

    const publicIndex = await call(new Request(`${TEST_APP_ORIGIN}/news`));
    const publicIndexHtml = await publicIndex.text();
    expect(publicIndex.status).toBe(200);
    expect(publicIndexHtml).toContain("A New Community Update");

    const publicDetail = await call(new Request(`${TEST_APP_ORIGIN}/news/${post.slug}`));
    const publicDetailHtml = await publicDetail.text();
    expect(publicDetail.status).toBe(200);
    expect(publicDetailHtml).toContain("First paragraph.");
    expect(publicDetailHtml).toContain("&lt;script&gt;alert(&#39;no&#39;)&lt;/script&gt;");
    expect(publicDetailHtml).not.toContain("<script>alert('no')</script>");
    expect(publicDetailHtml).toContain('"@type":"NewsArticle"');

    const home = await call(new Request(`${TEST_APP_ORIGIN}/`));
    expect(await home.text()).toContain("Latest news");
    const sitemap = await call(new Request(`${TEST_APP_ORIGIN}/sitemap.xml`));
    expect(await sitemap.text()).toContain(`/news/${post.slug}`);

    const unpublished = await call(adminRequest(`/api/admin/news/${post.id}/unpublish`, auth, "POST", {}));
    expect(unpublished.status).toBe(200);
    const hiddenAgain = await call(new Request(`${TEST_APP_ORIGIN}/news/${post.slug}`));
    expect(hiddenAgain.status).toBe(404);
  });
});
