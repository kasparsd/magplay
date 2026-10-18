# Magnet link search

- [x] Recognize and validate pasted BitTorrent v1 magnets before searching sources, including hexadecimal and base32 info hashes.
- [x] Show a single result using its display name and preserve the full magnet through opening the torrent.
- [x] Explain magnet input in the search UI and canonical documentation.
- [x] Verify valid and malformed magnets, tracker preservation, and ordinary search behavior.

Validation: `npm test` passed all 208 tests; `npm run typecheck` and `npm run lint` passed; the magnet-search and existing pages Playwright suites passed all six tests. Tests requiring local listeners and Chromium ran outside the filesystem sandbox after sandbox launch/listen restrictions prevented their first run.
