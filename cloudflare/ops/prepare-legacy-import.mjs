#!/usr/bin/env node

import { createHash, createHmac, randomUUID } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";

function readInput() {
  if (process.stdin.isTTY) throw new Error("Pass a JSON configuration object on standard input.");
  const value = JSON.parse(readFileSync(0, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Input must be a JSON object.");
  return value;
}

function sql(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function slug(value, maximum = 100) {
  return String(value || "listing")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maximum)
    .replace(/-+$/g, "") || "listing";
}

function firstContact(record, type) {
  return (record.contacts || []).find((contact) => contact.type === type && contact.value)?.value || "";
}

function unsubscribeHash(secret, email) {
  const hex = createHmac("sha256", secret)
    .update(`serve-the-cays/unsubscribe/v1:${email}`)
    .digest("hex");
  const token = Buffer.from(hex, "hex").toString("base64url");
  return createHash("sha256").update(token).digest("hex");
}

try {
  const input = readInput();
  const bundlePath = String(input.bundle || "");
  const outputPath = String(input.output || "");
  if (!bundlePath || !outputPath) throw new Error("bundle and output paths are required.");
  const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
  if (bundle.format !== "serve-the-cays-legacy-export-v1") throw new Error("Unsupported legacy bundle format.");
  const confirmedContacts = input.confirm_legacy_contacts_public === true;
  const unsubscribeSecret = process.env.UNSUBSCRIBE_SECRET || "";
  const now = new Date().toISOString();
  const statements = [
    "PRAGMA foreign_keys = ON;",
    "",
    "-- Restricted legacy import. Review this SQL and its issue report before",
    "-- applying it to preview. It intentionally excludes all media bytes.",
  ];
  const issues = [];
  const locationTargets = new Map([
    ["nassau|new providence", "loc_nassau"],
    ["freeport|grand bahama", "loc_freeport"],
    ["marsh harbour|abaco", "loc_marsh_harbour"],
    ["george town|exuma", "loc_george_town"],
    ["governor's harbour|eleuthera", "loc_governors_harbour"],
    ["alice town|bimini", "loc_alice_town"],
    ["clarence town|long island", "loc_clarence_town"],
    ["andros town|andros", "loc_andros_town"],
    ["dunmore town|harbour island", "loc_dunmore_town"],
    ["matthew town|inagua", "loc_matthew_town"],
  ]);
  const legacyLocations = new Map((bundle.locations || []).map((location) => [
    String(location.id),
    locationTargets.get(`${String(location.city).toLowerCase()}|${String(location.island).toLowerCase()}`) || null,
  ]));
  const categoryTargets = new Map((bundle.categories || []).map((category) => [String(category.id), `cat_${slug(category.slug, 60).replaceAll("-", "_")}`]));

  for (const organization of bundle.organizations || []) {
    if (!organization.is_approved) {
      issues.push({ type: "organization", id: organization.id, issue: "pending legacy record requires manual private-contact review" });
      continue;
    }
    const id = `legacy_org_${organization.id}`;
    const publicEmail = confirmedContacts ? firstContact(organization, "email") : "";
    const publicPhone = confirmedContacts ? firstContact(organization, "phone") : "";
    statements.push(
      `INSERT OR IGNORE INTO organizations (id, slug, name, description, details, website, public_email, public_phone, custom_location, published_at, updated_at) VALUES (${sql(id)}, ${sql(slug(organization.slug || organization.name))}, ${sql(organization.name)}, ${sql(organization.description)}, ${sql(organization.details || "")}, ${sql(organization.website || "")}, ${sql(publicEmail)}, ${sql(publicPhone)}, '', ${sql(now)}, ${sql(now)});`,
      `INSERT OR IGNORE INTO migration_map (source_system, source_table, source_id, target_table, target_id, imported_at) VALUES ('legacy_flask', 'organization', ${sql(String(organization.id))}, 'organizations', ${sql(id)}, ${sql(now)});`,
    );
    for (const legacyLocationId of organization.location_ids || []) {
      const target = legacyLocations.get(String(legacyLocationId));
      if (target) statements.push(`INSERT OR IGNORE INTO organization_locations (organization_id, location_id) VALUES (${sql(id)}, ${sql(target)});`);
      else issues.push({ type: "organization", id: organization.id, issue: `unmapped location ${legacyLocationId}` });
    }
    for (const legacyCategoryId of organization.category_ids || []) {
      const target = categoryTargets.get(String(legacyCategoryId));
      if (target) statements.push(`INSERT OR IGNORE INTO organization_categories (organization_id, category_id) SELECT ${sql(id)}, id FROM categories WHERE id = ${sql(target)} OR slug = ${sql(slug((bundle.categories || []).find((item) => String(item.id) === String(legacyCategoryId))?.slug || ""))};`);
    }
    if (organization.logo_file_id || (organization.image_file_ids || []).length) issues.push({ type: "organization", id: organization.id, issue: "legacy media requires private download, validation, and Cloudflare Images sanitization" });
  }

  for (const event of bundle.events || []) {
    if (!event.is_approved) {
      issues.push({ type: "event", id: event.id, issue: "pending legacy record requires manual private-contact review" });
      continue;
    }
    const parsed = new Date(event.date_raw);
    if (Number.isNaN(parsed.getTime())) {
      issues.push({ type: "event", id: event.id, issue: `unstructured date requires manual conversion: ${String(event.date_raw).slice(0, 80)}` });
      continue;
    }
    const id = Number(event.id);
    if (!Number.isInteger(id) || id < 1) {
      issues.push({ type: "event", id: event.id, issue: "invalid numeric event id" });
      continue;
    }
    const locationId = legacyLocations.get(String(event.location_id)) || null;
    const legacyLocation = (bundle.locations || []).find((item) => String(item.id) === String(event.location_id));
    const locationDisplay = legacyLocation ? `${legacyLocation.city}, ${legacyLocation.island}` : "";
    const publicEmail = confirmedContacts ? firstContact(event, "email") : "";
    const publicPhone = confirmedContacts ? firstContact(event, "phone") : "";
    statements.push(
      `INSERT OR IGNORE INTO events (id, slug, name, description, details, start_at, timezone, venue_name, location_id, location_display, public_email, public_phone, published_at, updated_at) VALUES (${id}, ${sql(slug(event.name, 120))}, ${sql(event.name)}, ${sql(event.description)}, ${sql(event.details || "")}, ${sql(parsed.toISOString())}, 'America/Nassau', ${sql(event.venue_name)}, ${sql(locationId)}, ${sql(locationDisplay)}, ${sql(publicEmail)}, ${sql(publicPhone)}, ${sql(now)}, ${sql(now)});`,
      `INSERT OR IGNORE INTO migration_map (source_system, source_table, source_id, target_table, target_id, imported_at) VALUES ('legacy_flask', 'event', ${sql(String(event.id))}, 'events', ${sql(String(id))}, ${sql(now)});`,
    );
    if (event.logo_file_id || (event.image_file_ids || []).length) issues.push({ type: "event", id: event.id, issue: "legacy media requires private download, validation, and Cloudflare Images sanitization" });
  }

  for (const subscriber of bundle.subscribers || []) {
    const email = String(subscriber.email || "").trim().toLowerCase();
    if (!unsubscribeSecret) {
      issues.push({ type: "subscriber", id: subscriber.id, issue: "UNSUBSCRIBE_SECRET missing; subscriber not imported" });
      continue;
    }
    const id = `legacy_subscriber_${subscriber.id}`;
    const created = subscriber.subscribed_at || now;
    statements.push(
      `INSERT OR IGNORE INTO subscribers (id, email, status, consent_at, unsubscribe_token_hash, created_at, updated_at) VALUES (${sql(id)}, ${sql(email)}, 'active', ${sql(created)}, ${sql(unsubscribeHash(unsubscribeSecret, email))}, ${sql(created)}, ${sql(now)});`,
      `INSERT OR IGNORE INTO migration_map (source_system, source_table, source_id, target_table, target_id, imported_at) VALUES ('legacy_flask', 'subscriber', ${sql(String(subscriber.id))}, 'subscribers', ${sql(id)}, ${sql(now)});`,
    );
  }
  statements.push("");
  writeFileSync(outputPath, `${statements.join("\n")}\n`, { encoding: "utf8", mode: 0o600, flag: input.force ? "w" : "wx" });
  chmodSync(outputPath, 0o600);
  process.stderr.write(`${JSON.stringify({ prepared: true, issues, contacts_published: confirmedContacts }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Legacy import preparation failed."}\n`);
  process.exitCode = 1;
}
