# Spec: 337-skill-mcp-extension — ACI 扩展源：skill 工具 + MCP 客户端（发现 · 加载 · 执行）

> 输入 = [map #337 Decisions so far](https://github.com/winter6205/iknow/issues/337)（R1 #338 / R2 #339 / G1 #340 / G2 #341 / G3 #342 Resolution）。
> 范围 = skill 与 MCP 两种扩展源被 agent 发现 / 加载 / 执行的全链路接线 + 验收；不含 remote MCP/OAuth、allowed-tools 强制、`/cmd` UI（fog）。
> 落地 = spec → ACR → writing-plans，本 spec 不含实施代码。

## ASSUMPTIONS（假设闸门）

编号列出本 spec 的全部隐含假设。1–12 已由 tracker 决议锚定（来源在条目内）；13–14 是 spec 层新增假设，operator 已授权自审（「你自己审查自己写完」），按推荐面写入并在 §Open Questions 留复核口。

1. skill 工具形态 = `{name}` / read-only / lazy:false / timeoutTier:fast（G1 Q1）— **confirmed by #340**
2. frontmatter 生效三字段 name/description/disable-model-invocation；description 1536 截断+warn（G1 Q2）— **confirmed by #340**
3. disable-model-invocation = 装配期单层隐形，无 handler 拒绝（G1 Q3）— **confirmed by #340**
4. 双发现通道：`<available_skills>` 推（全量非 disabled 渲染，opt-in 子集降级留 fog）+ `skill_search` 拉；tool_search 合同不动（G1 Q4 / #337 Destination 修订）— **confirmed by #340**
5. 发现路径 iknow 化三级：`~/.iknow/skills` → `<cwd>/.iknow/skills` → `IKNOW_SKILL_DIRS`，同名后扫覆盖，不扫 `.claude/skills`；现有 5 skill git mv 迁移 + arthurpower 4 种子复制（G1 Q6）— **confirmed by #340**
6. MCP config = iknow 自有两级 `~/.iknow/mcp.json` + `.iknow/mcp.json`，条目级覆盖；不读 `~/.claude.json` / `.kiro`（G2 D1）— **confirmed by #341**
7. MCP 工具全 lazy / category:write / isConcurrencySafe:false / interruptBehavior:cancel；wire structuredContent 优先；isError 返文本不抛（G2 D2）— **confirmed by #341**
8. MCP 装配 = 启动连后台化不阻塞 + registerExternal 动态缝 + list_changed 热更新；Gate 3 豁免 / Gate 2 强制（G2 D3）— **confirmed by #341**
9. MCP 生命周期：注册超时 30s / 调用超时 long 档 30min + resetTimeoutOnProgress / shutdown manager 自持（client.close + stdio 子孙 SIGTERM，接线点 RuntimeBundle 生命周期钩子）/ onclose→failed 不重连（G2 D4）— **confirmed by #341**
10. 装配缝：`skill` + `skill_search` append `ACI_TOOLSET_NAMES`（21→23）；skill 三级目录装配期同步扫描建全量内存索引；MCP 不碰静态名单（G3 Q1）— **confirmed by #342**
11. 四入口：skill 全装配；MCP 仅 chat/serve/TUI，ask 剥离（条件化形态）（G3 Q2）— **confirmed by #342**
12. 测试金字塔：单测 MCP 用 stub client、skill 用 tmp fixture SKILL.md；集成用新造最小 fixture stdio MCP server；E2E 验收 = stub-model 脚本化全链路（新造 fixture skill + 真实 codebase-memory-mcp）进 CI + 真实 key 冒烟不入 CI（G3 Q3/Q5）— **confirmed by #342**
13. **（spec 层新增，ACR 复核后修订）** `<available_skills>` 系统段 = `assembleIdentityContext` 的**加性段**（assemble.ts:104-117 既有先例：toolList 段 / projectPath 段均在 LOCKED 循环之后追加，不触碰 `IKNOW_ASSEMBLY_ORDER`），不用「往 LOCKED 数组 append」路径。skill 清单进程内常量（无 watch 热更新），跨 turn 字节稳定，守 KV 缓存契约。→ **自审通过；复核口见 Open Questions OQ1**
14. **（spec 层新增）** E2E A 用真实 codebase-memory-mcp = 本机依赖：CI 机器未装该 server 时该验收文件**显式 skip 并打印原因**（遵循 .qoder/rules/test.md 的 Not run 记录格式），不静默通过、不算失败。→ **自审通过；复核口见 Open Questions OQ2**
15. **（ACR 裁决新增）** 实施不按单 commit 落地：按依赖序拆 ≥4 个 commit（①registry 动态缝 + Gate 3 豁免；②skill 扩展源 + identity 加性段；③MCP config/adapter/manager + shutdown 接线；④seed 迁移 git mv 独立资源 commit）。工作树已存在的 `@types/node` 未提交漂移（package.json / package-lock.json）与本 spec 无关，实施前先单独处理或 stash 隔离。— **confirmed by ACR verdict（minimal-change-verifier）**

## Objective

把 iknow harness 的 ACI 工具层从「21 件静态工具 + 已接线的 lazy/discover 机制（224 spec）」升级为「**skill 与 MCP 两种扩展源都能被 agent 发现、加载、执行**」：

1. **skill 扩展源**：新增 `skill` / `skill_search` 两件静态 ACI 工具 + 装配期三级目录扫描建索引 + `<available_skills>` 系统段渲染。模型链路 = L0 常驻清单感知 → `skill_search({query})` 定位 → `skill({name})` 注入正文。
2. **MCP 扩展源**：新增 MCP 客户端模块（`@modelcontextprotocol/client@2.0.0`，依赖变更已获 operator 显式授权），两级自有 config，后台连接 + `registerExternal` 动态追加，工具以 `mcp__<server>__<tool>` 命名、全 lazy，走既有 tool_search discover 通道。
3. **验收**：一个本地 skill 与一个 MCP server（codebase-memory-mcp）都能在 `chat` 里被发现并执行（skill 链 = 常驻清单推 + skill_search 拉 → skill 工具；MCP 链 = tool_search discover → `mcp__*` 执行）。

**用户**：iknow 单用户单项目本机产品；chat / ask / serve / TUI 四入口共享 `buildHarnessEngine` SSOT 装配。

**成功形态**：`npm test` 全绿含三层新测试；`chat` 真实会话中 skill 与 MCP 工具可发现可执行；`ask` 入口不含任何 MCP 工具与连接行为。

## Tech Stack

| 项          | 取值                                                                                                                 | 备注                                                                                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 语言        | TypeScript（5.x ESM，与 harness 一致）                                                                               | —                                                                                                                                                                      |
| 运行时      | Node.js                                                                                                              | —                                                                                                                                                                      |
| MCP SDK     | `@modelcontextprotocol/client@2.0.0`（Client + connect + listTools + callTool，stdio 子路径，list_changed 内置回调） | **lockfile 变更已获 operator 显式授权**（R2 / map Notes）；仅此一个新依赖                                                                                              |
| Schema 校验 | ajv `strict: true`（既有）                                                                                           | **实现前必探**：ajv strict 与 MCP inputSchema 的 `$ref`/`anyOf` 兼容性（R2 未实测风险 / G2 移交项）；探针失败 → 在 MCP 工具注册路径做 schema 归一化，不改全局 ajv 配置 |
| 测试        | vitest                                                                                                               | `npm test`                                                                                                                                                             |

## Commands

```bash
# Build
npm run typecheck       # 类型校验

# Test（产品主路径）
npm test                # vitest: unit + harness + integration

# Lint
npm run lint

# Sandbox 探针（若触碰 harness/sandbox；本 spec 预期不触碰）
npm run probe:sandbox
```

本 spec 不引入新命令。

## Project Structure

| 路径                                                                                                           | 形态             | 角色                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/harness/skill/scanner.ts`                                                                                 | **新**           | 三级目录扫描 + frontmatter 解析（生效三字段 + 存档六字段）+ 兜底规则（G1 Q2/Q6）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `src/harness/skill/catalog.ts`                                                                                 | **新**           | 全量内存索引（name → {description, dir, disabled, 存档字段}）；常驻清单派生（非 disabled 全量、名字序、无 description 不进清单）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `src/harness/skill/body.ts`                                                                                    | **新**           | `skill` handler 正文装配：frontmatter 剥离 + `Base directory` 行 + `<skill_files>` 采样（G1 Q5）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `src/harness/aci/tools/skill.ts`                                                                               | **新**           | 第 22 件 `AciToolDef` 工厂（`name="skill"`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/harness/aci/tools/skill-search.ts`                                                                        | **新**           | 第 23 件 `AciToolDef` 工厂（`name="skill_search"`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `src/harness/mcp/config.ts`                                                                                    | **新**           | 两级 config 读取 / union / 条目级覆盖 / 判别联合校验 / 坏条目跳过+warn（G2 D1）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/harness/mcp/adapter.ts`                                                                                   | **新**           | MCP tool → `AciToolDef`（命名 sanitize + 元数据四元组 + wire 形态，G2 D2）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `src/harness/mcp/manager.ts`                                                                                   | **新**           | 连接生命周期 / 状态机 pending·connected·failed·disabled / registerExternal 接线 / list_changed 重注册 / shutdown（G2 D3/D4）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/harness/aci/tools/registry.ts`                                                                            | 改动             | `ACI_TOOLSET_NAMES` 末尾 append `skill` / `skill_search`；factories 联动（Gate 3 derived-from-map 不破）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/harness/aci/aci-registry.ts`                                                                              | **改动（新缝）** | **新增 `registerExternal(defs)` 动态注册缝——当前代码中不存在（R2 为研究提案，src/ grep 零命中），本 spec 声明其契约**：缝 = `createAciRegistry` 闭包内的可变追加通道；追加项过 Gate 2 防撞 + 查重 + 同 ajv 实例编译 validator（015 同源 schema 强制）；追加后 `catalog.get/all`、`discover`、`visibleSchemas`（lazy 默认不进 prompt，经 tool_search discover 晋升）均可见。**`inner` 冻结快照不动**：`RegistryImpl.list()` 保持构造期快照语义（tools/registry.ts:76-79），动态工具不进 list() 回退路径——产品路径 promptTools 恒走 `visibleSchemas`，回退路径只覆盖静态集（写入 Boundaries Always）。动态工具的按名执行经 catalog→executor 分发解析（集成测试锁死）。Gate 3 只锁静态名单工厂路径，动态路径豁免（G2 D3 决议）。 |
| `src/harness/build-engine.ts`                                                                                  | 改动             | 装配期 skill 扫描 + catalog 入参；MCP manager 按 surface 条件化（ask 不建）；`BuiltEngine` 透出 manager shutdown 句柄                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `src/harness/identity/assemble.ts`                                                                             | 改动             | `<available_skills>` **加性段**：LOCKED 段循环之后追加（toolList / projectPath 同款先例，assemble.ts:104-117），不触碰 `IKNOW_ASSEMBLY_ORDER`；空清单显式语句（假设 13）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/cli/runtime.ts` / RuntimeBundle 生命周期钩子                                                              | 改动             | MCP manager.shutdown() 接线点（进程退出 / server 停机）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `.claude/skills/* → .iknow/skills/*`                                                                           | git mv           | 现有 5 skill 迁移（G1 Q6）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `.iknow/skills/{systematic-debugging,verification-before-completion,test-driven-development,session-handoff}/` | 复制             | arthurpower 种子 4 件（session-handoff 带 `disable-model-invocation: true`，验隐形）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `tests/fixtures/skills/echo/SKILL.md`                                                                          | **新**           | E2E 验收最小 fixture skill（G3 Q3）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `tests/fixtures/mcp-server/`                                                                                   | **新**           | 最小 fixture stdio MCP server（集成层，G3 Q5）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `tests/skill/` `tests/mcp/`                                                                                    | **新**           | 单测（见 Testing Strategy）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `tests/integration/mcp-chain.test.ts` 等                                                                       | **新**           | 集成：fixture server + registerExternal + tool_search discover                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `tests/e2e/skill-mcp-acceptance.test.ts`                                                                       | **新**           | E2E A：stub-model 脚本化全链路（见 Testing Strategy）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## Code Style

沿用 `src/harness/aci/` 既有形态——工厂函数 + `AciToolDef` 冻结对象 + fail-fast 装配。真实片段示例（wire 形态真值）：

```ts
// skill-search.ts — 第 23 件工具工厂（G1 Q4 wire 真值）
export function createSkillSearchTool(deps: {
  catalog: SkillCatalog;
}): AciToolDef {
  return Object.freeze({
    name: "skill_search",
    description:
      "Search installed skills by keyword (case-insensitive substring on name/description).",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    aci: { category: "read-only", lazy: false, timeoutTier: "fast" },
    handler: async ({ query }, _ctx) => {
      const hits = deps.catalog.search(query); // disabled 已在索引层过滤
      return hits
        .map((s) =>
          JSON.stringify({ name: s.name, description: s.description })
        )
        .join("\n");
    },
  });
}
```

```ts
// mcp/adapter.ts — 元数据四元组（G2 D2 wire 真值）
export function toAciToolDef(
  server: string,
  tool: McpListedTool,
  client: McpClientHandle,
  timeoutMs: number
): AciToolDef {
  return Object.freeze({
    name: `mcp__${sanitize(server)}__${sanitize(tool.name)}`, // Gate 2 命名空间
    description: tool.description ?? "",
    inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
    aci: {
      category: "write", // 保守默认 ask；不做 readOnlyHint 降级
      lazy: true, // 224 首批 lazy 住客
      timeoutTier: "long", // 30min 墙钟硬顶（挂死检测器语义）
      isConcurrencySafe: false, // 全串行
      interruptBehavior: "cancel", // ctx.signal 透传
    },
    handler: async (input, ctx) => {
      const res = await client.callTool(tool.name, input, {
        timeout: timeoutMs,
        resetTimeoutOnProgress: true,
        signal: ctx.signal,
      });
      if (res.isError) return extractText(res); // 文本返回不抛，模型可自行补救
      return res.structuredContent ?? extractText(res); // structuredContent 优先
    },
  });
}
```

```ts
// skill handler 正文装配（G1 Q5 wire 真值）
// <skill_content> = frontmatter 剥离正文
// + "Base directory: <abs dir>" 提示行
// + <skill_files>：glob **/* 排除 SKILL.md、排序、采样 10、绝对路径、"file list is sampled" 提示
// references/ 不递归；模型按清单自主 read_file
```

**命名 / 格式**：模块文件名 kebab-case；工厂 `create*Tool` / `create*`；错误用 `src/harness/errors.js` 既有错误类（`ToolExecutionError` / `RegistryConstructionError`）；warn 一行不泄露 env 值（G2 D1）。

## Testing Strategy

框架 vitest，三层金字塔（G3 Q5 决议）：

| 层               | 位置                                     | 覆盖点                                                                                                                                                                                                                                                                                                                                                                                                                            | 依赖                                                                                                                            |
| ---------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 单测             | `tests/skill/`                           | scanner 三级路径与覆盖序；frontmatter 生效/存档/忽略字段；description 1536 截断+warn；disable-model-invocation 索引过滤；兜底（缺 name→父目录名 / 缺 description→不入清单 / 解析失败→跳过+warn 不毒化）；body 装配（frontmatter 剥离 / Base directory / 采样 10）；常驻清单渲染（名字序 / 空清单显式）                                                                                                                            | tmp 目录 fixture SKILL.md，无网络无子进程                                                                                       |
| 单测             | `tests/mcp/`                             | config 两级合并 / 条目级覆盖 / disabled（认 `enabled:false`）/ 坏条目跳过+warn；adapter wire（structuredContent 优先 / isError 文本 / schema 兜底）；manager 状态机（注册超时 30s→failed / list_changed 重注册 / onclose→failed 不重连 / shutdown SIGTERM）；**并发类：①`list_changed` 到达时有在途 `callTool`（重注册不打断在途调用、不重复注册同名）②`manager.shutdown()` 与在途调用并发（调用收到明确取消/失败语义，不悬挂）** | **stub client**（内存假 client 实现 connect/listTools/callTool），不启真 server                                                 |
| 集成             | `tests/integration/`                     | 真子进程链路：fixture stdio MCP server → connect+listTools → registerExternal → tool_search discover → 调用执行；Gate 2 防撞（同名 `mcp__` 冲突拒绝）                                                                                                                                                                                                                                                                             | `tests/fixtures/mcp-server/`（新造最小 server），无 LLM                                                                         |
| E2E A（进 CI）   | `tests/e2e/skill-mcp-acceptance.test.ts` | stub-model 固定脚本：`skill_search({query}) → skill({name}) → tool_search({mcp 关键词}) → mcp__codebase_memory__<工具>`，逐步断言真实结果                                                                                                                                                                                                                                                                                         | fixture skill（`tests/fixtures/skills/echo/`）+ **真实 codebase-memory-mcp**；server 缺席 → 显式 skip + Not run 记录（假设 14） |
| E2E B（不入 CI） | 手工冒烟清单（写入 plan，不落自动化）    | 真实 LLM 驱动 chat：引导模型自发发现并使用 skill 与 MCP 工具                                                                                                                                                                                                                                                                                                                                                                      | operator 提供测试 key（Open Questions OQ3）                                                                                     |

**前置探针**（实现阻塞项）：ajv strict 与 MCP inputSchema `$ref`/`anyOf` 兼容性探针先行（R2 遗留风险）；探针结果决定是否需要注册路径 schema 归一化。

## Boundaries

### Always

- `ACI_TOOLSET_NAMES` append-only（Gate 3）：只末尾追加 `skill` / `skill_search`，不重排既有 21 件；Gate 3 只锁静态工厂路径，`registerExternal` 动态路径豁免但仍强制 Gate 2 防撞 + 查重。
- `RegistryImpl.list()` 构造期快照语义不变（tools/registry.ts 冻结契约）：动态 MCP 工具只经 `visibleSchemas` / catalog 可见；产品路径 promptTools 恒走 `visibleSchemas`，loop-engine 回退路径只覆盖静态集。
- MCP 动态注册强制过 Gate 2（`mcp__` 命名空间防撞）。
- MCP 工具大结果截断归 executor truncation authority（契约 X），adapter 不二次截断。
- MCP config 坏条目条目级隔离：跳过 + warn 一行（不泄露 env 值），不影响其他 server 与启动。
- skill 扫描失败 / 空目录 = 清单空降级，不阻塞装配与启动。
- MCP 连接后台化：`buildHarnessEngine` 返回不因任何 server 连接阻塞。
- 提交前 `npm test` + `npm run typecheck` 全绿。

### Ask first

- `@modelcontextprotocol/client` 之外的任何新依赖（本期无预期）。
- 全局 ajv 配置改动（探针失败时只允许 MCP 注册路径局部归一化）。
- `IKNOW_ASSEMBLY_ORDER` 既有段的任何重排（本 spec 只允许末尾 append）。
- 权限三层逻辑的任何改动（本 spec 明确零改动，MCP 走既有 category 模型）。

### Never

- 读 `~/.claude.json` / `.kiro/settings/mcp.json`（G2 裁决；用户手工迁移条目）。
- 扫描 `.claude/skills`（G1 Q6 路径 iknow 化裁决）。
- 解析或强制 allowed-tools 白名单（fog：第三方 skill 场景出现才上）。
- MCP 自动重连 / needs_auth 状态 / remote+OAuth（fog/增量）。
- `user-invocable` 的 `/cmd` UI（fog，G3 Q4）。
- 删除或降级既有测试；把失败测试改 skip（除非按假设 14 的显式 skip 格式并记录原因）。
- 把 MCP server 凭据 / env 值写进日志、warn、测试快照。

## Success Criteria

二元可判定，每条对应一个可执行检查：

- [ ] SC1 `ACI_TOOLSET_NAMES` 长度 = 23，末两位 `skill` / `skill_search`；Gate 3 装配校验通过（`npm test` 中 registry 测试断言）。
- [ ] SC2 三级目录扫描：同名 skill `IKNOW_SKILL_DIRS` > `.iknow/skills` > `~/.iknow/skills` 覆盖序被单测断言；`.claude/skills` 不被扫描（反例测试）。
- [ ] SC3 `disable-model-invocation: true` 的 skill（session-handoff 活体样本）不出现在 `<available_skills>` 段、`skill_search` 搜不到。
- [ ] SC4 种子装配后 `<available_skills>` 段含 systematic-debugging / verification-before-completion / test-driven-development 三件（名字序渲染）。
- [ ] SC5 `skill_search({query})` 大小写不敏感子串匹配，每行返回 `{name, description}` JSON；直呼名 `skill({name})` 返回正文，叫错名返回引导回检索的文本。
- [ ] SC6 `skill({name})` 返回 = frontmatter 剥离正文 + Base directory 行 + `<skill_files>` 采样 ≤10 绝对路径；references/ 未递归。
- [ ] SC7 两级 MCP config：项目级同名条目整体覆盖用户级；`disabled:true` / `enabled:false` 不连接；坏条目跳过且 warn 恰好一行且不含 env 值（单测断言）。
- [ ] SC8 `buildHarnessEngine` 返回时间不因 MCP server 缺席 / 慢而阻塞（测试用慢 connect stub 断言返回先于连接完成）；连接成功后 `mcp__*` 工具经 tool_search discover 可见。
- [ ] SC9 注册超时：30s 未连上 → 该 server 标 failed + warn，启动不失败，其余 server 不受影响。
- [ ] SC10 adapter wire：structuredContent 存在时优先返回；`isError:true` → 文本 tool_result 不抛异常；协议层错误（超时/断连）抛 execution_failed（单测三分支全覆盖）。
- [ ] SC11 `manager.shutdown()`：client.close 被调 + stdio 子孙收到 SIGTERM（子进程 fixture 断言退出信号）。
- [ ] SC12 `ask` 入口：registry / executor / catalog 三方视图不含任何 `mcp__*` 与 MCP 连接行为（build 测试断言 manager 未创建）；skill 两件工具在场。
- [ ] SC13 E2E A 通过：stub-model 脚本全链路（skill_search → skill → tool_search → `mcp__codebase_memory__*`）每步断言真实结果；`npm test` 内可复现。
- [ ] SC14 `npm test` 与 `npm run typecheck` exit 0。
- [ ] SC15 并发：`list_changed` 重注册与在途 `callTool` 并发时，在途调用不被打断、同名工具不重复注册（单测断言，stub client 构造时序）。
- [ ] SC16 并发：`manager.shutdown()` 与在途调用并发时，在途调用以明确取消/失败语义终结（不悬挂、不 resolve 成功），断言错误类型。

## Open Questions

- **OQ1**（假设 13 复核口）`<available_skills>` 加性段在 LOCKED 循环之后的追加位置（toolList 段之后、projectPath 段之前/后）；若实施中发现模型对 skill 清单感知率不足，段位置调整即触发本 spec 变更。
- **OQ2**（假设 14 复核口）codebase-memory-mcp 在 CI 机器缺席时的 skip 形态；若 operator 要求 CI 必跑，则需改为在 CI 安装该 server（依赖外部安装链路）。
- **OQ3** E2E B 的测试 key 由 operator 何时提供、走哪个路径（settings-model-extension 收尾后：`settings.llm.apiKey` 字面或 `${VAR}` 占位符 → `IKNOW_LLM_API_KEY_ENV` 机制已退役，ADR-0015）。
- **OQ4** serve 入口的 MCP server 连接以 serve 进程 cwd 为项目级 config 基准——与既有 serve sandboxRoot 语义一致（build-engine.ts:109-117 注释已指出 serve cwd 歧义），本期不额外解决，随该 backlog 走。

## Glossary

（摘自 `docs/CONTEXT.md`，原文不改写）

- **executor truncation authority**（契约 X）: executor 是工具结果截断元数据的唯一权威——自测序列化后字符数、自截断、自合成标记；工具返回纯数据、不带 truncated/total 元字段，executor 永不信任工具声称的截断字段（防 MCP 第三方伪造绕过封顶）。#140 裁决，ADR-0004 / ADR-0006。
- **observability side-channel**: (#298) 工具观测旁路——handler 返 envelope `{ output, meta? }`；executor 拆分后仅 `output` 字符串化进 model-facing tool_result，`meta` 经 `PostToolUseHook.payload` → `TuiToolEvent.payload` → `LiveToolRun` 字段供 TUI diff 预览等观测消费者，永不进模型视野。ADR-0004（supersede Y1）。
- **ACI tool set**: Harness 装配层（`src/harness/aci/`）注册的工具集；…SSOT 工厂 = `src/harness/aci/tools/registry.ts:createDefaultAciRegistry`，所有入口（`build-engine` / `tui/deps`）从这里取，工具数永不同步漂移（#141 / #191 / a277f68）。每次工具调用经 permission middleware（ADR-0004）与 timeout tier 装饰。（本 spec 落地后件数 21→23，词条计数待 domain-modeling 晋升时更新。）

## Architectural Constraints

- **ADR-0004**（tool-layer）：新工具经 permission middleware + timeout tier 装饰；skill 走 read-only 默认放行，MCP 走 category:write → ask。
- **ADR-0006**（tool-output-capping 20000）：MCP 大结果截断由 executor 统一执行（契约 X），adapter 层零截断逻辑。
- **224 spec**（`specs/224-tool-extension-path.md`）：lazy/discover/visibleSchemas + tool_search + 三闸门是本 spec 的地基；tool_search 合同零改动，MCP 是其首批 lazy 住客。
- **security-guardrails spec**：权限三层零改动；MCP config env 值不入日志（日志脱敏）。

## ACR Verdict（architecture-change-reviewer · 5-verdict gate）

**Round 1（2026-08-10，arthurpower:architecture-change-reviewer-agent）：BLOCKED** — bounded-context-guardian **no**（spec 声称 `registerExternal` 已存在，与真值矛盾：src/ grep 零命中，aci-registry.ts:96 / tools/registry.ts:78 双层冻结）；defensive-contract-validator **unclear**（无 concurrent 类测试计划）；error-handling-enforcer **yes**；complexity-anti-drift **yes**；minimal-change-verifier **no**（多逻辑任务不可单 commit + 工作树 `@types/node` 漂移需隔离）。

**修复**（已落本 spec）：①Project Structure 将 aci-registry.ts 改为「改动（新缝）」并写明 registerExternal 契约与冻结快照关系 + Gate 3 豁免机制 + Boundaries Always 锁 list() 快照语义；②Testing Strategy tests/mcp/ 补 2 个并发用例 + SC15/SC16；③假设 15 声明 ≥4 commit 拆分序与漂移隔离；④（提示项）假设 13 改走 assemble.ts:104-117 加性段先例，不触碰 LOCKED 数组。

**Round 2（自审复核修复后，2026-08-10）**：

- bounded-context-guardian: **yes** — registerExternal 缝契约显式声明于 aci-registry.ts（闭包内可变通道，spec:80），skill/ 与 mcp/ 只经 catalog/缝与 build-engine 装配层交互，无反向依赖；`inner` 冻结契约不动（spec:80, Boundaries Always spec:176-177）。
- defensive-contract-validator: **yes** — 五类边界齐备：empty（SC2 空目录降级）/ negative（SC5 叫错名、SC7 坏条目）/ overflow（1536 截断、采样 10、ADR-0006）/ concurrent（SC15/SC16）/ exception（SC9/SC10 三分支）。
- error-handling-enforcer: **yes** —（Round 1 已 yes，修复未触及错误路径）。
- complexity-anti-drift: **yes** —（Round 1 已 yes；新缝为闭包追加通道，无新函数超阈值）。
- minimal-change-verifier: **yes** — 范围 = map #337 五票决议（fog 排除显式于 Never 区）；依赖授权引用在案（spec:44）；commit 拆分序与漂移隔离声明于假设 15。
