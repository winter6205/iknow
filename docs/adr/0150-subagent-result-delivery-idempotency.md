# 0150. Sub-agent result delivery is exactly-once per terminal generation

Date: 2026-10-21
Status: accepted
Deciders: operator
Related: ADR-0008 (token accounting / host-injected commit), ADR-0112 (drain provenance), ADR-0136 §3 (commit before the first model request), ADR-0101 (the stable sub-agent `task_id`), ADR-0102 (`subagent_continue`)

Spec: none — there is no dedicated delivery spec; the behavior contract lives here and in `docs/CONTEXT.md` (`host drain`, `terminal generation`, `delivery ledger`).

## Context

Reproduced with a synthetic real `SessionHub` + `SessionStore` (no user data): one terminal sub-agent result was injected into the model-visible history on run 1, run 2 and run 3, and the digest message was persisted three times.

The mechanism at the change's base:

- `SubAgentManager.drainCompleted` enumerates every terminal task with an envelope and **never consumes**; `shutdown` is what clears the map.
- `drainPendingSubagents` formats that permanent read into the digest. The hub calls it before **every** `run()` and the wake gate calls it too; chat calls it per round and at closeout.
- There is no delivery marker anywhere: no field on `Task`, no fact in the store, no filter in `drainCompleted`.
- `resumeTask` replaces the `Task` record under the same `taskId`, so a new terminal result is indistinguishable from the previous one at the host boundary.

Restart cannot re-deliver today because the manager map is memory-only and terminal tasks are not rehydrated. A durable ledger is therefore not required for the reported bug; the ledger's lifetime is kept equal to the manager's and the durable option is recorded as a follow-up.

## Decision

### 1. Delivery key and terminal generation

A result is identified by `(conversationId, taskId, terminalSeq)`:

- `conversationId` comes from `def.conversationId`, `""` when absent.
- `taskId` is the existing parent-visible sub-agent handle.
- `terminalSeq` is a **manager-global monotonic counter**, assigned once in `emitStop` (the single terminal signal, guarded by `stoppedEmitted`) before the mailbox publish and `endedAt`.

A resumed task gets a new `Task` and a new `terminalSeq`, so its new terminal result is deliverable and the old one is not replayed. The counter is monotonic across resume and rehydration.

### 2. Claim / acknowledge / release

The ledger moves each key through `undelivered → claimed → delivered`:

- `claimCompleted` takes all undelivered entries (filtered to terminal, `excludeFromHostDrain !== true`) and snapshots each envelope into the claim record. A second concurrent claim of the same key returns nothing.
- `release` returns a claim to `undelivered`.
- `acknowledge` moves it to `delivered`.

Claim tokens are idempotent: acknowledge/release of an unknown or already-settled token is a no-op and never throws. A claim never re-formats its envelope, and a post-claim replacement on the `Task` (timeout fallback, non-zero exit) is visible through `queryBuffer` / `waitFor`, not through a second delivery. A terminal generation is therefore "the first terminal envelope".

### 3. Read versus claim

`drainCompleted` remains a read-only, non-consuming view, but skips delivered keys. Its signature grows `opts?: { includeDelivered?: boolean }` for **diagnostics only** (`queryableSubagentTaskIds` reports which task ids a failed wake could have seen); delivery gates never pass it.

The two host-drain entry points are named for the distinction the bug lost:

- `peekPendingSubagents(...)` — the read-only gate (`drainCompleted` + format), never claims. This is what gates and diagnostics use.
- `claimPendingSubagents(...)` — the delivery take (`claimCompleted` + format). It returns the formatted text plus the claim handle.

`formatDrainedResults` and the digest prefix/body stay byte-identical, so the model-visible text does not change. `drainPendingSubagents` is renamed (all call sites move together); leaving a function called "drain" that no longer delivers is the confusion this decision removes. The closeout keeps `drainCompleted` — the manager is about to shut down and its text moves to the pending closeout — and returns no claims.

