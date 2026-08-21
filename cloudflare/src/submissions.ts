import { ApiError, json, positiveInteger, readMultipart, type MultipartInput } from "./http";
import { requireMemberCsrf, requireMemberSession } from "./member-auth";
import { queueEmailStatement } from "./email";
import {
  cleanupPrivateImage,
  preparePrivateImage,
  privateImageInsert,
  validateImage,
  type PreparedPrivateImage,
} from "./images";
import {
  clientIp,
  constantTimeEqual,
  enforceRateLimit,
  randomId,
  requestIpHash,
  requireSameOrigin,
  submissionIdempotency,
  verifyTurnstile,
} from "./security";
import type {
  CategoryRow,
  Env,
  LocationRow,
  OrganizationContactType,
  OrganizationSectionKind,
} from "./types";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^[+()\-\s.0-9]{7,50}$/;

const ORGANIZATION_SECTION_FIELDS: ReadonlyArray<{
  field: string;
  sectionKind: OrganizationSectionKind;
  heading: string;
  maximum: number;
}> = [
  { field: "mission", sectionKind: "mission", heading: "Mission", maximum: 3000 },
  { field: "programs_services", sectionKind: "programs_services", heading: "Programs & services", maximum: 5000 },
  { field: "ways_to_help", sectionKind: "ways_to_help", heading: "Ways to help", maximum: 3000 },
  { field: "eligibility", sectionKind: "eligibility", heading: "Who can participate", maximum: 2000 },
  { field: "hours", sectionKind: "hours", heading: "Hours & availability", maximum: 1000 },
];

interface OrganizationInput {
  name: string;
  description: string;
  details: string;
  website: string;
  submitterEmail: string;
  submitterPhone: string;
  publicEmail: string;
  publicPhone: string;
  newLocation: string;
  locationIds: string[];
  categoryIds: string[];
  imageAlt: string;
  publicContacts: OrganizationPublicContactInput[];
  sections: OrganizationSectionInput[];
}

interface OrganizationPublicContactInput {
  contactType: OrganizationContactType;
  label: string;
  value: string;
  normalizedValue: string;
  sortOrder: number;
  isPrimary: boolean;
}

interface OrganizationSectionInput {
  sectionKind: OrganizationSectionKind;
  heading: string;
  bodyText: string;
  sortOrder: number;
}

interface EventInput {
  name: string;
  description: string;
  details: string;
  startAt: string;
  endAt: string;
  venueName: string;
  locationId: string;
  newLocation: string;
  website: string;
  submitterEmail: string;
  submitterPhone: string;
  publicEmail: string;
  publicPhone: string;
  imageAlt: string;
  organizationIds: string[];
}

function clean(value: string | undefined, maximum: number): string {
  return (value ?? "").trim().slice(0, maximum);
}

function loggedFieldName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "unknown";
}

function unique(values: string[] | undefined, maximum: number): string[] {
  return [...new Set((values ?? []).map((value) => clean(value, maximum)).filter(Boolean))];
}

function addFieldError(errors: Record<string, string[]>, field: string, message: string): void {
  errors[field] ??= [];
  if (!errors[field].includes(message)) errors[field].push(message);
}

function normalizedPhone(value: string): string {
  return value.replace(/\D/g, "");
}

