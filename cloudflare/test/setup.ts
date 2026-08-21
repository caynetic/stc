import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { beforeAll, beforeEach } from "vitest";

const testEnv = env as unknown as {
  DB: D1Database;
  PRIVATE_UPLOADS: R2Bucket;
  PUBLISHED_MEDIA: R2Bucket;
  TEST_MIGRATIONS: D1Migration[];
};

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

async function clearBucket(bucket: R2Bucket): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ cursor });
    if (listed.objects.length) await bucket.delete(listed.objects.map((object) => object.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare("DROP TRIGGER IF EXISTS outreach_activities_append_only_update"),
    testEnv.DB.prepare("DROP TRIGGER IF EXISTS outreach_activities_append_only_delete"),
  ]);
  await testEnv.DB.batch([
    testEnv.DB.prepare("DELETE FROM outreach_activities"),
    testEnv.DB.prepare("DELETE FROM outreach_contacts"),
    testEnv.DB.prepare("DELETE FROM news_posts"),
    testEnv.DB.prepare("DELETE FROM media_cleanup_jobs"),
    testEnv.DB.prepare("DELETE FROM newsletter_provider_events"),
    testEnv.DB.prepare("DELETE FROM newsletter_confirmation_requests"),
    testEnv.DB.prepare("DELETE FROM newsletter_deliveries"),
    testEnv.DB.prepare("DELETE FROM newsletter_suppressions"),
    testEnv.DB.prepare("DELETE FROM newsletter_digests"),
    testEnv.DB.prepare("DELETE FROM email_jobs"),
    testEnv.DB.prepare("DELETE FROM audit_events"),
    testEnv.DB.prepare("DELETE FROM moderation_events"),
    testEnv.DB.prepare("DELETE FROM event_rsvps"),
    testEnv.DB.prepare("DELETE FROM event_favorites"),
    testEnv.DB.prepare("DELETE FROM organization_favorites"),
    testEnv.DB.prepare("DELETE FROM member_notification_categories"),
    testEnv.DB.prepare("DELETE FROM member_notification_locations"),
    testEnv.DB.prepare("DELETE FROM event_organizations"),
    testEnv.DB.prepare("DELETE FROM organization_public_contacts"),
    testEnv.DB.prepare("DELETE FROM organization_sections"),
    testEnv.DB.prepare("DELETE FROM organization_categories"),
    testEnv.DB.prepare("DELETE FROM organization_locations"),
    testEnv.DB.prepare("DELETE FROM events"),
    testEnv.DB.prepare("DELETE FROM event_submissions"),
    testEnv.DB.prepare("DELETE FROM organizations"),
    testEnv.DB.prepare("DELETE FROM organization_submission_public_contacts"),
    testEnv.DB.prepare("DELETE FROM organization_submission_sections"),
    testEnv.DB.prepare("DELETE FROM organization_submission_categories"),
    testEnv.DB.prepare("DELETE FROM organization_submission_locations"),
    testEnv.DB.prepare("DELETE FROM organization_submissions"),
    testEnv.DB.prepare("DELETE FROM media_assets"),
    testEnv.DB.prepare("DELETE FROM subscribers"),
    testEnv.DB.prepare("DELETE FROM sessions"),
    testEnv.DB.prepare("DELETE FROM member_sessions"),
    testEnv.DB.prepare("DELETE FROM member_magic_links"),
    testEnv.DB.prepare("DELETE FROM members"),
    testEnv.DB.prepare("DELETE FROM users"),
    testEnv.DB.prepare("DELETE FROM rate_limits"),
    testEnv.DB.prepare("DELETE FROM migration_map"),
    testEnv.DB.prepare("UPDATE revision_state SET revision = 0, updated_at = '1970-01-01T00:00:00.000Z' WHERE id = 1"),
  ]);
  await testEnv.DB.batch([
    testEnv.DB.prepare(`
      CREATE TRIGGER outreach_activities_append_only_update
      BEFORE UPDATE ON outreach_activities
      BEGIN
        SELECT RAISE(ABORT, 'outreach activities are append-only');
      END
    `),
    testEnv.DB.prepare(`
      CREATE TRIGGER outreach_activities_append_only_delete
      BEFORE DELETE ON outreach_activities
      BEGIN
        SELECT RAISE(ABORT, 'outreach activities are append-only');
      END
    `),
  ]);
  await Promise.all([clearBucket(testEnv.PRIVATE_UPLOADS), clearBucket(testEnv.PUBLISHED_MEDIA)]);
});
