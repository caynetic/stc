import { ApiError, json, securityHeaders } from "./http";
import { expectedOrigin } from "./security";
import type { Env } from "./types";

interface OrganizationRow extends Record<string, unknown> {
  id: string;
  slug: string;
  name: string;
  description: string;
  details: string;
  website: string;
  public_email: string;
  public_phone: string;
  custom_location: string;
  image_asset_id: string | null;
  image_alt: string | null;
  published_at: string;
  locations_json: string;
  categories_json: string;
}

interface OrganizationDetailRow extends OrganizationRow {
  public_contacts_json: string;
  sections_json: string;
}

interface EventRow extends Record<string, unknown> {
  id: number;
  slug: string;
  name: string;
  description: string;
  details: string;
  start_at: string;
  end_at: string | null;
  timezone: string;
  venue_name: string;
  location_display: string;
  website: string;
  public_email: string;
  public_phone: string;
  image_asset_id: string | null;
  image_alt: string | null;
  published_at: string;
  organizations_json: string;
  rsvp_count: number;
}

interface EventOrganizationPayload {
  id: string;
  slug: string;
  name: string;
  role: "host" | "organizer" | "partner" | "beneficiary";
  is_primary: boolean;
}

interface OrganizationPublicContactPayload {
  type: "email" | "phone";
  label: string;
  value: string;
  is_primary: boolean;
}

interface OrganizationSectionPayload {
  kind: "mission" | "programs_services" | "ways_to_help" | "eligibility" | "hours";
  heading: string;
  body: string;
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function publicHttpUrl(value: string): string {
  const candidate = value.trim();
  if (!candidate) return "";
  try {
    const parsed = new URL(candidate);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username ||
      parsed.password
    ) return "";
    return candidate;
  } catch {
    return "";
  }
}

function organizationPayload(row: OrganizationRow): Record<string, unknown> {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    details: row.details,
    website: publicHttpUrl(row.website),
    public_email: row.public_email,
    public_phone: row.public_phone,
    custom_location: row.custom_location,
    image_url: row.image_asset_id ? `/media/${encodeURIComponent(row.image_asset_id)}` : "",
    image_alt: row.image_alt ?? "",
    locations: parseJsonArray(row.locations_json),
    categories: parseJsonArray(row.categories_json),
    published_at: row.published_at,
  };
}

function organizationPublicContacts(value: string): OrganizationPublicContactPayload[] {
  return parseJsonArray(value).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const candidate = item as Record<string, unknown>;
    if (
      !["email", "phone"].includes(String(candidate.type)) ||
      typeof candidate.label !== "string" ||
      typeof candidate.value !== "string"
    ) return [];
    return [{
      type: candidate.type as OrganizationPublicContactPayload["type"],
      label: candidate.label,
      value: candidate.value,
      is_primary: Number(candidate.is_primary) === 1,
    }];
  });
}

function organizationSections(value: string): OrganizationSectionPayload[] {
  const kinds = ["mission", "programs_services", "ways_to_help", "eligibility", "hours"];
  return parseJsonArray(value).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const candidate = item as Record<string, unknown>;
    if (
      !kinds.includes(String(candidate.kind)) ||
      typeof candidate.heading !== "string" ||
      typeof candidate.body !== "string"
    ) return [];
    return [{
      kind: candidate.kind as OrganizationSectionPayload["kind"],
      heading: candidate.heading,
      body: candidate.body,
    }];
  });
}

function organizationDetailPayload(row: OrganizationDetailRow): Record<string, unknown> {
  return {
    ...organizationPayload(row),
    public_contacts: organizationPublicContacts(row.public_contacts_json),
    sections: organizationSections(row.sections_json),
  };
}

function eventOrganizations(value: string): EventOrganizationPayload[] {
  return parseJsonArray(value).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const candidate = item as Record<string, unknown>;
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.slug !== "string" ||
      typeof candidate.name !== "string" ||
      !["host", "organizer", "partner", "beneficiary"].includes(String(candidate.role))
    ) return [];
    return [{
      id: candidate.id,
      slug: candidate.slug,
      name: candidate.name,
      role: candidate.role as EventOrganizationPayload["role"],
      is_primary: Boolean(candidate.is_primary),
    }];
  });
}

function ended(row: EventRow): boolean {
  return Date.parse(row.end_at || row.start_at) <= Date.now();
}

function eventPayload(row: EventRow): Record<string, unknown> {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    details: row.details,
    start_at: row.start_at,
    end_at: row.end_at,
    timezone: row.timezone,
    venue_name: row.venue_name,
    location_display: row.location_display,
    website: publicHttpUrl(row.website),
    public_email: row.public_email,
    public_phone: row.public_phone,
    image_url: row.image_asset_id ? `/media/${encodeURIComponent(row.image_asset_id)}` : "",
    image_alt: row.image_alt ?? "",
    published_at: row.published_at,
    organizations: eventOrganizations(row.organizations_json),
    rsvp_count: Number(row.rsvp_count) || 0,
    ended: ended(row),
  };
}

