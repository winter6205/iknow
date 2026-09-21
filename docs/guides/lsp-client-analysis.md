# LSP Client: Current State and Upgrade Analysis

> Scope: the headless agent LSP stack in the iknow harness
> (`src/harness/lsp/` + `aci/tools/symbol*.ts`).
> SSOT: `specs/251-lsp-tool.md`.
> **SSOT gap**: the source cites two deleted specs (`302-lsp-multilang`,
> `symbol-primary-aci`) in ~20 places. Their decisions — multilang dispatch and
> symbol-identity tooling — now survive only in code comments and this file.

## 1. Current state

### 1.1 Architecture

```
agent 符号工具（15 件）
  → aci/tools/symbol.ts（10 件查）+ symbol-mutate.ts（5 件改）
  → aci/tools/symbol-resolver.ts（符号身份 → 行列译码 + 内容指纹缓存）
  → lsp/client.ts（连接池、spawn、请求级打开窗口、诊断订阅）
  → vscode-jsonrpc（JSON-RPC 传输）
  → language server 子进程（stdio）
```

- **The model-facing surface is symbol identity, not coordinates**: tools take
  `{ file, symbol_path }`; row/column decoding lives in `symbol-resolver.ts`.
  The original 10 coordinate-face `lsp_*` tools were retired from the *model
  face*, but not from the codebase — `createLspToolSet`
  (`aci/tools/lsp.ts:857`) is the real-stack smoke-test instrument used by
  `scripts/lsp-probe.ts:266` (run via `npx tsx scripts/lsp-probe.ts`).
  Shared helpers (`getClientForWorkspaceDetailed` / `renderNoServer` /
  `stringifyResult` / `isLspFailureSentinel`, ...) are still imported by the
  live `symbol.ts` / `symbol-mutate.ts` / `symbol-resolver.ts`. The file is
  misnamed, not dead; deleting it would break the LSP probe.
  Caveat: the probe only calls `lsp_workspace_symbol({ file })` — always with
  `file` — so it never exercises the `find_symbol` branch without `file`; the
  probe matrix is not coverage for that path.
- **Transport**: `vscode-jsonrpc` (a runtime `dependency`).
- **Client logic**: a thin in-house wrapper (`client.ts`); no full LSP client
  SDK.
- **Adaptation layer**: per-language npm wrappers / PATH binaries; no
  hand-written tsserver bridge.

### 1.2 Dependencies

| Type       | Package                                     |
| ---------- | ------------------------------------------- |
| protocol   | `vscode-jsonrpc`                            |
| TS/JS      | `typescript-language-server` + `typescript` |
| Python     | `pyright`                                   |
| YAML       | `yaml-language-server`                      |
| JSON       | `vscode-json-languageserver`                |
| Dockerfile | `dockerfile-language-server-nodejs`         |

The `web/` subpackage has no LSP dependencies.

### 1.3 15 model-facing tools → the 10 methods actually sent

| tool                                               | method                      |
| -------------------------------------------------- | --------------------------- |
| `find_declaration`                                 | `textDocument/definition`   |
| `find_referencing_symbols`, `safe_delete_symbol`   | `textDocument/references`   |
| `find_implementations`                             | `textDocument/implementation` |
| `get_hover`                                        | `textDocument/hover`        |
| `get_symbols_overview`, `symbol-resolver`          | `textDocument/documentSymbol` |

| `prepare_call_hierarchy` | `textDocument/prepareCallHierarchy` |
| `list_incoming_calls` / `list_outgoing_calls` | `callHierarchy/{incoming,outgoing}Calls` |
| `find_symbol` | `workspace/symbol` |
| `rename_symbol` | `textDocument/rename` |
| `get_diagnostics_for_file` | `textDocument/publishDiagnostics` (push subscription, not a request) |
| `replace_symbol_body`, `insert_before_symbol`, `insert_after_symbol` | **no LSP method** — see §3.4 |

Plus the three text-sync notifications `didOpen` / `didChange` / `didClose`.

### 1.4 Capabilities in place

- Connection-pool trio: `(root, serverId)` cache / broken memory / in-flight
  dedup
- **Request-scoped document open**: `withDocumentOpen` opens on entry and closes
  on exit (including throw and timeout paths), with a refs count plus a `pinned`
  exception; tsserver builds no project for unopened files, so this is a
  *prerequisite* for project context, not an optimization (see the term entry in
  `docs/CONTEXT.md`)
- **Out-of-band change alignment**: `alignToDisk` compares mtime before each
  RPC and sends `didChange` only on a diff (`client.ts:560-580`, call site
  `:665`)
- **Child-process cleanup**: three reclamation seams (idle sweep / rebind
  stale sweep / `disposeAll`); `shutdownAll` always closes the connection then
  sends `SIGTERM` (`client.ts:187-197`)
- Server-capability snapshot + pruning that trusts **explicit `false` only**
  (see the deliberate rejection in §4)
- Push-diagnostics subscription with read-after-wait (catch up on `pushVersion`,
  2 s deadline by default)
- Warmup: spawns against real sample files and permanently pins a raw
  `ensureOpen` (`warmup.ts`)
- Worktree rebind: lazy sweep of stale-root clients when `directoryCell` flips
- Multilang dispatch: `resolveServer(file)` routes by extension, single hit
- Per-request timeout + abort bridging: always via `$/cancelRequest`, never by
  killing the server

