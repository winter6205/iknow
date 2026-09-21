# 0102. Subagent continuation: relaunch a dead process, never inject into a running loop

Date: 2026-09-18
Status: accepted

Amends ADR-0101 (adds lifetime; same-turn parallelism and `subagent_stop` are unchanged). Does not change ADR-0014's `wait` default. Does not change ADR-0040's dual `conversationId` division of labor.

## Context

Today the worker loop persists only a per-agent **trace** (`subagents/agent-<taskId>.jsonl`). Main-session continuation consumes the **session transcript**. The two are deliberately not equal (ADR-0071). If the parent wants the same worker conversation to do one more stretch, calling `spawn_subagent` again yields an amnesiac worker.

Resume means: the worker **is no longer running**, and it is relaunched from its transcript. Something still working has no such thing as resume (that would be mid-run injection). Failure, crash, timeout, and stop — and one more sentence after a successful handoff — mechanically take the same path. The gate cannot be whether the TUI shows `✓ Done`.

## Decision

1. **The gate = process dead + a worker transcript written after this slice.** `subagent_continue` takes this session's `task_id` plus the next sentence. `running` is rejected. `completed` / `failed` / `aborted` may all continue as long as a transcript exists. Those with only a trace and no transcript before this slice are rejected — never backfilled from trace.
2. **Relaunch, no keep-alive.** A new worker process; `load` the rewind head of the worker transcript, append the next user sentence, then `run()`. Not delivery to the old pid.
3. **Worker transcript:** the same append-only JSONL shape as the main session (the SessionFileV1 read path can consume it). It lives under the parent session folder's `subagents/` and **must not overwrite** `agent-<taskId>.jsonl`. Keyed by `(parent conversationId, task_id)`. Parsing reuses store load/save; `listSessions` does not index it. From this slice on, each spawn has the worker loop **append while running**. Existing per-agent trace is untouched and never a continue source. No extra session leaf in the project pool, and no second global copy of the worker trace.
4. **The outward handle stays `task_id`.** Lookup / stop / continue all accept it.
5. **The wait contract follows normal spawn.** Omitting `wait` stays foreground; `wait:false` stays background + mailbox.
6. **No mid-run injection.** To correct a running worker: stop it, or continue after it dies.

## Why not

**Why not accept only completed:** failure/crash are the main drivers of continuation.  
**Why not allow continue just because no ✓ Done was drawn:** cards are not lifetime; `running` would be mistaken for resumable.  
**Why not synthesize a transcript for the old worker from trace:** what-the-model-saw ≠ conversation history.  
**Why not let a worker hold a session leaf:** ADR-0071 already rejected peer-level subagent sessions.  
**Why not dump only at terminal state:** the parent holds only a short envelope and cannot reconstruct the dialogue chain.

## Consequences

- (+) After failure, retry with context intact; a follow-up sentence after success goes through the same tool.
- (−) Workers must write a nested transcript; SessionStore must load by nested keys and cannot assume one id = one leaf in the pool.
- (−) Extending `subagent_continue` to `running` requires amending this ADR.

## Evidence

- ADR-0071 Decision 6 / CONTEXT **session transcript** vs **what the model actually sees**.
- `subagents/agent-<taskId>.jsonl` is the per-agent trace (ADR-0035 / ADR-0071).
- ADR-0101: `task_id` is the parent-side dispatch handle.
