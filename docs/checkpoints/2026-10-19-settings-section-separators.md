# Settings section separators — 2026-10-19

Removed the top border between adjacent Settings sections. Heading padding and section margins remain unchanged. Canonical UI guidance and a patch release note describe the change.

`npm run build`, `npm run changeset:check` and `git diff --check` passed. Stylesheet inspection confirmed that `.settings-section + .settings-section` retains its margin and no longer sets a border.
