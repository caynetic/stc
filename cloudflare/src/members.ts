import { ApiError, json, readJson } from "./http";
import {
  requireMemberCsrf,
  requireMemberSession,
  type MemberSessionContext,
} from "./member-auth";
import type { Env } from "./types";

const MAX_EVENT_NOTIFICATION_FILTERS = 20;

function nowIso(): string {
  return new Date().toISOString();
}

type NotificationFilterField = "event_category_ids" | "event_location_ids";

function notificationFilterIds(
  body: Record<string, unknown>,
  field: NotificationFilterField,
  label: string,
): string[] | undefined {
  if (!Object.prototype.hasOwnProperty.call(body, field)) return undefined;
  const value = body[field];
  const fieldError = (message: string): never => {
    throw new ApiError(400, "validation_error", "Review your event update preferences.", {
      [field]: [message],
    });
  };
  if (!Array.isArray(value)) return fieldError(`Choose ${label} using a list.`);
  const items: unknown[] = value;
  if (items.length > MAX_EVENT_NOTIFICATION_FILTERS) {
    fieldError(`Choose no more than ${MAX_EVENT_NOTIFICATION_FILTERS} ${label}.`);
  }
  const ids = items.map((item) => typeof item === "string" ? item.trim() : "");
  if (ids.some((id) => !id || id.length > 100)) {
    fieldError(`Choose valid ${label}.`);
  }
  if (new Set(ids).size !== ids.length) {
    fieldError("Choose each option only once.");
  }
  return ids;
}

async function requireActiveNotificationFilters(
  env: Env,
  field: NotificationFilterField,
  ids: string[] | undefined,
): Promise<void> {
  if (!ids?.length) return;
  const categoryField = field === "event_category_ids";
  const table = categoryField ? "categories" : "locations";
  const placeholders = ids.map(() => "?").join(", ");
  const active = await env.DB.prepare(
    `SELECT id FROM ${table} WHERE is_active = 1 AND id IN (${placeholders})`,
  ).bind(...ids).all<{ id: string }>();
  if (active.results.length !== ids.length) {
    throw new ApiError(400, "validation_error", "Review your event update preferences.", {
      [field]: [`One or more selected ${categoryField ? "categories" : "locations"} are unavailable.`],
    });
  }
}

async function memberNotificationFilterIds(
  env: Env,
  memberId: string,
): Promise<{ eventCategoryIds: string[]; eventLocationIds: string[] }> {
  const [categories, locations] = await Promise.all([
    env.DB.prepare(
      `SELECT preference.category_id AS id
       FROM member_notification_categories preference
       JOIN categories taxonomy
         ON taxonomy.id = preference.category_id AND taxonomy.is_active = 1
       WHERE preference.member_id = ?
       ORDER BY taxonomy.name COLLATE NOCASE, taxonomy.id`,
    ).bind(memberId).all<{ id: string }>(),
    env.DB.prepare(
      `SELECT preference.location_id AS id
       FROM member_notification_locations preference
       JOIN locations taxonomy
         ON taxonomy.id = preference.location_id AND taxonomy.is_active = 1
       WHERE preference.member_id = ?
       ORDER BY taxonomy.island COLLATE NOCASE, taxonomy.city COLLATE NOCASE, taxonomy.id`,
    ).bind(memberId).all<{ id: string }>(),
  ]);
  return {
    eventCategoryIds: categories.results.map(({ id }) => id),
    eventLocationIds: locations.results.map(({ id }) => id),
  };
}

async function authenticatedMutation(
  request: Request,
  env: Env,
): Promise<MemberSessionContext> {
  const current = await requireMemberSession(request, env);
  await requireMemberCsrf(request, env, current);
  return current;
}

function eventSelect(alias = "e"): string {
  return `${alias}.id, ${alias}.slug, ${alias}.name, ${alias}.description,
          ${alias}.start_at, ${alias}.end_at, ${alias}.timezone,
          ${alias}.venue_name, ${alias}.location_display`;
}

