# Spec: Session API 路径迁移到 harness foundation（022 / #51）

> **Lean spec.** #51 ticket Q1-Q5 Resolution 是本 spec 的权威先决决议；本 spec 只补充 Resolution 未钉死的实施层细节（端点形状、文件改动清单、type 签名约束、Success Criteria、Boundaries、ACR gate）。未在本 spec 重述的内容，以 #51 Q1-Q5 Resolution + 014/015/016/017 冻结契约 + 018/019/020/021 已落地 commit 为准。

## Assumptions (confirmed)

> 以下 20 条假设经操作员逐条确认（2026-07-30），构成本 spec 的实施层决策基础。
> wayfinder #51 Q1-Q5 Resolution 作为先决决议直接引入，不在本 list 重开。

1. **A1 spec 路径**：`specs/022-session-api-migration.md`（对齐 016/017 spec 命名惯例：kebab-case 描述性 slug）。
2. **A2 spec 形态**：lean spec。Q1-Q5 grilling 决议作为「先决决议」直接引用，不在 spec 体内重开。spec 只补实施层细节。
3. **A3 spec 不替代 016/017/020 spec**：CLI 路径 spec 是 020 范围（`specs/<020-spec-slug>.md` 如已存在），#51 不重写 CLI 路径。foundation 行为契约以 016/017 spec 为准。
4. **A4 spec 不替代 #51 Resolution**：#51 Resolution 写进 GitHub issue comment（wayfinder 决议登记），spec 是其下游工程展开。
5. **A5 in-scope ADR = ADR-0001**（9router stack code defaults）。#51 范围不直接修改 `src/config/env.ts` 栈默认 - 仅在 Architectural Constraints 提一句「不动 env.ts 栈默认」（避免误改导致模型/endpoint 漂移）。
6. **A6 术语 SSOT = `docs/CONTEXT.md`**：Loop Engine / append-only messages / LoopTrace / StopReason / in-flight closeout / ToolExecutionContext / required runtime layer / ConversationState (deprecated) / G2 (deprecated)。spec 不重定义，只在 Architectural Constraints 段引用。
7. **A7 架构 SSOT = `docs/architecture.md` Capability modules 表**（Session API 行 + Harness (Foundation) 行）。spec 仅引用，不重画架构。
8. **A8 tech stack 零新增依赖**：继承 020 spec Tech Stack（TypeScript ES2022 / ESM / Node ≥20 / ajv strict / vitest）。#51 不引入任何新 runtime / dev 依赖。
9. **A9 测试框架沿用现有 vitest**（020 已迁 vitest）。不引入 playwright / cypress 等前端 e2e 框架。
10. **A10 web 适配完成证据** = (a) `npm run typecheck` exit 0 + (b) `npm test` exit 0 + (c) `npm run build`（vite build）exit 0 + (d) 手动冒烟：iknow serve + 浏览器 4 个场景（发消息 / 刷新页面恢复 / 新建会话 / 切换历史会话） + (e) 截图存 `docs/handoff/<date>-web-adapt/`。不引入前端自动化测试。
11. **A11 数据存储路径**：`data/sessions/<conversation_id>.json` 在仓库根目录。`data/` 加入根 `.gitignore`（数据不入 git、不进 commit、不进 diff）。
12. **A12 归档目录**：`docs/archive/022-retire-interaction/`，对齐 021 归档模式（`docs/archive/021-retire-legacy-loop-and-eval/` + README 记录退役理由 + 归档内容清单）。`tests/interaction.test.ts` 物理删除（其测试对象已归档）。
13. **A13 CHANGELOG 条目约定**：对齐 021 格式 `### Breaking (internal, pre-release)`。因 `package.json` `private: true` + `0.1.0 (unreleased)` 无外部消费者，仅记录内部 API 变更审计可追溯。
14. **A14 序列化方式** = JSON（不是 JSONL / SQLite / LevelDB / 文件锁）。对齐项目「不预建条件式修复层」「不引入新依赖」主线。
15. **A15 并发约定** = 单进程（`iknow serve` 是单 node 进程）。同 conversation_id 串行写用进程内 `Map<id, Promise<void>>` 串行化；不引入文件锁 / 跨进程 IPC / 共享内存。`run()` 期间临时持有 `priorMessages` + `result.messages` 仅作函数参数和返回值，不构建第二份权威副本（守 014）。
16. **A16 hub.ts 改造路径**：复刻 020 `src/cli/chat-session.ts:74-89` 写法（load JSON -> `run(opts.priorMessages)` -> save JSON），不引入新状态机框架 / 不引入 Observable / 不引入 FSM 库。LiveSession 是 hub 内部状态对象，仅在 hub 进程内存活。
17. **A17 spec 不规定工具函数具体签名**：如 `SessionStore` class 的 method 列表、`LiveSession` 内部字段排序、JSON 读写 helper 函数命名 -- 留给 writing-plans。
18. **A18 spec 不规定 UI 视觉细节**：会话历史侧栏的宽度 / 折叠态 / 动画 / 排序键 / 摘要长度 -- 留给 writing-plans / implementation。
19. **A19 spec 不规定 HTTP 端点具体 URL path**：仅约束「既有 `/api/v1/sessions` 等端点的 4 个改动 + 新增 1 个列表端点 + 删除 1 个 commands 端点」的概念边界；具体 path 形态（如 `/v1/sessions` vs `/api/v1/sessions`）沿用 020 已落地的 `src/session-api/http.ts` 既有 path。
20. **A20 Open Questions 默认空**：任何 unresolved 项必须先 grill 再写 spec，不允许「先写 plan 后盘」。

