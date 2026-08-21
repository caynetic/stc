import { readSession, requireCsrf } from "./auth";
import { ApiError, json, readJson } from "./http";
import { randomId, requestIpHash, slugify } from "./security";
import type { Env, SessionContext } from "./types";

type OutreachStatus = "not_contacted" | "contacted" | "responded" | "follow_up" | "closed";
type OutreachActivityType = "email_sent" | "email_received" | "phone_call" | "meeting" | "note";
type NewsStatus = "draft" | "published" | "archived";

const OUTREACH_STATUSES = new Set<OutreachStatus>([
  "not_contacted",
  "contacted",
  "responded",
  "follow_up",
  "closed",
]);
const OUTREACH_ACTIVITY_TYPES = new Set<OutreachActivityType>([
  "email_sent",
  "email_received",
  "phone_call",
  "meeting",
  "note",
]);

function value(body: Record<string, unknown>, key: string, maximum: number): string {
  return typeof body[key] === "string" ? String(body[key]).trim().slice(0, maximum) : "";
}

function optionalDate(body: Record<string, unknown>, key: string): string | null {
  const raw = value(body, key, 40);
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new ApiError(400, "validation_error", "Review the date and time fields.", {
      [key]: ["Enter a valid date and time."],
    });
  }
  return date.toISOString();
}

function pagination(url: URL): { page: number; perPage: number; offset: number } {
  const requestedPage = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
  const requestedPerPage = Number.parseInt(url.searchParams.get("per_page") ?? "20", 10);
  const page = Number.isFinite(requestedPage) ? Math.max(1, requestedPage) : 1;
  const perPage = Number.isFinite(requestedPerPage) ? Math.max(10, Math.min(50, requestedPerPage)) : 20;
  return { page, perPage, offset: (page - 1) * perPage };
}

function paginationPayload(page: number, perPage: number, total: number): Record<string, number> {
  return { page, per_page: perPage, total, total_pages: Math.max(1, Math.ceil(total / perPage)) };
}

