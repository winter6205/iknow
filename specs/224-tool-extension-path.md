# Spec: 224-tool-extension-path — 工具扩展之路接线（lazy/discover/visibleSchemas + tool_search + 准入契约）

> 输入 = [map #220 Decisions so far](https://github.com/winter6205/iknow/issues/220)（A2 #224 Resolution 五决策 + 下游实施移交清单）。
> 范围 = 机制全通，零工具 lazy 化（验收 = 行为中性）。
> 落地 = spec → ACR → writing-plans，本 spec 不含实施代码。

## Objective

把 iknow harness 的工具层从"固定 8 件"打通成"可按需加件"，但不引入任何运行时回归。具体包含三条能力建设：

1. **接线 `lazy` / `discover` / `visibleSchemas` 三件套**（`src/harness/aci/aci-registry.ts:48-51` 当前是 dead code）——`LoopEngineDeps` 加可选 `promptTools` 注入缝，`build-engine.ts` 装配时传 `reg.visibleSchemas`，loop-engine 在不动协议层/ACI 层语义的前提下消费新缝。
2. **补 `tool_search` 为第 9 件 ACI 工具**——模型按名/子串检索工具，handler 返回完整 `ToolDef` JSON（字符串 wire），引擎消费 discovered set 让检索过的 lazy 工具从下一轮起进入 `promptTools()`。
3. **新工具准入契约**——装配期 fail-fast 三闸门（自举守卫 / `mcp__` 命名空间防撞 / `ACI_TOOLSET_NAMES` append-only 纪律），契约 X/Y1 由单测锁反例。

**用户**：iknow 单用户单项目本机产品（STATUS.md:56/58）；CLI `chat` / `ask` / TUI / `serve` 四个入口共享同一份 ACI registry（`build-engine.ts` SSOT）。

**成功形态**：本期不引入新工具，8 → 8；机制全部接通并被测试覆盖；将来加第 10 件（MCP 工具、知识工具、lsp）时不再走"白名单 hardcode"流程。

## Tech Stack

| 项          | 取值                                                         | 备注                                                                 |
| ----------- | ------------------------------------------------------------ | -------------------------------------------------------------------- |
| 语言        | TypeScript（与 harness 一致，5.x ESM）                       | 零新依赖                                                             |
| 运行时      | Node.js                                                      | 同上                                                                 |
| LLM 客户端  | Anthropic SDK（通用 Messages API，**非 β** server-side API） | tool_search 走 host-side 加法，不用 `defer_loading`/`tool_reference` |
| Schema 校验 | ajv `strict: true` + ajv-formats（`tools/registry.ts:31`）   | createRegistry 已 lock 校验路径                                      |
| 测试        | vitest                                                       | `npm test`                                                           |
| 新依赖      | **无**                                                       | 行为中性前提下不允许 lockfile 变更                                   |

## Commands

```bash
# Build
npm run typecheck       # 入口文件类型校验

# Test（产品主路径）
npm test                # vitest: unit + harness + integration

# Lint
npm run lint            # 项目根 lint 入口

# Dev
npm run dev             # harness 烟测入口（按需）
```

本 spec 不引入新命令。所有实施验证走 `npm test` + `npm run typecheck`。

## Project Structure

新增 / 改动点（与 #224 Resolution "下游实施移交清单"对齐）：

| 路径                                                            | 形态     | 角色                                                                                                                            |
| --------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `src/harness/loop-engine.ts`                                    | 改动     | `LoopEngineDeps` 新增可选 `promptTools`；`deps.promptTools?.() ?? deps.registry.list()`                                         |
| `src/harness/build-engine.ts`                                   | 改动     | 装配期传 `reg.visibleSchemas` 到 `promptTools`；不传则回退全量（行为中性）                                                      |
| `src/harness/aci/aci-registry.ts`                               | 改动     | discovered set 闭包状态；装配期三闸门（自举守卫 + 命名空间防撞 + SSOT 纪律）；`visibleSchemas()` 已存在不改                     |
| `src/harness/aci/tools/tool-search.ts`                          | **新**   | 第 9 件 `AciToolDef` 工厂（`name="tool_search"`，其余见 § Code Style）                                                          |
| `src/harness/aci/tools/registry.ts`                             | 改动     | `ACI_TOOLSET_NAMES` append 第 9 项；`createDefaultAciRegistry` 注册 `tool_search`                                               |
| `src/harness/identity/system-resolver.ts`（或对应系统装配模块） | 改动     | system prompt 名录段注入缝（本期空壳 = 接线存在但渲染为空）                                                                     |
| `src/harness/permission/`                                       | **不动** | 三层零改动（决策点 5：discover 不过权限，首次调用仍 ask）                                                                       |
| `tests/harness/aci/tool-search.test.ts`                         | **新**   | handler 单测：空 query+names → 拒、子串命中、精确取名命中、无匹配 `"(no matches)"`、多返回 wire 形态                            |
| `tests/harness/aci/aci-registry.test.ts`                        | **改**   | 三闸门 fail-fast：tool_search 标 lazy 抛 / 命名冲突抛 / ACI_TOOLSET_NAMES 与 catalog 不一致抛                                   |
| `tests/harness/aci/registry.test.ts`                            | **改**   | `ACI_TOOLSET_NAMES` 锁 9 件                                                                                                     |
| `tests/harness/loop-engine/discovered-set.test.ts`              | **新**   | stub-model 驱动全链路：turn1 tool_search 调用 → discovered set 记录 → turn2 tools[] 含已发现工具 → 调用成功；契约 X/Y1 反例单测 |
| `specs/146-tui.md` 等其他 specs                                 | **不动** | 无交集                                                                                                                          |

## Code Style

### `AciToolDef` 工厂骨架（`tool-search.ts` 真值形态）

```ts
// 装配期自举守卫（在 createAciRegistry 内）失败抛 RegistryConstructionError
if (tool.name === "tool_search" && tool.aci.lazy === true) {
  throw new RegistryConstructionError(
    "tool_search is the bootstrap discovery tool — lazy=true is forbidden"
  );
}
```

```ts
// tool-search.ts:handler 形态（简化示意，最终走 ajv 校验）
const TOOL_SEARCH_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 1 },
    names: { type: "array", items: { type: "string" }, minItems: 1 },
  },
  additionalProperties: false,
  // ajv 不支持自定义 "at least one"——在 handler 入口抛 validation_failed
} as const;

const handler: ToolHandler = (input, _ctx) => {
  const { query, names } = input as { query?: string; names?: string[] };
  if (!query && !names?.length) {
    return "(no matches)"; // 与同类开源实现同语义：缺参 = 无结果
  }
  const matches = catalog.all().filter((t) => {
    if (names?.length) return names.includes(t.name);
    return (
      t.description.toLowerCase().includes(query!.toLowerCase()) ||
      t.name.toLowerCase().includes(query!.toLowerCase())
    );
  });
  if (!matches.length) return "(no matches)";
  // wire 形态：每行一个 JSON（对齐 Claude Code <function> 行式编码的 iknow 等价物）
  return matches
    .map((t) =>
      JSON.stringify({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })
    )
    .join("\n");
};
```

```ts
// aci 元数据（写死守决策点 2 ④）
const aci = {
  category: "read-only", // DEFAULT_BY_CATEGORY → allow，免 ask
  isConcurrencySafe: true,
  interruptBehavior: "cancel",
  timeoutTier: "fast", // 5s，纯内存 catalog 扫描
  // lazy 字段：不显式设（默认 false）。三闸门之自举守卫作为 fail-safe。
} as const;
```

### 命名 / 格式

- tool name：snake_case 单段；与 8 件现有工具同形态；与 MCP `mcp__` 命名空间物理分隔（命名空间防撞闸门）。
- description：英文 / 中文均可，需包含 "returns ToolDef JSON" + "use to find tools beyond the current prompt" 这两条提示词以引导模型主动 tool_search。
- 单测命名：`*.test.ts` 与源文件同名同目录（vitest 项目惯例）。

## Testing Strategy

| 等级        | 范围                                                                                                                                                                                                                    | 工具                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Unit        | handler 输入校验、无匹配行为、wire 形态、ajv 拒非法输入类型（query 非 string / names 非 array）                                                                                                                         | vitest stub                                  |
| Unit        | 三闸门 fail-fast（抛异常类型 + 错误消息子串）                                                                                                                                                                           | vitest                                       |
| Unit        | 契约 X 反例：mock handler 返回 `{ truncated: false, total: 100 }`，断言 executor 不信截断字段、按字符数自截（对齐 ADR-0006 20000 cap）                                                                                  | vitest                                       |
| Unit        | 契约 Y1 反例：mock handler 返回对象 `{code, stdout, stderr}`，断言 executor 按 plain-string 协议处理（bash 是契约 Y1b 例外，本测试锁定例外外的工具违反 Y1 的失败形态）                                                  | vitest                                       |
| Integration | 全链路 stub-model 驱动（核心交付验证）：脚本化 `responses` 数组 = [turn1 含 `tool_use(tool_search)` → turn2 含 `tool_use(lazy_tool)`]；断言 turn2 `adapter.step({ tools })` 中的 `tools[]` 包含 turn1 发现的工具 schema | vitest + stub model（`stubs/stub-model.ts`） |

**覆盖率门槛**：契约 X/Y1 反例与三闸门单测行覆盖 ≥ 90%；integration 测试覆盖完整 discover-to-invoke 路径。

**`npm test` = 唯一门**：交付门槛 = `npm test` 退出 0 + `npm run typecheck` 退出 0；任何 0 → 1 的回归 = 阻塞。

## Boundaries

### Always

- 装配期 fail-fast（对齐 `tools/registry.ts:50-74` 的 createRegistry 风格），不把错误留到运行期
- 字符串 wire（契约 Y1 守门），`tool_search` handler 永不返回结构化 payload
- 单测反例锁契约 X / Y1（不依赖代码评审记忆）
- ACI 8 → 9 件 SSOT append-only（不重排既有 8 件顺序；`ACI_TOOLSET_NAMES` 末尾追加）

### Ask first

- 加新依赖 / 改 lockfile（**本期零新增**，违反需要显式确认）
- 改 `LoopEngineDeps` 的类型从"optional"变成"required"（破坏 harness 现有 stub 装配测试，需要先升级 stub 测试）
- 改 permission 模块任何文件（**本期零改动**，决策点 5 已锁）
- 引入 agent-side `tool_reference` / `defer_loading`（β API 不在通用 Messages API 范围）

### Never

- 任何工具标 `lazy=true`（本期不做，决策点 3 已锁；首波 lazy 住客等 MCP 接入）
- `tool_search` 标 `lazy=true`（自举死锁，自举守卫抛）
- 修改 `tools/registry.ts` 的 ajv 配置（ADR-0006 / createRegistry 已 lock）
- 修改 `permission/` 模块任何文件
- 跨 session 持久化 discovered set（map #220 Out of scope 排除）
- 不为 `tool_search` 单独绕开 20000 字符封顶（契约 X 单一权威）

## Success Criteria

全部为二元（是/否），每条对应一条可执行的检查：

| #   | Criterion                                      | Check                                                                                                                                                                                       |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | 现有 8 件工具仍全量进 prompt                   | `tests/harness/aci/registry.test.ts` 锁 `ACI_TOOLSET_NAMES.length === 9` 含 8 件原工具                                                                                                      |
| S2  | `loop-engine.ts` 接到 `promptTools` 后行为中性 | stub-model 单元测试：未传 `promptTools` 时与既有 8 件 prompt 行为 byte-identical（adapter.step 第二参数结构不变）                                                                           |
| S3  | 三闸门装配期抛 `RegistryConstructionError`     | 单测三组：tool_search 标 lazy / 命名冲突 / `ACI_TOOLSET_NAMES` 与 catalog 不一致，每组断言抛错 + 错误消息含预期子串                                                                         |
| S4  | `tool_search` 输入校验                         | 单测：空 `{query, names}` 返回 `"(no matches)"`（ajv 处理缺参）；非空 `query` 子串命中；非空 `names` 精确取名；不匹配返回 `"(no matches)"`                                                  |
| S5  | `tool_search` wire 形态 = 字符串装 JSON        | 单测：handler 返回值 `typeof === "string"`；每行可被 `JSON.parse` 反解为 `{name, description, inputSchema}` 对象                                                                            |
| S6  | 契约 X 反例被锁                                | 单测：mock handler 输出 `{truncated: false, total: 100, text: "x".repeat(25000)}`，断言 executor 自截到 20000 字符（`ADR-0006` cap），不读 `truncated` 字段                                 |
| S7  | 契约 Y1 反例被锁                               | 单测：mock handler 返回对象 `{code, stdout, stderr}`，断言 executor 按 plain-string 协议处理（序列化失败 → validation_failed 走契约 Y1b 例外路径）                                          |
| S8  | discovered set 全链路 stub-model 验证          | 集成测试：脚本化 `responses[0]` = `tool_use(tool_search, names:["X"])`、`responses[1]` = `tool_use(X, ...)`；断言 stub-model 第二轮被调用的 `tools[]` 包含 `X` 的 schema，且 `X` 被执行成功 |
| S9  | `permission/` 零改动                           | `git diff --stat src/harness/permission/` 输出空                                                                                                                                            |
| S10 | 零新依赖                                       | `git diff package.json package-lock.json` 输出空                                                                                                                                            |
| S11 | CI 主路径全绿                                  | `npm test` 退出 0；`npm run typecheck` 退出 0                                                                                                                                               |

## Open Questions

本期不答（已在范围外 / 等后续地图推动），仅声明不静默：

- **首批 lazy 住客是谁**：等 MCP 接入（map #220 Not yet specified）
- **MCP 工具命名 + 注册通路具体形态**：map #220 Not yet specified
- **`isConcurrencySafe` 消费（并行工具调度）**：map #220 Not yet specified
- **8 件之后首批新工具（知识工具 / lsp 等）**：map #220 Not yet specified
- **跨 session 持久化 discovered set**：map #220 Out of scope（归 P4 远期）

## Glossary

> 来自 `docs/CONTEXT.md`（spec 引用，不重定义）。

- **ACI tool set**：Harness 装配层（`src/harness/aci/`）注册的工具集；SSOT = `src/harness/build-engine.ts`。
- **Loop Engine**：Foundation 的状态机运行内核，驱动模型 → 工具 → 真实结果 → 下一轮模型 → 明确停止；位于 `src/harness/`。
- **executor truncation authority**（契约 X，ADR-0004 / ADR-0006）：executor 是工具结果截断元数据的唯一权威——自测序列化后字符数、自截断、自合成标记；工具返回纯数据、不带 truncated/total 元字段。
- **plain-string tool output**（契约 Y1，ADR-0004）：生产工具输出为纯字符串（对齐同类开源实现的 wire 形态）；bash 是唯一例外保留结构化 `{code, stdout, stderr}`（Y1b）。
- **append-only messages**：Foundation 的权威 Anthropic 原生会话历史，是唯一事实来源；消息只能以不可变追加（`[...prev, x]`）更新。
- **project stack defaults**（ADR-0001）：iknow 的 LLM 栈默认（key 变量名 `ANTHROPIC_AUTH_TOKEN`、主模型 `m3-combo`、provider/baseUrl `http://localhost:20128/v1`）是项目级决策，焊进 `src/config/env.ts` 代码默认。

> A2 map 决策引入的新术语（待实施完成后经 `domain-modeling` 落 `docs/CONTEXT.md`；当前作 spec 内工作术语使用）：

- **promptTools injection seam**：`LoopEngineDeps` 的可选 `promptTools?: () => ReadonlyArray<ToolDef>`，装配层注入"当前 turn 应进 prompt 的工具集"。
- **discovered set**：engine 闭包级状态，记录本次 run 内被 `tool_search` 检索过的工具名；从下一轮起进入 `promptTools()` 输出。
- **implicit discovery corner**：模型不 tool_search 直接调 lazy 工具的产物。本 spec 设计决策：**无产品/permission 应对**——按 permission 三层原样过、discovered set 不自动补、下次 schema 仍按 `visibleSchemas()` 走。
- **bootstrap self-guard**：装配期断言 `name === "tool_search"` 且 `lazy === true` 时抛 `RegistryConstructionError`（避免发现工具自举死锁）。

## Architectural Constraints

| ADR                                | 引用形式                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------ |
| ADR-0001（project stack defaults） | tool_search 走通用 Messages API，**不依赖 β server-side `defer_loading`/`tool_reference`** |
| ADR-0004（6 工具集 + 契约 X/Y1）   | tool_search 作为第 9 件 append；wire 形态守契约 Y1；handler 不带截断字段守契约 X           |
| ADR-0005（executor hardening）     | tool_search 在 executor 路径下；abort/timeout 走默认 fast 档                               |
| ADR-0006（封顶 20000）             | tool_search 的输出也受 20000 字符封顶；不为它单独立例外                                    |

## ACR Verdict（architecture-change-reviewer · 5-verdict gate）

> 受影响文件 10 件（6 源文件 + 4 测试文件），≥ 3 件门槛达成。

```text
bounded-context-guardian:     yes — loop-engine 只收 Foundation ToolDef 形态的可选注入缝（promptTools），不认识 ACI/lazy；discovered set + 三闸门住 aci-registry；permission/ 零改动；system-resolver 只收空壳名录段；无反向依赖。
defensive-contract-validator: yes — 5 边界类全覆盖：empty（空参→"(no matches)"）/ negative（ajv 拒非法类型）/ overflow（20000 封顶 + 契约 X 反例）/ concurrency（isConcurrencySafe=true，engine 串行）/ exception（三闸门构造期 fail-fast）。
error-handling-enforcer:      yes — 失败路径全类型化：三闸门抛 RegistryConstructionError（对齐 createRegistry 既有形态）；参数校验走 executor validation_failed 标签；"(no matches)" 是合法返回非错误；permission 路径不动。
complexity-anti-drift:        yes — tool-search.ts 单一职责工厂（schema + handler + aci 元数据）；aci-registry 仅加三闸门 + discovered set 状态；loop-engine 单行 fallback；无嵌套、无参数膨胀。
minimal-change-verifier:      yes — 1 逻辑任务（扩展机制接线，零 lazy 实例、零新依赖、零 permission 改动）；tracer-bullet 拆分与 commit 顺序交 writing-plans。
```

**Gate 结果：5/5 yes，无阻塞。** 移交 `writing-plans`（固定序列：spec → ACR → writing-plans）。

- affects: src/harness/loop-engine.ts
- affects: src/harness/build-engine.ts
- affects: src/harness/aci/aci-registry.ts
- affects: src/harness/aci/tools/tool-search.ts (新)
- affects: src/harness/aci/tools/registry.ts
- affects: src/harness/identity/system-resolver.ts
- affects: tests/harness/aci/tool-search.test.ts (新)
- affects: tests/harness/aci/aci-registry.test.ts
- affects: tests/harness/aci/registry.test.ts
- affects: tests/harness/loop-engine/discovered-set.test.ts (新)
