# Spec: 会话持久化增强 + 跨入口共享池（#120 server 侧）

> 来源：`wayfinder:grilling` #120（M3 会话持久化与续接设计，6 问收口）+ 本 spec grilling 会话（操作员逐题裁决，2026-08-04）。
> TUI 入口的交互骨架独立成稿：`specs/146-tui.md`（blocked by 本 spec）；TUI 视觉稿 = issue #154。
> 本 spec 覆盖：存储根目录 / 项目命名空间 / SessionFileV1 schema v2 / sanitize 前向兼容 / summary 提取 / chat 外壳只读化。**不含** TUI 命令本身、并发写文件锁、流式。

## Objective

让 iknow 的会话存储做到 #120 Q6 唯一验收标准：**同一份磁盘文件，任何入口（serve / TUI / 将来 chat）读取都能回溯到对应会话状态**。具体三件事（借鉴 OpenHarness 能力清单 `upstream-openharness/src/openharness/services/session_storage.py`，用自己的实现）：

1. **共享会话池**：根目录从 `<cwd>/data` 迁到 `~/.iknow`，按项目命名空间隔离（sha1(cwd)[:12]），TUI 与 serve 天然共享同一池（#120 Q2.a α 直连 SessionStore）。
2. **summary 摘要字段**：首条 user 消息前 80 字符，供会话列表显示（TUI / serve 共用）。
3. **sanitize 前向兼容**：schema 演进（v1 → v2）加载不崩，旧文件读时补全、新字段写时自然落地。

用户 = iknow 开发者（serve / TUI 使用者）。成功 = Q6 验收测试通过：入口 X 保存 N 轮 → 入口 Y 读取一致 → Y 续跑第 N+1 轮 → X 再读仍在。

## Glossary（CONTEXT.md 原样引用，不重新定义）

- **append-only messages**：Foundation 的权威 Anthropic 原生会话历史，是唯一事实来源；消息只能以不可变追加（`[...prev, x]`）更新，禁止原地修改或建立第二份权威副本。
- **Session HTTP API / session-api**：Host 多会话面（`src/session-api/`），create/message/command/reset。
- **iknow serve**：承载 Session API + 静态产品 UI 的 CLI host。
- **turnCount**：Foundation 运行时回合计数，每完成一个 assistant 回合加一；`maxTurns` 是 run() 入口上限，二者不同层，不得混同。
- **host 多轮袋**：CLI path 不再维护权威多轮袋；本 spec 不引入，TUI 直接消费 harness `RunResult.messages`。
- **in-flight closeout**：abort/timeout 收尾语义（与 `DROP_REASONS` 存盘行为相关，见 Boundaries）。

## Architectural Constraints（按编号引用 ADR）

- **ADR-0001**：9router 栈代码默认。本 spec 不动 env / 模型配置。
- **ADR-0003**：TraceService 领域接口。D10 排除 chat 的理由不适用于 TUI（trace 写在 hub 层，TUI 走 hub 自动继承——见 `specs/146-tui.md`）；本 spec 不改 trace。
- **ADR-0007（本 spec 的落档候选，grilling 已裁决、待 domain-modeling 落档）**：M3 会话存储磁盘形态三合一决策——① 不迁 JSONL（整 JSON + tmp/rename 原子写保留）；② 共享根 `~/.iknow` + sha1(cwd)[:12] 项目命名空间；③ schema v2（summary / cwd 顶层）+ load 时 sanitize 不写盘。编号说明：#120 grilling 评论里的 "ADR-0005 候选" 已被工具层 ADR-0005 占用，按 docs/adr/ 最大号 + 1 取 0007。
- **#114 Standing preferences**："现有 session-store 是基础，不推翻重做"（SessionStore 类保留演进，不重写）；"append-only 纪律不可破"（内存边界已成立；磁盘形态本期不迁 JSONL——JSONL 已随 #120 Q1 撤销，标记在 #114 Not yet specified）。
- **#120 grilling 收口（真值）**：Q1 整 JSON 不迁 JSONL；Q2 α 全量接口 + per-turn 粒度；Q3 全链路 ReadonlyArray + Object.freeze；Q4 元数据全进 SessionFileV1 顶层；Q5 chat 放一放 / ask 维持无状态；Q6 唯一验收标准 = 任何入口读取一致。

## Tech Stack

- TypeScript + Node ≥20，本 spec 无新增依赖（`node:crypto` createHash / `node:os` homedir 均内置）。
- 依赖新增仅限 TUI spec（ink@^7 + react@^19，操作员已显式授权动 lockfile）——不在本 spec。
- vitest（既有），无新测试依赖。

## Commands

```
Build:      npm run build
Typecheck:  npm run typecheck
Test:       npm test                    # vitest：unit + harness + integration
Serve:      npm run serve               # 默认 ~/.iknow
Serve 覆盖:  npm run serve -- --data-dir <dir>   # 测试/隔离场景
```

## Project Structure

