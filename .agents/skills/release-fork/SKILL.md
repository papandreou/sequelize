---
name: release-fork
description: Publish a new patch release of this papandreou fork of Sequelize (sequelize-core-papandreou and sequelize-postgres-papandreou) to the public npm registry. Use when the user asks to release, publish, or cut a new patch of the fork, or mentions "npm publish" in the context of this repo.
---

# Releasing the papandreou Sequelize fork

This repo publishes two packages under private names — `sequelize-core-papandreou`
(from `packages/core`) and `sequelize-postgres-papandreou` (from `packages/postgres`)
— to the **public** npm registry (`registry.npmjs.org`), not the corporate Artifactory
mirror this machine normally uses. Consumers (e.g. the `peakon/api` repo) install them
via npm aliasing: `"@sequelize/core": "npm:sequelize-core-papandreou@^7.0.0-alpha.44-patchN"`.

Do this on the user's actual release branch (e.g. `sequelize-core-papandreouN`), not on
a fresh branch off `main` — that branch's `packages/{core,postgres}/package.json` already
has the fork's `name` and pinned dependency versions committed (see "Why the package.json
dance" below).

## Steps

### 1. Install deps for this branch

```sh
eval "$(fnm env)" && fnm use 18.18.2   # or whatever matches this branch; check .nvmrc if present
yarn
```

This branch pins different (older/incompatible) versions of TypeScript etc. than
branches cut from `main`, so always reinstall here even if you just ran `yarn` on a
different branch in this same checkout.

`ibm_db` will fail its native postinstall build on Apple Silicon ("Apple Silicon Chip
... is not supported") — this is a known, harmless limitation unrelated to `core`/
`postgres`. Ignore it; the overall `yarn` command still reports failure, but everything
needed for this workflow is installed regardless.

### 2. Temporarily revert the fork-specific package.json changes, then build

`packages/core/package.json` and `packages/postgres/package.json` have their `name`
fields renamed (`@sequelize/core` → `sequelize-core-papandreou`, etc.) and their
inter-package `workspace:*` dependencies replaced with pinned fork versions — necessary
for publishing, but it breaks `yarn build`, because sibling packages (mysql, mariadb,
mssql, sqlite3, db2, ibmi, snowflake, validator-js) still depend on
`"@sequelize/core": "workspace:*"`, which can't resolve once no workspace is actually
named `@sequelize/core`. Revert it, build, then restore:

```sh
# Save the diff BEFORE reverting -- you need the exact same patch to re-apply it
# afterward, and re-computing this diff after reverting would produce the wrong thing.
git diff origin/main...HEAD -- packages/core/package.json packages/postgres/package.json > /tmp/release-package-diff.patch

patch -p1 -R < /tmp/release-package-diff.patch   # revert: restore workspace:* + real names
yarn build                                        # builds all 12 packages via lerna/nx; this is normal
patch -p1 < /tmp/release-package-diff.patch       # restore: back to pinned fork versions
```

`git status --short` should show a clean tree (or only the version-bump changes from
step 3 if you've already done that) after the restore. Confirm with:

```sh
grep -E '"name"|"version"' packages/core/package.json packages/postgres/package.json
```

### 3. Bump the version

Bump the number after `-patch` in **both** `version` fields, and in postgres's
dependency on core (all three must match):

- `packages/core/package.json`: `"version"`
- `packages/postgres/package.json`: `"version"` and `"dependencies"."@sequelize/core"`

`packages/postgres/package.json`'s `"@sequelize/utils"` dependency version does *not*
bump — only core's own alpha version changes per release, not utils'.

### 4. Make sure `.npmrc` targets the public registry

This machine's global `~/.npmrc` points `registry` at the corporate Artifactory
mirror. The user keeps a `~/.npmrc-public` profile for the public registry, symlinked
as `.npmrc` at the repo root — **verify it's an actual symlink**, not a hardlink or
copy (`ls -la .npmrc`; hardlinks/copies silently diverge the moment either file is
edited, e.g. via `sed -i ''` on macOS, which rewrites-and-renames rather than editing
in place).

`~/.npmrc-public` must have an **explicit** `registry=https://registry.npmjs.org/`
line, not just a `//registry.npmjs.org/:_authToken=...` line — a project-level
`.npmrc` only overrides keys it actually sets, so without the explicit `registry=`
line the global config's Artifactory registry silently wins, and you'll build and
attempt to publish to the wrong place (`npm publish --dry-run` first will catch this
in the `Publishing to ...` line — check it says `registry.npmjs.org`, not
`artifactory.workday.com`).

Check login:

```sh
npm whoami --registry=https://registry.npmjs.org/
```

If that 401s (token expired), log in:

```sh
npm login --registry=https://registry.npmjs.org/
```

Run this **with `run_in_background: true`** (or equivalent persistent background
execution) — do not background it with a bare shell `&` across separate tool calls, as
the process can be killed before the user finishes the browser flow. Read the output
file for the login URL, give it to the user, and wait for them to complete it
(including 2FA) before re-checking `npm whoami`.

### 5. Publish

```sh
cd packages/core && npm publish --registry=https://registry.npmjs.org/ --otp=<code>
cd ../postgres && npm publish --registry=https://registry.npmjs.org/ --otp=<code>
```

Each `npm publish` needs its **own fresh OTP** — ask the user for a new code before
each call; a code from a minute ago will likely already be stale by the second
publish. `npm publish --dry-run` (no OTP needed) is useful beforehand to sanity-check
the tarball contents, name, version, and target registry.

Verify both landed (registry reads can lag a few seconds right after publish — retry
once on a 404):

```sh
npm view sequelize-core-papandreou@<version> version --registry=https://registry.npmjs.org/
npm view sequelize-postgres-papandreou@<version> version --registry=https://registry.npmjs.org/
```

### 6. Commit

```sh
git add packages/core/package.json packages/postgres/package.json
git commit -m "Releases sequelize-{core,postgres}-papandreou@<version>"
```

Don't push unless asked — confirm with the user first.

## Gotchas recap

- Never publish without first confirming `npm publish --dry-run`'s "Publishing to
  ..." line says `registry.npmjs.org`.
- `ibm_db`'s install failure on Apple Silicon is expected; don't try to fix it.
- The saved patch file in step 2 must come from a diff taken *before* reverting — the
  same patch is applied in both directions.
- A background `npm login` must survive between tool calls (`run_in_background:
  true`), or the login prompt dies before the user can complete it.
