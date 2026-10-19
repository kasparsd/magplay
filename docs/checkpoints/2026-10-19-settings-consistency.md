# Settings consistency validation — 2026-10-19

Implemented the eight cleanup suggestions from the visual review: source-specific guidance and filter visibility, no edit prompts on locked empty inputs, resolution controls that follow the transcode toggle, current Playback copy, compact mobile Debug metrics and resource disclosures, readable log summaries, explicit action labels, and section jump links. Lasting behavior is recorded in `docs/user-interface.md` and `docs/architecture.md`.

- `npm run typecheck` passed.
- `npm run lint` passed.
- `npm test` passed all 232 tests.
- `npm run test:e2e -- tests/e2e/settings.test.js` passed all 11 tests. Added coverage verifies source values survive type changes and saving, hidden filters reappear with their previous value, resolution survives draft toggles and discard, navigation scrolls to its section, resource disclosures remain expanded during polling, and mobile server facts occupy two columns.
- `npm run build`, `npm run changeset:check` and `git diff --check` passed.
- Browser screenshots at 1280 × 900 and 375 × 812 confirmed the source form, section navigation, inactive resolution controls, and collapsed/expanded mobile Debug layout. The disabled control is dimmed while its explanatory text remains readable.

Unit and browser suites ran outside the sandbox to permit local fixture ports and Chromium startup. The visual pass used `http://localhost:8080/settings` without saving changes to the running server's settings.
