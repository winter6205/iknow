# Spec: IM bridge — Feishu / Lark as an external consumer of the session API

**Status:** draft
**Basis:** ADR-0120 (integration shape settled; this spec implements, does not reopen); ADR-0110 (single writer); ADR-0019 / ADR-0023 (workspace root explicit); `docs/platforms/feishu-facts.md` = SSOT for platform numbers, restated only where one sets a contract
**Surface:** new `src/bridge/` + `src/bridge/feishu/`; `iknow bridge` in `src/cli/` + `src/cli/usage.ts`; `src/config/{settings,env}.ts` + `src/harness/sandbox/env-isolation.ts` for the credential and `bridge.feishu.allow` surface; `src/session-api/{http,contract,hub,serve}.ts` + `src/harness/permission/ask-user.ts` for §Server-side; `web/` (bearer header and the one-time token prompt only)

## Objective

A resident bridge turns one Feishu chat into one iknow conversation: receive callbacks, run the turn over `iknow serve`'s HTTP surface, render progress, results and approvals back. The answer already arrives in the driving call's response, so the open problems are progress granularity, approval ownership and admission — not final-text delivery.

### Naming

Module = **IM bridge**; directory `src/bridge/`; subcommand `iknow bridge`. _Channel_ is unavailable: it names the trust axis here (ADR-0009, `docs/CONTEXT.md:705`). Platform links are **connection** / **transport**. The `CONTEXT.md` entry is a docs task, not this file.

## Boundaries

- **Does:** the split, the inbound queue and mutex, session mapping, v1 progress, approval relay, the four authorized API changes, render budget, admission and audit, the two command surfaces, state and recovery.
- **Confirms with human:** (none)
- **Out:** other IM platforms (only an adapter directory + facts page reserved); per-`thread_id` session mapping; one bridge serving many unrelated tenants or more than one workspace root; audio; a phone app; inbound image, file, audio, or rich-text (`post`) turns; implementing `GET /sessions/:id/events`; SPA work beyond the bearer header and the one-time token prompt; workspace or permission-mode mutation from IM; a bridge command or button that grants `always-allow`.

## Core / adapter split

`src/bridge/` holds what we decide: mapping, admission, slash surface, turn execution over HTTP, state persistence, approval relay, abstract "status slot" / "body slot" rendering. `src/bridge/feishu/` holds what Feishu decides: long-connection inbound and ACK, card create/PATCH and CardKit streaming, reaction add/delete, token lifecycle. It verifies no callback signature and downloads no message resource: long connection carries its own encryption and authentication (facts page), and inbound media is out of v1 (§Boundaries). A new platform adds one adapter and one facts page; a change above the line is legitimate only when the platform cannot express a core primitive, and is reported as a core-model gap rather than special-cased. The core never parses a platform payload.

## Inbound execution model

1. Handler shape-checks, enqueues, returns 200. The 3-second deadline (facts page) is structural and the driving call blocks for the whole turn, so a turn inside a handler guarantees a miss and a re-push.
2. **Serial per `chat_id`**; global in-flight cap across chats, default 4 (`--max-in-flight`). A turn updates its card at most three times: create, one final body, close `streaming_mode`. It also adds one reaction and deletes that same reaction. No separate rate limiter. A 429 or the documented reset signal backs off that card; the final text is still delivered once.
3. **Single-instance mutex**, bridge-owned (ADR-0120 Decision 2): the 50-connection cap with random delivery (facts page) makes a second instance split events silently instead of failing. Ownership file with pid plus a per-start random token, `unlink` before listen — the egress shape (`src/harness/sandbox/egress/session.ts:957,991,996`). It records the last completed `event_id`; staleness is judged by pid liveness, and takeover logs the previous owner rather than erasing it.

## Session mapping and workspace

