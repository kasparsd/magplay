---
"@magplay/server": patch
---

The Docker images cap the Node heap at 128 MiB, so the server stays inside a small container's memory limit without extra settings. Set NODE_OPTIONS to change it.
