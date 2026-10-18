# Changesets and application changelog

## Goal and status

Created 2026-10-18. Implemented 2026-10-18; operating decisions now live in [docs/releases.md](../releases.md), and this file keeps the tasks and evidence. Capture user-facing changes alongside the code, then use Changesets to assemble one application changelog and calculate the next application version. Keep releases deliberate and reuse the existing Docker publishing workflow.

## Findings

- [x] Inspect package layout, version consumers, tests, Docker packaging and image publishing.
- [x] Check current upstream Changesets documentation and CLI behavior.
- [x] Choose the release unit, contributor workflow, implementation sequence and acceptance criteria.

The root `magplay` package is private, has version `0.1.0` and defines npm workspaces under `apps/*` and `packages/*`. Every workspace is private and currently uses `0.0.0`. The server's `main.ts` and `app.ts` both read the root version for startup/diagnostics. There is no Changesets configuration or changelog, and no local release tags were found during planning.

`.github/workflows/publish-image.yml` publishes `edge` on pushes to `main` and versioned multi-platform images when a GitHub Release is published. It already accepts `vX.Y.Z` release tags and prereleases. `.github/workflows/test.yml` runs unit, peer, browser, type and lint checks. There are ongoing logging changes in the working tree; implementation must accommodate those edits, especially in bootstrap, app creation and manifests.

## Proposed decisions

### One application release

Use `@magplay/server` as the sole versioned workspace because the server delivers the complete app, including the bundled client. All changesets target that package, including changes in client code, internal packages, `public/`, Docker and dependencies when they affect users. Internal modules do not need independent versions or changelogs.

Changesets discovers workspace packages separately from the repository root, so simply adding a changeset for root package `magplay` is not the proposed approach. Move the existing application baseline `0.1.0` to `apps/server/package.json`, remove the unused root version, and update both runtime readers to the server manifest. Keep the server private. Confirm this behavior with the pinned CLI in a disposable fixture before applying it to the app.

The canonical generated changelog will be `apps/server/CHANGELOG.md`, linked prominently from the root README and release documentation. Keep one file at Changesets' natural package location; a duplicate root changelog or relocation script adds unnecessary synchronization. Start recording changes from adoption onward; do not reconstruct release history from old commits or represent the `0.1.0` baseline as a published release.

### Configuration and commands

Pin `@changesets/cli` as a root development dependency. Upstream currently documents v3.0.3; confirm the stable version and Node/npm requirements when implementing. Use the matching configuration schema and avoid copying v2 automation examples into a v3 setup.

Initialize `.changeset/config.json` with these choices:

- `baseBranch: "main"`, `commit: false`, `access: "restricted"`.
- `privatePackages: { "version": true, "tag": false }` so the app is versioned without package-style tags or npm publication.
- Explicitly list every workspace except `@magplay/server` in `ignore`, and validate new workspace additions against this policy.
- Empty `fixed` and `linked` groups; retain existing `*` internal dependency ranges.
- Built-in `@changesets/cli/changelog` output, avoiding GitHub API credentials for local versioning.
- `format: false` so generated Markdown follows the repository's soft-line-break convention; verify output with the selected CLI.

Expose root scripts for `npm run changeset`, `npm run changeset:status` and `npm run release:version`. The version command runs `changeset version` and refreshes `package-lock.json` with `npm install --package-lock-only --ignore-scripts`. Keep versioning explicit, with no automatic commits, tags, releases or npm publish command.

### Contributor workflow and release policy

For a user-visible change, add a small Markdown changeset in the same PR or coherent change as the implementation. Select `@magplay/server` and write a user-facing summary explaining the changed behavior. Avoid file lists and internal refactoring details. Separate changesets are useful for unrelated changes; Changesets combines them when preparing a release.

Use patch for fixes and compatible operational/dependency changes, minor for new capabilities, and major for incompatible application behavior or configuration. While below `1.0.0`, intentionally use minor for breaking changes and clearly describe the operator action in the note; reserve a major bump for the deliberate `1.0.0` release. Pure refactoring, tests, planning and contributor documentation can use an empty changeset (`npm run changeset -- --empty`) to record that no release note is required. Documentation correcting operator instructions can warrant a normal changeset.

The initial release sequence is manual:

1. On a clean release branch containing the intended changes, inspect pending notes with `npm run changeset:status`.
2. Run `npm run release:version`, review the calculated server version, changelog entry, consumed changesets and lockfile, and run the required checks.
3. Merge the reviewed release commit/PR into `main` after CI passes.
4. Publish a GitHub Release tagged `v<server-version>` at that exact commit, using the corresponding changelog section as its body. Check that the tag, manifest and notes agree.
5. Confirm the existing workflow publishes the expected versioned GHCR image. Ordinary `main` pushes continue to publish `edge` without consuming changesets or bumping versions.

Do not use `changeset publish`; this app ships through GHCR. Defer automated release PRs, release creation and prerelease orchestration. If automated later, use the action generation matching the CLI and explicitly handle GitHub's restrictions on workflows triggered by the built-in token.

### CI policy

Add a separate read-only PR job with full Git history and the actual PR base available. Validate Changesets configuration, parse pending changesets and reject targets other than `@magplay/server`. Require each ordinary PR to add a valid changeset, either a release note or an explicit empty changeset. Compare against the PR base so existing notes on `main` do not satisfy a new PR. This also covers changes outside the server workspace, which package-based change detection alone would miss.

Allow a release-preparation PR to consume notes without adding another note, but validate its diff: it must consume existing notes, advance the server version, update the generated changelog and synchronize the lockfile, with no unrelated source changes. Do not exempt a PR solely because its branch has a particular name. Check newly added workspaces against the single-versioned-package policy so they cannot silently become another release unit. Verify how `changeset status` handles empty notes before choosing the exact check; do not assume it enforces this policy by itself.

