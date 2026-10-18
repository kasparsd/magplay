---
"@magplay/server": patch
---

Scripts and the stylesheet are now served under content-hashed `/assets/…` URLs that caches may keep for good, and pages always revalidate, so a new release shows up on reload even behind a caching reverse proxy. Purge any proxy cache stored with an overridden TTL once after upgrading.
