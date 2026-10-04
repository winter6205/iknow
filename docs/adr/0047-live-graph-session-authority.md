# 0047. The long-run graph's authority state is session-level live graph state, not stateless repeated run_graph

Date: 2026-09-07
Status: accepted

> **Persistence extension (2026-10-03, ADR-0136):** [ADR-0136](0136-native-session-checkpoint-architecture.md) carries this session-level graph authority into published native checkpoints and durable node progress for cross-process recovery. Current code still resets its in-memory ledger on resume; the new contract is not implemented. Existing revision/scheduling semantics and the prohibition on re-enacting completed work remain unchanged.

Long-run graph execution must never re-enact completed work. In V1 each `run_graph` leaves `GraphExecution` only on the call stack: the parent agent receives just condensed JSON, TUI progress is cleared when the call ends, and node `id`s cannot be matched to prior workers across calls. Therefore the host must hold **live graph state** at the session level; long-running work must not depend on the model's memory of the transcript. Terminology: see `docs/CONTEXT.md`. This ADR still does not lock revision wire formats or live-graph creation/teardown timing.

## Why not

- **Stateless repeated `run_graph` (alternative B)**: the host cannot force skipping already-done ids; after compact it is even less reliable.
- **Put the authority in the todo ledger**: ADR-0046 already rejected treating a list as a pipeline.
