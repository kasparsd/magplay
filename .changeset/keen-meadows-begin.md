---
"@magplay/server": patch
---

If a reverse proxy serves dist/client/assets itself, give files without a hash in their name (search.js, style.css) no-cache instead of immutable; see docs/http-caching.md. Hashed chunks stay immutable.