- `chat_id → conversationId` is bridge state, never a session-file field. **Direct messages are settled.** The key is `chat_id` alone. The bridge does not read which session the product UI currently has open.
- **When a direct message continues, and when it mints.** After slash handling, look up `chat_id` in `chats.json`. A row present means the old conversation: post the text to that `conversationId`. A row absent means the first time this direct chat has been admitted: `POST /sessions`, then store the new id. The next text in that same chat uses the stored id. Message wording, silence, time of day, and message count do not mint another conversation. Bridge restart keeps the row, so the next text is still the old conversation. A redelivered `event_id` is dropped before this lookup and does not mint.
- **`/new` is the only in-chat way to switch.** The bridge handles it locally: `POST /sessions`, replace the row, reply with a notice that a new conversation is in use. The command text is not posted into the old conversation or the new one. The old conversation stays on disk and receives nothing further from this chat. `/new` does not reset or rewind the old conversation (ADR-0120 Decision 6).
- **Groups are refused.** `chat_type == group` gets one reply, `v1 只支持私聊。`, and no session, no queue entry, no mapping row. Thread keys are out of this spec.
- Fresh conversation via `POST /api/v1/sessions` (`src/session-api/http.ts:321-328`); state read only via `GET /sessions/:id`.
- A `conversationId` another front end drives is never adopted: ADR-0110 Decision 3 makes cross-process open unsupported with silent tearing. The bridge uses only ids it minted and persisted.
- serve is unbound by default, answering creation with 400 `validation` field `workspaceRoot` (`src/session-api/hub.ts:232-243`). IM has no picker, so **binding never comes from IM text** (ADR-0120 Decision 5): startup config, cross-checked against the trusted roster, plus out-of-band `confirmTrust` / `--workspace-root` / `IKNOW_WORKSPACE_ROOT`. Every conversation this bridge mints uses that one root. A second repository is a second bridge process, not a second binding inside this one.
- Process-level holders are shared, so IM cannot mutate them in v1: `PUT /workspace` rewrites the process `boundRoot`, affecting only later sessions (`hub.ts:1646,1664,1709`), and `/permission-mode` POST only cycles one shift, never sets a level (`http.ts:489-494`). Either pollutes every other session.

## Progress presentation (v1, two levels)

`POST /sessions/:id/messages` returns after the turn with `{session, turn}` (`http.ts:604-616`; `TurnAnswerDto` `contract.ts:18-82`), so the bridge's own turn needs no push. Missing: intra-turn increments and turns the bridge did not start.

- **While the turn runs — one reaction.** Add it on the user's message when the turn is accepted, delete it when the turn ends in done or error. Only the adder may delete (facts page), so `reaction_id` persists the instant the add succeeds. One pair per turn, not a series of emoji. Intra-turn tool lines are not rendered.
- **When the turn ends — one card.** Create it in the running state if it was not created at accept, patch the final text once, then close `streaming_mode` on that completion path. `sequence` only moves forward. The card shows the final answer, not a live tool trace. If create or the final patch fails, send the final text once as a text message and say that the card was skipped. The documented send cap of 30 KB is the budget; a tighter card-JSON cap, if later measured, only lowers this number.
- v1 consumes no push. `GET /sessions/:id/events` stays 501 (`http.ts:397-412`) and is not a precondition of shipping the bridge (ADR-0120 Decision 7).

## Approval relay (declared blocking)

The API defects are fixed by S1/S2 below; these are the bridge-side rules they enable.

