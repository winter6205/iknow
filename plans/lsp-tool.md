# Plan: lsp-tool

**Goal**: 给 iknow harness 加 9 件 ACI LSP 工具（8 operation + lsp_diagnostics），自建 LSP 客户端（src/harness/lsp/ 新目录），edit_file 联动 tsserver invalidation，agent 在 loop 内做符号定位。
**Architecture**: 自建 LSP 客户端（vscode-jsonrpc + typescript-language-server）+ getClient() 三件套缓存（root+id/broken/inflight）+ 9 件 handler 工厂 makeOperationTool + edit_file 工厂 opts.onEdit 注入 seam + build-engine 装配 LSP notifier。
**Tech Stack**: TypeScript 5.x ESM · Node.js · `vscode-jsonrpc`（新增）· `typescript-language-server`（新增）· `typescript@5.9.3`（已有）· vitest
**Spec link**: `specs/251-lsp-tool.md`

## Tasks (ordered by dependency)

Each numbered item is one tracer bullet: vertical slice, one tag, one commit, binary acceptance.

1. **[decision] 锁定 LSP 依赖与类型基础** — affects: `package.json`, `package-lock.json`, `src/harness/lsp/types.ts`（新）
   - Acceptance: `npm ls vscode-jsonrpc typescript-language-server typescript` 全部 exit 0 且版本非空；`src/harness/lsp/types.ts` 导出 `LspCtx { readonly directory: string }` + `LspServerInfo` + `LspServerHandle` 三个 type 声明；`npm run typecheck` exit 0
   - Per-ticket loop: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

2. **[implementation] `server.ts` — 扁平 Info + NearestRoot** — affects: `src/harness/lsp/server.ts`（新）
   - Acceptance: `src/harness/lsp/server.ts` 导出 `TS_LOCKFILES`/`TS_EXCLUDE`/`NearestRoot`/`Typescript: LspServerInfo`；单测 `tests/harness/lsp/server.test.ts` 覆盖 lockfile 命中/deno.json exclude/无 lockfile 回 ctx.directory/跨 ctx.directory 拒绝 4 种 case 全通过；`grep -E "^export const (Registry|Spawn)" src/harness/lsp/` 为空（验证不拆文件）
   - [blocks: T1]
   - Per-ticket loop: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

3. **[implementation] `client.ts` — getClient() 三件套** — affects: `src/harness/lsp/client.ts`（新）, `tests/harness/lsp/client.test.ts`（新）
   - Acceptance: 单测覆盖三件套 4 case：同 root 复用不重 spawn / broken 记忆不重试 / inflight 并发去重（两次同 file 并发只 spawn 一次）/ 取消走 `$/cancelRequest` 不杀进程；`grep -c "kill\|process.kill" src/harness/lsp/client.ts` 为 0
   - [blocks: T1]
   - Per-ticket loop: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

4. **[parallel] `edit-file.ts` — 工厂 onEdit opts 注入** — affects: `src/harness/aci/tools/edit-file.ts`
   - Acceptance: `createEditFileTool(root, opts?: { onEdit?: (file: string) => void })` 编译通过；handler 成功路径调 `opts?.onEdit?.(absPath)`；handler 返回仍是纯字符串 `[edit_file] replaced N occurrence(s) in <absPath>`（守契约 Y1）；`opts.onEdit` 不传时行为与改动前 byte-identical（既有 edit_file 单测全绿）
   - [blocks: T1]
   - Per-ticket loop: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

5. **[implementation] `aci/tools/registry.ts` + `build-engine.ts` — onEdit 透传** — affects: `src/harness/aci/tools/registry.ts`, `src/harness/build-engine.ts`, `src/harness/lsp/notifier.ts`（新）
   - Acceptance: `CreateDefaultAciRegistryOptions` 加可选 `onEdit?: (file: string) => void`；`createDefaultAciRegistry` 透传给 `createEditFileTool(root, { onEdit: options.onEdit })`；`build-engine.ts` 构造 `lspNotifier`（`createLspNotifier()`，提供 `invalidate(file)` 发 `workspace/xrefs`）并把 `lspNotifier.invalidate` 作为 `onEdit` 注入；`registry.test.ts` 既有断言不破（onEdit 缺省时行为不变）
   - [blocks: T3, T4]
   - Per-ticket loop: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

