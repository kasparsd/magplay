# Releases and release notes

magplay has one version: `apps/server/package.json`. The server ships the whole app (the bundled client, the packages, `public/` and the Docker image), so every release note names `@magplay/server`, whatever part of the repository changed. The other workspaces stay at `0.0.0`. Startup logs, `/api/debug` and metrics read the version from that manifest (`apps/server/src/version.ts`).

`@magplay/release` (`packages/release`, run with `npm run release`) collects the notes in `.changeset/` and turns them into the next version and [`CHANGELOG.md`](../CHANGELOG.md) at the repository root. History starts here; `0.1.0` is the baseline, not a published release, and it is not tagged because it has no changelog section.

Nothing is published to npm.

## Adding a note

Add one in the same change as the code:

```bash
npm run release -- note --patch -m "Seeking past the converted part restarts conversion instead of stalling."
npm run release -- note --empty
```

`--empty` needs no summary. Each command writes a file such as `.changeset/brave-cats-sing.md`:

```md
---
"@magplay/server": patch
---

Seeking past the converted part restarts conversion instead of stalling.
```

Write for the person running magplay: what behaves differently, and what they need to do, if anything. Leave out file names and refactoring details. Unrelated changes can have separate notes; a release combines them. Editing a note before release is fine.

**Bump:**

- **patch:** fixes, and compatible operational or dependency changes.
- **minor:** new capabilities. Below `1.0.0`, also changes that break existing configuration or behaviour; say what the operator must change.
- **major:** reserved for the deliberate `1.0.0` release.

**Empty notes** are for refactoring, tests, plans and contributor documentation. They count as "this change needs no release note". A release consumes them without a changelog entry, and they do not open a release pull request on their own. Documentation that corrects operator instructions deserves a real note.

## What CI checks

The `changesets` job runs `npm run release -- status`. On a pull request it passes `--since origin/<base>`, and the job fails when that range adds no note. Notes already on the base do not count, and neither does editing one. The comparison includes the working tree, so a staged note counts before it is committed; an untracked one does not. Pull requests from `release/*` are the prepared version and are not checked.

A push to `main` runs `status` with no `--since`, which only checks that the pending notes are valid: empty, or naming only `@magplay/server` with `patch`, `minor` or `major` and a summary.

Run it locally with `npm run release -- status --since origin/main`.

## What happens on main

A push to `main` that changes `.changeset/`, `packages/release/` or the prepare workflow runs [prepare-release.yml](../.github/workflows/prepare-release.yml). It runs `version --github-output`, which deletes the notes (including empty ones), raises the server version by the highest bump and prepends the changelog section. The step outputs `applied`, `title` and `body`. When `applied` is true, the workflow refreshes `package-lock.json`, opens or updates the pull request on `release/next` with `peter-evans/create-pull-request`, and dispatches the test workflow on that branch. The title is `Release <version>`.

Empty notes alone leave the tree unchanged, so no pull request is opened. They stay until a real note is released with them.

Merging `release/next` runs [tag-release.yml](../.github/workflows/tag-release.yml). `tag --push --github-output` creates `v<version>` at the merge commit when the tag is absent, does not move a tag that already exists, and outputs `created`, `tag` and `notes`. When the tag was created, the workflow runs `gh release create` with the changelog section as the body, then `gh workflow run publish-image.yml --ref v<version>`. [publish-image.yml](../.github/workflows/publish-image.yml) builds and pushes the versioned GHCR image from that tag. Ordinary pushes to `main` still publish `edge`.

No secret is involved. Everything runs with the job's `GITHUB_TOKEN`, so the pull request, the tag and the release are attributed to `github-actions[bot]`. Events raised with that token do not start other workflows, which is why each workflow dispatches the next one itself: `workflow_dispatch` always creates a run. The pull request's own `pull_request` test runs appear as waiting for approval; the dispatched run on `release/next` is the one that counts, and approving the waiting ones is harmless.

The CLI only runs git. It never calls `gh` or the GitHub API; the workflows do that with the step outputs. The outputs are listed in [the package readme](../packages/release/README.md).

`version` and `tag` do not commit. `npm run release -- version --dry-run` prints the plan and leaves the tree alone. `npm run release -- status` lists what is pending.

**Undoing a mistaken `version`** before it is committed: `git checkout -- .changeset apps/server/package.json && git clean -f CHANGELOG.md` (the last part only if the changelog did not exist yet). Check with `git status` that the notes are back.

## First release

Nothing to set up. The first prepare run after this reaches `main` includes every pending note, so the first release pull request is `0.2.0`. `workflow_dispatch` on Prepare release runs it without waiting for another note. Repository settings must allow Actions to create pull requests (Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests").
