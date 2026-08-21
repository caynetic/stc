import { ApiError, positiveInteger, securityHeaders } from "./http";
import { randomId, randomOpaqueToken, sha256Hex } from "./security";
import type { Env, MediaAssetRow } from "./types";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 12_000;
export const MAX_IMAGE_PIXELS = 36_000_000;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const CLEANUP_BATCH_SIZE = 100;
const PROVISIONAL_CLEANUP_DELAY_MS = 15 * 60 * 1000;
const MAX_CLEANUP_ERROR_LENGTH = 500;

type MediaCleanupBucket = "private_uploads" | "published_media";

interface MediaCleanupJobRow {
  id: string;
  bucket: MediaCleanupBucket;
  object_key: string;
  asset_id: string | null;
  reason: string;
  attempts: number;
}

export interface ValidatedImage {
  bytes: ArrayBuffer;
  contentType: "image/jpeg" | "image/png" | "image/webp";
  size: number;
  width: number;
  height: number;
  sha256: string;
}

interface ImageDimensions {
  width: number;
  height: number;
}

export interface PreparedPrivateImage extends ValidatedImage {
  assetId: string;
  ownerType: "organization_submission" | "event_submission";
  ownerId: string;
  kind: "organization_logo" | "event_image";
  altText: string;
  originalKey: string;
  createdAt: string;
}

export interface PreparedDerivative {
  assetId: string;
  key: string;
  contentType: "image/webp";
  size: number;
  width: number;
  height: number;
  publishedAt: string;
  newlyCreated: boolean;
}

function mediaCleanupBinding(env: Env, bucket: MediaCleanupBucket): R2Bucket {
  return bucket === "private_uploads" ? env.PRIVATE_UPLOADS : env.PUBLISHED_MEDIA;
}

function cleanupErrorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.slice(0, MAX_CLEANUP_ERROR_LENGTH);
}

function cleanupRetryAt(now: Date, attempts: number): string {
  const delaySeconds = Math.min(86_400, 60 * (2 ** Math.min(Math.max(attempts, 0), 10)));
  return new Date(now.getTime() + delaySeconds * 1_000).toISOString();
}

async function upsertMediaCleanupJob(
  env: Env,
  input: {
    bucket: MediaCleanupBucket;
    objectKey: string;
    assetId: string;
    reason: string;
    nextAttemptAt: string;
  },
  now: Date,
): Promise<void> {
  const nowValue = now.toISOString();
  await env.DB.prepare(
    `INSERT INTO media_cleanup_jobs (
       id, bucket, object_key, asset_id, reason, attempts, last_error,
       next_attempt_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 0, '', ?, ?, ?)
     ON CONFLICT(bucket, object_key) DO UPDATE SET
       asset_id = excluded.asset_id,
       reason = excluded.reason,
       next_attempt_at = CASE
         WHEN excluded.next_attempt_at < media_cleanup_jobs.next_attempt_at
           THEN excluded.next_attempt_at
         ELSE media_cleanup_jobs.next_attempt_at
       END,
       updated_at = excluded.updated_at`,
  ).bind(
    randomId("media_cleanup"),
    input.bucket,
    input.objectKey,
    input.assetId,
    input.reason,
    input.nextAttemptAt,
    nowValue,
    nowValue,
  ).run();
}

async function markMediaCleanupFailure(
  env: Env,
  bucket: MediaCleanupBucket,
  objectKey: string,
  attempts: number,
  error: unknown,
  now: Date,
): Promise<void> {
  try {
    await env.DB.prepare(
      `UPDATE media_cleanup_jobs SET
         attempts = attempts + 1, last_error = ?, next_attempt_at = ?, updated_at = ?
       WHERE bucket = ? AND object_key = ?`,
    ).bind(
      cleanupErrorMessage(error),
      cleanupRetryAt(now, attempts + 1),
      now.toISOString(),
      bucket,
      objectKey,
    ).run();
  } catch (ledgerError) {
    console.error("Could not record media cleanup failure", {
      bucket,
      error: cleanupErrorMessage(ledgerError),
    });
  }
}

