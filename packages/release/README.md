# @magplay/release

Collects the notes in `.changeset/` and writes the application version, the versions of the packages a note names, the root changelog and those packages' changelogs. Nothing in this package is published to npm. How to write a note, and how a release moves from `main` to a container image, is in [docs/releases.md](../../docs/releases.md).

Run it from the repository root with `npm run release -- <command>`.

```bash
npm run release -- note --patch -m "Seeking past the converted part restarts conversion instead of stalling."
npm run release -- note --package @magplay/playback --minor -m "Seeking restarts conversion."
npm run release -- note --empty
npm run release -- status --since origin/main
npm run release -- version --dry-run
npm run release -- tag
```

## Commands

`note` writes one file under `.changeset/`. The bump is `--patch`, `--minor`, `--major` or `--empty`. A real note needs `-m`. With no `--package`, the note names `@magplay/server`. Repeat `--package` to name workspaces, all at that bump. An empty note is the file with no summary and no package, for a change an operator does not see.

`status` checks the pending notes and prints the application bump and any package bump. With `--since <ref>` it exits 2 when that range adds no note. Notes already on the base do not count, and neither does editing one.

`version` raises `apps/server/package.json` by the highest bump, raises each named package, prepends the combined section to `CHANGELOG.md` and prepends each package's own section to `CHANGELOG.md` beside its manifest. It deletes the notes, including empty ones. It does not commit, tag or touch `package-lock.json`. `--dry-run` prints the result and writes nothing. Empty notes alone change nothing and are left in place. The root entry names each package and its new version once; a note that names only the application is the summary alone.

`tag` creates the lightweight tag `v<version>` at `HEAD` when the changelog has that version. It does not move a tag that already exists. A version with no changelog section, including the `0.1.0` baseline, is left untagged. `--push` sends the tag to `origin` with whatever credentials git already has; in Actions that is the checkout's `GITHUB_TOKEN`.

`--json` prints the result as JSON.

## In GitHub Actions

The CLI runs git and edits files. Everything that talks to GitHub, the pull request, the release and the image build, is a workflow step fed by `--github-output`, which appends to `$GITHUB_OUTPUT`:

| Command | Outputs |
| --- | --- |
| `version --github-output` | `applied` (`true` or `false`); when applied, `title` (`Release <version>`) and the multiline `body` for the pull request |
| `tag --github-output` | `created` (`true` or `false`), `tag` (`v<version>`, or empty with no changelog section) and the multiline `notes` from the changelog |

[prepare-release.yml](../../.github/workflows/prepare-release.yml) passes `title` and `body` to `peter-evans/create-pull-request`. [tag-release.yml](../../.github/workflows/tag-release.yml) passes `tag` and `notes` to `gh release create`, then runs `gh workflow run publish-image.yml --ref <tag>`.

No secret is needed. Pushes, pull requests and releases made with `GITHUB_TOKEN` raise no events that start other workflows, so the workflows dispatch the next one themselves: `workflow_dispatch` is the exception that always runs. The pull request, the tag and the release are attributed to `github-actions[bot]`.
