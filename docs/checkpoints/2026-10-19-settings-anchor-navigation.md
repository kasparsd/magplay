# Settings anchor navigation — 2026-10-19

Removed the Settings section menu and its CSS. Section IDs, heading IDs, hash scrolling and status action destinations remain intact. Canonical UI guidance now specifies direct links without a section menu, and a patch release note records the change.

`npm run typecheck`, `npm run lint`, `npm run changeset:check` and `git diff --check` passed. Three targeted settings browser tests passed after rebuilding the client: menu absence with section anchors intact, direct Playback navigation with dependent controls, and the connection status action linking to Debug.

Browser tests required Chromium and local fixture servers outside the sandbox.