- The bridge **must not** infer ask ownership from a poll-time set difference: another session's ask would be answered from the wrong chat. Ownership comes from the response only.
- **Poll off the turn queue.** The driving `POST /messages` blocks for the whole turn, so `GET /sessions/:id/asks` on a timer is the only discovery channel; it never runs behind the queue slot its own turn holds. Cadence: once on entering a turn, then 500 ms while a turn is in flight, 2 s when idle.
- The window must dominate that interval, which is why S2 exists: the bridge profile sets the ask window to 180 s, ≥ 360× the in-flight poll, so an ask cannot expire in the gap between arising and the card landing.
- A longer window does not weaken the decision: expiry still denies (fail-closed retained), and the card states that a timeout was a denial, not a pending item.
- The bridge does not expose `always-allow`. The grant is memory-only and dies on serve restart (`hub.ts:1616-1623`; `session-grants.ts:4,35-37`); a button or slash command for it would claim a lifetime the process does not have.
- **Card copy is fixed**, simplified Chinese, not platform locale. Title `权限审批`. Body is two lines: the tool name, then `summaryHint`. Buttons: `批准这一次` and `拒绝`. The body states that no click within 180 seconds is a denial. After a click or a timeout the buttons are removed and the same card reads `已批准`, `已拒绝`, or `超时未处理，已自动拒绝`. The turn's final answer stays on the progress card. A denial does not send a second explanation message.
- Only the `open_id` that sent the user message for this turn may settle the card. Any other click consumes nothing. A second click finds no button and no live nonce.
- Callbacks carry attacker-controlled `action.value`; only the nonce record is trusted. **Verification precedes consumption** — a mismatch consumes nothing, so a rejected callback cannot burn a valid nonce.

## Server-side changes (minimum authorized)

Error kinds stay inside the envelope union (`contract.ts:356-363`).

| #   | Change                    | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Breaking                                                      |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| S1  | ask ownership             | `GET /sessions/:id/asks` → 200 `{asks:[{id,tool,summaryHint,conversationId}]}`, filtered to `:id`; unknown session → 400 `validation`, never the global list. Today the route is per-session but returns the process-global snapshot (`hub.ts:1410-1412` → `ask-user.ts:155-158`), and the view lacks the field (`ask-user.ts:132-136`, `http.ts:681-684`)                                                                                                                                  | additive field, tightened semantics; non-breaking for the SPA |
| S2  | ask window                | configurable via the existing `timeoutMs` option (`ask-user.ts:126-129`), passed at serve assembly (bridge profile: 180 s, see §Approval relay); the 5000 ms fail-closed default stays (`ask-user.ts:161,209-227`) so chat/TUI are unaffected; no wire change                                                                                                                                                                                                                               | no                                                            |
| S3  | `POST /sessions/:id/stop` | 200 `{session,stopped}`; `stopped:false` = idle (idempotent); malformed body → 400 `validation`; unknown session → 404 `not_found`; reuses the `postMessage({signal})` abort seam of `/compact` and `/continue` (`http.ts:651-677`); the turn reports `stopReason:"cancelled"` with `interrupted` (`contract.ts:42-48`)                                                                                                                                                                     | no (additive)                                                 |
| S4  | bearer gate               | session-reading and mutating routes require `Authorization: Bearer <token>`; `GET /api/v1/health` exempt (`http.ts:216-217`); absent / malformed / wrong → 401 `kind:"validation"`, one shape, no oracle; token resolves through the house chain **env > settings > default** (`IKNOW_SERVE_TOKEN` > user settings `serve.token` > a value generated per start and printed once to stderr) — there is no fourth, unauthenticated state; bind host unchanged (`http.ts:147`, `serve.ts:294`) | **yes** — SPA sends the header in the same change             |

S4 is not a follow-up: `handle()` has no credential branch across its route table (`http.ts:195-375`) yet that face posts messages, binds workspaces, cycles permission mode and resolves asks, so any local process could mint approvals on a remotely driven turn. ADR-0120 Decision 4 already blocks shipping a bridge before mutating routes authenticate.

## Outbound render budget

- Bounded by the 30 KB card cap (facts page, authoritative). Rule: one rendered segment per `activity` item (`contract.ts:28-29`) in order, cutting only the **last** included segment so the cut point is stable across PATCHes; truncation is always labeled with the dropped length, never silent.
- Past the budget, change form: full text goes out as a file message. Server-side tool previews are already truncated and flagged (`contract.ts:103-111`), never re-grown.
- Inbound text must satisfy `MAX_MESSAGE_CHARS = 8000` (`contract.ts:14`, enforced `hub.ts:3082-3085`): validate pre-call, reply with a typed notice, never split one message across posts to dodge the cap — that turns one turn into several.

## Admission and security boundary

