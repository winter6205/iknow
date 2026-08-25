# Plan: lsp-multilang

**Goal**: 泛化 iknow LSP 客户端（spec 251 已有）的 4 个 TS 专属接缝 + 首期落地 4 门 npm wrapper 语言（pyright / yaml-language-server / vscode-json-languageserver / dockerfile-language-server-nodejs），TS 保底，probe 参数化。
**Architecture**: `types.ts` `initialization?` 可选化 → `server.ts` 并排多 `Info` + `SERVERS` 数组 + `resolveServer(file)` 按扩展名单命中 dispatch → `language.ts` `LANGUAGE_EXTENSIONS` 表 + `languageIdFor` 查表 → `client.ts` `getClient` 消费 resolveServer → `scripts/lsp-probe.ts` 语言无关通用壳 + `PROBE_TARGETS` 夹具表。
**Tech Stack**: TypeScript 5.x ESM · Node.js · `vscode-jsonrpc`（已有）· `typescript-language-server`（已有）· `pyright` / `yaml-language-server` / `vscode-json-languageserver` / `dockerfile-language-server-nodejs`（4 门新增 devDeps）· vitest
**Spec link**: `specs/302-lsp-multilang.md`

## Tasks (ordered by dependency)

Each numbered item is one tracer bullet: vertical slice, one tag, one commit, binary acceptance.

1. **[decision] 锁定 4 门新语言 devDeps + types.ts initialization 可选化** — affects: `package.json`, `package-lock.json`, `src/harness/lsp/types.ts`
   - Acceptance: `npm ls pyright yaml-language-server vscode-json-languageserver dockerfile-language-server-nodejs` 全部 exit 0 且版本非空（pyright 1.1.411 / yaml-language-server 1.24.0 / vscode-json-languageserver 1.3.4 / dockerfile-language-server-nodejs 0.15.0）；`types.ts` `LspServerHandle.initialization` 改为 `?` 可选 `Record<string, unknown>`；`npm run typecheck` exit 0；`npm test` exit 0（现有 fixture 不破）
   - Per-ticket loop: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

2. **[implementation] `server.ts` — NearestRoot exclude 可选 + 4 门新语言 Info + SERVERS + resolveServer** — affects: `src/harness/lsp/server.ts`, `tests/harness/lsp/server.test.ts`
   - Acceptance: `NearestRoot(include, exclude?)` exclude 改可选（省略时无排除）；`TS_LOCKFILES`/`TS_EXCLUDE` 不再导出顶层常量（移 `Typescript` 旁局部）；`Pyright`/`YamlLS`/`JsonLS`/`DockerfileLS` 并排导出 + `SERVERS` 数组 + `resolveServer(file)` 按扩展名单命中；单测覆盖 NearestRoot exclude 可选（省略无排除/exclude 命中跳过/上界 stop 保留）+ resolveServer 路由（.py→pyright/.yaml→YamlLS/.json→JsonLS/Dockerfile→DockerfileLS/.ts→Typescript/无匹配→undefined）+ **overflow（SERVERS 空数组 → find 返回 undefined 不 throw）**；`grep -E "^export const (Registry|Spawn)" src/harness/lsp/server.ts` 为空（不拆文件）
   - [blocks: T1]
   - Per-ticket loop: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

3. **[implementation] `language.ts` — LANGUAGE_EXTENSIONS 表 + languageIdFor 迁入** — affects: `src/harness/lsp/language.ts`（新）, `tests/harness/lsp/language.test.ts`（新）
   - Acceptance: `LANGUAGE_EXTENSIONS` 表完整（.ts/.mts/.cts→typescript、.tsx→typescriptreact、.jsx→javascriptreact、.py/.pyi→python、.yaml/.yml→yaml、.json→json、.dockerfile→dockerfile）；`languageIdFor(file)` 查表 + 回退 typescript；单测覆盖每扩展名映射 + 回退；`client.ts` `languageIdFor` 改 import `language.ts`（原正则硬编码 `client.ts:226-231` 删除）
   - [blocks: T2]
   - Per-ticket loop: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

