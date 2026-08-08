# Spec: Trace 完整生命周期追踪面板（v2）

> **Wayfinder handoff artifact.** 本文是 wayfinder 地图 #284（智能体完整生命周期追踪面板）的 spec 化落地，承接该地图 7 条决议（#285–#291）。写侧契约扩展见 `specs/trace-service.md`；读侧面板 v0 见 `specs/traceserver-inspection-panel.md`；独立 trace 子命令见 `specs/iknow-trace-standalone-service.md`。**本 spec 交叉引用上述三份既有 spec，不取代它们**。
>
> 依据：GH wayfinder 地图 #284（OPEN）；GH issue #64（trace service 起源）；ADR-0003（trace service domain interface）；ADR-0008（token accounting usage placement）；Agent Trace 调研报告（`/mnt/e/训练集/agent-learn/agent-trace-guide/`）。

## Objective

把 iknow agent 运行的**完整生命周期**变成可在浏览器中**会话语境化**查看、可实时追踪、可定位出错的诊断面板。当前痛点：

- 写侧：`./trace.jsonl` 单文件多会话混写，跨进程/多会话并发不安全；按 conversation 切换和清点要 grep。
- 读侧：`/api/v1/traces` 只接单文件参数；缺省 404；面板只渲染扁平表格，无任何"哪个环节出问题"视图。
- 启动：`iknow trace` 是独立进程，需手传 `--trace-out`；不自动开浏览器；要看 trace 需两条命令。
- 字段：内容捕获（`messages_captured` / `arguments_captured` / `result_captured`）恒 false（`loop-engine.ts:1099-1100`），调试时看不到模型到底被喂了什么 / 工具返回了什么。
- 环节覆盖：trace 只覆盖 LLM/工具/回合/违规四类，**会话生命周期 / sandbox 命令执行 / 权限审批流 / 工具内部执行细节 / model provider 字段**都缺。
- 监控：reader sync 单次读（`reader.ts:55-65`），无 streaming/watch，无法实时盯活跃会话。

**用户**：iknow 开发者本人（agent/工具运行时开发者），用 `iknow ask` / `iknow serve` / `iknow tui` 跑 agent 时遇到"这轮为啥挂了 / 工具到底返回了什么 / 会话跑到哪了"。

**成功后**：

- 一个 `iknow trace` 命令启动 → 自动开浏览器 → 看到最近活跃会话的**6 环节流程图**（会话/LLM/工具/沙箱/权限/异常），错误节点一眼可见；
- 列表侧可切会话、可看历史（每会话独立文件，并发写无锁）；
- 前端 1s 轮询活跃会话的事件增量，监控当前正在跑的会话；
- 字段扩展时无需改读侧（reader 把未知字段存 `raw.unmapped` 池）。

**非目标**：

- B-scope OTel 导出（`observability-bridge.ts` 留桩即可）；
- chat TTY REPL 补接 trace（ADR-0003 D10 排除，#289 延后）；
- 流式进度可视化（已砍）；
- 远程/分布式追踪（iknow 是单进程本地调试工具）；
- 字段表自动从 schema 推导（fields.ts 仍是手写 SSOT，仅对**未知**字段动态兜底）。

## Tech Stack

- **语言**：TypeScript（`tsconfig.json`：ES2022 / NodeNext / strict / noUnusedLocals / verbatimModuleSyntax / isolatedModules）。
- **模块**：ESM（`package.json` `"type": "module"`）；TS 源用 `.js` 后缀相对导入。
- **运行时**：Node.js server-side。
- **测试**：Node built-in test runner via `tsx --test`（项目约定；同 016/017 spec）。
- **前端**：React 19 + Tailwind v4 + Vite（已在 `web/package.json`）；TypeScript 严格。
- **新依赖**：无。A-scope 零新 runtime 依赖；JSONL 仍是纯文本 `grep`-able。复用 `crypto.randomUUID()`、`node:fs` (sync)、`node:http`。
- **环境变量**：
  - `IKNOW_TRACE_OUT`（既有，写侧，env.ts SSOT）—— **目录路径**（本 spec 改造）；
  - `IKNOW_TRACE_MAX_CONTENT_BYTES`（新增，内容捕获限长，默认 65536 = 64 KiB）；
  - `IKNOW_TRACE_CAPTURE_THOUGHT`（新增遗留项，默认 0，思维链门控）；
  - 命名遵循 `IKNOW_*` 前缀（ADR-0001 既有约定）。

## Commands

