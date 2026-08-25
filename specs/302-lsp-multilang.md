# Spec: 302-lsp-multilang — LSP 多语言（泛化接缝 + 首期常用语言落地）

> 输入 = [map #303 Decisions so far](https://github.com/winter6205/iknow/issues/303)（#306/#304/#305/#307 已 close）+ 本 spec 复核决议。
> 范围 = 泛化 `src/harness/lsp/` 的 4 个 TS 专属接缝 + 首期落地 4 门 npm wrapper 语言（pyright / yaml-language-server / vscode-json-languageserver / dockerfile-language-server-nodejs），TS 保底。
> 落地 = spec → ACR → writing-plans，本 spec 不含实施代码。

## Objective

给 iknow harness 的 LSP 客户端（spec 251，TS 单语言已落地）**泛化接缝 + 首期落地常用语言**，让 agent 在 loop 内对多语言文件做符号定位。

**用户**：iknow 单用户单项目本机产品；CLI `chat` / `ask` / TUI / `serve` 四个入口共享同一份 ACI registry + LSP 客户端（`src/harness/lsp/`）。

**要建什么**：

1. **泛化 4 个 TS 专属接缝**（本工程核心，不是「加语言」）：
   - `types.ts` `LspServerHandle.initialization`：必填 `{tsserver:{path}}` → **可选 `Record<string, unknown>`**（#305 决策1）
   - `server.ts` `NearestRoot(TS_LOCKFILES, TS_EXCLUDE)`：exclude 改可选 `(include, exclude?)`；`TS_LOCKFILES`/`TS_EXCLUDE` 从导出顶层常量移各 `Info` 旁局部常量（#305 决策2）
   - `client.ts` `getClient` 硬编默认 `Typescript` → **按扩展名 dispatch**：抽 `resolveServer(file)` 放 server.ts，`getClient` 消费（#304 决策1）；单命中按声明序取第一个（#304 决策2）
   - `languageIdFor()` 正则硬编码 → 查 `LANGUAGE_EXTENSIONS` 表放独立 `language.ts`（#304 决策4）
2. **首期落地 4 门语言**（全 npm wrapper 类，零 PATH 依赖，贴合 iknow 本机产物）：
   - TS 保底（已有）+ **Python (pyright)** + **YAML (yaml-language-server)** + **JSON (vscode-json-languageserver)** + **Dockerfile (dockerfile-language-server-nodejs)**
3. **probe 参数化**（#307）：`scripts/lsp-probe.ts` 从 TS 专属硬编码改语言无关通用壳，import 生产 `SERVERS` + 独立 `PROBE_TARGETS` 夹具表（#307 Q1/Q3）
4. **二进制供给 = 混合 (c)**：有 npm wrapper 的装 iknow devDeps 开箱即用；无 wrapper 的（gopls / rust-analyzer）走 PATH `which` 探测 graceful —— **Go/Rust 二期，不在本 spec 范围**

**成功形态**：`getClient` 对 `.py` 文件自动路由 pyright、`.yaml` 到 yaml-language-server、`.json` 到 vscode-json-languageserver、`Dockerfile` 到 dockerfile-language-server-nodejs，TS 行为不回归；`lsp-probe` 按 `--lang` 参数化跑真实 server 烟测；`permission/` 零改动；`ACI_TOOLSET_NAMES` 仍 21 件（不加新工具，只改 dispatch 内部）。

## Tech Stack

| 项             | 取值                                                                                                    | 备注                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 语言           | TypeScript（与 harness 一致，5.x ESM）                                                                  | —                                                                                                    |
| 运行时         | Node.js                                                                                                 | —                                                                                                    |
| LSP 客户端底层 | `vscode-jsonrpc`（`node` 入口）                                                                         | 现有依赖（spec 251）；提供 requestId/响应路由/cancel 协议层                                          |
| LSP 翻译层     | `typescript-language-server`                                                                            | 现有 devDependency（TS 保底）                                                                        |
| TS 内核        | `typescript`（已依赖）                                                                                  | tsserver = `typescript/lib/tsserver.js`（零额外 dep）                                                |
| Python server  | `pyright`（npm wrapper）                                                                                | **新增 devDependency**；bin `pyright-langserver`；init `{pythonPath}`（venv 探测）                   |
| YAML server    | `yaml-language-server`                                                                                  | **新增 devDependency**；bin `yaml-language-server`；init 无                                          |
| JSON server    | `vscode-json-languageserver`                                                                            | **新增 devDependency**；bin `vscode-json-languageserver`；init 无必需（schemas 走 workspace/config） |
| Dockerfile     | `dockerfile-language-server-nodejs`                                                                     | **新增 devDependency**；bin `docker-langserver`；init 无；root=ctx.directory                         |
| 进程管理       | `child_process.spawn`                                                                                   | 标准库                                                                                               |
| 测试           | vitest                                                                                                  | `npm test`                                                                                           |
| 新依赖         | `pyright` + `yaml-language-server` + `vscode-json-languageserver` + `dockerfile-language-server-nodejs` | 4 个 npm wrapper **有意新增**，不守 spec 224 的零新依赖守门（#306 事实表 + 混合供给决议）            |

## Commands

```bash
# Build
npm run typecheck       # 入口文件类型校验

# Test（产品主路径）
npm test                # vitest: unit + harness + integration

# Lint
npm run lint            # 项目根 lint 入口

# LSP 探针（真实 server 烟测，--lang 参数化）
npm run probe:lsp -- --lang typescript   # TS 保底（现有契约）
npm run probe:lsp -- --lang python       # pyright 烟测
npm run probe:lsp -- --lang yaml         # yaml-language-server 烟测
npm run probe:lsp -- --lang json         # vscode-json-languageserver 烟测
npm run probe:lsp -- --lang dockerfile   # dockerfile-language-server-nodejs 烟测
```

## Project Structure

新增 / 改动点：

| 路径                                 | 形态        | 角色                                                                                                                                                                                                                              |
| ------------------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/harness/lsp/types.ts`           | **改动**    | `LspServerHandle.initialization` 必填 `{tsserver:{path}}` → **可选 `Record<string, unknown>`**（#305 决策1）                                                                                                                      |
| `src/harness/lsp/server.ts`          | **改动**    | `NearestRoot(include, exclude?)` exclude 可选（#305 决策2）；`TS_LOCKFILES`/`TS_EXCLUDE` 移局部（#305）；**新增 `Pyright`/`YamlLS`/`JsonLS`/`DockerfileLS` 并排 `Info` + `SERVERS` 数组 + `resolveServer(file)`**（#304 决策1/3） |
| `src/harness/lsp/language.ts`        | **新**      | `LANGUAGE_EXTENSIONS: Record<string,string>` 表 + `languageIdFor(file)` 迁入（#304 决策4）                                                                                                                                        |
| `src/harness/lsp/client.ts`          | **改动**    | `getClient` `?? Typescript` → `?? resolveServer(file)`；无匹配 early-return；`languageIdFor` 改 import `language.ts`（#304 决策1/4）                                                                                              |
| `src/harness/aci/tools/lsp.ts`       | **不动**    | 10 件 handler 零 LSP 聚合知识；经 `getClient(ctx, file)` 间接消费（opts.server 测试注入点保留）                                                                                                                                   |
| `src/harness/build-engine.ts`        | **不动**    | 装配不变（`LspCtx.directory = sandboxRoot`）                                                                                                                                                                                      |
| `src/harness/permission/`            | **不动**    | 零改动（#249 决议）                                                                                                                                                                                                               |
| `scripts/lsp-probe.ts`               | **改动**    | TS 专属硬编码 → 语言无关通用壳 + import `SERVERS` + `PROBE_TARGETS` 夹具表（#307 Q1/Q3）                                                                                                                                          |
| `scripts/lsp-probe-targets.ts`       | **新**      | `PROBE_TARGETS` 夹具表（每门语言 `{serverId, targetFile, line, char}`）（#307 Q3）                                                                                                                                                |
| `package.json` / `package-lock.json` | **改动**    | +4 npm wrapper devDeps（pyright / yaml-language-server / vscode-json-languageserver / dockerfile-language-server-nodejs）                                                                                                         |
| `tests/harness/lsp/server.test.ts`   | **改动**    | `NearestRoot` exclude 可选 + `resolveServer(file)` 扩展名路由单测                                                                                                                                                                 |
| `tests/harness/lsp/language.test.ts` | **新**      | `LANGUAGE_EXTENSIONS` 表 + `languageIdFor` 查表单测                                                                                                                                                                               |
| `tests/harness/lsp/client.test.ts`   | **改动**    | `resolveServer` dispatch 覆盖（opts.server 注入点语义从"默认 server"变"覆盖 dispatch 结果"）                                                                                                                                      |
| `specs/302-lsp-multilang.md`         | **本 spec** | —                                                                                                                                                                                                                                 |

## Code Style

### `types.ts` — `initialization` 可选化（#305 决策1）

```ts
// types.ts:58-62
export interface LspServerHandle {
  readonly process: import("node:child_process").ChildProcess;
  readonly initialization?: Record<string, unknown>; // 原: 必填 {tsserver:{path}}
}
```

### `server.ts` — 并排多 Info + SERVERS + resolveServer（#304 决策1/3 + #305 决策2）

```ts
// NearestRoot exclude 可选（#305 决策2）
export function NearestRoot(
  includePatterns: readonly string[],
  excludePatterns?: readonly string[]
): (file: string, ctx: LspCtx) => Promise<string | undefined> { ... }

// 各语言 Info 旁就近局部常量（不导出，#305 决策2）
export const Typescript: LspServerInfo = {
  id: "typescript",
  root: NearestRoot(
    ["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"],
    ["deno.json", "deno.jsonc"]
  ),
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
  async spawn(root, _ctx) { ... },  // 现有 + tsserver.path 照旧
};

export const Pyright: LspServerInfo = {
  id: "pyright",
  root: NearestRoot(["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile", "pyrightconfig.json"]),
  extensions: [".py", ".pyi"],
  async spawn(root, _ctx) {
    const bin = await resolveNpmBin("pyright", "pyright-langserver");  // 复用 resolveLanguageServerBin 模式
    if (!bin) return undefined;
    const pythonPath = await detectVenvPython(root);  // VIRTUAL_ENV → .venv → venv
    return { process: spawnProcess(bin, ["--stdio"], { cwd: root, env: process.env }),
             initialization: pythonPath ? { pythonPath } : undefined };
  },
};

export const SERVERS = [Typescript, Pyright, YamlLS, JsonLS, DockerfileLS] as const;
export function resolveServer(file: string): LspServerInfo | undefined {
  const ext = path.extname(file) || path.basename(file); // basename：handler 传全路径
  return SERVERS.find(s => s.extensions.includes(ext));
}
```

### `language.ts` — LANGUAGE_EXTENSIONS 表 + languageIdFor（#304 决策4）

```ts
export const LANGUAGE_EXTENSIONS: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".jsx": "javascriptreact",
  ".py": "python",
  ".pyi": "python",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".json": "json",
  ".dockerfile": "dockerfile",
  Dockerfile: "dockerfile", // 无扩展名全文件名（与 resolveServer basename 回退一致）
} as const;

