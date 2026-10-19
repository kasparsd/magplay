# Application releases validation — 2026-10-19

Evidence for replacing Changesets with `@magplay/release`. The procedure is canonical in [releases](../releases.md).

- **Notes.** The pending `.changeset/` files parse. A note is empty or names only `@magplay/server` with `patch`, `minor` or `major` and a summary. `npm run release -- status` reports `0.1.0 → 0.2.0 (minor)` from the notes already on this branch, including eight empty notes that do not raise the version.
- **Version dry run.** `npm run release -- version --dry-run` printed the same bump and left `apps/server/package.json` and `CHANGELOG.md` untouched. In a fixture, applying a minor note and a patch note wrote `0.2.0`, a changelog section with both groups, and deleted the notes including an empty one. The fixture lockfile was not modified. A second apply did nothing. Empty notes alone did not write a changelog.
- **Tag.** In a temporary repository, `0.1.0` with no changelog section created no tag. After a `0.2.0` section was committed, `tag` created `v0.2.0` and a second run left that tag in place (`git tag --list` stayed `v0.2.0`).
- **Status.** A range that does not add a note exits 2. Editing an existing note does not count, and adding `.changeset/README.md` does not count. `npm run release -- note` writes a changeset file.
- **Workflows.** Prepare release runs `version --github-output`, which sets `applied`, `title` and `body`. Tag release runs `publish`, which pushes `v<version>` and publishes the GitHub Release. Neither workflow assembles that result in shell.
- **Checks.** `npm test` passed, 269 tests. `npm run typecheck` and `npm run lint` passed. `git diff --check` passed.
- **Not done.** `RELEASE_TOKEN` is not created here. Until it is, the prepare and tag workflows log and skip. `publish-image.yml` is unchanged.
