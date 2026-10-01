# 0004. Tool layer six-tool set (bash / read_file / grep / glob / edit_file / write_file)

Date: 2026-08-04
Status: accepted

Amendment 2026-09-30: ADR-0134 partially supersedes Decision 1's statement that Bash timeout is not exposed to the model. Bash gains optional `timeout_ms`, a 10-second foreground default, and the explicit-background timeout/omission contract. Timing remains host-enforced; the other tool-layer decisions remain in force.

Amendment 2026-09-12: `grep`'s default output shape and count parameter **`head_limit`** are ruled in ADR-0084; the grep clause below ("output is a plain string `path:line:content`") is no longer the default rendering (that is `output=content`). Same-day change: `read_file` without `limit` reads from offset to EOF (the "default 200 lines" in clause 2 is void; the once-drafted default/cap-both-2000 was also rejected); an explicit `limit` stays hard-capped at 2000. `write_file`'s hard rejection of non-empty unread files is ruled in ADR-0084; `edit_file` gets no last-read precondition. The once-drafted "too-short anchor forbids `replace_all`" was rejected; the edit_file clause's unique-match + explicit `replace_all` stands.

## Context

GH issue (winter6205/iknow, `[wayfinder:grilling]` tool-layer rewrite design; parent issue was the memory-layer map). The five then-current ACI tools (`shell_exec` / `fs_search` / `fs_view` / `fs_edit` / `context_manager`) each self-marked `PROTOTYPE (throwaway)` and each had a fatal flaw: shell_exec's timeout killed no process and its allowlist keyed on executable file names rather than capabilities; fs_search mixed two semantics ("search content" / "find files") in one tool (`pattern:""` matched every file); fs_view declared `isConcurrencySafe:true` yet shared closure state `lastPath/lastOffset`; context_manager was dead (`lazy:true` broken in the real CLI path). Deleting context_manager had already been ruled. The rewrite discharges that pre-decided graduation debt. The operator settled each question over 10 rounds of HITL grilling on 2026-08-03~04.

## Decision

**Six-tool set finalized under industry-common names; the executor/registry/contract layers are kept and hardened as production-ready**:

1. **bash** (replaces shell_exec). Security boundary = OS sandbox (hard prerequisite, blocking); the allowlist is demoted to an interim measure until the sandbox lands. The 12000-character output truncation carries over (fixing the current UTF-16 surrogate splitting → count by code point); timeout is not exposed to the model (unified at the executor layer); output stays structured `{code, stdout, stderr}` (for eval/trajectory).
2. **read_file** (replaces fs_view). Purely stateless (closure abolished); inputs `path` + `offset` (0-based) + `limit` (default 200 / cap 2000 — see the 2026-09-12 amendment above for the current default); NUL binary detection; 1MB file-size cap (stat before reading; over-cap is rejected and steered to grep); output is a plain string with line numbers `<n:>6\t<line>`. The current six-field shape `{path, lines, from, to, nextOffset, eof}` is abolished — `nextOffset`/`eof` are model-derivable, zero information gain.
3. **grep** (content-search half split from fs_search). ripgrep subprocess preferred + Node fallback; regex; case-sensitive by default (`ignoreCase` optional); `limit` (default 200 / cap 2000; see the 2026-09-12 amendment for the current `head_limit` shape); output was a plain string `path:line:content`.
4. **glob** (file-finding half split from fs_search). Real glob patterns (substring matching abolished); `rg --files` + Node fallback; `limit` (default 200 / cap 5000); output is alphabetically ordered relative paths as a plain string.
5. **edit_file** (replaces fs_edit). Keeps the poka-yoke linter (bracket/quote pairing checked, unpaired content refused before write — a deliberate differentiator); adds `replace_all` (default false); keeps the `split().join()` replacement (avoids `$&` pollution).
6. **write_file** (new, fills the gap). Inputs `path` + `content` + `create_directories` (default true). Semantics = create or wholly overwrite. No current tool could create a new file (edit_file requires an existing old_str; during the transition the bash allowlist bans `>` redirection). Same poka-yoke linter.