```bash
# Type check (project-wide)
npm run typecheck

# Full test suite (Node built-in runner via tsx)
npm test

# Per-spec tests (本 spec 涉及模块)
npx tsx --test tests/harness/trace/*.test.ts tests/traceserver/*.test.ts

# Real-data smoke（真实 agent 跑 → trace 落地）
npx tsx src/cli.ts ask "test question"          # 默认 ./trace/，写盘
npx tsx src/cli.ts trace                         # 默认 ./trace/，自动开浏览器 → http://127.0.0.1:24881/
npx tsx src/cli.ts trace --no-open               # CI/headless：不自动开浏览器
npx tsx src/cli.ts trace --trace-out /tmp/r/    # 指定目录
IKNOW_TRACE_OUT=/tmp/r npx tsx src/cli.ts serve   # serve 长驻用此 env 写目录
npx tsx scripts/trace-migrate.ts ./trace.jsonl ./trace/   # 一次性迁移（破坏性变更）

# 验证 6 环节全部可见（写侧覆盖）
npm run probe:trace-phases    # 见 Open Questions §Q3（新加 npm script）

# 浏览器端 verify（开发）
npm run web:dev               # vite HMR；trace.html 走 /api/v1/traces
```

## Project Structure

**改动 21 个文件 + 新增 13 个 = 34 个物理文件**（精确盘点闭合账目；前几轮"8 / 13+6 / 14+7 / 21+9"皆因含跨 commit 重复标 MODIFIED 或漏计 commit 1 拆层新文件不闭合）。按 **5 commit 单元（commit 1-5）** 组织，每个 commit 一个 PR 一个独立 review（满足"1 commit = 1 logical task"）。**每文件在同一 spec 中只标一次（NEW 或 MODIFIED），不跨 commit 重复**——commit 1 拆出的 NEW 文件在 commit 3 "implement" 视为原 NEW 的延续，不另算 MODIFIED。

### Commit 1（纯重构，零功能变更）— 拆 hub.ts（拆三层，对齐 ≤300 lines/file 规则）

```
src/session-api/
├── trace-recorder.ts         # NEW: trace 写入职责独立模块（≤300 行）；抽象 JsonlTraceService 注入；hub.ts 不再直接持有 appendFileSync
├── session-store.ts          # NEW: 会话文件 IO 抽独立模块（≤300 行，封装 SessionStore 当前在 hub.ts 内的 load / save / list / drop 逻辑）
├── lifecycle-manager.ts      # NEW: postMessage 入口编排 + 缓存 deps + violation hook 编排（≤300 行，从 hub.ts 抽出）
├── session-cache.ts          # NEW: 会话 metadata 内存缓存层（≤300 行，从 hub.ts 抽出）
└── hub.ts                    # MODIFIED: 删 trace 写入 + session IO + lifecycle 编排 + 缓存代码；保留纯 facade（构造 + 组装 lifecycle/recorder/store/cache + 对外暴露 session 列表 / postMessage 委托）；hub.ts 行数从 796 → ≤ 300（拆三层，净减 496+）

tests/session-api/
├── trace-recorder.test.ts    # NEW: TraceRecorder 单元测试（与 hub.ts 解耦后单独可测）
├── session-store.test.ts     # NEW: SessionStore 单元测试（与 hub.ts 解耦后单独可测）
├── lifecycle-manager.test.ts # NEW: LifecycleManager 单元测试
└── session-cache.test.ts     # NEW: SessionCache 单元测试
```

**前置条件**：执行 Commit 2-5 之前必须先完成 Commit 1。
**验收**：

- `npm test` 通过；
- `wc -l src/session-api/hub.ts` ≤ **300 行**（硬阈值，对齐 complexity-anti-drift 规则 ≤300 lines/file）；
- `wc -l src/session-api/{trace-recorder,session-store,lifecycle-manager,session-cache}.ts` 各自 ≤ 300 行；
- `grep -r "appendFileSync" src/session-api/hub.ts` 0 命中；
- `grep -r "readFileSync\|writeFileSync" src/session-api/hub.ts` 0 命中（IO 移走）；
- `wc -l src/session-api/hub.ts` 净减 ≥ **496 行**（796 → ≤300），不是 "−20+"；
- 4 个新模块各自单元测试与 hub.ts 解耦（hub.ts 改动不影响 4 个模块测试）。

### Commit 2（写侧类型层，零运行时行为变更）

```
src/harness/trace/
├── types.ts                  # MODIFIED: 扩 LlmCallRecord 加 modelRequested/modelActual/provider（spec 欠账补全）；新增 SessionRecord / SandboxCmdRecord interface（不埋点）
├── index.ts                  # MODIFIED: 导出新 record 类型
└── observability-bridge.ts   # NOOP（B-scope 留桩）

src/traceserver/
├── fields.ts                 # MODIFIED:  TRACE_FIELD_DEFS 加 session / sandbox_cmd / agent_version / model_* / provider 字段声明（声明表 SSOT）
└── types.ts                  # MODIFIED:  TraceRecordType union 加 "session" | "sandbox_cmd"

tests/harness/trace/
└── types.test.ts             # MODIFIED: 新 record 类型 shape 测试（12+）
```