async function removeMediaCleanupJob(
  env: Env,
  bucket: MediaCleanupBucket,
  objectKey: string,
): Promise<void> {
  try {
    await env.DB.prepare(
      "DELETE FROM media_cleanup_jobs WHERE bucket = ? AND object_key = ?",
    ).bind(bucket, objectKey).run();
  } catch (error) {
    // R2 deletion is idempotent. Leaving this row behind is safe and lets a
    // later scheduled pass reconcile the D1 side of the completed cleanup.
    console.error("Could not finish media cleanup ledger entry", {
      bucket,
      error: cleanupErrorMessage(error),
    });
  }
}

async function attemptMediaCleanup(
  env: Env,
  input: {
    bucket: MediaCleanupBucket;
    objectKey: string;
    assetId: string;
    reason: string;
    attempts?: number;
  },
  now = new Date(),
): Promise<boolean> {
  try {
    await upsertMediaCleanupJob(env, {
      ...input,
      nextAttemptAt: now.toISOString(),
    }, now);
  } catch (error) {
    // Still try the immediate R2 delete. If both D1 and R2 are unavailable,
    // an R2 lifecycle rule remains the final backstop for the opaque object.
    console.error("Could not create media cleanup ledger entry", {
      bucket: input.bucket,
      assetId: input.assetId,
      error: cleanupErrorMessage(error),
    });
  }

  try {
    await mediaCleanupBinding(env, input.bucket).delete(input.objectKey);
  } catch (error) {
    await markMediaCleanupFailure(
      env,
      input.bucket,
      input.objectKey,
      input.attempts ?? 0,
      error,
      now,
    );
    console.error("Media object cleanup failed and will be retried", {
      bucket: input.bucket,
      assetId: input.assetId,
      reason: input.reason,
      error: cleanupErrorMessage(error),
    });
    return false;
  }

  await removeMediaCleanupJob(env, input.bucket, input.objectKey);
  return true;
}

async function registerProvisionalMediaCleanup(
  env: Env,
  input: {
    bucket: MediaCleanupBucket;
    objectKey: string;
    assetId: string;
    reason: string;
  },
): Promise<void> {
  const now = new Date();
  try {
    await upsertMediaCleanupJob(env, {
      ...input,
      nextAttemptAt: new Date(now.getTime() + PROVISIONAL_CLEANUP_DELAY_MS).toISOString(),
    }, now);
  } catch (error) {
    // Registration happens before the R2 put, so a D1 failure prevents an
    // untracked object from being written at all.
    console.error("Could not register provisional media cleanup", {
      bucket: input.bucket,
      assetId: input.assetId,
      error: cleanupErrorMessage(error),
    });
    throw new ApiError(
      503,
      "media_cleanup_tracking_unavailable",
      "The image could not be stored safely. Please try again.",
    );
  }
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

function uint16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, false);
}

function uint24LittleEndian(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function uint32(bytes: Uint8Array, offset: number, littleEndian = false): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, littleEndian);
}

function jpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (
    bytes.length < 20 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[bytes.length - 2] !== 0xff ||
    bytes[bytes.length - 1] !== 0xd9
  ) return null;
  const frames = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let dimensions: ImageDimensions | null = null;
  let offset = 2;
  while (offset < bytes.length - 2) {
    if (bytes[offset] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9) break;
    if (marker === 0x00 || marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const segmentLength = uint16(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (frames.has(marker)) {
      if (segmentLength < 8) return null;
      dimensions = { height: uint16(bytes, offset + 3), width: uint16(bytes, offset + 5) };
    }
    if (marker === 0xda) return dimensions;
    offset += segmentLength;
  }
  return null;
}

function pngDimensions(bytes: Uint8Array): ImageDimensions | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 57 || !signature.every((byte, index) => bytes[index] === byte)) return null;
  let offset = signature.length;
  let dimensions: ImageDimensions | null = null;
  let sawImageData = false;
  let chunkCount = 0;
  while (offset + 12 <= bytes.length && chunkCount < 1024) {
    const length = uint32(bytes, offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return null;
    const type = ascii(bytes, offset + 4, 4);
    if (chunkCount === 0) {
      if (type !== "IHDR" || length !== 13) return null;
      dimensions = { width: uint32(bytes, offset + 8), height: uint32(bytes, offset + 12) };
    } else if (type === "IHDR") return null;
    if (type === "IDAT") sawImageData = true;
    if (type === "IEND") return length === 0 && end === bytes.length && sawImageData ? dimensions : null;
    offset = end;
    chunkCount += 1;
  }
  return null;
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (
    bytes.length < 30 ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 4) !== "WEBP" ||
    uint32(bytes, 4, true) !== bytes.length - 8
  ) return null;
  const chunkType = ascii(bytes, 12, 4);
  const chunkLength = uint32(bytes, 16, true);
  if (20 + chunkLength > bytes.length) return null;
  if (chunkType === "VP8X" && chunkLength >= 10) {
    return { width: uint24LittleEndian(bytes, 24) + 1, height: uint24LittleEndian(bytes, 27) + 1 };
  }
  if (chunkType === "VP8 " && chunkLength >= 10 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { width: (bytes[26] | (bytes[27] << 8)) & 0x3fff, height: (bytes[28] | (bytes[29] << 8)) & 0x3fff };
  }
  if (chunkType === "VP8L" && chunkLength >= 5 && bytes[20] === 0x2f) {
    const packed = uint32(bytes, 21, true);
    return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

export function inspectImage(contentType: string, bytes: Uint8Array): ImageDimensions | null {
  if (contentType === "image/jpeg") return jpegDimensions(bytes);
  if (contentType === "image/png") return pngDimensions(bytes);
  if (contentType === "image/webp") return webpDimensions(bytes);
  return null;
}

export function safeImageDimensions(dimensions: ImageDimensions): boolean {
  return (
    dimensions.width > 0 &&
    dimensions.height > 0 &&
    dimensions.width <= MAX_IMAGE_DIMENSION &&
    dimensions.height <= MAX_IMAGE_DIMENSION &&
    dimensions.width * dimensions.height <= MAX_IMAGE_PIXELS
  );
}

export async function validateImage(file: File | undefined): Promise<ValidatedImage | null> {
  if (!file) return null;
  if (file.size > MAX_IMAGE_BYTES) {
    throw new ApiError(413, "image_too_large", "Choose an image that is 5 MiB or smaller.", {
      image: ["Choose an image that is 5 MiB or smaller."],
    });
  }
  const contentType = file.type.trim().toLowerCase();
  if (!IMAGE_TYPES.has(contentType)) {
    throw new ApiError(400, "unsupported_image_type", "Choose a JPEG, PNG, or WebP image.", {
      image: ["Choose a JPEG, PNG, or WebP image."],
    });
  }
  const bytes = await file.arrayBuffer();
  const dimensions = inspectImage(contentType, new Uint8Array(bytes));
  if (!bytes.byteLength || !dimensions) {
    throw new ApiError(400, "image_signature_mismatch", "The image file does not match its declared format.", {
      image: ["Choose a valid JPEG, PNG, or WebP image."],
    });
  }
  if (!safeImageDimensions(dimensions)) {
    throw new ApiError(400, "image_dimensions_unsafe", "Choose an image with smaller pixel dimensions.", {
      image: ["Choose an image no larger than 36 megapixels or 12000 pixels per side."],
    });
  }
  return {
    bytes,
    contentType: contentType as ValidatedImage["contentType"],
    size: bytes.byteLength,
    width: dimensions.width,
    height: dimensions.height,
    sha256: await sha256Hex(bytes),
  };
}

export async function preparePrivateImage(
  env: Env,
  input: {
    image: ValidatedImage;
    ownerType: PreparedPrivateImage["ownerType"];
    ownerId: string;
    kind: PreparedPrivateImage["kind"];
    altText: string;
  },
): Promise<PreparedPrivateImage> {
  const assetId = randomId("media");
  const originalKey = `quarantine/${input.ownerType}/${input.ownerId}/${randomOpaqueToken(32)}`;
  const createdAt = new Date().toISOString();
  await registerProvisionalMediaCleanup(env, {
    bucket: "private_uploads",
    objectKey: originalKey,
    assetId,
    reason: "private_upload_uncommitted",
  });
  await env.PRIVATE_UPLOADS.put(originalKey, input.image.bytes, {
    httpMetadata: { contentType: input.image.contentType },
    customMetadata: {
      asset_id: assetId,
      sha256: input.image.sha256,
      width: String(input.image.width),
      height: String(input.image.height),
    },
  });
  return { ...input.image, assetId, originalKey, createdAt, ...input };
}

export function privateImageInsert(env: Env, image: PreparedPrivateImage): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO media_assets (
       id, owner_type, owner_id, kind, status, alt_text, original_key,
       original_content_type, original_size_bytes, original_width,
       original_height, original_sha256, created_at
     ) VALUES (?, ?, ?, ?, 'quarantined', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    image.assetId,
    image.ownerType,
    image.ownerId,
    image.kind,
    image.altText,
    image.originalKey,
    image.contentType,
    image.size,
    image.width,
    image.height,
    image.sha256,
    image.createdAt,
  );
}

