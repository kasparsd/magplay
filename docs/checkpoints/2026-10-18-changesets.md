# Changesets adoption validation — 2026-10-18

Evidence for adopting Changesets. The release policy and procedure are canonical in [releases](../releases.md).

2026-10-18, `@changesets/cli` 3.0.3 (latest; engines Node `^22.11 || ^24 || >=26`, npm `>=10.9`):

- **Fixture** (root plus `@magplay/server` and one ignored private package, with this repository's config): `changeset -m … --patch @magplay/server` writes a note without prompting. `--patch` with an ignored package fails ("not found in the project"). `status` fails on an unknown package or an invalid bump, but **accepts a hand-written note for an ignored package**, which `check-changesets.mjs` rejects. `status --since=main` exits 0 when a branch has no notes, so it can't enforce "a note per PR"; the script compares the PR diff instead.
- **Versioning:** a patch plus a minor note give `0.1.0` → `0.2.0`, a changelog with "Minor Changes" and "Patch Changes" sections (each entry prefixed with its commit), both notes consumed, and internal packages left at `0.0.0`. `format: false` leaves soft line breaks alone. An empty-only release deletes the note with no bump and no changelog file.
- **Release dry run** in a clone of this branch: `npm run release:version` changed only the notes, `apps/server/package.json`, `apps/server/CHANGELOG.md` and `package-lock.json`. `check-changesets.mjs --base <pre-release commit>` accepted it, and rejected it once `apps/server/src/app.ts` was also changed. `npm ci` and a second `npm install --package-lock-only` left the lockfile unchanged.
- **Checks:** unit tests for the rules in `tools/scripts/check-changesets.test.mjs` (now in `npm test`, 223 tests). Typecheck and lint pass. A source-checkout server reported `0.1.0` in all startup log lines and in `/api/debug`.
- **Not done:** the Docker acceptance run. The daemon started in the session container, but `apk add ffmpeg` couldn't download through the session's network proxy. The runtime stage copies `apps/server/`, which holds the manifest `version.ts` reads; confirm with `node tools/scripts/check-docker.mjs` before the first versioned release.
- **Workflows:** `publish-image.yml` is unchanged; `edge` still comes from `main` and versioned images from `v*` GitHub Releases. The new `changesets` job in `test.yml` only reads (checkout with full history, Node, the script).