### 1.5 Verification

```bash
npx tsx scripts/lsp-probe.ts                  # real-server smoke test (5 servers × fixtures)
npx tsx scripts/lsp-probe.ts --lang python
npm test                           # tests/harness/lsp/ + tests/harness/aci/lsp.test.ts
```

---

## 2. Design boundaries

The iknow LSP stack serves *in-loop agent symbol lookup, diagnostics, and
symbol-level edits* — it is not an editor integration:

- handlers return plain strings (contract Y1); no UI decoration
- single local project: `LspCtx.directory` + `NearestRoot` suffice; no
  multi-root workspace
- cancellation goes through `$/cancelRequest`; the normal path never kills the
  language-server child process
- failures and capability gaps surface as **layered sentinels** (plain strings
  with a bracketed reason), classified by `isLspFailureSentinel` /
  `isMethodNotFoundSentinel`; `scripts/lsp-probe.ts` uses exactly these
  predicates to decide FAIL vs skip

---

## 3. Known gaps

### 3.1 Capability gaps (ordered by agent value)

| gap | current state | impact |
| --- | ------------- | ------ |
| **`codeAction` + `workspace/executeCommand`** | absent (`executeCommand` appears nowhere in `src/`) | the agent sees diagnostics but **cannot make the server fix them**: no quick-fix, no auto-import, no organize-imports; every fix must be hand-assembled as text |
| **`prepareRename`** | absent; `rename_symbol` sends `textDocument/rename` directly | "can this position be renamed?" is only discovered by a failed request, with no clean pre-check |
| **`typeHierarchy/*`** | absent | the call graph exists (both directions), the type graph does not; `find_implementations` covers only half |
| **pull diagnostics** | `textDocument/diagnostic` is in the capability table but nobody sends it; push only | relies on "edit, wait for a re-push, deadline" — the complexity of `waitForDiagnostics` is the price |
| **`willRenameFiles` / `didRenameFiles`** | absent | moving/renaming a file leaves imports un-updated by the server |
| `completion` / `signatureHelp` / `formatting` / `codeLens` | absent | low agent value (see §5) |

### 3.2 Language coverage

Only 5 servers (`SERVERS` in `server.ts:376`); `resolveServer` matches the
extension with **a single hit, no union**:

- covered: `.ts .tsx .js .jsx .mjs .cjs .mts .cts` / `.py .pyi` / `.yaml .yml`
  / `.json` / `.dockerfile` `Dockerfile`
- not covered (all fall to the `(no LSP server configured…)` sentinel):
  `.go` `.rs` `.java` `.rb` `.php` `.c` `.cpp` `.cs` `.sh` `.css` `.html`
  `.md` `.toml` `.sql` …
- multiple servers for one extension (e.g. `.ts` served by both tsserver and
  Biome) are not supported

### 3.3 The `find_symbol` branch without `file`

When `file` is omitted the call goes through `getClientForWorkspaceDetailed`
(`lsp.ts:447-459`): a fake path `<directory>/iknow-workspace.ts` is used only
to spawn, then the request is sent **raw, without entering the request-scoped
open window** (`symbol.ts:354-356`).

**Root cause established by measurement** (closing this section's former open
question; the old attribution "nothing to open" has been disproven): the search
set of `workspace/symbol` is determined by the project of the anchor file
(tsserver builds only an inferred project for an anchor outside `include`);
without `file` there is no anchor, so coverage is not trustworthy. Full
mechanism, flip experiments and repro commands: §8. After the fix, an
anchor-less call returns a layered sentinel (`renderNoProjectAnchor`,
`lsp.ts`), and `[]` now means only "this symbol really does not exist".

**Coverage**: the sentinel contract plus the real no-symbol `[]` are pinned by
12 fake-client contract tests (`tests/harness/aci/lsp.test.ts`); real-tsserver
re-verification evidence is in §8.3 / §8.8.

### 3.4 Primitives the protocol itself lacks

`replace_symbol_body` / `insert_before_symbol` / `insert_after_symbol` **do not
use LSP `textDocument/*`** — `symbol-mutate.ts:519` states there is no
"replace body" primitive; the implementation computes text edits from
`documentSymbol` ranges. This is a protocol gap, not an implementation shortcut.

### 3.5 Structural leftovers

- **11 dead rows in `METHOD_CAPABILITY_KEYS`**: the table has 19 entries
  (`client.ts:789`) but only 8 are actually sent by tools (`definition` /
  `references` / `hover` / `documentSymbol` / `implementation` / `rename` /
  `prepareCallHierarchy` / `workspace/symbol`). Nobody sends `typeDefinition` /
  `declaration` / `signatureHelp` / `codeAction` / `foldingRange` /
  `selectionRange` / `documentHighlight` / `semanticTokens/full` / `inlayHint`
  / `inlineValue` / `diagnostic`. Dead rows are harmless (only consulted by
  `serverDeclaresUnsupported`) but misleadingly suggest the methods are wired.
- **`find_declaration` sends `definition`, not `declaration`**: the
  declaration-vs-definition distinction is folded away (visible differences in
  C++ headers, TS `declare` scenarios).
- **`aci/tools/lsp.ts` is a dead file with live functions**: see §1.1.
- **Full sync only**: `notifyChange` reads and sends the whole document on each
  `didChange`; no incremental sync.