- Fail-closed roster read from the user settings section `bridge.feishu.allow`: `openIds` **gates**, `chatIds` **narrows**. An absent or empty `openIds` denies everything. An empty `chatIds` narrows nothing, and that is not a loophole — it is the only order that can work, because a direct chat's `chat_id` is not knowable before its first inbound event (a DM is addressed by `open_id`, and `GET /im/v1/chats` returned an empty list for our app, facts page §Measured), so a roster that demanded a `chat_id` up front could never admit its first message. When `chatIds` is non-empty, both must match.
- A stranger is dropped silently — neither confirming nor denying the bot — but one log line carries the `open_id`, the only onboarding path.
- Pairing grants access: a one-time code shown only to the initiator, redeeming exactly that `open_id`. The redeemed id is appended to the settings `bridge.feishu.allow.openIds` through the existing atomic settings writer (`src/config/persist-settings.ts:492-494`, `0600`), so there is one admission roster rather than a second one in bridge state.
- Card actions are single-consume; the nonce binds expected chat, message and operator, blocking replay and cross-chat or cross-card redirection.
- App credentials come from the environment only: `FEISHU_APP_ID` and `FEISHU_APP_SECRET`, read through `process.env` with no CLI flag and no `.env` file fallback (the provider-key path at `src/config/env.ts:391` is the precedent for refusing a file fallback). Missing or empty is a startup refusal that names the variable. Masking needs no new code: `FEISHU_APP_SECRET` matches the existing `SECRET_PATTERN` (`src/harness/sandbox/env-isolation.ts:73-74`), which the `process.env` name scan feeds into `configuredSecretNames()` (`:83-90`) and then into the child-env strip and value-hiding path (`currentSecretValues()`, `:152`). T0 asserts that coverage rather than building it. `FEISHU_APP_ID` is not a secret by that pattern and is never masked, which is fine: it is a public app identifier.
- **Why this pair is env-only while the serve token is not.** The two differ by blast radius and by rotation owner. `FEISHU_APP_SECRET` unlocks a tenant's cloud API surface, is rotated in a web console, and stays valid on every machine that holds it — so a file is the wrong place to keep it and a settings field would spread it into backups. The serve token gates a `127.0.0.1` listener on this machine, is rotated by editing one line, and has no meaning anywhere else. It also has a requirement the app secret does not: **two processes must agree on it**, and a measured constraint says an environment does not survive that — a non-interactive shell never reads `.bashrc`, so an env-only token breaks the moment `serve` or the bridge is started by anything but a login shell. Settings is the single source both read regardless of how they were launched, and it is already the repo's home for a literal credential (`settings.llm.apiKey`, `src/config/settings.ts:196-202`).
- **Serve token** (S4): user settings section `serve.token`, resolved env > settings > generated-per-start. `serve` never binds without one, so there is no fourth state to fall into. The SPA cannot read this file and must not be handed the value in served HTML — a local process that cannot pass the gate can fetch the page and lift an embedded token out of it, which reopens exactly what S4 closes. So the SPA holds the token in `sessionStorage` after a one-time prompt on the first 401, and the bridge reads settings like any other consumer. `web/` work stops at that prompt plus the header on the one `fetch` wrapper (`web/src/api/client.ts:75`); the prompt is the whole SPA surface, not a settings screen.
- State directory `0700`, files `0600`.
- **A new settings section is parsed, not tolerated.** `assembleSettings` emits only the sections it explicitly parses (`src/config/settings.ts:1727-1741`), so an unrecognized top-level key drops out of the typed result at _both_ layers and **without a warning** — the `onWarn` channel belongs to the project allowlist alone. So `serve.token` and `bridge.*` each need a parse-and-merge pair, otherwise the file silently lies about being configured. Hand-written keys do survive later writes: every persist path is a read-modify-write on raw JSON that preserves unknown top-level keys verbatim (`src/config/persist-settings.ts:269`) and re-applies `0600` before the rename (`:488-498`).
- Audit: one append-only line per approval decision — operator `open_id`, ask id, tool, decision, resolved or timed out. Message bodies never enter logs; ids only.