function organizationPublicContacts(
  input: MultipartInput,
  publicEmail: string,
  publicPhone: string,
  errors: Record<string, string[]>,
): OrganizationPublicContactInput[] {
  const contacts: OrganizationPublicContactInput[] = [];
  const seen = new Set<string>();
  const primaryTypes = new Set<OrganizationContactType>();

  const pushContact = (
    contactType: OrganizationContactType,
    label: string,
    value: string,
    normalizedValue: string,
  ): void => {
    const key = `${contactType}:${normalizedValue}`;
    if (seen.has(key)) {
      addFieldError(errors, "contact_value", "Remove duplicate public contact details.");
      return;
    }
    seen.add(key);
    const isPrimary = !primaryTypes.has(contactType);
    primaryTypes.add(contactType);
    contacts.push({
      contactType,
      label,
      value,
      normalizedValue,
      sortOrder: contacts.length,
      isPrimary,
    });
  };

  if (publicEmail) pushContact("email", "General inquiries", publicEmail, publicEmail.toLowerCase());
  if (publicPhone) pushContact("phone", "General inquiries", publicPhone, normalizedPhone(publicPhone));

  const types = input.lists.contact_type ?? [];
  const labels = input.lists.contact_label ?? [];
  const values = input.lists.contact_value ?? [];
  const rowCount = Math.max(types.length, labels.length, values.length);
  if (rowCount > 10) {
    addFieldError(errors, "contact_value", "Add no more than 10 additional public contacts.");
  }
  for (let index = 0; index < Math.min(rowCount, 10); index += 1) {
    const rawType = clean(types[index], 20);
    const label = clean(labels[index], 80);
    const value = clean(values[index], 254);
    if (!rawType && !label && !value) continue;
    if (rawType !== "email" && rawType !== "phone") {
      addFieldError(errors, "contact_type", "Choose email or phone for every additional contact.");
      continue;
    }
    if (!label) addFieldError(errors, "contact_label", "Label every additional contact, for example Volunteer team.");
    if (!value) {
      addFieldError(errors, "contact_value", "Enter the public email address or phone number.");
      continue;
    }
    if (rawType === "email" && !EMAIL_PATTERN.test(value)) {
      addFieldError(errors, "contact_value", "Enter a valid public email address.");
      continue;
    }
    if (rawType === "phone" && !PHONE_PATTERN.test(value)) {
      addFieldError(errors, "contact_value", "Enter a valid public phone number.");
      continue;
    }
    if (!label) continue;
    pushContact(
      rawType,
      label,
      rawType === "email" ? value.toLowerCase() : value,
      rawType === "email" ? value.toLowerCase() : normalizedPhone(value),
    );
  }
  return contacts;
}

function organizationSections(input: MultipartInput): OrganizationSectionInput[] {
  return ORGANIZATION_SECTION_FIELDS.flatMap((section, sortOrder) => {
    const bodyText = clean(input.fields[section.field], section.maximum);
    return bodyText
      ? [{ sectionKind: section.sectionKind, heading: section.heading, bodyText, sortOrder }]
      : [];
  });
}

function validateEmail(value: string, field: string, errors: Record<string, string[]>): void {
  if (value && (value.length > 254 || !EMAIL_PATTERN.test(value))) {
    errors[field] = ["Enter a valid email address."];
  }
}

function validatePhone(value: string, field: string, errors: Record<string, string[]>): void {
  if (value && !PHONE_PATTERN.test(value)) errors[field] = ["Enter a valid phone number."];
}

function validateWebsite(value: string, errors: Record<string, string[]>): void {
  if (!value) return;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) throw new Error();
  } catch {
    errors.website = ["Enter a complete http or https URL."];
  }
}

function validateExpected(input: MultipartInput, allowed: Set<string>): void {
  const emptyImageField = input.lists.image ?? [];
  if (emptyImageField.some((value) => value.trim() !== "")) {
    throw new ApiError(400, "unexpected_attachment", "Only the optional listing image may be attached.", {
      image: ["Choose an image using the file control."],
    });
  }
  const unexpected = Object.keys(input.lists).find((key) => key !== "image" && !allowed.has(key));
  if (unexpected) {
    console.warn("Rejected unexpected multipart field", { field: loggedFieldName(unexpected) });
    throw new ApiError(400, "unexpected_form_field", "The submitted form contains an unexpected field.");
  }
  const unexpectedFile = Object.keys(input.files).find((key) => key !== "image");
  if (unexpectedFile) {
    const safeField = loggedFieldName(unexpectedFile);
    throw new ApiError(400, "unexpected_attachment", "Only the optional listing image may be attached.", {
      [safeField]: ["Only the optional listing image may be attached."],
    });
  }
}

