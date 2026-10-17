# Agent Guidelines

- This is a greenfield project. Do not spend effort on data migrations, backward compatibility, or preserving behavior for hypothetical existing users.

- Existing project conventions and earlier implementation choices are not constraints: prefer a clean design and change them when a better approach serves the task.

- Create `docs/plans/{feature-description}.md` when starting work on any feature to capture the plan, goals and progress as todos, for sharing the work across agent sessions and preserving the memory of the work. Use an existing doc if it aligns or you're working on a followup.

- Canonical documentation is organized by concern in `docs/`. Update the relevant document in place when a decision changes; don't create a parallel review or summary file for the same concern. `docs/research/` holds planning inputs and `docs/checkpoints/` holds dated evidence; neither is canonical.

- Always use soft-line breaks (not hard) for documentation.