## Command surface

Flags: `--state-dir` (default `~/.iknow/bridge/feishu/`), `--serve-url`, `--pair`, `--revoke <open_id>`, `--status`, `--data-dir`. There is no `--config` flag: admission config lives in the user settings file under `bridge.feishu.allow` (`openIds`, `chatIds`), and a second config authority that can disagree with it is worse than a longer path. The project settings layer does not admit the `bridge` section — `PROJECT_SETTINGS_ALLOWED_KEYS` is `verify`/`secrets`/`permissions` (`src/config/settings.ts:636`) and every other top-level key in a project file is dropped and warned via `LoadSettingsOpts.onWarn` (`:628-635`). So a project-level `bridge` key cannot widen admission, and the warning is what makes the drop visible instead of silent. `--status` prints lock owner, whether `serve` answered, the configured workspace root, the `openIds` roster actually loaded, the mapped `conversationId` for this chat, and whether an ask is pending. The bearer token comes from settings `serve.token`, overridable by `IKNOW_SERVE_TOKEN` (§Admission). The TUI does not send it; it does not call this HTTP face. The SPA sends it in the S4 change. A new subcommand must update `usage.ts` (bilingual by design; commands `:21-30`, options `:32-47`) so both assertion families hold — positive advertisement and retired-flag absence (`tests/cli-session.test.ts:130-163`, `tests/cli/data-dir.test.ts:50-53`).

| IM verb                                    | Route                                                     | Status                                                                             |
| ------------------------------------------ | --------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| text, `/status`, `/continue`, `/compact`   | `/messages`, `GET /sessions/:id`, `/continue`, `/compact` | text continues the mapped conversation; mappable today                             |
| `/new`                                     | `POST /sessions`, then replace the `chat_id` row          | local; does not post the command as a turn                                         |
| `/stop`                                    | `/stop`                                                   | blocked on S3                                                                      |
| `/approve <id>`, card buttons              | `/asks/:askId/resolve`                                    | blocked on S1 + S4                                                                 |
| `/yes-always`                              | —                                                         | not in v1: the bridge does not grant `always-allow`                                |
| `/reset`, `/rewind`                        | `/reset`, `/rewind` (`http.ts:617-645`)                   | not in v1: ADR-0120 Decision 6 forbids the bridge resetting or rewinding a session |
| `/rename`, `/model`, `/workspace`, `/mode` | —                                                         | not in v1: no rename route; holders are process-level                              |

## State and recovery

`~/.iknow/bridge/feishu/`: `instance.lock` (pid, token, last `event_id`), `chats.json` (mapping only; the roster that admits a stranger lives in settings, §Admission), `cards.json` (`message_id`, `card_id`, element, last `sequence`), `reactions.json`, `nonces.json`, `seen-events` (bounded), `audit.log`. **Bridge restart:** all of it is on disk — cards resume, orphans are reclaimable, in-flight turns are lost only at transport level since the bridge owns no engine; unfinished streams close before the loss is reported. **serve restart:** memory-only grants vanish; the token survives when it came from settings, and only a generated one is replaced, an awaited turn dies — report once and never re-post the user text, whose side effects may already have landed.

## Failure paths

| #   | Path                                  | Behavior                                                                                                       |
| --- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| F1  | duplicate event after a slow handler  | `event_id` dedupe before enqueue; one turn; same 200                                                           |
| F2  | card PATCH rejected / throttled       | no tight retry; back off on the documented reset signal; degrade to reactions; final text still delivered once |
| F3  | callback would exceed 3 s             | ACK with no visible mutation, act asynchronously                                                               |
| F4  | `streaming_mode` left open            | buttons silently dead; a bug class with its own test, not a tolerated state                                    |
| F5  | `sequence` regression after crash     | re-read the cursor, advance only; a rejected PATCH means re-sync, not guessing higher                          |
| F6  | token expiry                          | refreshed at the documented boundary; never surfaces                                                           |
| F7  | version skew across S1–S4             | probe at startup, refuse to start with a readable report; never fall back to guessing ownership                |
| F8  | crash between reaction add and delete | replay `reactions.json`; delete owned reactions only                                                           |
| F9  | second instance starts                | refuses, naming the owner's pid and token                                                                      |
| F10 | ask expires while the card is open    | `{resolved:false}` (`http.ts:702-714`); mark expired, no retry — the harness already denied                    |

