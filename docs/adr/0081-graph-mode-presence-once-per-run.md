# 0081. With graph mode on, emit the short presence once per run()

Date: 2026-09-10
Status: accepted

## Context

An earlier design (ADR-0080) appended the short `<graph_mode>` presence line on every inner-loop hop about to call the model. Repeatedly appending the same line per hop would flood the transcript with duplicate presence lines, and on the human-facing surface — if not filtered — they would read as user bubbles.

## Decision

"While the graph is open" is stated **once per `run()`** (one human-turn): a single short `<graph_mode>` line is appended at the tail of `messages`, not per inner-loop model invocation. The flip itself may still carry one long ON/OFF line; if the same `run()` already emitted a long ON, the short line is not stacked on top. The line never enters system, never enters `run_graph` receipts, never enters `<agent_status>`. When graph mode is off or was never turned on: nothing is emitted. Human-facing rule: TUI/CLI must not render `<graph_mode>` as a user bubble — same discipline as `<agent_status>`.

## Consequences

- Forgetting to use the graph is still countered by the resident `run_graph` description + one short presence line per human turn + the long flip line — not by re-appending the same line throughout one tool loop.
- One opening line per turn is enough to mark the current run's overlay, while the transcript stays free of repeated presence noise.

## Why not

**Why not per hop (0080):** appending the same short line on every hop turns the transcript into repeated presence spam; on the human side, without filtering, those lines look like user bubbles. Once at the start of a run already marks the overlay for that turn.
