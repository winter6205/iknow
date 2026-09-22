# 0121. Code restore replays per-write preimages on the abandoned transcript chain

Date: 2026-09-22
Status: accepted

Rewind keeps moving only the **rewind head**. Workspace restore is a separate choice: successful `edit_file` / `write_file` / `symbol-mutate` calls store a **代码前像** (sha256 blob under the session folder's `code-snapshots/`) and stamp the sha on that tool's transcript event. **代码回退** walks the abandoned head chain, including worker transcripts spawned inside it, and writes a file back only when its current bytes still equal the last captured post-image and the live **taskRoot** identity matches. The transcript stays the only history authority (ADR-0027). Blobs are immutable `wx` payloads, not a second ledger (ADR-0071 D4, ADR-0036, ADR-0110).

## Why not

- **`codeSnapshotRef` on `CheckpointRecord`:** checkpoints are an interrupt side index. Ordinary completed turns, which are what the rewind picker lists, have no checkpoint. Rejected.
- **Git stash or a shadow repo:** couples restore to a repository the session may not have, and misses untracked writes the tools already captured. Rejected.
- **A filesystem watch to cover bash:** a second observer of the workspace becomes another history. Drift detection (refuse to clobber bytes we did not write) is the bash blind spot's contract. Rejected.
- **`maxSnapshots` or byte-quota GC:** a live transcript event can point at a deleted blob. Reclaim stays "delete the session folder". Rejected.
- **Sharing trace `blobs/`:** trace blob failure is swallowed (ADR-0071 D5). A preimage write failure must fail the tool before the workspace changes. Separate directory. Rejected.
