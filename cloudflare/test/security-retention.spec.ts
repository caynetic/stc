import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import worker from "../src/index";
import { purgeExpiredOriginals } from "../src/images";
import { anonymizeExpiredPrivateSubmissions } from "../src/retention";
import { purgeExpiredRateLimits, sha256Hex } from "../src/security";
import type { Env } from "../src/types";
import { seedAdmin, signInAdmin } from "./admin-auth";

const baseEnv = env as unknown as Env;
const OLD = "2000-01-01T00:00:00.000Z";
const APP_ORIGIN = "https://servethecays.test";

function call(request: Request, runtimeEnv: Env = baseEnv): Promise<Response> {
  return worker.fetch(request, runtimeEnv);
}

function databaseWithReadBarrier(fragment: string, parties = 2): D1Database {
  let arrivals = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return new Proxy(baseEnv.DB, {
    get(target, property) {
      if (property !== "prepare") {
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        const prepared = target.prepare(sql);
        if (!sql.includes(fragment)) return prepared;
        return new Proxy(prepared, {
          get(statement, statementProperty) {
            if (statementProperty !== "bind") {
              const value = Reflect.get(statement, statementProperty);
              return typeof value === "function" ? value.bind(statement) : value;
            }
            return (...values: unknown[]) => {
              const bound = statement.bind(...values);
              return new Proxy(bound, {
                get(boundStatement, boundProperty) {
                  if (boundProperty === "first") {
                    return async () => {
                      const result = await boundStatement.first();
                      arrivals += 1;
                      if (arrivals === parties) release();
                      await ready;
                      return result;
                    };
                  }
                  const value = Reflect.get(boundStatement, boundProperty);
                  return typeof value === "function" ? value.bind(boundStatement) : value;
                },
              });
            };
          },
        });
      };
    },
  });
}

function jpegBytes(): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    0x00, 0x01, 0x00, 0x01,
    0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    0x00,
    0xff, 0xd9,
  ]);
}

function webpBytes(): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  new DataView(bytes.buffer).setUint32(4, 22, true);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x58], 12);
  new DataView(bytes.buffer).setUint32(16, 10, true);
  return bytes;
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function imagesBinding(): ImagesBinding {
  const output = webpBytes();
  const transformer = {
    transform() { return transformer; },
    draw() { return transformer; },
    async output() {
      return {
        response: () => new Response(arrayBuffer(output)),
        contentType: () => "image/webp",
        image: () => new Response(arrayBuffer(output)).body!,
      };
    },
  };
  return { input: () => transformer } as unknown as ImagesBinding;
}

async function adminSession(): Promise<{ cookie: string; csrf: string }> {
  await seedAdmin("retention_owner", "retention-owner@example.org", "owner");
  const auth = await signInAdmin("retention-owner@example.org", {}, "203.0.113.230");
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
      "CF-Connecting-IP": "203.0.113.230",
    },
    body: JSON.stringify(body),
  });
}

