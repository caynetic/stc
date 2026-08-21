import { readSession, requireCsrf } from "./auth";
import { ApiError, json, readJson, securityHeaders } from "./http";
import {
  cleanupDerivative,
  preparePublishedDerivative,
  privateImageResponse,
  publishDerivativeStatement,
  type PreparedDerivative,
} from "./images";
import { queueEmailStatement } from "./email";
import { randomId, requestIpHash, slugify } from "./security";
import type {
  CategoryRow,
  Env,
  EventSubmissionRow,
  LocationRow,
  OrganizationPublicContactRow,
  OrganizationSectionRow,
  OrganizationSubmissionRow,
  SessionContext,
} from "./types";

type SubmissionType = "organization" | "event";
type SubmissionStatus = "pending" | "approved" | "denied";
type EventOrganizationRole = "host" | "organizer" | "partner" | "beneficiary";

interface EventOrganizationInput {
  organizationId: string;
  role: EventOrganizationRole;
  isPrimary: boolean;
}

interface EventOrganizationRow extends Record<string, unknown> {
  id: string;
  slug: string;
  name: string;
  role: EventOrganizationRole;
  is_primary: number;
  is_active: number;
}

const EVENT_ORGANIZATION_ROLES = new Set<EventOrganizationRole>([
  "host",
  "organizer",
  "partner",
  "beneficiary",
]);

function submissionType(value: string): SubmissionType {
  if (value !== "organization" && value !== "event") {
    throw new ApiError(404, "submission_not_found", "Submission not found.");
  }
  return value;
}

function statusFilter(value: string | null): SubmissionStatus | "all" {
  if (!value || value === "all") return "all";
  if (value === "pending" || value === "approved" || value === "denied") return value;
  throw new ApiError(400, "invalid_filter", "Choose a valid review status.");
}

function paginationParameters(url: URL): { page: number; perPage: number; offset: number } {
  const requestedPage = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
  const requestedPerPage = Number.parseInt(url.searchParams.get("per_page") ?? "20", 10);
  const page = Number.isFinite(requestedPage) ? Math.max(1, requestedPage) : 1;
  const perPage = Number.isFinite(requestedPerPage) ? Math.max(10, Math.min(50, requestedPerPage)) : 20;
  return { page, perPage, offset: (page - 1) * perPage };
}

function paginationResult(page: number, perPage: number, total: number): Record<string, number> {
  return {
    page,
    per_page: perPage,
    total,
    total_pages: Math.max(1, Math.ceil(total / perPage)),
  };
}

function stringValue(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

async function uniqueSlug(env: Env, table: "organizations" | "events", name: string, maximum = 100): Promise<string> {
  const base = slugify(name, maximum);
  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const candidate = suffix ? `${base.slice(0, maximum - String(suffix + 1).length - 1)}-${suffix + 1}` : base;
    const found = await env.DB.prepare(`SELECT 1 AS found FROM ${table} WHERE slug = ?`).bind(candidate).first<{ found: number }>();
    if (!found) return candidate;
  }
  throw new ApiError(503, "slug_unavailable", "A public URL could not be allocated.");
}

async function uniqueEventId(env: Env): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const bytes = crypto.getRandomValues(new Uint32Array(1));
    const id = (bytes[0] & 0x7fffffff) || 1;
    const found = await env.DB.prepare("SELECT 1 AS found FROM events WHERE id = ?").bind(id).first();
    if (!found) return id;
  }
  throw new ApiError(503, "event_id_unavailable", "A public event URL could not be allocated.");
}

async function moderationBody(request: Request): Promise<{ reason: string; notes: string }> {
  const body = await readJson(request);
  return {
    reason: stringValue(body.reason, 500),
    notes: stringValue(body.private_notes, 2000),
  };
}

async function adminAuditStatement(
  env: Env,
  request: Request,
  eventType: string,
  actorUserId: string,
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
    actorUserId,
    eventType,
    subjectType,
    subjectId,
    await requestIpHash(env, request),
    JSON.stringify(metadata),
    createdAt,
  );
}

function eventOrganizationPayload(row: EventOrganizationRow): Record<string, unknown> {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    role: row.role,
    is_primary: Boolean(row.is_primary),
    is_active: Boolean(row.is_active),
  };
}

