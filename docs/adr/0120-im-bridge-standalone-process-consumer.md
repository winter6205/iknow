# 0120. IM bridge: a standalone resident process, external consumer of iknow's own HTTP surface

Date: 2026-09-21
Status: accepted

## Context

We are adding IM bridging; the first target is Feishu / Lark. A bridge receives
platform callbacks (`im.message.receive_v1`, `card.action.trigger`), turns one IM
chat into one iknow turn, and posts the result back. Platform facts live on
`docs/platforms/feishu-facts.md`; this ADR only decides the shape.

Two shapes are technically available. (a) Build the engine inside the bridge
process: construct a `SessionHub`, reach the store directly, skip HTTP. (b) Run the
bridge as its own resident process, talking to `iknow serve` over the HTTP surface
it already exposes. Nothing structural blocks (a) — the hub is built at exactly two
sites today, `iknow serve` and the TUI (`src/session-api/serve.ts:208`,
`src/tui/hub-bridge.ts:333`), so a front end holding its own hub is established
practice. This is a safety argument, not a feasibility one.

ADR-0110 forces the choice. Its Decision 3 says, verbatim: "Cross-process concurrent
open of the same session is out of support. No detection, no recovery, no
behavioral promise." Shape (a) puts a second process in exactly that position
against the files the interactive hub owns.

The platform pushes the other way: long-connection subscription is available only to
enterprise self-built applications, every event and card callback must be handled to
completion within 3 seconds, and one application may hold at most 50 long
connections, each event delivered to a randomly chosen one. So the bridge must
outlive any interactive session, be mutually exclusive with itself, and never run a
turn inside a callback handler. See
`https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case?lang=zh-CN`.

## Decision

1. **The bridge is a separate, resident process, and iknow's HTTP surface is its
   only iknow-facing door.** The bridge constructs no `SessionHub`, imports no
   `SessionStore`, and never opens a session JSONL file. Whatever it needs, it asks
   `iknow serve` for. ADR-0110's single writer stays the only writer of session
   data; the bridge is a client of that writer, not a peer of it.
2. **One bridge instance, with mutual exclusion owned by the bridge.** Exclusive
   startup is enforced by the bridge itself, through a socket / pid ownership file,
   following the shape of the egress seam — ownership anchored on a per-session
   socket path plus a shared random token
   (`src/harness/sandbox/egress/session.ts:957,984-991`). The 50-connection cap and
   "we usually only start one" are not mutual exclusion.
3. **Acknowledge first, work later.** The callback path returns its 200 inside the
   3-second deadline having only recorded the event; the iknow turn runs on the
   bridge's own queue. This is not optional in our stack: the driving call
   `POST /api/v1/sessions/:id/messages` blocks until the turn finishes
   (`src/session-api/http.ts:604-616`), so calling it from a callback handler
   guarantees a deadline miss and a platform re-push.
4. **A local authentication token is a precondition of this decision, not a
   follow-up.** The face the bridge consumes listens on `127.0.0.1` by default
   (`src/session-api/http.ts:147`, `src/session-api/serve.ts:294`) and `handle()`
   has no authentication branch across its full route table
   (`src/session-api/http.ts:195-375`). A long-lived process talking to that face
   without a credential makes every local user and process a caller that can create
   sessions, send messages and bind workspaces. No bridge ships before the mutating
   routes reject unauthenticated requests; issuance and shape settle in the bridge
   spec.
5. **The bridge never chooses a workspace.** `iknow serve` is unbound by default
   and answers `POST /api/v1/sessions/:id/messages` with 400 `validation`
   field=`workspaceRoot` until an absolute root is bound explicitly
   (`docs/architecture.md`, "serve workspace = explicit", ADR-0023). The bridge
   drives sessions only on a root the operator bound out of band — via
   `PUT /api/v1/workspace` with `confirmTrust`, or `--workspace-root` /
   `IKNOW_WORKSPACE_ROOT`. IM text is never a binding instruction.
