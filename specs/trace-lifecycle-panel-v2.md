# Spec: 完整生命周期追踪面板 v2（Trace Lifecycle Panel v2）

> **范围**：在 ADR-0003 TraceService（写侧接口）+ `traceserver-inspection-panel.md`（读侧面板 v0）+ `iknow-trace-standalone-service.md`（独立 trace 子命令）之上，把 trace 从"扁平 JSONL 日志"升级为"可可视化、按会话切换、可实时监控、覆盖完整生命周期的追踪面板"。本 spec **交叉引用上述三个已有 spec**，不修改它们；它是 v2 的增量契约。
>
> 来源：wayfinder map `#284`（GH winter6205/iknow），7 个 ticket（#285/#286/#287/#288/#289/#290/#291）决议全部 settle。决策依据含 Agent Trace 调研报告（`/mnt/e/训练集/agent-learn/agent-trace-guide/`）。

## Objective

**What**：让开发者追踪智能体 agent 的**完整生命周期**——在终端敲一条命令，浏览器打开一个**可切换会话、可实时监控、可翻历史、按环节流程图标出"哪个环节/模块出了问题"**的追踪面板。

**Why**：当前 trace 是扁平 JSONL，开发者得手动 `iknow trace` 单独起面板、手动 `--trace-out`、浏览器里只有表格。看"哪个环节出问题"要靠人肉扫表。本 spec 把 7 个 wayfinder 决议落成 buildable 契约：**每会话独立文件 + 会话列表/下钻 API + 环节覆盖扩展 + 实时轮询 + 一键启动 + FlowTree 可视化**。

**Who**：开发 iknow 智能体的工程师（本地调试）。最终目的是帮开发智能体，不是生产监控。

**Success（总览）**：一条 `iknow trace` 命令 → 浏览器自动打开 → 默认显示最近会话的 FlowTree 树状拓扑 → 错误红条一眼可见 → 可切换历史会话 → 实时轮询当前活跃会话。

## Tech Stack

- **Language**: TypeScript（`tsconfig.json`: ES2022 / NodeNext / strict / noUnusedLocals / verbatimModuleSyntax / isolatedModules）。
- **Module**: ESM（`package.json` `"type": "module"`）；TS 源相对 import 用 `.js` 后缀。
- **Runtime**: Node.js server-side。**A-scope v2 NO new runtime deps**——复用现有 `crypto.randomUUID()`、`node:fs`、`node:http`。
- **Web**: 现有 `web/` SPA（React 19 + Vite + Tailwind v4），多页构建（`index.html` + `trace.html`）。**不引入图表/router 库**（FlowTree 是手写 SVG/div 布局，报告 `04` 建议"按环节上色"而非图表库）。
- **Test runner**: Node built-in test runner via `tsx --test`（项目惯例，同 016/017/traceserver）。

> Tech stack 变更需 new assumption gate（项目 Iron Law）。v2 零新增 deps。

## Commands

```bash
# Type check (project-wide)
npm run typecheck

# Full test suite (Node built-in runner via tsx)
npm test

# Web type check + build
npm run web:typecheck
npm run web:build

# 启动 trace 面板（默认自动打开浏览器 + 默认 ./trace/ 目录 + 显示最近活跃会话）
npx tsx src/cli.ts trace

# 指定 trace 目录 + 不自动开浏览器（CI/headless）
npx tsx src/cli.ts trace --trace-out /tmp/trace --no-open

# 写侧（serve 仍写 trace，trace 面板独立进程）
IKNOW_TRACE_OUT=/tmp/trace npx tsx src/cli.ts serve

# 一次性迁移旧 trace 文件（./trace.jsonl → ./trace/<convId>.jsonl）
npx tsx scripts/trace-migrate.ts
```

## Project Structure

