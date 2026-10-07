# Spec: 251-lsp-tool — ACI LSP tools (code navigation · TS + Python (Pyright) · self-built client)

> Input = [map #245 Decisions so far](https://github.com/winter6205/iknow/issues/245) (#246/#247/#248/#249/#250 already closed) + #251 (this ticket) review decisions.
> Scope = add 10 LSP tools to the ACI tool layer (9 operation + `lsp_diagnostics`), self-built LSP client, TypeScript **and** Python (Pyright) both required against real servers (amended 2026-10-07 by `docs/implementation-plans/runtime-capability-recovery.md` T2; Python is not a later phase).
> Delivery = spec → ACR → writing-plans; this spec contains no implementation code.

## Objective

Add **ACI LSP tools (code navigation)** to the iknow harness so the agent can do symbol lookup inside the loop. This is the LSP branch of map #220 "first batch of new tools after the 8", and the **first real tenants** after the spec 224 extension pathway (tool_search/lazy/discover) is implemented.

**Users**: iknow is a single-user, single-project, local product; the four entry points CLI `chat` / `ask` / TUI / `serve` share one ACI registry (`build-engine.ts` SSOT).

**What to build**:

1. **Self-built LSP client** — new directory `src/harness/lsp/`, TypeScript + Python (Pyright); both languages are required and each is proven against a real server.
2. **LSP tools append** (11 → 21 ACI tools, 10 new):
   - 9 operation tools: `lsp_definition` / `lsp_references` / `lsp_hover` / `lsp_document_symbol` / `lsp_workspace_symbol` / `lsp_go_to_implementation` / `lsp_prepare_call_hierarchy` / `lsp_incoming_calls` / `lsp_outgoing_calls` (#248 tier-B decision; shared position schema)
   - `lsp_diagnostics` as an independent top-level tool (#250 decision, not among the 9)
   - > **Count correction (confirmed at implementation, 2026-08-08)**: early drafts wrote "9 = 8 operation + lsp_diagnostics" and "11 → 20", but the operation list actually enumerated 9 names. Implementation exports all 9 operation + lsp_diagnostics = 10 tools per the list, total 11 → 21. S1/S4/S5/Glossary/ADR-0004 references are synced to 9 operation tools / 21 total.
3. **Engine-internal linkage**: after `edit_file` succeeds, automatically send invalidation to tsserver; the agent need not be aware (Q2 decision).

**Success shape**: the agent can do symbol lookup on TS/JS and Python files inside the loop (go-to-definition / find references / hover / outline / implementation / call graph / diagnostics pull), tsserver stays resident and is reused to eliminate cold start, `permission/` has zero changes, and all 9 tools follow contracts X/Y1.

## Tech Stack

| Item                  | Value                                           | Notes                                                                                                                                       |
| --------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Language              | TypeScript (consistent with harness, 5.x ESM)   | —                                                                                                                                           |
| Runtime               | Node.js                                         | —                                                                                                                                           |
| LSP client substrate  | `vscode-jsonrpc` (`node` entry)                 | **New dependency**; provides requestId/response-routing/cancel protocol layer (Q1/Q3 decisions)                                             |
| LSP translation layer | `typescript-language-server`                    | **New dependency** (project devDependencies); keep translation layer + `tsserver.path` localization (#247 Q1 REJECT of hand-written bridge) |
| TS kernel             | `typescript` (already depended on, 5.9.3)       | tsserver = `typescript/lib/tsserver.js` (zero extra dep)                                                                                    |
| Process management    | `child_process.spawn`                           | standard library                                                                                                                            |
| Testing               | vitest                                          | `npm test`                                                                                                                                  |
| New dependencies      | `vscode-jsonrpc` + `typescript-language-server` | core LSP-path dependencies, **exempt from** spec 224's zero-new-dependency gate (#251 ticket's Ask first already lists them)                |

## Commands

```bash
# Build
npm run typecheck       # type check of entry files

# Test (main product path)
npm test                # vitest: unit + harness + integration

# Lint
npm run lint            # project-root lint entry

# LSP probe (real language servers — TypeScript AND Python are both required)
npm run probe:lsp -- --lang typescript   # scripted spawn of the real TypeScript Language Server + 9-operation smoke test
npm run probe:lsp -- --lang python       # real Pyright against a project pyproject.toml + project .venv, at least two related source files
```

## Project Structure

New / changed points:

| Path                                   | Form          | Role                                                                                                                                                                                                                                                                                                              |
| -------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/harness/lsp/`                     | **New dir**   | LSP client layer                                                                                                                                                                                                                                                                                                  |
| `src/harness/lsp/server.ts`            | **New**       | LSP server declaration (`Info` type, one entry per language — TypeScript + Python/Pyright included: `id`/`extensions`/`root`/`spawn`), keeping the flat structure (#247 Q2 decision: no split); `NearestRoot` (#247 Q6 decision: keep; TS lockfile pattern + deno.json exclude, upper bound stop=`ctx.directory`) |
| `src/harness/lsp/client.ts`            | **New**       | JSON-RPC over stdio (`vscode-jsonrpc/node`); `getClient(root,id)` with the caching + broken + inflight triple (Q1/Q8 decisions)                                                                                                                                                                                   |
| `src/harness/lsp/notifier.ts`          | **New**       | edit_file linkage: `invalidate(file)` sends `workspace/xrefs` to tsserver (Q2/A13 decision)                                                                                                                                                                                                                       |
| `src/harness/aci/tools/lsp.ts`         | **New**       | factory for the 10 LSP tools (9 operation + `lsp_diagnostics`); handlers kept very thin (Q3 decision)                                                                                                                                                                                                             |
| `src/harness/aci/tools/registry.ts`    | Modified      | `ACI_TOOLSET_NAMES` appends the 9 tools; `createDefaultAciRegistry` registers them; `CreateDefaultAciRegistryOptions` gains optional `onEdit` passed through to `createEditFileTool`                                                                                                                              |
| `src/harness/aci/tools/edit-file.ts`   | Modified      | factory signature widened: `createEditFileTool(root, opts?: { onEdit?: (file: string) => void })`; on the handler success path `opts.onEdit?.(absPath)`; handler return stays a plain string (upholds contract Y1) (Q2/A13 decision)                                                                              |
| `src/harness/build-engine.ts`          | Modified      | assembles the `lsp` toolset + constructs `notifier.invalidate` as `onEdit` passed through to `createDefaultAciRegistry`                                                                                                                                                                                           |
| `src/harness/permission/`              | **Untouched** | zero changes (#249 decision)                                                                                                                                                                                                                                                                                      |
| `src/harness/aci/tools/tool-search.ts` | **Untouched** | keep as-is (lsp does not collide with tool_search names)                                                                                                                                                                                                                                                          |
| `tests/harness/lsp/client.test.ts`     | **New**       | vscode-jsonrpc mock: requestId/response-routing/cancel                                                                                                                                                                                                                                                            |
| `tests/harness/aci/lsp.test.ts`        | **New**       | unit tests for the 9 handlers: input validation / no match / shared schema                                                                                                                                                                                                                                        |
| `tests/harness/aci/registry.test.ts`   | Modified      | `ACI_TOOLSET_NAMES` locked at 21 tools                                                                                                                                                                                                                                                                            |
| `scripts/lsp-probe.ts`                 | **New**       | real TypeScript Language Server + Pyright smoke test: per `--lang`, spawn + 9 operations + diagnostics                                                                                                                                                                                                            |
| `specs/251-lsp-tool.md`                | **This spec** | —                                                                                                                                                                                                                                                                                                                 |

## Code Style

### `server.ts` — flat `Info` declaration + NearestRoot

```ts
// NearestRoot (#247 Q6: keep, do not cut). Walk up from path.dirname(file)
// to find the first ancestor containing a lockfile as root, excluding deno.json;
// fall back to ctx.directory if none found.
// Upper bound stop=ctx.directory prevents escaping the working directory.
const TS_LOCKFILES = [
  "package-lock.json",
  "bun.lockb",
  "bun.lock",
  "pnpm-lock.yaml",
  "yarn.lock",
];
const TS_EXCLUDE = ["deno.json", "deno.jsonc"];

export const Typescript: Info = {
  id: "typescript",
  root: NearestRoot(TS_LOCKFILES, TS_EXCLUDE),
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
  async spawn(root, ctx) {
    const tsserver = Module.resolve(
      "typescript/lib/tsserver.js",
      ctx.directory
    );
    if (!tsserver) return;
    const bin = await Npm.which("typescript-language-server");
    if (!bin) return;
    const proc = spawn(bin, ["--stdio"], { cwd: root, env: process.env });
    return { process: proc, initialization: { tsserver: { path: tsserver } } };
  },
};
```

### `client.ts` — `getClient()` triple cache

```ts
// #247 Q8: reuse triple (root+id cache / broken memory / inflight dedup)
// iknow has no InstanceContext; the lsp module holds its own ctx {directory, root},
// and build-engine passes process.cwd() in as directory at assembly time.
export interface LspCtx {
  readonly directory: string; // upper bound stop (NearestRoot must not escape it)
}

const clients = new Map<string, LspClient>();
const broken = new Set<string>();
const inflight = new Map<string, Promise<LspClient | undefined>>();

export async function getClient(
  file: string,
  ctx: LspCtx
): Promise<LspClient | undefined> {
  const server = Typescript; // server chosen per file language; TS + Python both required
  const root = await server.root(file, ctx);
  if (!root) return undefined;
  const key = `${root}:${server.id}`;
  if (broken.has(key)) return undefined;
  if (clients.has(key)) return clients.get(key);
  if (inflight.has(key)) return inflight.get(key); // concurrent dedup: share one spawn

  const task = spawnClient(server, root, ctx)
    .then((c) => (c ? (clients.set(key, c), c) : (broken.add(key), undefined)))
    .finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}
```

### `aci/tools/lsp.ts` — the 9 handlers kept very thin

```ts
// #247 Q3 (MCP statelessness idea): handlers only validate params + await client.sendRequest;
// per-request state belongs to vscode-jsonrpc (requestId + response routing).
// All 9 share the same position schema {file, line, character} (#248 decision).
const POSITION_SCHEMA = {
  type: "object",
  properties: {
    file: { type: "string" },
    line: { type: "integer", minimum: 1 },
    character: { type: "integer", minimum: 0 },
  },
  required: ["file", "line", "character"],
  additionalProperties: false,
} as const;

function makeOperationTool(
  name: string,
  method: string,
  extraSchema = {}
): AciToolDef {
  return Object.freeze({
    name, // e.g. "lsp_definition"
    description: `LSP operation ${method}. Read-only symbol lookup; 1-based line, 0-based character.`,
    inputSchema: { ...POSITION_SCHEMA, ...extraSchema },
    aci: {
      category: "read-only" as const,
      isConcurrencySafe: false, // stateful LSP instance; serial loop yields no concurrency naturally (#249)
      interruptBehavior: "cancel" as const, // via $/cancelRequest, do not kill tsserver (Q2/A9)
      timeoutTier: "default" as const, // 30s (#249)
    },
    handler: async (input) => {
      const params = parse(input); // ajv validation
      const client = await getClient(params.file, ctx); // spawn on demand + reuse
      if (!client) return "(no LSP server available for file)";
      const result = await client.sendRequest(method, toParams(params)); // vscode-jsonrpc
      return stringify(result); // contract Y1: plain string
    },
  });
}
// 10 tools = 9 operation + lsp_diagnostics (#250)
```

### `aci/tools/edit-file.ts` — `onEdit` opts injection (Q2/A13 decision)

```ts
// Q2/A13: edit_file success → emit a "file edited" event; the assembly layer wires it to the LSP notifier.
// The edit_file handler carries zero LSP knowledge (opts.onEdit is a generic callback, unaware of the consumer).
// Handler return stays a plain string (upholds contract Y1, no struct exposed).
export interface EditFileOpts {
  readonly onEdit?: (file: string) => void;
}

export function createEditFileTool(
  root: string,
  opts?: EditFileOpts
): AciToolDef {
  const handler = async (input: unknown): Promise<unknown> => {
    // ... existing readFile / lintPatch / countOccurrences unchanged ...
    await writeFile(absPath, replaced, "utf8");
    // ★ Call opts.onEdit after successful write, before return
    opts?.onEdit?.(absPath);
    return `[edit_file] replaced ${occurrences} occurrence(s) in ${absPath}`;
  };
  // ... frozen return unchanged ...
}
```

### `aci/tools/registry.ts` + `build-engine.ts` — `onEdit` pass-through

```ts
// registry.ts: CreateDefaultAciRegistryOptions gains an onEdit field,
// passed through to createEditFileTool(root, { onEdit: options.onEdit })
export interface CreateDefaultAciRegistryOptions {
  readonly env: Pick<IknowEnv, "web">;
  readonly sandboxRoot: string;
  readonly memoryDir?: string;
  readonly onEdit?: (file: string) => void; // ★ LSP linkage seam (spec 251)
}

// build-engine.ts: when assembling lsp tools, construct notifier.invalidate as onEdit
const lspNotifier = createLspNotifier(/* ... */);
const registry = createDefaultAciRegistry({
  env,
  sandboxRoot,
  memoryDir,
  onEdit: (file) => lspNotifier.invalidate(file), // ★ assembly layer wires LSP
});
```

## Testing Strategy

| Level       | Scope                                                                                                                                                                                                      | Tool                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Unit        | 9 operation handlers: input validation (missing line/character), ajv rejecting illegal types, no client returning `"(no LSP server available)"`, wire shape                                                | vitest stub           |
| Unit        | `lsp_diagnostics` handler: latest-wins map, severity filter, per-file cap 20, `<diagnostics file>` XML                                                                                                     | vitest                |
| Unit        | `client.ts`: vscode-jsonrpc mock verifying requestId uniqueness + response routing (MCP statelessness contract)                                                                                            | vitest mock           |
| Unit        | triple cache: same-root reuse / broken memory no retry / inflight concurrent dedup                                                                                                                         | vitest                |
| Unit        | contract X counterexample: mock handler returns `{truncated:false,total:100}`, assert executor self-truncates at 20000 without trusting the field                                                          | vitest (per ADR-0006) |
| Unit        | contract Y1 counterexample: mock handler returns an object, assert executor treats it as plain-string                                                                                                      | vitest                |
| Integration | `scripts/lsp-probe.ts`: real TypeScript Language Server + Pyright, per `--lang`, 9-operation smoke test + diagnostics, each required operation asserted on content                                         | tsx script            |
| Integration | probe Python target: a `pyproject.toml` + project `.venv` project with at least two related source files, so a cross-file reference is actually provable                                                   | tsx script            |
| Integration | probe assertion strength: definition / hover / cross-file references / diagnostics each assert expected file, symbol, or diagnostic content — a skip on a required operation fails the run                 | tsx script            |
| Unit        | failure identity: a failed start reports the server id plus its stage (selection / executable resolution / spawn-exit / initialization / request timeout / pool shutdown); an unsupported method stays a capability result| vitest                |
| Unit        | install-to-retry recovery: after a successful dependency install the affected server retries and succeeds in the same session, bounded, without consuming the one-way host-exit latch                      | vitest                |
| Integration | edit_file linkage: after edit, `onEdit` is called + notifier sends invalidation                                                                                                                            | vitest                |

**Coverage threshold**: handler unit tests + contract X/Y1 counterexample lines covered ≥ 90%; integration covers the full "spawn on demand → operation → reuse" path.

**`npm test` = the only gate**: delivery gate = `npm test` exit 0 + `npm run typecheck` exit 0.

## Boundaries

### Always

- `permission/` **zero changes** (#249 decision); `category=read-only` → DEFAULT_BY_CATEGORY → allow
- string wire (contract Y1 gatekept); the 9 handlers never return structured payloads
- interrupts go through `$/cancelRequest`, **never kill the tsserver process** (Q2/A9) — cancel ≠ pool eviction: only pool eviction and the exit path terminate the child process (see "Lifecycle / EXIT contract")
- tsserver resident + reuse triple (root+id / broken / inflight), spawn on demand, leave no env flag (#247 Q4). **Assembly-time warmup is in scope** (`startLspWarmup`, phase-2 B4 / fire-and-forget): spawn + `ensureOpen` on scanned sample files; samples get pinned (pin exception in the next section). "Resident" refers to the child process and connection; unpinned documents are not kept open (open documents use per-request refcount, next section)
- three assembly-time gates (bootstrap guard / `mcp__` namespace collision guard / `ACI_TOOLSET_NAMES` append-only discipline)
- LSP tool names never collide with `tool_search` and never start with `mcp__`

### Ask first

- adding new dependencies / changing the lockfile (`vscode-jsonrpc` + `typescript-language-server` are **intentional additions**, not a violation)
- changing any file under `permission/` (zero changes this phase; violation needs explicit confirmation)

### Never

- hand-writing a tsserver bridge (#247 Q1 REJECT; breaks the LSP multi-language abstraction)
- splitting `server.ts` into registry/spawn/client files (#247 Q2 REJECT; keep it flat)
- deleting `NearestRoot` (#247 Q6 REJECT; real multi-project-repo scenarios)
- killing the tsserver process to cancel (Q2/A9; cancel only sends `$/cancelRequest`, unrelated to pool eviction)
- warmup on by default / adding a warmup env flag (#247 Q4)
- changing any file in the `permission/` module
- persisting LSP client caches across sessions (A16: same-process, co-born)
- live disk watching: no `didChangeWatchedFiles` or any other watcher (on-disk changes are reconciled before requests, next section)
- new languages / PATH servers, new ACI tools (completion / codeAction / rename etc.)
- 1-based translation of Location payloads, incremental `didChange`, swapping the JSON-RPC stack
- `workspaceFolders` multi-root (existing `rootUri` + `NearestRoot` suffice)

## Lifecycle / EXIT contract

> This section is the frozen contract of the lsp-client-hardening ticket; below, "stop the process", "didOpen / didClose" and "sentinel" are all defined by this section.

### Process lifecycle (EXIT)

| Path                                     | Behavior                                                                                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| tool timeout / abort / cancel            | only send JSON-RPC `$/cancelRequest`, **do not terminate the child process** (Q2/A9 unchanged; cancel ≠ pool eviction)                         |
| idle sweep / worktree rebind stale sweep | **terminate the child process** just like the exit path: dispose the connection + SIGTERM + evict from cache                                   |
| `disposeAll`                             | same termination of the child process; **does not latch** — later calls may spawn new child processes                                          |
| `shutdownAll`                            | same termination of the child process; additionally **one-way latch** — thereafter `getClient` always returns spawn-failed, re-spawn forbidden |

- The three pool-eviction seams (idle sweep / worktree rebind stale sweep / `disposeAll`) and the exit path (`shutdownAll`) share **the same terminal state**. Rationale: stdio pipe handles are not released by closing the connection alone; closing only the connection would leave the host event loop unable to drain.
- The `shutdownAll` latch is one-way — no reverse unlatch path (A16 same-process, co-born).
- No process-termination call exists anywhere on the tool path. The earlier wording "the only process-kill point is host exit" is rewritten by this table and no longer holds.

### Open-document lifecycle

- **Per-request refcount**: overlapping requests for the same uri on one connection share a single `didOpen`; when the refcount hits zero, send `didClose`.
- On reaching zero, **also discard** that uri's open record (version counter) and that uri's diagnostics cache.
- Between two calls the file is not kept open on the server; the next request re-`didOpen`s (reading disk directly naturally picks up the latest text).
- **Pin exception (warmup)**: a bare `ensureOpen` (warmup sample path) marks the uri as pinned — a pinned document is not closed when the scope refcount hits zero; its open record and diagnostics cache are retained until pool eviction / the exit path terminates the connection. Warmup is "opening is the purpose", not a per-request scope: the previous bullet's "not kept open" holds for **unpinned** uris. Pinned uris still go through out-of-band disk reconciliation (next section) and never see stale text.
- `edit_file` linkage semantics unchanged: sync immediately after a successful write — not open → `didOpen`-equivalent path; already open → full-sync `didChange`, version++.

### Out-of-band disk reconciliation

- **Do not** use watchers / `didChangeWatchedFiles` / any live disk monitoring.
- Files not open are tracked by the language server itself against disk; the harness neither receives nor needs live pushes.
- Before sending an RPC, `stat` the mtime of every uri **currently open** (including the target file about to be used); if it differs from the mtime recorded at last sync → re-read the file and send a full-sync `didChange` (version++).

### initialize capability advertisement + missing-method sentinel

- `initialize`'s `capabilities` is **non-empty**, advertising only the methods iknow actually sends: textDocument definition / references / hover / documentSymbol / implementation / prepareCallHierarchy / callHierarchy both directions, workspace/symbol, plus the text-sync declaration needed for diagnostics push.
- A capability **absent** from the server's initialize result ≠ unsupported → send anyway.
- Server **explicitly declares `false`** → do not send the RPC, return the sentinel.
- RPC returning `-32601` / `Unhandled method` → return the same sentinel, **not counted as spawn failure** (no broken write, no client eviction, not classified under `no-server` / `spawn-failed`).
- The sentinel upholds contract Y1 (plain string, model-readable); it stays a capability result, distinct from a startup failure. On a **required** probe operation it is a FAIL that stays inside the run's total, so an all-skipped run never passes; only an operation outside the required set may be reported as a skip.
- TS call hierarchy still truly executes (must not be skipped due to capability advertisement).
- The language table (`SERVERS` 5 entries) and `ACI_TOOLSET_NAMES` are **unchanged**.

## Failure reporting and recovery

> Settled with the runtime-capability-recovery brief. The stage vocabulary below is a reporting contract, not an internal naming prescription: helper, type, and file structure stay open to the implementer.

### Failure identity: server + stage

- Every LSP failure names the **server identity** and the **stage** that failed. The stage set is closed: server selection, executable resolution, process spawn/exit, initialization, request timeout, unsupported method, pool shutdown (the terminal latch set by the host-exit path, which never respawns).
- An **unsupported method remains a capability result, not a startup failure** (see "initialize capability advertisement + missing-method sentinel"); it is not reported as an unavailable server.
- Permission refusal, egress denial, missing executable, child-process failure, initialization failure, timeout, and unsupported method stay distinguishable through the model-visible projection. A generic "unavailable" message does not stand in for the stage or the cause, and the model may not infer a network cause from one.
- A failed start retains the server's own error output as evidence for the next attempt instead of dropping it.

### Executable resolution

- Resolution walks its layers in a fixed order, **highest precedence first**: (1) the existing explicit override, (2) the **active project / worktree** runtime environment — its npm `node_modules/.bin` install, then its project virtualenv for Python, (3) this package's own `node_modules`, (4) the process `PATH` fallback. The explicit override stays the **highest** layer and the `PATH` fallback is **retained**, not replaced; adding the project layer inserts it below the override rather than above it.
- A successful global install is not evidence that the running harness resolves that executable from its current environment.

### Install-to-retry recovery

- A successful dependency install clears the affected server's failed-start state so the **same session** can retry it and succeed.
- The retry is **bounded** — no unbounded retry loop — and is **not routed through a terminal shutdown path**: the one-way latch reserved for host exit is not consumed by a recovery retry, and a later retry may still spawn.

## Success Criteria

All binary (yes/no), each mapped to an executable check:

| #   | Criterion                                          | Check                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | all 10 LSP tools enter the prompt                  | `tests/harness/aci/registry.test.ts` locks `ACI_TOOLSET_NAMES.length === 21` including the 11 original tools                                                                                                                                                                                                                                                                                                                                                  |
| S2  | `server.ts` keeps the flat structure               | no `registry.ts` / `spawn.ts` split files; `server.ts` contains `Info` + inline spawn                                                                                                                                                                                                                                                                                                                                                                         |
| S3  | `NearestRoot` kept                                 | `server.ts` contains `NearestRoot(TS_LOCKFILES, TS_EXCLUDE)` with upper bound stop=ctx.directory                                                                                                                                                                                                                                                                                                                                                              |
| S4  | input validation in the 9 operation handlers       | unit test: missing line/character → reject; ajv rejects illegal types; no client → `"(no LSP server available)"`                                                                                                                                                                                                                                                                                                                                              |
| S5  | 9 tools share the position schema                  | unit test: `lsp_definition` / `lsp_references` etc. inputSchema contains `{file,line,character}`                                                                                                                                                                                                                                                                                                                                                              |
| S6  | `lsp_diagnostics` wire = plain string              | unit test: returns `<diagnostics file>` XML; severity=1 filtering; per-file cap 20                                                                                                                                                                                                                                                                                                                                                                            |
| S7  | contract X counterexample locked                   | unit test: mock handler outputs `{truncated:false,total:100,text:"x".repeat(25000)}`, assert executor self-truncates at 20000 (ADR-0006)                                                                                                                                                                                                                                                                                                                      |
| S8  | contract Y1 counterexample locked                  | unit test: mock handler returns object `{code,stdout,stderr}`, assert executor treats it as plain-string                                                                                                                                                                                                                                                                                                                                                      |
| S9  | reuse triple                                       | unit test: same root reused without respawn / broken memory no retry / inflight concurrent dedup                                                                                                                                                                                                                                                                                                                                                              |
| S10 | `permission/` zero changes                         | `git diff --stat src/harness/permission/` outputs empty                                                                                                                                                                                                                                                                                                                                                                                                       |
| S11 | edit_file linkage                                  | unit test: after edit_file succeeds, `onEdit` is called + notifier sends invalidation                                                                                                                                                                                                                                                                                                                                                                         |
| S12 | real TS + Python server smoke test                 | `npm run probe:lsp -- --lang typescript` and `npm run probe:lsp -- --lang python` each exit 0: the real TypeScript Language Server and Pyright spawn, and definition / hover / cross-file references / diagnostics each carry a meaningful content assertion                                                                                                                                                                                                  |
| S13 | CI main path green                                 | `npm test` exits 0; `npm run typecheck` exits 0                                                                                                                                                                                                                                                                                                                                                                                                               |
| S14 | LSP client cache same-process, co-born             | no cross-session persistence code path; process exit → client dispose                                                                                                                                                                                                                                                                                                                                                                                         |
| S15 | pool eviction terminates child processes           | unit test: after idle sweep / rebind stale sweep / `disposeAll`, the child process exit lands; after `disposeAll`, respawn is possible; after `shutdownAll`, all calls return spawn-failed                                                                                                                                                                                                                                                                    |
| S16 | per-request didOpen / didClose                     | unit test: a single request orders open → RPC → close; overlapping requests on the same uri close only once (last holder), and **the document stays open throughout the overlapping scope** (when the second scope enters its body it must not fall into an already-`didClose` window); after close, the next request re-`didOpen`s; refcount hitting zero discards that uri's open record and diagnostics cache; pinned uris (warmup) are not closed on zero |
| S17 | out-of-band disk reconciliation                    | unit test: after opening, modify disk mtime (not via `edit_file`) → before the next request a full-sync `didChange` is sent, version++                                                                                                                                                                                                                                                                                                                        |
| S18 | `-32601` missing-method sentinel not spawn failure | unit test: server explicit `false` → no RPC sent; `-32601` / `Unhandled method` → Y1 plain-string sentinel; client not evicted, no broken written, later requests can still reuse                                                                                                                                                                                                                                                                             |
| S19 | TypeScript + Python both required                  | probe acceptance runs `--lang typescript` and `--lang python`; no criterion leaves Python as a later phase, and both use real running servers                                                                                                                                                                                                                                                                                                                 |
| S20 | Python coverage is a real multi-file project       | probe Python fixture has `pyproject.toml` + project `.venv` + ≥2 related source files; the cross-file reference resolves to the second file                                                                                                                                                                                                                                                                                                                   |
| S21 | a required-operation skip is a failing run         | a required operation returning the unsupported-method sentinel fails that language's probe run and stays in the total; all-required-skipped is not a pass                                                                                                                                                                                                                                                                                                     |
| S22 | failure names server identity + stage              | failing-case assertions carry the server id and its stage (selection / executable resolution / spawn-exit / initialization / request timeout / pool shutdown); an unsupported method is reported as a capability result, not a startup failure                                                                                                                                                                                                                |
| S23 | resolution uses the active project/worktree        | unit test: a project/worktree-local executable resolves; an explicit override still wins; the process `PATH` fallback still resolves when neither applies                                                                                                                                                                                                                                                                                                     |
| S24 | install-to-retry recovery is bounded               | unit test: a successful install clears that server's failed-start state, the same session retries and succeeds, retries are bounded, and the recovery retry does not take the one-way host-exit latch (a later spawn is still possible)                                                                                                                                                                                                                       |

## Open Questions

Not answered this phase (out of scope / awaiting later map push), declared only, not silent:

- ~~**Trigger timing for multi-language expansion**~~ **Decided (runtime-capability-recovery)**: TypeScript and Python (pyright) are both required and are each proven against a real server — Python is not a pending later phase. Still open is the trigger for languages **beyond** the current table (e.g. Rust / rust-analyzer)
- **Warmup env flag default value**: with measured data from cache reuse, decide whether warmup defaults on (not done this phase, no flag left)
- **Whether the `rename` operation enters a later phase**: explicitly excluded from phase 1; revisit trigger = write-class LSP policy settled + permission rule evolution
- ~~**Tension between stateful LSP tools and the executor "statelessness assumption"**~~ **Decided (lsp-client-hardening)**: the document dimension is closed by per-request refcount (see "Lifecycle / EXIT contract § Open-document lifecycle") — nothing is kept open on the server between two calls; per-request state is still carried by vscode-jsonrpc (Q3 decision)
- **Human-UI code navigation**: an IDE concern, not an agent-product one
- **LSP linkage degradation**: under the current spec shape, if `opts?.onEdit?.(absPath)` inside the `edit_file` handler throws (e.g. the notifier is already disposed), the whole edit_file run goes `execution_failed`. Whether to wrap a try/catch so the LSP linkage degrades (without affecting the main-path write) is left to implementation judgment by experience
- **Deployment prerequisite: `npm install` must succeed**: the probe (`npm run probe:lsp -- --lang …`) and the LSP unit tests cannot run before the already-declared dev dependencies (`vscode-jsonrpc`, `typescript-language-server`, `pyright`) are installed — a deployment precondition, so early bullets of plan tasks should set an explicit checkpoint

## Glossary

> From `docs/CONTEXT.md` (spec cites, does not redefine).

- **ACI tool set**: the tool set registered by the harness assembly layer (`src/harness/aci/`); SSOT factory = `src/harness/aci/tools/registry.ts:createDefaultAciRegistry`; currently 11 tools, 21 after this spec.
- **Loop Engine**: Foundation's state-machine run kernel, driving model → tools → real results → next model turn → explicit stop; lives in `src/harness/`.
- **executor truncation authority** (contract X, ADR-0004 / ADR-0006): the executor is the sole authority over tool-result truncation metadata — it self-measures serialized character count, self-truncates, self-composes the marker; tools return pure data without truncated/total meta-fields.
- **plain-string tool output** (contract Y1, ADR-0004): production tools output plain strings; bash is the sole exception retaining the structured `{code, stdout, stderr}` (Y1b).
- **append-only messages**: Foundation's authoritative Anthropic-native conversation history, the single source of truth; messages may only be updated by immutable append (`[...prev, x]`).
- **LoopTrace**: the second return surface of `run()`, `{ result, trace }` — layer-A structural metadata (strictly no payloads); diagnostics payloads travel via the authoritative messages history (#250 decision).

> New terms introduced by this spec (to be landed into `docs/CONTEXT.md` via `domain-modeling` after implementation; currently working terms inside the spec):

- **LSP client**: a `vscode-jsonrpc`-driven JSON-RPC over stdio client, reused by root+id (MCP statelessness-protocol idea: the protocol layer is stateless, tsserver is stateful).
- **getClient() triple**: root+id cache `Map` / broken memory `Set` / inflight dedup `Map` — reuse eliminates cold start, spawn failures are not retried, concurrent requests share one spawn.
- **NearestRoot**: walk up from `path.dirname(file)` to the nearest ancestor containing a lockfile as the LSP root; upper bound stop=ctx.directory.
- **onEdit seam**: `createEditFileTool(root, opts?: { onEdit?: (file: string) => void })` factory opts injection — after the handler writes successfully it calls `opts.onEdit?.(absPath)`, with zero LSP knowledge inside the handler; `CreateDefaultAciRegistryOptions` gains an `onEdit` field for pass-through; `build-engine.ts` injects `lspNotifier.invalidate` as `onEdit` at assembly time.

## Architectural Constraints

| ADR                                     | Reference form                                                                                                              |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| ADR-0004 (6 tool sets + contracts X/Y1) | the 10 LSP tools append as tools 12-21; wire upholds contract Y1; handlers carry no truncation fields, upholding contract X |
| ADR-0006 (cap 20000)                    | output of the 9 tools is also capped at 20000 characters; no LSP-specific exception                                         |

## ACR Verdict (architecture-change-reviewer · 5-verdict gate)

> 11 affected files (7 source + 4 test + 1 script) — the ≥ 3-files threshold is met.

```text
bounded-context-guardian:     yes — no reverse dependency between src/harness/lsp/ and aci/tools/; lsp/notifier.invalidate is wired into the registry only at build-engine assembly time via a factory closure; handlers carry zero LSP knowledge internally; permission/ zero changes + DEFAULT_BY_CATEGORY read-only → allow path holds.
defensive-contract-validator: yes — all 5 boundary classes covered (empty / negative / overflow / concurrent / exception); contract X/Y1 counterexamples S7/S8 explicitly locked; handler inputSchema validated against the same source compiled strictly by ajv; edit_file linkage adds integration test S11.
error-handling-enforcer:      yes — spawn failure does broken.add(key) + releases inflight; handler with no client returns an explicit string; cancel goes through $/cancelRequest without killing the process; contract Y1 enforces plain strings; edit_file calls opts?.onEdit?.(absPath) only after a successful write (failure paths do not fire it, avoiding false notifications); handler errors still throw ToolExecutionError, converted by the executor into execution_failed, no silent error swallowing.
complexity-anti-drift:        yes — server.ts flat Info + NearestRoot + inline spawn; client.ts triple Map/Set/Map, one responsibility each; handler makeOperationTool factory unifies the 9 tools; POSITION_SCHEMA declared once and shared; edit_file opts is a single-field EditFileOpts; registry pass-through is 1 line; no nesting bloat, no parameter explosion.
minimal-change-verifier:      yes — 1 logical task (9 LSP tools + self-built client + edit_file linkage); the seam goes through edit-file.ts factory gaining one optional opts parameter + registry.ts interface gaining 1 field + build-engine.ts assembly adding 1 closure line; loop-engine.ts zero changes; permission/ zero changes; 2 new dependencies are intentional additions; no warmup, no env flag left behind; interfaces are backward compatible (onEdit optional) and break no existing stub assembly tests.
```

**Gate result: 5/5 yes, hand to writing-plans.**

- affects: src/harness/lsp/server.ts (new)
- affects: src/harness/lsp/client.ts (new)
- affects: src/harness/lsp/notifier.ts (new)
- affects: src/harness/aci/tools/lsp.ts (new)
- affects: src/harness/aci/tools/registry.ts
- affects: src/harness/aci/tools/edit-file.ts
- affects: src/harness/build-engine.ts
- affects: tests/harness/lsp/client.test.ts (new)
- affects: tests/harness/aci/lsp.test.ts (new)
- affects: tests/harness/aci/registry.test.ts
- affects: scripts/lsp-probe.ts (new)