export async function cleanupPrivateImage(env: Env, image: PreparedPrivateImage | null): Promise<void> {
  if (!image) return;
  await attemptMediaCleanup(env, {
    bucket: "private_uploads",
    objectKey: image.originalKey,
    assetId: image.assetId,
    reason: "private_upload_uncommitted",
  });
}

async function readVerifiedOriginal(env: Env, asset: MediaAssetRow): Promise<ArrayBuffer> {
  const object = await env.PRIVATE_UPLOADS.get(asset.original_key);
  if (!object || object.size !== asset.original_size_bytes) {
    throw new ApiError(409, "image_integrity_error", "This image could not be safely read.");
  }
  const bytes = await object.arrayBuffer();
  if ((await sha256Hex(bytes)) !== asset.original_sha256) {
    throw new ApiError(409, "image_integrity_error", "This image could not be safely read.");
  }
  const dimensions = inspectImage(asset.original_content_type, new Uint8Array(bytes));
  if (!dimensions || !safeImageDimensions(dimensions) || dimensions.width !== asset.original_width || dimensions.height !== asset.original_height) {
    throw new ApiError(409, "image_integrity_error", "This image could not be safely read.");
  }
  return bytes;
}

export async function preparePublishedDerivative(env: Env, assetId: string): Promise<PreparedDerivative> {
  const asset = await env.DB.prepare("SELECT * FROM media_assets WHERE id = ?")
    .bind(assetId)
    .first<MediaAssetRow>();
  if (!asset) throw new ApiError(404, "image_not_found", "The submission image was not found.");
  if (asset.status === "published" && asset.derivative_key && asset.derivative_content_type === "image/webp") {
    return {
      assetId,
      key: asset.derivative_key,
      contentType: "image/webp",
      size: Number(asset.derivative_size_bytes),
      width: Number(asset.derivative_width),
      height: Number(asset.derivative_height),
      publishedAt: asset.published_at ?? new Date().toISOString(),
      newlyCreated: false,
    };
  }
  if (asset.status !== "quarantined") {
    throw new ApiError(409, "image_state_conflict", "This image is not awaiting review.");
  }
  if (!env.IMAGES) {
    throw new ApiError(503, "image_processing_unavailable", "Image processing is temporarily unavailable.");
  }
  const original = await readVerifiedOriginal(env, asset);
  let result: ImageTransformationResult;
  try {
    result = await env.IMAGES.input(new Response(original).body!)
      .transform({ width: 1600, height: 1600, fit: "scale-down" })
      .output({ format: "image/webp", quality: 85, anim: false });
  } catch (error) {
    console.error("Cloudflare Images transformation failed", { assetId, error });
    throw new ApiError(503, "image_processing_failed", "The image could not be prepared for publication.");
  }
  const derivativeBytes = await new Response(result.image()).arrayBuffer();
  const dimensions = inspectImage("image/webp", new Uint8Array(derivativeBytes));
  if (!derivativeBytes.byteLength || !dimensions || !safeImageDimensions(dimensions)) {
    throw new ApiError(503, "image_processing_failed", "The image could not be prepared for publication.");
  }
  const key = `published/${asset.id}/${randomOpaqueToken(24)}.webp`;
  const publishedAt = new Date().toISOString();
  await registerProvisionalMediaCleanup(env, {
    bucket: "published_media",
    objectKey: key,
    assetId: asset.id,
    reason: "published_derivative_uncommitted",
  });
  await env.PUBLISHED_MEDIA.put(key, derivativeBytes, {
    httpMetadata: { contentType: "image/webp", cacheControl: "public, max-age=31536000, immutable" },
    customMetadata: { asset_id: asset.id, original_sha256: asset.original_sha256 },
  });
  return {
    assetId,
    key,
    contentType: "image/webp",
    size: derivativeBytes.byteLength,
    width: dimensions.width,
    height: dimensions.height,
    publishedAt,
    newlyCreated: true,
  };
}