function organizationInput(input: MultipartInput, memberEmail: string): OrganizationInput {
  validateExpected(input, new Set([
    "name", "description", "details", "website", "submitter_email", "submitter_phone",
    "public_email", "public_phone", "new_location", "location_ids", "category_ids",
    "contact_type", "contact_label", "contact_value", "mission", "programs_services",
    "ways_to_help", "eligibility", "hours",
    "image_alt", "idempotency_key", "cf-turnstile-response", "turnstile_token", "hp",
  ]));
  const value: OrganizationInput = {
    name: clean(input.fields.name, 200),
    description: clean(input.fields.description, 500),
    details: clean(input.fields.details, 5000),
    website: clean(input.fields.website, 500),
    submitterEmail: clean(memberEmail, 254).toLowerCase(),
    submitterPhone: clean(input.fields.submitter_phone, 50),
    publicEmail: clean(input.fields.public_email, 254).toLowerCase(),
    publicPhone: clean(input.fields.public_phone, 50),
    newLocation: clean(input.fields.new_location, 200),
    locationIds: unique(input.lists.location_ids, 100).slice(0, 20),
    categoryIds: unique(input.lists.category_ids, 80).slice(0, 20),
    imageAlt: clean(input.fields.image_alt, 300),
    publicContacts: [],
    sections: organizationSections(input),
  };
  const errors: Record<string, string[]> = {};
  if (value.name.length < 2) errors.name = ["Enter the organization name."];
  if (value.description.length < 10) errors.description = ["Describe the organization in at least 10 characters."];
  validateWebsite(value.website, errors);
  validateEmail(value.publicEmail, "public_email", errors);
  validatePhone(value.submitterPhone, "submitter_phone", errors);
  validatePhone(value.publicPhone, "public_phone", errors);
  value.publicContacts = organizationPublicContacts(input, value.publicEmail, value.publicPhone, errors);
  if (!value.locationIds.length && !value.newLocation) {
    errors.location_ids = ["Choose a location or enter another Bahamian location."];
  }
  if (!value.categoryIds.length) errors.category_ids = ["Choose at least one category."];
  if (input.files.image && value.imageAlt.length < 3) {
    errors.image_alt = ["Describe the image for people using assistive technology."];
  }
  if (Object.keys(errors).length) throw new ApiError(400, "validation_error", "Review the highlighted fields.", errors);
  return value;
}

function eventInput(input: MultipartInput, memberEmail: string): EventInput {
  validateExpected(input, new Set([
    "name", "description", "details", "start_at", "end_at", "venue_name", "location_id",
    "new_location", "website", "submitter_email", "submitter_phone", "public_email",
    "public_phone", "image_alt", "organization_ids", "idempotency_key",
    "cf-turnstile-response", "turnstile_token", "hp",
  ]));
  const value: EventInput = {
    name: clean(input.fields.name, 200),
    description: clean(input.fields.description, 500),
    details: clean(input.fields.details, 5000),
    startAt: clean(input.fields.start_at, 40),
    endAt: clean(input.fields.end_at, 40),
    venueName: clean(input.fields.venue_name, 200),
    locationId: clean(input.fields.location_id, 100),
    newLocation: clean(input.fields.new_location, 200),
    website: clean(input.fields.website, 500),
    submitterEmail: clean(memberEmail, 254).toLowerCase(),
    submitterPhone: clean(input.fields.submitter_phone, 50),
    publicEmail: clean(input.fields.public_email, 254).toLowerCase(),
    publicPhone: clean(input.fields.public_phone, 50),
    imageAlt: clean(input.fields.image_alt, 300),
    organizationIds: unique(input.lists.organization_ids, 100),
  };
  const errors: Record<string, string[]> = {};
  if (value.name.length < 2) errors.name = ["Enter the event name."];
  if (value.description.length < 10) errors.description = ["Describe the event in at least 10 characters."];
  if (value.venueName.length < 2) errors.venue_name = ["Enter the venue name."];
  const start = Date.parse(value.startAt);
  const end = value.endAt ? Date.parse(value.endAt) : Number.NaN;
  if (!Number.isFinite(start)) errors.start_at = ["Enter a valid event date and time."];
  if (value.endAt && !Number.isFinite(end)) errors.end_at = ["Enter a valid ending date and time."];
  if (Number.isFinite(start) && Number.isFinite(end) && end <= start) errors.end_at = ["The ending time must be after the starting time."];
  if (!value.locationId && !value.newLocation) errors.location_id = ["Choose a location or enter another Bahamian location."];
  if (value.organizationIds.length > 20) {
    errors.organization_ids = ["Choose no more than 20 related organizations."];
  }
  validateWebsite(value.website, errors);
  validateEmail(value.publicEmail, "public_email", errors);
  validatePhone(value.submitterPhone, "submitter_phone", errors);
  validatePhone(value.publicPhone, "public_phone", errors);
  if (input.files.image && value.imageAlt.length < 3) {
    errors.image_alt = ["Describe the image for people using assistive technology."];
  }
  if (Object.keys(errors).length) throw new ApiError(400, "validation_error", "Review the highlighted fields.", errors);
  return value;
}

