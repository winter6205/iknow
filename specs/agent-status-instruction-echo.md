# Spec: status-line echo upgrade — instruction field and pivot reconcile marker

**Status:** draft (rev 2 — end-of-round review rulings landed: the T3 correlation-key clause gains the "re-freeze same-content clone counts as identical" second clause plus its precondition, preventing implementation from regressing to the rev-1 pure object-identity algorithm; OQ1/OQ2 closure registered in `docs/STATUS.md`)
**Basis:** ADR-0103 (amends two half-sentences in ADR-0028 Consequences; the injection discipline is unchanged verbatim); `docs/CONTEXT.md` "status bar" entry + _Avoid_ list
**Surface:** `src/harness/agent-status.ts` (field set + filtering predicate), `src/harness/loop-engine.ts` (`appendAgentStatusBar` injection point + run-scoped reconcile box), `src/harness/stream.ts` (`agent_status` event fields), `src/tui/agent-status-line.tsx` (event mapping, rendering surface untouched), `src/tui/session-state.ts` (hidden predicate untouched, verification regression)

## Goal

Fix "distorted echo content": after a user pivot instruction arrives, the status bar keeps re-sending the frozen stale todo list in full on every hop, and the instruction itself is pushed out of the bar column's trailing attention window (measured incident conversation `ee13c787`, 2026-09-18; the model worked on the old task for about 8 minutes). Two new pieces of information enter the bar:

1. the `instruction:` segment — the verbatim first line of the latest **real** user instruction (computed purely in code, no summarizing, no rewriting);
2. the pivot reconcile marker — a one-shot marker attached to the **next** bar after a new user message arrives, prompting the model to first reconcile the ledger via `todo_write` before continuing; later hops do not repeat it.

The injection discipline is untouched: append per hop, append-only, never replace an old bar, never enter `deps.system` (ADR-0028).

## Boundaries

- **Does:**
  - `AgentStatusSnapshot` field-set extension: `instruction` (`string | null`) + `reconcile` (`boolean`); `buildAgentStatusText` / `parseAgentStatusText` support both directions, and **old bars (without the new segments) must parse as before** (cold-start hydrate path `agentStatusFromMessages`).
  - "real user message" filtering predicate (harness-layer SSOT, see T2): excludes all host-injected user messages + strips the memory prefetch overlay.
  - loop-engine injection-point wiring: `appendAgentStatusBar` extracts instruction from `state.messages`, with one-shot reconcile settlement via a run-scoped box.
  - `agent_status` stream-event fields grow with the snapshot (same snapshot object, single-source-of-truth discipline preserved).
  - Golden-set disposition (the `<agent_status>` surface is registered in the roster as a **gap**): STATIC + SEAM locks added + incident-trajectory set created (see T5).
- **Out of this spec:**
  - Injection frequency / boundary injection / dedup (ADR-0103 §Why not already ruled them out; must not resurface under the guise of "noise reduction").
  - The `isTuiHiddenUserMessage` predicate itself (the bar still matches on the `<agent_status>` prefix; hiding behavior has zero change).
  - New TUI chrome instruction line (see "TUI projection discipline": display surface untouched).
  - The todo ledger write side, `todo_write` semantics (the three things of ADR-0085 stay untouched).
  - Introducing taskFocus / task cards / live environment into the bar (CONTEXT prohibition).

## Settled invariants

