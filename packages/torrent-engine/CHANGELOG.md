# @magplay/torrent-engine

## 0.0.1

### Patch

- Each torrent keeps 2 pieces in memory after a read instead of 20, so a watched torrent no longer holds 70–300 MiB of its pieces afterwards.