**验收**：`npm run typecheck` 通过；既有测试不退化；无新增 runtime 行为。

### Commit 3（写侧埋点 + 每会话独立文件 + 迁移）

> **注**：trace-recorder.ts 与 session-store.ts 在 commit 1 已 NEW，本 commit 在其内 implement 业务方法（视为 commit 1 NEW 的延续，**不另算 MODIFIED**）。hub.ts 同样在 commit 1 已 MODIFIED，本 commit 只"wire TraceRecorder 调用点"，仍归 commit 1 改动范畴。

```
src/session-api/
├── trace-recorder.ts         # (commit 1 NEW 续) implement recordSession / recordSandboxCmd / recordLlmCall (model 字段) / recordViolationTrace (路径改写)；每 postMessage 拼 `<traceDir>/<convId>.jsonl`
├── session-store.ts          # (commit 1 NEW 续) 无逻辑改动（commit 1 已抽完）
└── hub.ts                    # (commit 1 MODIFIED 续) wire TraceRecorder：在 postMessage 入口调 rec.recordSession(...)；recordViolationTrace 调用 trace-recorder.recordViolation(...)（不是自己写文件）

src/harness/trace/
└── jsonl.ts                  # MODIFIED: writer 接受 filePath 由 caller 拼路径；maskJsonLine 仍生效（POSTEL A3：sandbox_cmd schema 定义但运行时埋点由 sandbox violation 间接落，不直接生成 sandbox_cmd 行）

src/cli/usage.ts              # MODIFIED:  chat 不写 trace 的注释修正（usage.ts:61-62 实际从未写 trace）

scripts/
└── trace-migrate.ts          # NEW: 一次性迁移脚本（读 ./trace.jsonl → 按 conversation_id 分文件写 ./trace/）

tests/
├── harness/trace/
│   ├── jsonl.test.ts         # MODIFIED: 加每会话独立文件路径测试（6+）
│   └── integration.test.ts   # NEW: 真实并发写入多会话（每文件一行；reader 增量读取；session 根 record）
└── trace-migrate.test.ts     # NEW: 迁移脚本端到端（旧单文件 → 目录多文件，每行原样保留；8+）
```

**验收**：SC-1（1-5）、SC-2（6-9）通过。

### Commit 4（读侧会话列表 + 下钻 + 增量读取 + 自动 open + CLI 默认目录）

```
src/traceserver/
├── reader.ts                 # MODIFIED:  createJsonlTraceReader 按 filePath 读单文件；新增 query({conversationId, sinceOffset?}) 增量接口；limit/offset 仍生效
├── http.ts                   # MODIFIED:  GET /api/v1/traces 支持 sinceOffset；GET /api/v1/sessions 列目录（new）；GET /api/v1/traces 缺省 conversation_id → 最近活跃
└── serve.ts                  # MODIFIED:  traceDir 而非 traceFilePath；detect 旧 ./trace.jsonl 报错（fail-fast）；自动 open 浏览器

src/cli.ts                    # MODIFIED:  DEFAULT_TRACE_PATH "./trace/"；resolveTracePath 改目录；runTrace 默认目录；自动 open 浏览器
src/cli/parse-args.ts         # MODIFIED:  --no-open flag；trace 默认端口 24881（不变）

tests/traceserver/
├── reader.test.ts            # MODIFIED: 增量读取 sinceOffset（6+）；缺省 conversation_id → 最近活跃
├── http.test.ts              # MODIFIED:  /api/v1/sessions 端点（10+）；缺省 conversation_id 路由；sinceOffset 参数
└── serve.test.ts             # MODIFIED: traceDir 行为；旧 ./trace.jsonl 检测报错（4+）
```

**验收**：SC-3（10-13）、SC-4（14-16）、SC-5（17-20）通过。

### Commit 5（前端 FlowTree 接入 + 视图切换）

```
web/src/
├── components/
│   ├── FlowTree.tsx          # NEW (迁移自原型 /tmp/.trash-trace-view/variants/FlowTree.tsx，267 行)：6 站点横排 + 事件垂直落子树 + 回合分组 + 状态色错误红条
│   ├── SessionList.tsx       # NEW: 会话列表（fetch /api/v1/sessions，渲染 conversation_id/mtime/size/agent_version）
│   ├── TracePanel.tsx        # MODIFIED: 加会话列表侧栏 + FlowTree 视图切换
│   └── traceFields.ts        # MODIFIED: 加 session/sandbox_cmd 字段映射 + UI status 派生层（4 视觉态）
├── hooks/
│   └── useTracesData.ts      # MODIFIED: 双层轮询（列表 mtime + 明细增量）；切换会话重置 offset
└── api/client.ts             # MODIFIED: 加 listSessions() / getTraceSinceOffset()
```

