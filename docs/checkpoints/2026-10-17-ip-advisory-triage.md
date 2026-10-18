# `ip` advisory triage (GHSA-2p57-rm9w-gvfp)

Date: 2026-10-17. Chain: `ip@2.0.1` ← `bittorrent-tracker@11.2.3` ← `torrent-discovery@11.0.21` ← `webtorrent@3.0.21`.

## Call paths

- `grep` of `bittorrent-tracker`, `torrent-discovery` and `webtorrent` for imports of `ip` finds one:
  `bittorrent-tracker/lib/server/parse-udp.js`, which calls `ipLib.toString(ip)` on the optional IP field of a UDP announce.
- That parser belongs to the tracker *server* (`server.js`).
  `torrent-discovery` imports `{ Client }` from the package entry, which loads `server.js` as a module but never starts a server.
- magplay's own code never imports `ip`, and starts a tracker server only in `tests/integration/peers.test.js` (loopback, test-only).
- `isPublic` and `isPrivate`, the vulnerable classifiers, are not called anywhere in the chain.

## Exposure

The advisory is an SSRF misclassification by `isPublic`; with no caller, nothing in the production dependency path is affected.
Tracker and peer addresses from the swarm are never passed to `ip`.

## Fix options

- All three packages are at their latest releases; `npm view ip` shows 2.0.1 as latest with no patched version.
- `npm audit fix --force` proposes `bittorrent-tracker@0.7.3`, an incompatible downgrade; rejected.
- An `overrides` shim or replacement for `ip` would be an unmaintained-API swap for code that never runs; not worth the risk.

## Decision

Accept. No dependency changes, so no test or Docker re-run was needed.
Revisit if upstream replaces `ip` or magplay ever runs a tracker server.
