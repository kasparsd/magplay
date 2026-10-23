# Speed test in Debug validation — 2026-10-19

Moved the speed-test results and action into a Debug card between Server and Log. Removed the Connection section and its navigation link. Connection status actions now link to `/settings#debug`, and a slow result marks the Debug heading with a warning dot. Browser-local result storage is unchanged. Canonical UI, architecture and roadmap references were updated, and the change has a patch release note.

- `npm run typecheck` and `npm run lint` passed.
- `npm run test:e2e -- tests/e2e/settings.test.js` built the client and passed all 11 tests, including test execution in Debug, four-section navigation, and following a slow-connection status link to Debug with its warning dot.
- `npm run changeset:check` and `git diff --check` passed.
- Browser inspection confirmed the Speed test card below the Server card and above Log at `http://localhost:8080/settings#debug`.

Browser tests required Chromium and local fixture servers outside the sandbox.
