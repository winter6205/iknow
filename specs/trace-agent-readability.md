# Spec: trace-agent-readability — trace 对 agent 可读：crash 取证收口 + 读侧动线 + 磁盘止血

> 来源：2026-08-28 trace 设计评估（4 路 Explore 调研 + skeptic 二审 + 实测定量）。核心事实：trace/ 目录 99 文件 263.5MB，98.2% 字节为逐字重复的历史重发，单行最大 891KB；错误记录本身 ~500B 但顺序读定位中位要吞 31KB（p90 306KB）；agent 无任何 trace 查询工具；PR #783（worker 启动秒崩）修复后 stderr 只留内存尾 2000 字符，无指针、无完整落盘、有 flush 竞态。
> 假设闸门：operator 会话内选择框未逐条回复（2026-08-28）；4 项裁决按推荐项采纳、C 系列约束按调研锁定写入，全部列于 Assumptions 章节开放纠正。范围 = P0+P1；P2 另开后续 spec。

## Glossary（exact copy from docs/CONTEXT.md）

- **LoopTrace**: `run()` 的第二返回面 `{ result, trace }`（TurnTrace / Totals 两型）—— A 层结构元数据 trace，严格不含 payload；与 append-only messages 唯一权威解耦，immutable 累积。
  _Avoid_: 在 trace 里塞 input/output/token/cost（B 层字段）——该禁令仅对 LoopTrace 本体，不外延到 TraceService。
- **append-only messages**: Foundation 的权威 Anthropic 原生会话历史，是唯一事实来源；消息只能以不可变追加更新，禁止原地修改或建立第二份权威副本。
  _Avoid_: 把 harness trace JSONL 当会话历史。
- **ACI tool set**: Harness 装配层（`src/harness/aci/`）注册的工具集，SSOT 工厂 = `src/harness/aci/tools/registry.ts:createDefaultAciRegistry`，所有入口从这里取，工具数永不同步漂移。
  _Avoid_: 在 harness 之外另起 tool 注册表；在 entry point 手写工具数组。
- **executor truncation authority**（契约 X）: executor 是工具结果截断元数据的唯一权威——自测序列化后字符数、自截断、自合成标记；executor 兜底 `OUTPUT_HARD_CAP=20000`（ADR-0006）。
  _Avoid_: 工具自填 truncated/total 字段；executor 凭工具标记跳过兜底截断。
- **前景 spawn / 后景 spawn**: `spawn_subagent` 的两种结果契约（#361 裁决，ADR-0014）——前景（`wait:true`，默认）同步等 worker 到终态；worker 恒为独立进程。
  _Avoid_: 把前景/后景与进程隔离混同。
- **父可见信封**: 子代理交差给父模型看的那一层——短摘要、改过的路径、成败与停因；不是终稿全文。
  _Avoid_: 把汇报截断当成任务失败。
- **workspaceRoot**: per-root 操作状态锚；默认 `process.cwd()`，可被 `--workspace-root` 或 `IKNOW_WORKSPACE_ROOT` 覆盖（ADR-0019 D1.1）。
  _Avoid_: 与 `home`（global 配置锚）混同。
- **secret-roundtrip mask（#406）**: 输出 mask 经 `currentSecretValues(registry.values())` 兜底遮蔽；`settings.secrets.mode` 控制 `roundtrip`（默认）| `block`。
  _Avoid_: 落盘内容绕过 mask 单点。

**本 spec 新术语**（待 domain-modeling persist）：

- **stderr 指针**: worker crash 诊断的三件套落盘形态——`subagent_stop.error` 结构化字段 + `stderr_path`/`stderr_bytes` 指针字段 + `<traceDir>/stderr/<taskId>.log` 全量（mask 后、1MiB cap）文件。summary 内只留尾部 ≤2000 字符预览。
  _Avoid_: 把完整 stderr 内联进 JSONL 行；stderr 落盘绕过 mask。
- **blob 引用模式**（`IKNOW_TRACE_MESSAGES=blob`，默认 `full`）: llm_call 行内 messages 元素替换为内容寻址引用 `{sha, bytes}`、正文写入 `<traceDir>/blobs/<sha>`（内容寻址、write-if-missing、同样过 mask）的 opt-in 写侧模式。默认 `full` 与现状 byte-shape 完全兼容。
  _Avoid_: 默认开启；把 blob 模式当成对 ADR-0014「模型实际所见」不变量的修订（引用模式下 `messages_captured` 仍为 true，捕获语义不变，物理存储去重）。
