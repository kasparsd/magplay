# Agent Guidelines

- This is a greenfield project. Do not spend effort on data migrations, backward compatibility, or preserving behavior for hypothetical existing users.

- Existing project conventions and earlier implementation choices are not constraints: prefer a clean design and change them when a better approach serves the task.

- Create `docs/plans/{feature-description}.md` when starting work on any feature to capture the plan, goals and progress as todos, for sharing the work across agent sessions and preserving the memory of the work. Use an existing doc if it aligns or you're working on a followup. When a plan is fully implemented, move its lasting decisions into the canonical docs and its validation into `docs/checkpoints/`, then delete it; open work that needs the owner belongs in the roadmap.

- Canonical documentation is organized by concern in `docs/`. Update the relevant document in place when a decision changes; don't create a parallel review or summary file for the same concern. `docs/research/` holds planning inputs and `docs/checkpoints/` holds dated evidence; neither is canonical.

- Always use soft-line breaks (not hard) for documentation.

- Add a release note with every change (`npm run release -- note --patch -m "..."`, or `npm run release -- note --empty` when users see no difference). [docs/releases.md](docs/releases.md) explains what to write and which bump to pick.
