import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import {
  cleanupDerivative,
  cleanupPrivateImage,
  preparePrivateImage,
  privateImageInsert,
  processMediaCleanupJobs,
  type PreparedDerivative,
  type PreparedPrivateImage,
  type ValidatedImage,
} from "../src/images";
import type { Env } from "../src/types";

const baseEnv = env as unknown as Env;

function bytes(value: number): ArrayBuffer {
  return new Uint8Array([value]).buffer;
}

function validatedImage(): ValidatedImage {
  return {
    bytes: bytes(1),
    contentType: "image/png",
    size: 1,
    width: 1,
    height: 1,
    sha256: "0".repeat(64),
  };
}

describe("durable media cleanup", () => {
  it("registers cleanup before writing R2 and refuses an untracked upload", async () => {
    let puts = 0;
    const database = {
      prepare(sql: string) {
        if (!sql.includes("INSERT INTO media_cleanup_jobs")) return baseEnv.DB.prepare(sql);
        return {
          bind() {
            return {
              async run() {
                throw new Error("simulated D1 outage");
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    const bucket = {
      async put() {
        puts += 1;
      },
    } as unknown as R2Bucket;
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(preparePrivateImage({
        ...baseEnv,
        DB: database,
        PRIVATE_UPLOADS: bucket,
      }, {
        image: validatedImage(),
        ownerType: "organization_submission",
        ownerId: "submission_untracked",
        kind: "organization_logo",
        altText: "Community organization logo",
      })).rejects.toMatchObject({
        status: 503,
        code: "media_cleanup_tracking_unavailable",
      });
    } finally {
      log.mockRestore();
    }
    expect(puts).toBe(0);
  });

  it("clears a provisional private cleanup job in the media insert transaction", async () => {
    const prepared = await preparePrivateImage(baseEnv, {
      image: validatedImage(),
      ownerType: "organization_submission",
      ownerId: "submission_committed",
      kind: "organization_logo",
      altText: "Community organization logo",
    });
    expect((await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM media_cleanup_jobs WHERE object_key = ?",
    ).bind(prepared.originalKey).first<{ count: number }>())?.count).toBe(1);

    await baseEnv.DB.batch([privateImageInsert(baseEnv, prepared)]);

    expect((await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM media_cleanup_jobs WHERE object_key = ?",
    ).bind(prepared.originalKey).first<{ count: number }>())?.count).toBe(0);
    expect(await baseEnv.PRIVATE_UPLOADS.get(prepared.originalKey)).not.toBeNull();
  });

  it("keeps failed private and published deletions discoverable and retries them", async () => {
    const privateObjectPath = "quarantine/organization_submission/orphan/private";
    const publishedKey = "published/orphan/derivative.webp";
    await Promise.all([
      baseEnv.PRIVATE_UPLOADS.put(privateObjectPath, bytes(2)),
      baseEnv.PUBLISHED_MEDIA.put(publishedKey, bytes(3)),
    ]);
    const failingBucket = {
      async delete() {
        throw new Error("simulated R2 outage");
      },
    } as unknown as R2Bucket;
    const privateImage: PreparedPrivateImage = {
      ...validatedImage(),
      assetId: "media_private_orphan",
      ownerType: "organization_submission",
      ownerId: "submission_orphan",
      kind: "organization_logo",
      altText: "Community organization logo",
      originalKey: privateObjectPath,
      createdAt: "2026-08-14T00:00:00.000Z",
    };
    const derivative: PreparedDerivative = {
      assetId: "media_public_orphan",
      key: publishedKey,
      contentType: "image/webp",
      size: 1,
      width: 1,
      height: 1,
      publishedAt: "2026-08-14T00:00:00.000Z",
      newlyCreated: true,
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await cleanupPrivateImage({ ...baseEnv, PRIVATE_UPLOADS: failingBucket }, privateImage);
      await cleanupDerivative({ ...baseEnv, PUBLISHED_MEDIA: failingBucket }, derivative);
    } finally {
      log.mockRestore();
    }

    const pending = await baseEnv.DB.prepare(
      `SELECT bucket, object_key, attempts, last_error
       FROM media_cleanup_jobs ORDER BY bucket`,
    ).all<Record<string, unknown>>();
    expect(pending.results).toEqual([
      {
        bucket: "private_uploads",
        object_key: privateObjectPath,
        attempts: 1,
        last_error: "simulated R2 outage",
      },
      {
        bucket: "published_media",
        object_key: publishedKey,
        attempts: 1,
        last_error: "simulated R2 outage",
      },
    ]);

    expect(await processMediaCleanupJobs(baseEnv, new Date("2100-01-01T00:00:00.000Z"))).toBe(2);
    expect(await baseEnv.PRIVATE_UPLOADS.get(privateObjectPath)).toBeNull();
    expect(await baseEnv.PUBLISHED_MEDIA.get(publishedKey)).toBeNull();
    expect((await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM media_cleanup_jobs",
    ).first<{ count: number }>())?.count).toBe(0);
  });
});