async function auditStatement(
  env: Env,
  request: Request,
  session: SessionContext,
  eventType: string,
  subjectType: string,
  subjectId: string,
  metadata: Record<string, unknown>,
  createdAt: string,
): Promise<D1PreparedStatement> {
  return env.DB.prepare(
    `INSERT INTO audit_events (
       id, actor_user_id, event_type, subject_type, subject_id,
       ip_hash, metadata_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    randomId("audit"),
    session.userId,
    eventType,
    subjectType,
    subjectId,
    await requestIpHash(env, request),
    JSON.stringify(metadata),
    createdAt,
  );
}

async function organizationSelection(
  env: Env,
  body: Record<string, unknown>,
): Promise<{ organizationId: string | null; organizationName: string }> {
  const organizationId = value(body, "organization_id", 100) || null;
  if (organizationId) {
    const organization = await env.DB.prepare(
      "SELECT id, name FROM organizations WHERE id = ? AND is_active = 1",
    ).bind(organizationId).first<{ id: string; name: string }>();
    if (!organization) {
      throw new ApiError(400, "validation_error", "Choose an active organization.", {
        organization_id: ["The selected organization is unavailable."],
      });
    }
    return { organizationId, organizationName: organization.name };
  }
  const organizationName = value(body, "organization_name", 200);
  if (!organizationName) {
    throw new ApiError(400, "validation_error", "Enter or select an organization.", {
      organization_name: ["Organization name is required."],
    });
  }
  return { organizationId: null, organizationName };
}

function outreachStatus(raw: string): OutreachStatus {
  if (!OUTREACH_STATUSES.has(raw as OutreachStatus)) {
    throw new ApiError(400, "validation_error", "Choose a valid outreach status.");
  }
  return raw as OutreachStatus;
}

function contactDetails(body: Record<string, unknown>): {
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  privateNotes: string;
} {
  const contactName = value(body, "contact_name", 200);
  const contactEmail = value(body, "contact_email", 254).toLowerCase();
  const contactPhone = value(body, "contact_phone", 100);
  const privateNotes = value(body, "private_notes", 5000);
  if (!contactEmail && !contactPhone) {
    throw new ApiError(400, "validation_error", "Add an email address or phone number.", {
      contact_email: ["At least one contact method is required."],
      contact_phone: ["At least one contact method is required."],
    });
  }
  if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
    throw new ApiError(400, "validation_error", "Enter a valid email address.", {
      contact_email: ["Enter a valid email address."],
    });
  }
  return { contactName, contactEmail, contactPhone, privateNotes };
}

async function requireUniqueOutreachContact(
  env: Env,
  organization: { organizationId: string | null; organizationName: string },
  contactEmail: string,
  excludeId = "",
): Promise<void> {
  if (!contactEmail) return;
  const duplicate = await env.DB.prepare(
    `SELECT id FROM outreach_contacts
     WHERE contact_email = ? AND id <> ?
       AND (
         (? IS NOT NULL AND organization_id = ?)
         OR (? IS NULL AND organization_id IS NULL AND organization_name = ? COLLATE NOCASE)
       )
     LIMIT 1`,
  ).bind(
    contactEmail,
    excludeId,
    organization.organizationId,
    organization.organizationId,
    organization.organizationId,
    organization.organizationName,
  ).first<{ id: string }>();
  if (duplicate) {
    throw new ApiError(409, "outreach_duplicate", "This organization and email address are already in the outreach ledger.");
  }
}

export async function listOutreach(request: Request, env: Env): Promise<Response> {
  await readSession(request, env);
  const url = new URL(request.url);
  const rawStatus = url.searchParams.get("status") ?? "all";
  if (rawStatus !== "all") outreachStatus(rawStatus);
  const search = (url.searchParams.get("search") ?? "").trim().slice(0, 200);
  const pattern = `%${search}%`;
  const { page, perPage, offset } = pagination(url);
  const where = `WHERE (? = 'all' OR oc.status = ?)
    AND (? = '' OR oc.organization_name LIKE ? OR oc.contact_name LIKE ? OR oc.contact_email LIKE ?)`;
  const bindings = [rawStatus, rawStatus, search, pattern, pattern, pattern];
  const [rows, count, organizations] = await Promise.all([
    env.DB.prepare(
      `SELECT oc.*, o.slug AS organization_slug,
              (SELECT COUNT(*) FROM outreach_activities oa WHERE oa.outreach_contact_id = oc.id) AS activity_count
       FROM outreach_contacts oc
       LEFT JOIN organizations o ON o.id = oc.organization_id
       ${where}
       ORDER BY CASE WHEN oc.next_follow_up_at IS NOT NULL AND oc.next_follow_up_at <= ? THEN 0 ELSE 1 END,
                oc.next_follow_up_at, oc.updated_at DESC, oc.id DESC
       LIMIT ? OFFSET ?`,
    ).bind(...bindings, new Date().toISOString(), perPage, offset).all<Record<string, unknown>>(),
    env.DB.prepare(`SELECT COUNT(*) AS total FROM outreach_contacts oc ${where}`)
      .bind(...bindings).first<{ total: number }>(),
    env.DB.prepare("SELECT id, name FROM organizations WHERE is_active = 1 ORDER BY name, id LIMIT 500")
      .all<{ id: string; name: string }>(),
  ]);
  const total = Number(count?.total ?? 0);
  return json({
    contacts: rows.results,
    organizations: organizations.results,
    pagination: paginationPayload(page, perPage, total),
  });
}

export async function outreachDetail(request: Request, env: Env, id: string): Promise<Response> {
  await readSession(request, env);
  const [contact, activities] = await Promise.all([
    env.DB.prepare(
      `SELECT oc.*, o.slug AS organization_slug
       FROM outreach_contacts oc LEFT JOIN organizations o ON o.id = oc.organization_id
       WHERE oc.id = ?`,
    ).bind(id).first<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT oa.*, u.display_name AS actor_name, u.email AS actor_email
       FROM outreach_activities oa
       LEFT JOIN users u ON u.id = oa.actor_user_id
       WHERE oa.outreach_contact_id = ?
       ORDER BY oa.occurred_at DESC, oa.created_at DESC, oa.id DESC`,
    ).bind(id).all<Record<string, unknown>>(),
  ]);
  if (!contact) throw new ApiError(404, "outreach_not_found", "Outreach contact not found.");
  return json({ contact, activities: activities.results });
}

