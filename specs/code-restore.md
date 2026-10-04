# Spec: code restore on rewind

**Status:** ACR all-yes (see `plans/code-restore.md`)  
**Surface:** session transcript projection + session-folder blobs + harness write-tool port + TUI confirm + rewind HTTP

**Related accepted contract:** [Native session checkpoint architecture](session-checkpoint-architecture.md) and [ADR-0136](../docs/adr/0136-native-session-checkpoint-architecture.md) extend captured file evidence with durable pre-write operation associations for restart reconciliation. This document continues to define explicit manual rewind; its opt-out, root/drift checks, and missing-preimage preflight remain in force. The new automatic recovery protocol is not implemented and does not turn session entry into code rewind.

## Objective

When the operator rewinds a session to an earlier user-message anchor, they can also put workspace files back to the bytes those files had before the abandoned head-chain segment. The user is the person at the TUI rewind picker (and any HTTP client that sends the same flag). Success means transcript rewind and workspace restore are separately choosable, and the transcript stays the only history authority.

## Module cut

No new top-level capability. Four pieces, each in an existing module:

1. **Pure plan** — `src/session-api/store/code-preimage.ts`, sibling of `rewind-targets.ts`. Input is the abandoned head-chain segment (parent transcript events whose spawn falls in that segment, plus those workers' transcripts). Output is an ordered list of inverse file ops and a drift/identity/skip report. No workspace IO. No directory scan. Order comes only from event `id` / `parent`; the refs of one path coming from more than one transcript in the segment have no order on any single chain — the path is a receipt skip, never a parent-then-worker concatenation or a `createdAt` sort.

2. **Blob IO** — `src/session-api/store/code-snapshot-store.ts`. Content-addressed files at `<session folder>/code-snapshots/<sha256>`, `flag: "wx"` write-if-missing. Directory name is a constant in `src/shared/session-tree-names.ts`. Captures write their blobs directly at capture time (before the pending workspace write), not through any transcript queue — `wx` is idempotent per content address, so a parent and a worker racing on identical bytes is the normal dedup path, not a fault. The hub serialize queue / worker transcript queue order the commit-side drain → stamp pair, not the blob writes. There is no shared manifest file.

3. **Harness capture port** — one injected function on the write tools, same shape as `WorkerTranscriptIO` and `onEdit`: harness defines the function type and calls it; the host (cli / session-api assembly) supplies the implementation. Harness does not import session-api (Gate B). Call sites are the ACI paths that already write workspace bytes and already fire `onEdit`: `edit_file`, `write_file`, and `symbol-mutate`. The port runs before the workspace write. Port failure fails the tool and leaves the file untouched. The returned sha is what the host later stamps on that tool's transcript event. Model-visible tool output stays free of file bodies. Capture hosts are exactly two: the parent hub engine (session-api assembly) and the subagent worker process (the cli worker entry's assembly). The chat REPL is **not** a capture host — its engine assembles no port, and it has no `restoreCode` rewind surface (rewind lives on the hub/TUI/HTTP path); subagents spawned from chat still capture in their own worker process against the parent session folder.

4. **Rewind orchestration** — `SessionHub.rewindSession` grows a `restoreCode` flag. Transcript head movement stays `rewindToHead`. When the flag is true, the hub calls the pure plan, then applies ops. Apply lives next to the plan (`applyCodeRestore` in the same store module): for each path, write the preimage onto the live **taskRoot** only when that path's refs in the abandoned segment come from a single transcript and the current bytes equal that chain's last captured post-image; where the preimage ref records that the path was absent before that write, delete it under the same check instead of writing bytes. TUI (`rewind-picker.tsx`, `app.tsx`) and HTTP (`contract.ts`, `http.ts`) only pass the flag.

Settings stay in `src/config/settings.ts`: user-layer `codeRestore.enabled?: boolean`. Absent means enabled. No `maxSnapshots`. Project settings files do not gain this section (same drop rule as other non-allowlisted sections).

## Boundaries

- **Does:**
  - Capture full pre-write bytes and post-write bytes for successful `edit_file`, `write_file`, and `symbol-mutate` calls, including worker transcripts nested under the parent session folder.
  - Record on the tool transcript event: path relative to the live **taskRoot** at the call, root identity, preimage sha, post-image sha, and whether the path was absent before that write.
  - On rewind, cut at the existing rewind target `head` (the chosen user message's parent).
  - Apply every restore write and every delete on the live **taskRoot** — never on the session file's `workspaceRoot`; after a worktree rebind the two diverge and a stable project identity alone must not pass.
  - Delete a created path only when its preimage ref records that the path was absent before that write; a file that already existed — including one that existed empty — is written back with preimage bytes, never deleted. Absence is captured at the write, never inferred from an empty preimage.
  - Refs of one path coming from more than one transcript in the abandoned segment (parent chain plus a worker, or two workers): leave the path unchanged, list it on the rewind receipt, still move the rewind head.
  - TUI confirm offers three actions: rewind transcript and restore code, rewind transcript only, cancel.
  - HTTP rewind accepts an explicit `restoreCode` boolean; omitted means false.
  - Drift (current bytes differ from the last captured post-image) or a live **taskRoot** identity different from the captured root: skip workspace writes for the mismatched paths, list them on the rewind receipt, still move the rewind head.
  - A transcript event whose preimage blob cannot be read: typed failure, zero workspace writes, rewind head unchanged.
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
- A fixture whose live **taskRoot** and session file `workspaceRoot` have diverged: with `restoreCode: true` the preimage is written under the live taskRoot and the other tree is untouched.
- A fixture whose abandoned segment created a file: rewinding with `restoreCode: true` removes the file while its current bytes still equal the post-image; a fixture whose segment edited an already-empty file gets empty bytes written back and the file stays in place.
- A fixture where the same path has refs on both the parent chain and a worker transcript (or on two worker transcripts): the path is left unchanged, is listed on the rewind receipt, and the rewind head still moves.
- A capture-port failure (injected IO error) rejects the tool call and leaves the workspace file unchanged.
- Two identical preimages in one session folder produce one blob file.
- A parent rewind whose abandoned segment contains a worker `edit_file` or `write_file` restores that worker's file under the same drift rule.
- A rewind whose abandoned segment references a preimage blob that cannot be read leaves workspace bytes unchanged and leaves the rewind head unchanged.
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

- **代码前像**: 一次成功的 `edit_file` / `write_file` / `symbol-mutate` 改盘之前的文件字节。按 sha256 放在该会话文件夹的 `code-snapshots/`，引用（相对当时活 **taskRoot** 的路径、根身份、前像 sha、后像 sha、写入前该路径是否不存在）写在产生这次写入的转录本事件上。ADR-0121。
- **代码回退**: 沿被放弃的 head 链（含该段内的工人转录本）逆放 **代码前像**；同一路径只属于这一段里的一条转录本、当前字节等于该链最后一次已捕获后像、且活 **taskRoot** 身份一致时，才写回这个活 **taskRoot**（写入前路径不存在则删除该路径，否则写回前像字节）。跨多条转录本的同一路径、漂移或根身份不符则跳过并写入回执；前像 blob 读不到则工作区与 **rewind head** 都不变。ADR-0121。