- **crash 取证无条件**: `subagent_spawn`/`subagent_state_change`/`subagent_stop` 三类生命周期事件 + stderr 指针文件在任何产品入口（含 chat REPL）都落盘，与主循环 content trace 的入口开关解耦。
  _Avoid_: 把生命周期事件绑回 `--trace-out` 开关；对 ADR-0003 D10 的扩张理解为 content trace 进 chat REPL。

## Architectural Constraints（ADR 引用）

- **ADR-0003**（Trace Service domain interface）：#9 Postel's Law（只落当前可填字段）；#11 实时写盘 `appendFileSync`；#13 `recordXxx` MUST NOT throw + warn-once（本 spec 的写失败计数不得破坏该契约）；D10 chat REPL 不做 **content** trace——本 spec 对生命周期事件开无条件例外，属对 D10 的显式范围修正（见待写入 ADR 候选）。「无 rotation」在该 ADR 记为 future work，本 spec 兑现。
- **ADR-0014**（前景 spawn 默认）验收纪律：`messages_captured` 断言模型实际看到的 system prompt 含 proactive 关键词。本 spec 不动该断言路径：blob 模式默认关，`full` 模式 byte-shape 兼容；`tests/e2e/subagent-foreground-trace.test.ts:164` 断言保持全绿。
- **ADR-0006**（20k 硬截断、否决落盘）：其落盘否决针对**可再生工具输出**的 model-facing offload（含文件路径协议/生命周期/session-api 暴露）；worker 崩溃 stderr 是**一次性不可再生诊断**，且落盘物不进模型上下文、不进 tool_result——不属该否决域，spec 显式记录此区分。grep `--max-columns` 属 ADR-0006「工具级管读多少（语义单位）」的参数域。
- **ADR-0020**（trace 读侧挂载 serve）：读侧改动全部落在 `src/traceserver/` 兄弟目录内，不动挂载拓扑；`MAX_TRACE_BYTES` 8MiB 窗语义不变。
- **ADR-0019**（workspaceRoot）：worker trace 默认目录锚定改走 workspaceRoot 语义。
- **ADR-0004**（工具集 SSOT + 契约 X）：query_trace 经 `createDefaultAciRegistry` 注册，走 permission middleware + timeout tier；工具数为 SSOT 同步项。
- **SC20 / #406**（单序列化点脱敏）：任何新落盘载体（stderr .log、blobs/<sha>）必须过同一 `createOutputMask(currentSecretValues())`；crashedSummary → 父可见信封 → 模型面的既有裸奔洞同轮修复。

## Objective

让 trace 对 LLM agent 与崩溃取证真正可用，三块：

1. **P0 crash 取证收口**：worker crash 后，磁盘上永久存在「结构化 error 字段 + stderr 全量指针文件 + 尾部 summary」三件套；修复 exit-vs-flush 竞态与 crashedSummary 直达模型的脱敏洞。任何入口（含 chat REPL 默认配置）下复现 #783 秒崩都能一步拿到根因。
2. **P1 读侧动线**：agent 有了 `query_trace` 工具（投影模式：llm_call 默认不返回 messages 全文，返回 `messages_count` + 首末条预览 + error；`record_id` 下钻）；traceserver 补齐 `verification`/`goal` 白名单漂移与 `turn_id` 过滤；grep 工具超长命中行截断（防单行吃光 executor 20k 预算挤出其余命中）。
3. **P1 磁盘止血**：trace 目录 rotation 双帽默认开启（>500MB 或 >100 文件删最旧）；`IKNOW_TRACE_MESSAGES=blob` opt-in 模式用内容寻址引用消灭 98.2% 重复（实测 263.5MB → 约 37MB）；`maskJsonLine` 兑现注释承诺改工厂级缓存；写失败计数经 health 暴露。

用户：调试者（崩溃后定位根因）+ 运行中的主代理（自查 trace 定位错误）。成功 = Success Criteria 全绿。

## Tech Stack

不变：TypeScript + Node（ESM，tsc strict）+ Web 侧 React/Vite（本轮 web/ 零改动）。无新依赖。sha-256 用 `node:crypto`。