export function publishDerivativeStatement(env: Env, derivative: PreparedDerivative): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE media_assets SET
       status = 'published', derivative_key = ?, derivative_content_type = ?,
       derivative_size_bytes = ?, derivative_width = ?, derivative_height = ?,
       published_at = ?, denied_at = NULL
     WHERE id = ? AND status = 'quarantined'`,
  ).bind(
    derivative.key,
    derivative.contentType,
    derivative.size,
    derivative.width,
    derivative.height,
    derivative.publishedAt,
    derivative.assetId,
  );
}

export async function cleanupDerivative(env: Env, derivative: PreparedDerivative | null): Promise<void> {
  if (!derivative?.newlyCreated) return;
  await attemptMediaCleanup(env, {
    bucket: "published_media",
    objectKey: derivative.key,
    assetId: derivative.assetId,
    reason: "published_derivative_uncommitted",
  });
}

export async function privateImageResponse(env: Env, assetId: string): Promise<Response> {
  const asset = await env.DB.prepare("SELECT * FROM media_assets WHERE id = ?")
    .bind(assetId)
    .first<MediaAssetRow>();
  if (!asset || asset.original_deleted_at) throw new ApiError(404, "image_not_found", "This submission has no available image.");
  const bytes = await readVerifiedOriginal(env, asset);
  const headers = securityHeaders(asset.original_content_type);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Disposition", "inline");
  headers.set("Content-Length", String(bytes.byteLength));
  headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
  return new Response(bytes, { headers });
}

export async function publishedImageResponse(env: Env, assetId: string): Promise<Response> {
  const asset = await env.DB.prepare(
    `SELECT * FROM media_assets
     WHERE id = ? AND status = 'published' AND derivative_key IS NOT NULL`,
  )
    .bind(assetId)
    .first<MediaAssetRow>();
  if (!asset?.derivative_key || asset.derivative_content_type !== "image/webp") {
    throw new ApiError(404, "image_not_found", "This image is not available.");
  }
  const object = await env.PUBLISHED_MEDIA.get(asset.derivative_key);
  if (!object || object.size !== asset.derivative_size_bytes) {
    throw new ApiError(404, "image_not_found", "This image is not available.");
  }
  const headers = securityHeaders("image/webp");
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("Content-Length", String(object.size));
  headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
  return new Response(object.body, { headers });
}

export async function processMediaCleanupJobs(
  env: Env,
  now = new Date(),
  limit = CLEANUP_BATCH_SIZE,
): Promise<number> {
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), CLEANUP_BATCH_SIZE));
  const rows = await env.DB.prepare(
    `SELECT id, bucket, object_key, asset_id, reason, attempts
     FROM media_cleanup_jobs
     WHERE next_attempt_at <= ?
     ORDER BY next_attempt_at, created_at, id
     LIMIT ?`,
  ).bind(now.toISOString(), boundedLimit).all<MediaCleanupJobRow>();
  let completed = 0;
  for (const row of rows.results) {
    const removed = await attemptMediaCleanup(env, {
      bucket: row.bucket,
      objectKey: row.object_key,
      assetId: row.asset_id ?? "",
      reason: row.reason,
      attempts: Number(row.attempts),
    }, now);
    if (removed) completed += 1;
  }
  return completed;
}

export async function purgeExpiredOriginals(env: Env, now = new Date()): Promise<number> {
  await processMediaCleanupJobs(env, now);
  const days = positiveInteger(env.PRIVATE_RETENTION_DAYS, 30, 3650);
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const pendingDays = positiveInteger(env.PRIVATE_SUBMISSION_RETENTION_DAYS, 90, 3650);
  const pendingCutoff = new Date(now.getTime() - pendingDays * 86_400_000).toISOString();
  const rows = await env.DB.prepare(
    `SELECT * FROM media_assets
     WHERE original_deleted_at IS NULL
       AND ((status = 'published' AND published_at <= ?)
         OR (status = 'denied' AND denied_at <= ?)
         OR (status = 'quarantined' AND created_at <= ?))
     ORDER BY created_at LIMIT 100`,
  )
    .bind(cutoff, cutoff, pendingCutoff)
    .all<MediaAssetRow>();
  let deleted = 0;
  for (const asset of rows.results) {
    const deletedAt = now.toISOString();
    let claimed = false;
    if (asset.status === "quarantined") {
      const table = asset.owner_type === "organization_submission"
        ? "organization_submissions"
        : "event_submissions";
      const results = await env.DB.batch([
        env.DB.prepare(
          `UPDATE ${table} SET image_asset_id = NULL
           WHERE id = ? AND status = 'pending' AND image_asset_id = ?
             AND EXISTS (
               SELECT 1 FROM media_assets
               WHERE id = ? AND status = 'quarantined'
                 AND original_deleted_at IS NULL AND created_at <= ?
             )`,
        ).bind(asset.owner_id, asset.id, asset.id, pendingCutoff),
        env.DB.prepare(
          `UPDATE media_assets SET status = 'deleted', original_deleted_at = ?, deleted_at = ?
           WHERE id = ? AND status = 'quarantined'
             AND original_deleted_at IS NULL AND created_at <= ?`,
        ).bind(deletedAt, deletedAt, asset.id, pendingCutoff),
      ]);
      claimed = Number(results[1]?.meta.changes ?? 0) === 1;
    } else {
      const retainedAtColumn = asset.status === "published" ? "published_at" : "denied_at";
      const result = await env.DB.prepare(
        `UPDATE media_assets SET original_deleted_at = ?
         WHERE id = ? AND status = ? AND original_deleted_at IS NULL
           AND ${retainedAtColumn} <= ?`,
      ).bind(deletedAt, asset.id, asset.status, cutoff).run();
      claimed = Number(result.meta.changes ?? 0) === 1;
    }
    if (!claimed) continue;

    const removed = await attemptMediaCleanup(env, {
      bucket: "private_uploads",
      objectKey: asset.original_key,
      assetId: asset.id,
      reason: "retention_original",
    }, now);
    if (!removed) continue;
    deleted += 1;
  }
  return deleted;
}