6. **[implementation] `aci/tools/lsp.ts` — 9 件 handler 工厂** — affects: `src/harness/aci/tools/lsp.ts`（新）, `tests/harness/aci/lsp.test.ts`（新）
   - Acceptance: 9 件 tool 导出（8 operation: `lsp_definition` / `lsp_references` / `lsp_hover` / `lsp_document_symbol` / `lsp_workspace_symbol` / `lsp_go_to_implementation` / `lsp_prepare_call_hierarchy` / `lsp_incoming_calls` / `lsp_outgoing_calls` + `lsp_diagnostics`）；8 件共享 `POSITION_SCHEMA = {file, line, character}` 校验；`lsp_diagnostics` 无 position schema；单测覆盖 ajv 拒非法类型/缺参/无 client 返 `"(no LSP server available)"`/9 件 inputSchema 含必需字段/契约 Y1 字符串输出
   - [blocks: T3]
   - Per-ticket loop: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

7. **[implementation] `registry.ts` append 9 件到 ACI_TOOLSET_NAMES** — affects: `src/harness/aci/tools/registry.ts`, `tests/harness/aci/registry.test.ts`
   - Acceptance: `ACI_TOOLSET_NAMES.length === 20` 且 9 件 LSP 工具名在末尾追加（不重排既有 11 件）；`createDefaultAciRegistry` 注册 9 件并过三闸门（自举守卫 / `mcp__` 防撞 / append-only）；`registry.test.ts` 锁 `ACI_TOOLSET_NAMES.length === 20` 含 11 件原工具名
   - [blocks: T6]
   - Per-ticket loop: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

8. **[parallel] 契约 X/Y1 反例锁单测** — affects: `tests/harness/aci/lsp.test.ts`
   - Acceptance: 契约 X 反例单测：mock handler 输出 `{truncated:false, total:100, text:"x".repeat(25000)}`，断言 executor 自截到 20000 字符（`ADR-0006` cap），不读 `truncated` 字段；契约 Y1 反例单测：mock handler 返回对象 `{code, stdout, stderr}`，断言 executor 按 plain-string 协议处理
   - [blocks: T6]
   - Per-ticket loop: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

9. **[parallel] `scripts/lsp-probe.ts` — 真实 tsserver 烟测** — affects: `scripts/lsp-probe.ts`（新）, `package.json`（加 `probe:lsp` script）
   - Acceptance: `npm run probe:lsp` exit 0：脚本化 spawn tsserver + 8 operation 烟测（每个 operation 至少 1 个 assertion）+ `lsp_diagnostics` 拉取测试工程自身的错误；退出码 0
   - [blocks: T7]
   - Per-ticket loop: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

10. **[implementation] CI 主路径全绿 + permission/ 零改动守门** — affects: 无（验证收口）
    - Acceptance: `npm test` exit 0；`npm run typecheck` exit 0；`git diff --stat src/harness/permission/` 输出空（spec §S10）；`grep -rn "loop-engine.ts" specs/251-lsp-tool.md` 不含「改动」（确认 spec 与实际改动一致）
    - [blocks: T7, T8, T9]
    - Per-ticket loop: typecheck+tests → code-review → verification-before-completion → commit on ticket branch

## Cross-references

- architecture-change-reviewer verdict: 5/5 yes — bounded-context-guardian (lsp/ 与 aci/ 无反向依赖、handler 零 LSP 知识) / defensive-contract-validator (5 边界类全 + 契约 X/Y1 反例锁) / error-handling-enforcer (broken/inflight 释放 + cancel 不杀进程 + 无静默吞错) / complexity-anti-drift (server.ts 扁平 + client.ts 三件套各一职责 + handler 工厂统一 9 件) / minimal-change-verifier (1 逻辑任务 + seam 走 edit-file.ts 工厂扩参 1 字段 + registry/build-engine 透传)
- affected S1-S6 skills: S1 (新 bounded context `src/harness/lsp/`，独立 ACI 装饰层原型) / S2 (5 边界类全覆盖 + 契约 X/Y1 反例锁 + handler ajv 同源校验) / S5 (handler 工厂 + 三件套各一职责；每文件 <300 行) / S6 (1 逻辑任务，loop-engine 零改动、permission/ 零改动，2 新依赖有意)
- parallelization surface: T4 (edit-file 工厂扩参) 可与 T2/T3 (lsp/ 新文件) 并行；T8 (契约反例锁) 与 T9 (probe 烟测) 可与 T7 主线并行；T10 必须在所有 T2-T9 完成后
- deployment checkpoint (per ACR 遗留风险): T1 完成时必须 `npm install` 跑通，否则 T2-T10 全部阻塞——T1 acceptance 强制 `npm ls` 三个 dep 全部 exit 0
- onEdit try/catch 降级（Open Question）: 由实施 agent 在 T4 决定；spec 未强制要求
