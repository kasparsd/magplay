# Settings copy validation — 2026-10-19

Rewrote settings labels and help to name the setting, action or effect directly. Examples include “Applies to all devices”, “Source URL”, “Convert unsupported video”, “Minimum free disk space” and “Conversion cache limit”. Removed vague section descriptions and the speed test's claim that any streamed file would play. The healthy speed result names the actual download and latency thresholds. Canonical wording guidance is in `docs/user-interface.md`; the change has a patch release note.

- `npm run build`, `npm run typecheck`, `npm run lint`, `npm run changeset:check` and `git diff --check` passed.
- `npm test` passed all 232 tests after updating the expected source URL validation message.
- `npm run test:e2e -- tests/e2e/settings.test.js` passed all 11 tests on the final run. An earlier run timed out waiting for the saved notification to disappear; it passed unchanged on rerun.
- Reviewed the page at 1280 × 900 and 375 × 812. The longer storage labels and help fit on phones, and the Playback and Connection descriptions remain readable on desktop.
- Reviewed the copy against the no-ai-slop editing checklist: direct labels, concrete instructions, no promotional claims or conversational filler.

Test execution required local port binding and Chromium outside the sandbox. The visual pass did not save changes to the running server's settings.