async function validLocations(env: Env, ids: string[]): Promise<LocationRow[]> {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = await env.DB.prepare(`SELECT id, slug, city, island FROM locations WHERE is_active = 1 AND id IN (${placeholders})`)
    .bind(...ids)
    .all<LocationRow>();
  if (rows.results.length !== ids.length) {
    throw new ApiError(400, "validation_error", "Choose valid locations.", { location_ids: ["One or more selected locations are unavailable."] });
  }
  return rows.results;
}

async function validCategories(env: Env, ids: string[]): Promise<CategoryRow[]> {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = await env.DB.prepare(`SELECT id, slug, name FROM categories WHERE is_active = 1 AND id IN (${placeholders})`)
    .bind(...ids)
    .all<CategoryRow>();
  if (rows.results.length !== ids.length) {
    throw new ApiError(400, "validation_error", "Choose valid categories.", { category_ids: ["One or more selected categories are unavailable."] });
  }
  return rows.results;
}

async function validOrganizations(
  env: Env,
  ids: string[],
): Promise<Array<{ id: string; slug: string; name: string }>> {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT id, slug, name FROM organizations
     WHERE is_active = 1 AND id IN (${placeholders})
     ORDER BY name, id`,
  ).bind(...ids).all<{ id: string; slug: string; name: string }>();
  if (rows.results.length !== ids.length) {
    throw new ApiError(400, "validation_error", "Choose valid organizations.", {
      organization_ids: ["One or more selected organizations are unavailable."],
    });
  }
  return rows.results;
}

function genericSuccess(kind: "organization" | "event", id = ""): Response {
  return json({
    status: "success",
    submission_id: id || undefined,
    message: `Thank you. Your ${kind} has been received for private review.`,
  });
}

interface KeyedSubmissionRow {
  id: string;
  payload_fingerprint_hash: string | null;
}

function keyedReplayId(
  row: KeyedSubmissionRow | null,
  payloadFingerprintHash: string | null,
): string | null {
  if (!row) return null;
  if (
    payloadFingerprintHash &&
    row.payload_fingerprint_hash &&
    constantTimeEqual(payloadFingerprintHash, row.payload_fingerprint_hash)
  ) {
    return row.id;
  }
  throw new ApiError(
    409,
    "idempotency_conflict",
    "This idempotency key was already used for a different submission.",
  );
}

export async function submitOrganization(request: Request, env: Env): Promise<Response> {
  requireSameOrigin(request, env);
  const member = await requireMemberSession(request, env);
  await requireMemberCsrf(request, env, member);
  await enforceRateLimit(
    env,
    "organization-submission-member",
    member.memberId,
    positiveInteger(env.SUBMISSION_MEMBER_LIMIT, 5, 100),
  );
  await enforceRateLimit(env, "organization-submission-ip", clientIp(request), positiveInteger(env.SUBMISSION_IP_LIMIT, 5, 100));
  const input = await readMultipart(request);
  if (clean(input.fields.hp, 100)) return genericSuccess("organization");
  const data = organizationInput(input, member.email);
  await verifyTurnstile(input.fields, request, env, "submit_organization", env.TURNSTILE_ORGANIZATION_SECRET);
  await validLocations(env, data.locationIds);
  await validCategories(env, data.categoryIds);
  const image = await validateImage(input.files.image);
  const fingerprint = JSON.stringify({ ...data, image: image?.sha256 ?? "none" });
  const idempotency = await submissionIdempotency(
    env,
    `organization-member-${member.memberId}`,
    request.headers.get("Idempotency-Key") ?? input.fields.idempotency_key ?? "",
    fingerprint,
  );
  if (idempotency.keyHash) {
    const duplicate = await env.DB.prepare(
      `SELECT id, payload_fingerprint_hash
       FROM organization_submissions
       WHERE member_id = ? AND idempotency_key_hash = ?`,
    ).bind(member.memberId, idempotency.keyHash).first<KeyedSubmissionRow>();
    const replayId = keyedReplayId(duplicate, idempotency.payloadFingerprintHash);
    if (replayId) return genericSuccess("organization", replayId);
  } else if (idempotency.dedupeHash) {
    const duplicate = await env.DB.prepare(
      "SELECT id FROM organization_submissions WHERE idempotency_hash = ?",
    ).bind(idempotency.dedupeHash).first<{ id: string }>();
    if (duplicate) return genericSuccess("organization", duplicate.id);
  }

  const submissionId = randomId("orgsub");
  const now = new Date().toISOString();
  let prepared: PreparedPrivateImage | null = null;
  try {
    if (image) {
      prepared = await preparePrivateImage(env, {
        image,
        ownerType: "organization_submission",
        ownerId: submissionId,
        kind: "organization_logo",
        altText: data.imageAlt,
      });
    }
    const statements: D1PreparedStatement[] = [];
    if (prepared) statements.push(privateImageInsert(env, prepared));
    statements.push(
      env.DB.prepare(
        `INSERT INTO organization_submissions (
           id, member_id, status, name, description, details, website, submitter_email,
           submitter_phone, public_email, public_phone, new_location,
           image_asset_id, idempotency_hash, idempotency_key_hash,
           payload_fingerprint_hash, origin, ip_hash, created_at, updated_at
         ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        submissionId, member.memberId, data.name, data.description, data.details, data.website,
        data.submitterEmail, data.submitterPhone, data.publicEmail, data.publicPhone,
        data.newLocation, prepared?.assetId ?? null, idempotency.dedupeHash,
        idempotency.keyHash, idempotency.payloadFingerprintHash,
        new URL(request.url).origin, await requestIpHash(env, request), now, now,
      ),
    );
    for (const locationId of data.locationIds) {
      statements.push(env.DB.prepare("INSERT INTO organization_submission_locations (submission_id, location_id) VALUES (?, ?)").bind(submissionId, locationId));
    }
    for (const categoryId of data.categoryIds) {
      statements.push(env.DB.prepare("INSERT INTO organization_submission_categories (submission_id, category_id) VALUES (?, ?)").bind(submissionId, categoryId));
    }
    for (const contact of data.publicContacts) {
      statements.push(env.DB.prepare(
        `INSERT INTO organization_submission_public_contacts (
           id, submission_id, contact_type, label, value, normalized_value,
           sort_order, is_primary, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        randomId("orgsubcontact"), submissionId, contact.contactType, contact.label,
        contact.value, contact.normalizedValue, contact.sortOrder,
        contact.isPrimary ? 1 : 0, now,
      ));
    }
    for (const section of data.sections) {
      statements.push(env.DB.prepare(
        `INSERT INTO organization_submission_sections (
           id, submission_id, section_kind, heading, body_text, sort_order, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        randomId("orgsubsection"), submissionId, section.sectionKind,
        section.heading, section.bodyText, section.sortOrder, now,
      ));
    }
    statements.push(
      env.DB.prepare(
        `INSERT INTO moderation_events (id, submission_type, submission_id, action, created_at)
         VALUES (?, 'organization', ?, 'submitted', ?)`,
      ).bind(randomId("moderation"), submissionId, now),
      env.DB.prepare("UPDATE revision_state SET revision = revision + 1, updated_at = ? WHERE id = 1").bind(now),
    );
    if (data.submitterEmail) {
      statements.push(queueEmailStatement(env, {
        kind: "submission_receipt",
        recipientEmail: data.submitterEmail,
        subjectType: "organization_submission",
        subjectId: submissionId,
        idempotencyKey: `submission-receipt:organization:${submissionId}`,
        payload: { submission_type: "organization", submission_id: submissionId, name: data.name },
      }));
    }
    await env.DB.batch(statements);
  } catch (error) {
    await cleanupPrivateImage(env, prepared);
    if (idempotency.keyHash) {
      const raced = await env.DB.prepare(
        `SELECT id, payload_fingerprint_hash
         FROM organization_submissions
         WHERE member_id = ? AND idempotency_key_hash = ?`,
      ).bind(member.memberId, idempotency.keyHash).first<KeyedSubmissionRow>();
      const replayId = keyedReplayId(raced, idempotency.payloadFingerprintHash);
      if (replayId) return genericSuccess("organization", replayId);
    } else if (idempotency.dedupeHash) {
      const raced = await env.DB.prepare(
        "SELECT id FROM organization_submissions WHERE idempotency_hash = ?",
      ).bind(idempotency.dedupeHash).first<{ id: string }>();
      if (raced) return genericSuccess("organization", raced.id);
    }
    throw error;
  }
  return genericSuccess("organization", submissionId);
}

