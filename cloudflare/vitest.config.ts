import path from "node:path";
import { fileURLToPath } from "node:url";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: path.join(root, "wrangler.test.jsonc") },
      miniflare: {
        d1Databases: ["DB"],
        r2Buckets: ["PRIVATE_UPLOADS", "PUBLISHED_MEDIA"],
        bindings: {
          APP_ORIGIN: "https://servethecays.test",
          ENVIRONMENT: "test",
          REQUIRE_TURNSTILE: "false",
          PASSWORD_PEPPER: "test-password-pepper-that-is-at-least-32-bytes",
          SESSION_SECRET: "test-session-secret-that-is-at-least-32-bytes",
          MEMBER_SESSION_SECRET: "test-member-session-secret-that-is-different-and-at-least-32-bytes",
          IP_HASH_KEY: "test-ip-hash-key-that-is-at-least-32-bytes",
          RATE_LIMIT_HASH_KEY: "test-rate-limit-key-that-is-at-least-32-bytes",
          UNSUBSCRIBE_SECRET: "test-unsubscribe-secret-at-least-32-bytes",
          NEWSLETTER_CONFIRMATION_SECRET: "test-newsletter-confirmation-secret-at-least-32-bytes",
          TEST_MIGRATIONS: await readD1Migrations(path.join(root, "migrations")),
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/setup.ts"]
  }
});
