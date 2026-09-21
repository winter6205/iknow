# Spec: Path-based image reading into Anthropic vision

**Status:** draft
**Basis:** operator-authorized agent discretion + this turn's request to write spec/plan (the decision process is archived under `docs/archive/027-retire-wayfinder-charts/`, which is not a citation basis)
**Surface:** ACI read tool + tools executor + session persistence (`tool_result.content`) + Anthropic adapter passing it to the wire verbatim

## Objective

Let the main session (and any entry sharing the default ACI registry) invoke a tool on an image at a **path inside the workspace fence**, placing the pixels as an Anthropic SDK 0.115 `ImageBlockParam` inside `tool_result.content`, so the next `step` reaches `messages.create` / `.stream` unchanged. Users still send text only (`encodeUserText` untouched). The `read_file` text contract (NUL rejects binary, line pagination) is unchanged.

Success: the model calls `read_image` on a ≤1MB jpeg/png/gif/webp file, an SDK-shaped image block appears in the authoritative history, and after resume a further `step` still carries the same block; non-image binaries and oversize files still fail as typed errors.

## Assumptions (confirmed, no further replies awaited)

The operator has ruled on the destination and G1–G3; this list is part of the contract.

1. Pin the stable `ImageBlockParam` of `@anthropic-ai/sdk` 0.115 (base64 + `media_type` ∈ jpeg/png/gif/webp). No beta `file_id`.
2. The new ACI tool name is frozen as **`read_image`**. Do not extend `read_file`.
3. Path resolution shares the same fence as `read_file` (`resolveReadTarget` / `resolveWithinRoot` semantics).
4. MIME is decided by magic bytes, not by extension.
5. Size cap = the current `read_file` 1MB, judged before encoding.
6. The success payload lives in **`tool_result.content`**; never put `{ type: "image" }` at the message top level (session `isValidContentBlock` has no top-level image).
7. `safeContent` opens the hole **only** for the `read_image` success arm; all other tools still collapse to text. The image arm is not subject to ADR-0006's character hard cap (that is a text measure).
8. No model vision-capability table; sending to a non-vision model surfaces 4xx through the existing API error surface.
9. The authoritative history persists the SDK base64 (embedded in `tool_result`); the adapter does not hydrate by path.
10. `read_image` does **not** enter the last-read ledger.
11. TUI: same retract / live noise class as `read_file`; pixels are not rendered.
12. Sub-agents / workers: follow the default `createDefaultAciRegistry`, no separate seam.
13. Pasted images, MCP image pass-through, `web_fetch` `image/*`, generated images, assistant-output images: not in this spec.

## Boundaries

- **Does:**
  - Add `read_image`: input `{ path: string }`; on success `tool_result.content` contains one `{ type: "image", source: { type: "base64", media_type, data } }` (an optional very short text labelling the path may accompany it; the pixels are authoritative in the image block).
  - Magic bytes admit only jpeg/png/gif/webp; files containing NUL or a non-allowlisted magic number are typed-rejected (distinguishable from the "read as text" failure).
  - `stat` directory / ENOENT / >1MB: typed `ToolExecutionError`, no disk write, no image encoding.
  - The executor success arm recognizes image content blocks and hands them to `encodeToolResults` verbatim; the failure arm stays text.
  - `ACI_TOOLSET_NAMES` gains `read_image` **append-only** (Gate 3: the names list and factories stay in the same order).
  - `read_file` on the same png: still NUL-rejects as binary (regression).
  - Session save/load: an image embedded in `tool_result.content` round-trips into a shape the SDK can accept again.
  - Description: D9 STATIC lock; trajectory set **registered, not built** (no selection divergence; the hard gate sits in handler + schema).
  - compact / token estimation: messages containing nested images **must not estimate to 0** (the formula is not pinned; only nonzero, and evaluateCompactTrigger must not crash).
- **Confirms with human:** (none — the assumption gate is closed)
- **Out of this spec:**
  - TUI / Web user image pasting, clipboard.
  - MCP `type: "image"` pass-through.
  - `web_fetch` admitting `image/*`.
  - Assistant-turn `image` (the existing ProtocolError stands).
  - Changing `encodeUserText` / top-level image on user messages.
  - Model capability registry, pre-rejection by model id.
  - Last-read bookkeeping, `write_file` gate semantics.
  - Exact image token formula, compact strategies that prefer dropping images.
  - New TUI thumbnail rendering.
  - A provider-agnostic second content model.

## Success Criteria

Every criterion is verifiable via `vitest` green/red (the plan picks the test files for implementation; this spec does not invent paths as contracts).

- **SC1** `read_image` on a file whose magic is PNG/JPEG/GIF/WEBP and ≤1MB: the ok `tool_result.content` contains `type === "image"` with `source.type === "base64"` and `media_type` within the SDK's four values, `data` non-empty.
- **SC2** `read_file` on the same PNG: still `binary file rejected` (or the current equivalent typed message), never returns an image.
- **SC3** Contains NUL but not one of the four magics (or not recognizable as an allowed image): `read_image` fails typed, no image block produced.
- **SC4** `path` empty / non-string / outside the fence / ENOENT / directory / size>1MB: typed failure, no image.
- **SC5** Success paths of all other ACI tools still produce text-only tool_results (the `safeContent` hole does not leak).
- **SC6** `ACI_TOOLSET_NAMES` contains `read_image` and agrees with factories at Gate 3; if there is no absence-assembly condition it is always resident.
- **SC7** After sanitizing → saving → loading a `SessionFileV1` containing that `tool_result`, the nested image is still there and `buildMessageParams` does not strip it.
- **SC8** `interpretMessage` still raises ProtocolError for assistant `image`.
- **SC9** `estimateMessagesTokens` (or the current compact estimation entry) on a tool_result containing only a nested image with no text: **result > 0** and `evaluateCompactTrigger` does not throw.
- **SC10** A successful `read_image` does not write the path into the last-read ledger (subsequent `write_file` gate behavior on unrelated text files is unchanged by having read an image; overwriting a read png is not allowed by ledger entry — this tool never books entries at all).
- **SC11** The description enters the D9 STATIC lock; the roster in `docs/guides/prompt-development.md` gains a line for this tool: STATIC + trajectory set registered, not built.