The hub's `wakeFromSubagent` **claims**: the wake is the delivery, and its emptiness gate is the claim itself; a failed `postMessage` releases. Chat's wake path peeks first only to avoid claiming on a busy session, then claims. Any other gate reads, never claims.

### 4. The wake gate is the atomic claim, inside one serialize slot

`wakeFromSubagent` previously drained before `postMessage` took the slot, so a user turn could start between drain and run. Claim + `postMessage` are now wrapped in one `this.serialize({ conversationId, work })` call. `serialize` is re-entrant for the held slot, so `postMessage` sees the slot held and runs inline instead of deadlocking. The claim is taken inside the slot, and "empty → `undefined`" keeps today's contract. This removes both races: two wakes cannot claim the same entry, and no user turn can interleave between claim and run.

### 5. The ack is the write that carries the digest

Acking "the first write of any kind" or "on resolve" would either mark a result delivered before it is on disk or lose it on a crash. The rule is one predicate, `writeCarriesDigest(messages)`, plus one ack point per run:

- The predicate matches a `hostInjected === true` message one of whose text blocks **contains this run's claimed digest text as a substring**. It cannot match on object identity: `freezeMessage` rebuilds every `priorMessages` entry as a new object before any commit or publication sees it, so the drained-message reference is gone. Text is stable across freezing, the `hostInjected` stamp is deliberately preserved, and only host-injected messages are considered, so within one run at most the drain message can match. Substring, not equality, because chat joins the closeout text and the claimed text into one block.
- The predicate is applied to **the array actually written, prefix included** — inside `deps.commitMessages` that is `events = [...queryCommitPrefix, ...messages]`; the raw `messages` argument alone never contains the digest.
- The run wraps every write it can make and acks once, on the first successful write satisfying the predicate. Known carriers:
  - Hub, any iteration: `commitAcceptedInput` (the accepted input includes the drain message), the `events` array passed to `appendSessionEvents`, `publishSavedState` message sets, and the closing `conditionalSave` projection. The closing save is the one write that persists an **auto-loop iteration ≥2** digest, because `queryCommitPrefix` is consumed once and never re-applied after iteration 1.
  - Hub silent wake: no accepted input by design, so the digest acks through the engine's input-boundary publication or the closing save, whichever carries it first.
  - Chat: no in-run write carries the digest, so the checkpoint (`persistChatSessionCheckpoint`) is the ack site, after the save resolves and only when the save actually wrote. `none` writes nothing; `full` writes the round's messages, this round's digest included; `partial_user_only` splices the on-disk history with the round's genuine user queries, so this round's digest is filtered out but a byte-identical digest already on disk can still satisfy the predicate (see the residual bullet below).
- **A resolved write call is not a write.** `publishSavedState` SKIPS a publication without failing when the session is not publishable yet or has no committed head to anchor at — a normal outcome, since the same context is published at the next boundary. Reading "resolved" as "written" acked a delivery whose digest was nowhere on disk, and the result was then never offered again: lost, not delivered. The sink therefore **reports whether it wrote** (`publishSavedState` resolves `true` when the state landed, `false` when the host skipped it), and the hub observes the message set only on `true`. A publication that skipped is not a carrier.
- The latch is **per claim, not per host turn** (`runAutoLoopSteps` invokes `run` once per auto-loop iteration, and each invocation claims its own digest). The shared helper is `createDigestAck({ claims, digestText, hasDurableCarrier })`: `observe(written)` acks once when the predicate holds; `settle(true)` acks only when the host structurally has no carrier and otherwise releases. "No carrier" means: injected-deps hosts with no commit hook, no persistence hook and no checkpoint store, **and** a chat host with no conversation to write into (a checkpoint store alone writes nothing without a `conversationId`, so treating it as a carrier would release the claim on every run and re-deliver forever). The hub passes `hasDurableCarrier: true` unconditionally: it always wires the commit hook and the closing save, so the resolve fallback is unreachable there by construction and intentionally has no hub-side test.
- **Residual of the substring predicate.** The predicate scans the whole written array, and a `partial_user_only` write splices the on-disk history in front of the round's delta, so a byte-identical digest from an earlier turn (the same task producing the same text) can satisfy the predicate for a new generation. This applies to **both** hosts: chat's checkpoint and the hub's closing save each have that arm (`chat-session.ts`, `hub.ts` closing-save projection). The window is narrow — identical text and a `partial_user_only` write in that round — and the failure mode is a **lost** re-delivery, never a duplicate. Closing it needs a per-generation marker in the persisted message, i.e. a `SessionStore` format change; accepted here and tracked as a follow-up.
- `finally`: if the run throws before any ack, release. An abort **after** the digest-carrying write leaves it delivered — the digest is already in the persisted history, and re-delivery would duplicate it.
- A skipped `conditionalSave` (`none` / `concurrent_write`) is not a carrier and acks nothing; the claim is released.

