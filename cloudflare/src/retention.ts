import { positiveInteger } from "./http";
import type { Env } from "./types";

const RETENTION_MARKER = "[retention purged]";

export async function anonymizeExpiredPrivateSubmissions(
  env: Env,
  now = new Date(),
): Promise<number> {
  const days = positiveInteger(env.PRIVATE_SUBMISSION_RETENTION_DAYS, 90, 3650);
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const stagedProfileStatements = [
    env.DB.prepare(
      `DELETE FROM organization_submission_public_contacts
       WHERE submission_id IN (
         SELECT id FROM organization_submissions WHERE created_at <= ?
       )`,
    ).bind(cutoff),
    env.DB.prepare(
      `DELETE FROM organization_submission_sections
       WHERE submission_id IN (
         SELECT id FROM organization_submissions WHERE created_at <= ?
       )`,
    ).bind(cutoff),
  ];
  const anonymizeStatements = ["organization_submissions", "event_submissions"].map((table) =>
    env.DB.prepare(
      `UPDATE ${table}
       SET submitter_email = '', submitter_phone = ?, public_email = '',
           public_phone = '', idempotency_hash = NULL, idempotency_key_hash = NULL,
           payload_fingerprint_hash = NULL, origin = '', ip_hash = ''
       WHERE created_at <= ?
         AND (submitter_email <> '' OR submitter_phone <> ? OR idempotency_hash IS NOT NULL
           OR idempotency_key_hash IS NOT NULL OR payload_fingerprint_hash IS NOT NULL
           OR public_email <> '' OR public_phone <> '' OR origin <> '' OR ip_hash <> '')`,
    ).bind(RETENTION_MARKER, cutoff, RETENTION_MARKER),
  );
  const results = await env.DB.batch([...stagedProfileStatements, ...anonymizeStatements]);
  return results.slice(stagedProfileStatements.length)
    .reduce((total, result) => total + Number(result.meta.changes ?? 0), 0);
}
