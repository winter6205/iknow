# 0020. Trace inspection read side merged back into `iknow serve`: same-process route-subtree mount (reverses the separate-process split)

Date: 2026-08-17
Status: accepted

## Context

The PR in question (commit `9ae9cf5e`) had split the trace read API out of `iknow serve` into a standalone `iknow trace` process (default port 24881), on three grounds: slow reads dragging down conversation, missing fault isolation, independent deployment/scale-out. The 2026-08-17 review: trace is **A-scenario (developer local debug) only** (ADR-0003; B-scenario production OTel is explicitly excluded), and single-user local debugging has no scale-out semantics. The first two grounds are mitigable by a per-query cap (the reader already caps at `MAX_TRACE_BYTES` 8MiB) plus route-level try/catch, without process separation. Meanwhile the two-process setup carries real costs: two-port mental load, two SPAs of the same origin that cannot cross-link, and a startup hint that makes the user run a second command. The decision owner ruled to merge back.

## Decision

`iknow serve` mounts the trace read-side route subtree + the `/trace` SPA in-process, on the same port (8787); `iknow trace`'s default behavior inverts to a probe entry (the `--separate` escape hatch keeps the standalone process). The write side (`src/harness/trace/` via `session-api/hub.ts`) is unchanged; its later move of `trace.jsonl` + `blobs/` into the conversation folder is carried by ADR-0071, not here. `src/traceserver/` and `src/session-api/` stay sibling directories (S1 bounded context) — no physical merge.

- **D1.1 Route table (mounted mode, single port 8787)**: `GET /api/v1/traces` + `/fields` → `handleTracesRequest` (semantics unchanged); `GET /api/v1/traces/sessions` → `handleSessionsRequest` (migrated from standalone's `/api/v1/sessions` under the traces prefix to avoid colliding with chat's `GET /api/v1/sessions`; the chat sessions route is untouched); standalone mode (`--separate`) keeps the `/api/v1/sessions` alias for one version; mounted mode does not re-mount `/api/v1/health` (session-api already has it).
- **D1.2 SPA mount**: `GET /trace` + `GET /trace/*` → `trace.html` SPA fallback; `/` still serves `index.html`. Uses a new optional `stripPrefix` in `serveStaticRequest` (`src/web/serve-static.ts`, stdlib-only invariant holds); the path-traversal guard applies to the stripped path. Both SPAs share the same `web/dist` (the vite multi-entry status quo, zero build changes).
- **D1.3 Unified error envelope**: in mounted mode, `ValidationError` / `TraceReadError` / unknown errors go through session-api's `sendError` with the same envelope (`{error:{kind,message,context?}}`; `TraceReadError` is a fixed 500 `trace file read failed`, never echoing fs details). The `isSessionStoreError` guard semantics are unchanged (its Error-instance exclusion logic was always correct), only the comment is updated. Standalone mode keeps its own sendError.
- **D1.4 Reverse-dependency split**: the `createTraceRouter` factory takes an injected `version: string` (the caller gets it from `cli/usage.ts getVersion()` — `session-api/http.ts` already imports it that way); traceserver deletes its import of `../cli/usage.js`.
- **D1.5 Factory signature**: `createTraceRouter(opts: { traceDir?, maxBytes?, version }) → (req, res) => Promise<boolean>` (`true` = handled; `false` = not a trace route, caller continues). `startTraceServe` is kept as a thin shell (assembles factory + health + static internally) and continues to serve `--separate`.
- **D1.6 Frontend API base**: `getTraceSessions()` in `web/src/api/client.ts` moves to `${TRACE_API}/sessions` (i.e. `/api/v1/traces/sessions`); the `TRACE_API` default `/api/v1/traces` is unchanged and the `VITE_TRACE_API_BASE` override semantics are unchanged.
- **D2.1 `iknow trace` default behavior**: starts no process — probes `http://<host>:<port>/api/v1/health` (host/port via `--host`/`--port`, default 127.0.0.1:8787); success → print `http://host:port/trace` + auto-open the browser (disabled by `--no-open`) + exit 0; failure → print a not-detected hint telling the user to run `iknow serve` first or use `iknow trace --separate` + exit 1.
- **D2.2 `--separate` escape hatch**: current behavior kept (standalone process on 24881; the dynamic `import` of `traceserver/serve.js` stays — the chat/ask startup paths gain zero new dependencies).
- **D2.3 Legacy detection**: the `detectLegacyTrace` fail-fast is kept and runs before the probe (both modes need the migrated directory semantics).

## Consequences

1. CHANGELOG Breaking: `iknow trace`'s default behavior inverts; scripts relying on the old behavior use `iknow trace --separate`.
2. Slow-read mitigation now relies on the per-query cap (`MAX_TRACE_BYTES` + result-row cap); an extremely large trace may still briefly block the event loop on a single query — acceptable for A-scenario, and B-scenario is handled by the OTel path (within ADR-0003's exclusion scope).
3. The standalone alias `/api/v1/sessions` is deleted after one version.
4. `tests/session-api/trace-mount-removed.test.ts` (regression guard) is renamed to `trace-mounted.test.ts` with the assertion inverted.
5. Same-process single-port eliminates the dual-origin split — chat ↔ trace pages can cross-link plainly (the `/trace?session=<id>` deep-link), and trace data is naturally same-process with the serve write side (the hub writes `<traceDir>/<convId>.jsonl` per session, visible to the read side in place).

Evidence: ACR 5-dimension PASS (Pass 1 three yes + Pass 2, after supplementing the two unclear dimensions with the 5-boundary-classes mapping and the commit strategy, re-review yes); covering D1 / D2.