## Input-contract classes

| Surface              | empty                                           | invalid                                                                                                    | overflow                                                            | concurrent                                                                                  | exception                                                       |
| -------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `/sessions/:id/stop` | `{}` = stop in flight                           | non-object → 400                                                                                           | N/A                                                                 | second stop → `{stopped:false}`                                                             | typed error → existing `sendError`, never a hang                |
| `/sessions/:id/asks` | → `[]`                                          | unknown id → 400, never the global list                                                                    | same bound as `pendingAll()`                                        | resolve mid-poll → vanishes, later resolve `false`                                          | as above                                                        |
| Bearer check         | absent → 401                                    | malformed → 401, same shape as wrong token                                                                 | over-long header → 401 before parsing                               | stateless per request                                                                       | constant-time compare; no token or stack leak                   |
| App credentials      | unset / empty → refuse start, name the variable | space or control char in value → refuse, name it (a damaged paste must not silently become another secret) | N/A: nothing is length-guessed, the platform rejects a wrong secret | two processes with the same credentials → the mutex decides (F9), not a credential conflict | the value is never rendered, not even masked or length-prefixed |
| Bridge state files   | missing = fresh start, legal                    | unparseable → refuse to start, name the file; never auto-reset a mapping                                   | `seen-events` bounded, oldest-first eviction                        | one writer = the owning instance                                                            | write failure → not reported as done                            |
| IM slash parse       | bare `/` → unknown-command notice               | unknown verb → list real verbs                                                                             | over-cap → typed notice, no auto-split                              | per-chat serial, no reentrancy                                                              | throw after ACK → typed log, queue alive                        |

## Settled invariants

1. No engine and no session file in the bridge process; HTTP is the only iknow-facing door.
2. The bridge mints every `conversationId` it drives and never borrows one. A direct chat keeps one mapping until `/new` or until the row is absent. A group inbound mints nothing.
3. Callbacks never contain turns.
4. Approval fails closed: timeout denies, unknown nonce denies, unverified callback consumes nothing.
5. Ask ownership is authoritative per session, never inferred from a global snapshot.
6. IM text cannot bind a workspace or shift a process-level holder.
7. Every degradation is labeled on-screen.
8. Nothing ships before S4.

## Task breakdown (server-side first)

- **T0** app credentials from `process.env` + `bridge.feishu.allow` settings section + masking wiring — `src/config/{settings,env}.ts`, `src/harness/sandbox/env-isolation.ts`; unit tests on the refuse paths, one output-absence test. Gates T4, T5.
- **T1** S4 bearer gate — token resolution chain (env > settings `serve.token` > generated), the new `serve` settings section's parse-and-merge pair, `http.ts` gate, `serve.ts` wiring, `web/` header plus the one-time 401 prompt; route-table tests incl. the no-fourth-state claim. Gates T4+.
- **T2** S1 ask ownership — `ask-user.ts`, `hub.ts`, `http.ts`; integration test on a real `SessionStore` in a temp dir with two fresh `conversationId`s.
- **T3** S2 + S3 — assembly and route reusing the compact/continue abort shape; needs the real-model interrupt run.
- **T4** core skeleton — mapping, queue, mutex, state files; pure-function unit tests.
- **T5** admission, pairing, audit; unit tests incl. empty-config denies all.
- **T6** transport — connection, ACK, token lifecycle, Range download; fixture unit tests.
- **T7** rendering — card budget, sequence cursor, reaction machine; unit tests.
- **T8** approval relay — nonce issue / verify / consume order, cross-chat rejection. **Depends on T1 + T2.**
- **T9** CLI and `usage.ts`; passes both advertise assertions.
- **T10** real-device acceptance per §Success criteria.

