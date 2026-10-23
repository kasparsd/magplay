# Source status styling — 2026-10-19

Source status previously used the shared bordered `.badge` style also used for release metadata. It now uses muted text and a colored status dot without a border, background or pill padding. The Test button remains a separate action. Removed the now-unused status-specific badge border rules, updated the canonical UI guidance, and added a patch release note.

- `npm run typecheck` passed.
- Targeted ESLint checks for `apps/client/src/settings.ts` and `apps/client/src/lib/controls.ts` passed. Repository-wide lint found two formatting errors in concurrently edited `packages/torrent-engine/src/engine.test.ts`; those unrelated edits were left intact.
- Two targeted browser tests passed after rebuilding the client: a broken source still reports failure and links to Sources, and environment sources retain their status/action layout and read-only fields.
- `npm run changeset:check` and `git diff --check` passed.
- Browser inspection at `http://localhost:8080/settings` confirmed that “Working · 25 ms” appears as plain muted text beside its green status dot, while Test retains its button border.
