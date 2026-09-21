# Spec: code restore on rewind

**Status:** assumptions confirmed; architecture-change-reviewer not yet run  
**Surface:** session transcript projection + session-folder blobs + harness write-tool port + TUI confirm + rewind HTTP

## Objective

When the operator rewinds a session to an earlier user-message anchor, they can also put workspace files back to the bytes those files had before the abandoned head-chain segment. The user is the person at the TUI rewind picker (and any HTTP client that sends the same flag). Success means transcript rewind and workspace restore are separately choosable, and the transcript stays the only history authority.

## Module cut

No new top-level capability. Four pieces, each in an existing module:

1. **Pure plan** — `src/session-api/store/code-preimage.ts`, sibling of `rewind-targets.ts`. Input is the abandoned head-chain segment (parent transcript events whose spawn falls in that segment, plus those workers' transcripts). Output is an ordered list of inverse file ops and a drift/identity report. No workspace IO. No directory scan. Order comes only from event `id` / `parent`.

2. **Blob IO** — `src/session-api/store/code-snapshot-store.ts`. Content-addressed files at `<session folder>/code-snapshots/<sha256>`, `flag: "wx"` write-if-missing. Directory name is a constant in `src/shared/session-tree-names.ts`. Parent session writes go through the hub serialize queue. Worker writes go through the worker transcript queue. Both may wx the same blob bytes. There is no shared manifest file.

3. **Harness capture port** — one injected function on the write tools, same shape as `WorkerTranscriptIO` and `onEdit`: harness defines the function type and calls it; the host (cli / session-api assembly) supplies the implementation. Harness does not import session-api (Gate B). Call sites are the ACI paths that already write workspace bytes and already fire `onEdit`: `edit_file`, `write_file`, and `symbol-mutate`. The port runs before the workspace write. Port failure fails the tool and leaves the file untouched. The returned sha is what the host later stamps on that tool's transcript event. Model-visible tool output stays free of file bodies.

4. **Rewind orchestration** — `SessionHub.rewindSession` grows a `restoreCode` flag. Transcript head movement stays `rewindToHead`. When the flag is true, the hub calls the pure plan, then applies ops. Apply lives next to the plan (`applyCodeRestore` in the same store module): for each path, write the preimage only when the current bytes equal that path's last captured post-image in the abandoned segment; delete a created file only under the same check. TUI (`rewind-picker.tsx`, `app.tsx`) and HTTP (`contract.ts`, `http.ts`) only pass the flag.

Settings stay in `src/config/settings.ts`: user-layer `codeRestore.enabled?: boolean`. Absent means enabled. No `maxSnapshots`. Project settings files do not gain this section (same drop rule as other non-allowlisted sections).

## Boundaries

- **Does:**
  - Capture full pre-write bytes and post-write bytes for successful `edit_file`, `write_file`, and `symbol-mutate` calls, including worker transcripts nested under the parent session folder.
  - Record on the tool transcript event: path relative to the live **taskRoot** at the call, root identity, preimage sha, post-image sha.
  - On rewind, cut at the existing rewind target `head` (the chosen user message's parent).
  - TUI confirm offers three actions: rewind transcript and restore code, rewind transcript only, cancel.
  - HTTP rewind accepts an explicit `restoreCode` boolean; omitted means false.
  - Drift (current bytes differ from the last captured post-image) or a live **taskRoot** identity different from the captured root: skip workspace writes for the mismatched paths, list them on the rewind receipt, still move the rewind head.
  - `codeRestore.enabled: false` stops new captures. Already stored preimages remain usable.
- **Confirms with human:** (none — assumption list confirmed)
- **Out of this spec:**
  - bash mutations, `fence-tmp`, symlink and hardlink restore, Git stash or a shadow repo
  - explore workers that do not have write tools
  - snapshot byte quotas, refcount GC, and `maxSnapshots`
  - binding a snapshot ref onto `CheckpointRecord`
  - a second on-disk history that is not referenced from transcript events

## Success Criteria

- `npm test` exits 0, including the new cases below.
- A fixture that edits a file, rewinds with `restoreCode: true`, and reads the file back sees the pre-edit bytes.
- The same fixture with `restoreCode: false` (and with the field omitted on HTTP) leaves the file bytes unchanged while the rewind head moves.
- A fixture that changes the file again after the captured write, then rewinds with `restoreCode: true`, leaves those bytes unchanged and reports that path; the rewind head still moves.
- A fixture whose live **taskRoot** identity differs from the identity stored on the event performs no workspace write.
- A capture-port failure (injected IO error) rejects the tool call and leaves the workspace file unchanged.
- Two identical preimages in one session folder produce one blob file.
- A parent rewind whose abandoned segment contains a worker `edit_file` or `write_file` restores that worker's file under the same drift rule.
- Picker confirm content lists the three actions; the execute action carries the boolean the hub receives.

## Open Questions

(none)

## Inherits / Changes

Quoted from `docs/CONTEXT.md`:

- **session transcript**: 会话权威账本——单文件 append-only JSONL，每条事件有 id 与 parent；当前可见历史由 **rewind head** 投影，旧链保留。ADR-0027。
- **rewind head**: 落盘的当前头指针（transcript 某条事件 id）。rewind 只改这个指针，不截断 JSONL。进程内工作副本跟它走。
- **taskRoot**（活值）: 会话当前生效的 task worktree 根——**写与工具 cwd 只问它**。
- **ACI tool set**: Harness 装配层（`src/harness/aci/`）注册的工具集。

ADRs this contract depends on:

- ADR-0027 — transcript remains the authority; preimage blobs are payloads addressed by sha from tool events.
- ADR-0071 D2 / D4 — record lives in the conversation-id leaf; reclaim is delete-the-folder. New directory name is registered beside `subagents/` and `fence-tmp/`.
- ADR-0036 — sha256 + `flag:"wx"` write-if-missing.
- ADR-0110 — each transcript has one writer. Blob bodies are immutable wx. No shared mutable index.
- ADR-0102 — worker transcript stays under the parent session folder; restore reads it, and does not create another session leaf.
- ADR-0037 / ADR-0070 — restore does not create or enter a worktree.

Gate B stays: `src/harness` does not import `src/session-api`.

### 待写入

- **代码前像**: 一次成功的 `edit_file` / `write_file` / `symbol-mutate` 改盘之前的文件字节。按 sha256 放在该会话文件夹的 `code-snapshots/`。引用（相对当时活 taskRoot 的路径、根身份、前像 sha、后像 sha）写在产生这次写入的转录本事件上。
- **代码回退**: rewind 时沿被放弃的 head 链（含该段内的工人转录本）逆放代码前像。仅当该路径当前字节等于这段链上最后一次已捕获后像、且当前活 taskRoot 身份与捕获时一致时写回。否则跳过该路径并写进回执。转录本 rewind head 的移动不依赖写回是否发生。
