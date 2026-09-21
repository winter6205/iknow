# 0045. Server-izing the sandbox execution surface: same-process router + two protocol shapes (short-lived / long-lived task-handle)

Date: 2026-09-06
Status: accepted

> This ADR lands the decision ticket of the closed-world bash fence track: it fixes the boundary shape of the sandbox execution surface and the message contracts, and implementation proceeds from here. This ADR locks contract boundaries only (message shapes, timeout/interrupt, truncation, fail-loud, IPC failure typing); file / module / type names are left to implementation.
>
> ADR-0022 / ADR-0037 §9 keep governing the **physical semantics** of the bash fence (per-call network opt-in, closed-world allowlist, fail-loud typing); this ADR only moves the **execution-surface position** (in-process direct call → server boundary) — it does not change fence argv shape, the allowlist, or `--unshare-net` behavior.

## Context

Today the `sandbox/execution` surface is in-process direct calls: the bash tool (`src/harness/aci/tools/bash.ts:218-224`) goes `runInSandbox` → `spawnWithStopSignal` and waits synchronously for child exit; background (`defaultBackgroundSpawn` at `src/harness/background/manager.ts:239-291`) bypasses `runInSandbox` and **directly** `nodeSpawn(fence.argv[0], …)` a detached process group, with the host keeping `child.pid` as `record.pgid` (`manager.ts:388`) and `bash_stop` escalating host-side via `process.kill(-pid, …)` (`manager.ts:587-624`); verify (`makeDefaultRunVerify` at `src/harness/verify/sandbox-run.ts:60-77`) waits synchronously for child exit through `runInSandbox`. The three sites assemble from the same fence source (`createBwrapFence` + `createClosedWorldFsPolicy` (**retired with ADR-0092 as of 2026-09-13**, now `createFsPolicy`)), but the **executors use `node:child_process` raw** — bash via `runInSandbox`, background via `nodeSpawn`, verify again via `runInSandbox`: three distinct `child_process.spawn` entry points.

Round-2 ACR review (bounded-context-guardian / defensive-contract-validator / error-handling-enforcer) of the 2026-09-06 closed-world bash fence track opened the track with `unclear/no` items naming three gaps:

1. **No unified execution surface** — three independent spawn entries; any future new isolation / resource limit / audit hook means changing all three, violating `min-change-verifier`.
2. **No unified contract for the IPC boundary's 5 failure classes (empty / negative / overflow / concurrent / exception)** — today each site catches `child.once("error")` and lands `truncateByCodePoint` on its own; `RangeError` / empty frames / server-down mid-spawn are entirely unhandled on the background path.
3. **No failure contract (server unreachable / signal abort)** — degrading straight back to in-process spawn would quietly bypass ADR-0037 §9's closed-world fence physical contract, violating `error-handling-enforcer`'s "fail-loud, never silently degrade" discipline.

`BwrapFence` itself is already a pure-data token `Object.freeze({argv, sealed: true})` (`bwrap.ts:172`) — **no IPC state, no cross-session state, no cross-process mutable state**; the existing `session-api/http.ts:8787` (TCP 127.0.0.1 exposed to the SPA / external CLI clients) and `traceserver/serve.ts` are HTTP servers for **out-of-process** consumers. All three consumers of a bash sandbox server live **in the same Node process** (harness CLI / chat / hub), so introducing a cross-process IPC boundary (Unix socket / fork / TCP loopback) for a pure-data token shape is over-engineering.