- **Payloads are stringified verbatim**: `Location` / `LocationLink` shapes
  differ, and 0-based server line numbers coexist with 1-based tool inputs.
  The symbol-identity face removes most of the friction (the model no longer
  fills coordinates), but the returned value is still the server's raw
  structure.

---

## 4. Closed gaps (do not re-propose)

These were once listed as gaps and have since landed — older versions of this
file still described them as missing:

| formerly missing | current state |
| ---------------- | ------------- |
| `initialize` sent empty capabilities and ignored the server's reply | non-empty advertised capabilities, snapshot stored (`client.ts:467-478`) |
| no `didClose`, `openedUris` only grew | request-scoped open windows; close on exit + refs count |
| rebind / idle left child processes alive | all three reclamation seams send `SIGTERM` (`client.ts:187-197`) |
| out-of-band changes not synced | `alignToDisk` mtime comparison before each RPC |

**Deliberately rejected**: "prune tool registration / descriptions by declared
server capabilities" — typescript-language-server measurably does **not**
declare `callHierarchyProvider` yet implements call hierarchy; pruning on
declarations would wrongly strip TS's fidelity surface. The standing rule is
**absence ≠ unsupported; only explicit `false` counts**, and capability gaps
are discovered at runtime via `-32601` → method-not-found sentinel
(`client.ts:811-825`).

---

## 5. Out of scope

- adopting a full LSP client SDK (its document model and middleware conflict
  with the harness seam)
- `completion` / `signatureHelp`: the agent does not type character by
  character; low value
- semantic tokens / inlay hints / codeLens: presentation for humans; low value
  for an LLM
- on-type formatting; formatting stays with the project's own prettier / eslint
- a full `didChangeWatchedFiles` watcher (`alignToDisk`'s mtime comparison is
  usually enough)

