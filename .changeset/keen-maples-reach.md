---
"@magplay/server": minor
---

No trackers are added to torrents by default any more. magplay used to add five public UDP trackers to every torrent, which told five third parties what you open, and it did so for private torrents too. Set EXTRA_TRACKERS to a comma-separated list to restore that for public torrents; torrents flagged private now never get them. Magnets with no trackers of their own find peers through DHT until you set a list.
