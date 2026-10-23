# Package changelogs validation — 2026-10-19

Evidence for notes that name workspaces. The procedure is canonical in [releases](../releases.md).

- **Application notes.** A note that names only `@magplay/server` still bumps `apps/server/package.json` and writes the summary alone into the root changelog. No `apps/server/CHANGELOG.md` is created. Empty notes alone still write nothing.
- **Package notes.** In a fixture, one note naming `@magplay/playback` minor and `@magplay/http-kit` patch bumped the application `0.1.0` to `0.2.0`, playback `0.0.0` to `0.1.0` and http-kit `0.0.0` to `0.0.1`. The root section listed both packages and the summary once, under Minor. Each package changelog used that package's own bump and the bare summary. The fixture lockfile was unchanged.
- **This repository.** `loadWorkspaces` finds `@magplay/server` and `@magplay/api-contract`. Pending notes have no problems. `0.2.0` in the root changelog is left as it was released.
- **Checks.** `npm test` passed, 270 tests. `npm run typecheck` and `npm run lint` passed. `git diff --check` passed.