> Note: early versions also listed **rename** here (rationale: "`edit_file`
> already covers the write path"). That call was reversed — `rename_symbol`
> sends `textDocument/rename` and lets the server compute the cross-file
> `WorkspaceEdit`, a capability `edit_file` cannot replace.

---

## 6. Related paths

| path | role |
| ---- | ---- |
| `src/harness/lsp/client.ts` | connection pool, spawn, request-scoped open windows, mtime alignment, diagnostics subscription, child-process cleanup |
| `src/harness/lsp/server.ts` | 5 language-server declarations + `NearestRoot` + `resolveServer` |
| `src/harness/lsp/language.ts` | language detection |
| `src/harness/lsp/notifier.ts` | invalidate after edit |
| `src/harness/lsp/warmup.ts` | post-assembly warmup (real samples + pinned open) |
| `src/harness/aci/tools/symbol.ts` | the 10 lookup tools (model face) |
| `src/harness/aci/tools/symbol-mutate.ts` | the 5 mutation tools (model face, category=write) |
| `src/harness/aci/tools/symbol-resolver.ts` | symbol identity → row/column decoding + content-fingerprint cache |
| `src/harness/aci/tools/lsp.ts` | the retired coordinate-face 10 tools + still-used shared helpers (sentinels / stringify / workspace client) |
| `scripts/lsp-probe.ts` | real-server smoke test |

---

## 7. Probe matrix (measured)

**Definition: "a language is supported" = it has a row in this matrix.** A row
stands only on probe runs, never on capability declarations (the deliberate
rejection in §4 applies).

`npx tsx scripts/lsp-probe.ts [--lang <lang>]` is the only LSP
measurement surface that walks the **real stack**: production
`createLspToolSet` (`aci/tools/lsp.ts:857`, see §1.1) → `lsp/client.ts` → a
spawned real language-server child process. `--lang` accepts the keys of
`PROBE_TARGETS` (`scripts/lsp-probe-targets.ts`): typescript / python / yaml /
json / dockerfile.

### 7.1 Coordinate-face scope (read before citing this matrix)

This matrix measures the **coordinate face** `lsp_*`. The probe calls
`lsp_workspace_symbol({ file: target })` (`scripts/lsp-probe.ts:319-321`) —
**always with `file`**.

It does **not** cover the `find_symbol` branch without `file`: that path goes
through `getClientForWorkspaceDetailed` (`aci/tools/lsp.ts:447`), uses the fake
path `<directory>/iknow-workspace.<ext>` only to spawn, then sends the request
raw without entering the request-scoped open window (`symbol.ts:354-356`). The
probe never calls `find_symbol` and never enters that branch.

**Do not cite this matrix as coverage of the anchor-less `find_symbol`
path** — it measures only the coordinate face `lsp_*`; the root cause and
contract for the anchor-less `find_symbol` branch are in §8 and §3.3.

### 7.2 Verdict vocabulary

The probe has three verdicts (`ProbeVerdict`, `scripts/lsp-probe.ts:141-145`):

| verdict | output marker                | meaning                                              |
| ------- | ---------------------------- | ---------------------------------------------------- |
| pass    | `✓ <op>`                     | returned a non-empty plain string, not any failure sentinel |
| skip    | `- <op> (skipped: <reason>)` | the server does not implement the method (MethodNotFound); **not counted in total** |
| fail    | `✗ <op> (<detail>)`          | empty return / non-string / failure sentinel / other RPC error |

- **skips carry no score**: `passed === total` is decided over ops **actually
  checked**; a capability-gap op neither passes nor loses a point
  (`scripts/lsp-probe.ts:195-198`).
- Hence **`all green` ≠ the server implements every method**: in the table
  below only 3 ops were truly checked for json. Reading `all green` must come
  with reading `(passed/total)`.
- **A failure sentinel is FAIL, not skip**: spawn failure / no server / no root
  route through `isLspFailureSentinel` (`scripts/lsp-probe.ts:176-178`) and
  print `✗`.
- Exit code: `passed === total ? 0 : 1` (`scripts/lsp-probe.ts:379`). All 5
  languages in this run exited **0**.

### 7.3 Matrix (run 2026-09-16)

The `lsp_` prefix is omitted in the header; column names are the probe's op
names. `passed/total` is the probe's last line `all green (passed/total)`.

| language   | serverId                            | definition            | references            | hover | document_symbol | workspace_symbol      | go_to_implementation  | prepare_call_hierarchy | incoming_calls        | outgoing_calls        | diagnostics | passed/total |
| ---------- | ----------------------------------- | --------------------- | --------------------- | ----- | --------------- | --------------------- | --------------------- | ---------------------- | --------------------- | --------------------- | ----------- | ------------ |
| typescript | `typescript`                        | ✓                     | ✓                     | ✓     | ✓               | ✓                     | ✓                     | ✓                      | ✓                     | ✓                     | ✓           | 10/10        |
| python     | `pyright`                           | ✓                     | ✓                     | ✓     | ✓               | ✓                     | skip (MethodNotFound) | ✓                      | ✓                     | ✓                     | ✓           | 9/9          |
| yaml       | `yaml-language-server`              | ✓                     | skip (MethodNotFound) | ✓     | ✓               | skip (MethodNotFound) | skip (MethodNotFound) | skip (MethodNotFound)  | skip (MethodNotFound) | skip (MethodNotFound) | ✓           | 4/4          |
| json       | `json-language-server`              | skip (MethodNotFound) | skip (MethodNotFound) | ✓     | ✓               | skip (MethodNotFound) | skip (MethodNotFound) | skip (MethodNotFound)  | skip (MethodNotFound) | skip (MethodNotFound) | ✓           | 3/3          |
| dockerfile | `dockerfile-language-server-nodejs` | ✓                     | skip (MethodNotFound) | ✓     | ✓               | skip (MethodNotFound) | skip (MethodNotFound) | skip (MethodNotFound)  | skip (MethodNotFound) | skip (MethodNotFound) | ✓           | 4/4          |

**Across the table: 0 FAIL cells, 0 untested cells.** Every skip has exactly
one cause — MethodNotFound, the probe's own wording:

```
MethodNotFound sentinel — server 未实现该方法
```

Skip details (matrix column → the LSP method the probe actually sent):

| serverId                            | skipped ops                                                                                                                                          | corresponding method                                                                                                                                            |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typescript`                        | none                                                                                                                                                 | —                                                                                                                                                               |
| `pyright`                           | `lsp_go_to_implementation`                                                                                                                          | `textDocument/implementation`                                                                                                                                   |
| `yaml-language-server`              | `lsp_references` / `lsp_workspace_symbol` / `lsp_go_to_implementation` / `lsp_prepare_call_hierarchy` / `lsp_incoming_calls` / `lsp_outgoing_calls` | `textDocument/references` / `workspace/symbol` / `textDocument/implementation` / `textDocument/prepareCallHierarchy` / `callHierarchy/{incoming,outgoing}Calls` |
| `json-language-server`              | the same six as yaml + `lsp_definition`                                                                                                              | the same six as yaml + `textDocument/definition`                                                                                                                |
| `dockerfile-language-server-nodejs` | the same six as `yaml-language-server`                                                                                                               | same as the yaml row                                                                                                                                            |

Matrix column → method, full table:

| op                           | method                                                |
| ---------------------------- | ----------------------------------------------------- |
| `lsp_definition`             | `textDocument/definition`                             |
| `lsp_references`             | `textDocument/references`                             |
| `lsp_hover`                  | `textDocument/hover`                                  |
| `lsp_document_symbol`        | `textDocument/documentSymbol`                         |
| `lsp_workspace_symbol`       | `workspace/symbol`                                    |
| `lsp_go_to_implementation`   | `textDocument/implementation`                         |
| `lsp_prepare_call_hierarchy` | `textDocument/prepareCallHierarchy`                   |
| `lsp_incoming_calls`         | `callHierarchy/incomingCalls`                         |
| `lsp_outgoing_calls`         | `callHierarchy/outgoingCalls`                         |
| `lsp_diagnostics`            | `textDocument/publishDiagnostics` (push subscription, not a request) |

### 7.4 Fixtures and root markers

| --lang     | target file                                                  | kind             | root marker                                                |
| ---------- | ------------------------------------------------------------ | ---------------- | ---------------------------------------------------------- |
| typescript | `src/harness/lsp/client.ts` (line 94, char 22)               | real repo file   | `package-lock.json` (`TS_LOCKFILES`, `server.ts:157-163`)  |
| json       | `tsconfig.json` (line 2, char 1)                             | real repo file   | none (`JsonLS.root = ctx.directory`, `server.ts:323`)      |
| python     | `.iknow/probe-lsp/python/probe.py` (line 1, char 4)          | generated fixture | `pyrightconfig.json` (`ProbeTarget.rootMarkers`)          |
| yaml       | `.iknow/probe-lsp/yaml/probe.yml` (line 5, char 9)           | generated fixture | none (`YamlLS.root = ctx.directory`, `server.ts:295`)     |
| dockerfile | `.iknow/probe-lsp/dockerfile/Dockerfile` (line 1, char 5)    | generated fixture | none (`DockerfileLS.root = ctx.directory`, `server.ts:354`) |

Fixtures are always written under `.iknow/probe-lsp/<lang>/` (`.iknow/*` is
gitignored), never at the repo root, so they cannot be mistaken for real
deployment files. Why these three languages must use fixtures (the rationale
formerly lived only in fixture comments):

- **python**: the repo root carries no root marker pyright recognizes (no
  `pyproject.toml` / `setup.py` / `setup.cfg` / `requirements.txt` / `Pipfile`
  / `pyrightconfig.json` — only `package-lock.json`, a TS marker). The fixture
  directory ships its own `pyrightconfig.json` so `NearestRoot` hits
  immediately.
- **yaml**: on the real target `.github/workflows/*.yml`, yaml-language-server's
  definition / hover **measured empty** (no anchors). The fixture rewrites the
  source with a YAML anchor `&defaults`; definition on the `*defaults` alias
  measures non-empty (jumping to the anchor definition).
- **dockerfile**: the repo has no `Dockerfile` at all. The fixture also encodes
  a measured finding: this server returns **`null`** for definition on a `FROM`
  image name / an `ARG` reference site; but definition on the **variable name**
  of `ARG NAME=value` (`BASE_VERSION`, line 1 char 4-16) returns non-empty
  (self-referential range), and hover returns the value (`{"contents":"20"}`).
  The fixture therefore carries an `ARG` reference plus a variable-name target
  so definition / hover have real non-empty returns. This server declares no
  provider for references / implementation / workspaceSymbol / callHierarchy
  (the source of the six skips in the table above).

### 7.5 Reproduction environment

This run (the source of every number in the matrix):

```bash
git rev-parse --short HEAD   # 21bd5805 (feat/lsp-silent-degradation)
node -v                      # v22.23.2
npx tsx --version            # tsx v4.23.0

npx tsx scripts/lsp-probe.ts                          # typescript baseline
npx tsx scripts/lsp-probe.ts --lang python
npx tsx scripts/lsp-probe.ts --lang yaml
npx tsx scripts/lsp-probe.ts --lang json
npx tsx scripts/lsp-probe.ts --lang dockerfile
```

All 5 server packages were present in `node_modules` and resolved at step 1 of
`resolveNpmBin` (`createRequire`, same-source resolution); the PATH `which`
fallback was never used:

| serverId                            | package                               | measured version | bin name                   |
| ----------------------------------- | ----------------------------------- | -------- | ---------------------------- |
| `typescript`                        | `typescript-language-server`        | 5.3.0    | `typescript-language-server` |
| `pyright`                           | `pyright`                           | 1.1.411  | `pyright-langserver`         |
| `yaml-language-server`              | `yaml-language-server`              | 1.24.0   | `yaml-language-server`       |
| `json-language-server`              | `vscode-json-languageserver`        | 1.3.4    | `vscode-json-languageserver` |
| `dockerfile-language-server-nodejs` | `dockerfile-language-server-nodejs` | 0.15.0   | `docker-langserver`          |

### 7.6 Recording convention for untested cells

**This run had 0 untested cells**: all 5 server binaries were in place, all
were run, and the matrix above is that measured output.

When a binary is missing: the probe prints `✗ <op> (LSP server unavailable)`,
counted as FAIL with exit code 1 (spawn failure yields `renderNoServer`'s
spawn-failed sentinel, recognized by `isLspFailureSentinel`,
`scripts/lsp-probe.ts:176-178`). **In that case the document records the cell
as "untested", never as "the server does not support that method"**, and lists
the missing package plus `SERVERS.installHint`
(`server.ts:216/259/294/322/353`):

| serverId                            | installHint                                      |
| ----------------------------------- | ------------------------------------------------ |
| `typescript`                        | `npm i -g typescript typescript-language-server` |
| `pyright`                           | `npm i -g pyright`                               |
| `yaml-language-server`              | `npm i -g yaml-language-server`                  |
| `json-language-server`              | `npm i -g vscode-langservers-extracted`          |
| `dockerfile-language-server-nodejs` | `npm i -g dockerfile-language-server-nodejs`     |

---

## 8. `find_symbol` without `file`: root cause (measured)

This section closes the "root cause not yet established" open question from §3.3.
Every conclusion was re-derived in this worktree against a **real tsserver**
(`typescript-language-server` 5.3.0 + `typescript` 5.9.3) — no mocks, no stubs.
Anything that is an inference is explicitly marked as such.

**One-line conclusion**: `find_symbol` without `file` returning `[]` is not
"nothing to open". The **search set of `workspace/symbol` is not the workspace** —
it is the **project graph** tsserver currently has loaded, and that graph is
decided by the file the LSP `file:` anchor points at. An out-of-project anchor
leaves the graph empty, observable as `[]` / `No Project.` / fewer hits than
reality; an anchor inside the tsconfig `include` builds the right graph and the
results are trustworthy.

### 8.1 Prior attributions this round refutes

| Prior claim                                   | Measured                                                                                                                                                                                   |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lsp.ts:495` comment / §3.3: empty result blamed on "no file to open"  | The attribution is wrong. A file **was** open (warmup's bare `ensureOpen`) and the query still returned `[]` — even **right after returning hits** (§8.4 flip). The deciding factor is the **project** owning the anchor file, not "was any file ever opened" |
| Earlier claim: after `ensureOpen(registry.ts)` the same query returned 3 hits and stayed stable | Reproduced, but the real numbers are **4 hits / 3 files**, and the result **falls back to 0–1 hits after 6–8 s**. That observation landed inside a project-rebuild **transient window** (§8.4) |
| Earlier claim: waiting 10 s never changes `[]`         | True for this worktree's **production anchor scenario** (`0` throughout the 40 s window in §8.3), but **not generalizable**: with an in-project anchor, `0` becomes `4` within 10 s (§8.2 anchor A) |

### 8.2 Mechanism

The `workspace/symbol` implementation in `typescript-language-server`
(`node_modules/typescript-language-server/lib/cli.mjs:24650-24660`, read directly):

```js
async workspaceSymbol(params, token) {
  const response = await this.tsClient.execute(CommandTypes.Navto, {
    file: this.tsClient.lastFileOrDummy(),   // ← 搜索集合的锚点
    searchValue: params.query
  }, token);
```

- `lastFileOrDummy()` (`cli.mjs:19819`) = `this.documents.files[0]`, i.e. the
  **most recently touched open document at the LSP layer** (`didOpen` does
  `_files.unshift`, `didChange` unshifts again, `didClose` splices it out;
  `cli.mjs:17713/17740/17755`). When every document is closed it falls back to
  the workspace-folder path (= this client's `rootUri` = the pool key's root).
- On the tsserver side, `navto` (`typescript.js:194428` →
  `IpcIOSession.getNavigateToItems` → `getFullNavigateToItems`, `194322`): when
  **`file` is present** it searches **only the project owning that file**
  (`getProjects(args)`); only when **`file` is absent** does `forEachEnabledProject`
  search all projects. `No Project.` is thrown by `ThrowNoProject`
  (`typescript.js:186170`) when `getProjects(file)` finds no project at all.

**Anchor → project mapping** (measured, not read-code inference): an anchor
inside the tsconfig `include` makes tsserver load that tsconfig project, and the
search set = the entire tsconfig program; an anchor **outside** the `include`
makes tsserver load an inferred project for it, and an inferred project
**contains only that file plus its import closure** — it never scans a
directory.

**Measured contrast (same repo, only the anchor file changes)**: A =
`src/harness/aci/tools/symbol.ts` (inside `include`), B =
`archive/onetime-probes/closed-world-inventory-probe.ts` (outside `include`):

| Query                                                 | Anchor A (in `include`)             | Anchor B (out of `include`) |
| ----------------------------------------------------- | ----------------------- | -------------------------- |
| `createAciRegistry` (`src/`, never opened)            | `4` hits (stable after ~7 s)        | `0` (stable across 40 s)   |
| `createSymbolQueryToolSetForTest` (`tests/`, never opened) | `0` (stable for 30 s+)         | —                          |

The `tests/` row is a second measurement: `tsconfig.json:26` sets `include` to
`["src/**/*.ts", "src/**/*.tsx"]` and `tests/` is in `exclude`
(`tsconfig.json:27`), so the symbol is unreachable **even under the right
project** — proof that the search boundary is the tsconfig program, not the
directory tree.

### 8.3 Production shape: this worktree returns `[]` throughout, measured

With `ctx.directory = <repo root>` (the production shape), through the real
`startLspWarmup` + `find_symbol`:

```text
[lsp-warmup] partial: pyright: no client available
warmup status=partial pinned=["typescript:archive/onetime-probes/closed-world-inventory-probe.ts","json-language-server:package-lock.json"]
pool keys after warmup   = ["<ROOT>:typescript","<ROOT>:json-language-server"]
pool keys after no-file = ["<ROOT>:typescript","<ROOT>:json-language-server"]
0s=0 2.8s=0 4.8s=0 6.8s=0 9.0s=0 11.1s=0 ... 38s=0 40s=0   （20 次采样，40 s 窗口）
```

The mechanism chain (every link measured):

1. Warmup scans the directory to **recursive depth 2 and pins the first file
   whose extension matches** (`warmup.ts:107-124`). In this repo's root
   `readdir` order the first `.ts` is `archive/onetime-probes/...` (measured
   scan order: `.env.example, .git, .gitignore, ...,
archive/onetime-probes/closed-world-inventory-probe.ts`) — a file under
   `archive/`, **outside the tsconfig `include`** (`tsconfig.json:26`).
2. `find_symbol` without `file` → `getClientForWorkspaceDetailed` derives
   server/root from the synthetic path `<ctx.directory>/iknow-workspace.ts`
   (`lsp.ts:447-459`). The synthetic path sits at the repo root, `NearestRoot`
   hits the root's `package-lock.json` → **root = ctx.directory, pool key =
   `<ROOT>:typescript`, the same tsserver process warmup used** (same pid,
   measured).
3. When the first query arrives, `lastFileOrDummy()` = the archive file warmup
   pinned → empty inferred project → `[]`; tsserver caches that inferred
   project, so every later query keeps returning `[]`.
4. **Nothing under this repo's `src/` is ever pinned** (warmup pins only its
   first sample; the request-scoped `withDocumentOpen` window sends `didClose`
   on exit, removing the src file from `_files`, so `_files[0]` falls back to
   warmup's archive pin — measured: with no warmup `_files` is empty,
   `lastFileOrDummy()` falls back to the workspace-folder path, and the query
   throws `No Project.` outright). The right project therefore never gets
   built.