export async function submitEvent(request: Request, env: Env): Promise<Response> {
  requireSameOrigin(request, env);
  const member = await requireMemberSession(request, env);
  await requireMemberCsrf(request, env, member);
  await enforceRateLimit(
    env,
    "event-submission-member",
    member.memberId,
    positiveInteger(env.SUBMISSION_MEMBER_LIMIT, 5, 100),
  );
  await enforceRateLimit(env, "event-submission-ip", clientIp(request), positiveInteger(env.SUBMISSION_IP_LIMIT, 5, 100));
  const input = await readMultipart(request);
  if (clean(input.fields.hp, 100)) return genericSuccess("event");
  const data = eventInput(input, member.email);
  await verifyTurnstile(input.fields, request, env, "submit_event", env.TURNSTILE_EVENT_SECRET);
  if (data.locationId) await validLocations(env, [data.locationId]);
  await validOrganizations(env, data.organizationIds);
  const image = await validateImage(input.files.image);
  const normalizedStart = new Date(data.startAt).toISOString();
  const normalizedEnd = data.endAt ? new Date(data.endAt).toISOString() : "";
  const fingerprint = JSON.stringify({ ...data, startAt: normalizedStart, endAt: normalizedEnd, image: image?.sha256 ?? "none" });
  const idempotency = await submissionIdempotency(
    env,
    `event-member-${member.memberId}`,
    request.headers.get("Idempotency-Key") ?? input.fields.idempotency_key ?? "",
    fingerprint,
  );
  if (idempotency.keyHash) {
    const duplicate = await env.DB.prepare(
      `SELECT id, payload_fingerprint_hash
       FROM event_submissions
       WHERE member_id = ? AND idempotency_key_hash = ?`,
    ).bind(member.memberId, idempotency.keyHash).first<KeyedSubmissionRow>();
    const replayId = keyedReplayId(duplicate, idempotency.payloadFingerprintHash);
    if (replayId) return genericSuccess("event", replayId);
  } else if (idempotency.dedupeHash) {
    const duplicate = await env.DB.prepare(
      "SELECT id FROM event_submissions WHERE member_id = ? AND idempotency_hash = ?",
    ).bind(member.memberId, idempotency.dedupeHash).first<{ id: string }>();
    if (duplicate) return genericSuccess("event", duplicate.id);
  }

  const submissionId = randomId("eventsub");
  const now = new Date().toISOString();
  let prepared: PreparedPrivateImage | null = null;
  try {
    if (image) {
      prepared = await preparePrivateImage(env, {
        image,
        ownerType: "event_submission",
        ownerId: submissionId,
        kind: "event_image",
        altText: data.imageAlt,
      });
    }
    const statements: D1PreparedStatement[] = [];
    if (prepared) statements.push(privateImageInsert(env, prepared));
    statements.push(
      env.DB.prepare(
        `INSERT INTO event_submissions (
           id, member_id, status, name, description, details, start_at, end_at, timezone,
           venue_name, location_id, new_location, website, submitter_email,
           submitter_phone, public_email, public_phone, image_asset_id,
           idempotency_hash, idempotency_key_hash, payload_fingerprint_hash,
           origin, ip_hash, created_at, updated_at
         ) VALUES (
           ?, ?, 'pending', ?, ?, ?, ?, ?, 'America/Nassau',
           ?, ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?, ?, ?
         )`,
      ).bind(
        submissionId, member.memberId, data.name, data.description, data.details, normalizedStart,
        normalizedEnd || null, data.venueName, data.locationId || null, data.newLocation,
        data.website, data.submitterEmail, data.submitterPhone, data.publicEmail,
        data.publicPhone, prepared?.assetId ?? null, idempotency.dedupeHash,
        idempotency.keyHash, idempotency.payloadFingerprintHash,
        new URL(request.url).origin, await requestIpHash(env, request), now, now,
      ),
      env.DB.prepare(
        `INSERT INTO moderation_events (id, submission_type, submission_id, action, created_at)
         VALUES (?, 'event', ?, 'submitted', ?)`,
      ).bind(randomId("moderation"), submissionId, now),
      env.DB.prepare("UPDATE revision_state SET revision = revision + 1, updated_at = ? WHERE id = 1").bind(now),
    );
    statements.push(queueEmailStatement(env, {
      kind: "submission_receipt",
      recipientEmail: member.email,
      subjectType: "event_submission",
      subjectId: submissionId,
      idempotencyKey: `submission-receipt:event:${submissionId}`,
      payload: { submission_type: "event", submission_id: submissionId, name: data.name },
    }));
    data.organizationIds.forEach((organizationId, index) => {
      statements.push(
        env.DB.prepare(
          `INSERT INTO event_submission_organizations (
             submission_id, organization_id, role, is_primary, created_at
           ) VALUES (?, ?, 'organizer', ?, ?)`,
        ).bind(submissionId, organizationId, index === 0 ? 1 : 0, now),
      );
    });
    await env.DB.batch(statements);
  } catch (error) {
    await cleanupPrivateImage(env, prepared);
    if (idempotency.keyHash) {
      const raced = await env.DB.prepare(
        `SELECT id, payload_fingerprint_hash
         FROM event_submissions
         WHERE member_id = ? AND idempotency_key_hash = ?`,
      ).bind(member.memberId, idempotency.keyHash).first<KeyedSubmissionRow>();
      const replayId = keyedReplayId(raced, idempotency.payloadFingerprintHash);
      if (replayId) return genericSuccess("event", replayId);
    } else if (idempotency.dedupeHash) {
      const raced = await env.DB.prepare(
        "SELECT id FROM event_submissions WHERE member_id = ? AND idempotency_hash = ?",
      ).bind(member.memberId, idempotency.dedupeHash).first<{ id: string }>();
      if (raced) return genericSuccess("event", raced.id);
    }
    throw error;
  }
  return genericSuccess("event", submissionId);
}

export async function taxonomy(env: Env): Promise<Response> {
  const [locations, categories, organizations] = await Promise.all([
    env.DB.prepare("SELECT id, slug, city, island FROM locations WHERE is_active = 1 ORDER BY island, city").all<LocationRow>(),
    env.DB.prepare("SELECT id, slug, name FROM categories WHERE is_active = 1 ORDER BY name").all<CategoryRow>(),
    env.DB.prepare("SELECT id, slug, name FROM organizations WHERE is_active = 1 ORDER BY name, id LIMIT 500")
      .all<{ id: string; slug: string; name: string }>(),
  ]);
  return json({
    locations: locations.results,
    categories: categories.results,
    organizations: organizations.results,
  }, 200, {
    "Cache-Control": "public, max-age=300",
  });
}
