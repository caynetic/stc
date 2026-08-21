# Security policy

Please do not open a public issue for a suspected vulnerability.

Report it privately to `hello@servethecays.com` with the subject
`Security report`. Include the affected route or component, the impact you
observed, and safe reproduction steps. Do not include real subscriber data,
member information, credentials, session tokens, or destructive proof.

The maintainers will validate the report, preserve relevant evidence, and
coordinate remediation before public discussion. Please avoid automated scans
that create accounts, send email, upload large files, or place material load on
the live service without prior permission.

## Repository secrets

The public repository must not contain:

- `.dev.vars`, `.env` files, credentials, tokens, or private keys;
- provisioned Cloudflare resource identifiers or real Turnstile site keys;
- owner allowlists, subscriber exports, private submissions, or provider
  payloads;
- Worker version IDs, D1 recovery bookmarks, or private release evidence.

Run `npm run public:check` from `cloudflare/` before publishing a snapshot or
opening a pull request.
