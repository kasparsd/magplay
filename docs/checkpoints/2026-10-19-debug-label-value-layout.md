# Debug label–value layout — 2026-10-19

Replaced the Debug fact and resource grid with one label–value pair per row. Labels align left and values align right, using the same layout on desktop and phone. Resource disclosures, meters and live updates remain in place. Canonical UI guidance and a patch release note describe the change.

- `npm run typecheck`, targeted ESLint checks, `npm run changeset:check` and `git diff --check` passed.
- Two browser checks passed after rebuilding the client: expanded Debug groups/log records survive polling, and server facts occupy label–value rows at 1100 px and 375 px.
- The initial browser run lost trace files during concurrent test activity. Rerunning with `--output /tmp/madplay-debug-label-value-tests` passed both checks.
- Browser screenshots confirmed server facts and expanded resource rows at desktop and 375 px phone widths.

Browser tests required Chromium and local fixture servers outside the sandbox.
