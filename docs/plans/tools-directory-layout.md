# Tools directory layout

Move tooling out of the repository root so operational stuff (docker container
state, repo scripts) lives under `tools/`, keeping the root for the application
itself. `compose.yml` stays in the root; `Dockerfile` stays next to it.

## Decisions

- `./tools/docker/<container>/config/` holds the per-container config that the
  stack mounts (Jackett, Prowlarr). It replaces the old `.local-config/`
  location and stays gitignored, since it is runtime state written by the
  containers.
- `./tools/scripts/` holds repository helper scripts (`check-docker.mjs`,
  `setup-indexers.mjs`). They resolve paths against the repository root via
  `import.meta.url`, so they work from any working directory.
- `compose.yml` stays in the root, and its volume paths point to
  `./tools/docker/*/config` directly.

## Progress

- [x] Move `scripts/*.mjs` to `tools/scripts/` and fix internal paths
- [x] Point compose mounts and setup-indexers at `tools/docker/<container>/config`
- [x] Update `.gitignore` / `.dockerignore` for the new layout
- [x] Update README and canonical docs references
