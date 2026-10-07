# T1 evidence: reproduced command and LSP failure

Date: 2026-10-07
Ticket: T1 of [`docs/implementation-plans/runtime-capability-recovery.md`](../implementation-plans/runtime-capability-recovery.md) — "Capture reproducible command and LSP failure evidence".
Scope: evidence only. This ticket changed no behavior code; the commits that do are separate.

## Method

Incident session `8f3b101d-27f3-4a54-ba34-e557304ffdb6` (2026-10-07T14:43–14:48Z).

`tool_call` records in `trace.jsonl` do not inline results (`result_captured:false`); the bodies live in
`<traceDir>/<conversation>.jsonl`. That is the trace SSOT, and every quoted result below is read from it,
not from the assistant's own narration. Server-side probe runs were executed in a disposable worktree
(`/home/winner/projects/iknow-wt-rcr`, `origin/master` 30a931d15) with dependencies installed from the
lockfile.

## Finding 1 — a piped install reported success it did not have

Command (`tool_call_id` `7469060a-626d-4f16-bdf7-66391ed65cea`, 121.8 s, harness `status: ok`):

```sh
cd /home/winner/projects/iknow && timeout 120 npm i -g typescript-language-server typescript 2>&1 | tail -20
```

Recorded result:

```json
{
  "code": 0,
  "stdout": "npm warn Unknown user config \"disturl\". ...",
  "stderr": ""
}
```

`code:0` is `tail`'s status, not npm's. The falsifiable prediction — "the install did not happen" — was
checked in the same session and held. The next call in that session ran
`command -v typescript-language-server; command -v tsserver; ls $(npm root -g)` and returned:

```json
{
  "code": 0,
  "stdout": "@anthropic-ai\n@mariozechner\nbun\ncline\ncorepack\niknow\nnpm\nplaywright\n"
}
```

No `typescript-language-server`, no `typescript` in the global root. **A false success was reported and
consumed as a success.** This is the plan's settled pipeline clause reproduced: the reported status is the
shell's real status, and without `pipefail` an upstream installer's status is not recoverable from it.

## Finding 2 — the retry stalled, and the result cannot classify why

Command (`tool_call_id` `055b5110-3956-4aa1-ac82-9b0c1d2371c8`, harness `timeout_ms` 150000):

```sh
cd /home/winner/projects/iknow && timeout 120 npm i -g typescript-language-server 2>&1 | tail -30; echo "EXIT=${PIPESTATUS[0]}"
```

Recorded result: `status: error`, `error.type: execution_failed`, `error.cause: timeout`, duration 154.6 s
against a 150 s deadline, `cleanup: {state: "confirmed_stopped", pgid: 1896112}`. Two observations:

- Cleanup did its job — the deadline fired and the process group is confirmed stopped.
- The command's own `timeout 120` should have ended the pipeline near 120 s; the harness deadline was
  reached ~34 s later, so stop/settle latency exceeded the deadline rather than the command running long.

**Classification: not established.** Egress denial and runtime stall are indistinguishable in this evidence.
The only stderr-capable channel was swallowed by `| tail`, and the harness surfaced no failure stage or
cause. A direct unpiped probe from a later session reached `registry.npmjs.org` and `pypi.org`, but that
session's bash path is not egress-fenced (a control probe to `https://example.com` also returned `HTTP=200`),
so it cannot classify the incident either. **No network cause is claimed.**

## Finding 3 — LSP reported an unavailable server with no stage and no cause

`get_hover` on `src/session-api/goal/index.ts` (`tool_call_id` `343233b8-194e-4874-a2b4-884e13dbce8e`,
24.3 ms, `status: ok`):

```text
(LSP server typescript unavailable; hint: npm i -g typescript typescript-language-server)
```

Server identity is present (`typescript`). Everything needed to act is absent: the failing stage (selection /
executable resolution / spawn-exit / initialization), the original cause, and the server's stderr. The hint
advertises a global npm install, which is not evidence the running harness can resolve that executable.

The companion call `find_symbol` returned `(LSP server does not implement workspace/symbol; use another tool
for this query)` — an unsupported-method capability result, correctly distinct from a startup failure. Both
arrive as `status: ok` tool results, so nothing in the trace marks either as an error.

## Finding 4 — the real-server probe is green while its assertions are advisory

Both probe runs today, with `typescript-language-server@5.3.0` and `pyright@1.1.414` present in the
worktree and both servers really started:

```
$ npm run probe:lsp -- --lang typescript
✓ lsp_definition (no client.ts)          <-- did not hit client.ts, still a pass
... all green (10/10)                     exit 0

$ npm run probe:lsp -- --lang python
- lsp_go_to_implementation (skipped: MethodNotFound sentinel — server 未实现该方法)
... all green (9/9)                       exit 0
```

Three live defects, all reproduced rather than inferred:

1. `lsp_definition` printed `no client.ts` and was still counted as a pass — its content check only
   annotates the verdict, it does not gate it.
2. The skipped operation was excluded from `total` (9, not 10). With every operation skipped the accounting
   is `0 === 0` and the probe exits 0 — a green run that exercised nothing.
3. The Python target is a single `probe.py` plus `pyrightconfig.json`: no `pyproject.toml`, no project
   `.venv`, and no second source file, so cross-file references cannot be exercised at all.

## What the reproduction changes

| Plan clause                                            | Status after reproduction                                                                                                                                                   |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pipeline must not imply recovery of an upstream status | Confirmed reachable in the real runtime (Finding 1). Settled contract stands: no global `pipefail`; the fix is truthful per-command evidence, not a shell-semantics change. |
| Failures must keep status, stderr, cause and cleanup   | Confirmed missing on the LSP surface (Finding 3) and unable to classify on the command surface (Finding 2).                                                                 |
| Real TS + Python operations with meaningful assertions | Not currently established (Finding 4): green with no assertion behind it.                                                                                                   |
| Unsupported methods are capability results             | Already satisfied, and observably distinct from startup failure.                                                                                                            |

T4/T5/T6 are therefore gated on real behavior gaps — verify-route stderr and session disposal, background
stderr, LSP stage/cause retention and install-to-retry recovery, probe assertion strength, and the total
memory OFF gate — not on an inferred network diagnosis.

## Follow-up findings recorded during implementation

These were measured while landing T5. They are recorded as explicit non-passes with reasons, not silently
skipped and not silently fixed.

**`lsp_diagnostics` returns empty for a file an earlier operation already opened and closed.** Measured:
hovering a symbol first and then requesting diagnostics on the same file yields an empty set; requesting
diagnostics first on that file yields a real diagnostic. Both TypeScript Language Server and Pyright publish
diagnostics on the first `didOpen` only. The probe therefore asserts diagnostics against a dedicated fixture
file. A product fix needs a pull-diagnostics fallback in the diagnostics handler, which changes that
handler's behavior for the whole suite and is outside this plan's scope.

**`stage` is optional on `LspClientFailure`.** Every failure the client pool produces carries a stage, but
`src/harness/aci/tools/symbol-mutate.ts` constructs a failure object directly and does not set one. Making
the field required needs that file in scope; today the field is optional and pinned by tests.