4. **[implementation] `client.ts` — getClient 消费 resolveServer** — affects: `src/harness/lsp/client.ts`, `tests/harness/lsp/client.test.ts`
   - Acceptance: `client.ts:90` 由 `const server = opts?.server ?? Typescript` 改 `?? resolveServer(file)`；无匹配 server → early-return `undefined`（graceful `"(no LSP server available)"`）；`opts.server` 测试注入点保留（语义从"默认 server"变"覆盖 dispatch 结果"）；单测覆盖 dispatch 路由每语言 + opts.server 覆盖 dispatch + 无匹配 undefined + **concurrent（同 root+server 并发 getClient 只 spawn 一次，single-match 无并集）**；现有 8 处 `initialization:{tsserver:{path}}` fixture 不破（零迁移）
   - [blocks: T3]
   - Per-ticket loop: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

5. **[implementation] `scripts/lsp-probe.ts` — 语言无关通用壳 + PROBE_TARGETS 夹具表** — affects: `scripts/lsp-probe.ts`, `scripts/lsp-probe-targets.ts`（新）, `package.json`（`probe:lsp` script 支持 `--lang`）
   - Acceptance: `lsp-probe.ts` import 生产 `SERVERS` + `PROBE_TARGETS`；`--lang` 参数化（typescript/python/yaml/json/dockerfile）；9-op 通用验证壳（spawn server → ensureOpen 目标文件 → definition/references/... → 断言非空非哨兵）；`lsp-probe-targets.ts` 每语言 `{serverId, targetFile, line, char}` 夹具表；`npm run probe:lsp -- --lang typescript` exit 0（TS 保底不回归）
   - [blocks: T4]
   - Per-ticket loop: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

6. **[implementation] 4 门新语言真实现测 + CI 主路径全绿 + permission/ 零改动守门** — affects: 无（验证收口）
   - Acceptance: `npm run probe:lsp -- --lang python/yaml/json/dockerfile` 各 exit 0（需 npm install 后）；`npm test` exit 0；`npm run typecheck` exit 0；`git diff --stat src/harness/permission/` 输出空（spec §S9）；`tests/harness/aci/registry.test.ts` 锁 `ACI_TOOLSET_NAMES.length === 21`（spec §S10，不新增工具）
   - [blocks: T5]
   - Per-ticket loop: typecheck+tests → code-review → verification-before-completion → commit on ticket branch

## Cross-references

- architecture-change-reviewer verdict: 5/5 yes — bounded-context-guardian (lsp/ 内部泛化、handler 零改动、permission/ 零改动、probe 只读消费 SERVERS) / defensive-contract-validator (5 边界类全：empty=无扩展名 file / negative=无匹配 server / overflow=SERVERS 空数组 / concurrent=dispatch 并发 / exception=spawn 失败) / error-handling-enforcer (spawn 失败 broken + venv 探测失败 init undefined + resolveServer 无匹配 undefined + cancel 不杀进程) / complexity-anti-drift (resolveServer 单行 find + languageIdFor 查表零分支 + PROBE_TARGETS 纯数据表) / minimal-change-verifier (1 逻辑任务 + getClient 改 2 行 + types.ts 改 1 字段 + 4 新 devDep 有意 + 不加新 ACI 工具)
- affected S1-S6 skills: S1 (lsp/ 内部同上下文，无新 bounded context) / S2 (5 边界类 + resolveServer 无匹配 + NearestRoot exclude 可选) / S5 (resolveServer 单行 + languageIdFor 零分支 + PROBE_TARGETS 纯数据) / S6 (1 逻辑任务，permission/ 零改动、ACI_TOOLSET_NAMES 仍 21 件、4 新依赖有意)
- parallelization surface: T2/T3 (server.ts + language.ts，独立文件) 可并行；T5 (probe) 依赖 T4；T6 必须在所有 T1-T5 完成后
- deployment checkpoint (per ACR 遗留风险): T1 必须 `npm install` 跑通 4 个新 devDep，否则 T2-T6 的 probe 单测无法跑——T1 acceptance 强制 `npm ls` 4 dep 全部 exit 0
- resolveNpmBin / detectVenvPython helper 归属（Open Question）: 首期 server.ts 内联（复用现有 resolveLanguageServerBin 模式），T2 实施 agent 决定是否抽;spec 未强制
- `.pyi` languageId 覆盖（Open Question）: 首期把 `.pyi` 也映射 `python`（deviation from 同类实现），T3 实施确认 pyright 收正确 languageId
- ACR re-verification: 首轮 ACR 判 defensive-contract **unclear**（overflow/concurrent 两边界类在 ACR 断言但缺测试表行）；已补 T2 overflow + T4 concurrent 测试行，spec Testing Strategy 表同步补齐，5/5 yes 成立。