## Objective

**What**: 把 Session API 路径（`iknow serve`）从旧 loop（`src/agent-loop/` + `src/interaction/` + `IknowAnswer`）切到新 harness foundation（`src/harness/run()`），同时退役 G2 envelope、退役 Session API slash 体系、归档 `src/interaction/`、改造 web 前端跟随新 wire、新增「会话历史侧栏」。

**Why**: 018 refined 后的迁移主线最后一站。020 已把 CLI 路径切到 harness（commit b1e1fb6），021 已砍旧 EVAL + 公开面 BREAKING（commit 93813b0），022 闭环 serve 路径 = foundation 成为唯一循环底座 + `src/interaction/` 真正归零。`src/agent-loop/` 7 文件（`loop.ts`/`llm-agent.ts`/`llm-client.ts`/`session.ts`/`priors.ts`/`tool-defs.ts`/`trace.ts`）在 #51 完成后可安全归档/删除。

**Who**:

- 实施者：本 spec 的下游 `writing-plans` 消费者 + 实施 agent。
- 用户：web SPA 用户 + `iknow serve` API 调用者 + CLI 用户（CLI 不受影响，020 已切）。

**Success**: Session API 路径真实跑通（真实模型 + 演示工具 + harness `run()` 多 step + trace 可见）；`src/session-api/` 不再 import 旧 `src/agent-loop/` / `src/interaction/`；`TurnDto` wire 契约与 harness 形态对齐；web 前端跟随 wire 适配 + 会话历史侧栏可切换；`src/interaction/` 在 Session API 路径归零；`npm run typecheck` + `npm test` + `npm run build` 通过；code review 确认不破坏 019/020/021 成果。

## Tech Stack

继承 020 spec Tech Stack，零新增依赖：

- **Language**: TypeScript（ES2022 / NodeNext / strict / noUnusedLocals / verbatimModuleSyntax / isolatedModules）。
- **Module**: ESM（`"type": "module"`）；TS 源码内部相对导入用 `.js` 后缀。
- **Runtime**: Node ≥20。`AbortController` / `AbortSignal` / `fs/promises` / `node:http` 均为 Node 内建，不引入 polyfill。
- **Model SDK**: `@anthropic-ai/sdk`（019 真实接入，017 signal/timeout 透传）。
- **JSON Schema validator**: `ajv@^8.17.1` + `ajv-formats@^2.1.1`（015 冻结），`strict: true`。
- **Test runner**: vitest（020 迁入，016/017 旧 tsx 套件已迁）。
- **Web build**: Vite + React 19 + TypeScript（`web/package.json` 已锁定）。

> Tech stack 变更需新假设门（spec-driven-development Iron Law）。#51 不新增任何 runtime / dev 依赖。

## Commands

```bash
# Type check（项目根）
npm run typecheck

# Full test suite（vitest）
npm test

# Web build（web/ 子包）
cd web && npm run build

# Serve smoke（实施期手动）
npx tsx scripts/i11-session-api-harness-smoke.ts   # 对齐 i9/i10 惯例（脚本名实施期定）
```

> 命令继承项目 `package.json` scripts + `web/package.json` scripts，#51 不新增 npm script（除实施期 smoke 脚本，按需加入 `scripts/`，对齐 i9/i10 命名惯例）。

## Project Structure

继承 020 已有结构 + 021 归档惯例，零新根目录。具体改动文件清单留给 implementation，但 spec 必须给出**模块级责任**：

