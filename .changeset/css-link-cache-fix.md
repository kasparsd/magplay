---
"@magplay/server": patch
---

Stop caching the resolved asset-link map in memory, so pages always use the current build's hashed CSS and script URLs.
