# Spec: session-model-isolation — each conversation owns its model route

**Status:** active — 2026-10-17.
**Decision SSOT:** `docs/adr/0145-conversation-owns-its-model-route.md` (amends ADR-0015 §1, ADR-0093, ADR-0094). Issue: #1258.
**Surface:** `src/session-api/hub.ts`, `src/session-api/store/schema.ts`, `src/session-api/serve.ts` (comment contract), `src/config/env.ts` (route resolver), `src/harness/sandbox/env-isolation.ts` + `src/harness/build-engine.ts` (mask union), `src/harness/subagent/` (envelope + worker fallback), `src/tui/run.tsx` + `src/tui/app.tsx` + `src/tui/hub-bridge.ts` (the `/model` act and display).
**Plan:** `plans/session-model-isolation.md`.
**Anchors:** every `path:line` is verified at master `a67e8273`.

## Goal

A conversation's model is chosen at creation and changed only from inside that conversation. The default model in `settings.json` decides only what new conversations start with.

**Users:** the operator running several TUI conversations or several processes; serve clients multiplexing conversations over one hub.

## 1. Terms

- **default model** — `settings.llm.model`, read through the EnvLoader. Read at conversation creation and for the one-shot backfill (§3); never on a turn.
- **conversation model route** — a `provider/model` route ID owned by one conversation. Durable copy: `SessionFileV1.model`. Runtime copy: the hub's `sessionRoutes: Map<conversationId, string>`.

## 2. Invariants

1. Every model call made for conversation C (turn, continue, compaction, thinking override, sub-agent fallback) uses C's route. No such call reads `cachedDeps.adapter`, `overrideEnvForTurn()` or `env.llm.model` for the model choice — except the equal-route short-circuit of §5, where the base adapter IS that route's adapter.
2. A change of the default (any process, any writer) changes no live conversation's route.
3. C's route changes only through C's `/model` act.
4. A present map entry is never replaced by a snapshot or a file read. Restoring happens only when the entry is absent.
5. A route that does not resolve fails the turn with a typed error; it never falls back to the default.
6. The output mask set is the union of every live owner's secrets; no build or route resolution removes another owner's values.
7. Credentials and limits (`apiKey`, `baseUrl`, `headers`, `routeMaxTokens`, `temperature`, `stream`, `thinking`, `thinkingEffort`, `fallback`) still hot-apply on the next turn of every conversation.

## 3. Lifecycle

| Event                                                 | Map                      | Session file                                                                |
| ----------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------- |
| `createSession` (`hub.ts:2412`)                       | set to current default   | `model` written in the creation save (`hub.ts:2418-2437`)                   |
| first attach, file has `model`                        | restored from file       | unchanged                                                                   |
| first attach, file lacks `model` (pre-change session) | snapshot current default | persisted with the next save of that conversation                           |
| TUI switch away and back                              | untouched                | untouched                                                                   |
| `/model` select in C                                  | set                      | `model` written inside C's serialize slot                                   |
| `resetSession` (`hub.ts:3307`)                        | entry deleted            | `model` kept (`...session` spread, `hub.ts:3319`) → restored on next attach |
| `shutdown` (`hub.ts:2203`)                            | cleared                  | —                                                                           |
| process exit                                          | gone                     | authoritative                                                               |

serve has no close/delete endpoint (routes in `src/session-api/http.ts`: create `:326`, reset `:628`), so serve entries live until reset or exit. No capacity eviction.

## 4. The `/model` act

One selection does both, in this order:

1. `hub.setSessionModel(conversationId, route)` — validate the route resolves (`resolveLlmEnvForRoute`), then map + session file. On failure nothing changes and a notice is shown.
2. The existing default write: `persistModelChanges` → `markSelfWrite` → `activeEnvLoader.reload()` (`src/tui/run.tsx:778-781`). `bridge.hub.reloadFromEnv()` (`:782`) stays for credential hot-apply and display; it no longer swaps the model of any conversation.

If 2 fails after 1, C keeps its new route; the existing notice path (`persistModelFailure`, `run.tsx:788`; `persistModelFromCommit`, `src/tui/app.tsx:5342-5358`) reports the default write failure. `onPersistModel` (`app.tsx:1924`) gains `conversationId`.

No separate "this conversation only" key, no "revert to default" key.

## 5. Read path

Per turn in `postMessage` (`hub.ts:2485`) and `runContinuePending` (`hub.ts:3593`):

