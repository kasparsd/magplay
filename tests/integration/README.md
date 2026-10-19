# Loopback peer integration

```sh
npm run test:peers
```

This Node suite uses an actual WebTorrent TCP seeder, an HTTP tracker bound to 127.0.0.1 and the application in a child process with an **empty** temporary torrent cache. Test data is generated locally; no ffmpeg, browser, public tracker, indexer or internet peer is required. DHT and local multicast discovery are disabled for both clients.

It verifies:

- Magnet metadata retrieval and real missing-piece transfer, ranged bytes and a full-file SHA-256 match.
- A disappearing seeder, stalled raw **and tar** requests, prompt reader release after client cancellation, continued health responses, and a successful new request after the seeder returns.
- A dead swarm's 504 deadline, responsiveness while waiting, and retry after the failed shared load is cleared.

The status API's `activeStreams` field counts active raw/tar responses and is used to check cancellation; it is not a peer count. Completed files report 100% even for exact piece-boundary file lengths, where the dependency's fractional progress can otherwise undercount the last piece.

`DHT_ENABLED=false` and `LSD_ENABLED=false` are also available in normal deployments when only explicitly configured trackers/peers should be used. Both default to enabled. Disabling them reduces discovery options; the tracker is still required for these tests.

Metadata discovery retains its separate `METADATA_TIMEOUT_S` deadline. Once metadata is known, `TORRENT_CHECK_TIMEOUT_S` bounds piece verification (default **7200 seconds**, deliberately much longer for large files on slow storage). Increase this for representative server hashing times rather than shrinking it to the peer-discovery deadline. Timeout/error/close cleanups have colocated unit tests in `packages/torrent-engine/src/ready.test.ts`.

The suite is deterministic about local endpoints and test data, not network scheduling. All clients, child processes, tracker listeners and temporary files are cleaned up. It does not exercise public DHT interoperability, NAT, remote tracker behavior, or real server throughput.

The torrent-engine and server implementations are strict TypeScript with type-aware linting. This external integration harness remains JavaScript and converts on touch; its real peer behavior complements the typed colocated factory/lifecycle tests.