```
src/
├── harness/trace/                    # 写侧（已有，v2 扩展）
│   ├── types.ts                      # ✓ 已有 → 加 SessionRecord / SandboxCmdRecord / model字段
│   ├── jsonl.ts                      # ✓ 已有 → 每会话独立文件语义（filePath 改目录下 convId 文件）
│   ├── noop.ts / safe-trace.ts       # ✓ 已有，不动
│   └── index.ts                      # ✓ barrel → 导出新 record 类型
├── traceserver/                      # 读侧（已有，v2 扩展）
│   ├── serve.ts                      # ✓ 已有 → startTraceServe 改目录语义 + 默认 open（host 层）
│   ├── reader.ts                     # ✓ 已有 → 增量读取（offset）+ 未知字段 raw.unmapped 池
│   ├── http.ts                       # ✓ 已有 → 会话列表端 + 下钻路由 + 缺省最近会话 + poll 参数
│   ├── sessions.ts                   # 〔新〕→ 会话列表（readdir + stat）reader
│   └── fields.ts                     # ✓ 已有 → 加新 record_type 字段声明
├── cli.ts                            # ✓ → runTrace 默认 ./trace/ + 自动 open + --no-open
└── cli/parse-args.ts                 # ✓ → 加 --no-open flag
scripts/
└── trace-migrate.ts                  # 〔新〕→ 旧单文件 → 按 conversation_id 分文件迁移
web/src/
├── trace-main.tsx / components/      # ✓ → TracePanel 升级：FlowTree 可视化 + 会话列表 + 轮询
└── components/FlowTree.tsx           # 〔新〕→ 原型 `/tmp/.trash-trace-view/variants/FlowTree.tsx` 移植
tests/
├── harness/trace/                    # 写侧单测（已有）
├── harness/trace-integration.test.ts # ✓已有 → 每会话独立文件断言
├── traceserver/                      # 读侧单测（已有 4 文件）
│   ├── sessions.test.ts              # 〔新〕→ 会话列表 + 下钻 + 缺省最近会话
│   └── reader-incremental.test.ts    # 〔新〕→ 增量读取 + raw.unmapped
└── scripts/trace-migrate.test.ts     # 〔新〕→ 迁移脚本
```

## Code Style

### Interface contract（`src/harness/trace/types.ts` 扩展）

延续 ADR-0003 命名（`recordXxx` + `@throws never` + Postel 字段缺席）。新增方法：

```ts
// 新增 record 类型（沿用 TraceError / TraceStatus）
export interface SessionRecord {
  startedAt: string;
  endedAt: string;
  durationMs: number;
  agentVersion: string; // 由 writer/CLI 侧在构造时注入（C2 决议：注入而非 harness 层 import cli/usage.ts，避免写侧←cli 反向依赖）
  status: TraceStatus;
  error?: TraceError;
}

export interface SandboxCmdRecord {
  parentTurnId: string; // 单值 parent（#286 决议：新 record 统一 parent_*_id 单值）
  command: string;
  exitCode: number;
  stdoutCaptured: boolean; // Postel：布尔开关，内容仅 true 时落盘
  stdout?: string; // 限长（C 方案：IKNOW_TRACE_MAX_CONTENT_BYTES）
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: TraceStatus;
  error?: TraceError;
}

// TraceService 接口新增方法（D1：扩展接口，非新接口）
export interface TraceService {
  recordLlmCall(record: LlmCallRecord): Promise<string | undefined>; // ✓已有
  recordToolCall(record: ToolCallRecord): Promise<string | undefined>; // ✓已有
  recordTurn(record: TurnRecord): Promise<string | undefined>; // ✓已有
  recordSession(record: SessionRecord): Promise<string | undefined>; // 〔新〕返回 sessionId
  recordSandboxCmd(record: SandboxCmdRecord): Promise<string | undefined>; // 〔新〕
}
```

### LlmCallRecord 补字段（#286 决议）

```ts
export interface LlmCallRecord {
  // ...既有字段不动...
  modelRequested?: string; // 补（spec 欠账，resolve 到实际路由模型）
  modelActual?: string; // 补（request.model ≠ response.model，报告 02:147 双字段）
  provider?: string; // 补（= gen_ai.provider.name 类比）
}
```

### 每会话独立文件语义（jsonl.ts）

`createJsonlTraceService` 的 `filePath` 语义改为**目录**：写 `<filePath>/<conversationId>.jsonl`。`conversationId` 仍实例绑定（ADR-0003 D4）。`recordViolationTrace`（hub.ts:615）同域写 `<filePath>/<convId>.jsonl`。