```
src/
├── harness/                          # 【不动】Foundation 016/017 已落地，#51 消费者
│   ├── loop-engine.ts                #   提供 run(userText, deps, signal?, opts?) 与 step()
│   ├── loop-trace.ts                 #   LoopTrace A 层元数据
│   ├── model-adapter/                #   Anthropic adapter (real / stub)
│   └── tools/                        #   registry + executor + tool-result
├── session-api/                      # 【改】hub.ts / contract.ts 跟随 Q1-Q3 改；serve.ts / http.ts 端点级改
│   ├── hub.ts                        #   LiveSession 状态机从 buildAgent -> runHarness
│   ├── contract.ts                   #   TurnDto.answer: IknowAnswer -> { finalText, stopReason, turnCount }
│   ├── serve.ts                      #   启动流程调整
│   ├── http.ts                       #   路由表：新增 GET /sessions 列表 / 删 POST /sessions/:id/commands
│   └── index.ts                      #   barrel 跟随改
├── cli/
│   ├── runtime.ts                    # 【改】buildAgent 退役（hub 不再 import）；保留 buildHarnessEngine（CLI 用）
│   └── {chat-session,slash,format}.ts # 【不动】CLI 路径 020 已切 harness
├── shared/
│   └── schema.ts                     # 【改】删 interface IknowAnswer；SessionContext 保留（harness 工具层 caller-role 注入，015 ACI 契约）
├── interaction/                      # 【删/归档】5 文件全归档到 docs/archive/022-retire-interaction/
└── agent-loop/                       # 【删/归档】7 文件在 #51 完成后全归档
                                     #   （loop.ts / llm-agent.ts / llm-client.ts /
                                     #    session.ts / priors.ts / tool-defs.ts / trace.ts）

web/src/
├── api/
│   ├── types.ts                      # 【改】删 IknowAnswer；加 SessionListItem DTO；改 TurnDto
│   └── client.ts                     # 【改】删 postCommand；加 listSessions helper；可能加 GET /sessions/:id history
├── hooks/
│   └── useSessionChat.ts             # 【改】状态机：删 mode/role；加侧栏状态；localStorage 存 conversation_id
├── components/
│   ├── SessionSidebar.tsx            # 【新增】会话历史侧栏
│   ├── AppShell.tsx                  # 【改】挂载侧栏
│   ├── ChatHeader.tsx                # 【改】删 Mode select + Role select
│   ├── G2Panel.tsx                   # 【删】物理删除
│   └── MessageBubble.tsx             # 【改】改读 answer.finalText / stopReason / turnCount
└── {main,App,Composer,ErrorBoundary,MessageList}.{tsx,ts} # 【不动】

tests/
└── interaction.test.ts               # 【删】物理删除（测试对象 src/interaction/ 已归档）

docs/
├── archive/
│   └── 022-retire-interaction/        # 【新增】对齐 021 模式：归档 src/interaction/ 5 文件 + README
│       ├── README.md                 #   退役理由 + 归档内容清单 + Cross-references
│       ├── index.ts
│       ├── types.ts
│       ├── conversation.ts
│       ├── format.ts
│       └── slash.ts
└── handoff/
    └── <date>-web-adapt/              # 【新增】web 适配完成截图（实施期）

data/sessions/                        # 【新增】运行时 JSON 文件存储
└── <conversation_id>.json             #   .gitignore 排除

CHANGELOG.md                          # 【改】加 ### Breaking (internal, pre-release) 条目
```

> 文件名 / 子模块拆分 / LiveSession 内部字段 / JSON helper 命名是实施细节；writing-plans 可微调，但模块级责任不得变。

## Code Style

### wire DTO 约束（Q1 决议落地形态）

```ts
// src/session-api/contract.ts - TurnDto.answer 形状（Q1 决议：纯 harness 投影）

/** 022 Q1: Session API 消息返回壳。harness RunResult 投影，wire 不外露 messages/trace。
 *  字段语义直接映射 src/harness/model-adapter/types.ts 的 RunResult 子集。 */
export interface TurnAnswerDto {
  readonly finalText: string; // 映射 RunResult.finalText
  readonly stopReason: StopReason; // 复用 harness 7 类 StopReason 类型
  readonly turnCount: number; // 映射 RunResult.turnCount（每次 run() 从 0 起）
}

/** 022 Q1: 单次消息往返的 wire 形状。 */
export interface TurnDto {
  readonly query: string; // 用户输入文本
  readonly answer: TurnAnswerDto; // harness 投影，不含 messages/trace
  readonly human_text?: string; // host 投影（jsonMode=false 时填充；实施期定具体形态）
}
```

```ts
// src/session-api/contract.ts - SessionSummary 跟随 Q2-G4 改

/** 022 Q2-G4: wire 移除 caller_role 字段（治理在 host 边界外）。注意：Q2-G4 = wire 去字段，非删 SessionContext 类型——类型保留供 harness 工具层 caller-role 注入（015 ACI 契约）。 */
export interface SessionSummary {
  readonly conversation_id: string;
  readonly mode: "deterministic" | "llm"; // 020 决议保留（CLI/产品 CLI 字段；#51 不删）
  readonly json_mode: boolean;
  readonly turn_count: number;
  readonly prior_count: number;
  readonly embeddings: boolean;
  // caller_role: CallerRole  // 022 删除
}
```

### Session Store 文件 schema 约束（Q2-G1 决议）

```ts
/** 022 Q2-G1: 单会话 JSON 文件 schema。文件路径 = data/sessions/<conversation_id>.json。
 *  hub 在每次 run() 前后读写；进程重启保留（不预热加载）。 */
interface SessionFileV1 {
  readonly schemaVersion: 1; // 预留升级空间
  readonly conversation_id: string; // 与文件名一致
  readonly messages: ReadonlyArray<AnthropicNativeMessage>; // harness append-only 权威
  readonly jsonMode: boolean; // host 投影模式
  readonly turnCount: number; // 当前会话累积 turnCount（每个 message run() 后从 result 取）
  readonly updatedAt: string; // ISO 8601
  // SessionContext 的 wire 字段已退役（Q2-G4 = wire 去 caller_role；SessionContext 类型本身保留，见 SC11）
  // simulate_governance_timeout 字段已退役（Q2-G4）
}
```

### hub.ts 调用形态约束（Q1+Q2 决议落地）

```ts
// src/session-api/hub.ts - postMessage 路径示意（约束调用顺序，具体实现由 writing-plans 定）

// 1. load JSON 文件（lazy 读）
const session = await loadSessionFile(conversation_id);

// 2. 调用 harness run()，opts.priorMessages 从文件取（014 单源 + 020 CLI 写法复用）
const { result, trace } = await run(query, deps, undefined, {
  priorMessages: session.messages,
});

// 3. 写回 JSON 文件（覆盖写 result.messages；含 017 in-flight closeout 决议：
//    cancelled -> 不写；timeout -> 写含 execution_failed tool_result 的 messages）
await saveSessionFile(conversation_id, {
  ...session,
  messages: result.messages, // 014 append-only 权威
  turnCount: session.turnCount + result.turnCount, // 020 turnCount 每条 message 从 0 起 -> 累加
  updatedAt: new Date().toISOString(),
});

// 4. wire 投影（Q1：messages/trace 不外露）
return {
  turn: {
    query,
    answer: {
      finalText: result.finalText,
      stopReason: result.stopReason,
      turnCount: result.turnCount,
    },
  },
};
// trace 立即 GC（Q2-G2：不进 wire 不落盘）
```