export async function createOutreach(request: Request, env: Env): Promise<Response> {
  const session = await readSession(request, env);
  await requireCsrf(request, env, session);
  const body = await readJson(request, 32 * 1024);
  const organization = await organizationSelection(env, body);
  const contact = contactDetails(body);
  await requireUniqueOutreachContact(env, organization, contact.contactEmail);
  const status = outreachStatus(value(body, "status", 30) || "not_contacted");
  const nextFollowUpAt = optionalDate(body, "next_follow_up_at");
  const id = randomId("outreach");
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [env.DB.prepare(
    `INSERT INTO outreach_contacts (
       id, organization_id, organization_name, contact_name, contact_email, contact_phone,
       status, next_follow_up_at, private_notes, created_by_user_id, updated_by_user_id,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    organization.organizationId,
    organization.organizationName,
    contact.contactName,
    contact.contactEmail,
    contact.contactPhone,
    status,
    nextFollowUpAt,
    contact.privateNotes,
    session.userId,
    session.userId,
    now,
    now,
  )];
  if (status !== "not_contacted") {
    statements.push(env.DB.prepare(
      `INSERT INTO outreach_activities (
         id, outreach_contact_id, activity_type, occurred_at, subject, details,
         evidence_reference, previous_status, new_status, actor_user_id, created_at
       ) VALUES (?, ?, 'status_change', ?, '', 'Initial outreach status', '', 'not_contacted', ?, ?, ?)`,
    ).bind(randomId("outreach_activity"), id, now, status, session.userId, now));
  }
  statements.push(await auditStatement(
    env,
    request,
    session,
    "outreach.contact_created",
    "outreach_contact",
    id,
    { organization_id: organization.organizationId, status },
    now,
  ));
  await env.DB.batch(statements);
  return json({ status: "success", id }, 201);
}

export async function updateOutreach(request: Request, env: Env, id: string): Promise<Response> {
  const session = await readSession(request, env);
  await requireCsrf(request, env, session);
  const existing = await env.DB.prepare("SELECT status FROM outreach_contacts WHERE id = ?")
    .bind(id).first<{ status: OutreachStatus }>();
  if (!existing) throw new ApiError(404, "outreach_not_found", "Outreach contact not found.");
  const body = await readJson(request, 32 * 1024);
  const organization = await organizationSelection(env, body);
  const contact = contactDetails(body);
  await requireUniqueOutreachContact(env, organization, contact.contactEmail, id);
  const status = outreachStatus(value(body, "status", 30));
  const nextFollowUpAt = optionalDate(body, "next_follow_up_at");
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [env.DB.prepare(
    `UPDATE outreach_contacts
     SET organization_id = ?, organization_name = ?, contact_name = ?, contact_email = ?,
         contact_phone = ?, status = ?, next_follow_up_at = ?, private_notes = ?,
         updated_by_user_id = ?, updated_at = ?
     WHERE id = ?`,
  ).bind(
    organization.organizationId,
    organization.organizationName,
    contact.contactName,
    contact.contactEmail,
    contact.contactPhone,
    status,
    nextFollowUpAt,
    contact.privateNotes,
    session.userId,
    now,
    id,
  )];
  if (status !== existing.status) {
    statements.push(env.DB.prepare(
      `INSERT INTO outreach_activities (
         id, outreach_contact_id, activity_type, occurred_at, subject, details,
         evidence_reference, previous_status, new_status, actor_user_id, created_at
       ) VALUES (?, ?, 'status_change', ?, '', 'Outreach status updated', '', ?, ?, ?, ?)`,
    ).bind(randomId("outreach_activity"), id, now, existing.status, status, session.userId, now));
  }
  statements.push(await auditStatement(
    env,
    request,
    session,
    "outreach.contact_updated",
    "outreach_contact",
    id,
    { previous_status: existing.status, status },
    now,
  ));
  await env.DB.batch(statements);
  return json({ status: "success" });
}

function automaticStatus(type: OutreachActivityType, current: OutreachStatus): OutreachStatus {
  if (current === "closed") return current;
  if (type === "email_received") return "responded";
  if (type === "email_sent" || type === "phone_call" || type === "meeting") return "contacted";
  return current;
}

export async function addOutreachActivity(request: Request, env: Env, id: string): Promise<Response> {
  const session = await readSession(request, env);
  await requireCsrf(request, env, session);
  const contact = await env.DB.prepare("SELECT status FROM outreach_contacts WHERE id = ?")
    .bind(id).first<{ status: OutreachStatus }>();
  if (!contact) throw new ApiError(404, "outreach_not_found", "Outreach contact not found.");
  const body = await readJson(request, 32 * 1024);
  const rawType = value(body, "activity_type", 30) as OutreachActivityType;
  if (!OUTREACH_ACTIVITY_TYPES.has(rawType)) {
    throw new ApiError(400, "validation_error", "Choose a valid outreach activity.");
  }
  const occurredAt = optionalDate(body, "occurred_at") ?? new Date().toISOString();
  const subject = value(body, "subject", 500);
  const details = value(body, "details", 5000);
  const evidenceReference = value(body, "evidence_reference", 1000);
  if (rawType === "email_sent" && !evidenceReference) {
    throw new ApiError(400, "validation_error", "Add sent-message evidence before recording an email as sent.", {
      evidence_reference: ["Record a sent-mail link, message ID, or provider reference."],
    });
  }
  if (!subject && !details) {
    throw new ApiError(400, "validation_error", "Add a subject or activity details.");
  }
  const nextStatus = automaticStatus(rawType, contact.status);
  const now = new Date().toISOString();
  const activityId = randomId("outreach_activity");
  const statements: D1PreparedStatement[] = [env.DB.prepare(
    `INSERT INTO outreach_activities (
       id, outreach_contact_id, activity_type, occurred_at, subject, details,
       evidence_reference, actor_user_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(activityId, id, rawType, occurredAt, subject, details, evidenceReference, session.userId, now)];
  if (nextStatus !== contact.status) {
    statements.push(env.DB.prepare(
      `INSERT INTO outreach_activities (
         id, outreach_contact_id, activity_type, occurred_at, subject, details,
         evidence_reference, previous_status, new_status, actor_user_id, created_at
       ) VALUES (?, ?, 'status_change', ?, '', 'Status updated from recorded activity', '', ?, ?, ?, ?)`,
    ).bind(randomId("outreach_activity"), id, occurredAt, contact.status, nextStatus, session.userId, now));
  }
  const lastContactedAt = rawType === "note" ? null : occurredAt;
  statements.push(
    env.DB.prepare(
      `UPDATE outreach_contacts
       SET status = ?, last_contacted_at = COALESCE(?, last_contacted_at),
           updated_by_user_id = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(nextStatus, lastContactedAt, session.userId, now, id),
    await auditStatement(
      env,
      request,
      session,
      "outreach.activity_recorded",
      "outreach_contact",
      id,
      { activity_id: activityId, activity_type: rawType, evidence_recorded: Boolean(evidenceReference) },
      now,
    ),
  );
  await env.DB.batch(statements);
  return json({ status: "success", activity_id: activityId }, 201);
}

function newsFields(body: Record<string, unknown>): { title: string; summary: string; bodyText: string } {
  const title = value(body, "title", 200);
  const summary = value(body, "summary", 500);
  const bodyText = value(body, "body_text", 50000);
  const errors: Record<string, string[]> = {};
  if (!title) errors.title = ["Title is required."];
  if (!summary) errors.summary = ["Summary is required."];
  if (!bodyText) errors.body_text = ["Post content is required."];
  if (Object.keys(errors).length) throw new ApiError(400, "validation_error", "Complete the news post.", errors);
  return { title, summary, bodyText };
}

async function uniqueNewsSlug(env: Env, title: string, excludeId = ""): Promise<string> {
  const base = slugify(title, 120);
  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const suffixText = suffix ? `-${suffix + 1}` : "";
    const candidate = `${base.slice(0, 120 - suffixText.length)}${suffixText}`;
    const found = await env.DB.prepare("SELECT id FROM news_posts WHERE slug = ? AND id <> ?")
      .bind(candidate, excludeId).first<{ id: string }>();
    if (!found) return candidate;
  }
  throw new ApiError(503, "slug_unavailable", "A public news URL could not be allocated.");
}

export async function listNewsAdmin(request: Request, env: Env): Promise<Response> {
  await readSession(request, env);
  const url = new URL(request.url);
  const rawStatus = url.searchParams.get("status") ?? "all";
  if (!new Set(["all", "draft", "published", "archived"]).has(rawStatus)) {
    throw new ApiError(400, "invalid_filter", "Choose a valid news status.");
  }
  const { page, perPage, offset } = pagination(url);
  const [rows, count] = await Promise.all([
    env.DB.prepare(
      `SELECT id, slug, title, summary, status, published_at, created_at, updated_at
       FROM news_posts WHERE (? = 'all' OR status = ?)
       ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
    ).bind(rawStatus, rawStatus, perPage, offset).all<Record<string, unknown>>(),
    env.DB.prepare("SELECT COUNT(*) AS total FROM news_posts WHERE (? = 'all' OR status = ?)")
      .bind(rawStatus, rawStatus).first<{ total: number }>(),
  ]);
  const total = Number(count?.total ?? 0);
  return json({ posts: rows.results, pagination: paginationPayload(page, perPage, total) });
}

export async function newsAdminDetail(request: Request, env: Env, id: string): Promise<Response> {
  await readSession(request, env);
  const post = await env.DB.prepare("SELECT * FROM news_posts WHERE id = ?")
    .bind(id).first<Record<string, unknown>>();
  if (!post) throw new ApiError(404, "news_not_found", "News post not found.");
  return json({ post });
}

export async function createNews(request: Request, env: Env): Promise<Response> {
  const session = await readSession(request, env);
  await requireCsrf(request, env, session);
  const fields = newsFields(await readJson(request, 64 * 1024));
  const id = randomId("news");
  const slug = await uniqueNewsSlug(env, fields.title);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO news_posts (
         id, slug, title, summary, body_text, status,
         created_by_user_id, updated_by_user_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
    ).bind(id, slug, fields.title, fields.summary, fields.bodyText, session.userId, session.userId, now, now),
    await auditStatement(env, request, session, "news.created", "news_post", id, { slug }, now),
  ]);
  return json({ status: "success", id, slug }, 201);
}

