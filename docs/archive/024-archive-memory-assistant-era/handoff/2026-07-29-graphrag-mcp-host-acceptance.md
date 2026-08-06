# GraphRAG MCP — Claude Code Reference Host Acceptance (wayfinder #49)

Date: 2026-07-29
Branch: `worktree-graphrag-mcp-host-acceptance` (3 commits ahead of `worktree-graphrag-mcp-scaffold`)
Map parent: wayfinder #33
Issue: #49 (final MVP acceptance Gate)
T-005 dependency: #36 (stage 1 memory backend) — **still OPEN**, gates the full ingest → retrieve invariant
Stage 0 scaffold source: PR #43, merged at `f976e4e`

## What this session delivered

Three commits, one logical task each, all on top of the stage-0 scaffold from PR #43.

1. `1a7fe4f chore(upgrade): MCP TypeScript SDK 1.x → 2.0`
   - `@modelcontextprotocol/sdk@1.30.0` (single package) → `@modelcontextprotocol/server@2.0.0` + `/client@2.0.0` (split line, stable since 2026-07-27)
   - `zod@3.25.0` → `zod@4.2.0` (v2 mandates v4)
   - 4 import paths rewritten; lockfile reshuffled (user-authorized under CLAUDE.md `lockfile-mutation` rule)
   - Verified by vitest 11/11 green pre-test-fix, plus post-fix as below

2. `c0bf2ff test(host-smoke): #49 Claude Code reference host acceptance (split + boundary + zod4 probe)`
   - Replaced the single 77-line happy-path test with six named tests, each ≤ 40 lines and ≤ 4 nesting levels (ACR complexity-anti-drift)
   - Added concurrent double-client + zod4 JSON-Schema `minLength:1` regression guard (ACR defensive-contract-validator)
   - Tightened the host-agnostic decoupling regex to import forms only (kills the false positive that matched a doc-comment in `dist/index.js`)

3. `pending feat(config): graphrag-memory stdio MCP host wiring + EXIT_CODES` (this commit)
   - `.mcp.json` at repo root: registers `graphrag-memory` as an stdio MCP server for Claude Code and any other reference host
   - `EXIT_CODES` SSOT in `src/index.ts` (0 OK, 1 fatal runtime, 2 bad config) replacing the two magic numbers
   - Dropped the magic `${tool.name} failed:` prefix from the handler error wrap; now mirrors v2's internal `createToolError` shape (ACR error-handling-enforcer)

## #49 invariants — partial closure