async function publicRsvpCount(env: Env, eventId: number): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM event_rsvps WHERE event_id = ? AND status = 'going'",
  ).bind(eventId).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

export async function memberDashboard(request: Request, env: Env): Promise<Response> {
  const current = await requireMemberSession(request, env);
  const now = nowIso();
  const [
    member,
    newsletter,
    organizations,
    events,
    upcoming,
    past,
    organizationSubmissions,
    eventSubmissions,
    notificationFilters,
    availableCategories,
    availableLocations,
  ] = await Promise.all([
    env.DB.prepare(
      `SELECT id, email, display_name, reminder_emails_enabled,
              legacy_favorites_imported_at, created_at, updated_at
       FROM members WHERE id = ?`,
    ).bind(current.memberId).first<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT status, personalization_enabled, member_id
       FROM subscribers WHERE email = ? COLLATE NOCASE`,
    ).bind(current.email).first<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT o.id, o.slug, o.name, o.description, f.created_at AS saved_at
       FROM organization_favorites f
       JOIN organizations o ON o.id = f.organization_id AND o.is_active = 1
       WHERE f.member_id = ? ORDER BY f.created_at DESC, o.name`,
    ).bind(current.memberId).all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT ${eventSelect("e")}, f.created_at AS saved_at
       FROM event_favorites f
       JOIN events e ON e.id = f.event_id AND e.is_active = 1
       WHERE f.member_id = ? ORDER BY f.created_at DESC, e.start_at`,
    ).bind(current.memberId).all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT ${eventSelect("e")}, r.status, r.created_at, r.updated_at
       FROM event_rsvps r
       JOIN events e ON e.id = r.event_id
       WHERE r.member_id = ? AND r.status = 'going'
         AND COALESCE(e.end_at, e.start_at) > ?
       ORDER BY e.start_at, e.id`,
    ).bind(current.memberId, now).all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT ${eventSelect("e")}, r.status, r.created_at, r.updated_at
       FROM event_rsvps r
       JOIN events e ON e.id = r.event_id
       WHERE r.member_id = ?
         AND (r.status = 'cancelled' OR COALESCE(e.end_at, e.start_at) <= ?)
       ORDER BY r.updated_at DESC, e.id DESC`,
    ).bind(current.memberId, now).all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT id, 'organization' AS type, name, status, created_at, updated_at
       FROM organization_submissions WHERE member_id = ? ORDER BY created_at DESC`,
    ).bind(current.memberId).all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT id, 'event' AS type, name, status, created_at, updated_at
       FROM event_submissions WHERE member_id = ? ORDER BY created_at DESC`,
    ).bind(current.memberId).all<Record<string, unknown>>(),
    memberNotificationFilterIds(env, current.memberId),
    env.DB.prepare(
      `SELECT id, slug, name FROM categories
       WHERE is_active = 1 ORDER BY name COLLATE NOCASE, id`,
    ).all<{ id: string; slug: string; name: string }>(),
    env.DB.prepare(
      `SELECT id, slug, city, island FROM locations
       WHERE is_active = 1 ORDER BY island COLLATE NOCASE, city COLLATE NOCASE, id`,
    ).all<{ id: string; slug: string; city: string; island: string }>(),
  ]);
  if (!member) throw new ApiError(401, "authentication_required", "Sign in to continue.");
  const submissions = [...organizationSubmissions.results, ...eventSubmissions.results]
    .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
  const newsletterActive = newsletter?.status === "active" && newsletter.member_id === current.memberId;
  const personalizedUpdatesEnabled = newsletterActive && Boolean(newsletter.personalization_enabled);
  return json({
    member: {
      ...member,
      reminder_emails_enabled: Boolean(member.reminder_emails_enabled),
    },
    favorite_organizations: organizations.results,
    favorite_events: events.results,
    upcoming_rsvps: upcoming.results,
    past_rsvps: past.results,
    submissions,
    notification_settings: {
      event_reminders_enabled: Boolean(member.reminder_emails_enabled),
      newsletter_status: newsletter?.status ?? "not_subscribed",
      newsletter_subscribed: newsletterActive,
      personalized_updates_enabled: personalizedUpdatesEnabled,
      event_category_ids: notificationFilters.eventCategoryIds,
      event_location_ids: notificationFilters.eventLocationIds,
    },
    notification_taxonomy: {
      categories: availableCategories.results,
      locations: availableLocations.results,
    },
  });
}

export async function updateMemberProfile(request: Request, env: Env): Promise<Response> {
  const current = await authenticatedMutation(request, env);
  const body = await readJson(request);
  const displayProvided = Object.prototype.hasOwnProperty.call(body, "display_name");
  const reminderProvided = Object.prototype.hasOwnProperty.call(body, "reminder_emails_enabled")
    || Object.prototype.hasOwnProperty.call(body, "event_reminders_enabled");
  const displayName = displayProvided
    ? (typeof body.display_name === "string" ? body.display_name.trim() : "")
    : current.displayName;
  const reminderValue = reminderProvided
    ? (body.reminder_emails_enabled ?? body.event_reminders_enabled)
    : current.reminderEmailsEnabled;
  const personalizedProvided = Object.prototype.hasOwnProperty.call(body, "personalized_updates_enabled");
  const personalizedValue = body.personalized_updates_enabled;
  const eventCategoryIds = notificationFilterIds(body, "event_category_ids", "event categories");
  const eventLocationIds = notificationFilterIds(body, "event_location_ids", "event locations");
  if (displayName.length > 120) {
    throw new ApiError(400, "validation_error", "Review your profile details.", {
      display_name: ["Display name must be 120 characters or fewer."],
    });
  }
  if (reminderProvided && typeof reminderValue !== "boolean") {
    throw new ApiError(400, "validation_error", "Choose a reminder preference.", {
      reminder_emails_enabled: ["Choose whether to receive event reminders."],
    });
  }
  if (personalizedProvided && typeof personalizedValue !== "boolean") {
    throw new ApiError(400, "validation_error", "Choose a newsletter preference.", {
      personalized_updates_enabled: ["Choose whether to personalize newsletter updates."],
    });
  }
  await requireActiveNotificationFilters(env, "event_category_ids", eventCategoryIds);
  await requireActiveNotificationFilters(env, "event_location_ids", eventLocationIds);
  const now = nowIso();
  const statements: D1PreparedStatement[] = [env.DB.prepare(
    `UPDATE members SET display_name = ?, reminder_emails_enabled = ?, updated_at = ?
     WHERE id = ?`,
  ).bind(displayName, reminderValue ? 1 : 0, now, current.memberId)];
  if (!reminderValue) {
    statements.push(
      env.DB.prepare(
        `DELETE FROM email_jobs
         WHERE member_id = ? AND kind = 'event_reminder' AND status IN ('pending', 'failed')`,
      ).bind(current.memberId),
      env.DB.prepare(
        `UPDATE event_rsvps SET reminder_sent_at = NULL, updated_at = ?
         WHERE member_id = ? AND status = 'going'`,
      ).bind(now, current.memberId),
    );
  }
  if (personalizedProvided) {
    statements.push(env.DB.prepare(
      `UPDATE subscribers SET personalization_enabled = ?, updated_at = ?
       WHERE member_id = ? AND status = 'active'`,
    ).bind(personalizedValue ? 1 : 0, now, current.memberId));
  }
  if (eventCategoryIds) {
    statements.push(env.DB.prepare(
      "DELETE FROM member_notification_categories WHERE member_id = ?",
    ).bind(current.memberId));
    for (const categoryId of eventCategoryIds) {
      statements.push(env.DB.prepare(
        `INSERT INTO member_notification_categories (member_id, category_id, created_at)
         VALUES (?, ?, ?)`,
      ).bind(current.memberId, categoryId, now));
    }
  }
  if (eventLocationIds) {
    statements.push(env.DB.prepare(
      "DELETE FROM member_notification_locations WHERE member_id = ?",
    ).bind(current.memberId));
    for (const locationId of eventLocationIds) {
      statements.push(env.DB.prepare(
        `INSERT INTO member_notification_locations (member_id, location_id, created_at)
         VALUES (?, ?, ?)`,
      ).bind(current.memberId, locationId, now));
    }
  }
  await env.DB.batch(statements);
  const [newsletter, notificationFilters] = await Promise.all([
    env.DB.prepare(
      `SELECT status, personalization_enabled, member_id
       FROM subscribers WHERE email = ? COLLATE NOCASE`,
    ).bind(current.email).first<Record<string, unknown>>(),
    memberNotificationFilterIds(env, current.memberId),
  ]);
  const newsletterActive = newsletter?.status === "active" && newsletter.member_id === current.memberId;
  return json({
    status: "success",
    member: {
      id: current.memberId,
      email: current.email,
      display_name: displayName,
      reminder_emails_enabled: reminderValue,
    },
    notification_settings: {
      event_reminders_enabled: reminderValue,
      newsletter_status: newsletter?.status ?? "not_subscribed",
      newsletter_subscribed: newsletterActive,
      personalized_updates_enabled: newsletterActive && Boolean(newsletter.personalization_enabled),
      event_category_ids: notificationFilters.eventCategoryIds,
      event_location_ids: notificationFilters.eventLocationIds,
    },
  });
}

export async function setOrganizationFavorite(
  request: Request,
  env: Env,
  organizationId: string,
): Promise<Response> {
  const current = await authenticatedMutation(request, env);
  const organization = await env.DB.prepare(
    "SELECT id FROM organizations WHERE id = ? AND is_active = 1",
  ).bind(organizationId).first<{ id: string }>();
  if (!organization) throw new ApiError(404, "organization_not_found", "Organization not found.");
  await env.DB.prepare(
    `INSERT INTO organization_favorites (member_id, organization_id, created_at)
     VALUES (?, ?, ?) ON CONFLICT(member_id, organization_id) DO NOTHING`,
  ).bind(current.memberId, organizationId, nowIso()).run();
  return json({ status: "success", saved: true, organization_id: organizationId });
}

export async function deleteOrganizationFavorite(
  request: Request,
  env: Env,
  organizationId: string,
): Promise<Response> {
  const current = await authenticatedMutation(request, env);
  await env.DB.prepare(
    "DELETE FROM organization_favorites WHERE member_id = ? AND organization_id = ?",
  ).bind(current.memberId, organizationId).run();
  return json({ status: "success", saved: false, organization_id: organizationId });
}

export async function setEventFavorite(
  request: Request,
  env: Env,
  eventId: number,
): Promise<Response> {
  const current = await authenticatedMutation(request, env);
  const event = await env.DB.prepare(
    `SELECT id FROM events WHERE id = ? AND is_active = 1
     AND COALESCE(end_at, start_at) > ?`,
  ).bind(eventId, nowIso()).first<{ id: number }>();
  if (!event) throw new ApiError(404, "event_not_found", "This event is unavailable or has ended.");
  await env.DB.prepare(
    `INSERT INTO event_favorites (member_id, event_id, created_at)
     VALUES (?, ?, ?) ON CONFLICT(member_id, event_id) DO NOTHING`,
  ).bind(current.memberId, eventId, nowIso()).run();
  return json({ status: "success", saved: true, event_id: eventId });
}

export async function deleteEventFavorite(
  request: Request,
  env: Env,
  eventId: number,
): Promise<Response> {
  const current = await authenticatedMutation(request, env);
  await env.DB.prepare(
    "DELETE FROM event_favorites WHERE member_id = ? AND event_id = ?",
  ).bind(current.memberId, eventId).run();
  return json({ status: "success", saved: false, event_id: eventId });
}

export async function setEventRsvp(
  request: Request,
  env: Env,
  eventId: number,
): Promise<Response> {
  const current = await authenticatedMutation(request, env);
  const now = nowIso();
  const event = await env.DB.prepare(
    `SELECT ${eventSelect("e")}
     FROM events e
     WHERE e.id = ? AND e.is_active = 1 AND COALESCE(e.end_at, e.start_at) > ?`,
  ).bind(eventId, now).first<Record<string, unknown>>();
  if (!event) throw new ApiError(409, "event_ended", "This event is unavailable or has ended.");
  const existing = await env.DB.prepare(
    "SELECT status, transition_count FROM event_rsvps WHERE member_id = ? AND event_id = ?",
  ).bind(current.memberId, eventId).first<{
    status: "going" | "cancelled";
    transition_count: number;
  }>();
  await env.DB.prepare(
    `INSERT INTO event_rsvps (
       member_id, event_id, status, reminder_sent_at, created_at, updated_at
    ) VALUES (?, ?, 'going', NULL, ?, ?)
     ON CONFLICT(member_id, event_id) DO UPDATE SET
       status = 'going',
       transition_count = CASE
         WHEN event_rsvps.status <> 'going' THEN event_rsvps.transition_count + 1
         ELSE event_rsvps.transition_count
       END,
       reminder_sent_at = CASE
         WHEN event_rsvps.status <> 'going' THEN NULL
         ELSE event_rsvps.reminder_sent_at
       END,
       updated_at = CASE
         WHEN event_rsvps.status <> 'going' THEN excluded.updated_at
         ELSE event_rsvps.updated_at
       END`,
  ).bind(current.memberId, eventId, now, now).run();
  return json({
    status: "success",
    rsvp: { event_id: eventId, status: "going" },
    rsvp_count: await publicRsvpCount(env, eventId),
    duplicate: existing?.status === "going",
  });
}

export async function deleteEventRsvp(
  request: Request,
  env: Env,
  eventId: number,
): Promise<Response> {
  const current = await authenticatedMutation(request, env);
  const existing = await env.DB.prepare(
    `SELECT r.status, r.transition_count, ${eventSelect("e")}
     FROM event_rsvps r JOIN events e ON e.id = r.event_id
     WHERE r.member_id = ? AND r.event_id = ?`,
  ).bind(current.memberId, eventId).first<Record<string, unknown>>();
  if (!existing || existing.status === "cancelled") {
    return json({
      status: "success",
      rsvp: { event_id: eventId, status: "cancelled" },
      rsvp_count: await publicRsvpCount(env, eventId),
      duplicate: true,
    });
  }
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE event_rsvps
       SET status = 'cancelled', reminder_sent_at = NULL,
           transition_count = transition_count + 1, updated_at = ?
       WHERE member_id = ? AND event_id = ? AND status = 'going'`,
    ).bind(now, current.memberId, eventId),
    env.DB.prepare(
      `DELETE FROM email_jobs
       WHERE member_id = ? AND kind = 'event_reminder'
         AND status IN ('pending', 'failed')
         AND json_extract(payload_json, '$.event_id') = ?`,
    ).bind(current.memberId, eventId),
  ]);
  return json({
    status: "success",
    rsvp: { event_id: eventId, status: "cancelled" },
    rsvp_count: await publicRsvpCount(env, eventId),
  });
}

