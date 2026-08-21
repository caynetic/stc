export type FieldErrors = Record<string, string[]>;

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export async function readBoundedBody(
  request: Request,
  maximumBytes: number,
  tooLargeMessage: string,
  invalidBodyMessage: string,
): Promise<Uint8Array> {
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (Number.isSafeInteger(length) && length > maximumBytes) {
      throw new ApiError(413, "request_too_large", tooLargeMessage);
    }
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maximumBytes) {
        try {
          await reader.cancel("request body exceeded the configured limit");
        } catch {
          // The 413 below is authoritative even if the source cannot be cancelled.
        }
        throw new ApiError(413, "request_too_large", tooLargeMessage);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "invalid_body", invalidBodyMessage);
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields: FieldErrors = {},
  ) {
    super(message);
  }
}

export function positiveInteger(
  value: string | undefined,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback;
}

export function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function securityHeaders(contentType = "application/json; charset=utf-8"): Headers {
  const headers = new Headers({
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  });
  return headers;
}

export function json(
  value: unknown,
  status = 200,
  extraHeaders?: HeadersInit,
): Response {
  const headers = securityHeaders();
  headers.set("Cache-Control", "no-store");
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((item, key) => headers.set(key, item));
  }
  return new Response(JSON.stringify(value), { status, headers });
}

export function html(
  value: string,
  status = 200,
  cacheControl = "no-store",
): Response {
  const headers = securityHeaders("text/html; charset=utf-8");
  headers.set("Cache-Control", cacheControl);
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data: https://img.buymeacoffee.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  );
  return new Response(value, { status, headers });
}

export function redirect(location: string, status = 303): Response {
  const headers = securityHeaders("text/plain; charset=utf-8");
  headers.set("Location", location);
  headers.set("Cache-Control", "no-store");
  return new Response(null, { status, headers });
}

export async function readJson(request: Request, maximumBytes = 64 * 1024): Promise<Record<string, unknown>> {
  const type = request.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!type.startsWith("application/json")) {
    throw new ApiError(415, "unsupported_media_type", "Send JSON for this request.");
  }
  const bytes = await readBoundedBody(
    request,
    maximumBytes,
    "The request is too large.",
    "The request body could not be read.",
  );
  let raw: string;
  try {
    raw = utf8Decoder.decode(bytes);
  } catch {
    throw new ApiError(400, "invalid_json", "The request body is not valid JSON.");
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "invalid_json", "The request body is not valid JSON.");
  }
}

export interface MultipartInput {
  fields: Record<string, string>;
  lists: Record<string, string[]>;
  files: Record<string, File>;
}

export async function readMultipart(
  request: Request,
  maximumBytes = 6 * 1024 * 1024,
): Promise<MultipartInput> {
  const type = request.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!type.startsWith("multipart/form-data") && !type.startsWith("application/x-www-form-urlencoded")) {
    throw new ApiError(415, "unsupported_media_type", "Submit this form using form data.");
  }
  const bytes = await readBoundedBody(
    request,
    maximumBytes,
    "The submitted form is too large.",
    "The submitted form could not be read.",
  );
  const boundedHeaders = new Headers(request.headers);
  boundedHeaders.delete("Content-Length");
  let data: FormData;
  try {
    data = await new Request(request.url, {
      method: request.method,
      headers: boundedHeaders,
      body: bytes.buffer as ArrayBuffer,
    }).formData();
  } catch {
    throw new ApiError(400, "invalid_form", "The submitted form could not be read.");
  }
  const fields: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  const files: Record<string, File> = {};
  let parsedBytes = 0;
  let entries = 0;
  data.forEach((value, key) => {
    entries += 1;
    if (entries > 200) {
      throw new ApiError(413, "request_too_large", "The submitted form contains too many fields.");
    }
    parsedBytes += utf8.encode(key).byteLength;
    if (value instanceof File && value.size > 0) {
      parsedBytes += value.size;
      if (parsedBytes > maximumBytes) {
        throw new ApiError(413, "request_too_large", "The submitted form is too large.");
      }
      if (files[key]) {
        throw new ApiError(400, "unexpected_attachment", "Only one image may be attached.", {
          [key]: ["Only one image may be attached."],
        });
      }
      files[key] = value;
      return;
    }
    if (typeof value === "string") {
      parsedBytes += utf8.encode(value).byteLength;
      if (parsedBytes > maximumBytes) {
        throw new ApiError(413, "request_too_large", "The submitted form is too large.");
      }
      lists[key] ??= [];
      lists[key].push(value);
      if (!(key in fields)) fields[key] = value;
    }
  });
  return { fields, lists, files };
}

export function apiErrorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return json(
      {
        status: "error",
        code: error.code,
        message: error.message,
        ...(Object.keys(error.fields).length ? { errors: error.fields } : {}),
      },
      error.status,
    );
  }
  console.error("Unhandled request error", error);
  return json(
    {
      status: "error",
      code: "internal_error",
      message: "The request could not be completed.",
    },
    500,
  );
}
