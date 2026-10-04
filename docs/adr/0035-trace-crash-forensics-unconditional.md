# 0035. Subagent lifecycle trace is written unconditionally (corrects the scope of ADR-0003 D10)

Date: 2026-08-28
Status: accepted

> **Scoped amendment (2026-10-03, ADR-0136):** The inherited chat content-trace exclusion is superseded for new-format persistent native sessions by [ADR-0136](0136-native-session-checkpoint-architecture.md). This does not weaken this ADR's lifecycle-evidence scope or imply that current orderly shutdown proves abnormal-host worker termination. Implementation and acceptance remain pending.

Background: the retrospective of a worker-startup-instant-crash PR found that the chat REPL entry defaulted subagent trace to Noop (`build-engine.ts:374-380` / `cli.ts:277-286`) — after an instant crash there was zero on-disk evidence, and incident forensics depended entirely on the serve/TUI entries. Decision: the three lifecycle event kinds `subagent_spawn`/`subagent_state_change`/`subagent_stop` plus a crash-stderr pointer file (`<traceDir>/stderr/<taskId>.log`, masked, 1MiB cap) are written unconditionally at every product entry; the exclusion scope of ADR-0003 D10 "chat REPL does no trace" is **narrowed to content trace** (payload surfaces such as llm_call/turn/tool_call). Lifecycle metadata lines are tiny (measured ~400-600B/line) and do not trigger the interactive-boundary problem that decision originally avoided (write boundaries under ctrl-c / session switching are content-surface semantics).

**Positive / Applied:** reproducing this class of instant crash at any entry now leaves an on-disk evidence chain (structured error fields + full stderr pointer + tail summary); debuggers no longer depend on remembering entry-point switches.

**Negative / Trade-offs:** chat REPL gains one more continuously appended `subagent.jsonl` aggregate file (KB-scale per task); this superficially conflicts with the ADR-0003 D10 text and is resolved by this ADR's scope narrowing — future readers seeing trace lines in chat REPL should defer to this ADR.

## Amendment 2026-09-08 (ADR-0071)

**Location change**: `<traceDir>` moved from the cwd-relative `./trace/` (`cli.ts:77`) into the **session folder** `~/.iknow/projects/<project slug>/<conversationId>/`. The crash-stderr pointer required by this ADR accordingly lands at `<session folder>/stderr/<taskId>.log`. At the same time, the "all subagents machine-wide aggregated into one file" shape of `subagent.jsonl` (`createTrace("subagent")`, `hub.ts:2869` / `cli.ts:336`) retires in favor of **per-agent** `<parent session folder>/subagents/agent-<id>.jsonl` + `.meta.json` — the evidence chain for this class of instant crash now carries lineage by construction, no longer requiring reverse lookup via the literal conversationId `"subagent"`.

**This ADR's unconditional guarantee is not weakened** (stated deliberately, so future readers do not misjudge): ADR-0071 Decision 5 adds one precondition to trace — the `blobs/` directory must be writable; while it is not, that run's `llm_call` writes zero lines. But that precondition **acts only on the content surface** (the `llm_call.messages` body in ADR-0003 D10's scope, i.e. records that go through `toBlobReferences`). The three lifecycle event kinds governed by this ADR (`subagent_spawn` / `subagent_state_change` / `subagent_stop`) **carry no messages body**, so `toBlobReferences` never fires for them, and lifecycle lines plus the stderr pointer **are still written normally** when `blobs/` is unwritable. The unconditionality of crash forensics holds as before.

**Negative / Trade-offs (added here)**: the lifecycle surface and the content surface are now **differently sensitive** to `blobs/` health — within one incident, lifecycle lines may be complete while `llm_call` is absent. This is a trade-off authorized by ADR-0071; during forensics one must know that "`llm_call` absent ≠ that call did not happen".

Evidence pointers: the instant-crash PR (d1e5a9e7) and buglog `c1a15695` (branch docs/subagent-worker-startup-crash-buglog); the 2026-08-28 trace design evaluation (4-way Explore + skeptic second review); ADR-0071 (session-folder consolidation and content-addressed trace bodies).