### 风格要点

继承 016/017/020/021 风格要点，#51 新增约束：

- **append-only messages 单源**：`session.messages` 全程不动，仅在 `result.messages` 整体替换；禁止原地修改 / push / 索引赋值（守 014）。
- **wire 不外露 messages / trace**：`TurnDto.answer` 仅含 `{ finalText, stopReason, turnCount }`，Anthropic 原生 messages 不出 Session API。
- **cancelled 不写文件**：017 in-flight closeout -> stop `cancelled` 时 `result.messages === session.messages`（整回合不进历史），`saveSessionFile` 可直接 return（no-op），不引入额外状态字段。
- **timeout 写文件**：017 in-flight closeout -> stop `timeout` 时 in-flight tool call 已原子追加 `execution_failed` tool_result，`saveSessionFile` 必须写入。
- **trace 即时 GC**：`const { result, trace } = await run(...)` 后 `trace` 变量在 hub 函数返回前不再被引用；不写日志 / 不写文件 / 不进 wire。
- **LiveSession 最小化**：hub 进程内存仅维护「当前活跃 conversation 的元数据指针」（如最近访问时间、懒加载标志），不持有 messages 副本（messages 全在文件）。具体 LiveSession 字段排序留给 implementation。
- **侧栏数据流**：会话历史侧栏 = 列表元数据（不缓存 messages）。`useSessionChat` 持 `conversation_id`（localStorage 持久）+ 调 `GET /sessions` 拉列表 + 切换会话时调 `GET /sessions/:id` 拉 messages 恢复到 UI。

### 复杂度阈值约束（spec 层钉死，实施层不得超）

继承 017 spec §Complexity thresholds（项目 `code-quality.md` 同款）：

- **Cyclomatic complexity ≤ 10 / 函数**
- **Nesting depth ≤ 4**
- **Function ≤ 40 行**（soft review-trigger；超 60 行 = 拆函数硬闸门）
- **File ≤ 500 行**（超 = 拆模块硬闸门）
- **Params ≤ 4 / 函数**（超 = 引入 options object 硬闸门）
- **Clone rate ≤ 3%**（项目 jscpd 门）

适用对象（实施 agent 必须守住）：

- `src/session-api/hub.ts`（postMessage / postCommand 删除 / createSession / getSession / listSessions / resetSession 路径）
- SessionStore 读写 helper（loadSessionFile / saveSessionFile / listSessionFiles / deleteSessionFile 等）
- `web/src/hooks/useSessionChat.ts` 状态机（含侧栏状态扩展）
- `web/src/components/SessionSidebar.tsx` 组件 + 任何新增的 React 组件

> 阈值是**约束**不是**实现**。A17 仍保留「不规定具体函数签名」，但实施层函数一旦越过阈值必须拆。ACR complexity-anti-drift 在 writing-plans 完成后会复检。

### SessionStore IO 错误契约（typed error contract）

017 spec §In-flight closeout 用 `StopReason` + `execution_failed` 是 typed 错误路径；本 spec 必须把 SessionStore 的 IO 错误也 typed，不允许坍缩到裸 404。

```ts
// src/session-api/store/errors.ts — SessionStore 错误分类（建议命名，实施 agent 微调）

/** SessionStore 错误分类。hub 在 IO 失败时抛此类型，http 层映射到 wire ApiErrorBody。 */
export type SessionStoreError =
  | { kind: "not_found"; conversation_id: string } // 文件不存在
  | { kind: "parse_failed"; conversation_id: string; reason: string } // JSON 损坏
  | { kind: "schema_invalid"; conversation_id: string; field: string } // schemaVersion / 字段类型不匹配
  | { kind: "write_failed"; conversation_id: string; cause: string } // fs.writeFile 失败
  | { kind: "concurrent_write"; conversation_id: string } // 同 id 写已在进行（被串行化器拒绝 -- 实施期可省，依赖 caller 串行）
  | { kind: "io_error"; conversation_id: string; cause: string }; // 其他 fs IO 错误（权限 / 磁盘满 / EROFS）

/** wire 错误响应。继承 src/session-api/contract.ts ApiErrorBody shape（020 已定义）。 */
export interface ApiErrorBody {
  readonly error: {
    readonly kind: SessionStoreError["kind"] | "validation" | "internal";
    readonly message: string;
    readonly conversation_id?: string;
    readonly field?: string;
  };
}
```

**错误映射契约**（hub 层必守）：

| SessionStoreError.kind | HTTP status | wire `error.kind`  | 是否 retryable              |
| ---------------------- | ----------- | ------------------ | --------------------------- |
| `not_found`            | 404         | `not_found`        | 否                          |
| `parse_failed`         | 422         | `parse_failed`     | 否（建议重建）              |
| `schema_invalid`       | 422         | `schema_invalid`   | 否（schema 升级走专门路径） |
| `write_failed`         | 500         | `write_failed`     | 是（client 可重试同请求）   |
| `concurrent_write`     | 409         | `concurrent_write` | 是（client 等 50ms 后重试） |
| `io_error`             | 500         | `io_error`         | 是                          |

