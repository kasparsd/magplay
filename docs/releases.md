# Releases

`@magplay/server` carries the application version. That package ships the server and the bundled client. Other workspaces stay private at `0.0.0` and are not published. Nothing is published to npm.

The changelog people read is [CHANGELOG.md](../CHANGELOG.md) at the repository root. Changesets writes a package changelog beside the versioned package, so `apps/server/CHANGELOG.md` is a link to that file.

## Add a note

```sh
npm run changeset
```

That is the Changesets prompt. Choose `@magplay/server`. Use `patch` for a fix or a compatible operational change, `minor` for a new capability, and `major` only for the deliberate `1.0.0` release. Below `1.0.0`, describe a breaking change as `minor` and say what the operator must do. Use `npm run changeset -- --empty` for refactoring, tests, planning, or contributor-only documentation.

Write the summary as one paragraph about the changed behavior. A pull request must add a new note; a note already on `main` does not count.

`npm run changeset:status` lists pending notes.

## Prepare a version

```sh
npm run release:version
```

That runs `changeset version` and refreshes the lockfile. Review the server version, the root changelog, the consumed notes, and the lockfile. Other package versions stay `0.0.0`. If the command was a mistake and is not committed:

```sh
git restore apps/server/package.json CHANGELOG.md package-lock.json .changeset
```

An empty-only run consumes the empty notes and does not change the version or changelog.

Merging notes to `main` makes the [release workflow](../.github/workflows/release.yml) open a version pull request. Enable **Allow GitHub Actions to create and approve pull requests**. A pull request opened by the built-in token does not start other workflows.

Merging that pull request leaves no notes. The next push creates a GitHub release tagged `v<server version>` and tags `ghcr.io/kasparsd/magplay` with `X.Y.Z` and `X.Y` (`X` is added from `1.0.0`; a prerelease gets only its exact tag). The image step is in the release workflow because a release created by the built-in token does not trigger [publish-image.yml](../.github/workflows/publish-image.yml). Pushes to `main` still move `edge` without consuming notes.

`npm run release:publish` creates that GitHub release in Actions. Do not run `changeset publish`.