**FlowTree.tsx 复杂度声明（前置条件，避免把 267 行/嵌套深 16/17 箭头函数的原型直接搬进生产）**：

- 迁移时**必须重构**，不照抄原型。硬约束（对齐 `complexity-anti-drift` 规则硬阈值）：**单函数 ≤ 30 行、嵌套 ≤ 4 层、参数 ≤ 3、文件 ≤ 300 行**。
- 布局计算（`colCenter`/`stationIdx`/`pos` 绝对定位）抽成纯函数，箭头函数数收敛到 ≤ 5。
- 若重构后仍 > 300 行，拆 `FlowTreeLayout.ts`（纯布局计算，无 JSX）+ `FlowTreeNode.tsx`（单节点渲染）。
- **验收（AND 硬门，全部满足才算通过）**：
  - `wc -l web/src/components/FlowTree.tsx` ≤ 300 行；
  - 单函数 ≤ 30 行（手工核查最大函数行数）；
  - 嵌套 ≤ 4 层（手工核查最深 JSX 嵌套）；
  - 函数参数 ≤ 3（手工核查所有函数签名）；
  - `npx eslint web/src/components/FlowTree.tsx` 启用 `max-lines: [error, 300]` / `max-lines-per-function: [error, 30]` / `max-depth: [error, 4]` / `max-params: [error, 3]` 四条规则无告警。

**验收**：SC-6（21-23）、SC-7（24）通过。

### 文件总数核对（精确盘点，账目闭合）

**每文件在同一 spec 中只算一次（NEW 或 MODIFIED）**，不跨 commit 重复标。

#### NEW（13 个）

1. `src/session-api/trace-recorder.ts`（commit 1 NEW）
2. `src/session-api/session-store.ts`（commit 1 NEW）
3. `src/session-api/lifecycle-manager.ts`（commit 1 NEW）
4. `src/session-api/session-cache.ts`（commit 1 NEW）
5. `scripts/trace-migrate.ts`（commit 3 NEW）
6. `tests/harness/trace/integration.test.ts`（commit 3 NEW）
7. `tests/session-api/trace-recorder.test.ts`（commit 1 NEW）
8. `tests/session-api/session-store.test.ts`（commit 1 NEW）
9. `tests/session-api/lifecycle-manager.test.ts`（commit 1 NEW）
10. `tests/session-api/session-cache.test.ts`（commit 1 NEW）
11. `tests/trace-migrate.test.ts`（commit 3 NEW）
12. `web/src/components/FlowTree.tsx`（commit 5 NEW）
13. `web/src/components/SessionList.tsx`（commit 5 NEW）

#### MODIFIED（21 个）

- commit 1：`src/session-api/hub.ts`（拆三层，对齐 ≤300 lines/file）
- commit 2：`src/harness/trace/types.ts` / `src/harness/trace/index.ts` / `src/traceserver/fields.ts` / `src/traceserver/types.ts` / `tests/harness/trace/types.test.ts`
- commit 3：`src/harness/trace/jsonl.ts` / `src/cli/usage.ts` / `tests/harness/trace/jsonl.test.ts`
- commit 4：`src/traceserver/reader.ts` / `src/traceserver/http.ts` / `src/traceserver/serve.ts` / `src/cli.ts` / `src/cli/parse-args.ts` / `tests/traceserver/reader.test.ts` / `tests/traceserver/http.test.ts` / `tests/traceserver/serve.test.ts`
- commit 5：`web/src/components/TracePanel.tsx` / `web/src/components/traceFields.ts` / `web/src/hooks/useTracesData.ts` / `web/src/api/client.ts`

**修正账目**：NEW 13 + MODIFIED 21 = **34 个物理文件**。**每个 commit 单元内的"跨 commit 续写"（trace-recorder / session-store / lifecycle-manager / session-cache / hub.ts / cli.ts）不再独立列 MODIFIED**，归属于该文件首次出现的 commit。

## Code Style

**命名 + 字段**：snake_case JSONL / camelCase TS（ADR-0003 D8 既有约定；`camelToSnake` 集中在 `jsonl.ts`）。

**会话文件路径拼接**（`SessionHub.postMessage`，`hub.ts:486-498` 改造后）：

```ts
// src/session-api/hub.ts（示意）
const sessionTraceFile = path.join(this.traceOut, `${conversationId}.jsonl`);
const runDeps: LoopEngineDeps = {
  ...deps,
  executor: wrappedExecutor,
  ...(this.traceOut
    ? {
        trace: createJsonlTraceService({
          filePath: sessionTraceFile, // ← 关键：会话级文件路径
          conversationId,
        }),
      }
    : {}),
};
```