const ORGANIZATION_CORE_COLUMNS = `
  o.id, o.slug, o.name, o.description, o.details, o.website,
  o.public_email, o.public_phone, o.custom_location, o.image_asset_id,
  o.published_at`;

const ORGANIZATION_RELATIONSHIP_COLUMNS = `
  COALESCE((
    SELECT json_group_array(json_object(
      'id', listed.id, 'slug', listed.slug, 'city', listed.city, 'island', listed.island
    ))
    FROM (
      SELECT l.id, l.slug, l.city, l.island
      FROM organization_locations ol JOIN locations l ON l.id = ol.location_id
      WHERE ol.organization_id = o.id
      ORDER BY l.island, l.city, l.id
    ) listed
  ), '[]') AS locations_json,
  COALESCE((
    SELECT json_group_array(json_object(
      'id', listed.id, 'slug', listed.slug, 'name', listed.name
    ))
    FROM (
      SELECT c.id, c.slug, c.name
      FROM organization_categories oc JOIN categories c ON c.id = oc.category_id
      WHERE oc.organization_id = o.id
      ORDER BY c.name, c.id
    ) listed
  ), '[]') AS categories_json`;

const ORGANIZATION_FROM = `
  FROM organizations o
  LEFT JOIN media_assets m ON m.id = o.image_asset_id AND m.status = 'published'`;

const ORGANIZATION_SELECT = `
  SELECT ${ORGANIZATION_CORE_COLUMNS}, m.alt_text AS image_alt,
    ${ORGANIZATION_RELATIONSHIP_COLUMNS}
  ${ORGANIZATION_FROM}`;

const ORGANIZATION_DETAIL_SELECT = `
  SELECT ${ORGANIZATION_CORE_COLUMNS}, m.alt_text AS image_alt,
    ${ORGANIZATION_RELATIONSHIP_COLUMNS},
    COALESCE((
      SELECT json_group_array(json_object(
        'type', listed.contact_type,
        'label', listed.label,
        'value', listed.value,
        'is_primary', listed.is_primary
      ))
      FROM (
        SELECT contact_type, label, value, is_primary
        FROM organization_public_contacts
        WHERE organization_id = o.id
        ORDER BY is_primary DESC, sort_order, id
      ) listed
    ), '[]') AS public_contacts_json,
    COALESCE((
      SELECT json_group_array(json_object(
        'kind', listed.section_kind,
        'heading', listed.heading,
        'body', listed.body_text
      ))
      FROM (
        SELECT section_kind, heading, body_text
        FROM organization_sections
        WHERE organization_id = o.id
        ORDER BY sort_order, id
      ) listed
    ), '[]') AS sections_json
  ${ORGANIZATION_FROM}`;

const UPCOMING_EVENT_SQL = "COALESCE(e.end_at, e.start_at) > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

const EVENT_SELECT = `
  SELECT e.*, m.alt_text AS image_alt,
    COALESCE((
      SELECT COUNT(*)
      FROM event_rsvps er
      WHERE er.event_id = e.id AND er.status = 'going'
    ), 0) AS rsvp_count,
    COALESCE((
      SELECT json_group_array(json_object(
        'id', linked.id,
        'slug', linked.slug,
        'name', linked.name,
        'role', linked.role,
        'is_primary', linked.is_primary
      ))
      FROM (
        SELECT o.id, o.slug, o.name, eo.role, eo.is_primary
        FROM event_organizations eo
        JOIN organizations o ON o.id = eo.organization_id AND o.is_active = 1
        WHERE eo.event_id = e.id
        ORDER BY eo.is_primary DESC, o.name, o.id
      ) linked
    ), '[]') AS organizations_json
  FROM events e
  LEFT JOIN media_assets m ON m.id = e.image_asset_id AND m.status = 'published'`;

export async function organizationListData(env: Env, url: URL): Promise<Record<string, unknown>[]> {
  const search = (url.searchParams.get("search") ?? "").trim().slice(0, 100);
  const city = (url.searchParams.get("city") ?? "").trim().slice(0, 100);
  const category = (url.searchParams.get("category") ?? "").trim().slice(0, 80);
  const rows = await env.DB.prepare(
    `${ORGANIZATION_SELECT}
     WHERE o.is_active = 1
       AND (? = '' OR o.name LIKE '%' || ? || '%' COLLATE NOCASE OR o.description LIKE '%' || ? || '%' COLLATE NOCASE)
       AND (? = '' OR EXISTS (
         SELECT 1 FROM organization_locations ol2 JOIN locations l2 ON l2.id = ol2.location_id
         WHERE ol2.organization_id = o.id AND l2.city = ? COLLATE NOCASE
       ))
       AND (? = '' OR EXISTS (
         SELECT 1 FROM organization_categories oc2 JOIN categories c2 ON c2.id = oc2.category_id
         WHERE oc2.organization_id = o.id AND c2.slug = ?
       ))
     ORDER BY o.name LIMIT 200`,
  )
    .bind(search, search, search, city, city, category, category)
    .all<OrganizationRow>();
  return rows.results.map(organizationPayload);
}

