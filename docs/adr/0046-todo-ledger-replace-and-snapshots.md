# 0046. The todo ledger may be replaced; old files stay as snapshots; replacing the table does not feed messages

Date: 2026-09-06
Status: accepted

The main session's `todo_write` is a revisable task list — not Plan Mode, and not a pipeline on the graph. Writing one global set of steps before starting is allowed; when tasks change, **replace** writes a new current `todos.md`, and the old file stays in the same session directory as a snapshot. A replace-as-jump does not append the new list into `messages` (the tool call already carries it); later turns keep their global view solely via the status bar projecting the current unchecked items (ADR-0028).

## Why not

- **A Plan Mode phase**: plan read/write first, then flip to execution. What is rejected is the phase, not "having an editable list to begin with".
- **Pure append to the same file, old `- [ ]` lines left open**: two todo sets coexist and the global view shatters.
- **Overwrite and lose the old file**: history becomes unrecoverable.
- **Fold todos into `run_graph`**: light planning in default chat should not depend on the graph overlay. Dynamic Pipeline / replan is a separate matter, hung on the graph.
