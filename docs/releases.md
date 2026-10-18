# Releases and release notes

magplay has one version: `apps/server/package.json`. The server ships the whole app (the bundled client, the packages, `public/` and the Docker image), so every release note names `@magplay/server`, whatever part of the repository changed. The other workspaces are private, ignored by Changesets and stay at `0.0.0`. Startup logs, `/api/debug` and metrics read the version from that manifest (`apps/server/src/version.ts`).

[Changesets](https://github.com/changesets/changesets) (`@changesets/cli`, pinned in the root `package.json`) collects the notes in `.changeset/` and turns them into the next version and [`apps/server/CHANGELOG.md`](../apps/server/CHANGELOG.md). History starts with adoption; `0.1.0` is the baseline, not a published release.

## Adding a note

Add one in the same change as the code:

```bash
npm run changeset -- --patch @magplay/server -m "Seeking past the converted part restarts conversion instead of stalling."
npm run changeset                       # the same, interactively
npm run changeset -- --empty            # nothing users would notice
```

Each command writes a file such as `.changeset/brave-cats-sing.md`:

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

**Empty notes** (`--empty`) are for refactoring, tests, plans and contributor documentation. They count as "this change needs no release note"; the release consumes them without a bump or changelog entry. Documentation that corrects operator instructions deserves a real note.

## What CI checks

`npm run changeset:check` (`tools/scripts/check-changesets.mjs`) runs in the `changesets` job:

- `.changeset/config.json` ignores every workspace except `@magplay/server`, all workspaces are private, and `fixed`/`linked` are empty. A new workspace fails until it is added to `ignore`.
- Each pending note is empty or names only `@magplay/server` with `patch`, `minor` or `major` and a summary. `changeset status` accepts a note for an ignored package without complaint, so this check is what catches it.
- On a pull request, against the PR base: the branch adds a note, or it is a release. Notes already on the base don't count, and neither does editing one. A release deletes notes and changes only `apps/server/package.json` (with a higher version), `apps/server/CHANGELOG.md` and `package-lock.json` (with the same version).

Run it locally with `npm run changeset:check -- --base origin/main`. It compares the working tree with the merge base, so a staged note counts before it is committed; an untracked one doesn't.

Pushes straight to `main` only get the first two checks, so a direct push still needs its own note.

## Preparing a release

1. On a release branch from an up-to-date `main`, review what is pending with `npm run changeset:status`.
2. Run `npm run release:version`. It runs `changeset version`, which deletes the notes, raises the server version by the highest bump requested and writes the changelog section, then refreshes `package-lock.json`. It doesn't commit, tag or publish.
3. Review the diff (version, changelog section, deleted notes, lockfile only) and run `npm run typecheck`, `npm run lint` and `npm test`. Open a PR; the `changesets` job validates it as a release.
4. After merging, publish a GitHub Release tagged `v<version>` at the merge commit, with the changelog section as its body. [`publish-image.yml`](../.github/workflows/publish-image.yml) builds and pushes the versioned GHCR image from it. Check that the tag, `apps/server/package.json` and `/api/debug` agree.

Ordinary pushes to `main` keep publishing `edge` without consuming notes or changing the version. Don't use `changeset publish`; nothing goes to npm.

**Undoing a mistaken `release:version`** before it is committed: `git checkout -- .changeset apps/server/package.json package-lock.json && git clean -f apps/server/CHANGELOG.md` (the last part only if the changelog didn't exist yet). Check with `git status` that the notes are back.

## Not automated

Release PRs, tags, GitHub Releases and prereleases are manual. Automating them later needs the Changesets action generation that matches v3, and a token other than `GITHUB_TOKEN` if the release should trigger other workflows.