**This is not "warmup silently failed"**: `getWarmupOutcome()` measured as
`partial` / non-empty `pinned` / `failures` containing only the unrelated
`pyright: no client available`. Warmup ran successfully — it just
**picked the wrong sample**.

### 8.4 Worse: even a correct anchor can **flip back** to `[]`

Opening a second document on the same client changes `_files[0]`, and with it
the search set. Measured in two arms (wait 9 s after the first open, then open
the second):

```text
archive(9s) -> src     : 10.7s=4 12.8s=4 14.8s=0 16.9s=0 ... 33.0s=0     （先给结果，再清空）
src(9s)     -> archive :  9.3s=0 11.5s=0 14.0s=4 16.1s=4 ... 32.6s=4     （先空，后给结果）
```

Within the same arm, `No Project.` ⇄ `[]` ⇄ changing hit counts were all
observed (1 s after a scoped window closes it throws `No Project.`; 5 s later
the same query returns a different anomaly carrying the `<semantic>` prefix).
**Inference (marked as inference, not directly measured)**: when tsserver
switches between inferred projects it unloads/rebuilds projects, and during
the rebuild window `navto` can land on a half-built state — exactly the shape
"4 hits first, then 0 two seconds later". This transient was not verified
line-by-line against `getProjects`' project-selection rules, so it stays an
inference.

