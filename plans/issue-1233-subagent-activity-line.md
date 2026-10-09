# Plan: Issue #1233 — Useful Sticky Subagent Activity

**Issue:** [#1233](https://github.com/winner6205build/iknow/issues/1233)
**Status:** Approved scope; both implementation tickets pending.
**Goal:** Keep the subagent card's second line useful after a tool returns by showing the latest issued tool and its existing argument summary until another call replaces it.
**Approach:** First retain the latest worker `tool_use` through its `tool_result` across the existing ledger, manager, and card projection. Then render that call with the shared tool-summary rules. The line describes the most recently issued call, not whether it is still running or succeeded.
**Spec/context links:** [specs/subagent-card-title.md](../specs/subagent-card-title.md), [docs/CONTEXT.md](../docs/CONTEXT.md), [specs/README.md](../specs/README.md).

## Accepted contract amendment

The operator-approved amendment for this plan supersedes Issue #1233's required-description proposal and the current spec's in-flight pairing rule:

> The activity slot keeps the most recently issued worker tool call after its `tool_result`, until another `tool_use` replaces it. It shows the tool name and a summary derived from the recorded input. With multiple calls, the slot represents the latest call in ledger order only; it does not imply that the call is still running or succeeded. No required or optional `description` field, schema change, or prompt instruction is added.

The existing card and lifecycle constraints remain inherited:

> “The card is exactly these two lines.” Line 1 remains the spawn title and line 2 the single activity slot. A completed worker keeps the green `✓ Done` marker; a failed worker stays on its failure overlay. A settled spawn card without a live worker keeps an empty slot. No tool call or no ledger also yields an empty slot, while a bad ledger is diagnosed and yields an empty value.

These excerpts refer to the current contract in `specs/subagent-card-title.md`; implementation updates that spec and its existing `subagent card live` entry in `docs/CONTEXT.md` and `specs/README.md` to match the accepted behavior. No new domain term or ADR is needed.

**ACR:** All five verdicts are yes for this two-ticket implementation scope.

```text
bounded-context-guardian: yes — `worker-activity.ts` projects ledger data, `manager.ts` keeps the opaque reader/cache seam, and `subagent-message-lines.ts` renders and clips the row.
input-contract-tests: yes — no public input contract changes; planned reader tests cover empty or malformed ledgers, unknown tools, concurrent workers, and read failures.
error-handling-enforcer: yes — the existing reader reports ledger faults and returns an empty value; the manager guards reader failures and stale terminal or resumed reads.
complexity-anti-drift: yes — ledger projection, manager caching, and card rendering stay in their existing modules; the shared summary formatter is reused.
minimal-change-verifier: yes — this changes only the activity display behavior, with no description field, prompt/schema change, or added stream or surface.
```

**Per-ticket loop:** TDD (RED first) → focused tests and `npm run typecheck`.
**After both tickets:** `code-review` → if `GATE: BLOCKED`, `review-report-repair` in the next slot → `verification-before-completion` → commit. No push without explicit authorization.
**Persist:** None — keep the existing term; record the accepted behavior in its owning contract docs during implementation.

## Tasks (ordered by dependency)

1. **Keep the latest issued tool visible through its result** — `[implementation]`
   - **Inherits:** “The card is exactly these two lines.” “When that joined worker is `completed`, line 1 is unchanged and line 2 is green `✓ Done`.” “`failed` stays on that card's failure overlay.” Preserve the empty slot for a missing call or ledger and for a settled spawn block without a live worker.
   - **Surface:** Existing `session-api` worker-ledger projection, `harness/subagent` manager list/cache, and TUI subagent-card projection.
   - **Acceptance:** Once a worker ledger contains a `tool_use`, the card keeps that tool name after its matching `tool_result`; the next `tool_use` replaces it. Each concurrent worker reads only its own ledger. The activity value and its TUI memo signature track the complete projected value; remove in-flight naming where its contract changes. Completion still renders `✓ Done`, failure still uses the failure overlay, and terminal or resumed workers cannot be repainted by stale reads. A reopened settled card with no live manager entry, a worker with no call, or a missing ledger keeps the slot empty. An unreadable or malformed ledger is diagnosed and degrades to empty without throwing.
   - **Verification:** Use the production reader with isolated temporary JSONL ledgers. Run `npx vitest run tests/session-api/worker-activity.test.ts tests/subagent/manager-in-flight-tool.test.ts`, `bun test tests/tui/subagent-card-lines.test.ts tests/tui/subagent-two-line-budget.test.tsx`, and `npm run typecheck`.
   - **Status:** [ ] pending
   - **Completion/headroom:** The visible retention, replacement, lifecycle, and isolation behavior is fixed; the internal projection and helper split remain open to implementation.

2. **Show the existing argument summary on the retained activity line** — `[implementation]`
   - **Inherits:** T1's latest-issued-call lifetime and the existing two-line, completion, failure, reopen, and empty-slot behavior. Reuse the existing tool-summary rules through the worker activity projection; preserve the shared formatter's behavior.
   - **Surface:** Existing worker-ledger projection, manager activity cache/list, TUI card projection, and the existing tool-summary module.
   - **Acceptance:** Known tools show a concise `tool name · argument summary` from that call's recorded input, clipped to one visual line at the card width. Unknown tools fall back to the bare tool name; legacy or missing input uses a safe existing fallback and never exposes raw JSON. Formatter status `ok` is used only for neutral name-and-summary formatting: it does not assert success, and past-tense summaries such as “Wrote” or “Edited” remain descriptions of the requested operation. The activity stays dim; only worker completion shows `✓ Done`. No tool schema, prompt, model-facing text, permission logic, shared formatter, or other display surface changes. Update the existing spec, context entry, and spec index to describe the summary and its limited meaning.
   - **Verification:** Extend the existing reader, manager, and card tests listed in T1 using production projection over isolated temporary JSONL; exercise a known summarized tool, an unknown tool, old/missing input, width clipping, and retention after a result. Run `npm run typecheck` and the final `npm test` (which already runs Vitest and `bun test tests/tui/`; do not duplicate the full Bun suite). Capture one real `mcp__terminalcp__terminalcp` PTY interaction with `npm run dev:tui` showing sticky activity, replacement, an argument summary, and `✓ Done`; stop the TUI and clean up. No `npm run test:real-llm` is needed because model-visible behavior does not change.
   - **Status:** [ ] pending
   - [blocks: T1]
   - **Completion/headroom:** The card visibly communicates the tool and requested operation without a new model contract; exact field names and rendering helpers remain open.

## Implementation handoff

Two tracer bullets are sufficient: retention and richer text are separately demoable end-to-end changes. A separate decision or testing ticket would add no independent outcome.

Keep changes inside the existing activity projection, manager cache/list, and card rendering modules. Assign product-code test work to `test-engineer` and implementation by module to `implementer`; no new adapter or general activity framework is part of this plan. Keep stdout as one terminal envelope; the panel, web, CLI, worker prompt, and permission behavior remain unchanged. The PTY check must stop the TUI even on failure. The plan authoring pass did not run tests or claim runtime validation.
