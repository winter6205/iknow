# 0006. Tool output capping (hard truncation, executor floor 20000 chars, no disk offload)

Date: 2026-08-04
Status: accepted

Amendment 2026-09-12: the `grep` tool's default entry count became 50 (hard cap 2000 unchanged), parameter name **`head_limit`**. `read_file` without a `limit` reads to EOF, no longer treating a default 200 or 2000 lines as a whole-file read strategy; an explicit `limit` caps at 2000; the 1MB file-size rejection and this ADR's executor 20000-char floor are unchanged. See ADR-0084.

## Context

Blocks C+D of the GH issue (Q9 truncation policy / Q10 cap threshold, absorbed from an earlier cap-design ticket). Problem domain: a single tool result can blow up the context window (the "single-result blowout" axis, orthogonal to the compression policy on the "cumulative growth" axis). The upstream contract (ADR-0004 contract X) already settled it: tools return pure data, and the executor is the sole truncation authority. An earlier draft Resolution (8000 chars / two-layer policy) was flagged by the operator as "skipped grilling, not a decision" and reopened; this round's grilling re-adjudicated formally. iknow has no token accounting (not built), so char-level is the only viable safety net today. Operator ruling on 2026-08-04.

## Decision

**Q9 = hard truncation, tail discarded, no disk offload.**

1. When the executor safety net exceeds the threshold: truncate + append a uniform marker (including original length / retained length + guidance along the lines of "reinvoke with more precise input if you need more information"). The full content is **not written to disk**.
2. Disk offload rejected (microcompact write-file + preview + path, the `_offload_tool_output_if_needed` pattern): offloading requires a file-path protocol + lifecycle + session-api exposure = scope expansion; the memory-layer map already decided to "discuss the history serialization protocol together with compression-policy phase 2 sliding window" — untouched this phase.
3. Rationale: most iknow tools are **regenerable queries** ("read a file / search content") — after truncation the model can grep with a narrower pattern / read_file at a different offset / bash with extra filters to re-fetch, at lower cost than maintaining an offloaded-file lifecycle. Disk offload is designed for "data cannot be regenerated" scenarios (expensive in-sandbox command output); iknow's main scenarios do not fit.

**Q10 = executor safety-net threshold of 20000 chars.**

4. Hard constraint: >= each tool's normal maximum output, avoiding duplicated two-layer truncation. Per-tool normal maxima: bash 12000 (already truncated at tool level) / grep 200 entries x ~70 chars ≈ 14000 / glob 200 entries x ~50 chars ≈ 10000 / read_file bounded by the 1MB file-size cap. 20000 ≈ 5000-10000 tokens.
5. Against the inline threshold of 16000: iknow is slightly looser — because there is no second offload layer this phase, the single threshold must be wider.
6. The two layers each own their lane: tool level governs "how much to read" (semantic units: lines/entries/chars), executor governs "output never exceeds how much" (char-level floor).

**Tool-level truncation parameters (settled together with the ADR-0004 tool set)**: bash 12000 chars (counted by code point, fixing surrogate-pair splits) / read_file limit default 200, cap 2000 lines + file size 1MB / grep limit default 200, cap 2000 / glob limit default 200, cap 5000.

**Why not alternatives**:

- _Offload + preview + path_: see Decision 2-3; moreover the memory-layer map has reserved it for compression-policy phase 2's unified discussion, and landing it this phase would fragment the history-serialization protocol design.
- _The earlier draft's 8000-char floor_: 8000 < bash's tool-level 12000 -> bash truncates to 12000 then the executor truncates again to 8000 — duplicated two-layer truncation + marker conflict. Formally overturned.
- _Relative threshold as a fraction of modelWindow_: depends on token accounting (not built), infeasible this phase; filed as a memory-layer-map phase-2 derivative.
- _Executor trusts the tool's truncated field and skips the safety net_: violates contract X (the executor never trusts fields claimed by tools); MCP third parties could forge `truncated:true` to bypass the cap.

## Consequences

- (+) The "single-result blowout" axis is closed: any tool's output (including future MCP third parties) passes the executor master gate and can never exceed 20000 chars.
- (+) The two truncation layers do not conflict: tool-level (semantic units) and executor-level (char floor) thresholds do not overlap (20000 > each tool's normal maximum).
- (+) No offload = no operational burden of file lifecycles / path protocols / session-api exposure; small implementation surface.
- (−) Over-threshold output is **unrecoverable** (the tail is truly lost) — recovery relies on the model "re-invoking with narrower input"; for non-regenerable output (e.g. one expensive build log) this is a real loss. Mitigation: bash's tool-level 12000 truncates first, so the executor layer rarely fires; disk offload to be revisited in compression-policy phase 2.
- (−) Char-level != token-level precision: 20000 chars floats at roughly 1:1~1:4, i.e. about 5000-10000 tokens; the error is controllable under the ceiling; token-level precision waits for token accounting to land.
- (−) Overturns the earlier draft number (8000): this ADR is authoritative; that Resolution archive is annotated "draft, overturned by this grilling round".

**Evidence pointers**:

- The C+D block resolution comments + Resolution on the GH issue (2026-08-04).
- Predecessor issue (closed) — the draft Resolution (8000 chars) archived, formally overturned by this ADR.
- Reference: `engine/query.py:524-553` (`_offload_tool_output_if_needed`, 16000 threshold + 3000 preview + disk offload) / `services/tool_outputs.py:10-12` (configurable threshold + microcompact 4000) / `tools/bash_tool.py:139-140` (12000 hardcoded).
- Related issues: token accounting (precondition for relative thresholds), compression policy (offload revisit point).
- Related ADRs: 0004 (tool set + contract X) / 0005 (executor hardening — the body that executes this safety net).

**Scope narrowed (ADR-0083)**: `skill()`'s assembled body is moved out of this ADR's safety-net gate — the exemption is a static declaration at assembly time (`ToolDef.exemptFromOutputCap`), not a runtime field, so contract X stays intact. The 20000-char ruling for all other tools (including MCP) is unchanged. See `docs/adr/0083-skill-body-exempt-from-executor-output-cap.md`.
