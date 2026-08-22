import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import worker from "../src/index";
import type { Env } from "../src/types";

const APP_ORIGIN = "https://servethecays.test";
const baseEnv = env as unknown as Env;

function call(request: Request, overrides: Partial<Env> = {}): Promise<Response> {
  return worker.fetch(request, { ...baseEnv, ...overrides });
}

describe("routing security", () => {
  it("keeps a scheme-relative-looking path on the canonical host", async () => {
    const response = await call(
      new Request(`${APP_ORIGIN}//example.invalid/`),
      { ENVIRONMENT: "production" },
    );

    expect(response.status).toBe(308);
    expect(response.headers.get("Location")).toBe(`${APP_ORIGIN}/example.invalid`);
    expect(new URL(response.headers.get("Location")!).origin).toBe(APP_ORIGIN);
  });

  it("uses an absolute canonical trailing-slash redirect and preserves the query", async () => {
    const response = await call(
      new Request(`${APP_ORIGIN}/about/?from=directory&next=%2Forganizations`),
      { ENVIRONMENT: "production" },
    );

    expect(response.status).toBe(308);
    expect(response.headers.get("Location")).toBe(
      `${APP_ORIGIN}/about?from=directory&next=%2Forganizations`,
    );
  });

  it("identifies Caynetic Ltd. as the operator on the rendered About page", async () => {
    const response = await call(new Request(`${APP_ORIGIN}/about`));
    const page = await response.text();

    expect(response.status).toBe(200);
    expect(page).toContain("Serve the Cays is an initiative of");
    expect(page).toContain('href="https://caynetic.ltd"');
    expect(page).toContain("Caynetic Ltd.</a>");
    expect(page).not.toContain("https://caynetic.com");
    expect(page).not.toContain("canyetic.com");
  });

  it("adds security headers to static assets without changing content or cache metadata", async () => {
    const assets = {
      fetch: async () => new Response("body { color: navy; }", {
        headers: {
          "Content-Type": "text/css; charset=utf-8",
          "Cache-Control": "public, max-age=86400",
          ETag: '"asset-version"',
        },
      }),
    } as unknown as Fetcher;

    const response = await call(
      new Request(`${APP_ORIGIN}/static/css/style.css`),
      { ASSETS: assets },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("body { color: navy; }");
    expect(response.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=86400");
    expect(response.headers.get("ETag")).toBe('"asset-version"');
    expect(response.headers.get("Strict-Transport-Security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
  });

  it("gives the content-hashed email logo an immutable browser cache policy", async () => {
    const imageBytes = new Uint8Array([137, 80, 78, 71]);
    const assets = {
      fetch: async () => new Response(imageBytes, {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=0, must-revalidate",
          ETag: '"email-logo-version"',
        },
      }),
    } as unknown as Fetcher;

    const response = await call(
      new Request(`${APP_ORIGIN}/static/images/email-logo.5a81761f5371.png`),
      { ASSETS: assets },
    );

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(imageBytes);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("ETag")).toBe('"email-logo-version"');
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