```
src/session-api/store/schema.ts        — SessionFileV1 → v2 扩字段（summary / cwd / sanitized_at）+ sanitizeSessionFile() + extractSummary()
src/session-api/store/session-store.ts — 项目命名空间路径（resolveProjectSessionDir）；load/save/list/delete 保留；list() 投影加 summary（见 SC 12）
src/session-api/hub.ts                 — createSession / postMessage 同步新字段（schemaVersion 2 / cwd / summary）
src/session-api/serve.ts               — dataDir 默认 <cwd>/data → ~/.iknow（--data-dir 覆盖保留）
src/cli/slash.ts                       — CliChatState.messages: T[] → ReadonlyArray<T>（Q3）
src/cli/chat-session.ts                — 赋值处 Object.freeze([...result.messages])（Q3）
tests/session-api/store/               — sanitize / summary / 命名空间 / 跨入口一致测试
```

## Code Style

沿用仓库既有风格（ESM、readonly-first、显式结构化错误）：

```ts
// schema.ts — sanitize 是纯函数：输入任意版本 parse 结果，输出当前形状；load 不写盘
// 顺序契约（reject-first）：schemaVersion 范围检查先于逐字段处理——
//   schemaVersion > CURRENT(2) 立即 schema_invalid，不进入字段保留分支；
//   仅 schemaVersion ≤ 2 的文件才谈"未知字段原样保留"。
export function sanitizeSessionFile(raw: unknown): SessionFileV1 { ... }

// summary：首个含 text block 的 user 消息，strip()[:80]，不剥 markdown（存储层职责单一）
export function extractSummary(
  messages: ReadonlyArray<AnthropicNativeMessage>,
): string { ... }

// host 层赋值：Object.freeze 一并冻住，类型推断出 ReadonlyArray，免 cast（Q3 裁决）
// 两处都要：chat-session.ts 的 run 后赋值 + slash.ts /reset 的 `= []`（空数组同样冻结）
ctx.state.messages = Object.freeze([...result.messages]);
```

注释只写 why（如：为什么 sanitize 不修复 messages——权威历史不可篡改）。

## Testing Strategy

- **Unit**：`extractSummary`（首条 user text block / 跳过纯 tool_result 消息 / 空 messages → "" / 80 字符截断 / strip 首尾空白）；`sanitizeSessionFile`（v1 补齐 summary / cwd / sanitized_at；未来版本未知字段保留不丢；messages 元素形状坏 → 拒绝；schemaVersion > 2 → 拒绝）。
- **Integration（Q6 验收，核心）**：tmpdir 池 + stub adapter，两个独立 `SessionHub` 实例（模拟 serve / TUI 两进程）：hub A `createSession` + `postMessage` N 轮 → hub B `load` 断言 messages / conversation_id / turnCount / summary / cwd / schemaVersion / updatedAt / jsonMode 全等 → hub B 续跑第 N+1 轮保存 → hub A 再读断言 N+1 在。
- **Store 契约**：tmpdir 下 `resolveProjectSessionDir` 产出 `<base>/sessions/<basename>-<sha1[:12]>/`；不同 cwd 不碰撞、同 cwd 稳定。
- 覆盖项目测试规范六类路径：正常 / 失败（schema_invalid 结构化错误不崩）/ 边界（空 messages 的 summary）/ 权限不足（store error 映射）/ 空与非法输入（损坏 JSON）/ 并发（hub inflight 既有测试保留；跨进程并发 = 已知边界，不在本期测试范围）。

## Boundaries

- **Always**：load 时 sanitize（内存 normalize，无写盘副作用）；`validateSessionFile` 的 schemaVersion 严格等值检查放宽为**范围检查**（≤ CURRENT 接受进 sanitize，> CURRENT 拒绝——ACR 核对：现 schema.ts:34 是等值，plan 必须含此行）；messages 深校验（role ∈ {user, assistant} + content 为合法 block 数组）；save 时 summary 重算（messages 是唯一权威，summary 是可再生投影）；测试先行（TDD，失败测试不得删除 / 降强度 / 改跳过）。
- **Ask first**：schema 再加字段（v3）；`--data-dir` 默认值再变；动 lockfile（TUI spec 已单独授权 ink / react，其余新增一律先问）。
- **Never**：sanitize 修复 messages 内容（权威历史不可篡改，形状坏 = 拒绝加载）；按白名单丢弃未知字段（未来字段必须原样保留，否则当前版本 re-save 即数据销毁）；启动时批量改写旧文件（read-lazy upgrade only）；本期给任何入口暴露会话删除交互（D1，会话是记忆资产；`SessionStore.delete` API 保留但无产品面调用）；动 `DROP_REASONS`（cancelled / protocolError / emptyFinalResponse 回合不存盘维持现状——cancelled 回合 user 提问丢失是已知边界，replay 类需求出现时另立票）。

## Success Criteria（全部二进制可测）

