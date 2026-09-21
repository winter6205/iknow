# 0030. graph mode is a Shift+Tab orchestration overlay with assembly snapshots at the run() boundary

Date: 2026-08-27
Status: accepted

D-α product entry: Shift+Tab enters graph mode (an orchestration overlay); Graph is not crammed into `PermissionMode`. The three-state cycle is `Default → Auto → Graph → Default`; `/graph` is the non-TTY equivalent, and one settings entry acts as the default for new sessions (off by default). Entering Graph freezes the current permission (ask/auto unchanged). The orchestration segment and `run_graph` are injected/exposed only at the **next `run()` assembly** — after switching modes, they take effect when the model starts its next run. Switching mid-run is not blocked, there is no mid-run re-assembly, and no debounce is added for this. This overrides the parent map's earlier stance that "Shift+Tab is still a permission mode and stays unclaimed." The task count N for entering the graph is **not locked** — it is not "N ≥ 2 must go through the graph"; N and prompt suggestion timing are left to measurement with real tasks during implementation.

## Why not

- **Making Graph a fourth PermissionMode**: entangles the orchestration axis with the authorization axis, pollutes policy / `/permission-mode`, and makes the D-β coordinator harder to split.
- **Injecting prompt+tools only behind an env gate**: already rejected by ADR-0014 (doubles the test matrix, undiscoverable). A human-triggered in-session overlay is not an implicit process-start gate.
- **Hot-swapping the tool surface in the current round on mode switch / guarding against accidental mid-run switches**: injection happens only when the next run starts; during a run there is neither a way to guard nor a need to (operator 2026-08-27).

> 2026-09-04 revision: the **model-facing representation** changed — `run_graph` moved from conditional assembly to permanent registration + handler gate, and the orchestration segment was withdrawn from the system prompt in favor of a switch hint appended at the tail of messages. This ADR's product semantics (three-state cycle, effect at the next `run()` assembly, no mid-run blocking) are unchanged.