**What this means for the fix task**: even if a fix turns "no anchor" into a
typed failure, **a non-empty result still does not mean a complete result**,
and **an empty result may be merely transient under any anchor**.

### 8.5 Verdicts on the candidate mechanisms

| #   | Candidate                                      | Verdict                                          | Decisive evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | --------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | warmup failed silently                             | **RULED OUT** (not a cause on its own)                          | Measured `getWarmupOutcome()`: `status=partial`, non-empty `pinnedSamples`, `failures` only pyright. Warmup ran successfully. But it **picked the wrong sample** (pinned the first hit outside the tsconfig `include`) — that half shares a root with (d)                                                                                                                                                                                                                                                                   |
| b   | pool-key mismatch                                  | **RULED OUT** (production shape); **REACHABLE** (general shape) | Production shape measured: warmup pin and the synthetic-path dispatch share a pid, and the pool has a single `typescript` key (§8.3). The general shape is constructible: with nested lockfiles, warmup's sample root ≠ the synthetic-path root, producing 2 keys and 2 tsserver processes, and warmup's pin is **completely invisible** to the no-`file` path (`<ROOT>/sub:typescript` vs `<ROOT>:typescript`, measured). Not triggered in this repo                                                                                                                                           |
| c   | `ctx.directory` not the repo root                  | **RULED OUT** (production path)                            | `build-engine.ts:620-632`: non-ask surfaces take `mcpRoots.workspaceRoot`; `resolveWorkspaceRoot` is a three-step chain `[opts.workspaceRoot, env IKNOW_WORKSPACE_ROOT, cwd]` (`config/workspace-root.ts:151-171`) that returns a subdirectory unvalidated — theoretically reachable when a user starts a session from a subdirectory, not triggered in this repo. Related fact: in worktree scenarios `ctx.directory` = the worktree (ADR-0019), which equals "the repo root in the user's mind"                                                                                                   |
| c′  | **workspace-level dispatch lands on a non-target server** | **ESTABLISHED** (general shape)                          | When the directory has `.ts` files but **no TS root marker**, typescript / pyright each return `no-root` (measured), and the third declared server `yaml-language-server` (`root = ctx.directory`) **becomes the live client**; `find_symbol` then returns the **missing-method sentinel** `(LSP server does not implement workspace/symbol; use another tool for this query)`. What the model reads is "use another tool"; the truth is "TS was never asked" — a **misleading signal**. Measured `process.spawnargs[0]` = `node_modules/yaml-language-server/bin/yaml-language-server` |
| d   | `workspace/symbol` / tsserver behavior itself      | **ESTABLISHED** (primary cause)                              | §8.2–8.4: the search set = the project owning the file pointed to by `lastFileOrDummy()`; an inferred project contains only that file + its import closure; a tsconfig project is bounded by `include`; switching anchors triggers project rebuilds and the observed hits → none flip                                                                                                                                                                                                                                                               |