**接口扩展**（`src/harness/trace/types.ts`，D1 决议 D1）：

```ts
// 扩 LlmCallRecord（D1 + #286）
export interface LlmCallRecord {
  // ... 既有字段 ...
  modelRequested: string; // SPEC-2 补
  modelActual: string; // SPEC-2 补
  provider: string; // SPEC-2 补
}

// 新增 record 类型（D1 + #286）
export interface SessionRecord {
  agentVersion: string; // D2 / 三关联键契约
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: TraceStatus;
  error?: TraceError;
}

export interface SandboxCmdRecord {
  parentTurnId: string | undefined; // 父 turn 引用（#286 单值 parent_*_id 约定）
  command: string; // 命令本身
  exitCode: number | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: TraceStatus;
  error?: TraceError;
}

// TraceService 接口扩展（D1 决议）
export interface TraceService {
  recordLlmCall(record: LlmCallRecord): Promise<string | undefined>;
  recordToolCall(record: ToolCallRecord): Promise<string | undefined>;
  recordTurn(record: TurnRecord): Promise<string | undefined>;
  // ↓ 新增
  recordSession(record: SessionRecord): Promise<string | undefined>;
  recordSandboxCmd(record: SandboxCmdRecord): Promise<string | undefined>;
  // @throws never — ADR-0003 D13 不变
}
```

**埋点归属（Fix 1 — session 根只属于 session-api，不属 loop-engine）**：

- **session 根记录**：由 `SessionHub.postMessage` 入口埋（`src/session-api/trace-recorder.ts`），每会话一次，与 `conversation_id` 同生命周期。**loop-engine 不埋 session**（loop-engine 不持会话概念，ADR-0003 D5/D10；避免引擎层反向依赖会话）。
- **`agentVersion` 注入源**：由 `SessionHub` 构造参数 `agentVersion: string` 注入，**来源是 caller（CLI/serve 装配时传入 `getVersion()`）**，`session-api` 不反向 import `cli/usage.ts`。**不引入 `useVersion()`**（该 seam 全库不存在，spec 明确不造）。

```ts
// src/session-api/trace-recorder.ts（Commit 1 新建；每 postMessage 一次）
export function createTraceRecorder(opts: {
  traceDir: string; // 每会话独立文件目录
  conversationId: string;
  agentVersion: string; // Force: 由 caller 注入，session-api 不 self-import getVersion()
  writer?: (line: string) => void; // 测试注入
}): TraceService & { recordViolation(reason: string): void };

// src/session-api/hub.ts（Commit 1 之后，wire 调用）
const rec = this.traceRecorderFor(conversationId); // 复用 per-postMessage 装配（同 hub.ts:486-498 既有模式）
await rec.recordSession({
  agentVersion: this.agentVersion, // 构造注入，非 getVersion()
  startedAt: nowIso(),
  endedAt: nowIso(),
  durationMs: 0,
  status: "ok",
});
```

**埋点时机（B 层，在 safeTrace 包裹下）**：`recordLlmCall` / `recordToolCall` / `recordTurn` 的既有 4 处 `loop-engine.ts` `stepWithTrace` 埋点**不动**（这 4 处是引擎层 loop 元数据，与 session 无关）。新增的 `recordSession` / `recordSandboxCmd` **不属于 loop-engine**——都在 trace-recorder（session-api 层）。

**Postel 落地（A3 决议）**：`sandbox_cmd` / `permission` 字段 schema 定义进 types.ts，**但运行时埋点只在 sandbox 违规时通过 `recordViolationTrace` 落 violation + reason=sandbox_violation，其他暂留空**。**不预填占位字段**（遵循 ADR-0003 D9）。<br>
**agent_version 只写 session 根**（Q4 已决策），llm_call 顶层不重填，靠 conversation 关联可查。

## Testing Strategy

- **框架**：Node built-in test runner via `tsx --test`（项目约定）。
- **位置**：`tests/` 镜像 `src/`。
- **目标覆盖率**（F2 决议：50+ 测试覆盖）：
  - **新增 record 类型**：`types.test.ts` 12 测试（每个 record 字段 shape + optional 字段缺席 + Postel 字段缺席语义）。
  - **每会话独立文件**：`jsonl.test.ts` 6 测试（多并发写入隔离；同一会话两次写入同文件追加；不同会话不同文件；maskJsonLine 跨文件生效）。
  - **迁移脚本**：`trace-migrate.test.ts` 8 测试（旧单文件 → 多文件；conversation_id 分组正确；每行原样保留；空文件/坏行/不存在错误路径）。
  - **读侧会话列表**：`http.test.ts` + `serve.test.ts` 10 测试（`/sessions` 列目录 stat 轻量；`/traces` 缺省→最近活跃；带 conversation_id 精确路由；sinceOffset 增量读取；400/404 兼容）。
  - **增量读取**：`reader.test.ts` 6 测试（sinceOffset 只读新增；新文件重置 offset 0；truncated 处理；非法 offset 拒绝）。
  - **旧 ./trace.jsonl 检测**：`serve.test.ts` 4 测试（启动时检测存在 → fail-fast 报错 + 退出码 1 + 提示迁移；不存在正常启动；自动创建空目录）。
  - **前端集成**（v0 既有 30 测试 + 新增 8）：FlowTree 渲染 6 站点；会话切换重置 offset；轮询触发器。