### 环节 schema（A3 决议：定义全 schema，埋点分阶段）

| record_type   | 埋点状态                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------- |
| `session`     | **本 spec 埋**（L1 根，loop-engine 入口）                                                |
| `sandbox_cmd` | **schema 就位，埋点留 pendingRuntime**（sandbox 只有 violation，无独立命令执行记录能力） |

> **Postel 例外论证（ACR 第 4 维）**：ADR-0003 D9 Postel 要求"能力不存在就不声明字段"。`sandbox_cmd` 声明但仍不可填，表面违反 D9。**例外理由**：wayfinder #286 决议**明确**定了 sandbox_cmd 环节（用户要"追踪沙箱命令执行"），且 FlowTree 原型（#291）已把它作为 6 站点之一。若完全删 schema 留位，等 sandbox runtime 能力落地时需再改 spec + 加字段 + 改 fields.ts + 改前端，破坏可视化契约。故**声明 schema 但埋点留 pendingRuntime** 是决议驱动的显式例外，且**不写入任何 JSONL 行**（无 sandbox_cmd 记录产生，直到 runtime 能力落地），因此不产生"空数据污染 trace"——Postel 的"不记录不可填字段"精神（trace 里出现的都是真实发生的）仍被满足。
> | `permission`（复用 `violation` + `reason` 枚举） | **本 spec 埋**（reason=permission_denied 落 violation） |
> | `llm_call` + model/provider | **本 spec 埋**（字段补全） |

### 读侧会话列表 + 下钻

```ts
// GET /api/v1/sessions → 扫目录会话列表
interface SessionSummary {
  conversation_id: string; // 文件名 = UUID
  mtime: number; // 最近活跃（stat）
  size: number; // 字节（列表不读内容，行数≈size）
  agent_version?: string; // 从会话根记录读（C2；根记录缺失/坏行时 absent）
}

// 参数边界（def-ior，仿现有 parseLimit http.ts:71-80）：
// ?poll=<ms> — 非负整数，0=停轮询，缺省 1000；负值/非整数/NaN → 400 validation
// ?limit / ?offset — 复用现有 parseLimit/parseOffset 契约（limit 1..200，offset >= 0）
// /api/v1/sessions — 无分页上限（会话数有限，readdir 全量）；若未来会话多再加分页

// GET /api/v1/traces?conversation_id=<id> → 路由到 <traceDir>/<id>.jsonl
// 缺省 conversation_id → 最近活跃会话（readdir+stat 按 mtime）
// ?poll=<ms> 前端轮询间隔（缺省 1000，0 关闭）
// 响应含 agent_version（从会话根记录读）
```

### FlowTree 可视化（#291 决议）

原型 `/tmp/.trash-trace-view/variants/FlowTree.tsx` 移植到 `web/src/components/FlowTree.tsx`。6 站点横排（session/llm/tool/sandbox/permission/violation）+ 事件垂直落子树 + 回合分组 + 状态色（UI 4 值派生，trace 仍 2 值）+ 详情面板（fields keyvals + upstream/downstream）。

## Testing Strategy

- **框架**：Node built-in test runner via `tsx --test`（项目惯例）。
- **写侧** `tests/harness/trace/`：`recordSession` / `recordSandboxCmd` 生成 ID、`@throws never`、每会话独立文件写路径、violation 同域。
- **读侧** `tests/traceserver/`：
  - `sessions.test.ts`（新）：会话列表 readdir+stat、下钻路由、缺省→最近会话、无目录→空列表、`agent_version` 提取。
  - `reader-incremental.test.ts`（新）：增量读取 offset、空文件、文件追加、文件被替换、未知字段 `raw.unmapped` 池。
  - 既有 `reader/serve/http/serve-static` 4 文件回归（目录语义改动）。
- **迁移** `tests/scripts/trace-migrate.test.ts`（新）：旧单文件→多文件、按 conversation_id 分、保留原行、坏行处理。
- **CLI** `tests/cli/trace.test.ts`：`--no-open` flag、默认 `./trace/`、旧文件 fail-fast 提示。
- **覆盖目标**（F2 决议）：traceserver 专项 **≥ 50 测试**（v0 是 30，新增会话列表/增量/迁移/新 record_type）。
- **e2e/冒烟**：真实 `npx tsx src/cli.ts trace` → 浏览器打开 → FlowTree 渲染 → 轮询当前会话。