### 8.6 Is the no-`file` path salvageable? — Yes, provided the **anchor lands inside the target project's tsconfig `include`**

- **Salvageable** (measured): point the anchor at any file under `src/` and the
  same query on the same client goes from `0` to `4` within ~7 s, stable for
  30 s+ (§8.2 anchor A).
- **Where it fails**: a caller without `file` **has no way to know** which file
  to pick. Warmup's current strategy is "first extension match in `readdir`
  order" — measured to be exactly the wrong pick (`archive/`).
- **So the fix task should not go down the "make warmup pick smarter" road**
  (that is guessing the project layout). Only two fix families are viable:
  **(i) make result trustworthiness part of the return value** (sentinel /
  warning), **(ii) require a `file` anchor** (prompt / description side). They
  are not mutually exclusive.

### 8.7 Sentinel wording draft (for the fix task to consume)

The decision semantics of the three existing prefixes (`lsp.ts:181-239`):

| Prefix                               | Meaning                  | `isLspFailureSentinel` | probe verdict |
| ------------------------------------ | ------------------------- | ---------------------- | ------------- |
| `(no LSP server configured`          | no matching server        | true (FAIL)            | fail          |
| `(no LSP project root found`         | server exists, no root marker | true (FAIL)        | fail          |
| `(LSP server … unavailable`          | spawn failed / bin missing | true (FAIL)           | fail          |
| `(LSP server … does not implement …` | server capability gap     | **false** (skip)       | skip          |