**`run()` harness 错误**仍走 harness 7 类 StopReason（completed / maxTurns / nonSuccessStop / protocolError / emptyFinalResponse / **cancelled / timeout**），不进 SessionStoreError 分类。harness 抛 typed harness error（如 stub-model 抛 AbortError）时，hub 转 `stopReason: "cancelled"` 或 `"timeout"` 进 TurnAnswerDto，不抛裸异常。

> 此契约是 spec 层 hard requirement：实施 agent 不得用 bare `throw new Error("...")` 替代 typed SessionStoreError，也不得把所有 IO 错误坍缩成单一 500。

## Testing Strategy

- **测试框架**：vitest（020 已迁）。不引入 playwright / cypress / jsdom 增强。
- **测试层**：
  - **unit**：hub.ts LiveSession 状态机 / SessionStore 读写 helper / JSON schema 校验 / TurnDto 形状
  - **integration**：`src/session-api/` 端到端 HTTP 流（启 `node:http` 监听，ts/tsx 跑测试）+ SessionStore 文件读写 + harness run() 串联
  - **manual smoke**（实施期手动，不进 vitest）：对齐 i9/i10 惯例，新增 `scripts/i11-session-api-harness-smoke.ts`，覆盖 6 条断言（completed / stopReason / turnCount ≥ 2 / 多 step / finalText 非空 / cancelled/timeout 各一）

- **测试覆盖维度**（5 类边界）：
  - **empty**：新建空 conversation 文件 + 首次 run
  - **negative**：messages 损坏 / 文件不存在 / id 不匹配 -> hub 返 typed `SessionStoreError`（404/422），不返裸 500
  - **overflow**：long-running run（多 step） + 大 messages 累计
  - **exception**：cancelled signal（中途 abort） + timeout（adapter 延迟 > timeoutMs）
  - **concurrent**：同 id 并发 POST /messages -> 进程内 `Map<id, Promise>` 串行化（不引入文件锁）

- **覆盖率目标**（unit + integration 层，vitest `--coverage`）：
  - **Line coverage ≥ 80%** for `src/session-api/{hub,contract,http,serve}.ts` + `src/session-api/store/**`
  - **Branch coverage ≥ 70%** for 同上文件
  - **SessionStore error path 必须全 6 类覆盖**：`not_found` / `parse_failed` / `schema_invalid` / `write_failed` / `concurrent_write` / `io_error` 各至少 1 个测试（对应 wire ApiErrorBody.kind 断言）
  - **错误映射契约表**每行至少 1 个测试：assert HTTP status + `error.kind` + retryable 字段
  - **harness run() 错误路径**：cancelled / timeout 各 1 个测试（assert TurnAnswerDto.stopReason 正确，不抛裸异常）
  - **回归套件**（016/017/020）coverage 不下降（基线 = 当前 master vitest coverage，实施前 `npm test -- --coverage` 留底）

- **web 端验证**（手动冒烟，不进 vitest）：
  - 浏览器 4 场景（发消息 / 刷新页面恢复 / 新建会话 / 切换历史会话）
  - 截图存 `docs/handoff/<date>-web-adapt/`，对齐 i4-smoke / i9-smoke / i10-smoke 模式
  - 验证侧栏列表展示、切换后 messages 恢复、刷新后从 localStorage 恢复 conversation_id

- **回归约束**：
  - 016 S1-S11 + 017 S12-S17 全过不回归
  - 020 CLI 集成测试（chat-session / cli-session / cli-harness）全过不回归
  - 019 i9 smoke 6 条 + 020 i10 smoke 6 条全过不回归

> Success Criteria 区把每条转成二元判据。

## Boundaries

- **Always do**:
  - 跑 `npm run typecheck` + `npm test` + `cd web && npm run build` 全绿后才算完成。
  - 严格遵守 014 append-only messages：单源 = 文件；wire 不外露；hub 不持有副本。
  - trace 即时 GC：不写日志 / 不写文件 / 不进 wire（守 Q2-G2）。
  - cancelled -> saveSessionFile no-op；timeout -> saveSessionFile 写含 execution_failed 的 messages（守 017 in-flight closeout）。
  - 同 id 写操作串行化：`Map<id, Promise<void>>` 进程内串行；不同 id 可并行。
  - 归档 `src/interaction/` 5 文件 + `tests/interaction.test.ts` 物理删除。
  - 删除 `src/shared/schema.ts` 的 `IknowAnswer` 类型（SessionContext 保留，见 SC11）+ CHANGELOG 加 Breaking 条目。
  - web 改完手动冒烟 + 截图存 handoff。
  - 不动 `src/config/env.ts` 栈默认（守 ADR-0001）。

- **Ask first**:
  - 新增 runtime 依赖（#51 不新增任何依赖）。
  - 修改 `tsconfig.json` 或 `package.json` scripts（除新增 i11 smoke 脚本）。
  - 调整 `src/harness/` 子模块职责切分（Foundation 已 016/017 冻结）。
  - 调整 `src/cli/` 路径（CLI 已 020 切好）。
  - 修改 014/015/016/017 已冻类型形状（RunResult / LoopTrace / StopReason / LoopEngineDeps）。