## Boundaries

- **Always do**：
  - 每会话独立文件写路径正确（`<traceDir>/<convId>.jsonl`）
  - 交互端 `trace` 与 `serve` 分开（不逆转 #183 拆分）
  - 既有 trace spec（trace-service / traceserver-inspection-panel / iknow-trace-standalone-service）不动
  - LoopTrace 保持 payload-free（CONTEXT.md `_Avoid_`）
  - 埋点失败不中断业务（`safeTrace` + `@throws never`）
- **Ask first**：
  - 新增 runtime 依赖（v2 目标零新增）
  - `TraceService` 接口变更（ADR-0003 已定，扩张需明示）
  - 改 `--trace-out` 语义（破坏性，用户已有 `./trace.jsonl`）
  - 新增 record_type（Postel 张力，需 ACR + spec 确认）
  - 前端 UI 实现偏离 FlowTree 原型
- **Never do**：
  - 思维链明文入 trace（报告红线①）
  - 埋点失败导致业务崩溃（报告红线②）
  - 在 span/record 里做 eval（报告红线③）
  - 用估算值顶替 trace 真值（CONTEXT.md usage `_Avoid_`）
  - 多进程同时写同一会话文件（#285 文档注明）

### Commit 切分（ACR 第 5 维：minimal-change 补强）

v2 是 7 个 wayfinder ticket 的兑现，**不可作为单一逻辑任务落地**。按 1 commit = 1 logical task（Conventional Commits）切分：

1. `feat(trace): 每会话独立文件写入`（写侧 `jsonl.ts` 目录语义 + `recordSession`/`recordSandboxCmd` 接口 + violation 同域）—— 对应 #285 + #286 写侧
2. `feat(trace): 读侧会话列表 + 下钻`（`sessions.ts` + `http.ts` 端点 + 缺省最近会话 + 增量读取 + raw.unmapped）—— 对应 #290 + #288
3. `feat(trace): 启动体验 + 默认目录`（`cli.ts` runTrace 默认 `./trace/` + 自动 open + `--no-open` + usage）—— 对应 #287
4. `feat(trace): 旧 trace 迁移脚本`（`scripts/trace-migrate.ts` + 检测旧文件 fail-fast）—— 对应 #285 迁移
5. `feat(trace): FlowTree 可视化面板`（`web/src/components/FlowTree.tsx` + TracePanel 升级 + 会话切换 + 轮询）—— 对应 #291 + web 侧

> ⚠️ **破坏性变更独立 commit**：#285 的 `--trace-out` 默认语义变更（`./trace.jsonl` → `./trace/`）必须**独立于其他 commit**，并**配套迁移脚本（commit 4）**，避免作为单一逻辑任务混入。三个现有 spec（trace-service / traceserver-inspection-panel / iknow-trace-standalone-service）不修改，新 spec 独立提交。

## Success Criteria

**写侧（SC-W）**：

1. `npm run typecheck` 通过（含 web）。
2. 全量 `npm test` 无新增失败。
3. `createJsonlTraceService` 写 `<filePath>/<conversationId>.jsonl`（不再是单文件）。
4. `TraceService` 接口含 `recordSession` / `recordSandboxCmd`，均 `@throws never`。
5. `LlmCallRecord` 含 `modelRequested`/`modelActual`/`provider`（成功分支填，错误分支缺席）。
6. `SessionRecord` 含 `agentVersion`（= getVersion()）。
7. `recordSession` 在 loop-engine 入口埋点（L1 根）；`sandbox_cmd` 埋点留 pendingRuntime（schema 就位）。
8. `recordViolationTrace` 写 `<filePath>/<convId>.jsonl` 同域。
9. 迁移脚本 `scripts/trace-migrate.ts`：旧单文件 → 按 conversation_id 分文件，保留原行。

