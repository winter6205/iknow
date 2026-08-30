# Spec: 251-lsp-tool — ACI LSP 工具（代码跳转 · TS 首期 · 自建客户端）

> 输入 = [map #245 Decisions so far](https://github.com/winter6205/iknow/issues/245)（#246/#247/#248/#249/#250 已 close）+ #251（本票）复核决议。
> 范围 = ACI 工具层加 10 件 LSP 工具（9 operation + `lsp_diagnostics`），自建 LSP 客户端，TS 单语言首期。
> 落地 = spec → ACR → writing-plans，本 spec 不含实施代码。

## Objective

给 iknow harness 增加 **ACI LSP 工具（代码跳转）**，供 agent 在 loop 内做符号定位。这是 map #220「8 件之后首批新工具」的 LSP 分支，也是 spec 224 扩展通路（tool_search/lazy/discover）实施后的**第一波真实住客**。

**用户**：iknow 单用户单项目本机产品；CLI `chat` / `ask` / TUI / `serve` 四个入口共享同一份 ACI registry（`build-engine.ts` SSOT）。

**要建什么**：

1. **自建 LSP 客户端**——`src/harness/lsp/` 新目录，TS 单语言首期。
2. **LSP 工具 append**（11 → 21 件 ACI 工具，10 件新增）：
   - 9 件 operation 工具：`lsp_definition` / `lsp_references` / `lsp_hover` / `lsp_document_symbol` / `lsp_workspace_symbol` / `lsp_go_to_implementation` / `lsp_prepare_call_hierarchy` / `lsp_incoming_calls` / `lsp_outgoing_calls`（#248 B 档决议；shared position schema）
   - `lsp_diagnostics` 独立顶层工具（#250 决议，不在 9 件内）
   - > **计数勘误（2026-08-08 实施确认）**：早期草稿写「9 件 = 8 operation + lsp_diagnostics」且「11 → 20」，但 operation 清单实际列出 9 个名字。实施按清单全量导出 9 operation + lsp_diagnostics = 10 件，总量 11 → 21。S1/S4/S5/Glossary/ADR-0004 引用已同步为 9 件 operation / 21 件总量。
3. **引擎内部联动**：`edit_file` 成功后自动给 tsserver 发 invalidation，agent 无需感知（Q2 决议）。

**成功形态**：agent 在 loop 内可对 TS/JS 文件做符号定位（定义跳转/找引用/悬停/大纲/实现/调用图/诊断拉取），tsserver 常驻复用消除 cold start，`permission/` 零改动，9 件全走契约 X/Y1。

## Tech Stack

| 项             | 取值                                            | 备注                                                                                               |
| -------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 语言           | TypeScript（与 harness 一致，5.x ESM）          | —                                                                                                  |
| 运行时         | Node.js                                         | —                                                                                                  |
| LSP 客户端底层 | `vscode-jsonrpc`（`node` 入口）                 | **新增依赖**；提供 requestId/响应路由/cancel 协议层（Q1/Q3 决议）                                  |
| LSP 翻译层     | `typescript-language-server`                    | **新增依赖**（项目 devDependencies）；保留翻译层 + `tsserver.path` 本地化（#247 Q1 REJECT 自写桥） |
| TS 内核        | `typescript`（已依赖 5.9.3）                    | tsserver = `typescript/lib/tsserver.js`（零额外 dep）                                              |
| 进程管理       | `child_process.spawn`                           | 标准库                                                                                             |
| 测试           | vitest                                          | `npm test`                                                                                         |
| 新依赖         | `vscode-jsonrpc` + `typescript-language-server` | LSP 路径核心依赖，**不守** spec 224 的零新依赖守门（#251 票 Ask first 已列）                       |

## Commands

```bash
# Build
npm run typecheck       # 入口文件类型校验

# Test（产品主路径）
npm test                # vitest: unit + harness + integration

# Lint
npm run lint            # 项目根 lint 入口

# LSP 探针（真实 tsserver 烟测）
npm run probe:lsp       # 脚本化 spawn tsserver + 9 operation 烟测（对照 sandbox-probe.ts）
```

## Project Structure

新增 / 改动点：

| 路径                                   | 形态        | 角色                                                                                                                                                                                                                  |
| -------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/harness/lsp/`                     | **新目录**  | LSP 客户端层                                                                                                                                                                                                          |
| `src/harness/lsp/server.ts`            | **新**      | LSP server 声明（`Info` 类型 + TS 单语言：`id`/`extensions`/`root`/`spawn`），保留扁平结构（#247 Q2 决议不拆）；`NearestRoot`（#247 Q6 决议保留，TS lockfile pattern + deno.json exclude，上界 stop=`ctx.directory`） |
| `src/harness/lsp/client.ts`            | **新**      | JSON-RPC over stdio（`vscode-jsonrpc/node`）；`getClient(root,id)` 缓存 + broken + inflight 三件套（Q1/Q8 决议）                                                                                                      |
| `src/harness/lsp/notifier.ts`          | **新**      | edit_file 联动：`invalidate(file)` 给 tsserver 发 `workspace/xrefs`（Q2/A13 决议）                                                                                                                                    |
| `src/harness/aci/tools/lsp.ts`         | **新**      | 10 件 LSP 工具工厂（9 operation + `lsp_diagnostics`）；handler 极薄（Q3 决议）                                                                                                                                        |
| `src/harness/aci/tools/registry.ts`    | 改动        | `ACI_TOOLSET_NAMES` append 9 件；`createDefaultAciRegistry` 注册；`CreateDefaultAciRegistryOptions` 加可选 `onEdit` 透传给 `createEditFileTool`                                                                       |
| `src/harness/aci/tools/edit-file.ts`   | 改动        | 工厂签名扩参：`createEditFileTool(root, opts?: { onEdit?: (file: string) => void })`；handler 成功路径 `opts.onEdit?.(absPath)`；handler 返回仍是纯字符串（守契约 Y1）（Q2/A13 决议）                                 |
| `src/harness/build-engine.ts`          | 改动        | 装配 `lsp` 工具集 + 构造 `notifier.invalidate` 作为 `onEdit` 透传给 `createDefaultAciRegistry`                                                                                                                        |
| `src/harness/permission/`              | **不动**    | 零改动（#249 决议）                                                                                                                                                                                                   |
| `src/harness/aci/tools/tool-search.ts` | **不动**    | 保持现状（lsp 不与 tool_search 同名）                                                                                                                                                                                 |
| `tests/harness/lsp/client.test.ts`     | **新**      | vscode-jsonrpc mock：requestId/响应路由/cancel                                                                                                                                                                        |
| `tests/harness/aci/lsp.test.ts`        | **新**      | 9 件 handler 单测：输入校验/无匹配/共享 schema                                                                                                                                                                        |
| `tests/harness/aci/registry.test.ts`   | 改          | `ACI_TOOLSET_NAMES` 锁 21 件                                                                                                                                                                                          |
| `scripts/lsp-probe.ts`                 | **新**      | 真实 tsserver 烟测：spawn + 9 operation + diagnostics                                                                                                                                                                 |
| `specs/251-lsp-tool.md`                | **本 spec** | —                                                                                                                                                                                                                     |

## Code Style

### `server.ts` — 扁平 `Info` 声明 + NearestRoot

```ts
// NearestRoot（#247 Q6：保留，不砍）。从 path.dirname(file) 向上找第一个
// 含 lockfile 的祖先当 root，exclude deno.json；找不到回 ctx.directory。
// 上界 stop=ctx.directory 防止跨出工作目录。
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

### `client.ts` — `getClient()` 三件套缓存

```ts
// #247 Q8：复用三件套（root+id 缓存 / broken 记忆 / inflight 去重）
// iknow 没有 InstanceContext；ctx 由 lsp 模块自己持有 {directory, root}，
// build-engine 装配时把 process.cwd() 作为 directory 透入。
export interface LspCtx {
  readonly directory: string; // 上界 stop（NearestRoot 不允许跨出）
}

const clients = new Map<string, LspClient>();
const broken = new Set<string>();
const inflight = new Map<string, Promise<LspClient | undefined>>();

export async function getClient(
  file: string,
  ctx: LspCtx
): Promise<LspClient | undefined> {
  const server = Typescript; // TS 单语言首期
  const root = await server.root(file, ctx);
  if (!root) return undefined;
  const key = `${root}:${server.id}`;
  if (broken.has(key)) return undefined;
  if (clients.has(key)) return clients.get(key);
  if (inflight.has(key)) return inflight.get(key); // 并发去重：共享一次 spawn

  const task = spawnClient(server, root, ctx)
    .then((c) => (c ? (clients.set(key, c), c) : (broken.add(key), undefined)))
    .finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}
```

### `aci/tools/lsp.ts` — 9 件 handler 极薄

```ts
// #247 Q3（MCP 无状态思路）：handler 只做参数校验 + await client.sendRequest，
// per-request 状态归 vscode-jsonrpc（requestId + 响应路由）。
// 9 件共享同一 position schema {file, line, character}（#248 决议）。
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
      isConcurrencySafe: false, // 有状态 LSP 实例；loop 串行天然无并发（#249）
      interruptBehavior: "cancel" as const, // 走 $/cancelRequest，不杀 tsserver（Q2/A9）
      timeoutTier: "default" as const, // 30s（#249）
    },
    handler: async (input) => {
      const params = parse(input); // ajv 校验
      const client = await getClient(params.file, ctx); // 按需 spawn + 复用
      if (!client) return "(no LSP server available for file)";
      const result = await client.sendRequest(method, toParams(params)); // vscode-jsonrpc
      return stringify(result); // 契约 Y1：纯字符串
    },
  });
}
// 10 件 = 9 operation + lsp_diagnostics（#250）
```

### `aci/tools/edit-file.ts` — `onEdit` opts 注入（Q2/A13 决议）

```ts
// Q2/A13：edit_file 成功 → 发出「文件编辑完成」事件，由装配层接 LSP notifier。
// edit_file handler 零 LSP 知识（opts.onEdit 是个通用回调，不知道谁消费）。
// handler 返回仍是纯字符串（守契约 Y1，不暴露结构体）。
export interface EditFileOpts {
  readonly onEdit?: (file: string) => void;
}

export function createEditFileTool(
  root: string,
  opts?: EditFileOpts
): AciToolDef {
  const handler = async (input: unknown): Promise<unknown> => {
    // ... 原有 readFile / lintPatch / countOccurrences 不变 ...
    await writeFile(absPath, replaced, "utf8");
    // ★ 写入成功后、返回前调 opts.onEdit
    opts?.onEdit?.(absPath);
    return `[edit_file] replaced ${occurrences} occurrence(s) in ${absPath}`;
  };
  // ... 冻结返回不变 ...
}
```

### `aci/tools/registry.ts` + `build-engine.ts` — `onEdit` 透传

```ts
// registry.ts: CreateDefaultAciRegistryOptions 加 onEdit 字段，
// 透传给 createEditFileTool(root, { onEdit: options.onEdit })
export interface CreateDefaultAciRegistryOptions {
  readonly env: Pick<IknowEnv, "web">;
  readonly sandboxRoot: string;
  readonly memoryDir?: string;
  readonly onEdit?: (file: string) => void; // ★ LSP 联动缝（spec 251）
}

// build-engine.ts: 装配 lsp 工具时构造 notifier.invalidate 作为 onEdit
const lspNotifier = createLspNotifier(/* ... */);
const registry = createDefaultAciRegistry({
  env,
  sandboxRoot,
  memoryDir,
  onEdit: (file) => lspNotifier.invalidate(file), // ★ 装配层接 LSP
});
```

## Testing Strategy

| 等级        | 范围                                                                                                                           | 工具                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| Unit        | 9 件 operation handler：输入校验（缺 line/character）、ajv 拒非法类型、无 client 返回 `"(no LSP server available)"`、wire 形态 | vitest stub             |
| Unit        | `lsp_diagnostics` handler：latest-wins map、severity 过滤、每文件封顶 20、`<diagnostics file>` XML                             | vitest                  |
| Unit        | `client.ts`：vscode-jsonrpc mock 验证 requestId 唯一 + 响应路由（MCP 无状态契约）                                              | vitest mock             |
| Unit        | 三件套缓存：同 root 复用 / broken 记忆不重试 / inflight 并发去重                                                               | vitest                  |
| Unit        | 契约 X 反例：mock handler 返回 `{truncated:false,total:100}`，断言 executor 自截 20000 不信字段                                | vitest（对齐 ADR-0006） |
| Unit        | 契约 Y1 反例：mock handler 返回对象，断言 executor 按 plain-string 处理                                                        | vitest                  |
| Integration | `scripts/lsp-probe.ts`：真实 spawn tsserver + 9 operation 烟测 + diagnostics                                                   | tsx script              |
| Integration | edit_file 联动：edit 后 `onEdit` 被调 + notifier 发 invalidation                                                               | vitest                  |

**覆盖率门槛**：handler 单测 + 契约 X/Y1 反例行覆盖 ≥ 90%；integration 覆盖完整「按需 spawn → operation → 复用」路径。

**`npm test` = 唯一门**：交付门槛 = `npm test` 退出 0 + `npm run typecheck` 退出 0。

## Boundaries

### Always

- `permission/` **零改动**（#249 决议）；`category=read-only` → DEFAULT_BY_CATEGORY → allow
- 字符串 wire（契约 Y1 守门）；9 件 handler 永不返回结构化 payload
- 中断走 `$/cancelRequest`，**不杀 tsserver 进程**（Q2/A9）
- tsserver 常驻 + 复用三件套（root+id / broken / inflight），按需 spawn，不预热、不留 env flag（#247 Q4）
- 装配期三闸门（自举守卫 / `mcp__` 命名空间防撞 / `ACI_TOOLSET_NAMES` append-only 纪律）
- LSP 工具名不与 `tool_search` 同名、不以 `mcp__` 起头

### Ask first

- 加新依赖 / 改 lockfile（`vscode-jsonrpc` + `typescript-language-server` 是**有意新增**，非违反）
- 改 `permission/` 任何文件（本期零改动，违反需显式确认）

### Never

- 自写 tsserver 桥（#247 Q1 REJECT；破坏 LSP 多语言抽象）
- 拆 `server.ts` 为 registry/spawn/client 三文件（#247 Q2 REJECT；保留扁平）
- 删 `NearestRoot`（#247 Q6 REJECT；多项目仓库真场景）
- 杀 tsserver 进程来 cancel（Q2/A9）
- 预热默认开 / 加预热 env flag（#247 Q4）
- 改 `permission/` 模块任何文件
- 跨 session 持久化 LSP client 缓存（A16：同进程同生）

## Success Criteria

全部为二元（是/否），每条对应可执行的检查：

| #   | Criterion                         | Check                                                                                                              |
| --- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| S1  | 10 件 LSP 工具全量进 prompt       | `tests/harness/aci/registry.test.ts` 锁 `ACI_TOOLSET_NAMES.length === 21` 含 11 件原工具                           |
| S2  | `server.ts` 保留扁平结构          | 无 `registry.ts` / `spawn.ts` 拆分文件；`server.ts` 含 `Info` + spawn 内联                                         |
| S3  | `NearestRoot` 保留                | `server.ts` 含 `NearestRoot(TS_LOCKFILES, TS_EXCLUDE)` 且上界 stop=ctx.directory                                   |
| S4  | 9 件 operation handler 输入校验   | 单测：缺 line/character → 拒；ajv 拒非法类型；无 client → `"(no LSP server available)"`                            |
| S5  | 9 件共享 position schema          | 单测：`lsp_definition` / `lsp_references` 等 inputSchema 含 `{file,line,character}`                                |
| S6  | `lsp_diagnostics` wire = 纯字符串 | 单测：返回 `<diagnostics file>` XML；severity=1 过滤；每文件封顶 20                                                |
| S7  | 契约 X 反例被锁                   | 单测：mock handler 输出 `{truncated:false,total:100,text:"x".repeat(25000)}`，断言 executor 自截 20000（ADR-0006） |
| S8  | 契约 Y1 反例被锁                  | 单测：mock handler 返回对象 `{code,stdout,stderr}`，断言 executor 按 plain-string 处理                             |
| S9  | 复用三件套                        | 单测：同 root 复用不重 spawn / broken 记忆不重试 / inflight 并发去重                                               |
| S10 | `permission/` 零改动              | `git diff --stat src/harness/permission/` 输出空                                                                   |
| S11 | edit_file 联动                    | 单测：edit_file 成功后 `onEdit` 被调 + notifier 发 invalidation                                                    |
| S12 | 真实 tsserver 烟测                | `npm run probe:lsp` 退出 0：spawn + 9 operation + diagnostics 全通                                                 |
| S13 | CI 主路径全绿                     | `npm test` 退出 0；`npm run typecheck` 退出 0                                                                      |
| S14 | LSP client 缓存同进程同生         | 无跨 session 持久化代码路径；进程退出 → client dispose                                                             |

## Open Questions

本期不答（已在范围外 / 等后续地图推动），仅声明不静默：

- **多语言扩展触发时机**：Python（pyright）/ Rust（rust-analyzer）何时进、什么信号触发（等 TS 首期实测精度/效率后）
- **预热 env flag 默认值**：复用缓存后的实测数据，决定预热是否默认开（本期不做、不留 flag）
- **`rename` operation 是否进后续期**：首期明确不含；重审时机 = write 类 LSP 政策定型 + permission 规则演进
- **LSP 有状态工具与 executor「无状态假设」的张力**：per-request 状态隔离由 vscode-jsonrpc 承担（Q3 决议），实测验证待实施后
- **人类 UI 代码跳转**：IDE 的事，非 agent 产品
- **LSP 联动降级**：当前 spec 形式下，`edit_file` handler 内 `opts?.onEdit?.(absPath)` 若抛错（如 notifier 已 dispose），整次 edit_file 会走 `execution_failed`。是否用 try/catch 包一层使 LSP 联动降级（不影响主路径写盘），留给实施时按经验决定
- **部署前置：`npm install` 跑通**：当前 `vscode-jsonrpc` / `typescript-language-server` 未安装，`npm run probe:lsp` 与 LSP 相关单测在 `npm install` 前无法跑——属部署前置条件，plan 任务的早期 bullet 应设显式 checkpoint

## Glossary

> 来自 `docs/CONTEXT.md`（spec 引用，不重定义）。

- **ACI tool set**：Harness 装配层（`src/harness/aci/`）注册的工具集；SSOT 工厂 = `src/harness/aci/tools/registry.ts:createDefaultAciRegistry`；当前 11 件，本 spec 后 21 件。
- **Loop Engine**：Foundation 的状态机运行内核，驱动模型 → 工具 → 真实结果 → 下一轮模型 → 明确停止；位于 `src/harness/`。
- **executor truncation authority**（契约 X，ADR-0004 / ADR-0006）：executor 是工具结果截断元数据的唯一权威——自测序列化后字符数、自截断、自合成标记；工具返回纯数据、不带 truncated/total 元字段。
- **plain-string tool output**（契约 Y1，ADR-0004）：生产工具输出为纯字符串；bash 是唯一例外保留结构化 `{code, stdout, stderr}`（Y1b）。
- **append-only messages**：Foundation 的权威 Anthropic 原生会话历史，是唯一事实来源；消息只能以不可变追加（`[...prev, x]`）更新。
- **LoopTrace**：`run()` 的第二返回面 `{ result, trace }`—— A 层结构元数据（严格不含 payload）；diagnostics payload 走 messages 权威历史（#250 决议）。

> 本 spec 引入的新术语（待实施完成后经 `domain-modeling` 落 `docs/CONTEXT.md`；当前作 spec 内工作术语使用）：

- **LSP client**：`vscode-jsonrpc` 驱动的 JSON-RPC over stdio 客户端，按 root+id 复用（MCP 无状态协议思路：协议层无状态、tsserver 有状态）。
- **getClient() 三件套**：root+id 缓存 `Map` / broken 记忆 `Set` / inflight 去重 `Map`——复用消除 cold start，spawn 失败不重试，并发请求共享一次 spawn。
- **NearestRoot**：从 `path.dirname(file)` 向上找含 lockfile 的最近祖先当 LSP root；上界 stop=ctx.directory。
- **onEdit seam**：`createEditFileTool(root, opts?: { onEdit?: (file: string) => void })` 工厂 opts 注入——handler 写入成功后调 `opts.onEdit?.(absPath)`，handler 内部零 LSP 知识；`CreateDefaultAciRegistryOptions` 加 `onEdit` 字段透传；`build-engine.ts` 装配时把 `lspNotifier.invalidate` 作为 `onEdit` 注入。

## Architectural Constraints

| ADR                              | 引用形式                                                                           |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| ADR-0004（6 工具集 + 契约 X/Y1） | 10 件 LSP 工具作为第 12-21 件 append；wire 守契约 Y1；handler 不带截断字段守契约 X |
| ADR-0006（封顶 20000）           | 9 件输出也受 20000 字符封顶；不为 LSP 单独立例外                                   |

## ACR Verdict（architecture-change-reviewer · 5-verdict gate）

> 受影响文件 11 件（7 源 + 4 测试 + 1 脚本）≥ 3 件门槛达成。

```text
bounded-context-guardian:     yes — src/harness/lsp/ 与 aci/tools/ 之间无反向依赖；lsp/notifier.invalidate 仅在 build-engine 装配时通过工厂闭包接进 registry；handler 内部零 LSP 知识；permission/ 零改动 + DEFAULT_BY_CATEGORY read-only → allow 路径成立。
defensive-contract-validator: yes — 5 边界类全覆盖（empty / negative / overflow / concurrent / exception）；契约 X/Y1 反例 S7/S8 显式 lock；handler inputSchema 走 ajv 严格编译同源校验；edit_file 联动新增 S11 integration。
error-handling-enforcer:      yes — spawn 失败 broken.add(key) + inflight 释放；handler 无 client 返明确字符串；cancel 走 $/cancelRequest 不杀进程；契约 Y1 强制纯字符串；edit_file opts?.onEdit?.(absPath) 写入成功后调（失败路径不触发避免误通知）；handler 错误仍 throw ToolExecutionError 走 executor 转 execution_failed，无静默吞错。
complexity-anti-drift:        yes — server.ts 扁平 Info + NearestRoot + spawn 内联；client.ts 三件套 Map/Set/Map 各一职责；handler makeOperationTool 工厂统一 9 件；POSITION_SCHEMA 单次声明共享；edit_file opts 单字段 EditFileOpts；registry 透传 1 行；无嵌套膨胀、无参数爆炸。
minimal-change-verifier:      yes — 1 逻辑任务（9 件 LSP 工具 + 自建客户端 + edit_file 联动）；seam 改走 edit-file.ts 工厂扩参 1 个可选 opts + registry.ts 接口加 1 个字段 + build-engine.ts 装配 1 行 closure；loop-engine.ts 零改动；permission/ 零改动；2 个新依赖有意新增；不预热、不留 env flag；接口向后兼容（onEdit optional）不破现有 stub 装配测试。
```

**Gate 结果：5/5 yes，hand to writing-plans。**

- affects: src/harness/lsp/server.ts (新)
- affects: src/harness/lsp/client.ts (新)
- affects: src/harness/lsp/notifier.ts (新)
- affects: src/harness/aci/tools/lsp.ts (新)
- affects: src/harness/aci/tools/registry.ts
- affects: src/harness/aci/tools/edit-file.ts
- affects: src/harness/build-engine.ts
- affects: tests/harness/lsp/client.test.ts (新)
- affects: tests/harness/aci/lsp.test.ts (新)
- affects: tests/harness/aci/registry.test.ts
- affects: scripts/lsp-probe.ts (新)