- **测试级别**：unit（types / fields / reader 函数）、integration（hub + session-api + traceserver + 前端 API client 串通）、smoke（真实 agent 跑 → trace 落地 → 面板读，参见 `npm run probe:trace-phases`）。
- **运行**：每次提交前 `npm test`；trace 模块变更强制跑 `tests/harness/trace/` + `tests/traceserver/`。

## Boundaries

**Always do**：

- `await safeTrace(() => trace.recordXxx(...))`（ADR-0003 D13，绝不直接调 `trace.recordXxx`）。
- 新增字段先加 `types.ts` 类型 + `fields.ts` 声明表 + 测试，再埋点。
- 写侧零 fsync、零队列（依赖 `appendFileSync` 原子性 + 目录隔离，#285 D5）。
- 跨文件改动前走 `architecture-change-reviewer` 5-verdict gate。
- 中文 commit message + 1 commit = 1 logical task（项目惯例；本 spec 按 5 commit 单元拆）。
- 覆盖率阈值不在此锁死（项目级约定见 CLAUDE.md / CONTEXT.md；本 spec 只锁"≥50 新增测试 + 既有不退化"）。

**Ask first**：

- 改 `fields.ts` 字段顺序或删除既有字段（破坏面板列）。
- 加新依赖（lockfile 变更需显式授权）。
- 改 `docs/architecture.md` Capability modules 表的描述（SSOT）。
- 改 `usage.ts` / `CHANGELOG.md` 用户可见文案。
- 引入 fs.watch / SSE / OTel SDK（本 spec 明确不引入，但若要引入须新 ADR + assumption gate）。
- `--trace-out` 兼容回退（破坏性变更的过渡策略）。

**Never do**：

- 写 messages / arguments / result 全量进 trace（`messages_captured`/`arguments_captured`/`result_captured` 默认 false 不可临时打开，违反 Postel + 报告红线①）。
- 把 agent 思维链（assistant.message.reasoning 等内省字段）明文入 trace。
- 把 usage token / cost 字段塞进 LoopTrace（CONTEXT.md `LoopTrace` _Avoid_）。
- 把 session_id / turn_id 当数组引用父子（新增 record_type 必须用 `parent_*_id` 单值，#286 决议）。
- 用 `crypto.randomUUID()` 在 `loop-engine.ts` 写 trace ID 上下文（ADR-0003 D5：ID 由 TraceService 生成返回）。
- 删 `traceserver/tests/*.test.ts` 既有测试来让构建通过。
- 把 `trace.jsonl` 旧文件当目录读（破坏性迁移，强制走 `scripts/trace-migrate.ts`）。

## Success Criteria

> **Binary, testable.** 全部满足 = spec 落地完成。每条对应一个或多个测试。

**SC-1 数据模型**：

1. `iknow ask "test"` 在无 `--trace-out` 时写 `./trace/` 目录（非 `./trace.jsonl` 文件）；目录里至少有 `<convId>.jsonl` 一个文件。
2. `iknow serve --trace-out /tmp/r` 起进程，`/tmp/r/` 下有多个 `<convId>.jsonl` 文件（多会话）；每个文件首行 `conversation_id` 与文件名一致。
3. 检测到旧 `./trace.jsonl` 文件存在时 `iknow trace` 启动 exit 1 + stderr 含 "迁移" 提示；不存在则正常启动。
4. `scripts/trace-migrate.ts ./trace.jsonl ./trace/` 把旧单文件按 `conversation_id` 分写到新目录；每行 JSON 解析后 content 字节完全保留（`scripts/trace-migrate.test.ts` 测试）。
5. 同一进程内多 session 并发 `postMessage`：每会话最终独立文件 + 每文件只含该 `conversation_id` 行（不串写）。

**SC-2 环节覆盖**：

6. `llm_call` JSONL 行含 `model_requested` / `model_actual` / `provider` 三个 snake_case 字段（成功分支）。
7. 新增 `session` 记录（`record_type: "session"`，含 `agent_version`）；`sandbox_cmd` 记录 schema 在 `types.ts` 定义（不强制运行时埋点，按 Postel 留位）。
8. `violation` 记录 `reason` 字段枚举扩展（至少含 `sandbox_violation` / `permission_denied`）；**不复用 record_type 新建**。
9. `agent_version` 字段 = `SessionHub` 构造参数注入的值（caller 在装配时传入 `getVersion()` 返回值；**session-api 不反向 import `cli/usage.ts`，不引入 `useVersion()`**）；只写 session 根记录，llm_call 顶层不重填。

