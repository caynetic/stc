# Historical legacy data migration

This document records the safeguards used for the completed migration into the
Worker application. The obsolete Flask runtime and its source exporter are no
longer part of this repository. `ops/prepare-legacy-import.mjs` remains only to
interpret an already-created restricted bundle for audit or reconciliation; it
does not read or mutate a source system.

## 1. Restricted bundle handling

Any previously created bundle must stay outside Git at mode 0600. Record only
counts and checksums in a migration ledger. A bundle contains personal
information and must not be pasted into logs, tickets, or chat.

## 2. Review ambiguity

Legacy contacts are ambiguous because the old submission form stored a
submitter's email or phone on the same contact relationship displayed by an
approved listing. The importer leaves those contacts non-public unless a human
review explicitly sets `confirm_legacy_contacts_public` to `true` for the
reviewed bundle.

Legacy event dates are free-form strings. Events whose dates cannot be parsed
are excluded from generated SQL and listed in the issue report. Pending legacy
records are also excluded because their contacts cannot safely be classified
without human review.

## 3. Prepare reviewed SQL

`ops/prepare-legacy-import.mjs` reads a JSON configuration on standard input
with `bundle`, `output`, `confirm_legacy_contacts_public`, and optional `force`
fields. It creates a mode-0600 SQL file and writes a PII-free issue summary to
standard error. If subscribers are being migrated, provide
`UNSUBSCRIBE_SECRET` through a protected process environment so generated
tokens match the Worker; never place the secret in the bundle or SQL.

Apply the SQL to preview first. Compare source and target counts, inspect every
issue, sample public pages, and confirm no private contact appears in HTML,
JSON, sitemap, or CSV output.

## 4. Migrate media separately

The SQL generator intentionally does not download or publish legacy files.
For each verified approved media reference:

1. Resolve the exact Spaces object and inventory its size, content type, and
   checksum without exposing credentials or presigned URLs.
2. Download into a restricted temporary location.
3. Apply the same JPEG/PNG/WebP, 5 MiB, signature, dimension, and pixel checks
   as new submissions.
4. Put the original in private R2 and process it through the Cloudflare Images
   binding to a WebP derivative.
5. Store the derivative in published-media R2 and update the matching D1 media
   record only after validation.
6. Verify public delivery, metadata removal, and private-source isolation.

Do not bulk-copy a public Spaces bucket into public R2. Unsupported or
unverifiable files remain excluded and are reported for manual replacement.

## 5. Final delta and reconciliation

The completed cutover required a final frozen-source export, checksum and count
comparison, reviewed delta import, and sampling of every data type. Any source
database or Spaces inventory retained outside this repository is historical
evidence, not an application rollback path. Migration completion requires
positive evidence for every source row or a documented exclusion—not merely a
successful command.
