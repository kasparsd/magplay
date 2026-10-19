# Settings follow-ups validation — 2026-10-19

Completed the four follow-ups from the settings review. Source headings and Test button names update from the URL hostname while typing without replacing focused inputs; URL credentials are excluded from those names. The speed-test card and status menu share warnings that identify the failed download-speed or latency limit without guessing a network cause. Source field presentation and conversion resolution dependencies now use declarative schema rules through one client resolver. Save confirmations track an expiry deadline, cancel old timers on edits or subsequent saves, and check expiry when the page becomes visible or is shown again.

The earlier save timeout did not establish a failed save or a reproducible timer bug. Save assertions now use a controlled browser clock instead of waiting for a real-time notification to disappear. Added regression checks cover expiry boundaries, edits during a confirmation, consecutive saves, and returning after a deadline without running the timer.

- `npm test` passed all 236 tests, including new schema-rule and connection-warning tests.
- The settings browser suite passed 13 checks covering source names, retained focus and values, warnings, schema dependencies and confirmation timing. A fourteenth environment-lock check passed on a targeted rerun after correcting its cleanup assertion: toggling back to the saved value hides the save bar, so there is no Discard button to click.
- `npm run typecheck`, `npm run lint`, `npm run changeset:check` and `git diff --check` passed. Browser test commands rebuilt the client.
- Canonical behavior and implementation details are updated in `docs/user-interface.md` and `docs/architecture.md`. A patch release note accompanies the fixes.

Unit and browser tests ran outside the sandbox to permit local fixture ports and Chromium startup.