**Decision: do not add a fourth prefix branch to the family.** Rationale:

1. The three prefixes mean "**this call never landed**". `find_symbol` without
   `file` returning `[]` or a transient — **the call landed**, the RPC got a
   response. Recording that as probe FAIL would log `workspace/symbol` as
   server-unavailable, i.e. a **misclassification** (the probe's FAIL semantics
   are `LSP server unavailable`, see `scripts/lsp-probe.ts:176-178`).
2. The probe **never calls** `find_symbol` and **never enters** this branch
   (already fixed in §7.1). A new prefix would be dead logic on the probe
   side — zero benefit.
3. The consumer of this information is **the model**, not the probe: what the
   model needs is "the conclusion is not trustworthy, take another route", not
   "LSP is broken". Keeping `isLspFailureSentinel` false means the model is
   neither misled into "LSP unavailable" nor blocked from judging later symbol
   tools usable.
4. Zero coupling with the existing predicates: the new wording contains
   neither `" does not implement "` (so `isMethodNotFoundSentinel` cannot
   capture it) nor `" unavailable"`, and does not start with the other two
   prefixes (so `isLspFailureSentinel` cannot either). **No predicate changes
   needed.**

**The exact strings the fix should return (two; pick by reachable state):**

1. No project anchor (`No Project.` / empty return / RPC anomaly — the model
   cannot act on the result):

```text
(LSP workspace/symbol has no project anchor under <ctx.directory>; an empty result from this path is not trustworthy — pass file=<a file inside the project to search> or use get_symbols_overview on a known file)
```

2. Results present but coverage not guaranteed (normal return, including an
   empty array):

```text
(LSP workspace/symbol coverage is not authoritative: the server only has the documents it was asked to open; pass file=<a file inside the project to search> to anchor the search, or use get_symbols_overview on a known file)
```

Both start with `(LSP `, consistent with the family's style; measured
`isLspFailureSentinel=false`, `isMethodNotFoundSentinel=false`,
`classifyProbeResult → pass` — **by design they are never downgraded to
FAIL / skip**.

**If the fix task opts for only string 1 (lower noise)**, string 2 gets demoted
to `find_symbol`'s description text (a model-visible assembly surface → follow
the golden set in `docs/guides/prompt-development.md`), and the sentinel
family still gains **no new branch**.

### 8.8 Reproduction environment and commands

```bash
git rev-parse --short HEAD        # 21bd5805 = 测量时的基线；此后 T1/T4/T5 已并入
                                  #   （a7badf7b / 835498c6 / f5506090）。本节所有
                                  #   行号已对照并入后的 HEAD 复核
node -v                           # v22.23.2
npx tsx --version                 # tsx v4.23.0
# typescript 5.9.3 / typescript-language-server 5.3.0（node_modules 实测版本）
```

Every experiment ran the real stack directly via `npx tsx -e '<script>'`
(`createSymbolQueryToolSet` + real `getClient` / `startLspWarmup`); fixtures
live in `.iknow/t2-fixtures/<case>/` (gitignored). The two-step reproduction
core: pin a file outside the tsconfig `include` →
`find_symbol({ query: "<a symbol in src>" })` observes `[]`; move the anchor to
a file inside `include` → the same query produces hits within ~7 s.

### 8.9 What remains unestablished (recorded as-is)

1. **Project-selection rules not verified line-by-line.** "An inferred project
   contains only the pinned file + its import closure" and "project switching
   triggers unload/rebuild" are a model inferred from behavioral observation +
   the `getProjects(args)` call in `getFullNavigateToItems`. The priority
   scoring inside `getProjects` was not read line-by-line, so the transient
   cause in §8.4 stays marked as **inference**.
2. **No trustworthy threshold for first-query latency.** ~7 s is a single
   observation on this machine (WSL2), with tsserver still loading in the
   background; no cross-machine or cold/hot-disk comparison was done, so no
   wait policy can be derived from it.
3. **The full state machine between `No Project.` and `[]` was not
   exhausted.** Observed so far: throwing `No Project.` (both `<syntax>` and
   `<semantic>` prefixes), returning `[]`, returning partial hits, hit counts
   decaying. Which condition combinations produce which outcome — the matrix
   was not run.
4. **Multi-language server behavior untested.** The anchor mechanism in §8.2
   holds for `typescript-language-server` + tsserver only. The
   `workspace/symbol` anchor semantics of pyright / yaml / json / dockerfile
   (most return MethodNotFound directly) were not tested individually.
