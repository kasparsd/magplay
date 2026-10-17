# Settings and status browser verification — 2026-10-17

This is local browser-test evidence for the Settings/status implementation, not canonical UI guidance or a production-device acceptance claim.

`npm run test:e2e -- --grep "status indicator"` passed against the isolated Chromium fixture. The test verifies the separate status indicator and direct Settings control, readable binary-check rows, an environment-locked source, saving and retaining a live server setting, `#debug` deep-link scrolling, the absence of the stray `0` text node in Debug, and refusal of a cross-origin settings write.

- [Status menu screenshot](2026-10-17-settings-status-e2e/status-menu.png)
- [Settings Debug screenshot](2026-10-17-settings-status-e2e/settings-debug.png)

The fixture deliberately lacks BitMagnet, so the amber Explore warning and its count of one in both screenshots are expected.