export async function organizationData(env: Env, slug: string): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare(`${ORGANIZATION_DETAIL_SELECT} WHERE o.slug = ? AND o.is_active = 1`)
    .bind(slug)
    .first<OrganizationDetailRow>();
  if (!row) throw new ApiError(404, "organization_not_found", "Organization not found.");
  const events = await env.DB.prepare(
    `${EVENT_SELECT}
     WHERE e.is_active = 1
       AND ${UPCOMING_EVENT_SQL}
       AND EXISTS (
         SELECT 1 FROM event_organizations linked
         WHERE linked.event_id = e.id AND linked.organization_id = ?
       )
     ORDER BY e.start_at, e.id
     LIMIT 100`,
  ).bind(row.id).all<EventRow>();
  return { ...organizationDetailPayload(row), upcoming_events: events.results.map(eventPayload) };
}

export async function eventListData(env: Env, url: URL): Promise<Record<string, unknown>[]> {
  const search = (url.searchParams.get("search") ?? "").trim().slice(0, 100);
  const city = (url.searchParams.get("city") ?? "").trim().slice(0, 100);
  const rows = await env.DB.prepare(
    `${EVENT_SELECT}
     LEFT JOIN locations l ON l.id = e.location_id
     WHERE e.is_active = 1
       AND ${UPCOMING_EVENT_SQL}
       AND (? = '' OR e.name LIKE '%' || ? || '%' COLLATE NOCASE OR e.description LIKE '%' || ? || '%' COLLATE NOCASE)
       AND (? = '' OR l.city = ? COLLATE NOCASE)
     ORDER BY e.start_at, e.id LIMIT 200`,
  )
    .bind(search, search, search, city, city)
    .all<EventRow>();
  return rows.results.map(eventPayload);
}

export async function eventData(env: Env, id: number): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare(
    `${EVENT_SELECT}
     WHERE e.id = ? AND e.is_active = 1`,
  )
    .bind(id)
    .first<EventRow>();
  if (!row) throw new ApiError(404, "event_not_found", "Event not found.");
  return eventPayload(row);
}

export async function organizationsApi(request: Request, env: Env): Promise<Response> {
  return json({ organizations: await organizationListData(env, new URL(request.url)) }, 200, {
    "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
  });
}

export async function organizationApi(env: Env, slug: string): Promise<Response> {
  return json({ organization: await organizationData(env, slug) }, 200, {
    "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
  });
}

export async function eventsApi(request: Request, env: Env): Promise<Response> {
  return json({ events: await eventListData(env, new URL(request.url)) }, 200, {
    "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
  });
}

export async function eventApi(env: Env, id: number): Promise<Response> {
  const event = await eventData(env, id);
  return json({ event }, 200, {
    "Cache-Control": event.ended
      ? "public, max-age=300, stale-while-revalidate=3600"
      : "public, max-age=60, stale-while-revalidate=300",
    ...(event.ended ? { "X-Robots-Tag": "noindex, nofollow" } : {}),
  });
}

export async function sitemap(env: Env): Promise<Response> {
  const [organizations, events, news] = await Promise.all([
    env.DB.prepare("SELECT slug, updated_at FROM organizations WHERE is_active = 1 ORDER BY slug").all<{ slug: string; updated_at: string }>(),
    env.DB.prepare(
      `SELECT e.id, e.updated_at FROM events e
       WHERE e.is_active = 1 AND ${UPCOMING_EVENT_SQL}
       ORDER BY e.start_at, e.id`,
    ).all<{ id: number; updated_at: string }>(),
    env.DB.prepare(
      `SELECT slug, updated_at FROM news_posts
       WHERE status = 'published' AND published_at <= ?
       ORDER BY published_at DESC, id DESC`,
    ).bind(new Date().toISOString()).all<{ slug: string; updated_at: string }>(),
  ]);
  const origin = expectedOrigin(env);
  const staticPaths = ["/", "/organizations", "/events", "/news", "/about", "/privacy"];
  const entries = [
    ...staticPaths.map((path) => ({ loc: `${origin}${path}`, lastmod: "" })),
    ...organizations.results.map((row) => ({ loc: `${origin}/organization/${encodeURIComponent(row.slug)}`, lastmod: row.updated_at })),
    ...events.results.map((row) => ({ loc: `${origin}/event/${row.id}`, lastmod: row.updated_at })),
    ...news.results.map((row) => ({ loc: `${origin}/news/${encodeURIComponent(row.slug)}`, lastmod: row.updated_at })),
  ];
  const escapeXml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries
    .map((entry) => `  <url><loc>${escapeXml(entry.loc)}</loc>${entry.lastmod ? `<lastmod>${escapeXml(entry.lastmod.slice(0, 10))}</lastmod>` : ""}</url>`)
    .join("\n")}\n</urlset>\n`;
  const headers = securityHeaders("application/xml; charset=utf-8");
  headers.set("Cache-Control", "public, max-age=300");
  return new Response(body, { headers });
}

export function robots(env: Env): Response {
  const body = `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/admin/\nSitemap: ${expectedOrigin(env)}/sitemap.xml\n`;
  const headers = securityHeaders("text/plain; charset=utf-8");
  headers.set("Cache-Control", "public, max-age=86400");
  return new Response(body, { headers });
}