## Open Questions

(none)

## Inherits / Changes

### Cited from CONTEXT.md (verbatim, not redefined)

**ACI tool set**: the tool set registered by the harness assembly layer (`src/harness/aci/`); **baseline 8** (`bash` / `read_file` / `grep` / `glob` / `edit_file` / `write_file` / `web_fetch` / `web_search`) growing since in append-only batches (memory 2 / skill / subagent / todo / mcp / bg / run_graph / trace read side / **symbol tool surface** 15 / worktree 5 …). **The current count takes the length of the `src/harness/aci/tools/registry.ts:ACI_TOOLSET_NAMES` array as the sole SSOT and this entry does not restate a number** (that file itself declares "this table's length takes the array as source of truth"). The SSOT factory = `createDefaultAciRegistry` in the same file; every entry (`build-engine` / `tui/deps`) takes it from here (#141 / #191 / a277f68). Every tool call passes through the permission middleware (ADR-0004) and timeout tier decoration.

**last-read ledger**: the register of "spec paths seen" within this conversation. **Process memory**, keyed by conversationId, never persisted to the session folder. Booked on: successful `read_file`, or successful allowlisted `bash` from which a single path can be extracted (`cat` / `nl` / `bat` / `batcat` / `head` / `tail` / `sed -n 'X,Yp'` / `grep` / `egrep` / `fgrep` / `rg`; single file, no pipes, no redirection). Consulted only by `write_file` against files that exist and have size>0; missing means hard reject, no disk write; new files and empty files are exempt. `edit_file` does not consult the table. Does not scan `ctx.messages`. Without a conversationId, non-empty overwrite fails closed. Resume starts with an empty table. ADR-0084.

**retract class (set)**: tool classes that, once settled, do not spread a body preview (reads / most searches / queries). Whether live output enters the progress block is asked of **live noise**, not folding this whole table into `calling`. `read_file` still does not render file content; `web_search` / `web_fetch` follow **live signal**.

### Existing seams in this repo that the contract depends on

- `encodeUserText` encodes only text user messages; `buildMessageParams` filters system then sends `as MessageParam[]` verbatim to the wire.
- `safeContent` (`src/harness/tools/executor.ts`) today compresses success payloads into `[{ type: "text", text }]`.
- `AnthropicContentBlock` has no top-level `image`; `tool_result.content` is `unknown`; session `isValidContentBlock` does not recursively validate the content of a `tool_result`.
- `read_file`: NUL → binary rejected; `MAX_FILE_BYTES` 1MB.
- SDK `ToolResultBlockParam.content` permits `ImageBlockParam`.
- Prompting: `docs/guides/prompt-development.md` — the guide is not a gate; a new tool's description goes through D9 STATIC.

### Changes (relative to current state)

- ACI gains 1 tool, `read_image` (append-only).
- The executor gains an image-content pass-through arm (only this tool's success path).
- Compact estimation is nonzero for nested images (SC9).
- The TUI retract / live noise roster includes `read_image` (same class as `read_file`).

### Pending write-in (persist)

- CONTEXT: the **ACI tool set** growth batch gains `read_image` (still no count restated in the entry); **last-read** _Avoid_ or body marks that `read_image` does not book entries; **retract / live noise** names `read_image` as same class as `read_file`.
- ADR: this slice opens no new ADR (the protocol does not change the top-level `AnthropicContentBlock`; failures use the existing `ToolExecutionError` / API error). If landing forces a change to the top-level union, open an ADR then and stop at persist.

persist (spec Step 4): the CONTEXT entries above have been written into this worktree's `docs/CONTEXT.md` (including the new term **read_image**). No new ADR.

## architecture-change-reviewer

```
bounded-context-guardian: yes — no new BC: the tool lands in ACI + executor pass-through arm + compress estimate (all still harness); TUI only edits existing rosters; ACI_TOOLSET_NAMES gets a tail append-only
input-contract-tests: yes — public entry read_image({path}): empty/invalid/out-of-fence=SC4, non-allowlisted magic=SC3, overflow>1MB=SC4, ENOENT/directory=SC4; concurrent N/A (not in last-read; executor serial)
error-handling-enforcer: yes — directory/ENOENT/>1MB/non-allowlisted magic all yield ToolExecutionError with no disk write and no image encoding; failure arm stays text; non-vision uses the existing API 4xx; SC5 pins that the safeContent hole does not leak
complexity-anti-drift: yes — standalone read_image file (not stuffed into read-file.ts); registry appends one name only; handler owns magic/size, executor only recognizes the image block for pass-through
minimal-change-verifier: yes — single task "path image read via Anthropic native tool_result"; pasted images/MCP/web_fetch/top-level user image carved out
```

OVERALL: PASS — hand to writing-plans