1. **The bar carries only live state computed by code**: instruction is a verbatim echo (first line of the user's original words, truncated), not an LLM summary; the reconcile marker is fixed constant text. Policy prose still does not enter the bar.
2. **instruction source = the latest real user message at the tail of messages**: must exclude the agent_status injection itself (`isAgentStatusText`), and exclude all host injections (filter roster in T2); memory prefetch rides on the user turn (the part before `MEMORY_PREFETCH_END` is a model-side overlay) — strip the overlay to get the original text before extracting.
3. **The reconcile presence condition is exactly one**: "the next bar after a new user message arrives". Using "was todo_write called this hop", "is the todo segment present" or "did the bar change" as conditions is forbidden (explicitly listed in CONTEXT _Avoid_). The marker appears only once on that hop.
4. **reconcile text is byte-stable**: the same constant across turns and sessions (it is a bar line, not system content, so prefix stability is not broken).
5. **Field-order discipline (root of bidirectional compatibility)**: all scalar field lines (`last_tool:`, `instruction:`, the reconcile line) come **before** the `todos:` header, and todo lines always occupy the bar's trailing section. Effect: an old parser eating a new bar (find `last_tool:` + take everything after the `todos:` header) still gets the correct subset; a new parser eating an old bar gets `instruction: null, reconcile: false`.
6. **append-only unchanged**: this spec adds no message-replacement / splice path; the `pendingInjected` record discipline (#888 save-fork) keeps covering the new injection shape.
7. **Empty slots are not advertised**: no real user message (in theory only synthetic assembly) → the `instruction:` segment is entirely absent; no open items → the todo segment is entirely absent (existing discipline).

## Task breakdown

### T1 — bar field-set extension (`agent-status.ts` pure-function pair)

`buildAgentStatusText` output shape (full shape when the todo segment is present):

```
<agent_status>
last_tool: <name>
instruction: <verbatim first line, ≤100 code points>
reconcile: <fixed marker sentence, appears only on that hop>
todos:
- [ ] [tN] <subject>
</agent_status>
```

- `instruction` is `null` → the whole line is absent; `reconcile` is `false` → the whole line is absent (both are "empty slots are not advertised").
- The fixed text of the reconcile line (a constant, exported for tests and roster locks) means: "a new user instruction was detected; if it is inconsistent with the current todo ledger, first reconcile the ledger via todo_write before continuing." A single English line (same language surface as the rest of the bar), byte-constant.
- `parseAgentStatusText`: take the value of the `instruction:` line (missing → `null`); the `reconcile:` line present → `true`; unknown scalar lines before the `todos:` header must not be swallowed into the todo list (only after the header is the todo segment). Malformed → `null`, never throw (existing contract).

**Acceptance**: unit tests cover — new build/new parse round-trip; old-format bars (last_tool + todos only) parse to `instruction: null, reconcile: false`; a new-format bar consumed by old field consumers (TUI `agentStatusFromEvent`) does not crash on extra fields; `agentStatusFromMessages` returns a valid snapshot for old transcripts (cold-start hydrate with only old bars); an `instruction` value containing the `</agent_status>` substring does not break structural parsing (same-line text, line-level validation, see Failure paths F3).

### T2 — real-user-message filtering (SSOT predicate)

A new predicate (landing in `agent-status.ts` or a single file in the same domain, named e.g. `extractLatestRealUserText(messages)`) scans from the tail of `messages` backwards for the first **real** user message:

- role === user, text blocks joined (same shape as `joinedUserText`, but do not import TUI-side pieces — the harness must not depend in reverse);
- hitting **any entry of the injection roster** → skip. The roster (current complete set, each with its predicate): `isAgentStatusText` (`<agent_status>`), `isGraphModeText` (`<graph_mode>`, covering both long change notices and short presence lines), `isSubagentDrainText` (`## Sub-agent `, i.e. task-class system injection), `isVerifyInjectedText`, `isSkillIndexDeltaText` (`<available_skills>` delta), MCP reconnect notifications (`MCP_RECONNECT_NOTIFICATION_TEMPLATE` fixed prefix `MCP server '`), `LOOP_DETECTED_TEXT`, compact-product prompts (`buildCompactPrompt` / `SUMMARY_PROMPT` text, if persisted into prior). The skill-load envelope (`[skill-load name="…" ]`) **counts as a real user message** but extract the first line of the remainder after its `\n\n`; empty remainder → treat this message as having no instruction source and keep scanning backwards (rationale: the first line is an assembly envelope, not the user's words — echoing it verbatim has no replay value).
- Hitting the memory prefetch overlay (`MEMORY_PREFETCH_END` in the text) → take the tail segment (after the marker) as the original text before extracting; no marker → the whole text is the original.
- **Roster-completeness lock**: a SEAM test enumerates the output text of every `encodeUserText` injection seam in loop-engine and asserts each hits the filter roster (a new injection seam not on the roster turns red). This is the guardrail this spec leaves for the future, preventing "new injections being mistaken for user instructions".

**Extraction rule**: after full stripping, take the **first line** (before `\n`), `trim` trailing whitespace; truncation = 100 **code points** (counted via `Array.from`, not UTF-16 units), over the limit truncate without an ellipsis (verbatim discipline: adding an ellipsis is rewriting); first line is an empty string → the message has no valid instruction line, keep scanning backwards.

**Acceptance**: unit tests — a pivot message at the tail → extract its first line; a bar at the tail → skip the bar and take the real message; drain / graph / mcp reconnect / skill delta each present → skipped; prefetch prefix present → take the original segment; skill-load envelope with remainder → take the remainder's first line, no remainder → scan backwards; CJK + emoji mixed 100-code-point truncation never splits a character; roster-completeness SEAM test green.

### T3 — loop-engine wiring and one-shot reconcile settlement

- **instruction source**: `appendAgentStatusBar` consumes `state.messages` (the T2 extractor) and passes it into `computeAgentStatusSnapshot` (opts extended with `instruction: string | null`). The todo read path has zero change.
- **reconcile state lands in a run-scoped box** (copying the `lastToolRef` shape: created in `run()`, shared across steps; `public step()` single-step semantics create their own). **Do not** make it a persisted snapshot field, **do not** write it to JSONL, **do not** put it on the deps assembly surface:
  - Box content: `reconcileRef: { stamped: AnthropicNativeMessage | undefined }` — the object reference of the most recent "real user message" already settled with a bar (messages are frozen + immutably appended, no id needed; see below for the identity clauses).
  - **Correlation key = identity test, two clauses (rev 2)**: ① object identity (`L === stamped`); ② same role + block-by-block same content → judged the same message (re-freeze clone). The **precondition** of ②: within a single run, the only real user message is the one appended at the `run()` entry; all later user messages are host injections filtered by the T2 roster — hence content-identity is equivalent to object-identity on the settlement surface, and there is no second real message with identical content to confuse it. **Empirical motivation (why ① alone is insufficient)**: compact's `applyCompactAttachment` clones each kept message through `freezeMessage`; after a reactive-compact retry the same message's reference changes while its content does not; with ① alone the clone would be misjudged as a newly arrived message and the same instruction would be marked twice, violating invariant 3 "the marker appears only on that hop". Landing point: `loop-engine.ts` `isSameRealUserMessage`.
  - Settlement algorithm (inside each `appendAgentStatusBar` call): take the T2-matched real user message `L` (object reference); `L !== undefined && !identity_test(L, reconcileRef.stamped)` → this bar gets `reconcile: true` and set `stamped = L`; otherwise `reconcile: false`. **"The marker appears for exactly one hop"** follows naturally from this algorithm.
  - The compaction / reactive-compact retry paths share the same box and algorithm (both `appendAgentStatusBar` call sites wired in the same shape).
  - Cold start / resume: the box starts at `stamped = undefined` → the first bar of this run carries the marker once (legitimate: after a process restart the model exactly needs one reconciliation prompt; not a violation of "one-shot" — one-shot = settled once per arrival).
- **`agent_status` stream event** fields grow with the snapshot (`instruction` / `reconcile`), still emitted from the same snapshot at the same computation point (single source of truth; the TUI and the bar cannot diverge).

**Acceptance**: harness integration tests follow the repo rule of stub-model + `createJsonlTraceService` double-track assert (trace event sequence + NoopTrace-vs-no-trace deepEqual baseline): multiple hops in one turn → the reconcile marker on the first hop only, instruction present on every hop; a second wave of user messages (new run) → marked again on the first hop, gone from the second hop on; with an empty todo segment the marker is independently present (the presence condition is unrelated to todos, invariant 3).

### T4 — TUI projection discipline

- **Display surface untouched**: `agentStatusLines` keeps projecting only open todo lines (single `□ a · b · c` line, `clipOneLineVisual` truncation rules unchanged). The instruction echo gets **no** new chrome line — when it arrives the user message is already rendered as a ❯ bubble; replaying it for humans is duplication; the reconcile marker is a reminder for the model and has no value on the human-readable surface.
- `agentStatusFromEvent` must tolerate and pass through the new fields (event mapping extends; the `AgentStatusLine` consumer surface has zero change); replace-on-event semantics unchanged.
- `isTuiHiddenUserText` / `isAgentStatusText` prefix checks unchanged (the new segments are inside the wrapper and do not affect hiding); the `isAgentStatusText` filtering in `session-api/turn-projection.ts` gets the same regression verification.

**Acceptance**: TUI unit tests — rendering output for events carrying instruction/reconcile segments is byte-identical to old events (no human-facing regression); hidden-bubble filter regression green.

### T5 — golden set / roster disposition (mandatory surface for model-visible text changes)

In the `docs/guides/prompt-development.md` roster, the `<agent_status>` surface lock = STATIC + SEAM, set path = **gap**. This change is "a gap surface being modified"; per the guide there are two options — this spec rules **build the set** (basis: the guide's "when an incident recurs, admit that input into the set, no regressions allowed", and ADR-0103's evidence is exactly the `ee13c787` incident):

1. **STATIC**: the bar format's key lines (`last_tool:` / `instruction:` / `reconcile:` prefixes, the `todos:` header ordering, the reconcile constant sentence) enter the existing agent-status static-lock tests;
2. **SEAM**: the T3 integration tests (one-shot settlement, not entering system, byte-stable across hops);
3. **trajectory set**: a new golden fixture (placed with the existing trajectory sets, not a separate cabinet — following the co-location discipline of `tests/harness/graph/graph-mode-notification.fixtures.ts`; suggested `tests/harness/agent-status-instruction.fixtures.ts`): fixed input = non-empty todo ledger + pivot instruction arrival; checkable behavior = the model's first tool on the next hop is `todo_write` (reconciling the ledger) rather than continuing old-task tools; the real-model half must pass `npm run test:real-llm` (missing key → report Not run honestly; never pass offline green off as real-model green);
4. **Backfill**: the implementation PR backfills the set path into the roster table's `<agent_status>` row (gap → path).

### T6 — TUI pty field test (repo rule: changes that enter a session must be shown on screen)

Use `mcp__aiterm__pty_*` to start a fresh TUI session: ① give a multi-step task and let the model record it via `todo_write`; ② send a mid-run pivot instruction; ③ read session JSONL / trace evidence: the first bar after the pivot contains `instruction:` (= the pivot's verbatim first line) + the `reconcile:` line, the next bar's reconcile line is gone while the instruction line remains; ④ no injection-bubble resurgence on screen, todo footer projection not degraded. Evidence (transcript snippets + trace line numbers) goes into the acceptance report.

## Failure paths

| #   | Path                                                              | Behavior                                                                                                              |
| --- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| F1  | no real user message at all after the bar (fresh assembly, prior entirely injected) | `instruction` segment absent, reconcile not settled (nothing to key on), bar degrades to the old field-set shape      |
| F2  | the real user message's first line is blank                        | skip this message and scan backwards (extraction rule T2); no valid line in the whole chain → same as F1               |
| F3  | instruction's first line contains the `</agent_status>` or `<agent_status>` substring | kept verbatim (same-line text does not break line-level validation: parsing uses `lines[0] ===` / `lines.at(-1) ===` full equality, scalar lines take values by prefix); pinned by a regression test |
| F4  | cold-start hydrate of an old-format bar (no new segments)          | `parseAgentStatusText` returns `instruction: null, reconcile: false`, not judged malformed (the backward half of invariant 5) |
| F5  | a new-format bar parsed by an old version (rollback scenario)      | the old parser finds `last_tool:`, takes everything after the `todos:` header → gets the correct old field subset, no crash (the forward half of the ordering discipline) |
| F6  | the `MEMORY_PREFETCH_END` marker appears inside the user's original text (user pasted the string) | take the segment after the **last** marker as the original (under- rather than over-admit: prefer echoing less leading text than treating the overlay as an instruction); pinned by a test |
| F7  | todos.md read failure                                              | existing silent convergence (no todo segment, no throw), new fields unaffected                                        |

## Input-contract classes

| Surface                | empty                           | invalid                                     | Notes                                    |
| ---------------------- | ------------------------------- | ------------------------------------------- | --------------------------------------- |
| instruction extraction | no real user message in prior → segment absent | first line empty → scan backwards | pure read, zero throw surface                        |
| `parseAgentStatusText` | old bar (new segments missing) is legal | missing `last_tool:` / wrapper lines not equal → null (existing) | missing new segments ≠ malformed                         |
| reconcile box          | first hop of a run `stamped = undefined` | N/A                                         | two-clause identity test on the correlation key (object identity ∨ re-freeze same-content clone, precondition in T3 rev 2); frozen messages carry no aliasing risk |

## Success criteria

- **SC1**: bar field set = `last_tool` + `instruction` (conditionally present) + reconcile line (one-shot) + todo segment (conditionally present); all scalar segments precede the `todos:` header (ordering unit test).
- **SC2**: instruction verbatim = first line ≤100 code points of the latest real user message (after stripping the prefetch overlay), with zero LLM involvement (pure-function unit tests + grep asserting zero adapter import in this module).
- **SC3**: reconcile marker "present on the first hop after arrival, absent from the next hop", trace double-track assert (T3); the presence condition is independent of the todo segment and the `todo_write` call history.
- **SC4**: old bars parse as before (hydrate-path regression); new bars consumed by old consumer surfaces (TUI footer / turn-projection) with zero exceptions.
- **SC5**: injection-roster completeness SEAM test green (every loop-engine `encodeUserText` injection product is classified as injection by the filter predicate).
- **SC6**: `agent_status` stream event and bar text same-source unit test (derived from the same snapshot assertion).
- **SC7**: golden set T5 all four items: STATIC lock, SEAM lock, trajectory fixture admitted to the set, roster table backfilled (backfill happens in the implementation PR; registering takes effect once this spec merges).
- **SC8**: `npm test` fully green + TUI pty field test (T6) evidence archived; the real-model trajectory set passes `npm run test:real-llm` (missing key → report Not run honestly).

## Inherits / Changes

- **Inherits**: ADR-0028 injection discipline (per hop, append-only, not into system); #888 `pendingInjected` save-fork discipline; `readOpenTodoLines` silent convergence; todo-segment projection SSOT (`todo-ledger.ts`); TUI replace-on-event single source.
- **Changes**: two half-sentences in ADR-0028 Consequences (already landed via ADR-0103 Amended clause; this spec does not edit the ADR); the shapes of `AgentStatusSnapshot` / `buildAgentStatusText` / `parseAgentStatusText` / `computeAgentStatusSnapshot` / the `agent_status` event (field extension, additive); the prompt-development roster's `<agent_status>` row (gap → set path, changed in the implementation PR).
- **Untouched**: `isAgentStatusText`, `isTuiHiddenUserMessage`, `agentStatusLines` rendering rules, the todo ledger write side.

## Open questions

- OQ1 (**closed in rev 2**, end-of-round review ruling, registered in `docs/STATUS.md`): whether `LOOP_DETECTED_TEXT` and compact prompt text persist into cross-run history under the current prior shape is not empirically confirmed — the filter predicate is written as "hit ⇒ injection", and both seams enter the roster even if they do not persist (conservative over-filtering, zero cost); the SEAM completeness lock backs up new injection seams. Ruling: conservative over-filtering + the SEAM lock suffices; OQ closed.
- OQ2 (**closed in rev 2**, end-of-round review ruling, registered in `docs/STATUS.md`): a whitespace-only skill-load remainder being handled as "no valid line, scan backwards" is settled, but whether **slash products such as `/compact`** remain in the prior as user-message form needs verification against real transcripts at implementation time; if injection forms not on the roster exist, add them to the T2 roster (the completeness SEAM test will surface them automatically). Ruling: T7 TUI pty + trace field test showed no off-roster divergence; OQ closed.

## Evidence pointers

- Incident transcript: `~/.iknow/projects/iknow-ddcb805367a0/ee13c787-5958-4524-95d3-0e89d520f12a/` (30+ identically shaped bars vs 1 instruction after the instruction arrived).
- Current field surface: `src/harness/agent-status.ts:39-97` (snapshot + pure-function pair), `:158-169` (`computeAgentStatusSnapshot`).
- Injection point: `src/harness/loop-engine.ts:600-625` (`appendAgentStatusBar`, including the same-source stream-event emission), `:2185-2192` (`lastToolRef` run-scoped box shape — the reconcile box copies it), `:2276` / `:2328` (two call sites: normal step and compact retry).
- Complete injection-form inventory: grep of `encodeUserText` call sites (graph change/presence, mcp reconnect `:795`, skill delta, compact prompts, `LOOP_DETECTED_TEXT`, worker-side host truncation prompts — the worker has no bar seam and is out of this surface).
- Existing filter-roster members: `isAgentStatusText` (agent-status.ts:62), `isGraphModeText` (graph/notification.ts:37), `isSubagentDrainText` (subagent/host-drain.ts:38), `isVerifyInjectedText` (verify/inject.ts:17), `isSkillIndexDeltaText` (skill/index-delta.ts:67); prefetch marker: `memory/prefetch.ts:30` (`MEMORY_PREFETCH_END`, "Splits overlay (model-only) from the typed query").
- TUI consumer surface: `src/tui/agent-status-line.tsx:27-57`, `src/tui/session-state.ts:302-312`, `src/tui/app.tsx:1506 / :2342` (hydrate `agentStatusFromMessages`).
- Roster registration: `docs/guides/prompt-development.md` table, `<agent_status>` row (STATIC + SEAM, gap).

## ACR Verdict (architecture-change-reviewer · 5-verdict gate)

```text
bounded-context-guardian: yes — all changes stay in the harness bar seam (spec Surface line; T2 never imports TUI in reverse; T4 display surface untouched; Out-of-scope excludes TUI chrome/taskFocus)
defensive-contract-validator: yes — F1-F7 + Input-contract table cover empty/malformed/overflow (100-code-point CJK+emoji truncation in T2)/exception; concurrency isolated naturally by the run-scoped box (T3's two call sites wired in the same shape, loop-engine.ts:2276/:2328 verified to exist)
error-handling-enforcer: yes — F7 todos read failure = existing EXIT silent convergence (agent-status.ts:147 verified); F3/F4/F6 malformed → null without throwing; the extraction surface has "zero throws" (invariant 7, T1)
complexity-anti-drift: yes — reuses the lastToolRef box shape (loop-engine.ts:2185-2192 verified) and the pendingInjected discipline (invariant 6); extends the pure-function pair without building subsystems (T1/T3)
minimal-change-verifier: yes — one-to-one with ADR-0103 decisions 1-4; T5/T6 are repo-mandated surfaces, not creep; all roster anchors hit on inspection
OVERALL: PASS — hand to writing-plans
```