export async function importLegacyFavorites(request: Request, env: Env): Promise<Response> {
  const current = await authenticatedMutation(request, env);
  const body = await readJson(request, 32 * 1_024);
  if (!Array.isArray(body.names)) {
    throw new ApiError(400, "validation_error", "Provide the saved organization names.");
  }
  const names = [...new Set(body.names
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().slice(0, 200))
    .filter(Boolean))]
    .slice(0, 200);
  const member = await env.DB.prepare(
    "SELECT legacy_favorites_imported_at FROM members WHERE id = ?",
  ).bind(current.memberId).first<{ legacy_favorites_imported_at: string | null }>();
  if (member?.legacy_favorites_imported_at) {
    return json({
      status: "success",
      already_imported: true,
      imported_count: 0,
      unmatched_count: 0,
      ambiguous_count: 0,
    });
  }
  const statements: D1PreparedStatement[] = [];
  const matchedNames: string[] = [];
  const unmatchedNames: string[] = [];
  const ambiguousNames: string[] = [];
  const now = nowIso();
  for (const name of names) {
    const matches = await env.DB.prepare(
      `SELECT id FROM organizations
       WHERE is_active = 1 AND name = ? COLLATE NOCASE
       ORDER BY id LIMIT 2`,
    ).bind(name).all<{ id: string }>();
    if (matches.results.length === 0) {
      unmatchedNames.push(name);
    } else if (matches.results.length > 1) {
      ambiguousNames.push(name);
    } else {
      matchedNames.push(name);
      statements.push(env.DB.prepare(
        `INSERT INTO organization_favorites (member_id, organization_id, created_at)
         VALUES (?, ?, ?) ON CONFLICT(member_id, organization_id) DO NOTHING`,
      ).bind(current.memberId, matches.results[0].id, now));
    }
  }
  statements.push(env.DB.prepare(
    `UPDATE members SET legacy_favorites_imported_at = ?, updated_at = ?
     WHERE id = ? AND legacy_favorites_imported_at IS NULL`,
  ).bind(now, now, current.memberId));
  const results = await env.DB.batch(statements);
  const importedNames = matchedNames.filter((_, index) => Number(results[index]?.meta.changes ?? 0) === 1);
  return json({
    status: "success",
    imported_count: importedNames.length,
    imported_names: importedNames,
    already_saved_names: matchedNames.filter((name) => !importedNames.includes(name)),
    unmatched_count: unmatchedNames.length,
    unmatched_names: unmatchedNames,
    ambiguous_count: ambiguousNames.length,
    ambiguous_names: ambiguousNames,
  });
}

