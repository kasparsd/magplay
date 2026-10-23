# Settings scope copy validation — 2026-10-19

Removed the separate scope note and its styling. The Sources introduction now reads “Sources for search results and Explore on all devices.” The page has no editable browser preferences; speed-test results remain browser-local and the Player retains its hidden preferences. Updated the canonical UI documentation and added a patch release note.

- `npm run typecheck`, `npm run lint`, `npm run build`, `npm run changeset:check` and `git diff --check` passed.
- Browser inspection of `http://localhost:8080/settings` confirmed the combined description, the absence of separate scope notes in Sources, Playback and Storage, and the unchanged browser-local explanation for speed-test results.

Follow-up: removed “on all devices” from the Sources introduction as well. Its final wording is “Sources for search results and Explore.” Updated the canonical UI guidance and pending release note. `npm run build`, `npm run changeset:check` and `git diff --check` passed.
