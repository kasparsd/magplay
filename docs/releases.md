# Releases and release notes

magplay has one application version: `apps/server/package.json`. The server ships the whole app (the bundled client, the packages, `public/` and the Docker image), so a release tags that version and the root [`CHANGELOG.md`](../CHANGELOG.md) is what the GitHub Release and the image describe. Startup logs, `/api/debug` and metrics read it from that manifest (`apps/server/src/version.ts`). `0.1.0` is the baseline, not a published release, and `0.2.0` is the first tagged release. Nothing is published to npm yet.

A workspace other than the server stays at `0.0.0` until a note names it. Naming one bumps that package, writes `CHANGELOG.md` beside its manifest, and still bumps the application, because the change ships in the image. The root changelog lists that package change once, with the package's new version. The package changelog keeps the same summary under the package's own version. A note that names only `@magplay/server` is an application change: it has no package changelog, and the root entry is the summary alone.

`@magplay/release` (`packages/release`, run with `npm run release`) collects the notes in `.changeset/` and writes these versions and changelogs.

## Adding a note

Add one in the same change as the code:

```bash
npm run release -- note --patch -m "Seeking past the converted part restarts conversion instead of stalling."
npm run release -- note --package @magplay/playback --package @magplay/api-contract --minor -m "Seeking restarts conversion."
npm run release -- note --empty
```

With no `--package`, the note names `@magplay/server`. Repeat `--package` to name workspaces; every named package takes that one bump. `--empty` needs no summary and names no package. Each command writes a file such as `.changeset/brave-cats-sing.md`:

```md
---
"@magplay/playback": minor
"@magplay/api-contract": minor
---

Seeking restarts conversion.
```

A hand-written note may give the packages different bumps. The root changelog groups the entry under the highest of them, and each package changelog uses its own. The released root section reads:

```md
### Minor

- `@magplay/api-contract` 0.1.0, `@magplay/playback` 0.1.0: Seeking restarts conversion.
```

Write for the person running magplay: what behaves differently, and what they need to do, if anything. Leave out file names and refactoring details. The same summary is copied into each named package's changelog, so it has to make sense there too. Unrelated changes can have separate notes; a release combines them. Editing a note before release is fine.

**Bump:**

- **patch:** fixes, and compatible operational or dependency changes.
- **minor:** new capabilities. Below `1.0.0`, also changes that break existing configuration or behaviour; say what the operator must change.
- **major:** reserved for the deliberate `1.0.0` release.

**Empty notes** are for refactoring, tests, plans and contributor documentation. They count as "this change needs no release note". A release consumes them without a changelog entry, and they do not open a release pull request on their own. Documentation that corrects operator instructions deserves a real note.

## What CI checks

The `changesets` job runs `npm run release -- status`. On a pull request it passes `--since origin/<base>`, and the job fails when that range adds no note. Notes already on the base do not count, and neither does editing one. The comparison includes the working tree, so a staged note counts before it is committed; an untracked one does not. Pull requests from `release/*` are the prepared version and are not checked.

A push to `main` runs `status` with no `--since`, which only checks that the pending notes are valid: empty, or naming the application or a workspace in this repository with `patch`, `minor` or `major` and a summary.

Run it locally with `npm run release -- status --since origin/main`.

## What happens on main

A push to `main` that changes `.changeset/`, `packages/release/` or the prepare workflow runs [prepare-release.yml](../.github/workflows/prepare-release.yml). It runs `version --github-output`, which deletes the notes (including empty ones), raises the application version by the highest bump, bumps each named package, and prepends the root changelog section and those packages' changelogs. The step outputs `applied`, `title` and `body`. When `applied` is true, the workflow refreshes `package-lock.json`, opens or updates the pull request on `release/next` with `peter-evans/create-pull-request`, and dispatches the test workflow on that branch. The title is `Release <version>`.

Empty notes alone leave the tree unchanged, so no pull request is opened. They stay until a real note is released with them.

Merging `release/next` runs [tag-release.yml](../.github/workflows/tag-release.yml). `tag --push --github-output` creates `v<version>` at the merge commit when the tag is absent, does not move a tag that already exists, and outputs `created`, `tag` and `notes`. When the tag was created, the workflow runs `gh release create` with the changelog section as the body, then `gh workflow run publish-image.yml --ref v<version>`. [publish-image.yml](../.github/workflows/publish-image.yml) builds and pushes the versioned GHCR image from that tag. Ordinary pushes to `main` still publish `edge`.

No secret is involved. Everything runs with the job's `GITHUB_TOKEN`, so the pull request, the tag and the release are attributed to `github-actions[bot]`. Events raised with that token do not start other workflows, which is why each workflow dispatches the next one itself: `workflow_dispatch` always creates a run. The pull request's own `pull_request` test runs appear as waiting for approval; the dispatched run on `release/next` is the one that counts, and approving the waiting ones is harmless.

The CLI only runs git. It never calls `gh` or the GitHub API; the workflows do that with the step outputs. The outputs are listed in [the package readme](../packages/release/README.md).

`version` and `tag` do not commit. `npm run release -- version --dry-run` prints the plan and leaves the tree alone. `npm run release -- status` lists what is pending.

**Undoing a mistaken `version`** before it is committed: restore `.changeset/`, `apps/server/package.json`, `CHANGELOG.md`, and any package `package.json` or `CHANGELOG.md` shown by `git status`. Check that the notes are back.

## Repository setting

Actions has to be allowed to create pull requests (Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests"). `workflow_dispatch` on Prepare release runs it without waiting for another note.
