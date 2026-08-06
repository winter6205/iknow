# Plan: Web interaction surface + Session HTTP API

> Feature: host-layer HTTP session API + static chat UI  
> Constraint: **no** 4-tool protocol change; G2 every turn; reuse `ConversationState`  
> Branch intent: `feat/web-interaction-session-api`  
> Date: 2026-07-12

---

## Skill check (router)

| Class         | Skill                            | Role                              |
| ------------- | -------------------------------- | --------------------------------- |
| Planning gate | `architecture-change-reviewer`   | 5-verdict before code             |
| Planning      | `writing-plans`                  | tasks ≤1 commit, binary AC        |
| Frontend      | `frontend-ui-engineering`        | tokens, a11y, loading/empty/error |
| Contracts     | `defensive-contract-validator`   | empty/invalid/session-not-found   |
| Errors        | `error-handling-enforcer`        | typed HTTP errors, no empty catch |
| Scope         | `minimal-change-verifier`        | no tool/schema rewrite            |
| Agent surface | `agent-development-lifecycle`    | host surface only                 |
| Verify later  | `verification-before-completion` | before claim done                 |

**Not this slice:** streaming SSE, auth production, multi-tenant DB, React SPA scaffold (static host UI first).

---

## Architecture Change Review (ACR)

| Core Skill                   | Verdict                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| bounded-context-guardian     | **yes** — new `src/session-api/` (HTTP host) + `web/` (UI); reuses `interaction/*` + `cli/runtime`; no `controllers/services` layering; tools stay in `kb-*` |
| defensive-contract-validator | **yes** — tests: empty body, missing session, overlong text, invalid mode/role, concurrent create                                                            |
| error-handling-enforcer      | **yes** — JSON `{ error, message, details? }` + HTTP status; map `IknowError`; no silent 200 on fail                                                         |
| complexity-anti-drift        | **yes** — split contract / hub / http / static; handlers thin; UI modules: api / state / render / tokens                                                     |
| minimal-change-verifier      | **yes** — 1 logical task per commit; no refactor of agent-loop tools                                                                                         |

**Conflicts:** none requiring sequencing beyond T1→T2→T3.

---

## Problem / goal

| Have                              | Gap                                 |
| --------------------------------- | ----------------------------------- |
| CLI chat REPL + ConversationState | No browser surface                  |
| G2 + priors + slash               | No HTTP session API                 |
| STATUS: Web/HTTP 未实现           | Need reserved API + working backend |

**Goal:** ship (1) OpenAPI-style contract, (2) in-process HTTP session server, (3) accessible chat page that calls it, (4) tests + docs.

---

## API surface (host, not tools)

| Method | Path                            | Purpose                                             |
| ------ | ------------------------------- | --------------------------------------------------- |
| GET    | `/api/v1/health`                | liveness                                            |
| POST   | `/api/v1/sessions`              | create conversation                                 |
| GET    | `/api/v1/sessions/:id`          | snapshot (turns meta + last answer G2)              |
| POST   | `/api/v1/sessions/:id/messages` | user turn → G2 answer                               |
| POST   | `/api/v1/sessions/:id/commands` | slash-equivalent (json/role/mode/reset/help/status) |
| POST   | `/api/v1/sessions/:id/reset`    | clear turns (optional new_id)                       |
| GET    | `/` and `/web/*`                | static UI                                           |

**Non-goals for v0:** auth tokens, rate limits, SSE stream, multi-process session store.

---

## Files expected to change

| Path                                            | Task               |
| ----------------------------------------------- | ------------------ |
| `plans/web-interaction-session-api.md`          | this plan          |
| `docs/design/session-http-api-v0.md`            | contract truth     |
| `src/session-api/contract.ts`                   | DTOs               |
| `src/session-api/hub.ts`                        | multi-session host |
| `src/session-api/http.ts`                       | node:http router   |
| `src/session-api/serve.ts`                      | bootstrap + static |
| `src/session-api/index.ts`                      | exports            |
| `src/cli/parse-args.ts` + `cli.ts` + `usage.ts` | `serve` command    |
| `web/*`                                         | UI                 |
| `tests/session-api.test.ts`                     | contract tests     |
| `package.json`                                  | `serve` script     |
| `docs/STATUS.md` / `CHANGELOG.md`               | map update         |
| `.evals/tasks/007-session-api.yaml`             | plan eval hook     |

---

## Tasks (dependency order; 1 task ≈ 1 commit)

### T1 — Contract + red tests

- **Affects:** `src/session-api/contract.ts`, `tests/session-api.test.ts`, `docs/design/session-http-api-v0.md`
- **AC:** `npm test -- tests/session-api.test.ts` fails until hub/http land _or_ pure contract validation tests pass; design doc lists all routes
- **Binary:** design doc has GET health + POST sessions + POST messages

### T2 — SessionHub + HTTP server + CLI `serve`

- **Affects:** `src/session-api/hub.ts`, `http.ts`, `serve.ts`, `index.ts`, CLI parse/usage/cli.ts, `package.json`
- **AC:** `npx tsx src/cli.ts serve --port 8787` starts; `curl` create + message returns G2 `snapshot_id`
- **Binary:** hard-coded test against hub in-process without network optional; HTTP test with listen(0)

### T3 — Frontend chat UI

- **Affects:** `web/index.html`, `web/styles.css`, `web/app.js`, `web/api.js`
- **AC:** UI shows empty/loading/error/data; creates session; posts message; renders text + source_spans + snapshot_id; no raw hex outside tokens.css variables
- **Binary:** grep `snapshot_id` in app.js render path; no `#6[0-9a-f]` purple defaults

### T4 — Docs + eval task + STATUS

- **Affects:** STATUS, CHANGELOG, eval yaml, handoff note
- **AC:** STATUS §1 lists HTTP session + web UI; `bash .evals/run.sh` includes 007 if wired

---

## Validation

```bash
npm run typecheck
npm test
# manual:
npx tsx src/cli.ts serve --port 8787 --mode deterministic
# browser: http://127.0.0.1:8787/
```

---

## Risks

| Risk                               | Mitigation                                                   |
| ---------------------------------- | ------------------------------------------------------------ |
| LLM mode needs keys                | default deterministic; UI shows mode; fail-closed JSON error |
| In-memory sessions lost on restart | document; P4 persistence later                               |
| CORS                               | same-origin static from same server                          |
| Scope creep to React SPA           | static first; no new heavy FE framework                      |

---

## Success line

`成功 = plan has 4 tasks, all with binary acceptance; HTTP session API returns G2; web UI projects envelope without dropping snapshot_id`