| #   | Invariant                                                                           | Status                     | Evidence                                                                                                                                                                                                 |
| --- | ----------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a1  | stdio JSON-RPC handshake: `initialize` / `initialized` work under a real MCP client | **PASS**                   | `host-smoke: handshake returns graphrag-memory serverInfo`                                                                                                                                               |
| a2  | tool discovery: `tools/list` returns MVP tool set                                   | **PASS**                   | `host-smoke: tools/list returns echo with an object inputSchema`                                                                                                                                         |
| a3  | tool call: `tools/call` on MVP tools returns correct shape                          | **PASS**                   | `host-smoke: tools/call round-trips the message as text content`                                                                                                                                         |
| a4  | full MVP flow: `ingest → retrieve` end-to-end                                       | **BLOCKED on T-005 (#36)** | tools do not exist yet                                                                                                                                                                                   |
| a5  | host-agnostic decoupling: zero imports from iknow                                   | **PASS**                   | `host-smoke: host-agnostic: built artifact does not import from iknow runtime` + post-rewrite `grep -rEn "from ['\"](iknow\|src/shared\|src/config\|../../src\|../../../src)" graphrag-memory/` is empty |
| b   | SDK upgrade itself (was not in #49 but caught the teardown-hang symptom)            | **PASS**                   | v2 `StdioClientTransport.close()` drives `stdin.end → SIGTERM → SIGKILL`; the v1 hand-spawn 5s safety net is gone                                                                                        |

Captured vitest evidence: `C:\Users\86152\.claude\jobs\6038601d\tmp\commit2-test.txt` (16/16 green, host-smoke 7 tests in 3.17s).

## Why I did not close #49

`a4` requires `ingest` and `retrieve` tools. They are gated on T-005 (#36), which is OPEN and unclaimed. Closing #49 against the current `echo`-only tool would be misleading — the Gate's contract is "independent GraphRAG MCP MVP verified by Claude Code reference host", and the MVP does not yet exist.

Honest state: **stage-0 scaffold + SDK upgrade + host-wiring are done; the Gate cannot close until T-005 lands.** This handoff is the evidence trail; the GitHub issue comment will mirror it.

## v2.0 migration — surprises worth recording

These were not in the original plan and only became visible after running tests.

1. **Transport lifecycle**: v2's `StdioClientTransport` takes `command/args/env` and owns the child process; the v1 pattern of hand-spawning and handing stdio to the transport is unsupported. The teardown-hang the v1 test saw disappears naturally with the v2-correct usage.
2. **Input-validation failure semantics**: v2 wraps `tools/call` failures with bad input as `CallToolResult { isError: true, content: [{ type: 'text', text: '...' }] }`. v1 rejected the client-side promise. The schema's `min(1)` still fires — we just observe it via the result shape now. If a future host treats `isError` as success, that's its bug, not ours.
3. **Zod 4 JSON Schema mapping**: `z.string().min(1)` now emits `minLength: 1`, not the v3 `minimum`. JSON Schema 2020-12 is the default. We added a regression-guard test on the wire shape to catch any future zod downgrade.
4. **Type imports**: `CallToolResult` / `TextContent` are re-exported from `@modelcontextprotocol/server` (and `/client`); no separate `@modelcontextprotocol/sdk/types.js` import path. `registry.ts` was updated.

## What is NOT in this branch (deliberate, per ACR)

- **Typed `ToolError` class**: stage 0 has one pure-function tool (`echo`); introducing a typed error class is YAGNI. When T-005 adds `ingest`/`retrieve` (which can throw on IO), this becomes justified and belongs in the #36 effort.
- **Server-crash-during-session fixture**: the ACR exception-class test was a YAGNI-deferred because it requires spawning a deliberately misbehaving server fixture; deferred to #36 alongside the typed error.
- **`.mcp.json` shipped without secret keys**: uses only `GRAPHRAG_MEMORY_TRANSPORT` / `_LOG_LEVEL` (both non-secret). The `dist/` artifact is `.gitignore`-d, so the host must run `npm install && npm run build --workspace graphrag-memory` before `.mcp.json` works — documented in the commit message.

## Verification record (ground truth)

Commands run on this branch:

```bash
npm install                                              # locks @modelcontextprotocol/{server,client}@2.0.0, zod@4.4.3
npm run typecheck --workspace graphrag-memory            # clean
npm run build --workspace graphrag-memory                # clean
npm test --workspace graphrag-memory                     # 16/16 green (7 echo + 2 index + 7 host-smoke)
npm run typecheck                                        # root, clean (pre-commit hook)
npm test                                                 # root, 233/233 green (pre-commit hook)
```

Captured: `C:\Users\86152\.claude\jobs\6038601d\tmp\commit{1,2}-test.txt`.

## Next steps for the operator

1. **T-005 (#36)** is the real next move; this branch is now stage-0-acceptance-ready so T-005 can be built and immediately re-accepted by the same harness.
2. **Live Claude Code verification** (out of band): open Claude Code in this branch's directory, observe the `graphrag-memory` server in the MCP panel, run an `echo` tool call. Evidence is already in the automated tests; this is for the human-eye sanity step the wayfinder process asks for in #49's decision output.
3. **GitHub**: open a draft PR from `worktree-graphrag-mcp-host-acceptance` against `master`. Comment on #49 with this handoff's path and the partial-closure table. Do not close #49 — the Gate is not yet met.