- **Never do**:
  - 引入前端自动化测试框架（playwright / cypress / jsdom 增强）- A10 决议。
  - 引入数据库依赖（sqlite / leveldb / prisma / knex / lowdb）- A14 决议。
  - 引入文件锁 / 跨进程 IPC / 共享内存 - A15 决议。
  - 引入新状态机框架 / Observable / FSM 库 - A16 决议。
  - 留 G2 envelope 占位 / 字段映射 - Q1 决议（整体退役，不留壳）。
  - 复活 `src/interaction/` slash 体系 / 命令 - Q3 决议（整体退役，CLI 复用路径留给未来）。
  - 重新启用 `/mode` / `/role` 命令 / Mode select UI / Role select UI - Q2-G4 + Q3 决议。
  - 让 wire 回放 messages 给客户端（破 014 单源原则）- Q2-G3 决议。
  - 让 trace 进 wire / 落盘 / 写日志 - Q2-G2 决议。
  - 删除失败测试让构建通过；把失败测试改成跳过 - 项目 `code-quality.md`。
  - 重开 014/015/016/017 已冻契约（#51 扩展均为「新增端点 + 删旧符号 + 归档目录」方式，不修改 freeze）。
  - **bare `throw new Error("...")` 替代 typed `SessionStoreError`** - ACR error-handling-enforcer 闸门（错误必须 typed 分类）。
  - **SessionStore IO 错误坍缩成单一 500 / 裸 404** - 错误映射契约表（6 类 kind + HTTP status + retryable）必须全落地。
  - **超复杂度阈值不拆函数** - ACR complexity-anti-drift 闸门（cyclomatic ≤10 / nesting ≤4 / 函数 ≤40 行 hard / 文件 ≤500 行 hard / 参数 ≤4 hard）。

## Success Criteria

二元判据（每条 yes/no）：

1. `npm run typecheck` 退出码 0？ □
2. `npm test` 退出码 0（含 016/017/020 套件不回归）？ □
3. `cd web && npm run build` 退出码 0？ □
4. Session API 路径真实跑通（i11 smoke：completed + stopReason + turnCount ≥ 2 + 多 step + finalText 非空 + cancelled/timeout 各一）？ □
5. `src/session-api/` 全部 5 文件 grep 不到 `from "../agent-loop/` 或 `from "../interaction/`？ □
6. `TurnDto.answer` 字段集 = `{ finalText, stopReason, turnCount }`，不含 `messages` / `trace` / `snapshot_id` / `source_spans` / `governance_status` / `tool_calls` / `hops_used`？ □
7. web `useSessionChat` 状态机不持有 messages 副本，`localStorage` 仅存 `conversation_id`？ □
8. web `G2Panel.tsx` 物理删除，`web/src/components/` 下无此文件？ □
9. web `ChatHeader.tsx` 无 Mode select / Role select 入口？ □
10. `POST /api/v1/sessions/:id/commands` 路由物理删除（`http.ts` 无此路由 handler）？ □
11. `src/shared/schema.ts` 无 `IknowAnswer` 类型定义？SessionContext 保留（harness 工具层 caller-role 注入，015 ACI 契约） □
12. `src/interaction/` 目录物理移除（`ls src/interaction/` 报 No such file）？ □
13. `tests/interaction.test.ts` 物理删除？ □
14. `docs/archive/022-retire-interaction/` 目录存在 + 含 README + 含归档 5 文件？ □
15. `data/sessions/` 路径存在 + 根 `.gitignore` 含 `data/`？ □
16. web 手动冒烟 4 场景（发消息 / 刷新恢复 / 新建会话 / 切换历史会话）通过 + 截图存 `docs/handoff/<date>-web-adapt/`？ □
17. web 会话历史侧栏 `SessionSidebar.tsx` 物理存在 + AppShell 挂载 + 列表展示（`GET /sessions`）+ 切换功能（`GET /sessions/:id`）？ □
18. CHANGELOG.md 含 `### Breaking (internal, pre-release)` 条目，记录本次变更？ □
19. 进程重启后旧 conversation_id 文件仍在 + GET `/sessions/:id` 命中 + 返回 messages？ □
20. code review 确认不破坏 019/020/021 成果（CLI 路径不回归 / `src/eval/` 归档不回归 / 公开面 BREAKING 范围不扩大）？ □
21. `src/session-api/` + `src/session-api/store/**` line coverage ≥ 80% 且 branch coverage ≥ 70%（vitest `--coverage`）？ □
22. SessionStoreError 6 类（`not_found` / `parse_failed` / `schema_invalid` / `write_failed` / `concurrent_write` / `io_error`）各 ≥ 1 个 vitest 测试覆盖？ □
23. SessionStore 错误映射契约表 6 行（HTTP status + `error.kind` + retryable）每行 ≥ 1 个 vitest 测试？ □
24. `hub.ts` / SessionStore / `useSessionChat.ts` / `SessionSidebar.tsx` 无函数超 cyclomatic ≤10 / nesting ≤4 / 函数 ≤40 行（hard）/ 文件 ≤500 行（hard）/ 参数 ≤4（hard）？ □