## Implementation tasks

### 1. Prove the package model and install

- [x] In a temporary workspace fixture, verify the pinned CLI discovers only the server as releasable, supports the chosen private-package/ignore configuration and generates only the server changelog.
- [x] Pin the CLI, add configuration and root scripts, and update the lockfile.
- [x] Move the version baseline to the server and update bootstrap/app version readers together, accommodating current logging work.
- [x] Ensure the server manifest is available at the chosen relative path in the source checkout and production image; Docker already copies `apps/server/`.

### 2. Document and enforce contribution policy

- [x] Create canonical `docs/releases.md` with authoring examples, bump policy, empty-note policy, commands, release procedure and recovery from an uncommitted mistaken version run.
- [x] Link the generated changelog and release guide from the README. Add a short release-note requirement to `AGENTS.md`, referencing the guide rather than duplicating it.
- [x] Keep `.changeset/README.md` as a brief pointer to the canonical guide.
- [x] Add the read-only CI check and verify normal notes, empty notes, malformed notes, wrong targets, missing notes, unrelated existing notes and valid/invalid release-preparation diffs.
- [x] Add one patch changeset for the delivered changelog/release workflow; do not consume it or cut a release as part of setup.

### 3. Verify the full versioning path

- [x] In an isolated copy, exercise patch and combined patch/minor notes: verify the calculated version, generated entries, note consumption and unchanged internal package versions.
- [x] Confirm an empty-only change produces no version bump/changelog entry and document the pinned CLI's behavior for that case.
- [x] Refresh the lockfile, run `npm ci` in the isolated copy and confirm a second lockfile refresh has no diff.
- [x] Verify startup logs and `/api/debug` report the server manifest version; use focused tests around the version source where useful.
- [ ] Run `npm run typecheck`, `npm run lint` and `npm test` *(done)*; use existing Docker acceptance tooling to confirm the production image starts and reports that same version *(not done: see the log)*. Add peer/browser checks if implementation touches behavior covered by those suites.
- [x] Review workflow triggers and image tag compatibility without publishing a release or pushing an image during local verification.
- [x] Update this plan's todos with actual validation results and leave delivered operating decisions in `docs/releases.md`.

## Acceptance

- [x] A contributor can add one note for any app change without learning the internal package graph.
- [x] One explicit command produces one application version and one changelog, preserving all summaries and choosing the highest requested bump.
- [x] The release version has one manifest source and agrees with startup/Debug output and the intended `vX.Y.Z` release tag. *(Source checkout verified; the production image not yet.)*
- [x] PR checks accept intentional no-release work, reject missing or invalid notes, and permit validated release preparation.
- [x] All packages remain private; the existing `edge`/versioned-image workflow remains usable.
- [x] No release is published as a side effect of installing Changesets or adding a note.

## References

- [Changesets for applications and Docker images](https://changesets.dev/guide/beyond-npm): private application versioning and ignored private dependencies.
- [Configuration reference](https://changesets.dev/guide/config): private packages, changelog generation and formatting.
- [CLI reference](https://changesets.dev/guide/cli): adding notes, status and explicit versioning.
- [Current CLI package manifest](https://github.com/changesets/changesets/blob/main/packages/cli/package.json): version and engine requirements; recheck at implementation time.
- [Current Changesets Action](https://github.com/changesets/action): generation compatibility and automation options, for a possible later phase.

## Validation log

2026-10-18, `@changesets/cli` 3.0.3 (latest; engines Node `^22.11 || ^24 || >=26`, npm `>=10.9`):

- **Fixture** (root plus `@magplay/server` and one ignored private package, with this repository's config): `changeset -m … --patch @magplay/server` writes a note without prompting. `--patch` with an ignored package fails ("not found in the project"). `status` fails on an unknown package or an invalid bump, but **accepts a hand-written note for an ignored package**, which `check-changesets.mjs` rejects. `status --since=main` exits 0 when a branch has no notes, so it can't enforce "a note per PR"; the script compares the PR diff instead.
- **Versioning:** a patch plus a minor note give `0.1.0` → `0.2.0`, a changelog with "Minor Changes" and "Patch Changes" sections (each entry prefixed with its commit), both notes consumed, and internal packages left at `0.0.0`. `format: false` leaves soft line breaks alone. An empty-only release deletes the note with no bump and no changelog file.
- **Release dry run** in a clone of this branch: `npm run release:version` changed only the notes, `apps/server/package.json`, `apps/server/CHANGELOG.md` and `package-lock.json`. `check-changesets.mjs --base <pre-release commit>` accepted it, and rejected it once `apps/server/src/app.ts` was also changed. `npm ci` and a second `npm install --package-lock-only` left the lockfile unchanged.
- **Checks:** unit tests for the rules in `tools/scripts/check-changesets.test.mjs` (now in `npm test`, 223 tests). Typecheck and lint pass. A source-checkout server reported `0.1.0` in all startup log lines and in `/api/debug`.
- **Not done:** the Docker acceptance run. The daemon started in the session container, but `apk add ffmpeg` couldn't download through the session's network proxy. The runtime stage copies `apps/server/`, which holds the manifest `version.ts` reads; confirm with `node tools/scripts/check-docker.mjs` before the first versioned release.
- **Workflows:** `publish-image.yml` is unchanged; `edge` still comes from `main` and versioned images from `v*` GitHub Releases. The new `changesets` job in `test.yml` only reads (checkout with full history, Node, the script).

