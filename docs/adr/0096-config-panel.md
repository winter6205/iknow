# 0096. `/config` becomes a settings panel; FS / worktree gating / subagent concurrency cap on one screen

Date: 2026-09-15
Status: accepted

Parameterless `/config` in the TUI opens a floating panel of the same family as `/model` (↑↓ selects a row, Enter edits the value, Esc saves, exits, and persists to user-layer settings), instead of only flipping filesystem isolation levels through command-line arguments. The first version has three rows: filesystem isolation level (global / workspace), worktree isolation mode (ON/OFF), and the subagent concurrency cap preset `3 | 5 | 9 | 15 | unlimited`. The parameterized `/config …` form stays for chat/serve and scripts, sharing the panel's single holder and single persistence semantics. Future settings only add rows, never new slashes. The spec is picked up later under `specs/`; this ADR locks only the shape and the cap-disclosure policy.

**Why not one slash per toggle:** `/config` already occupies the vocabulary; adding `/isolation` `/subagent-cap` would scatter the command table and the panel family — the opposite of what `/model` already proved: one vocabulary entry + one panel.

**Why not write the concurrency cap into the system prefix:** the prefix must stay stable while the cap changes in the panel. A resident system value either goes stale or busts the cache on every change. The gate is the manager's hard cap; the model side learns the current state through two surfaces — the `spawn_subagent` tool description embeds the current cap, and on overflow `SubAgentCapacityError` returns a tool_result (which already carries `active/max`). Humans see the panel and `/info`. No extra "current cap N" is injected at session start.

**Why not disclose the cap only on overflow, not in the description:** the model must plan its parallelism before issuing the (N+1)-th spawn; the N in the description and the N in the error receipt must be the same number. The overflow receipt stays; it just is not the only disclosure channel.

**Why not drop the hard cap (keep only `unlimited`):** with no cap, local processes and context get saturated. `unlimited` is one of the presets: the manager performs no concurrency rejection; OS / memory remain the factual ceiling. The default stays 15.

Amends ADR-0092 (the TUI `/config` entry widens from "arguments flip the FS level" to a panel; the two-level FS value range is unchanged). Amends ADR-0037 (`worktreeOnMutate` can be toggled in-session by the panel and persisted; the gate still never auto-provisions). Amends ADR-0014 (the cap can be adjusted at runtime through the same manager ceiling; graph nodes still count against the same ceiling; `unlimited` means that ceiling never rejects).
