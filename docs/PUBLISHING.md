# Publishing the source repository

The website links to `https://github.com/caynetic/stc` as its public source
location. Update that link and its static contract test before publishing under
a different repository name.

## Current-tree check versus history

`npm run public:check` scans the files that would be visible in the current
repository snapshot. It rejects ignored private paths, live infrastructure
identifiers in the public Worker template, common credential formats, private
operator email, and generated clutter.

That check does **not** sanitize Git history. This project previously carried
private operational configuration, so the first public release must use a
fresh, independently reviewed history. Do not change the visibility of the
historically private repository merely because the current-tree check passes.

## First-public-release checklist

1. Run `npm ci` and `npm run verify` from `cloudflare/`.
2. Review `git status`, every staged path, and the complete staged diff.
3. Confirm that `wrangler.private.jsonc`, `.dev.vars`, `ops/private/`, exports,
   logs, screenshots, database files, and provider evidence are absent.
4. Publish the reviewed snapshot as a new root commit in a fresh repository or
   use a separately approved, audited history-replacement procedure.
5. Run the public-repository check again from the fresh history.
6. Confirm that the source URL in the site footer resolves to that public
   repository.
7. Leave `CLOUDFLARE_DEPLOY_ENABLED` unset until preview resources and GitHub
   environments have been configured deliberately.
8. Make the repository public only after the clean snapshot, MIT license,
   security contact, contribution guide, and deployment boundary have been
   reviewed on GitHub.

Replacing the history of an existing remote is destructive and is not part of
the ordinary application release. It requires a separate, explicit decision.