1. `SessionStore` 默认池根 = `os.homedir() + "/.iknow"`，目录布局 `~/.iknow/sessions/<basename>-<sha1(cwd)[:12]>/<uuid>.json`（digest 12 hex）。
2. `serve --data-dir <dir>` 覆盖生效；不传时不再在 `<cwd>/data` 建档。
3. 新保存的会话文件 `schemaVersion === 2`，顶层含 `summary`（string）与 `cwd`（string）。
4. `summary === strip(首个含 text block 的 user 消息的首个 text block)[:80]`；无则 `""`。
5. v1 文件 load 成功：summary 重算补齐、cwd 补 `""`、sanitized_at 补该文件 updatedAt；load 本身零写盘。
6. 未来版本文件（schemaVersion > 2）load → `schema_invalid` 结构化错误（不崩、不静默吞）；schemaVersion ≤ 2 且字段可补全 → 成功。
7. messages 元素形状非法（role 越界 / content 非合法 block 数组）→ `schema_invalid`，不尝试修复。
8. Q6 验收测试（上述 Integration）通过：双入口读写一致 + 续跑可见。
9. `CliChatState.messages` 类型为 `ReadonlyArray<AnthropicNativeMessage>`，**两处赋值点**（chat-session.ts run 后赋值、slash.ts `/reset` 清空）全部 `Object.freeze`，`npm run typecheck` 零错误。
10. 旧 `<cwd>/data/sessions/` 文件不被读取、不被迁移、不被删除（留在原地）。
11. `npm test` 全绿。
12. `SessionStore.list()` 返回的条目在既有 `conversation_id / updatedAt / lastFinalText` 之外**增加 `summary` 字段**（从文件顶层读取；v1 文件经 sanitize 重算补齐）。`lastFinalText`（最近 assistant 文本）与 `summary`（首条 user 文本）是两个不同信号，并存不互替——serve 现有列表端点的既有字段不变（非破坏性），TUI 列表用 `summary`。

## Open Questions

1. **#114 地图 Destination 措辞更新**：仍写 "append-only JSONL + resume"，与 #120 Q1 撤销裁决字面冲突。`docs/CONTEXT.md` / 地图写入权归 domain-modeling，不在本 spec 内改——建议落 ADR-0007 时同步触发。
2. **TUI 交互骨架 spec 独立推进**：`specs/146-tui.md`（本 spec 是其 blocked-by）；视觉稿 issue #154 再 blocked by 它。
3. **并发写控制（文件锁）另立 issue**：本期记为已知边界——tmp/rename 保证不写坏文件，最坏后写覆盖先写丢一个 turn（#146 决策 4 收口 = 不做）。
4. **ADR-0007 落档**：grilling 裁决已齐，落档动作归 domain-modeling（docs/adr/ 写权限），本 spec 只声明候选内容。

## ACR 5-verdict（Step 4 · architecture-change-reviewer · 2026-08-04 · OVERALL PASS）

- bounded-context-guardian: **yes** — 改动限于 `src/session-api/store/{schema,session-store}.ts`、`src/session-api/{hub,serve}.ts`、`src/cli/{slash,chat-session}.ts`；无反向依赖 harness 内部，无循环导入；明确排除复活 host 多轮袋为权威状态。
- defensive-contract-validator: **yes** — sanitize（v1 兼容 / 未来版本拒绝 / 坏 messages）、extractSummary（空 / 纯 tool_result / 80 截断 / strip）、resolveProjectSessionDir（碰撞 / 稳定）、跨进程 Q6 集成全覆盖；并发类显式记为已知边界（文件锁 out of scope，9a）而非静默省略。
- error-handling-enforcer: **yes** — `schema_invalid` 结构化类型错误（version > 2 / messages 形状非法），不静默吞、不修复；"sanitize 永不修复 messages" 是写进 Boundaries 的契约；load 零写盘副作用明示。
- complexity-anti-drift: **yes** — sanitize / extractSummary 为顶层纯函数（无 IO）；复用 SessionHub 而非发明第二份保存路径；按文件/函数级点名，无超阈值（≤30 行 / ≤4 层嵌套 / ≤3 参数）迹象。
- minimal-change-verifier: **yes** — 单一逻辑任务（共享池 + schema v2）；out-of-scope（JSONL / 文件锁 / 流式 / 删除 / chat 持久化）干净排除在 Boundaries Never / Open Questions，未混入成功标准；与 TUI spec 以 blocked-by 排序。

ACR notes（非阻塞，已折进本 spec 相应章节）：① schemaVersion 等值→范围检查（已入 Boundaries Always）；② reject-first 顺序契约（已入 Code Style）；③ `/reset` 赋值点也要冻结（已入 SC 9 / Code Style）；④ lastFinalText vs summary 并存定义（已入 SC 12）。

## Handoff

- 下游：`writing-plans`（spec → ACR → plan 顺序固定）
- plan 路径：`plans/120-session-persistence.md`
- 并行 / 后继：`specs/146-tui.md`（TUI 入口）→ issue #154（视觉稿）→ #147（流式，独立不阻塞）