```
route  = sessionRoutes.get(id)                    // restored on attach
env    = resolveLlmEnvForRoute(defaultEnv, route) // src/config/env.ts, new
adapter= routeCache.get(route, defaultEnv ref)    // createAdapterFromEnv(env) on miss
runDeps= { ...deps, adapter, ... }                // hub.ts:2744
```

- Thinking override: `withThinkingOverride({ deps, override, env })` (`hub.ts:2594-2601`) receives the route `env`.
- Compaction (`hub.ts:3446`): the route adapter replaces `this.cachedDeps?.adapter`.
- Cache key `(route, defaultEnv reference)`: the EnvLoader returns a new reference after a reload, so credential edits invalidate naturally. M routes → M adapters.
- **Equal-route short-circuit.** When the conversation's route IS the tier's own route (`route === tier.llm.model`), the base adapter already IS that route's adapter — it was built from the same env the tier is read from (`reloadFromEnv` restamps it from that env). The overlay is therefore applied exactly when the route DIFFERS from the tier's route, and only then. Replacing the base adapter for the tier's own route would discard a host-injected adapter (the SDK / test seam) for no behavioural gain. The precondition is pinned by a test: a conversation whose route equals the tier's model still sends that model on the wire after a default change.
- `reloadFromEnv` (`hub.ts:2269`) keeps validation, dedupe (`hub.ts:381-392`) and `onEnvChange`; it stops restamping `engineByRoot` adapters as the model source.

## 6. Sub-agent fallback

The worker envelope (`src/harness/subagent/envelope.ts`, next to `parentThinking` at `:81`) carries `parentModelRoute`. In the worker, the main-route fallback `env.llm.model` (`src/harness/subagent/worker.ts:741`, and the client/max-token helpers fed by `workerRoute` at `:740-742`) uses `parentModelRoute` when present. `settings.subagent.model` (`worker.ts:730`) still wins. `specs/subagent-model.md` "otherwise from `settings.llm.model`" becomes "otherwise from the parent conversation's route".

## 7. Output masking

`env-isolation.ts:160-167`: `setActiveExtraSecrets(owner, values)` / `clearActiveExtraSecrets(owner)`; `currentSecretValues()` reads the union. Owners: each engine build (keyed by root, `build-engine.ts:1345`; block mode clears only its own owner) and each live route (keyed `route:<id>`, its resolved apiKey and header values).

## 8. Contract text

- `src/session-api/serve.ts:255-258` → "editing `model` applies to new conversations; `apiKey` / `headers` apply on the next `POST /messages`".
- ADR-0015 §1, ADR-0093, ADR-0094: amendment notes.

## New tests

All in `tests/session-api/hub-session-model.test.ts` unless noted; wire-level oracle is the capture server body `model` and `TurnRecord.modelRequested` / `modelActual` (`src/harness/trace/types.ts:185-186`).

1. Two conversations A, B; A selects `p/m2`; B's next turn still sends `m1`.
2. After A's select, a newly created conversation sends `m2` (default updated).
3. A conversation with persisted `model: p/m2` reopened in a fresh hub whose default is `p/m1` sends `m2`.
4. Two conversations on routes with different keys: both keys masked in `currentSecretValues()` after both turns, in either build order — in the new file, because the oracle needs a real hub turn per route (the sandbox neighbour file owns the union mechanism itself, with synthetic owners).

Cross-process is simulated: write `settings.json` + drive the EnvLoader subscription → `reloadFromEnv`, then assert the existing conversation's next turn is unchanged. No second process.

## Test disposition

`tests/session-api/hub-hot-reload.test.ts` (no deletions, AGENTS.md red line 11):

| Line                                                                    | Today                         | Becomes                                                                          |
| ----------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------- |
| `:162` `deps.adapter` not the base adapter                              | object identity               | capture-server body for a new conversation carries the provider model            |
| `:198` adapter replaced after model change                              | object identity               | new conversation sends new model; existing conversation sends old model          |
| `:208-245` next postMessage gets new adapter                            | same conversation switches    | split: same conversation keeps `model-1`; new conversation sends `model-2`       |
| `:340` / `:372` / `:380` adapter kept / rebuilt on reload failure / fix | object identity               | next turn still sends the old model / key; after fix, wire carries the fixed key |
| `:386` baseUrl, `:425` temperature                                      | same conversation hot-applies | unchanged (invariant 7)                                                          |

## Before release (not in this change)

- Full matrix: {TUI, serve} × {create, reopen, reset, backfill} × {route valid, provider removed, key unset}.
- Real two-process test over one `~/.iknow`.
- Concurrent `/model` in two conversations of one serve hub under load.
- Session-file round-trip fuzz with and without `model`.