6. **Chat-to-session mapping is bridge-side state.** The bridge keeps its own
   ledger mapping one IM chat to one `conversationId` (a finer within-chat key is the
   bridge spec's open question, not this decision) and learns session state only
   through `GET /api/v1/sessions/:id`. It never enumerates, edits or
   repairs session files, and never resets or rewinds a session it does not own.
7. **v1 consumes no push.** The bridge polls or reads on demand; the server-side
   event stream stays the reserved `501` placeholder
   (`src/session-api/http.ts:397-411`). When that route lands, the bridge is its
   first consumer and this decision does not change.

## Why not

- **A second engine inside the bridge process (in-process hub, direct store, no
  HTTP):** faster, and it gets streaming hooks for free — `hub.postMessage` exposes
  an `onStream` seam only in-process hosts can pass (`src/session-api/hub.ts:1753`).
  That is precisely the temptation to refuse: a second writer on files ADR-0110
  declares cross-process unsupported, with the tearing mechanism in Consequences.
  Rejected.
- **Fold the bridge into `iknow serve` as a same-process module or subcommand:** an
  IM disconnect or a card-reconnect storm then shares the event loop and the hub's
  per-conversation serialize queue with interactive sessions, and platform retry
  bursts become load on the interactive server. It also loses independent restart and
  an independent crash domain. Rejected.
- **Make Feishu an iknow tool (MCP direction):** that is the model deciding to send
  a message; here the platform decides to start a turn. The control direction is
  reversed, a tool call cannot answer a callback inside 3 seconds, and a tool cannot
  own chat-to-session mapping. Rejected.
- **Reuse the `chat` REPL self-assembly path:** it holds no hub — it mirrors hub
  semantics in its own code (`src/cli/chat-session.ts`), so reuse adds a third
  assembly site instead of consolidating on the single writer — and it is a
  foreground interactive process, not a daemon. Rejected.
- **Add a cross-process lock in the store to make a second engine safe:** ADR-0110
  already rejects OS-level locks as a substitute layer for the assembly-boundary
  queue, and adding one would silently extend that contract. Rejected.

## Consequences

- **Tearing is the reason, and it is silent.** `save()` is read → write to a fixed
  name `<id>.jsonl.tmp` → `rename` (`src/session-api/store/session-store.ts:377-395`,
  tmp name at `:378`), with no CAS, no mtime check and no version field, so two
  writers overwrite each other's whole file and the loser's update disappears with
  no error. Worse: `appendEvents()` chains new ids off `log.maxEventIndex + 1` read
  from disk (`src/session-api/store/session-store.ts:444-483`), so two processes
  reading the same head emit duplicate event ids; `parseSessionJsonl` then throws
  `schema_invalid` (`src/session-api/store/jsonl.ts:285-290`) and `load()` fails
  from then on — while `save()` treats `schema_invalid` as a corrupt log and
  self-heals by full rewrite (`src/session-api/store/session-store.ts:386-392`),
  erasing the other process's records as a side effect of recovering. The only
  serialization is the in-process Promise chain keyed by conversation id
  (`src/session-api/hub.ts:3254-3270`); the repo has no `flock` and no lock-file,
  and its sole `wx` flag use is content-addressed trace blob dedupe
  (`src/harness/trace/jsonl.ts:152`).
- **The bridge pays an extra hop and a supervision cost:** one more process to
  package, start, restart and observe, HTTP latency per turn, and explicit behaviour
  while `iknow serve` is down — park and retry, never write locally.
- **Progress is not observable from outside.** Card updates degrade to whole-turn
  granularity in v1: the bridge sees the finished turn, not the stream, since the
  streaming seam is in-process (`hub.ts:1753`) and the events route is `501`.
  Closing that is the SSE route's job, not the bridge's.
- **The localhost face becomes a real API contract, and an unauthenticated one.** A
  non-trivial external consumer now depends on its shapes, error envelope and the
  unbound-workspace 400, while the surface itself has no credential check today.
  Shipping the token gate is therefore the first deliverable of this decision, not a
  later hardening pass.
- **ADR-0110 is untouched.** Nothing in the store layer loosens, and the TUI /
  `serve` hub constructions remain the only engine assembly sites.

## Evidence pointers

- Engine assembly sites: `src/session-api/serve.ts:208`, `src/tui/hub-bridge.ts:333`
  (the only two `new SessionHub(` under `src/`).
- `docs/adr/0110-session-data-single-writer.md:20` — cross-process open out of
  support: "no detection, no recovery, no behavioral promise".
- `src/session-api/store/session-store.ts:377-395` (`save`: read → fixed-name tmp →
  rename), `:386-392` (`schema_invalid` → full-rewrite self-heal), `:417` (JSDoc:
  `appendEvents` "MUST be called under the hub serialize queue"), `:444-483`
  (`appendEvents`: read head → assign ids → `appendFile`).
- `src/session-api/store/jsonl.ts:285-290` — duplicate event id → `schema_invalid`
  field `events`.
- `src/session-api/hub.ts:3254-3270` — in-process per-conversation serialize;
  `src/session-api/hub.ts:1753` — `onStream`, in-process hosts only.
- `src/session-api/worktree-rebind.ts:1076-1082` — occupancy visible only within the
  current process.
- `src/harness/sandbox/egress/session.ts:957,984-991` — ownership via an `os.tmpdir()`
  per-session socket path and stale-socket cleanup, plus the shared random token at
  `:996` keeping other host processes out.
- `src/session-api/http.ts:147`, `src/session-api/serve.ts:294` — default bind host
  `127.0.0.1`; `src/session-api/http.ts:195-375` — all of `handle()`, no
  authentication branch; `:219` + `:397-411` — events route wired to `501` "SSE
  streaming is reserved; not implemented in v0"; `:604-616` — `POST
/sessions/:id/messages` awaits the whole turn.
- `docs/architecture.md` — "serve workspace = explicit (ADR-0023)".
- `docs/platforms/feishu-facts.md` — facts page, SSOT for platform numbers.
- https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case?lang=zh-CN
  — long connection: enterprise self-built apps only, 3-second deadline, 50
  connections per app, random delivery to one.
