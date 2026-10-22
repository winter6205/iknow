# 0149. The phone drives the live TUI session through a local remote seat and a Happy `iknow` backend

Date: 2026-10-20
Status: accepted
Deciders: operator
Related: ADR-0110 (one writer per session file — the TUI process stays that writer; nothing here opens a session file from a second process), ADR-0147 (approvals are call-addressed by `toolUseId`, have no default timeout, and "always allow" is a tool-level session grant — the phone answers through the same inlet), ADR-0120 (the IM bridge is an external Session HTTP consumer — a different surface; this ADR does not route through `iknow serve`)

Spec: `specs/remote-sync.md`

## Context

Anchors are verified at master `20cb6384` (iknow) and at commit `b99e7f83` of `slopus/happy` (Happy).

**1. The live session lives inside the TUI process.** The TUI builds its own `SessionHub` (`src/tui/hub-bridge.ts:473`) and is the single writer of the session file (ADR-0110). A second process cannot attach to that session: cross-process concurrent open is out of support, and the hub refuses a racing write with `concurrent_write` (`src/session-api/hub.ts:511`). Any remote surface that must show and steer _the same_ session the laptop shows must therefore enter through the TUI process.

**2. The existing remote face does not stream.** `iknow serve` binds `127.0.0.1` (`src/session-api/serve.ts:297`) and its SSE stream is reserved but not implemented (`src/session-api/http.ts:408`). It also owns a hub of its own, so it cannot serve the TUI's live session (fact 1).

**3. Stream events are per call, not per session.** `SessionHub.postMessage` forwards events only to the `onStream` callback of the caller that started the turn (`src/session-api/hub.ts:3204-3209`); `continueSession` and `compactSession` do the same (`:4040-4045`, `:3871`). No second observer can subscribe today.

**4. The TUI already owns every input semantic the phone needs.** A typed message during a live turn is held in the per-session gap queue and sent at the turn boundary (`src/tui/turn-gap-queue.ts:1-12`, `src/tui/app.tsx:4113-4120`). Esc interrupts the parent turn and the session's foreground subagents (`src/tui/app.tsx:4814-4823`). The permission modal answers once / always / reject (`src/tui/modal.tsx:46`); "always" adds a `tui-always-<tool>` session grant (`src/tui/app.tsx:3746-3765`).

**5. The TUI's approval source is the TUI ask bridge, not the hub.** The TUI hub is built without an ask handle, so `SessionHub.listPendingAsks()` (`src/session-api/hub.ts:2187`) is empty in the TUI; pending questions live in `createTuiAskUserBridge` (`src/tui/run.tsx:560`, `src/tui/ask-user.ts:44-133`). Security-review asks reach the same modal without emitting `approval_pending` (`src/harness/permission/permission-executor.ts:600-622`).

**6. Happy provides the phone, the relay and the end-to-end encryption.** The official Happy Android app renders session-protocol envelopes (`packages/happy-wire/src/sessionProtocol.ts:110-175`), shows a permission card for every `agentState.requests` entry and answers it through the `permission` RPC (`packages/happy-cli/src/api/types.ts:400-440`, `packages/happy-app/sources/sync/ops.ts:919,953`). The Happy server only stores and forwards ciphertext. A CLI-side session client exists (`packages/happy-cli/src/api/apiSession.ts`); what is missing is a backend that speaks to iknow.

## Decision

### 1. The TUI process hosts a remote seat; the hub gets an event bus

The TUI process, when `remote.enabled` is true in user settings, opens one **remote seat**: a Unix socket at `<dataDir>/run/remote.sock` (default data dir `~/.iknow`, `src/session-api/serve.ts:78-81`). The seat is the only way into the live session from outside the process. The TUI stays the single writer (ADR-0110 unchanged).

`SessionHub` gains a session-wide **event bus** (`subscribeEvents`). Every stream event of every turn, continuation and compaction is published to it in addition to the caller's `onStream`, together with three host events the stream lacks: `user_message` (with its origin), `turn_started` and `turn_ended`. The per-call `onStream` contract is unchanged.

### 2. One input port: phone and keyboard take the same paths

The seat does not reimplement input. The TUI registers an **input port** whose three operations call the functions the keyboard already uses:

- `sendMessage(text)` → `sendTurn` — a message arriving mid-turn is queued in the gap queue for the next turn boundary, exactly like a typed one.
- `answerApproval(toolUseId, once | always | reject)` → `resolvePermissionAsk` — so a phone "always" writes the same `tui-always-<tool>` grant as the modal.
- `abort()` → `interruptForegroundTurn` — Esc semantics.

### 3. Approvals: first answer wins, both sides close

Pending approvals are read from the TUI ask bridge (fact 5), so security-review questions are included. Whichever side answers first settles the ask; a later answer is refused with `not_pending`. The settlement is broadcast as `approval_resolved` (with who answered and how), and both the TUI modal and the phone card close. There is no default timeout (ADR-0147 R4); an `approval.timeoutMs` the operator configured still applies to both sides alike. Remote permissions are local permissions: the phone cannot change the permission mode.

### 4. The socket protocol is versioned and host-neutral

NDJSON over the Unix socket, a `hello` / `welcome` handshake with an integer protocol version, request/response correlation by id, and a server-assigned monotonic `seq` on every event. A reconnecting client sends its last `seq` and the server's `instanceId`; it gets a replay from a bounded ring buffer when that is possible, and a fresh snapshot otherwise. Authentication is the filesystem: the directory is `0700`, the socket `0600`, both owned by the user. The protocol types live outside `src/tui/` so a later standalone daemon can serve the same protocol unchanged.

### 5. Happy side: a fork of happy-cli only, with a native `iknow` backend

The phone runs the official Happy Android app, unchanged. The Happy server runs self-hosted. On the laptop, a fork of happy-cli adds `happy iknow`: a long-running process that connects to the remote seat, maps seat events to Happy session-protocol envelopes, mirrors laptop-typed messages to the phone, maps pending approvals to `agentState.requests` and completed ones to `completedRequests`, and maps the phone's message, `permission` and `abort` RPCs to the input port. The backend speaks the seat protocol natively; no agent-protocol adapter sits in between. Server and CLI are built from the same pinned Happy commit.

### 6. Notifications go through a self-hosted ntfy

The Happy push path is not used. iknow publishes to a self-hosted ntfy server on `approval pending` and on turn end; the text names only the event kind and tool name, never code, paths or message content. URL, topic and access token are user settings; absent settings mean off.

### 7. Scope

In scope: one TUI process, its active conversation, one paired phone. Out of scope: Session API S4 auth, a standalone daemon, several TUI processes sharing one seat, starting a TUI from the phone, phone file attachments.

## Consequences

- The phone and the laptop see one session, one transcript and one approval queue; there is no second state to reconcile.
- iknow takes a new long-lived local listener; its exposure is bounded by filesystem permissions, and a second TUI with remote enabled runs without a seat instead of fighting for it.
- iknow gains no network listener and no dependency on Happy; Happy-specific code lives only in the fork.
- The official app updates independently of the pinned server and CLI; protocol drift is an operational risk (spec §12).