## Commands

```bash
npm run typecheck
npm test
npx vitest run tests/subagent      # crash 取证定向
npx vitest run tests/traceserver   # 读侧定向
npx vitest run tests/harness       # trace 写侧 / rotation / blob / mask
npx vitest run tests/e2e/subagent-foreground-trace.test.ts   # ADR-0014 断言回归
npm run lint
```

## Project Structure

```
# P0 crash 取证
src/harness/subagent/manager.ts     # emitStop/emitStateChange 补填 error；crashedSummary 过 mask；
                                    # exit 保终态 + stderr close 有界 race(≤500ms) 后构建 summary；
                                    # crash 时 tee stderrBuf 全量到 <diagnosticsDir>/stderr/<taskId>.log（mask + 1MiB cap）；
                                    # 工厂增 diagnosticsDir?: string 注入缝
src/harness/subagent/spawn.ts       # spawn env 追加 IKNOW_TRACE_OUT=<resolved traceDir>（子进程 trace 归位父目录）
src/harness/subagent/worker.ts      # DEFAULT_WORKER_TRACE_DIR 从 CWD 相对改为 workspaceRoot 锚定
src/harness/trace/types.ts          # SubagentStopRecord + stderrPath?/stderrBytes?（Postel 可选；error? 留位已在 types.ts:289/308）
src/cli.ts                          # chat 入口：subagent 生命周期 trace 无条件装配（conversationId="subagent"）；
                                    # 主循环 content trace 开关不动（ADR-0003 D10）
src/harness/build-engine.ts         # 透传 diagnosticsDir（traceDir → manager DI 缝）

# P1 写侧止血
src/harness/trace/rotation.ts       # 新文件：maybeRotate(dir, {maxTotalBytes:500MB, maxFiles:100})，双帽删最旧
src/harness/trace/jsonl.ts          # maskJsonLine 工厂级缓存（兑现 jsonl.ts:76 注释）；IKNOW_TRACE_MESSAGES=blob
                                    # 模式：messages 元素→{sha,bytes} 引用 + blobs/<sha> 写入（mask 后）；写失败实例计数器
src/harness/trace/noop.ts           # 计数器空实现对齐

# P1 读侧动线
src/harness/aci/tools/query-trace.ts  # 新文件：进程内直调 createJsonlTraceReader；投影模式；
                                      # 参数 conversation_id?/record_type?/status?/task_id?/parent_turn_id?/turn_id?
                                      # /limit?/record_id?/resume_offset?；llm_call 默认投影（messages_count +
                                      # 首/末条预览 + error），record_id 精确下钻；返回体自限 ≤4000 chars
src/harness/aci/tools/registry.ts     # +query_trace（第 11 工具，SSOT；permission read-only tier + fast timeout）
src/harness/aci/tools/grep.ts         # rg 路径 +--max-columns=2000；Node fallback 在 scanLines visit 处截单行
src/traceserver/types.ts              # TRACE_RECORD_TYPES +verification/goal；TraceQuery +turnId?
src/traceserver/http.ts               # parseTraceQuery +turn_id
src/traceserver/reader.ts             # applyFilter +turn_id 精确匹配
src/traceserver/fields.ts             # verification/goal 列映射
src/session-api/http.ts               # health 响应 + traceWriteFailures（读各 JsonlTraceService 实例计数）
tests/                                # 上表逐项对应
```

不改：`envelope.ts` wire schema（status/reason 枚举冻结）；`loop-engine.ts` 埋点语义（`messages_captured:true` 路径与 StopReason 冻结）；`src/tui/`；web/ 前端；ADR-0014 验收断言路径。

## Code Style