export function languageIdFor(file: string): string {
  const ext = path.extname(file) || path.basename(file); // basename：handler 传全路径
  return LANGUAGE_EXTENSIONS[ext] ?? "typescript"; // 回退 typescript（守现有 TS 行为）
}
```

### `client.ts` — getClient 消费 resolveServer（#304 决策1）

```ts
export async function getClient(
  ctx: LspCtx,
  file: string,
  opts?: { readonly server?: LspServerInfo }
): Promise<LspClient | undefined> {
  const server = opts?.server ?? resolveServer(file);   // 原: ?? Typescript
  if (!server) return undefined;                          // 无匹配 → graceful"(no LSP server)"
  const root = await server.root(file, ctx);
  if (!root) return undefined;
  ...按键三件套不变...
}
```

### `scripts/lsp-probe.ts` — 语言无关通用壳（#307 Q1/Q3）

```ts
import { SERVERS } from "../src/harness/lsp/server.js";
import { PROBE_TARGETS } from "./lsp-probe-targets.js";

// 9-op 通用验证壳：spawn server → ensureOpen 目标文件 → definition/references/... → 断言非空非哨兵
async function runLang(lang: string): Promise<void> {
  const target = PROBE_TARGETS[lang];
  const server = SERVERS.find((s) => s.id === target.serverId);
  if (!server) throw new Error(`no server for lang=${lang}`);
  const ctx = { directory: target.projectRoot };
  const tools = createLspToolSet(ctx);
  // ... 跑 9 operation 指向 target.file / target.line / target.char ...
}
// --lang argument → runLang
```

## Testing Strategy

| 等级        | 范围                                                                                                                                            | 工具        |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Unit        | `language.ts`：`LANGUAGE_EXTENSIONS` 表完整（TS/TSX/JSX/PY/YAML/JSON/Dockerfile）+ `languageIdFor` 查表 + 回退 typescript                       | vitest stub |
| Unit        | `server.ts` `resolveServer(file)`：`.py`→pyright、`.yaml`→YamlLS、`.json`→JsonLS、`Dockerfile`→DockerfileLS、`.ts`→Typescript、无匹配→undefined | vitest      |
| Unit        | `server.ts` `NearestRoot(include, exclude?)`：exclude 可选（省略时无排除）、exclude 命中跳过、上界 stop 保留                                    | vitest      |
| Unit        | `types.ts` `initialization?` 可选化：有值为 Record、省略合法（不破坏现有 fixture）                                                              | vitest      |
| Unit        | `client.ts` dispatch：`resolveServer` 路由正确每语言；`opts.server` 注入覆盖 dispatch 结果；无匹配返回 undefined                                | vitest      |
| Unit        | `server.ts` `resolveServer(SERVERS=[])` overflow：空数组 → `find` 返回 undefined（不 throw）；`SERVERS.find` 无匹配也返回 undefined             | vitest      |
| Unit        | `client.ts` dispatch 并发去重：同 root+server 并发 getClient 只 spawn 一次（继承三件套 inflight，新增 dispatch 层不 fork）；single-match 无并集 | vitest      |
| Integration | 4 门新语言真实 server 烟测：`npm run probe:lsp -- --lang python/yaml/json/dockerfile` 全绿（需 npm install 后）                                 | tsx script  |
| Integration | TS 保底不回归：`npm run probe:lsp -- --lang typescript` 全绿（现有契约 S12）                                                                    | tsx script  |

**覆盖率门槛**：handler 单测 + dispatch + languageId 覆盖 ≥ 90%；integration 覆盖「按需 spawn → operation → 复用」路径。

**`npm test` = 唯一门**：交付门槛 = `npm test` 退出 0 + `npm run typecheck` 退出 0。

## Boundaries

### Always

- `permission/` **零改动**（#249 决议）；`category=read-only` → DEFAULT_BY_CATEGORY → allow
- `ACI_TOOLSET_NAMES` **仍 21 件**（不新增工具，只改 dispatch 内部）；append-only 纪律不重排既有 11 件
- 中断走 `$/cancelRequest`，**不杀任何 server 进程**（Q2/A9）
- server 常驻 + 复用三件套（root+id / broken / inflight），按需 spawn，不预热、不留 env flag（#247 Q4）
- 单命中（#304 决策2）：`resolveServer` 按声明序取第一个命中；无并集
- 混合供给 (c)：有 npm wrapper 的走 devDep 开箱即用，无 wrapper 的（Go/Rust）走 PATH 探测 graceful —— **本 spec 只做 npm wrapper 类**
- 泛化不破坏现有 `Typescript` 声明（`initialization` 可选化 + 常量移局部对现有 fixture 兼容，零迁移）

### Ask first

- 加新依赖 / 改 lockfile（4 个 npm wrapper 是**有意新增**，非违反；go/gopls、rust-analyzer 二期另行决策）
- 改 `permission/` 任何文件（零改动，违反需显式确认）
- 从单命中演进到多命中并集（#304 决策2 留 fog，未来加工具 server 时另行决策）

### Never

- 自写任何语言 server 桥（#247 Q1 REJECT；破坏 LSP 多语言抽象）
- 拆 `server.ts` 为 registry/spawn/client 三文件（#247 Q2 REJECT；保留扁平）
- 删 `NearestRoot`（#247 Q6 REJECT；多项目仓库真场景）
- 杀任何 server 进程来 cancel（Q2/A9）
- 预热默认开 / 加预热 env flag（#247 Q4）
- 改 `permission/` 模块任何文件
- 跨 session 持久化 LSP client 缓存（S14：同进程同生）
- 本 spec 实装 Go/Rust（gopls / rust-analyzer 二期，不在范围）

## Success Criteria

全部为二元（是/否），每条对应可执行的检查：

| #   | Criterion                          | Check                                                                                                                  |
| --- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| S1  | `initialization` 可选化            | `types.ts:58-62` 改为 `initialization?: Record<string, unknown>`；单测：省略合法 + 有值兼容                            |
| S2  | `NearestRoot` exclude 可选         | `server.ts` 签名 `(include, exclude?)`；单测：省略 exclude 时无排除、exclude 命中跳过、上界 stop 保留                  |
| S3  | `TS_LOCKFILES`/`TS_EXCLUDE` 移局部 | `server.ts` 不再导出顶层常量；`Typescript` 用就近局部常量；无测试按名引用                                              |
| S4  | `resolveServer` 扩展名路由         | 单测：`.py`→pyright、`.yaml`→YamlLS、`.json`→JsonLS、`Dockerfile`→DockerfileLS、`.ts`→Typescript、无匹配→undefined     |
| S5  | `getClient` 消费 `resolveServer`   | `client.ts:90` 由 `?? Typescript` 改 `?? resolveServer(file)`；无匹配 early-return；`opts.server` 注入点保留           |
| S6  | `language.ts` 表 + `languageIdFor` | `LANGUAGE_EXTENSIONS` 表完整 + `languageIdFor` 查表 + 回退 typescript；`client.ts` `languageIdFor` 改 import           |
| S7  | 4 门新语言 server 声明             | `server.ts` 并排 `Pyright`/`YamlLS`/`JsonLS`/`DockerfileLS` `Info` + 进 `SERVERS` 数组；spawn/root/init 按 #306 事实表 |
| S8  | probe 语言无关通用壳               | `lsp-probe.ts` import `SERVERS` + `PROBE_TARGETS` 夹具表 + `--lang` 参数化；9-op 通用验证壳                            |
| S9  | `permission/` 零改动               | `git diff --stat src/harness/permission/` 输出空                                                                       |
| S10 | `ACI_TOOLSET_NAMES` 仍 21 件       | `tests/harness/aci/registry.test.ts` 锁 `21`（不因本 spec 增工具）                                                     |
| S11 | TS 保底真实现测                    | `npm run probe:lsp -- --lang typescript` 退出 0：spawn + 9 operation + diagnostics 全通（现有契约 S12 不回归）         |
| S12 | 4 门新语言真实现测                 | `npm run probe:lsp -- --lang python/yaml/json/dockerfile` 各退出 0（npm install 后）                                   |
| S13 | CI 主路径全绿                      | `npm test` 退出 0；`npm run typecheck` 退出 0                                                                          |
| S14 | LSP client 缓存同进程同生          | 无跨 session 持久化代码路径；进程退出 → client dispose                                                                 |

## Open Questions

本期不答（已在范围外 / 等后续地图推动），仅声明不静默：

- **Go/Rust 二期（gopls / rust-analyzer）**：无 npm wrapper，走 PATH `which` 探测；CI 无二进制时 probe graceful skip 还是 pending —— 另行决策，不在本 spec
- **多命中并集演进**：未来加 ESLint/Biome 类工具 server（认 `.ts`）时，是否从单命中演进到并集——留 fog（#304 决策2）
- **`.pyi` languageId 覆盖**：research #306 确认同类实现的 `.pyi` 不在 LANGUAGE_EXTENSIONS → 回退 plaintext。本 spec 首期把 `.pyi` 也映射 `python`（避免 pyright 收 plaintext），但这是 deviation 待实测确认
- **YAML root 标记**：同类实现用 JS lockfile 集当 YAML 项目根（无 YAML 专属标记）。本 spec 沿用同类实现现状，待实测看是否要 YAML-specific root（如 `.yamllint`）
- **JSON 无 root 逻辑**：vscode-json-languageserver 自身无 project root 概念，iknow 的 `NearestRoot` 上界 stop 语义对它不适用 —— 首期用 `_file => ctx.directory`（dockerfile 同），待实测验证
- **`resolveNpmBin` / `detectVenvPython` helper 归属**：server.ts 内新增（复用现有 `resolveLanguageServerBin` 模式），还是抽工具 —— 首期 server.ts 内联，文件增长再抽
- **部署前置：`npm install` 跑通**：4 个新 devDep 未装，`probe:lsp --lang python/yaml/json/dockerfile` 与相关单测在 `npm install` 前无法跑——属部署前置条件，plan 早期 bullet 应设显式 checkpoint

## Glossary

> 来自 `docs/CONTEXT.md`（spec 引用，不重定义）。

- **ACI tool set**：Harness 装配层（`src/harness/aci/`）注册的工具集；SSOT 工厂 = `src/harness/aci/tools/registry.ts:createDefaultAciRegistry`；当前 21 件（#251 后）。
- **LoopTrace**：`run()` 的第二返回面 `{ result, trace }`—— A 层结构元数据（严格不含 payload）；diagnostics payload 走 messages 权威历史（#250 决议）。
- **executor truncation authority**（契约 X，ADR-0004 / ADR-0006）：executor 是工具结果截断元数据的唯一权威——自测序列化后字符数、自截断、自合成标记；工具返回纯数据、不带 truncated/total 元字段。
- **plain-string tool output**（契约 Y1，ADR-0004）：生产工具输出为纯字符串；bash 是唯一例外保留结构化 `{code, stdout, stderr}`（Y1b）。

> 本 spec 引入的新术语（待实施完成后经 `domain-modeling` 落 `docs/CONTEXT.md`；当前作 spec 内工作术语使用）：

- **SERVER 集合**：`src/harness/lsp/server.ts` 并排导出的多个 `LspServerInfo`（`Typescript`/`Pyright`/`YamlLS`/`JsonLS`/`DockerfileLS`）+ `SERVERS` 数组（#304 决策3）。
- **resolveServer**：`server.ts` 导出的 `(file) => LspServerInfo | undefined` 选择器——从 file 扩展名（无扩展名用全文件名）在 `SERVERS` 里按声明序找第一个 `extensions.includes(ext)` 的 server（#304 决策1/2）。
- **LANGUAGE_EXTENSIONS**：`language.ts` 的 `Record<ext, languageId>` 表——didOpen 时告诉 server 目标文件语言（#304 决策4）；与 `server.extensions`（dispatch 匹配）是两个独立职责。
- **PROBE_TARGETS**：`scripts/lsp-probe-targets.ts` 的夹具表——每门语言 `{serverId, targetFile, line, char}`，probe 遍历 `SERVERS` × 夹具跑 9-op 烟测（#307 Q3）。

## Architectural Constraints

| ADR                              | 引用形式                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| ADR-0004（6 工具集 + 契约 X/Y1） | 10 件 LSP 工具已 append（#251）；本 spec 不新增工具，只改 dispatch 内部；wire 守契约 Y1                                   |
| ADR-0006（封顶 20000）           | 9 件输出仍受 20000 字符封顶；不为 LSP 单独立例外                                                                          |
| ADR-0012（per-ticket loop）      | plan 中每个 `[implementation]` bullet 嵌入 per-ticket loop（tdd → typecheck+tests → code-review → verification → commit） |

## ACR Verdict（architecture-change-reviewer · 5-verdict gate）

> 受影响文件 12 件（7 源 + 4 测试 + 1 脚本）≥ 3 件门槛达成。

```text
bounded-context-guardian:     yes — src/harness/lsp/ 内部泛化（types/server/language/client 同上下文）；aci/tools/lsp.ts 十件 handler 零改动（经 getClient 间接消费）；permission/ 零改动 + DEFAULT_BY_CATEGORY read-only → allow 路径成立；scripts/lsp-probe.ts 消费 SERVERS 但只读（probe 不是生产装配路径）。
defensive-contract-validator: yes — 5 边界类全覆盖（empty=无扩展名 file / negative=无匹配 server / overflow=SERVERS 空数组 / concurrent=dispatch 并发 / exception=spawn 失败）。overflow 与 concurrent 两类的显式测试行已补入 Testing Strategy 表（§Testing Strategy），resolveServer 无匹配 → undefined graceful；SERVERS.find 空数组 → undefined；NearestRoot exclude 可选 + 上界 stop 保留。
error-handling-enforcer:      yes — spawn 失败 broken.add(key) + inflight 释放（沿用 #251）；resolveServer 无匹配 → undefined（handler 转纯字符串）；venv 探测失败 → initialization undefined（pyright 无 pythonPath 仍可 spawn）；4 门新语言 spawn 用 resolveNpmBin 探测，缺失 → undefined 走 broken；cancel 走 $/cancelRequest 不杀进程。
complexity-anti-drift:        yes — server.ts 扁平多 Info + SERVERS + resolveServer；resolveServer 单行 find；languageIdFor 查表零分支；PROBE_TARGETS 纯数据表；dispatch 无嵌套膨胀；NearestRoot exclude 可选一参。
minimal-change-verifier:       yes — 1 逻辑任务（泛化 4 接缝 + 首期 4 语言）；getClient 改 2 行（`?? resolveServer`）；types.ts 改 1 字段（initialization 可选化）；server.ts 加 4 Info + SERVERS + resolveServer；language.ts 新 1 表；client.ts 现有 fixture 零迁移；4 个新 devDep 有意新增（混合供给决议）；不加新 ACI 工具（ACI_TOOLSET_NAMES 仍 21 件）。
```

**Gate 结果：5/5 yes，hand to writing-plans。**

- affects: src/harness/lsp/types.ts
- affects: src/harness/lsp/server.ts
- affects: src/harness/lsp/language.ts (新)
- affects: src/harness/lsp/client.ts
- affects: scripts/lsp-probe.ts
- affects: scripts/lsp-probe-targets.ts (新)
- affects: package.json / package-lock.json
- affects: tests/harness/lsp/server.test.ts
- affects: tests/harness/lsp/language.test.ts (新)
- affects: tests/harness/lsp/client.test.ts
- affects: specs/302-lsp-multilang.md (本 spec)
