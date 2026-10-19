---
"@magplay/server": patch
---

Reuse cached torrent data when reopening a previously viewed torrent: save file mtimes after the first load and pass them back on reload so WebTorrent trusts the cached pieces instead of re-hashing or re-fetching them from peers.