```ts
// manager.ts — 竞态修复形态：exit 只保终态时序，summary 构建有界等 stderr 流收尾
child.on("exit", (code, signal) => {
  // 终态 emit 照旧（timeout guard / SC16 覆盖语义不变）
  // crash 分支：await Promise.race([stderrClosed, delayMs(500)]) 后再取 stderrBuf 构建 summary
});
// child.on("error")（manager.ts:701-718）同病同修

// stderr tee：任何落盘内容过同一 mask（SC20），不造第二个脱敏旁路
const masked = createOutputMask(currentSecretValues()).mask(stderrBuf);
writeFileSync(join(diagnosticsDir, "stderr", `${taskId}.log`), masked.slice(-1MiB_CAP));

// crashedSummary → 父可见信封（模型面）同过 mask —— 修既有裸奔洞
summary: maskSecrets(crashedSummary(code, signal, stderrTail))

// jsonl.ts — blob 模式（opt-in，默认 full：byte-shape 与现状完全一致）
// blob 模式下 messages_captured 仍为 true（ADR-0014 捕获语义不变，物理存储去重）
messages: mode === "blob" ? messages.map(toBlobRef) : messages

// query-trace.ts — 投影优先，防上下文炸弹（executor 20k 兜底之下自限 4k）
// description 写明「先投影后下钻」：默认不返回 messages 全文，record_id 拉单条详情
```

## Testing Strategy

vitest，按模块落 `tests/subagent/` / `tests/harness/` / `tests/traceserver/` / `tests/session-api/` / `tests/aci/`。六类覆盖：

| 层      | 内容                                                                                                                                                                                          |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 正常    | 真实 OS pipe spawn→crash→三件套落盘（error 非空 + stderr .log 含尾部 + stop 行 stderr_path 指向存在文件）；rotation 双帽各自触发；blob 模式 sha 引用 + blobs/ 命中；query_trace 投影/下钻两段 |
| 失败    | stderr .log 写盘失败不 crash（safeTrace 同形态）；trace 写失败计数经 health 暴露；blob 目录不可写降级回 full 行                                                                               |
| 边界    | stderr 大 burst（>64KB）后立即 exit 仍捕获尾部行（竞态专项）；.log 恰在 1MiB cap 截断；rotation 恰在帽值边界；空 stderrBuf 时 summary 保持裸 base（manager.test.ts:272 既有锁定不破）         |
| 权限    | query_trace 只读、无写路径；stderr .log / blobs 内容均不含已知 secret（注入 fake secret 后 grep 断言）；父可见信封 summary 同断言                                                             |
| 空/非法 | query_trace 未知 record_type → typed 错误（镜像 parseRecordType 白名单）；rotation env=off 不删文件；conversation_id 路径分隔符拒绝保持                                                       |
| 并发    | 多 worker 同时 crash 的 .log 互不覆盖（taskId 命名）；rotation 与并发写竞争时不删活跃文件（mtime 保护）；grep 长行截断后其余命中仍在场                                                        |

ADR-0014 回归专项：`IKNOW_TRACE_MESSAGES` 缺省时 `subagent-foreground-trace.test.ts` 全绿（byte-shape 兼容证明）。

## Boundaries

- **Always do**：埋点与落盘全走 safeTrace/never-throw（ADR-0003 D13）；任何新落盘载体过 `createOutputMask`；Postel——新字段仅存在时落盘；blob/rotation 默认关闭或保守（full 默认、帽值宽）；query_trace 返回体自限。
- **Ask first**：blob 默认值反转（需 ADR 修订 + e2e 断言调整）；rotation 帽值/保留期调整；stderr .log 保留策略（当前随目录 rotation 生命周期）；query_trace 参数面扩展（时间窗过滤等，358 已记非阻塞观察）。
- **Never do**：动 `messages_captured` 默认断言路径（ADR-0014）；写侧 delta/off 模式（挂 ADR-0003/0014 修订前置，本 spec 显式不做）；B-scope OTel（ADR-0003 排除域）；扩 envelope status/reason 枚举；动 LoopTrace A 层；把 stderr 全量内联进 JSONL 行或模型信封；content trace 进 chat REPL（D10 修正仅限生命周期事件）；memory 相关字段（operator 另会话接入中）。

## Success Criteria（binary，每条映射可执行检查）

