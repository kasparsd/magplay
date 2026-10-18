---
---

Copy the shared `tsconfig.base.json` into the Docker build stage so esbuild bundles the client with the project's compiler options instead of warning about a missing base config.