async function eventOrganizationBody(request: Request): Promise<EventOrganizationInput[]> {
  const body = await readJson(request, 32 * 1024);
  if (!Array.isArray(body.organizations)) {
    throw new ApiError(400, "validation_error", "Provide the related organizations.", {
      organizations: ["Organizations must be a list."],
    });
  }
  if (body.organizations.length > 20) {
    throw new ApiError(400, "validation_error", "Choose no more than 20 related organizations.", {
      organizations: ["Choose no more than 20 related organizations."],
    });
  }
  const result: EventOrganizationInput[] = [];
  const seen = new Set<string>();
  let primaryCount = 0;
  for (const raw of body.organizations) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ApiError(400, "validation_error", "Review the related organizations.", {
        organizations: ["Each organization link must include an organization, role, and primary setting."],
      });
    }
    const item = raw as Record<string, unknown>;
    const organizationId = stringValue(item.organization_id, 100);
    const role = stringValue(item.role, 20) as EventOrganizationRole;
    if (!organizationId || !EVENT_ORGANIZATION_ROLES.has(role) || typeof item.is_primary !== "boolean") {
      throw new ApiError(400, "validation_error", "Review the related organizations.", {
        organizations: ["Choose a valid organization and relationship role for every link."],
      });
    }
    if (seen.has(organizationId)) {
      throw new ApiError(400, "validation_error", "An organization can be linked only once.", {
        organizations: ["Remove duplicate organizations."],
      });
    }
    seen.add(organizationId);
    const isPrimary = item.is_primary;
    if (isPrimary) primaryCount += 1;
    result.push({ organizationId, role, isPrimary });
  }
  if (primaryCount > 1) {
    throw new ApiError(400, "validation_error", "Choose at most one primary organization.", {
      organizations: ["Only one organization may be primary."],
    });
  }
  return result;
}

async function requireActiveOrganizations(env: Env, links: EventOrganizationInput[]): Promise<void> {
  if (!links.length) return;
  const placeholders = links.map(() => "?").join(",");
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM organizations
     WHERE is_active = 1 AND id IN (${placeholders})`,
  ).bind(...links.map((link) => link.organizationId)).first<{ count: number }>();
  if (Number(row?.count ?? 0) !== links.length) {
    throw new ApiError(400, "validation_error", "Choose active organizations.", {
      organizations: ["One or more organizations are unavailable."],
    });
  }
}

async function submissionOrganizationRows(env: Env, id: string): Promise<EventOrganizationRow[]> {
  const rows = await env.DB.prepare(
    `SELECT o.id, o.slug, o.name, o.is_active, eso.role, eso.is_primary
     FROM event_submission_organizations eso
     JOIN organizations o ON o.id = eso.organization_id
     WHERE eso.submission_id = ?
     ORDER BY eso.is_primary DESC, o.name, o.id`,
  ).bind(id).all<EventOrganizationRow>();
  return rows.results;
}

async function publishedEventOrganizationRows(env: Env, eventId: number): Promise<EventOrganizationRow[]> {
  const rows = await env.DB.prepare(
    `SELECT o.id, o.slug, o.name, o.is_active, eo.role, eo.is_primary
     FROM event_organizations eo
     JOIN organizations o ON o.id = eo.organization_id
     WHERE eo.event_id = ?
     ORDER BY eo.is_primary DESC, o.name, o.id`,
  ).bind(eventId).all<EventOrganizationRow>();
  return rows.results;
}

export async function summary(request: Request, env: Env): Promise<Response> {
  await readSession(request, env);
  const rows = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM organization_submissions WHERE status = 'pending') AS pending_organizations,
       (SELECT COUNT(*) FROM event_submissions WHERE status = 'pending') AS pending_events,
       (SELECT COUNT(*) FROM organization_submissions WHERE status = 'approved') AS approved_organizations,
       (SELECT COUNT(*) FROM event_submissions WHERE status = 'approved') AS approved_events,
       (SELECT COUNT(*) FROM organization_submissions WHERE status = 'denied') AS denied_organizations,
       (SELECT COUNT(*) FROM event_submissions WHERE status = 'denied') AS denied_events,
       (SELECT COUNT(*) FROM subscribers WHERE status = 'active') AS active_subscribers,
       (SELECT COUNT(*) FROM outreach_contacts WHERE status = 'follow_up') AS outreach_follow_ups,
       (SELECT COUNT(*) FROM news_posts WHERE status = 'published') AS published_news_posts`,
  ).first<Record<string, number>>();
  return json(rows ?? {});
}

