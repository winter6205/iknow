# 0121. Code restore replays per-write preimages on the abandoned transcript chain

Date: 2026-09-22
Status: accepted

> **Scoped extension (2026-10-03, ADR-0136):** [ADR-0136](0136-native-session-checkpoint-architecture.md) adds durable pre-write per-file intent associations for restart reconciliation, so a missing/error tool result cannot erase applicable captured write evidence. It preserves raw `code-snapshots/`, explicit capture opt-out, and this ADR's manual-rewind root/drift/chronology safeguards. Automatic recovery retains verified effects; it does not perform code rewind. This target protocol is not implemented yet.

Rewind keeps moving only the **rewind head**. Workspace restore is a separate choice: successful `edit_file` / `write_file` / `symbol-mutate` calls store a **代码前像** (sha256 blob under the session folder's `code-snapshots/`) and stamp the sha on that tool's transcript event, including whether the path was absent before that write. **代码回退** walks the abandoned head chain, including worker transcripts spawned inside it, and writes a file back on the live **taskRoot** only when that path's refs come from a single transcript, its current bytes still equal that chain's last captured post-image, and the live **taskRoot** identity matches. A created path (absent before the write) is deleted; any other match writes the preimage bytes back. The transcript stays the only history authority (ADR-0027). Blobs are immutable `wx` payloads, not a second ledger (ADR-0071 D4, ADR-0036, ADR-0110).

## Why not

- **`codeSnapshotRef` on `CheckpointRecord`:** checkpoints are an interrupt side index. Ordinary completed turns, which are what the rewind picker lists, have no checkpoint. Rejected.
- **Git stash or a shadow repo:** couples restore to a repository the session may not have, and misses untracked writes the tools already captured. Rejected.
- **A filesystem watch to cover bash:** a second observer of the workspace becomes another history. Drift detection (refuse to clobber bytes we did not write) is the bash blind spot's contract. Rejected.
- **`maxSnapshots` or byte-quota GC:** a live transcript event can point at a deleted blob. Reclaim stays "delete the session folder". Rejected.
- **Sharing trace `blobs/`:** trace blob failure is swallowed (ADR-0071 D5). A preimage write failure must fail the tool before the workspace changes. Separate directory. Rejected.
- **Sort preimages by `createdAt` across transcripts:** parent and worker are different writers. A timestamp total order is a second clock beside event id / parent, and a tie can restore the wrong bytes. Rejected.
- **Concatenate the parent chain, then worker transcripts, and fold earliest/latest:** that sequence is neither chain. A background worker that writes the same path before and after a parent write can match the live post-image and still restore an intermediate preimage. A path owned by more than one transcript is a receipt skip. Rejected.
- **Infer "created" from an empty preimage:** an existing empty file has the same bytes. Deleting it would remove a file the segment did not create. Absence is recorded at capture. Rejected.
- **Restore into the session file's workspaceRoot:** `relPath` is relative to the live **taskRoot** at the write. After a worktree rebind those roots diverge, and a stable project identity would still pass the identity check. Write target is the live **taskRoot**. Rejected.