async function seedOldSubmission(imageAssetId: string | null = null): Promise<void> {
  await baseEnv.DB.prepare(
    `INSERT INTO organization_submissions (
       id, name, description, submitter_email, submitter_phone, image_asset_id,
       public_email, public_phone, idempotency_hash, idempotency_key_hash,
       payload_fingerprint_hash, origin, ip_hash, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    "submission_old",
    "Old community listing",
    "A sufficiently detailed old community submission.",
    "private@example.org",
    "+1 242 555 0100",
    imageAssetId,
    "public@example.org",
    "+1 242 555 0199",
    "a".repeat(64),
    "c".repeat(64),
    "d".repeat(64),
    "https://servethecays.com",
    "b".repeat(64),
    OLD,
    OLD,
  ).run();
}

async function seedMedia(input: {
  id: string;
  key: string;
  status: "quarantined" | "published" | "denied";
  ownerId?: string;
  derivativeKey?: string | null;
  publishedAt?: string | null;
  deniedAt?: string | null;
}): Promise<void> {
  await baseEnv.PRIVATE_UPLOADS.put(input.key, new Uint8Array([1]));
  await baseEnv.DB.prepare(
    `INSERT INTO media_assets (
       id, owner_type, owner_id, kind, status, alt_text, original_key,
       original_content_type, original_size_bytes, original_width,
       original_height, original_sha256, derivative_key,
       derivative_content_type, derivative_size_bytes, derivative_width,
       derivative_height, created_at, published_at, denied_at
     ) VALUES (?, 'organization_submission', ?, 'organization_logo', ?, ?, ?,
       'image/png', 1, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    input.id,
    input.ownerId ?? "submission_old",
    input.status,
    `${input.status} organization logo`,
    input.key,
    "0".repeat(64),
    input.derivativeKey ?? null,
    input.derivativeKey ? "image/webp" : null,
    input.derivativeKey ? 1 : null,
    input.derivativeKey ? 1 : null,
    input.derivativeKey ? 1 : null,
    OLD,
    input.publishedAt ?? null,
    input.deniedAt ?? null,
  ).run();
}

describe("scheduled private-data retention", () => {
  it("removes stale quarantined originals and detaches them from pending review", async () => {
    const key = "quarantine/organization_submission/submission_old/original";
    await seedMedia({ id: "media_old", key, status: "quarantined" });
    await seedOldSubmission("media_old");

    const count = await purgeExpiredOriginals({
      ...baseEnv,
      PRIVATE_SUBMISSION_RETENTION_DAYS: "90",
    });

    expect(count).toBe(1);
    expect(await baseEnv.PRIVATE_UPLOADS.get(key)).toBeNull();
    expect(await baseEnv.DB.prepare(
      "SELECT image_asset_id FROM organization_submissions WHERE id = 'submission_old'",
    ).first()).toMatchObject({ image_asset_id: null });
    expect(await baseEnv.DB.prepare(
      "SELECT status, original_deleted_at, deleted_at FROM media_assets WHERE id = 'media_old'",
    ).first()).toMatchObject({ status: "deleted" });
  });

  it("preserves an image reference if publication wins before the retention claim", async () => {
    const key = "quarantine/organization_submission/submission_old/race";
    await seedMedia({ id: "media_old", key, status: "quarantined" });
    await seedOldSubmission("media_old");
    let raced = false;
    const racingDatabase = new Proxy(baseEnv.DB, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (!raced) {
              raced = true;
              await baseEnv.DB.prepare(
                `UPDATE media_assets SET status = 'published', derivative_key = ?,
                   derivative_content_type = 'image/webp', derivative_size_bytes = 1,
                   derivative_width = 1, derivative_height = 1, published_at = ?
                 WHERE id = 'media_old' AND status = 'quarantined'`,
              ).bind("published/media_old/race.webp", new Date().toISOString()).run();
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await purgeExpiredOriginals({
      ...baseEnv,
      DB: racingDatabase,
      PRIVATE_SUBMISSION_RETENTION_DAYS: "90",
    });

    expect(await baseEnv.PRIVATE_UPLOADS.get(key)).not.toBeNull();
    expect(await baseEnv.DB.prepare(
      "SELECT image_asset_id FROM organization_submissions WHERE id = 'submission_old'",
    ).first()).toEqual({ image_asset_id: "media_old" });
    expect(await baseEnv.DB.prepare(
      "SELECT status, original_deleted_at FROM media_assets WHERE id = 'media_old'",
    ).first()).toMatchObject({ status: "published", original_deleted_at: null });
  });

  it("still purges old published and denied originals on the 30-day schedule", async () => {
    await seedMedia({
      id: "media_published",
      key: "quarantine/published/original",
      status: "published",
      derivativeKey: "published/media_published/image.webp",
      publishedAt: OLD,
    });
    await seedMedia({
      id: "media_denied",
      key: "quarantine/denied/original",
      status: "denied",
      deniedAt: OLD,
    });

    const count = await purgeExpiredOriginals({ ...baseEnv, PRIVATE_RETENTION_DAYS: "30" });

    expect(count).toBe(2);
    expect(await baseEnv.DB.prepare(
      "SELECT status, original_deleted_at FROM media_assets ORDER BY id",
    ).all()).toMatchObject({
      results: [
        { status: "denied", original_deleted_at: expect.any(String) },
        { status: "published", original_deleted_at: expect.any(String) },
      ],
    });
  });

  it("detaches a purged denied image on restore and can approve without it", async () => {
    const key = "quarantine/denied/restored-after-purge";
    await seedMedia({ id: "media_old", key, status: "denied", deniedAt: OLD });
    await seedOldSubmission("media_old");
    await baseEnv.DB.prepare(
      `UPDATE organization_submissions SET status = 'denied', reviewed_at = ?, updated_at = ?
       WHERE id = 'submission_old'`,
    ).bind(OLD, OLD).run();

    expect(await purgeExpiredOriginals(
      { ...baseEnv, PRIVATE_RETENTION_DAYS: "30" },
      new Date("2026-08-01T00:00:00.000Z"),
    )).toBe(1);
    expect(await baseEnv.PRIVATE_UPLOADS.get(key)).toBeNull();

    const auth = await adminSession();
    const restored = await call(adminPost(
      "/api/admin/submissions/organization/submission_old/restore",
      auth,
    ));
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ status: "success", image_detached: true });
    expect(await baseEnv.DB.prepare(
      "SELECT status, image_asset_id FROM organization_submissions WHERE id = 'submission_old'",
    ).first()).toEqual({ status: "pending", image_asset_id: null });
    expect(await baseEnv.DB.prepare(
      "SELECT status, original_deleted_at FROM media_assets WHERE id = 'media_old'",
    ).first()).toMatchObject({ status: "denied", original_deleted_at: expect.any(String) });

    const approved = await call(adminPost(
      "/api/admin/submissions/organization/submission_old/approve",
      auth,
    ));
    expect(approved.status).toBe(200);
    expect(await baseEnv.DB.prepare(
      "SELECT image_asset_id FROM organizations WHERE source_submission_id = 'submission_old'",
    ).first()).toEqual({ image_asset_id: null });
  });

  it("claims a denied original before R2 deletion so a racing restore detaches it", async () => {
    const key = "quarantine/denied/restore-during-delete";
    await seedMedia({ id: "media_old", key, status: "denied", deniedAt: OLD });
    await seedOldSubmission("media_old");
    await baseEnv.DB.prepare(
      `UPDATE organization_submissions SET status = 'denied', reviewed_at = ?, updated_at = ?
       WHERE id = 'submission_old'`,
    ).bind(OLD, OLD).run();
    const auth = await adminSession();
    let restoreResponse: Response | undefined;
    const racingBucket = {
      delete: async (objectKey: string) => {
        await baseEnv.PRIVATE_UPLOADS.delete(objectKey);
        restoreResponse = await call(adminPost(
          "/api/admin/submissions/organization/submission_old/restore",
          auth,
        ));
      },
    } as unknown as R2Bucket;

    expect(await purgeExpiredOriginals({
      ...baseEnv,
      PRIVATE_UPLOADS: racingBucket,
      PRIVATE_RETENTION_DAYS: "30",
    }, new Date("2026-08-01T00:00:00.000Z"))).toBe(1);

    expect(restoreResponse?.status).toBe(200);
    expect(await restoreResponse!.json()).toMatchObject({ status: "success", image_detached: true });
    expect(await baseEnv.PRIVATE_UPLOADS.get(key)).toBeNull();
    expect(await baseEnv.DB.prepare(
      "SELECT status, image_asset_id FROM organization_submissions WHERE id = 'submission_old'",
    ).first()).toEqual({ status: "pending", image_asset_id: null });
    expect(await baseEnv.DB.prepare(
      "SELECT status, original_deleted_at FROM media_assets WHERE id = 'media_old'",
    ).first()).toMatchObject({ status: "denied", original_deleted_at: expect.any(String) });
  });

  it("skips denied-original deletion when restore wins before the retention claim", async () => {
    const key = "quarantine/denied/restore-before-claim";
    await seedMedia({ id: "media_old", key, status: "denied", deniedAt: OLD });
    await seedOldSubmission("media_old");
    const original = jpegBytes();
    await baseEnv.PRIVATE_UPLOADS.put(key, original);
    await baseEnv.DB.batch([
      baseEnv.DB.prepare(
        `UPDATE media_assets SET original_content_type = 'image/jpeg',
           original_size_bytes = ?, original_width = 1, original_height = 1,
           original_sha256 = ? WHERE id = 'media_old'`,
      ).bind(original.byteLength, await sha256Hex(arrayBuffer(original))),
      baseEnv.DB.prepare(
        `UPDATE organization_submissions SET status = 'denied', reviewed_at = ?, updated_at = ?
         WHERE id = 'submission_old'`,
      ).bind(OLD, OLD),
    ]);
    const auth = await adminSession();
    let restoreResponse: Response | undefined;
    let raced = false;
    const racingDatabase = new Proxy(baseEnv.DB, {
      get(target, property) {
        if (property !== "prepare") {
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (sql: string) => {
          const prepared = target.prepare(sql);
          if (!sql.includes("UPDATE media_assets SET original_deleted_at = ?")) return prepared;
          return new Proxy(prepared, {
            get(statement, statementProperty) {
              if (statementProperty !== "bind") {
                const value = Reflect.get(statement, statementProperty);
                return typeof value === "function" ? value.bind(statement) : value;
              }
              return (...values: unknown[]) => {
                const bound = statement.bind(...values);
                return new Proxy(bound, {
                  get(boundStatement, boundProperty) {
                    if (boundProperty === "run") {
                      return async () => {
                        if (!raced) {
                          raced = true;
                          restoreResponse = await call(adminPost(
                            "/api/admin/submissions/organization/submission_old/restore",
                            auth,
                          ));
                        }
                        return boundStatement.run();
                      };
                    }
                    const value = Reflect.get(boundStatement, boundProperty);
                    return typeof value === "function" ? value.bind(boundStatement) : value;
                  },
                });
              };
            },
          });
        };
      },
    });

    expect(await purgeExpiredOriginals({
      ...baseEnv,
      DB: racingDatabase,
      PRIVATE_RETENTION_DAYS: "30",
    }, new Date("2026-08-01T00:00:00.000Z"))).toBe(0);

    expect(restoreResponse?.status).toBe(200);
    expect(await restoreResponse!.json()).toMatchObject({ status: "success", image_detached: false });
    expect(await baseEnv.PRIVATE_UPLOADS.get(key)).not.toBeNull();
    expect(await baseEnv.DB.prepare(
      "SELECT status, image_asset_id FROM organization_submissions WHERE id = 'submission_old'",
    ).first()).toEqual({ status: "pending", image_asset_id: "media_old" });
    expect(await baseEnv.DB.prepare(
      "SELECT status, original_deleted_at FROM media_assets WHERE id = 'media_old'",
    ).first()).toEqual({ status: "quarantined", original_deleted_at: null });

    const approved = await call(adminPost(
      "/api/admin/submissions/organization/submission_old/approve",
      auth,
    ), { ...baseEnv, IMAGES: imagesBinding() });
    expect(approved.status).toBe(200);
    expect(await baseEnv.DB.prepare(
      `SELECT o.image_asset_id, m.status AS media_status
       FROM organizations o JOIN media_assets m ON m.id = o.image_asset_id
       WHERE o.source_submission_id = 'submission_old'`,
    ).first()).toEqual({ image_asset_id: "media_old", media_status: "published" });
  });

  it("rolls an admin mutation back when its atomic audit insert fails", async () => {
    await seedOldSubmission();
    const auth = await adminSession();
    await baseEnv.DB.prepare("DROP TRIGGER IF EXISTS test_fail_admin_audit").run();
    await baseEnv.DB.prepare(
      `CREATE TRIGGER test_fail_admin_audit
       BEFORE INSERT ON audit_events
       WHEN NEW.event_type = 'moderation.denied'
       BEGIN
         SELECT RAISE(ABORT, 'simulated audit failure');
       END`,
    ).run();
    let response: Response;
    try {
      response = await call(adminPost(
        "/api/admin/submissions/organization/submission_old/deny",
        auth,
        { reason: "Unable to verify this listing." },
      ));
    } finally {
      await baseEnv.DB.prepare("DROP TRIGGER IF EXISTS test_fail_admin_audit").run();
    }

    expect(response!.status).toBe(500);
    expect(await baseEnv.DB.prepare(
      "SELECT status FROM organization_submissions WHERE id = 'submission_old'",
    ).first()).toEqual({ status: "pending" });
    expect((await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM moderation_events WHERE submission_id = 'submission_old'",
    ).first<{ count: number }>())?.count).toBe(0);
    expect((await baseEnv.DB.prepare(
      `SELECT COUNT(*) AS count FROM email_jobs
       WHERE json_extract(payload_json, '$.subject_id') = 'submission_old'`,
    ).first<{ count: number }>())?.count).toBe(0);
  });

  it("commits side effects only for the winning concurrent denial", async () => {
    await seedOldSubmission();
    const now = new Date().toISOString();
    await baseEnv.DB.batch([
      baseEnv.DB.prepare(
        `INSERT INTO members (id, email, created_at, updated_at)
         VALUES ('member_race', 'member-race@example.org', ?, ?)`,
      ).bind(now, now),
      baseEnv.DB.prepare(
        "UPDATE organization_submissions SET member_id = 'member_race' WHERE id = 'submission_old'",
      ),
    ]);
    const auth = await adminSession();
    const runtimeEnv = {
      ...baseEnv,
      DB: databaseWithReadBarrier("SELECT submission.status"),
    };
    const responses = await Promise.all([
      call(adminPost(
        "/api/admin/submissions/organization/submission_old/deny",
        auth,
        { reason: "Unable to verify the first review." },
      ), runtimeEnv),
      call(adminPost(
        "/api/admin/submissions/organization/submission_old/deny",
        auth,
        { reason: "Unable to verify the concurrent review." },
      ), runtimeEnv),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const payloads = await Promise.all(responses.map((response) => response.json<Record<string, unknown>>()));
    expect(payloads.filter((payload) => payload.duplicate === true)).toHaveLength(1);
    expect(await baseEnv.DB.prepare(
      "SELECT status FROM organization_submissions WHERE id = 'submission_old'",
    ).first()).toEqual({ status: "denied" });
    expect(await baseEnv.DB.prepare(
      `SELECT COUNT(*) AS count FROM moderation_events
       WHERE submission_type = 'organization' AND submission_id = 'submission_old' AND action = 'denied'`,
    ).first()).toEqual({ count: 1 });
    expect(await baseEnv.DB.prepare(
      `SELECT COUNT(*) AS count FROM audit_events
       WHERE subject_id = 'submission_old' AND event_type = 'moderation.denied'`,
    ).first()).toEqual({ count: 1 });
    expect(await baseEnv.DB.prepare(
      `SELECT COUNT(*) AS count FROM email_jobs
       WHERE kind = 'submission_denied' AND recipient_email = 'member-race@example.org'`,
    ).first()).toEqual({ count: 1 });
    expect(await baseEnv.DB.prepare(
      "SELECT revision FROM revision_state WHERE id = 1",
    ).first()).toEqual({ revision: 1 });
  });

  it("allows a legitimate deny, restore, deny cycle with distinct side effects", async () => {
    await seedOldSubmission();
    const now = new Date().toISOString();
    await baseEnv.DB.batch([
      baseEnv.DB.prepare(
        `INSERT INTO members (id, email, created_at, updated_at)
         VALUES ('member_cycle', 'member-cycle@example.org', ?, ?)`,
      ).bind(now, now),
      baseEnv.DB.prepare(
        "UPDATE organization_submissions SET member_id = 'member_cycle' WHERE id = 'submission_old'",
      ),
    ]);
    const auth = await adminSession();
    for (const request of [
      adminPost(
        "/api/admin/submissions/organization/submission_old/deny",
        auth,
        { reason: "First review could not verify the listing." },
      ),
      adminPost(
        "/api/admin/submissions/organization/submission_old/restore",
        auth,
      ),
      adminPost(
        "/api/admin/submissions/organization/submission_old/deny",
        auth,
        { reason: "Second review still could not verify the listing." },
      ),
    ]) {
      expect((await call(request)).status).toBe(200);
    }

    expect(await baseEnv.DB.prepare(
      `SELECT action, COUNT(*) AS count FROM moderation_events
       WHERE submission_type = 'organization' AND submission_id = 'submission_old'
       GROUP BY action ORDER BY action`,
    ).all()).toMatchObject({
      results: [
        { action: "denied", count: 2 },
        { action: "restored", count: 1 },
      ],
    });
    expect(await baseEnv.DB.prepare(
      `SELECT COUNT(*) AS count FROM email_jobs
       WHERE kind = 'submission_denied' AND recipient_email = 'member-cycle@example.org'`,
    ).first()).toEqual({ count: 2 });
    expect(await baseEnv.DB.prepare(
      "SELECT revision FROM revision_state WHERE id = 1",
    ).first()).toEqual({ revision: 3 });
  });

  it("sends moderation decisions only to a linked member's verified email", async () => {
    const now = new Date().toISOString();
    await baseEnv.DB.batch([
      baseEnv.DB.prepare(
        `INSERT INTO members (id, email, created_at, updated_at)
         VALUES ('member_decision', 'verified-member@example.org', ?, ?)`,
      ).bind(now, now),
      baseEnv.DB.prepare(
        `INSERT INTO event_submissions (
           id, name, description, start_at, venue_name, submitter_email,
           created_at, updated_at
         ) VALUES ('event_anonymous', 'Anonymous event',
           'An event submitted with an unverified visitor address.',
           '2026-12-01T15:00:00.000Z', 'Community Centre',
           'unverified-victim@example.net', ?, ?)`,
      ).bind(now, now),
      baseEnv.DB.prepare(
        `INSERT INTO event_submissions (
           id, member_id, name, description, start_at, venue_name,
           submitter_email, created_at, updated_at
         ) VALUES ('event_member', 'member_decision', 'Member event',
           'An event submitted by a member with a verified account address.',
           '2026-12-02T15:00:00.000Z', 'Community Centre',
           'replacement-victim@example.net', ?, ?)`,
      ).bind(now, now),
      baseEnv.DB.prepare(
        `INSERT INTO event_submissions (
           id, name, description, start_at, venue_name, submitter_email,
           created_at, updated_at
         ) VALUES ('event_anonymous_approval', 'Anonymous approved event',
           'An approved event submitted with an unverified visitor address.',
           '2026-12-03T15:00:00.000Z', 'Community Centre',
           'second-unverified-victim@example.net', ?, ?)`,
      ).bind(now, now),
      baseEnv.DB.prepare(
        `INSERT INTO event_submissions (
           id, member_id, name, description, start_at, venue_name,
           submitter_email, created_at, updated_at
         ) VALUES ('event_member_approval', 'member_decision', 'Member approved event',
           'An approved event submitted by a member with a verified account.',
           '2026-12-04T15:00:00.000Z', 'Community Centre',
           'third-unverified-victim@example.net', ?, ?)`,
      ).bind(now, now),
    ]);
    const auth = await adminSession();

    for (const id of ["event_anonymous", "event_member"]) {
      const response = await call(adminPost(
        `/api/admin/submissions/event/${id}/deny`,
        auth,
        { reason: "The event details could not be verified." },
      ));
      expect(response.status).toBe(200);
    }
    for (const id of ["event_anonymous_approval", "event_member_approval"]) {
      const response = await call(adminPost(
        `/api/admin/submissions/event/${id}/approve`,
        auth,
      ));
      expect(response.status).toBe(200);
    }

    const decisions = await baseEnv.DB.prepare(
      `SELECT kind, recipient_email FROM email_jobs
       WHERE kind IN ('submission_approved', 'submission_denied')
       ORDER BY kind, recipient_email`,
    ).all<{ kind: string; recipient_email: string }>();
    expect(decisions.results).toEqual([
      { kind: "submission_approved", recipient_email: "verified-member@example.org" },
      { kind: "submission_denied", recipient_email: "verified-member@example.org" },
    ]);
  });

  it("anonymizes stale private submitter identifiers while preserving the review row", async () => {
    await seedOldSubmission();
    await baseEnv.DB.batch([
      baseEnv.DB.prepare(
        `UPDATE organization_submissions SET
           status = 'approved', published_organization_id = 'org_retained',
           reviewed_at = ?, updated_at = ?
         WHERE id = 'submission_old'`,
      ).bind(OLD, OLD),
      baseEnv.DB.prepare(
        `INSERT INTO organizations (
           id, slug, name, description, public_email, public_phone,
           source_submission_id, published_at, updated_at
         ) VALUES ('org_retained', 'retained-public-copy', 'Old community listing',
           'A sufficiently detailed old community submission.',
           'public@example.org', '+1 242 555 0199', 'submission_old', ?, ?)`,
      ).bind(OLD, OLD),
      baseEnv.DB.prepare(
        `INSERT INTO organization_submission_public_contacts (
           id, submission_id, contact_type, label, value, normalized_value,
           sort_order, is_primary, created_at
         ) VALUES ('old_public_contact', 'submission_old', 'email', 'Volunteer team',
           'volunteer@example.org', 'volunteer@example.org', 0, 1, ?)`,
      ).bind(OLD),
      baseEnv.DB.prepare(
        `INSERT INTO organization_submission_sections (
           id, submission_id, section_kind, heading, body_text, sort_order, created_at
         ) VALUES ('old_profile_section', 'submission_old', 'mission', 'Mission',
           'This staged section should expire with the private review material.', 0, ?)`,
      ).bind(OLD),
    ]);

    const count = await anonymizeExpiredPrivateSubmissions({
      ...baseEnv,
      PRIVATE_SUBMISSION_RETENTION_DAYS: "90",
    }, new Date("2026-08-01T00:00:00.000Z"));

    expect(count).toBe(1);
    expect(await baseEnv.DB.prepare(
      `SELECT submitter_email, submitter_phone, public_email, public_phone,
              idempotency_hash, idempotency_key_hash, payload_fingerprint_hash,
              origin, ip_hash
       FROM organization_submissions WHERE id = 'submission_old'`,
    ).first()).toEqual({
      submitter_email: "",
      submitter_phone: "[retention purged]",
      public_email: "",
      public_phone: "",
      idempotency_hash: null,
      idempotency_key_hash: null,
      payload_fingerprint_hash: null,
      origin: "",
      ip_hash: "",
    });
    expect(await baseEnv.DB.prepare(
      `SELECT public_email, public_phone FROM organizations WHERE id = 'org_retained'`,
    ).first()).toEqual({
      public_email: "public@example.org",
      public_phone: "+1 242 555 0199",
    });
    expect(await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM organization_submission_public_contacts WHERE submission_id = 'submission_old'",
    ).first()).toEqual({ count: 0 });
    expect(await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM organization_submission_sections WHERE submission_id = 'submission_old'",
    ).first()).toEqual({ count: 0 });
  });

  it("clears staged event contact and idempotency data without changing its public copy", async () => {
    await baseEnv.DB.batch([
      baseEnv.DB.prepare(
        `INSERT INTO event_submissions (
           id, status, name, description, start_at, venue_name,
           submitter_email, submitter_phone, public_email, public_phone,
           idempotency_hash, idempotency_key_hash, payload_fingerprint_hash,
           origin, ip_hash, published_event_id, reviewed_at, created_at, updated_at
         ) VALUES ('event_submission_old', 'approved', 'Old service event',
           'A sufficiently detailed old community event submission.',
           '2026-01-10T15:00:00.000Z', 'Community Centre',
           'private-event@example.org', '+1 242 555 0101',
           'public-event@example.org', '+1 242 555 0198', ?, ?, ?,
           'https://servethecays.com', ?, 42001, ?, ?, ?)`,
      ).bind("e".repeat(64), "f".repeat(64), "1".repeat(64), "2".repeat(64), OLD, OLD, OLD),
      baseEnv.DB.prepare(
        `INSERT INTO events (
           id, slug, name, description, start_at, venue_name,
           public_email, public_phone, source_submission_id, published_at, updated_at
         ) VALUES (42001, 'retained-public-event', 'Old service event',
           'A sufficiently detailed old community event submission.',
           '2026-01-10T15:00:00.000Z', 'Community Centre',
           'public-event@example.org', '+1 242 555 0198',
           'event_submission_old', ?, ?)`,
      ).bind(OLD, OLD),
    ]);

    expect(await anonymizeExpiredPrivateSubmissions({
      ...baseEnv,
      PRIVATE_SUBMISSION_RETENTION_DAYS: "90",
    }, new Date("2026-08-01T00:00:00.000Z"))).toBe(1);

    expect(await baseEnv.DB.prepare(
      `SELECT submitter_email, submitter_phone, public_email, public_phone,
              idempotency_hash, idempotency_key_hash, payload_fingerprint_hash,
              origin, ip_hash
       FROM event_submissions WHERE id = 'event_submission_old'`,
    ).first()).toEqual({
      submitter_email: "",
      submitter_phone: "[retention purged]",
      public_email: "",
      public_phone: "",
      idempotency_hash: null,
      idempotency_key_hash: null,
      payload_fingerprint_hash: null,
      origin: "",
      ip_hash: "",
    });
    expect(await baseEnv.DB.prepare(
      "SELECT public_email, public_phone FROM events WHERE id = 42001",
    ).first()).toEqual({
      public_email: "public-event@example.org",
      public_phone: "+1 242 555 0198",
    });
  });

  it("does not anonymize private submitter identifiers before the retention window", async () => {
    await seedOldSubmission();
    const fresh = "2026-07-31T00:00:00.000Z";
    await baseEnv.DB.prepare(
      "UPDATE organization_submissions SET created_at = ?, updated_at = ? WHERE id = 'submission_old'",
    ).bind(fresh, fresh).run();

    const count = await anonymizeExpiredPrivateSubmissions({
      ...baseEnv,
      PRIVATE_SUBMISSION_RETENTION_DAYS: "90",
    }, new Date("2026-08-01T00:00:00.000Z"));

    expect(count).toBe(0);
    expect(await baseEnv.DB.prepare(
      `SELECT submitter_email, submitter_phone, public_email, public_phone,
              idempotency_key_hash, payload_fingerprint_hash
       FROM organization_submissions WHERE id = 'submission_old'`,
    ).first()).toEqual({
      submitter_email: "private@example.org",
      submitter_phone: "+1 242 555 0100",
      public_email: "public@example.org",
      public_phone: "+1 242 555 0199",
      idempotency_key_hash: "c".repeat(64),
      payload_fingerprint_hash: "d".repeat(64),
    });
  });

  it("deletes only rate-limit windows that have been stale for two full windows", async () => {
    await baseEnv.DB.batch([
      baseEnv.DB.prepare(
        "INSERT INTO rate_limits (key, window_started_at, count, updated_at) VALUES ('stale', ?, 2, ?)",
      ).bind(OLD, OLD),
      baseEnv.DB.prepare(
        "INSERT INTO rate_limits (key, window_started_at, count, updated_at) VALUES ('current', ?, 1, ?)",
      ).bind("2026-08-01T11:59:00.000Z", "2026-08-01T11:59:00.000Z"),
    ]);

    const count = await purgeExpiredRateLimits({
      ...baseEnv,
      RATE_LIMIT_WINDOW_SECONDS: "300",
    }, new Date("2026-08-01T12:00:00.000Z"));

    expect(count).toBe(1);
    expect(await baseEnv.DB.prepare("SELECT key FROM rate_limits ORDER BY key").all())
      .toMatchObject({ results: [{ key: "current" }] });
  });
});