> 判据 5（`src/session-api/` 不 import 旧符号）是「Session API 路径真正切到 harness」的**显式守门**。
> 判据 6（TurnDto.answer 字段集）是 Q1 wire 决议的**显式守门**。
> 判据 7（web 不持有 messages 副本）是 Q2-G3 单源原则的**显式守门**。
> 判据 12（`src/interaction/` 物理移除）是 Q4 归档的**显式守门**。
> 判据 16（手动冒烟 4 场景 + 截图）是 A10 web 证据的**显式守门**。
> 判据 21（覆盖率）+ 22（SessionStoreError 全覆盖）+ 23（错误映射契约覆盖）是 ACR defensive-contract-validator + error-handling-enforcer 的**显式守门**。
> 判据 24（复杂度阈值）是 ACR complexity-anti-drift 的**显式守门**。

## Open Questions

无。#51 Q1-Q5 Resolution + 本 spec A1-A20 假设已覆盖全部实施层决策点。剩余 LiveSession 字段排序 / SessionStore method 列表 / SessionSidebar 视觉细节 / i11 smoke 脚本名 / handoff 截图具体日期等属于 writing-plans / implementation 范围，不阻塞 spec。

---

## Architectural Constraints

- **in-scope ADR**：ADR-0001（9router stack as code defaults）。#51 范围**不修改** `src/config/env.ts` 栈默认；保留 ADR-0001 的「项目栈决策焊进 env.ts」原则，避免误改导致模型/endpoint 漂移。
- **领域语言**（引自 `docs/CONTEXT.md`，不重定义）：
  - **Loop Engine**：Foundation 的状态机运行内核，位于 `src/harness/`，作为 018 退役旧 loop 后的可靠运行时基础。
  - **append-only messages**：Foundation 的权威 Anthropic 原生会话历史，是唯一事实来源；消息只能以不可变追加（`[...prev, x]`）更新，禁止原地修改或建立第二份权威副本。
  - **LoopTrace**：Foundation `run()` 的第二返回面 `{ result, trace }`；trace 是 A 层结构元数据（不含 payload），与 014 messages 唯一权威严格解耦，immutable 累积。
  - **StopReason**：Foundation Loop Engine 的 7 类停止判别联合（completed / maxTurns / nonSuccessStop / protocolError / emptyFinalResponse / **cancelled / timeout**）。
  - **in-flight closeout**：abort/timeout 发生时的收尾语义--模型在途则整回合不进历史（`finalState = 入口 state`）；工具在途则 assistant 回合已原子追加（不可回滚），在途 tool call 填 `execution_failed`（message 固定 "cancelled"/"timeout"）。
  - **ToolExecutionContext**：Executor 透传给 handler 的执行上下文 `{ signal }`；run 第三参 signal 原样透传、不创建子 signal。
  - **required runtime layer / conditional remediation layer**：017 两层对仗边界--required 已实施；conditional remediation（自动重试、token-cost 护栏、trace B 层字段、工具分类超时、错误分类细化、总耗时独立 stop、OTel-span-metric 树）017 显式禁止，#51 不预建。
  - **ConversationState**：Host 层多轮袋--**Deprecated for CLI path since 018 (refined 2026-07-29)**；retained for Session API migration ticket（owner = #51）。#51 完成后**整体归档**。
  - **G2**：agent response envelope--must carry `snapshot_id` (and citation fields when answering from KB) before return to user。**#51 整体退役**，snapshot_id 随旧 KB 工具弃用（019）自然消亡。
- **消歧**（引自 `docs/CONTEXT.md` Flagged ambiguities）：
  - **LoopTrace vs messages**：LoopTrace 是非权威 A 层结构元数据（不含 payload），messages 才是 014 唯一权威历史；trace 只用于诊断聚合，不得作为第二份权威副本。
  - **cancelled vs timeout**：两条独立停止路径--cancelled 由 Loop Engine 检测 `signal.aborted`，timeout 由 adapter/executor 超时结果判定；signal 优先，不在 signal 层合并超时。
  - **turnCount vs max_hops**：`turnCount`（Foundation）统计每个已完成的 assistant 回合；`max_hops`（产品 / eval）只统计 retrieve + verify hop（默认 5）；两者属于不同层次，不得混同。#51 退役后 wire 上只剩 `turnCount`，`max_hops` 随旧 KB 工具归档自然消亡。
- **架构 SSOT**（引自 `docs/architecture.md` Capability modules 表）：
  - **Harness (Foundation) 行**：Foundation 运行时（loop-engine / anthropic-adapter / stubs / executor / registry）--#51 不修改，仅消费。
  - **Session API 行**：Host 多会话 HTTP 表面（hub / serve / contract / http）--#51 主要改动对象。
  - **CLI 行**：CLI REPL / oneshot / format--#51 不修改（020 已切 harness）。
  - **Interaction 行**：旧 host 多轮袋--#51 归档。
  - **Archive 行**：021 已落 `src/eval/` 归档；#51 落 `src/interaction/` 归档（022 子目录）。
- **Cross-context 边界**：
  - `_upstream_gbrain/` 只读参考（gitignore），禁止 runtime 链接 / import / symlink / 动态加载--继承项目规则。
  - `src/session-api/` 不 import `src/agent-loop/` 或 `src/interaction/`（判据 5 显式守门）。
  - `web/` 不 import `src/interaction/*`（已天然成立，grep 验证零命中）。

---

## ACR 5-Verdict Gate