Ordering is explicit: T1–T3 land before T4 and T8 consume them, since a bridge shipped against the pre-change face would have to guess ask ownership — the defect this spec exists to close.

## Success criteria

- SC1: with two live sessions, an ask arising in A is invisible and unresolvable from B — by test, not inspection.
- SC2: stopping in flight yields `cancelled`; stopping idle yields `{stopped:false}`; client disconnect aborts like `/compact`.
- SC3: every route except `GET /api/v1/health` rejects absent, malformed and wrong tokens identically; the SPA still works with the header; and no state answers unauthenticated — with neither env nor settings supplying a token, `serve` still gates on the generated one.
- SC4: a second instance refuses and names the owner. SC5: an over-cap answer truncates at a stable point with a visible label.
- SC6: `npm test` green; T3's real-model run green; LSP diagnostics clean on changed files.
- SC7: one admitted direct `chat_id` posts a second text to the same `conversationId`. `/new` stores a different id and the following text uses that id. A later text while the row exists does not call session create. Restarting the bridge process and delivering another text still uses the id from disk.
- SC8: a `chat_type == group` inbound replies `v1 只支持私聊。` and does not create a session or a mapping row.
- SC9: with `FEISHU_APP_SECRET` unset the bridge refuses to start and names the variable; with it set, no startup log line, `--status` output or error rendering contains it in any form, including a mask of it. A `bridge` key present only in the project settings layer is dropped with the existing `onWarn` warning and cannot widen the roster the process admits from.
- **Real-device checklist** — not automatable in CI; each unchecked item is reported Not run, never as done: 1 pair on a phone; 2 send text, see the running reaction; 3 long answer truncates visibly; 4 approve a tool ask from the card and see the turn continue; 5 let an ask time out, confirm the deny reached the session; 6 kill -9 mid-turn, confirm no orphan reaction and no duplicated turn; 7 restart serve, confirm the expired-grant notice; 8 finish a streaming card, confirm buttons respond.

## Measured matrix

Pure functions → `npm test`. T0 needs nothing more: its refusal paths and its output-absence assertion never reach a conversation. Anything reaching a real conversation → `npm test` **plus** a `mcp__aiterm__pty_*` TUI run (start, inject keys, read the screen, record operations and on-screen result): T2, T3, T8. T1 changes a browser surface, so it adds the web run: `iknow serve` + `web/dist` through `.claude/skills/playwright-cli/`, and its screen evidence is the 401 prompt accepting the token and one session then loading. Loop interruption and CLI wiring → additionally `npm run test:real-llm`: T3, T9. New subcommand → `usage.ts` synced to both assertion families. **No `probe:*` is required by this spec:** the entries `package.json` carries (`probe:lsp`, `probe:sandbox:subagent`, `probe:aci-web-backend`) fence sandbox/subagent, LSP and egress-backend boundaries, none of which a bridge process touches — the bridge builds no engine and spawns no worker (Boundaries). The full physical-sandbox probe lives outside this repo, so it is not citable as runnable here. A bridge smoke surface would be new work: one `scripts/probe-*.ts` plus its npm entry, and until that exists the real-device checklist is reported Not run, never as done.

## Open questions

(none)

## Inherits / Changes

**Inherits:** ADR-0110 (no new lock); ADR-0019 / ADR-0023; all seven ADR-0120 decisions; the egress ownership-file precedent; existing typed-error and log-redaction discipline; the `.claude/rules/test.md` matrix. **Changes:** S1–S4 plus the SPA header and its one-time token prompt, and two new user-settings sections (`serve`, `bridge`). Numbering: this decision is ADR-0120 because ADR-0119 on master is code-preimage restore.

## Evidence pointers

Assertions carry their own line citations above. Additional: `src/session-api/store/errors.ts:13-19` (kinds feeding the envelope union); platform constraints live in `docs/platforms/feishu-facts.md` rather than being duplicated here.
