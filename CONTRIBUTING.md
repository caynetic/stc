# Contributing

Thanks for taking an interest in Serve the Cays. Changes should preserve the
separation between public listings, private submissions, member data,
administrator access, and provider credentials.

## Development setup

```sh
cd cloudflare
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run db:seed:local
npm run dev
```

Use only test addresses and demonstration data locally. Do not add a real
Forward Email credential, Cloudflare resource ID, Turnstile site key, owner
address, subscriber list, or production export to the repository.

## Before submitting a change

Run:

```sh
cd cloudflare
npm run verify
```

The verification command builds CSS, type-checks the Worker, runs the
Workers-runtime and static-contract tests, and checks the visible repository
files for public-release hygiene.

Changes to routes, authentication, retention, moderation, email delivery,
consent, or D1 schema should include focused tests and documentation. Add new
D1 schema changes as the next ordered migration; do not rewrite a migration
that may already have been applied.

## Pull requests

Keep each change focused and explain:

- the user-visible or operational outcome;
- the trust boundary or data lifecycle affected;
- the tests run and their result;
- any migration, provider, accessibility, privacy, or rollback consideration.

Never attach real personal information, private provider payloads, secrets,
recovery bookmarks, or screenshots of authenticated administration screens.

Serve the Cays is licensed under the MIT License. By submitting a contribution,
you agree that it may be distributed under that repository-wide license.