export async function listSubmissions(request: Request, env: Env): Promise<Response> {
  await readSession(request, env);
  const url = new URL(request.url);
  const status = statusFilter(url.searchParams.get("status"));
  const type = url.searchParams.get("type") ?? "all";
  const { page, perPage, offset } = paginationParameters(url);
  if (!['all', 'organization', 'event'].includes(type)) throw new ApiError(400, "invalid_filter", "Choose a valid submission type.");
  const source = `
    SELECT * FROM (
      SELECT 'organization' AS type, id, status, name, description,
             created_at, reviewed_at, image_asset_id,
             submitter_email, submitter_phone
      FROM organization_submissions
      UNION ALL
      SELECT 'event' AS type, id, status, name, description,
             created_at, reviewed_at, image_asset_id,
             submitter_email, submitter_phone
      FROM event_submissions
    ) submissions
    WHERE (? = 'all' OR status = ?)
      AND (? = 'all' OR type = ?)`;
  const [rows, count] = await Promise.all([
    env.DB.prepare(`${source} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .bind(status, status, type, type, perPage, offset).all(),
    env.DB.prepare(`SELECT COUNT(*) AS total FROM (${source}) filtered`)
      .bind(status, status, type, type).first<{ total: number }>(),
  ]);
  const total = Number(count?.total ?? 0);
  return json({ submissions: rows.results, pagination: paginationResult(page, perPage, total) });
}

export async function listPublishedEvents(request: Request, env: Env): Promise<Response> {
  await readSession(request, env);
  const url = new URL(request.url);
  const { page, perPage, offset } = paginationParameters(url);
  const [rows, count] = await Promise.all([env.DB.prepare(
    `SELECT e.id, e.slug, e.name, e.start_at, e.end_at, e.is_active,
            COUNT(eo.organization_id) AS organization_count
     FROM events e
     LEFT JOIN event_organizations eo ON eo.event_id = e.id
     WHERE e.is_active = 1
     GROUP BY e.id
     ORDER BY e.start_at DESC, e.id DESC
     LIMIT ? OFFSET ?`,
  ).bind(perPage, offset).all<Record<string, unknown>>(), env.DB.prepare(
    "SELECT COUNT(*) AS total FROM events WHERE is_active = 1",
  ).first<{ total: number }>()]);
  const total = Number(count?.total ?? 0);
  return json({ events: rows.results, pagination: paginationResult(page, perPage, total) });
}

export async function publishedEventOrganizationDetail(
  request: Request,
  env: Env,
  eventId: number,
): Promise<Response> {
  await readSession(request, env);
  const event = await env.DB.prepare(
    `SELECT id, slug, name, description, start_at, end_at, timezone,
            venue_name, location_display, is_active
     FROM events WHERE id = ? AND is_active = 1`,
  ).bind(eventId).first<Record<string, unknown>>();
  if (!event) throw new ApiError(404, "event_not_found", "Event not found.");
  const [organizations, availableOrganizations] = await Promise.all([
    publishedEventOrganizationRows(env, eventId),
    env.DB.prepare(
      `SELECT id, slug, name FROM organizations
       WHERE is_active = 1 ORDER BY name, id LIMIT 500`,
    ).all<{ id: string; slug: string; name: string }>(),
  ]);
  return json({
    event: {
      ...event,
      organizations: organizations.map(eventOrganizationPayload),
      available_organizations: availableOrganizations.results,
    },
  });
}

export async function submissionDetail(
  request: Request,
  env: Env,
  rawType: string,
  id: string,
): Promise<Response> {
  await readSession(request, env);
  const type = submissionType(rawType);
  if (type === "organization") {
    const row = await env.DB.prepare("SELECT * FROM organization_submissions WHERE id = ?")
      .bind(id)
      .first<OrganizationSubmissionRow>();
    if (!row) throw new ApiError(404, "submission_not_found", "Submission not found.");
    const [locations, categories, publicContacts, sections, history] = await Promise.all([
      env.DB.prepare(
        `SELECT l.id, l.slug, l.city, l.island
         FROM locations l JOIN organization_submission_locations sl ON sl.location_id = l.id
         WHERE sl.submission_id = ? ORDER BY l.island, l.city`,
      ).bind(id).all<LocationRow>(),
      env.DB.prepare(
        `SELECT c.id, c.slug, c.name
         FROM categories c JOIN organization_submission_categories sc ON sc.category_id = c.id
         WHERE sc.submission_id = ? ORDER BY c.name`,
      ).bind(id).all<CategoryRow>(),
      env.DB.prepare(
        `SELECT id, contact_type, label, value, normalized_value, sort_order, is_primary
         FROM organization_submission_public_contacts
         WHERE submission_id = ? ORDER BY sort_order, id`,
      ).bind(id).all<OrganizationPublicContactRow>(),
      env.DB.prepare(
        `SELECT id, section_kind, heading, body_text, sort_order
         FROM organization_submission_sections
         WHERE submission_id = ? ORDER BY sort_order, id`,
      ).bind(id).all<OrganizationSectionRow>(),
      env.DB.prepare(
        `SELECT m.action, m.reason, m.private_notes, m.created_at,
                u.display_name AS actor_name
         FROM moderation_events m LEFT JOIN users u ON u.id = m.actor_user_id
         WHERE m.submission_type = 'organization' AND m.submission_id = ?
         ORDER BY m.created_at DESC`,
      ).bind(id).all(),
    ]);
    return json({
      submission: {
        type,
        ...row,
        locations: locations.results,
        categories: categories.results,
        public_contacts: publicContacts.results,
        sections: sections.results,
      },
      history: history.results,
    });
  }
  const row = await env.DB.prepare(
    `SELECT e.*, l.city AS location_city, l.island AS location_island
     FROM event_submissions e LEFT JOIN locations l ON l.id = e.location_id
     WHERE e.id = ?`,
  )
    .bind(id)
    .first<EventSubmissionRow & { location_city: string | null; location_island: string | null }>();
  if (!row) throw new ApiError(404, "submission_not_found", "Submission not found.");
  const [history, organizations, availableOrganizations] = await Promise.all([
    env.DB.prepare(
      `SELECT m.action, m.reason, m.private_notes, m.created_at,
              u.display_name AS actor_name
       FROM moderation_events m LEFT JOIN users u ON u.id = m.actor_user_id
       WHERE m.submission_type = 'event' AND m.submission_id = ?
       ORDER BY m.created_at DESC`,
    ).bind(id).all(),
    row.status === "approved" && row.published_event_id
      ? publishedEventOrganizationRows(env, row.published_event_id)
      : submissionOrganizationRows(env, id),
    env.DB.prepare(
      `SELECT id, slug, name
       FROM organizations
       WHERE is_active = 1
       ORDER BY name, id
       LIMIT 500`,
    ).all<{ id: string; slug: string; name: string }>(),
  ]);
  return json({
    submission: {
      type,
      ...row,
      organizations: organizations.map(eventOrganizationPayload),
      organization_links_source: row.status === "approved" && row.published_event_id
        ? "published"
        : "submission",
      available_organizations: availableOrganizations.results,
    },
    history: history.results,
  });
}

export async function updateSubmissionOrganizations(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const current = await readSession(request, env);
  await requireCsrf(request, env, current);
  const links = await eventOrganizationBody(request);
  const submission = await env.DB.prepare(
    "SELECT status FROM event_submissions WHERE id = ?",
  ).bind(id).first<{ status: SubmissionStatus }>();
  if (!submission) throw new ApiError(404, "submission_not_found", "Submission not found.");
  if (submission.status === "approved") {
    throw new ApiError(409, "submission_state_conflict", "Update the published event instead.");
  }
  await requireActiveOrganizations(env, links);
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM event_submission_organizations WHERE submission_id = ?").bind(id),
  ];
  for (const link of links) {
    statements.push(env.DB.prepare(
      `INSERT INTO event_submission_organizations (
         submission_id, organization_id, role, is_primary, created_at
       ) VALUES (?, ?, ?, ?, ?)`,
    ).bind(id, link.organizationId, link.role, link.isPrimary ? 1 : 0, now));
  }
  statements.push(
    env.DB.prepare("UPDATE event_submissions SET updated_at = ? WHERE id = ?").bind(now, id),
    env.DB.prepare("UPDATE revision_state SET revision = revision + 1, updated_at = ? WHERE id = 1").bind(now),
    await adminAuditStatement(
      env,
      request,
      "moderation.event_links_updated",
      current.userId,
      "event_submission",
      id,
      { organization_count: links.length },
      now,
    ),
  );
  await env.DB.batch(statements);
  return json({
    status: "success",
    organizations: (await submissionOrganizationRows(env, id)).map(eventOrganizationPayload),
  });
}

export async function updatePublishedEventOrganizations(
  request: Request,
  env: Env,
  eventId: number,
): Promise<Response> {
  const current = await readSession(request, env);
  await requireCsrf(request, env, current);
  const links = await eventOrganizationBody(request);
  const event = await env.DB.prepare("SELECT id FROM events WHERE id = ?")
    .bind(eventId)
    .first<{ id: number }>();
  if (!event) throw new ApiError(404, "event_not_found", "Event not found.");
  await requireActiveOrganizations(env, links);
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM event_organizations WHERE event_id = ?").bind(eventId),
  ];
  for (const link of links) {
    statements.push(env.DB.prepare(
      `INSERT INTO event_organizations (
         event_id, organization_id, role, is_primary, created_at
       ) VALUES (?, ?, ?, ?, ?)`,
    ).bind(eventId, link.organizationId, link.role, link.isPrimary ? 1 : 0, now));
  }
  statements.push(
    env.DB.prepare("UPDATE events SET updated_at = ? WHERE id = ?").bind(now, eventId),
    env.DB.prepare("UPDATE revision_state SET revision = revision + 1, updated_at = ? WHERE id = 1").bind(now),
    await adminAuditStatement(
      env,
      request,
      "event.links_updated",
      current.userId,
      "event",
      String(eventId),
      { organization_count: links.length },
      now,
    ),
  );
  await env.DB.batch(statements);
  return json({
    status: "success",
    organizations: (await publishedEventOrganizationRows(env, eventId)).map(eventOrganizationPayload),
  });
}

export async function submissionImage(
  request: Request,
  env: Env,
  rawType: string,
  id: string,
): Promise<Response> {
  await readSession(request, env);
  const type = submissionType(rawType);
  const table = type === "organization" ? "organization_submissions" : "event_submissions";
  const row = await env.DB.prepare(`SELECT image_asset_id FROM ${table} WHERE id = ?`)
    .bind(id)
    .first<{ image_asset_id: string | null }>();
  if (!row?.image_asset_id) throw new ApiError(404, "image_not_found", "This submission has no image.");
  return privateImageResponse(env, row.image_asset_id);
}

async function approveOrganization(
  request: Request,
  env: Env,
  current: SessionContext,
  id: string,
  reason: string,
  notes: string,
): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT submission.*, member.email AS member_email
     FROM organization_submissions submission
     LEFT JOIN members member ON member.id = submission.member_id
     WHERE submission.id = ?`,
  )
    .bind(id)
    .first<OrganizationSubmissionRow & {
      member_email: string | null;
      moderation_transition_token: string | null;
    }>();
  if (!row) throw new ApiError(404, "submission_not_found", "Submission not found.");
  if (row.status === "approved") return json({ status: "success", public_id: row.published_organization_id, duplicate: true });
  if (row.status !== "pending") throw new ApiError(409, "submission_state_conflict", "Restore this denied submission before approving it.");
  const [locations, categories] = await Promise.all([
    env.DB.prepare("SELECT location_id FROM organization_submission_locations WHERE submission_id = ?").bind(id).all<{ location_id: string }>(),
    env.DB.prepare("SELECT category_id FROM organization_submission_categories WHERE submission_id = ?").bind(id).all<{ category_id: string }>(),
  ]);
  const organizationId = randomId("org");
  const slug = await uniqueSlug(env, "organizations", row.name);
  const now = new Date().toISOString();
  const transitionToken = randomId("moderation_transition");
  let derivative: PreparedDerivative | null = null;
  try {
    if (row.image_asset_id) derivative = await preparePublishedDerivative(env, row.image_asset_id);
    const statements: D1PreparedStatement[] = [];
    if (derivative) statements.push(publishDerivativeStatement(env, derivative));
    statements.push(
      env.DB.prepare(
        `UPDATE organization_submissions SET status = 'approved', reviewed_by_user_id = ?,
           reviewed_at = ?, published_organization_id = ?, moderation_transition_token = ?,
           updated_at = ?
         WHERE id = ? AND status = 'pending' AND moderation_transition_token IS ?`,
      ).bind(
        current.userId,
        now,
        organizationId,
        transitionToken,
        now,
        id,
        row.moderation_transition_token,
      ),
      env.DB.prepare(
        `INSERT INTO organizations (
           id, slug, name, description, details, website, public_email,
           public_phone, custom_location, image_asset_id, source_submission_id,
           is_active, published_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).bind(
        organizationId, slug, row.name, row.description, row.details, row.website,
        row.public_email, row.public_phone, row.new_location, row.image_asset_id,
        row.id, now, now,
      ),
    );
    for (const location of locations.results) {
      statements.push(env.DB.prepare("INSERT INTO organization_locations (organization_id, location_id) VALUES (?, ?)").bind(organizationId, location.location_id));
    }
    for (const category of categories.results) {
      statements.push(env.DB.prepare("INSERT INTO organization_categories (organization_id, category_id) VALUES (?, ?)").bind(organizationId, category.category_id));
    }
    statements.push(
      env.DB.prepare(
        `INSERT INTO organization_public_contacts (
           id, organization_id, contact_type, label, value, normalized_value,
           sort_order, is_primary, source_submission_contact_id, created_at, updated_at
         )
         SELECT 'orgcontact_' || lower(hex(randomblob(16))), ?, contact_type,
                label, value, normalized_value, sort_order, is_primary, id, ?, ?
         FROM organization_submission_public_contacts
         WHERE submission_id = ?
         ORDER BY sort_order, id`,
      ).bind(organizationId, now, now, id),
      env.DB.prepare(
        `INSERT INTO organization_sections (
           id, organization_id, section_kind, heading, body_text, sort_order,
           source_submission_section_id, created_at, updated_at
         )
         SELECT 'orgsection_' || lower(hex(randomblob(16))), ?, section_kind,
                heading, body_text, sort_order, id, ?, ?
         FROM organization_submission_sections
         WHERE submission_id = ?
         ORDER BY sort_order, id`,
      ).bind(organizationId, now, now, id),
    );
    statements.push(
      env.DB.prepare(
        `INSERT INTO moderation_events (
           id, submission_type, submission_id, action, actor_user_id,
           reason, private_notes, transition_token, created_at
         ) VALUES (?, 'organization', ?, 'approved', ?, ?, ?, ?, ?)`,
      ).bind(
        randomId("moderation"),
        id,
        current.userId,
        reason,
        notes,
        transitionToken,
        now,
      ),
      env.DB.prepare("UPDATE revision_state SET revision = revision + 1, updated_at = ? WHERE id = 1").bind(now),
    );
    if (row.member_email) {
      statements.push(queueEmailStatement(env, {
        kind: "submission_approved",
        recipientEmail: row.member_email,
        subjectType: "organization_submission",
        subjectId: id,
        idempotencyKey: `submission-approved:organization:${id}`,
        payload: {
          submission_type: "organization",
          submission_id: id,
          name: row.name,
          public_url: `/organization/${slug}`,
        },
      }));
    }
    statements.push(await adminAuditStatement(
      env,
      request,
      "moderation.approved",
      current.userId,
      "organization_submission",
      id,
      { organization_id: organizationId },
      now,
    ));
    await env.DB.batch(statements);
  } catch (error) {
    await cleanupDerivative(env, derivative);
    const currentRow = await env.DB.prepare(
      "SELECT status, published_organization_id FROM organization_submissions WHERE id = ?",
    ).bind(id).first<{ status: string; published_organization_id: string | null }>();
    if (currentRow?.status === "approved") {
      return json({ status: "success", public_id: currentRow.published_organization_id, duplicate: true });
    }
    if (currentRow && currentRow.status !== "pending") {
      throw new ApiError(409, "submission_state_conflict", "Restore this denied submission before approving it.");
    }
    throw error;
  }
  return json({ status: "success", public_id: organizationId, public_url: `/organization/${slug}` });
}

async function approveEvent(
  request: Request,
  env: Env,
  current: SessionContext,
  id: string,
  reason: string,
  notes: string,
): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT submission.*, member.email AS member_email
     FROM event_submissions submission
     LEFT JOIN members member ON member.id = submission.member_id
     WHERE submission.id = ?`,
  )
    .bind(id)
    .first<EventSubmissionRow & {
      member_email: string | null;
      moderation_transition_token: string | null;
    }>();
  if (!row) throw new ApiError(404, "submission_not_found", "Submission not found.");
  if (row.status === "approved") return json({ status: "success", public_id: row.published_event_id, duplicate: true });
  if (row.status !== "pending") throw new ApiError(409, "submission_state_conflict", "Restore this denied submission before approving it.");
  const organizations = await submissionOrganizationRows(env, id);
  if (organizations.some((organization) => !Number(organization.is_active))) {
    throw new ApiError(
      409,
      "organization_link_unavailable",
      "Remove or replace inactive organizations before approving this event.",
    );
  }
  const location = row.location_id
    ? await env.DB.prepare("SELECT city, island FROM locations WHERE id = ?").bind(row.location_id).first<{ city: string; island: string }>()
    : null;
  const locationDisplay = location ? `${location.city}, ${location.island}` : row.new_location;
  const eventId = await uniqueEventId(env);
  const slug = await uniqueSlug(env, "events", row.name, 120);
  const now = new Date().toISOString();
  const transitionToken = randomId("moderation_transition");
  let derivative: PreparedDerivative | null = null;
  try {
    if (row.image_asset_id) derivative = await preparePublishedDerivative(env, row.image_asset_id);
    const statements: D1PreparedStatement[] = [];
    if (derivative) statements.push(publishDerivativeStatement(env, derivative));
    statements.push(
      env.DB.prepare(
        `UPDATE event_submissions SET status = 'approved', reviewed_by_user_id = ?,
           reviewed_at = ?, published_event_id = ?, moderation_transition_token = ?,
           updated_at = ?
         WHERE id = ? AND status = 'pending' AND moderation_transition_token IS ?`,
      ).bind(
        current.userId,
        now,
        eventId,
        transitionToken,
        now,
        id,
        row.moderation_transition_token,
      ),
      env.DB.prepare(
        `INSERT INTO events (
           id, slug, name, description, details, start_at, end_at, timezone,
           venue_name, location_id, location_display, website, public_email,
           public_phone, image_asset_id, source_submission_id, is_active,
           published_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).bind(
        eventId, slug, row.name, row.description, row.details, row.start_at,
        row.end_at, row.timezone, row.venue_name, row.location_id, locationDisplay,
        row.website, row.public_email, row.public_phone, row.image_asset_id,
        row.id, now, now,
      ),
      env.DB.prepare(
        `INSERT INTO moderation_events (
           id, submission_type, submission_id, action, actor_user_id,
           reason, private_notes, transition_token, created_at
         ) VALUES (?, 'event', ?, 'approved', ?, ?, ?, ?, ?)`,
      ).bind(
        randomId("moderation"),
        id,
        current.userId,
        reason,
        notes,
        transitionToken,
        now,
      ),
      env.DB.prepare("UPDATE revision_state SET revision = revision + 1, updated_at = ? WHERE id = 1").bind(now),
    );
    statements.push(env.DB.prepare(
      `INSERT INTO event_organizations (
         event_id, organization_id, role, is_primary, created_at
       )
       SELECT ?, organization_id, role, is_primary, ?
       FROM event_submission_organizations
       WHERE submission_id = ?`,
    ).bind(eventId, now, id));
    if (row.member_email) {
      statements.push(queueEmailStatement(env, {
        kind: "submission_approved",
        recipientEmail: row.member_email,
        subjectType: "event_submission",
        subjectId: id,
        idempotencyKey: `submission-approved:event:${id}`,
        payload: {
          submission_type: "event",
          submission_id: id,
          name: row.name,
          public_url: `/event/${eventId}`,
        },
      }));
    }
    statements.push(await adminAuditStatement(
      env,
      request,
      "moderation.approved",
      current.userId,
      "event_submission",
      id,
      { event_id: eventId },
      now,
    ));
    await env.DB.batch(statements);
  } catch (error) {
    await cleanupDerivative(env, derivative);
    const currentRow = await env.DB.prepare(
      "SELECT status, published_event_id FROM event_submissions WHERE id = ?",
    ).bind(id).first<{ status: string; published_event_id: number | null }>();
    if (currentRow?.status === "approved") {
      return json({ status: "success", public_id: currentRow.published_event_id, duplicate: true });
    }
    if (currentRow && currentRow.status !== "pending") {
      throw new ApiError(409, "submission_state_conflict", "Restore this denied submission before approving it.");
    }
    throw error;
  }
  return json({ status: "success", public_id: eventId, public_url: `/event/${eventId}` });
}

export async function approve(
  request: Request,
  env: Env,
  rawType: string,
  id: string,
): Promise<Response> {
  const current = await readSession(request, env);
  await requireCsrf(request, env, current);
  const { reason, notes } = await moderationBody(request);
  const type = submissionType(rawType);
  return type === "organization"
    ? approveOrganization(request, env, current, id, reason, notes)
    : approveEvent(request, env, current, id, reason, notes);
}

export async function deny(
  request: Request,
  env: Env,
  rawType: string,
  id: string,
): Promise<Response> {
  const current = await readSession(request, env);
  await requireCsrf(request, env, current);
  const { reason, notes } = await moderationBody(request);
  if (reason.length < 3) {
    throw new ApiError(400, "validation_error", "Give a short reason for denying this submission.", {
      reason: ["Give a short reason for denying this submission."],
    });
  }
  const type = submissionType(rawType);
  const table = type === "organization" ? "organization_submissions" : "event_submissions";
  const row = await env.DB.prepare(
    `SELECT submission.status, submission.image_asset_id, submission.name,
            submission.moderation_transition_token,
            member.email AS member_email
     FROM ${table} submission
     LEFT JOIN members member ON member.id = submission.member_id
     WHERE submission.id = ?`,
  )
    .bind(id)
    .first<{
      status: string;
      image_asset_id: string | null;
      member_email: string | null;
      moderation_transition_token: string | null;
      name: string;
    }>();
  if (!row) throw new ApiError(404, "submission_not_found", "Submission not found.");
  if (row.status === "denied") return json({ status: "success", duplicate: true });
  if (row.status !== "pending") throw new ApiError(409, "submission_state_conflict", "An approved submission cannot be denied.");
  const now = new Date().toISOString();
  const transitionToken = randomId("moderation_transition");
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE ${table} SET status = 'denied', reviewed_by_user_id = ?, reviewed_at = ?,
         moderation_transition_token = ?, updated_at = ?
       WHERE id = ? AND status = 'pending' AND moderation_transition_token IS ?`,
    ).bind(current.userId, now, transitionToken, now, id, row.moderation_transition_token),
    env.DB.prepare(
      `INSERT INTO moderation_events (
         id, submission_type, submission_id, action, actor_user_id,
         reason, private_notes, transition_token, created_at
       ) VALUES (?, ?, ?, 'denied', ?, ?, ?, ?, ?)`,
    ).bind(
      randomId("moderation"),
      type,
      id,
      current.userId,
      reason,
      notes,
      transitionToken,
      now,
    ),
    env.DB.prepare("UPDATE revision_state SET revision = revision + 1, updated_at = ? WHERE id = 1").bind(now),
  ];
  if (row.image_asset_id) {
    statements.unshift(
      env.DB.prepare("UPDATE media_assets SET status = 'denied', denied_at = ? WHERE id = ? AND status = 'quarantined'")
        .bind(now, row.image_asset_id),
    );
  }
  if (row.member_email) {
    statements.push(queueEmailStatement(env, {
      kind: "submission_denied",
      recipientEmail: row.member_email,
      subjectType: `${type}_submission`,
      subjectId: id,
      idempotencyKey: `submission-denied:${type}:${id}:${transitionToken}`,
      payload: {
        submission_type: type,
        submission_id: id,
        name: row.name,
        reason,
      },
    }));
  }
  statements.push(await adminAuditStatement(
    env,
    request,
    "moderation.denied",
    current.userId,
    `${type}_submission`,
    id,
    { reason },
    now,
  ));
  try {
    await env.DB.batch(statements);
  } catch (error) {
    const currentRow = await env.DB.prepare(`SELECT status FROM ${table} WHERE id = ?`)
      .bind(id)
      .first<{ status: string }>();
    if (currentRow?.status === "denied") return json({ status: "success", duplicate: true });
    if (currentRow && currentRow.status !== "pending") {
      throw new ApiError(409, "submission_state_conflict", "An approved submission cannot be denied.");
    }
    throw error;
  }
  return json({ status: "success" });
}

export async function restore(
  request: Request,
  env: Env,
  rawType: string,
  id: string,
): Promise<Response> {
  const current = await readSession(request, env);
  await requireCsrf(request, env, current);
  const { reason, notes } = await moderationBody(request);
  const type = submissionType(rawType);
  const table = type === "organization" ? "organization_submissions" : "event_submissions";
  const row = await env.DB.prepare(
    `SELECT status, image_asset_id, moderation_transition_token FROM ${table} WHERE id = ?`,
  )
    .bind(id)
    .first<{
      status: string;
      image_asset_id: string | null;
      moderation_transition_token: string | null;
    }>();
  if (!row) throw new ApiError(404, "submission_not_found", "Submission not found.");
  if (row.status === "pending") return json({ status: "success", duplicate: true });
  if (row.status !== "denied") throw new ApiError(409, "submission_state_conflict", "Only denied submissions can be restored.");
  const now = new Date().toISOString();
  const transitionToken = randomId("moderation_transition");
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE ${table} SET status = 'pending', reviewed_by_user_id = NULL,
       reviewed_at = NULL,
       image_asset_id = CASE
         WHEN image_asset_id IS NULL OR EXISTS (
           SELECT 1 FROM media_assets
           WHERE id = image_asset_id
             AND status = 'quarantined'
             AND original_deleted_at IS NULL
         ) THEN image_asset_id
         ELSE NULL
       END,
       moderation_transition_token = ?, updated_at = ?
       WHERE id = ? AND status = 'denied' AND moderation_transition_token IS ?`,
    ).bind(transitionToken, now, id, row.moderation_transition_token),
    env.DB.prepare(
      `INSERT INTO moderation_events (
         id, submission_type, submission_id, action, actor_user_id,
         reason, private_notes, transition_token, created_at
       ) VALUES (?, ?, ?, 'restored', ?, ?, ?, ?, ?)`,
    ).bind(
      randomId("moderation"),
      type,
      id,
      current.userId,
      reason,
      notes,
      transitionToken,
      now,
    ),
    env.DB.prepare("UPDATE revision_state SET revision = revision + 1, updated_at = ? WHERE id = 1").bind(now),
  ];
  if (row.image_asset_id) {
    statements.unshift(
      env.DB.prepare(
        `UPDATE media_assets SET status = 'quarantined', denied_at = NULL
         WHERE id = ? AND status = 'denied' AND original_deleted_at IS NULL`,
      )
        .bind(row.image_asset_id),
    );
  }
  statements.push(await adminAuditStatement(
    env,
    request,
    "moderation.restored",
    current.userId,
    `${type}_submission`,
    id,
    {},
    now,
  ));
  try {
    await env.DB.batch(statements);
  } catch (error) {
    const currentRow = await env.DB.prepare(`SELECT status FROM ${table} WHERE id = ?`)
      .bind(id)
      .first<{ status: string }>();
    if (currentRow?.status === "pending") return json({ status: "success", duplicate: true });
    if (currentRow && currentRow.status !== "denied") {
      throw new ApiError(409, "submission_state_conflict", "Only denied submissions can be restored.");
    }
    throw error;
  }
  const restored = await env.DB.prepare(`SELECT image_asset_id FROM ${table} WHERE id = ?`)
    .bind(id)
    .first<{ image_asset_id: string | null }>();
  const imageDetached = Boolean(row.image_asset_id && !restored?.image_asset_id);
  return json({ status: "success", image_detached: imageDetached });
}

function csvCell(value: unknown): string {
  let text = String(value ?? "").replace(/\r?\n/g, " ");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export async function subscribersCsv(request: Request, env: Env): Promise<Response> {
  const current = await readSession(request, env);
  if (current.role !== "owner") {
    throw new ApiError(403, "owner_required", "Owner access is required to export subscriber data.");
  }
  const rows = await env.DB.prepare(
    `SELECT email, status, consent_at, unsubscribed_at, created_at
     FROM subscribers ORDER BY created_at DESC`,
  ).all<Record<string, unknown>>();
  const lines = [
    ["Email", "Status", "Consent at", "Unsubscribed at", "Created at"].map(csvCell).join(","),
    ...rows.results.map((row) => [row.email, row.status, row.consent_at, row.unsubscribed_at, row.created_at].map(csvCell).join(",")),
  ];
  const headers = securityHeaders("text/csv; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Disposition", 'attachment; filename="serve-the-cays-subscribers.csv"');
  return new Response(`\uFEFF${lines.join("\r\n")}\r\n`, { headers });
}