**SC-3 读侧会话列表 + 下钻**：

10. `GET /api/v1/sessions` 返回 200，body 含 `sessions: [{conversation_id, mtime, size, agent_version}, ...]`；不读文件内容（测试用 mock fs 验证 `readSync` 调用 0 次）。
11. `GET /api/v1/traces?conversation_id=<id>` 路由到 `<traceDir>/<id>.jsonl`；记录来自该文件 + 应用现有 reader 过滤。
12. `GET /api/v1/traces`（缺省 `conversation_id`）返回最近活跃会话（mtime 最大）的明细，**不是 400**。
13. `GET /api/v1/traces?conversation_id=nonexistent` → 404 not_found（不在最近活跃范围内）。

**SC-4 实时监控**：

14. `GET /api/v1/traces?conversation_id=<id>&since_offset=<bytes>` 返回 `{records, new_offset, has_more}`；`new_offset` 等于文件当前 size；连续两次调用之间只有新追加的行被返回（不重发）。
15. `?since_offset > file_size` → 400 validation（offset 非法）。
16. 文档/前端使用 1s 默认轮询；`?poll=0` 在 server 不影响响应（仅是前端行为）；前端 `useTracesData` 钩子实现双层轮询（列表 mtime + 明细增量），切换会话重置 offset。

**SC-5 启动体验**：

17. `iknow trace`（无 `--trace-out`）默认指向 `./trace/`，自动 `open` 浏览器到 `http://127.0.0.1:24881/`；CLI 输出含 "Trace 检测面板" 字样。
18. `iknow trace --no-open` 不开浏览器，CLI 行为相同（端口/响应/进程常驻）。
19. `iknow serve` 启动保持纯交互（**不**自动 `open` 浏览器；**不**连带开 trace 进程）；CLI 提示 "trace 面板请另起 `iknow trace`"。
20. CI/headless 下 `--no-open` 是默认（若 `CI=true` 环境变量则自动 `--no-open`，无须手动传）。

**SC-6 可视化主视图（FlowTree 接入）**：

21. `web/src/components/FlowTree.tsx` 存在，渲染 6 站点横排（session/llm/tool/sandbox/permission/violation）+ 事件按归属垂直落入各自子树 + 回合分组 + 状态色错误红条。
22. `TracePanel.tsx` 提供视图切换（表格 / FlowTree），切换不丢失当前会话选中。
23. UI `status` 派生层把 trace 2 值 `ok/error` + `violation.reason` + `tool_kind` 映射到 4 视觉态（ok/warn/denied/error）；trace JSONL 仍 2 值（`tests/.../fields.test.ts` 验证派生函数）。

**SC-7 字段扩展性**：

24. 新增一个不在 `fields.ts` 声明的 JSONL 字段（如自定义 `__test_marker`）：reader 不丢弃，存入 `row.__raw_unmapped__` 池；面板"其他字段" tab 渲染；fields.ts 不报错（`assertUniqueFieldDefs` 不命中）。

**SC-8 内容捕获门控（遗留项，spec 不实现，仅定义 env）**：

25. `IKNOW_TRACE_MAX_CONTENT_BYTES` env 在 `env.ts` 注册（默认 65536 = 64 KiB）；`IKNOW_TRACE_CAPTURE_THOUGHT` 注册（默认 0）；**spec 不要求实现读取，仅 env 声明 + 类型**（实现留到后续独立 ticket）。

**SC-9 回归**：

26. `npm test` 通过；trace / traceserver / session-api 全部既有测试不退化（≥50 测试通过）。
27. `npm run typecheck` 通过（src + web 两侧）。
28. 既有 `iknow-trace-standalone-service.md` 9 条判据全部继续满足（不破坏既有 spec）。

## Open Questions

**Q1 — Postel 与决议一致性的边界（A3 决议的进一步细化）**

`session` 记录由 `run()` 入口埋点（必有），`sandbox_cmd` schema 定义但 runtime 暂不埋点（pendingRuntime）。但 `permission` 决定**复用 violation + reason 枚举**——这等价于 permission 走 violation 路径，**未违反 Postel**（埋的是已有能力）。**没有 Q1 遗留**。

确认 `session` 记录由 `run()` 入口埋、sandbox_cmd 仅 schema；`permission` 走 violation 复用。→ **已决策**。

**Q2 — chat 是否纳入**