1. **crash 三件套**：真实 OS pipe 下 spawn 必崩 worker（`process.stderr.write('boom-diagnostic'); process.exit(2)`）→ `<traceDir>/stderr/<taskId>.log` 存在且含 `boom-diagnostic`；`subagent_stop` 行 `error.type` 非空、`stderr_path` 指向存在的文件、`summary` 含尾部。**Check**: `npx vitest run tests/subagent`（集成，仿 subagent-chain.test.ts:122 真管道形态）✅/❌
2. **竞态修复**：>64KB stderr burst 后立即 `exit(2)` 的子进程，crash summary 含最后一条 stderr 行。**Check**: 竞态专项单测绿 ✅/❌
3. **脱敏闭环**：注入已知 secret 后，stderr .log、blobs/、crashedSummary（父可见信封）三者均不含 secret 明文。**Check**: 单测 grep 断言 ✅/❌
4. **取证无条件**：chat REPL（pipe 形态、未配 traceOut）跑一次 spawn_subagent → `trace/subagent.jsonl` 出现三类生命周期事件。**Check**: integration test 绿 ✅/❌
5. **rotation**：夹具目录超双帽任一 → 下次工厂创建后最旧 .jsonl 被删、总数 ≤ 帽；env 关闭不删；活跃文件（mtime < 5min）受保护。**Check**: rotation 单测绿 ✅/❌
6. **白名单漂移修复**：`GET /api/v1/traces?record_type=verification`（与 goal）返回 200；fields 含两型列映射；`?turn_id=` 过滤命中。**Check**: `npx vitest run tests/traceserver` 绿 ✅/❌
7. **blob opt-in**：默认 full 下既有 e2e（含 messages_captured 断言）全绿；`IKNOW_TRACE_MESSAGES=blob` 下行内为 `{sha,bytes}`、`blobs/<sha>` 存在且内容过 mask。**Check**: 两条单测 + `npx vitest run tests/e2e/subagent-foreground-trace.test.ts` 绿 ✅/❌
8. **query_trace 工具**：registry SSOT 含 query_trace（工具数断言更新）；`status=error` 过滤命中错误行且返回不含 messages 全文；单次返回 ≤4000 chars；`record_id` 下钻能取到单条详情。**Check**: `tests/aci/` 单测 + registry 数量断言绿 ✅/❌
9. **grep 行长截断**：命中 1MB 单行时该条 ≤2000 chars + 截断标记，同查询其余命中不被挤出。**Check**: grep 单测绿 ✅/❌
10. **mask 工厂缓存**：既有 secret-roundtrip（#406）测试全绿 + 新断言 mask 构造每工厂 1 次。**Check**: 单测绿 ✅/❌
11. **写失败可观测**：模拟写盘失败 → `GET /api/v1/health` 的 `traceWriteFailures` ≥1 且 loop 不 crash（D13 契约不破）。**Check**: session-api 单测绿 ✅/❌
12. **零回归**：traceserver/harness/subagent 既有测试全绿，`npm run typecheck` / `npm run lint` 干净。**Check**: 命令 exit 0 ✅/❌

## Open Questions

无阻塞项。两条非阻塞观察：(1) rotation 对 `blobs/` 的回收策略（引用计数 vs 随会话文件同生命周期删orphans）留 PLAN 细化——首版按「blob 文件 mtime 早于最旧保留会话文件即删」的 orphans 规则起步；(2) query_trace 时间窗过滤（358 已记同类非阻塞观察）留后续。

## Assumptions（2026-08-28 闸门；operator 选择框未逐条回复，以下按推荐项采纳，review 时可逐条推翻）

1. **范围 = P0+P1**：crash 取证 + 读侧动线 + 磁盘止血为一个逻辑任务簇；P2（tool result 捕获开关、resume_offset 前端闭环、sandbox stdout 截断、buglog 文档 merge）另开后续 spec。采纳推荐项。
2. **messages 治理 = blob 引用模式 opt-in**（`IKNOW_TRACE_MESSAGES=full|blob`，默认 full）：不动 ADR-0014 不变量与 ADR-0003「JSONL 可 grep」默认语义，先立机制后议默认。采纳推荐项（写侧 delta/off 模式显式不做）。
3. **crash 取证无条件落盘**：生命周期三类事件在任何入口都写 `subagent.jsonl`；content trace 仍守 ADR-0003 D10 不进 chat REPL。采纳推荐项；对 D10 的范围修正已列入待写入 ADR 候选。
4. **query_trace 进 registry SSOT**（第 11 个 ACI 工具，permission read-only + fast timeout tier）：不用 lazy/tool_search 通道（发现成本 > 前缀字节成本）。采纳推荐项。
5. **C1 stderr 指针形态**：`<traceDir>/stderr/<taskId>.log`、mask 后落盘、1MiB cap；`subagent_stop` 增 `stderr_path`/`stderr_bytes` Postel 可选字段。调研锁定。
6. **C2 竞态修复形态**：exit 保终态 + stderr close 有界 race（≤500ms），不做裸 exit→close 替换（防状态机被 stdio drain 绑架 + 潜在 close 永不来挂起）；`child.on("error")` 同修。调研锁定（skeptic 修正）。
7. **C3 rotation 双帽**：>500MB 或 >100 文件删最旧，env 可关；worker trace 默认目录从 CWD 相对改为 workspaceRoot 锚定（ADR-0019 语义）。调研锁定。
8. **C4 读侧补齐不加端点**：白名单 + fields 列 + `turn_id` 过滤；「最新错误」用现有 `status=error` + 降序 + `limit=1` 覆盖，不新增聚合端点。调研锁定。
9. **C5 maskJsonLine 工厂缓存**：兑现 jsonl.ts:76 注释承诺，行为不变。调研锁定。
10. **C6 写失败计数**：维持 D13 never-throw + warn-once，追加实例计数经 health 暴露。调研锁定。
11. **C7 不做清单**：B-scope OTel；memory 字段标识（operator 另会话）；resume_offset 前端闭环；tool result 捕获开关；写侧 delta/off；buglog 文档 merge（随实现单独 docs commit，不占本 spec 验收）。调研锁定。