**Cross-tool contracts**:

- **Contract X (single authority for truncation metadata)**: tools return pure data with no `truncated`/`total` metadata fields; the executor is the sole authority — it measures the serialized character count itself, truncates itself, composes the marker itself, and never trusts fields claimed by tools. Closes the MCP third-party forgery surface.
- **Contract Y1 (plain-string output, since deprecated)**: the wire boundary `serialize_content_block` dropped metadata. bash is the exception (Y1b keeps the structured code). **The "plain string" reading of Y1 is subsequently superseded by the observability side-channel** — the model-facing tool_result is still a plain string (Y1's spirit retained), but a handler may return an envelope `{ output, meta? }`; the executor splits it and serializes only `output` into the model tool_result, while `meta` (typically edit_file/write_file's `oldContent`/`newContent`) travels `PostToolUseHook.payload` → `TuiToolEvent.payload` → `LiveToolRun` on the observation side-channel and never enters model view.
- **symlink**: resolve + containment land this round; mount-boundary OS isolation belongs to the later sandbox work.

**Workflow semantics**: grep/glob discovery → read_file precise reading; large files never enter context whole.

**Why not alternatives**:

- _Keep 5 tools, don't split grep/glob, no write_file_: fs_search's single-tool semantics are ambiguous (the `pattern:""` bug-class side effect); without write_file the agent cannot create files (the transitional bash fallback is also blocked by the allowlist).
- _Keep iknow-invented names (shell_exec / fs_view / fs_search)_: industry-common names lower model learning cost and sharpen prompt semantics; the rename is safe because what permission machinery loads is the `aci.category` field, not the name string.
- _Keep fs_search's structured `{matches, truncated, total}` output_: diverges from the plain-string norm; `truncated`/`total` are forgeable fields (an MCP third party could inject fake values to defeat the cap); contract X makes the executor the sole authority.
- _Keep read_file's stateful pagination_: closure state contradicts `isConcurrencySafe:true` and the serial loop never reads that state anyway; stateless is replayable, concurrent-safe, and easy to test.
- _bash plain-string output_: bash's `code` is genuinely useful for eval/trajectory (distinguishing "ran and failed" from "didn't run"); stuffing it into metadata only to discard at the wire boundary is not something iknow must copy.

## Consequences

- (+) The tool set uses industry-common names with separated action semantics — better on both model learning cost and prompt clarity.
- (+) Contract X converges truncation metadata to a single executor authority; the MCP third-party forgery surface collapses to one place.
- (+) write_file fills the "cannot create files" gap; the agent can do complete coding tasks.
- (+) read_file's statelessness removes the concurrency contradiction + hidden coupling.
- (−) Renaming to industry-common names requires syncing permission/category assembly + eval/trajectory references (old names such as `shell_exec`).
- (−) bash's production path is blocked on the OS sandbox (allowlist interim only); the five sandbox-trace items were left in the corresponding issue comments with pointers.
- (−) The edit_file/write_file poka-yoke linter risks false positives on "legal but unpaired" content (e.g. markdown code fences) — apply first, relax only on real false positives (on record).
- (−) Contract Y1 costs the model the structured `total` ("200/347 matches"); it relies on the truncation marker + "re-invoke with narrower input" guidance — readable text markers suffice for correct decisions.
- (+→−) Contract Y1 is subsequently superseded by the observability side-channel: the model-facing tool_result stays a plain string (Y1's spirit retained), while the handler envelope's `meta` field reaches observation consumers (e.g. the TUI) through a separate side-channel without polluting model view.

**Evidence pointers**:

- GH issue (winter6205/iknow) — the 10-round grilling's per-question rulings + Resolution + per-tool resolution comments.
- Predecessor issue (closed) — the context_manager deletion ruling.
- Industry tool-naming references (bash / read_file / grep / glob / edit_file / write_file).
- Related ADRs: 0005 (executor hardening) / 0006 (output capping policy).
- `src/harness/aci/tools/` — the five PROTOTYPE tools being rewritten.