ADR-0003 D10 + wayfinder #289 都明确 chat 排除。**严格排除**。本 spec 不写 chat 接入代码。

**Q3 — `npm run probe:trace-phases` 是否新增**

实现期才需要（端到端真实 agent 跑 → 6 环节全部可见）。本 spec **只要求 npm script 占位 + 注释**（明确写"端到端 smoke 留到实现"），不在 SC 中硬性要求存在。

**Q4 — `agent_version` 在 llm_call 顶层也填？**

报告三关联键契约要求 + C2 决议"复用 `getVersion()`"——**只填 session 根**（避免每条记录冗余，JSONL 单调长）。llm_call 不重填，靠 conversation 关联可查。**已决策**（session 根 = 版本锚点）。

**Q5 — 测试覆盖率是否锁死 ≥ 80% 行 / ≥ 70% 分支**

**F2 决议给的是 ≥50 测试数**（不锁死百分比）。SC-26 写"≥50 测试通过"。百分比阈值是项目级约定（`docs/CONTEXT.md` / CLAUDE.md），不在本 spec 重复。→ **已决策**。

**Q6 — 写入 `raw.unmapped` 池的字段命名约定**

决议给的是"reader 不丢未知字段存 `raw.unmapped` 池"。**具体键名**未锁——`__raw_unmapped__` 是提议，与既有 JSONL 字段不冲突（双下划线前后缀是 Python/TS 私有习惯）。**实现期可微调为更稳定命名**（如 `__unmapped_fields__`）。→ **已留实现弹性**。

**Q7 — `--trace-out` 破坏性迁移的用户可见警告**

`iknow trace` 检测到旧 `./trace.jsonl` → exit 1 + stderr "请运行 `npx tsx scripts/trace-migrate.ts ./trace.jsonl ./trace/`"。但 `iknow serve` / `iknow ask` 启动时若检测到旧文件，是否也要 exit 1？**目前决议只 trace 命令检**（#285 D3 决议），serve/ask 沿用——避免破坏开发流。**确认**。

---

## ACR Verdict Block (5-line verdict, filled by `architecture-change-reviewer` after 5 rounds)

```
bounded-context-guardian:        yes — session 根只归 session-api（spec:282 loop-engine 不埋 session）；agentVersion 由 caller 注入、session-api 不反向 import cli/usage.ts 也不造 useVersion() seam（spec:283）；trace-recorder/session-store/lifecycle-manager/session-cache 拆入 session-api 层（spec:84-87），harness/trace 仅供类型与 jsonl，单向依赖无反向/循环
defensive-contract-validator:    yes — 5 边界类（empty/negative/overflow/concurrent/exception）均有具名测试锚点；spec 自报 ≥50 新增测试 + 既有不退化（spec:299/375）
error-handling-enforcer:         yes — safeTrace 包裹绝不直调（spec:329）+ @throws never（spec:276, ADR-0003 D13）；400/404 typed（SC-13/SC-15 spec:344/349）；旧 trace.jsonl fail-fast exit1 + 迁移提示（spec:328, SC-3 spec:269）
complexity-anti-drift:           yes — hub.ts 拆三层（trace-recorder + session-store + lifecycle-manager + session-cache）硬阈值 ≤300 行（spec:88/101/105，净减 ≥496 算术自洽）；FlowTree 验收 AND 硬门（spec:191-196，eslint max-lines/function/depth/params 四条 error 门禁）
minimal-change-verifier:         yes — 文件账闭合 NEW 13 + MODIFIED 21 = 34（spec:78,200-228）；5 commit 单元各自独立 reviewable；跨 commit 续写（trace-recorder/hub 等）有正当理由（commit 1 拆模块、commit 3 实现，各自逻辑任务完整）
```

**OVERALL: PASS**（5/5 yes after 5 rounds; spec 进入 Step 5 handoff writing-plans）

## References

- wayfinder 地图 #284 (GH issue)
- ADR-0003 (trace service domain interface) — `docs/adr/0003-trace-service-domain-interface.md`
- ADR-0008 (token accounting usage placement) — `docs/adr/0008-token-accounting-usage-placement.md`
- ADR-0001 (9router stack-as-code env var naming) — `docs/adr/0001-9router-stack-as-code-defaults.md`
- 既有 spec: `specs/trace-service.md`（写侧接口）/ `specs/traceserver-inspection-panel.md`（读侧面板 v0）/ `specs/iknow-trace-standalone-service.md`（独立 trace 子命令）
- `docs/CONTEXT.md`（LoopTrace / usage 术语与 _Avoid_）
- Agent Trace 调研报告（`/mnt/e/训练集/agent-learn/agent-trace-guide/`）
- 原型成果物：`/tmp/.trash-trace-view/variants/FlowTree.tsx` + `data/types.ts`（6 站点横排树状拓扑）