> **首轮（2026-07-30）**：`bounded-context-guardian`=yes / `defensive-contract-validator`=no / `error-handling-enforcer`=no / `complexity-anti-drift`=no / `minimal-change-verifier`=yes。OVERALL BLOCKED。
>
> **v2 补强（2026-07-30）**：
>
> - 新增 §SessionStore IO 错误契约（typed 错误分类 + 6 类 wire 错误响应 + 错误映射契约表）
> - 新增 §复杂度阈值约束（继承 017 spec §Complexity thresholds）
> - 新增 4 条 Success Criteria（21/22/23/24：覆盖率 + SessionStoreError 全覆盖 + 错误映射覆盖 + 复杂度阈值）
> - 新增 3 条 Boundaries-Never（bare throw 禁止 / 错误坍缩禁止 / 超阈值不拆函数禁止）
>
> **v2 重跑（2026-07-30）**：5 维全绿。OVERALL PASS。

1. **bounded-context-guardian**: `yes` - 模块级责任表（L77-134）锁定 Session API 消费 harness 不动 016/017 foundation、web 不 import interaction；CR5 + Architectural Constraint 显式 gate `src/session-api/` 零 import `src/agent-loop/` + `src/interaction/`；Boundaries-Never 禁 wire 回放 messages / G2 复活 / slash 复活；无技术层切片或循环 import。
2. **defensive-contract-validator**: `yes` - v2 覆盖率目标（L310-316）钉死 line ≥80% + branch ≥70% for `src/session-api/{hub,contract,http,serve}.ts` + `store/**`；6 类 SessionStoreError 各 ≥1 test；错误映射契约表每行 ≥1 test；harness cancelled/timeout 各 ≥1 test；回归 coverage 不降于 master baseline；SC21 binary 化。5 类边界（empty/negative/overflow/exception/concurrent）已枚举（L303-308）。
3. **error-handling-enforcer**: `yes` - v2 typed `SessionStoreError` 判别联合 6 类（L261-267）替代裸 404/500 坍缩；`ApiErrorBody` wire shape（L270-277）端到端 typed；错误映射契约表（L282-289）钉死 kind -> HTTP status -> wire kind -> retryable；L293 hard requirement 禁 bare `throw new Error(...)` + 禁 6 类坍缩到单一 500；Boundaries-Never（L362-363）+ SC22 + SC23 binary 化。
4. **complexity-anti-drift**: `yes` - v2 阈值钉死（L233-251）：cyclomatic ≤10 / nesting ≤4 / 函数 ≤40 soft（>60 hard split）/ 文件 ≤500 hard split / 参数 ≤4 options-object hard / clone rate ≤3%；适用文件枚举（hub.ts / SessionStore helpers / useSessionChat.ts / SessionSidebar.tsx）；L251 澄清 A17 边界保留（constraints not signatures）；Boundaries-Never（L364）+ SC24 binary 化。
5. **minimal-change-verifier**: `yes` - 单 logical task（Session API 路径迁 harness + Q1-Q5 退役 G2/slash/wire caller_role）；~22 文件改动是同一连贯迁移的内部一致性，非多 task；Boundaries-Always（cancelled no-op / timeout execution_failed / append-only / trace GC）是该迁移的内部 coherence。

**OVERALL: PASS** - 5 维全绿，hand to writing-plans。

> **ACR 观察（非阻塞，移交 writing-plans）**：spec 明确 A17（不规定具体函数签名）+ A18（不规定 UI 视觉细节）保留给 writing-plans / implementation。实施 agent 必须在写代码时守住 §复杂度阈值约束 + §SessionStore IO 错误契约 + Success Criteria 21-24 的 binary 守门。任何超阈值或 bare throw 必须在 PR 阶段被复检。

---

## Cross-references

- **#51 Resolution**（Q1-Q5）: `wayfinder:#51` GitHub issue（wayfinder 决议登记，本 spec 引用为权威先决）
- **017 spec**（Gate B 物理必需层）: `specs/loop-hardening-for-migration.md`
- **016 spec**（Gate A 最小顺序闭环）: `specs/minimum-sequential-agent-loop.md`
- **018/019/020/021 Resolution**: `wayfinder:#45` / `wayfinder:#46` / `wayfinder:#47`（closed 2026-07-30, commit b1e1fb6）/ `wayfinder:#48`（closed 2026-07-30, commit 93813b0）
- **014 模型回合契约**: `wayfinder:#14`（已闭环，归档至 `docs/archive/wayfinder/issues/014-...`）
- **015 工具 ACI 契约**: `wayfinder:#15`（已闭环，归档至 `docs/archive/wayfinder/issues/015-...`）
- **013 Foundation 边界**: `wayfinder:#13`（已闭环，归档至 `docs/archive/wayfinder/issues/013-...`）
- **022 map sub-context**：本 spec 落定后由 writing-plans 在 `plans/022-session-api-migration.md` 展开为可执行计划
- **领域语言**: `docs/CONTEXT.md`（Loop Engine / append-only messages / LoopTrace / StopReason / in-flight closeout / ToolExecutionContext / required runtime layer / ConversationState (deprecated) / G2 (deprecated)）
- **架构 SSOT**: `docs/architecture.md` Capability modules 表
- **in-scope ADR**: `docs/adr/0001-9router-stack-as-code-defaults.md`
- **021 归档模式**（对齐）: `docs/archive/021-retire-legacy-loop-and-eval/README.md`