**读侧（SC-R）**：10. `GET /api/v1/sessions` 返回会话列表（conversation_id / mtime / size / agent_version，stat 不读内容）。11. `GET /api/v1/traces?conversation_id=<id>` 路由到会话文件，复用 reader 过滤。12. 缺省 `conversation_id` → 返回最近活跃会话（readdir+stat 按 mtime），不 400，不混看。13. `GET /api/v1/traces/fields`、`/api/v1/health` 行为不变。14. reader 增量读取：记 offset，只读新增行（`?poll=` 支持）。15. reader 对未知字段不丢弃，存 `raw.unmapped` 池（面板"其他字段"渲染）。16. `maxBytes` 语义保留，作用于按会话文件。17. `GET /api/v1/sessions` 的 readdir/stat 失败路径：单个文件 stat 报 ENOENT（读时该会话被删）→ **跳过该文件**（不报错）；readdir 目录不存在 → 返回空列表（非 500）；读侧 IO 错误 → TraceReadError → 500（不泄漏 fs 细节，继承 serve.ts:157-166）。18. `agent_version` 根记录缺失/坏行 → 该字段 absent（optional），列表不因单会话坏行整体失败。

**CLI（SC-C）**：19. `iknow trace` 默认自动打开浏览器（`--no-open` 关闭）。20. `iknow trace` 默认 `./trace/` 目录，无需 `--trace-out`。21. 检测到旧 `./trace.jsonl` 文件 → fail-fast 提示迁移（不静默当目录）。22. `serve` 与 `trace` 分开：serve 不连带开 trace 面板，启动保留"另起 iknow trace"提示。

**可视化（SC-V）**：23. 面板默认显示最近活跃会话的 FlowTree 树状拓扑（6 站点）。24. 当会话含 `status=error` 或 `status=denied` 记录时，FlowTree 对应节点渲染为 danger 色（红色），且不依赖人工筛选即可见。25. 会话列表点击某历史会话 → 明细下钻到该会话 FlowTree（列表与明细分离）。26. 实时轮询当前活跃会话：默认间隔 1s，`?poll=0` 时停止轮询（一次性加载）。

## Open Questions

1. **sandbox_cmd 埋点时机**：A3 决议 schema 就位、埋点留 pendingRuntime。当 sandbox runtime 能力（独立命令执行记录）落地时，哪些已有？—— 需后续 ticket 明确 runtime 能力契约。
2. **permission 复用 violation reason 枚举值域**：#286 定 `permission_denied` 等枚举，但具体枚举全集（`none|pii|jailbreak|topic|tool_policy|length|permission_denied`）是否与报告一致？—— spec 用报告枚举，实现时校验。
3. **`GET /api/v1/sessions` 端点路径**：定在 `/api/v1/sessions` vs `/api/v1/traces/sessions`。spec 用 `/api/v1/sessions`（与 `/api/v1/traces` 平级），实现时确认不与 session-api 的 `/api/v1/sessions` 冲突（trace 是独立进程，无冲突）。
4. **agent_version 注入 seam**：C2 决议——由 writer/CLI 侧在构造 `SessionRecord` 时注入 `getVersion()` 值，harness/trace 层不 import `cli/usage.ts`（避免反向依赖，遵循 ADR-0003 文件头"trace 不 import model-adapter"先例）。traceserver 读侧从会话根记录读该字段，也需注入 getVersion 用于写侧。实现时确认具体注入点。
5. **FlowTree 与现有 TraceTable 共存**：v2 是新增 FlowTree 视图，还是替换 TraceTable？spec 假设**新增可切换视图**（FlowTree 为主，TraceTable 保留为"表格"变体），实现时确认 UI 切换。

## Architectural Constraints（Context-Loop Pre-Check）

- **LoopTrace**（`docs/CONTEXT.md:26`）：A 层结构元数据，严格不含 payload；`_Avoid_` 塞 input/output/token/cost。v2 不触碰 loop-trace.ts。
- **usage token accounting**（`docs/CONTEXT.md:29`）：权威落点 TraceService `LlmCallRecord`；v2 只补 model/provider，不动 token 落位。
- **required/conditional remediation layer**（`docs/CONTEXT.md:41`）：trace B 层字段属 conditional remediation，017 显式禁止。v2 的 sandbox_cmd 埋点留 pendingRuntime 即遵循此边界。
- **ADR-0003**：D4 conversation_id 必填；D5 ID 由 TraceService 生成；D9 Postel（只记录当前可填字段）；D10 chat 排除；D13 recordXxx MUST NOT throw。
- **ADR-0008**：usage 四字段落位 LlmCallRecord，错误分支整条缺席。