The resolve fallback for injected-deps hosts that wire no persistence hook is documented and asserted as a distinct named test case. It must never be the production path: a resolve ack would turn "delivered" into "lost" on the next crash.

### 6. Registry aggregation and claim fallback

Claim/ack/release are **optional** members of the manager drain view, the same way `abortTask` is optional on the read view: structural fakes and wake-only views stay valid, and absence means "this view cannot deliver", in which case the claim falls back to the read-only path. The registry always exposes the full set and remembers the owning manager per claim token, so ack/release route back to the ledger that issued the token; a routed token is dropped from that map, so it does not grow with every delivery. A throwing manager is reported with the existing `SubagentManagerDrainError` and skipped; the other managers still contribute. `includeDelivered` passes through unchanged.

Rebind is safe by construction: the hub keeps pre-rebind managers registered and does not shut them down, so their ledgers outlive the rebind; chat closes out before `shutdown` and moves the text into `pendingSubagentDrain`, which is cleared only after a successful run.

### 7. Lifetime, restart and resume

- **Lifetime:** the ledger is created per manager, cleared by `shutdown`, and never persisted. No `SessionStore` / trace JSONL change, no schema version bump.
- **Restart:** nothing is re-delivered, because the source buffer dies with the process (and terminal tasks are not rehydrated). A fresh manager starts with an empty ledger.
- **Resume is unchanged.** `resumeTask` keeps its current contract (existence → lifetime → transcript → prior-process death → cap) and its doc sentence stays true because a resumed task gets a new `terminalSeq`. A resume gate was considered and **rejected**: foreground `wait:true`, graph nodes and the verify classifier are `excludeFromHostDrain` and never claimable, so an "undelivered result" refusal would have refused every legitimate resume of them; a result already read through `subagent_result` (`queryBuffer`) never claims either. Resume is not part of the reported bug, so a gate would be scope creep with a real regression surface.

## Consequences

- One terminal result reaches the conversation at most once per `(conversation, task, terminal generation)`, across repeated runs, wake + user-turn races, auto-loop iterations and rebinds.
- The model-visible digest text is byte-identical; no prompt, golden-set or L5 change.
- A commit failure before the digest-carrying write leaves the result claimable for the next run.
- Two residual costs are accepted rather than fixed here:
  - `shutdown` loses any undelivered result, exactly as today.
  - Releasing a claim does not re-post a mailbox notice, so the retry waits for the next run or wake rather than firing immediately (the same observable behavior as today).
- Follow-ups (separate issues): a durable delivery ledger if manager rehydration of terminal tasks lands; a delivery receipt on the trace; a lease timeout for claims abandoned by a host bug; "re-arm the same generation" mailbox semantics if release should re-notify immediately; and a per-generation marker in persisted messages to close the substring-predicate residual (§5).