This ADR rules: consolidate the execution surface into a **same-process router** (mirroring `createTraceRouter`'s mountable router shape, `traceserver/serve.ts:51-83`), turning `runInSandbox` and friends from direct calls into router handlers; no forked child process, no standalone daemon, no Unix socket; the protocol splits into two shapes (short-lived request/response, long-lived task-handle) covering the foreground / verify / background caller classes.

## Decision

### 1. Server shape: same-process router (mountable, module boundary)

A new module `src/harness/sandbox/server/` exports `createSandboxServer(opts)`, returning an in-process router (`(req: SandboxRequest) => Promise<SandboxResponse>`, or for long-lived task-handles an `AsyncIterable<SandboxTaskEvent>`). The shape mirrors `createTraceRouter` (`traceserver/serve.ts:61`) — pure factory, no server, no shared mutable state; callers hold one router reference from harness assembly, shared by the three consumers (bash tool / background manager / verify).

Explicitly **not** doing (rejected in §3 Alternatives):

- **No forked child process running the server** — the fence is a pure-data token; forking parks a stateless token in a separate process, introducing state unrelated to the main process and violating the minimalism of "fence is a pure-data frozen argv token".
- **No standalone daemon / TCP server** — all three consumers are inside one Node process; a daemon forces an IPC crossing that adds latency, complexity, port conflicts, and lifecycle governance (supervisor / reaper / heartbeat) costs for in-process consumers.
- **No Unix socket / `child_process.fork` IPC channel** — the repo has no Unix-socket or fork precedent (grep `child_process.fork` / `net.createServer` / `unix:` all zero hits), so it would be an entirely new infrastructure surface; a same-process router is just a function call and needs no IPC channel.

During migration, `runInSandbox` **demotes to a thin wrapper over the router handler** — straight `router(req) → response`, no direct `child_process.spawn`. **Demotion = deletion-not** (to stay compatible with the existing 30+ test fixtures), but its spawn call sites are expressed through the server boundary; acceptance item (a) reads "the in-process direct-call path is deleted or demoted to a server-internal implementation" — this ADR chooses "demote"; deletion is deferred to a later ticket once all fixtures have migrated.

### 2. Runtime contract: two protocol shapes (short-lived / long-lived task-handle)

#### 2.1 Short-lived request/response (foreground + verify)

Applies to: bash tool foreground (`bash.ts:218-224` `await runInSandbox(...)`), verify (`sandbox-run.ts:71-77` `await runVerify(...)`). Call semantics = wait for child exit, take a one-shot result.

Message shape (contract boundary; concrete type names left to implementation):

```
request:
  kind: "exec"
  fence: BwrapFence          # 纯数据 frozen argv token, 不变
  cwd: string                # 来自 waveRoot(ADR-0037 §7.2 batch 快照)
  env: NodeJS.ProcessEnv     # 已 envIsolation.filter() 的 fenceEnv
  signal?: AbortSignal       # ctx.signal
  maxOutputCodePoints?: number   # 缺省 = DEFAULT_MAX_OUTPUT_CODE_POINTS (12_000)
  killGraceMs?: number       # 缺省 = 2_000 (沿 runner.ts:18)

response:
  exitCode: number           # null → signalExitCode(signal)
  stdout: string             # 已按 maxOutputCodePoints 截断
  stderr: string             # 同上
```

**Truncation carries over** the **code-point** truncation of `DEFAULT_MAX_OUTPUT_CODE_POINTS = 12_000` (`runner.ts:16`); the `truncateByCodePoint` contract (`runner.ts:84-89`) does not change under the server form. The `SIGNAL_EXIT_CODES` mapping (`runner.ts:21-54`) is unchanged.

#### 2.2 Long-lived task-handle (background)

Applies to: bash tool background (`bash.ts:160-167` → `manager.spawn` → `defaultBackgroundSpawn`). Call semantics = fire-and-forget spawn + log stream + stop control.

Message shape:

```
spawn request:
  kind: "spawn"
  fence: BwrapFence          # 同 2.1
  cwd: string
  env: NodeJS.ProcessEnv
  signal?: AbortSignal       # ctx.signal
  killGraceMs?: number       # 沿 2.1
  recordCommand?: string     # 占位符形态( #406 roundtrip)
  conversationId?: string    # ctx.conversationId

spawn response (一次性, 同步 resolve):
  task_id: string            # "bg-" + 12 hex, 沿 ADR-0021 D1.7
  log_path: string

task event stream (AsyncIterable, 长生命周期):
  kind: "stdout" | "stderr" | "exit" | "stopped"
  chunk?: string             # stdout/stderr
  exit_code?: number         # exit 事件
  signal?: NodeJS.Signals

stop control message:
  kind: "stop"
  task_id: string
  graceMs?: number           # 缺省 2_000
```

`bash_stop` still escalates via host-side `process.kill(-pgid, …)` (`manager.ts:587-624`) and **never bypasses the host to signal directly** — the task-handle protocol encapsulates "the intermediate state of kill escalation" inside the server router; the client only sends a `stop` control message and never imports `node:child_process` directly. Physical pid ownership **remains with the host** (`child.pid` stored as `record.pgid`); `bash_stop` relaying `kill(-pgid)` through the server is a **protocol-layer abstraction**, orthogonal to "which process holds the pid" — under the same-process router form the two coincide naturally (host = server), and they only split under a standalone-daemon form; this ADR chooses the same-process router, so `pid ownership transfer` is out of scope here.

#### 2.3 Timeout and interrupt

- `ctx.signal` abort → **client side**: send a `stop` control message (task-handle protocol) or cancel the await (short-lived protocol). **Never just drop the client promise** — upon abort the server router must propagate the signal to the fenced child process (task-handle via `kill(-pgid)`; short-lived via the abort listener in `spawnWithStopSignal`, `runner.ts:131-132`).
- Timeouts (`maxOutputCodePoints` / `killGraceMs`) keep the existing `spawnWithStopSignal` escalation path at the spawn end; no extra timer is added at the router layer.

### 3. violation-handling stays on the client side

`violation-executor.ts` (post-hook, wrapped at the executor layer) is an **application-layer observer** watching `tool_result` text prefixes (`VIOLATION_PREFIXES`), fully decoupled from sandbox internals. Ruling: it stays client-side (`executor` keeps the wrap); it does not move into the server.

Reasons:

1. **Violation classification depends on tool-layer semantics** (permission_denied / dangerous / sensitive path / escape attempt), and all those semantics live client-side (the bash tool handler's `isDangerousCommand` / `commandContainsSensitivePath`); the server only sees the already-spawned fence child's stdout/stderr/exit_code and **has no tool-layer semantics to classify with**.
2. **The kill-session hook is session-level semantics** (counter accumulation → session-level escalation), not sandbox-child-process semantics; putting it server-side would leak session state across the boundary.
3. **If the server ever crosses processes (possible future), a violation hook observing server replies over IPC would be inverted coupling** — the server is the observed, not the observer.

The post-hook's consumption is unchanged after server-ization: the client still runs `wrapWithViolationHook` on the `response` or `task event` it receives, classifying by the existing prefix match.

### 4. Four IPC boundary failure classes (contract typing)

Under the server form, the IPC boundary (the router call itself — a function call in-process, an IPC message if ever cross-process) must cover 4 failure classes (overflow has been folded into §2.1's truncateByCodePoint contract).

| Boundary class | Trigger condition                                                                                                                                                              | Contract                                                                                                                                                                                                                                            | Test surface                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **empty**      | request frame missing `command` (spawn) / `fence` (exec) field / `task_id` field                                                                                                | typed fail-loud (`ToolExecutionError` family), **no spawn**, no fake response returned                                                                                                                                                              | (e) companion tests                                  |
| **negative**   | `maxOutputCodePoints <= 0` / `killGraceMs < 0`                                                                                                                                  | `RangeError`, preserving the `runner.ts:84-86` `truncateByCodePoint` contract, nothing lost                                                                                                                                                         | (e)                                                  |
| **overflow**   | child stdout/stderr > `maxOutputCodePoints`                                                                                                                                     | the router handler truncates via `truncateByCodePoint` before sending out, and does **not** throw a typed error (the `SandboxServerError` union carries no overflow kind; §2.1 semantics already say so)                                              | (e)                                                  |
| **concurrent** | multiple requests in flight (same router instance)                                                                                                                              | the fence shares no mutable state (fence argv frozen; fsPolicy factory-time / per-call rebuild each independent; `createBwrapFence` returns a frozen token), concurrency is allowed, and the decision is **explicitly recorded**                     | (e) companion tests cover concurrent fence construction |
| **exception**  | server unreachable (future cross-process scenario) / child exited after accept without an ack (orphan process group)                                                            | typed fail-loud + an **orphan process-group reap discipline** — on child exit with frame-parse failure the router must explicitly `process.kill(-pgid, SIGKILL)`, per `background/stale-reap.ts:184` (pgid-reuse hardening)                            | (e)                                                  |

Under the same-process router form "server unreachable" physically cannot happen (a function call's stack trace bubbles naturally), but the contract still spells out typed fail-loud semantics — keeping interface stability for a possible future cross-process move; **never** skip test coverage on the grounds that "it can't fail in-process anyway" (that would violate `min-change-verifier`'s contract stability).

### 5. Failure contract (fail-loud, no degradation)

- **Server unreachable** = typed fail-loud (`ToolExecutionError` + explicit `kind: "server_unreachable"`), **never silently degrade** to in-process spawn. Reason: degrading = bypassing ADR-0037 §9's unified closed-world fence physical contract (the fence is built by the server → server unreachable → a direct call sidesteps allowlist construction and the fail-loud typing), violating `error-handling-enforcer`'s "fail-loud, never silently degrade".
- **`ctx.signal` abort** = cancellation via control message on the server end (task-handle protocol sends `stop`; the short-lived protocol forwards the signal inside the handler to `spawnWithStopSignal`), **never just drop the client promise**. Reason: dropping the promise alone leaves the orphan process group running inside bwrap with the host never seeing a signal and kill escalation never happening — violating ADR-0037 §9.4's "configuration-failure fail-loud" discipline (an orphan = an unobservable execution surface outside the closed-world fence).
- **Client-side `Promise.reject`** = the server handler's `try/catch` wraps `child.once("error")` (the existing `runner.ts:135-140` contract); the typed error bubbles.

## Alternatives considered

### (a) Same-process Unix socket singleton (forked child runs the server, main process talks over a Unix socket)

Rejected. Three pieces of evidence:

1. `BwrapFence` is a pure-data token `Object.freeze({argv, sealed: true})` (`bwrap.ts:172`) — forking parks a stateless token in a separate process, and **there is no IPC state that needs a process crossing**; the state a fork would introduce (server-internal counters, registry, reaper) belongs to the server itself, not to the fence.
2. A Unix socket inside the same Node process could go straight through `child_process.fork`'s IPC channel **without an explicit socket** — but forking itself is overkill; a same-process router is just a function call.
3. The repo has **no Unix-socket or fork precedent** (zero hits for `child_process.fork` / `net.createServer` / `unix:`), so it would be an entirely new infrastructure surface; and it is orthogonal to the existing same-process `createTraceRouter` (mountable router, `traceserver/serve.ts:61`) form.

### (b) Standalone daemon (external process, TCP 127.0.0.1 or Unix socket)

Rejected. Three pieces of evidence:

1. All three consumers (bash tool / background manager / verify) **live in the same Node process** (harness CLI / chat / hub); a daemon forces an IPC crossing that adds latency for in-process consumers (Unix domain socket ≈ 10µs, TCP loopback ≈ 50µs — a 10~50× regression against `runInSandbox`'s in-process function call < 1µs) and adds port-conflict and lifecycle-governance (supervisor / reaper / heartbeat) costs.
2. `session-api/http.ts:8787` (TCP 127.0.0.1 exposed to the SPA / external CLI clients) and `traceserver/serve.ts` are servers for **out-of-process** consumers; the bash sandbox server's consumers are **all in-process** — a different **scope** from the existing server patterns, so reusing that pattern is a category error.
3. Startup / supervision / port conflicts / lifecycle are new costs — a daemon needs graceful SIGTERM exit, stale-socket cleanup, port-already-in-use handling, and orphaned-socket cleanup after a host crash; the same-process router pushes all of that onto the host process's existing lifecycle, i.e. zero additions.

### (c) MCP surface (`@modelcontextprotocol/sdk`)

Rejected. Three pieces of evidence:

1. MCP is a **tool-surface protocol meant for the model** (schemas exposed to LLM clients, spinning JSON-RPC over stdio / SSE), while the bash sandbox server's three consumers are **in application code** (harness / background manager / verify), not LLM clients.
2. The MCP protocol layer (`tools/list` / `tools/call` / `initialize` handshake / capability negotiation) is designed for cross-process LLM tool discovery and **misaligns with the sandbox's internal execution boundary** — wrapping `runInSandbox` as an MCP tool packages an internal library function as a cross-process tool and violates least astonishment.
3. ADR-0043 has already fixed the MCP tool-surface disclosure tiering (finalized on the first turn, `lazy: true` consolidated); the sandbox server must not join the MCP tool-surface channel, to keep tool-schema churn away from the internal executor.

## Consequences

### Positive

- The three spawn entries (bash foreground / verify / background) converge on one router; future isolation / resource-limit / audit-hook work **changes one place**.
- The 5 IPC-boundary failure classes (empty / negative / overflow / concurrent / exception) get **focused** test coverage in one place, closing the boundary-coverage gap `defensive-contract-validator` flagged.
- The failure contract (server-unreachable typed fail-loud, `ctx.signal` abort via control message) is locked by ADR and **never silently degrades** to in-process spawn, keeping the fence's physical contract unified.
- Same-process router = zero new infrastructure (no socket / no fork / no daemon), structurally isomorphic with the existing `createTraceRouter` mountable-router pattern, review-friendly.

### Negative / Trade-offs

- The router module introduces a new factory function plus the type surface of two protocol shapes (request/response + task-handle) — real implementation cost, but it is **consolidation** cost and is not re-billed onto existing fixtures (tests keep using the thin `runInSandbox` / `defaultBackgroundSpawn` wrappers; externally observable behavior is unchanged).
- Under the same-process router form "server unreachable" physically cannot happen — yet the contract still spells out typed fail-loud semantics and keeps test coverage, preserving interface stability for a future cross-process move (contract stability over present-day brevity).
- The task-handle protocol encapsulates "the intermediate state of kill escalation" into the router (`stop` control message), but physical pid ownership stays with the host — the two layers (protocol / physical) are semantically orthogonal; if the server ever crosses processes, how they split needs a dedicated ADR.

### Reversibility

- Migrating same-process router → standalone daemon: keep the router function signature and the two protocol shapes, swap the router internals' direct `runInSandbox` / `defaultBackgroundSpawn` calls for IPC client calls; the three consumer sites **need no migration** (they already call the router, not the internal implementation).
- Protocol changes: the §2 message shapes are the contract boundary; changing them needs a new ADR (a contract means "the implementation is for now, the contract is for longer"). Changing shape = changing the contract, not just the implementation.

## Evidence

- `src/harness/sandbox/bwrap.ts:172`: `BwrapFence = Object.freeze({argv, sealed: true})` — evidence of the pure-data frozen argv token.
- `src/harness/sandbox/runner.ts:16-54, 84-89, 96-150`: default truncation cap 12_000, the code-point truncation contract, the `spawnWithStopSignal` escalation path, the `SIGNAL_EXIT_CODES` mapping.
- `src/harness/aci/tools/bash.ts:160-167, 218-224`: the bash tool's foreground/background entries; foreground `await runInSandbox`, background `manager.spawn`.
- `src/harness/background/manager.ts:239-291, 587-624`: `defaultBackgroundSpawn` bypassing `runInSandbox` to call `nodeSpawn(fence.argv[0], …)` directly; `bash_stop` escalating via host-side `process.kill(-pgid, …)`.
- `src/harness/verify/sandbox-run.ts:60-77`: `makeDefaultRunVerify` going through `runInSandbox`.
- `src/harness/sandbox/violation-executor.ts, violation-handling.ts`: the post-hook based on `tool_result` text prefixes (`VIOLATION_PREFIXES`), decoupled from sandbox internals — evidence that violation handling stays client-side.
- `src/session-api/http.ts:130-157` + `src/traceserver/serve.ts:61-83`: the existing TCP server / mountable router patterns — the same-process router mirrors `createTraceRouter`'s mountable router mode.
- `src/harness/background/stale-reap.ts:184`: the orphan process-group reap reference (`process.kill(-pgid, SIGKILL)` + starttime pgid-reuse hardening).
- ADR-0022: the fence physical contract boundary for per-call `network: true` (inherited here, unmodified).
- ADR-0037 §7.2 / §9: batch-snapshot semantics (foreground / background / verify consume the same fence token within a wave) and the closed-world fence allowlist rulings — server-ization modifies none of these physical contracts.
- ADR-0037 §9.4: the fail-loud typing for allowlist misses (configuration-failure vs runtime-observable classes) — this ADR's failure contract carries on "typed fail-loud, never silently degrade".
- ADR-0021 D1.7: the `bg-` + 12 hex task_id naming contract (inherited by §2.2).
- The closed-world bash fence track's decision ticket context and the Round-2 ACR review (2026-09-06).

## Acceptance self-check

| Acceptance item | Where this ADR lands it |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) server shape choice | §1 same-process router (mountable factory), with reasons + rejection of Unix socket / standalone daemon / MCP surface in §3 Alternatives |
| (b) runtime contract | §2.1 short-lived request/response + §2.2 long-lived task-handle + §2.3 timeout/interrupt; truncation carries over 12_000 code-points; SIGNAL_EXIT_CODES unchanged |
| (c) consumer migration path and compatibility policy | §1 "demote to a thin router-handler wrapper, do not delete" — keeps compatibility with the existing 30+ fixtures; §2's two protocol shapes cover the bash foreground / verify / background consumers |
| (d) violation-handling ownership | §3 stays client-side, three reasons (semantics dependency / session-level semantics / inverted coupling under future cross-process move) |
| (e) two protocol shapes + pid ownership | §2.1 / §2.2 shape split; §2.2's closing paragraph explains physical pid ownership stays with the host and the task-handle protocol is "encapsulated kill-escalation state" (the two coincide naturally in-process and only split under a standalone daemon) |
| (f) 5 IPC boundary failure classes | §4 table: empty / negative / overflow / concurrent / exception, each with contract + test surface |
| (g) failure contract | §5: server-unreachable typed fail-loud, no silent degradation; ctx.signal abort canceled via control message, never just a dropped promise; reasons (unified fence physical contract / orphan process-group reap discipline) stated item by item |