→ 无静默假设；4 项裁决 + 7 项锁定约束全部显式在案。

## 待写入清单（已 flush 2026-08-28）

- **CONTEXT.md 新术语**：stderr 指针、blob 引用模式、crash 取证无条件——已写入 Language + Relationships 三行。✅
- **ADR**：`docs/adr/0035-trace-crash-forensics-unconditional.md`（D10 范围修正）、`docs/adr/0036-trace-messages-blob-refs-opt-in.md`（blob 存储格式）——均 accepted。✅

## ACR Verdict（architecture-change-reviewer）

**2026-08-28，affected files 15（见 Project Structure）≥3：**

```
bounded-context-guardian: yes — trace 域新增 rotation.ts 自包含于 src/harness/trace/；manager 经 diagnosticsDir DI 参数消费、不 import trace 内部（接口面只经 TraceService，与 358 同型）；query_trace 走 ADR-0004 registry SSOT 单点注册；traceserver 白名单/fields/parse 链自包含（ADR-0020 拓扑零改动）；session-api health 只读计数器。无跨域 import、无反向依赖。
defensive-contract-validator: yes — Testing Strategy 六类表覆盖 5 boundary classes：empty（空 stderrBuf 保裸 base——manager.test.ts:272 既有锁定、query_trace 未知 record_type typed 错误）；overflow（.log 1MiB cap、64KB burst 竞态专项、rotation 双帽边界、blob 目录不可写降级 full）；concurrent（多 worker crash .log 按 taskId 隔离、rotation mtime 保护活跃文件）；exception（写失败 never-throw + 计数器、safeTrace 同形态包裹 tee）；权限（query_trace 只读、三载体 mask grep 断言）。
error-handling-enforcer: yes — 每条失败路径 typed 且不静默：blob 写失败显式降级 full 行（不丢捕获语义）；trace 写失败 warn-once + health 计数（D13 契约不破）；crash 路径 error.type 非空为验收断言；错误枚举全复用 TraceStatus / reason 闭集，零新 magic code；竞态修复用有界 race 而非裸换事件（消除 close-never 挂起这类新失败模式）。
complexity-anti-drift: yes — 声明结构每函数单一抽象层：rotation 独立新文件（jsonl.ts 不再膨胀——jsonl.ts 只收 mask 缓存 + messages 一个 map 分支）；query-trace.ts 投影纯函数 + reader 直调，无新状态机；manager crash 分支局部收口在一个 race helper；写侧模式枚举刻意止步于 full|blob 两值（delta/off 被 Never 排除，防模式蔓延）；无深嵌套/复制意图。
minimal-change-verifier: yes — 1 个逻辑任务簇「trace 对 agent 可读」，非 scope creep（P2 五项显式排除）；内部按 P0 crash 取证 → P1 写侧止血 → P1 读侧动线 3 个 commit 序列化（358 先例同型：常量/解耦项单独 commit），不 merge 成一坨。
```

**OVERALL: 5/5 yes → PASS → persist（待写入清单）→ hand to writing-plans。**
