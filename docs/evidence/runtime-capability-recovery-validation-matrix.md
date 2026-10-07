# Validation matrix: runtime capability recovery

Date: 2026-10-07
Covers: T4 (command execution), T5 (LSP), T6 (memory OFF gate) of
[`docs/implementation-plans/runtime-capability-recovery.md`](../implementation-plans/runtime-capability-recovery.md).
Companion to [`runtime-capability-recovery-t1-evidence.md`](runtime-capability-recovery-t1-evidence.md), which
records the reproduced failure. This file records what the landed behavior does.

Every row states the operation, the observed result, and the evidence. A row that did not pass says so and
gives the reason. Nothing here is inferred from a comment.

## How the PTY rows were produced

The model provider was pointed at a local Anthropic-compatible capture endpoint that records each request body
and replays a scripted turn, so the *actual* request the TUI sent is the artifact under test. Sessions ran
under `script` (real PTY) with an isolated `HOME`, an isolated workspace, and a local capture provider. The
conversation request is distinguished from two other requests the same session makes: a one-time token-budget
probe (ADR-0043) and a tool-less turn. Only the conversation request — the one carrying the assembled system
prompt and the tool set the model works with — is scored below.

## T6 — the memory switch is a total capability gate

Same workspace, same store, same provider; only `settings.memory` changes. "conversation request" = the
request carrying the assembled system prompt and tool set.

| # | Operation | Observed | Evidence |
|---|---|---|---|
| T6.1 | TUI, `autoExtract`/`dream` both false, empty store | Conversation request carries **40 tools, no `memory_recall`/`memory_save`**, system 7685 chars, no memory pointer | PTY phase A, capture log |
| T6.2 | TUI, both true, empty store | **42 tools, `memory_recall` + `memory_save` present**, system 7835 chars | PTY phase B |
| T6.3 | TUI, both true, one stored entry | **42 tools, memory pointer present** (system 8474 chars, references the stored slug) | PTY phase C |
| T6.4 | TUI, both false, **same non-empty store** | **40 tools, no memory tools, pointer absent** (system 8217 chars = 8474 − 257) | PTY phase D |
| T6.5 | Store contents across T6.3 → T6.4 | The stored entry file is still on disk after the OFF session; OFF does not touch it | Directory listing before and after the T6.4 session |

T6.3 → T6.4 is the decisive pair: with the library non-empty, OFF removes the pointer, the tools, and the
system contribution, and leaves the bytes on disk.

### Explicit non-pass with reason

**The OFF request still carries the memory tool names in one internal call.** The ADR-0043 token-budget
probe (`src/harness/build-engine.ts` around line 1735) measures the tool surface once per session by calling
the model with `reg.catalog.all()`. Because the memory tools stay *registered* and refuse at execution time,
they are in that catalog, so that probe's request lists them.

It is not a capability leak: the probe's response is discarded (only `inputTokens` is read), nothing can be
invoked from it, and it is not the conversation request. It is also pre-existing shape — the probe measures
`catalog.all()` rather than `visibleSchemas()`, which predates this change. Recorded here rather than hidden.

**The `/memory` picker keystroke was not exercised.** The panel opens in the real TUI and renders
`自动记忆 OFF · 抽取已关闭` with `[↑↓] 选择 · [Space] 切换 · [Enter] 固定 · [Esc 保存退出]`, but a scripted
PTY keystroke did not land the toggle — a scripted space did not change the persisted value. The OFF and ON
states were therefore entered through `settings.json`, not through the keystroke. The toggle's own persistence
and atomic commit are covered by the TUI and engine tests; what the PTY rows above prove is the *assembly*
consequence, which is the part the contract is about. **Not verified here:** that one keystroke flips the
persisted setting in a real PTY.

## T4 — command execution tells the truth

| # | Operation | Observed | Evidence |
|---|---|---|---|
| T4.1 | TUI issues `bash` for a domain that is not on any allowlist, interactive mode | The approval prompt renders with the command and the three choices (`[y] 本次允许` / `[a] 总是允许（本会话）` / `[n] 拒绝`) | PTY phase E, terminal output |
| T4.2 | Approve once (`[y]`), same session | The command **actually runs** — it is not blocked by policy — and returns `{"code":0,"stdout":"HTTP=000CURL_FAILED\n","stderr":"curl: (28) Connection timed out after 5002 milliseconds\n"}` | PTY phase F, tool result in the capture log |
| T4.3 | Same result surface | The failure **reason is in stderr in the model-visible result**, not only in the trace row. Before this change the background and verify routes dropped stderr, and a plain type said nothing | `{"stderr":"curl: (28) …"}` vs the old `{"code":0,"stdout":"…","stderr":""}` shape from the incident trace |
| T4.4 | Background route, unknown domain | Fail-closed: the background route receives a policy with no approval gate, so it cannot ask and cannot reach the network | `tests/harness/aci/bash-background-egress-fail-closed.test.ts` (runs the real filter and asserts the `no-approval-inlet` sink) |
| T4.5 | Verify route, every exit path | Egress session released on success, nonzero exit, timeout, denied egress, and spawn failure; a failing dispose is recorded, never swallowed | `tests/harness/verify/sandbox-run-egress-release.test.ts` (8 cases) |
| T4.6 | Pipeline semantics | A producer piped through `tail` reports `tail`'s real status; there is no global `pipefail`. The status is honest, not a recovery of the producer's | `tests/harness/aci/bash-signal-and-pipeline.test.ts:106` |