function clearMemberCookie(env: Env): string {
  const secure = env.ENVIRONMENT !== "local" && env.ENVIRONMENT !== "test";
  const name = secure ? "__Host-stc_member_session" : "stc_member_session";
  return `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export async function deleteMemberAccount(request: Request, env: Env): Promise<Response> {
  const current = await authenticatedMutation(request, env);
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM email_jobs
       WHERE status <> 'sent' AND (
         member_id = ? OR (
           recipient_email = ? COLLATE NOCASE
           AND kind IN ('magic_link', 'welcome', 'rsvp_confirmation', 'rsvp_cancellation', 'event_reminder')
         )
       )`,
    ).bind(current.memberId, current.email),
    env.DB.prepare(
      "DELETE FROM member_magic_links WHERE email = ? COLLATE NOCASE AND consumed_at IS NULL",
    ).bind(current.email),
    env.DB.prepare("UPDATE organization_submissions SET member_id = NULL WHERE member_id = ?")
      .bind(current.memberId),
    env.DB.prepare("UPDATE event_submissions SET member_id = NULL WHERE member_id = ?")
      .bind(current.memberId),
    env.DB.prepare(
      `UPDATE subscribers
       SET member_id = NULL, personalization_enabled = 0, updated_at = ?
       WHERE member_id = ?`,
    ).bind(now, current.memberId),
    env.DB.prepare("DELETE FROM members WHERE id = ?").bind(current.memberId),
  ]);
  return json({ status: "success", authenticated: false }, 200, {
    "Set-Cookie": clearMemberCookie(env),
  });
}