export async function updateNews(request: Request, env: Env, id: string): Promise<Response> {
  const session = await readSession(request, env);
  await requireCsrf(request, env, session);
  const existing = await env.DB.prepare("SELECT id, slug, title, status FROM news_posts WHERE id = ?")
    .bind(id).first<{ id: string; slug: string; title: string; status: NewsStatus }>();
  if (!existing) throw new ApiError(404, "news_not_found", "News post not found.");
  const fields = newsFields(await readJson(request, 64 * 1024));
  const slug = existing.status === "published" || fields.title === existing.title
    ? existing.slug
    : await uniqueNewsSlug(env, fields.title, id);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE news_posts
       SET slug = ?, title = ?, summary = ?, body_text = ?, updated_by_user_id = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(slug, fields.title, fields.summary, fields.bodyText, session.userId, now, id),
    await auditStatement(
      env,
      request,
      session,
      "news.updated",
      "news_post",
      id,
      { previous_slug: existing.slug, slug, status: existing.status },
      now,
    ),
  ]);
  return json({ status: "success", slug });
}

export async function changeNewsStatus(
  request: Request,
  env: Env,
  id: string,
  action: "publish" | "unpublish" | "archive",
): Promise<Response> {
  const session = await readSession(request, env);
  await requireCsrf(request, env, session);
  const existing = await env.DB.prepare("SELECT status, published_at FROM news_posts WHERE id = ?")
    .bind(id).first<{ status: NewsStatus; published_at: string | null }>();
  if (!existing) throw new ApiError(404, "news_not_found", "News post not found.");
  const nextStatus: NewsStatus = action === "publish" ? "published" : action === "archive" ? "archived" : "draft";
  if (existing.status === nextStatus) return json({ status: "success", duplicate: true });
  const now = new Date().toISOString();
  const publishedAt = nextStatus === "published" ? (existing.published_at ?? now) : existing.published_at;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE news_posts
       SET status = ?, published_at = ?, updated_by_user_id = ?, updated_at = ?
       WHERE id = ? AND status = ?`,
    ).bind(nextStatus, publishedAt, session.userId, now, id, existing.status),
    await auditStatement(
      env,
      request,
      session,
      `news.${action}ed`,
      "news_post",
      id,
      { previous_status: existing.status, status: nextStatus },
      now,
    ),
  ]);
  return json({ status: "success", post_status: nextStatus, published_at: publishedAt });
}