## Glossary

- **TraceService**（`docs/CONTEXT.md` 相关 + ADR-0003）：独立 bounded context，记录 LLM/tool/turn 内容到 JSONL，供本地调试。v2 扩展 recordSession/recordSandboxCmd + model 字段。
- **LoopTrace**（`docs/CONTEXT.md:26`）：`run()` 第二返回面，A 层结构元数据，无 payload。与 TraceService 是两个 bounded context。
- **conversation_id**（ADR-0003 D4）：每条 JSONL 记录的关联键；v2 中 = 每会话独立文件名（UUID）。
- **record_type**：JSONL 记录类型（llm_call/tool_call/turn/violation，v2 加 session/sandbox_cmd）。
- **raw.unmapped 池**：读侧 reader 对未知字段的兜底存储，面板"其他字段"渲染（报告 02:168,205 + 04:215）。
- **FlowTree**：v2 可视化主视图，6 站点树状拓扑（#291 原型）。

## ACR 5-Verdict Gate

第一轮（2026-08-09）：**5/5 unclear → BLOCKED**。5 个未闭合设计缝已全部修正：

1. **[bounded-context]** `agentVersion` 反向依赖 → 改为注入（writer/CLI 构造 SessionRecord 时注入，harness/trace 不 import cli）。✅
2. **[defensive-contract]** `?poll=`/`/api/v1/sessions` 参数边界缺失 → 补 def-ior（poll 非负整数 + limit/offset 复用现有契约）。✅
3. **[error-handling]** sessions 读侧失败路径缺失 → 明确定义（stat ENOENT 跳过、readdir 缺目录空列表、agent_version absent 降级）。✅
4. **[complexity]** sandbox_cmd Postel 违约 → 显式论证例外（决议驱动 + 不写 JSONL 行，Postel 精神仍满足）。✅
5. **[minimal-change]** 7 ticket 打包 → 加 Commit 切分（5 commits + 破坏性变更独立），避免单一逻辑任务落地。✅

第二轮（2026-08-09）：**PASS — 5/5 yes**。通过 ACR gate，可交 writing-plans。

- [bounded-context-guardian] **yes** — agentVersion 注入 seam 已定（spec:96,247），无写侧←cli 反向依赖
- [defensive-contract-validator] **yes** — poll/参数边界 def-ior 已补（spec:162-163），sessions.test 覆盖
- [error-handling-enforcer] **yes** — SC-R 17/18 失败路径明确（stat ENOENT 跳过 / readdir 缺目录空列表 / agent_version absent 降级）
- [complexity-anti-drift] **yes** — sandbox_cmd Postel 例外已论证（spec:146），schema-only 无运行时接线
- [minimal-change-verifier] **yes** — 5 commits 切分 + 破坏性变更独立（spec:210-220）

**残留非阻塞提示（给 writing-plans 排序）**：commit 1（写路径目录语义）与 commit 3（--trace-out 默认）都是破坏性变更，且存在 1→3→4（迁移）依赖链；建议把破坏性写路径变更与迁移脚本紧邻，避免旧 `./trace.jsonl` 空窗。Open Q4 方向已 settle，仅剩"确认具体注入点"实现细节。

## Cross-references

- `docs/adr/0003-trace-service-domain-interface.md` — 写侧接口契约（D9 Postel / D10 chat 排除）
- `docs/adr/0008-token-accounting-usage-placement.md` — usage 落位
- `specs/trace-service.md` — 写侧接口 spec（v2 扩展它，不改）
- `specs/traceserver-inspection-panel.md` — 读侧面板 spec v0（v2 扩展它，不改）
- `specs/iknow-trace-standalone-service.md` — 独立 trace 子命令 spec（v2 扩展它，不改）
- `docs/CONTEXT.md` — LoopTrace / usage 术语
- Agent Trace 调研报告 `/mnt/e/训练集/agent-learn/agent-trace-guide/` — 决策依据（三关联键、内容捕获红线、字段 SSOT）