### Explicit non-pass with reason

**An end-to-end "approve an install, then use the installed executable from the same session" run was not
performed.** The T4.1–T4.3 run proves the approval gate, that the command really executes after approval, and
that its stderr survives. It does not prove that approving `npm i -g typescript-language-server` leaves the
*harness* able to resolve that binary — the incident's actual complaint. Two reasons: the install target was a
network fetch that timed out in this environment (T4.2 shows the timeout), and the same-session resolution
recovery is covered directly by `tests/harness/lsp/install-recovery-real-server.test.ts` rather than through an
interactive install. **Not verified here:** the install-then-consume path driven from a live approval.

**The cross-mode parity clause (ordinary vs `full_auto` for the same install) has no test.** The reviewer
flagged it; it is not implemented and is not claimed here.

## T5 — LSP

| # | Operation | Observed | Evidence |
|---|---|---|---|
| T5.1 | `npm run probe:lsp -- --lang typescript` | **exit 0, all green (10/10)**, with `lsp_definition (hit probe_lib.ts (languageIdFor))` — a real cross-file hit, not the old `(no client.ts)` annotation | run after the repair, below |
| T5.2 | `npm run probe:lsp -- --lang python` | **exit 0, all green (9/9)**, `venv: .iknow/probe-lsp/python/.venv/bin/python`, `lsp_definition (hit offset.py (compute_offset))` — a hit in the *second* source file, so the cross-file assertion is real | run after the repair, below |
| T5.2b | The Python target on disk | `.venv/`, `pyproject.toml`, `probe_pkg/`, `probe.py`, `probe_broken.py` — a real project, against the old single `probe.py` + `pyrightconfig.json` | `.iknow/probe-lsp/python/` |
| T5.3 | Required operation that cannot run | The run fails with a non-zero exit naming the operation, instead of being skipped into a green total | `scripts/lsp-probe.ts` required-op floor |
| T5.4 | Definition / hover / cross-file references / diagnostics | Each carries a real content assertion; definition is gated on the expected target rather than annotated | `scripts/lsp-probe.ts` |
| T5.5 | Executable resolution | Explicit override stays highest, then the active project / worktree install, then the harness, then PATH | `tests/harness/lsp/server-resolution.test.ts` |
| T5.6 | Failed start | Server identity **and** the failing stage are reported, with bounded stderr retained | `tests/harness/lsp/start-failure.test.ts` |
| T5.7 | Same-session retry after an install | Bounded by `MAX_LSP_RECOVERY_ATTEMPTS`; does not latch the pool shut down | `tests/harness/lsp/start-failure.test.ts`, `src/harness/lsp/client.ts` |

Verbatim probe tails after the repair:

```
$ npm run probe:lsp -- --lang typescript
✓ lsp_definition (hit probe_lib.ts (languageIdFor))
✓ lsp_references (hit probe_lib.ts (languageIdFor))
✓ lsp_hover
✓ lsp_document_symbol
✓ lsp_workspace_symbol
✓ lsp_go_to_implementation
✓ lsp_prepare_call_hierarchy
✓ lsp_incoming_calls
✓ lsp_outgoing_calls
✓ lsp_diagnostics (diagnostics XML)
all green (10/10)                                            exit 0

$ npm run probe:lsp -- --lang python
  venv: .iknow/probe-lsp/python/.venv/bin/python
✓ lsp_definition (hit offset.py (compute_offset))
✓ lsp_references (hit offset.py (compute_offset))
✓ lsp_hover
✓ lsp_document_symbol
✓ lsp_workspace_symbol
- lsp_go_to_implementation (skipped: MethodNotFound sentinel — server 未实现该方法)
✓ lsp_prepare_call_hierarchy
✓ lsp_incoming_calls
✓ lsp_outgoing_calls
✓ lsp_diagnostics (diagnostics XML)
all green (9/9)                                             exit 0
```

The remaining `lsp_go_to_implementation` skip is an *optional* operation on a server that genuinely does not
implement it, and it is still reported on the console rather than folded silently into the total.

## Regression

| Operation | Observed |
|---|---|
| Full `npm test` at the command-execution commit | **507 files, 7651 tests passed**, 531 s, run by the pre-commit hook against this exact working tree |
| `npm run typecheck` | exit 0 |
| Focused set after the repair (memory + engine + hub prefetch) | **24 files, 606 tests passed** |
| Focused set after the repair (LSP + ACI + verify + memory + sandbox + bash) | **145 files, 2215 tests passed** |
| `node $HOME/.claude/plugins/.../s5-complexity/check.mjs --changed --base 30a931d15` | **exit 0 — 170 touched functions within baseline**, no regression |

The complexity ratchet is the same check the pre-commit hook runs; it was red on this range after the first
review and is green now.

## Known limitations carried forward

- `lsp_diagnostics` returns empty for a file an earlier operation already opened and closed; the probe
  asserts diagnostics against a dedicated fixture instead. See the T1 evidence doc, follow-up section.
- `stage` is optional on `LspClientFailure` because `src/harness/aci/tools/symbol-mutate.ts` constructs a
  failure without one.
- The internal ADR-0043 token-budget probe still lists the registered memory tools (T6 non-pass above).
- Default settings are dual-off, so a default install has no memory capability until the switch is turned on.
  This is the ratified contract, recorded as a `Breaking` entry in `CHANGELOG.md`.