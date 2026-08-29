# Spec: query-trace-tool-results — 从 llm_call.messages 投影 tool_result（不写 tool_call.result）

> 2026-08-29：P2「tool result 捕获开关」否决复制写入。读侧从已有 `llm_call.messages` 抽出工具结果。操作员授权直接成文。

## Glossary（exact copy from docs/CONTEXT.md）

- **append-only messages**: Foundation 的权威 Anthropic 原生会话历史，是唯一事实来源；消息只能以不可变追加更新，禁止原地修改或建立第二份权威副本。
  _Avoid_: 把 harness trace JSONL 当会话历史。
- **ACI tool set**: Harness 装配层（`src/harness/aci/`）注册的工具集，SSOT 工厂 = `src/harness/aci/tools/registry.ts:createDefaultAciRegistry`，所有入口从这里取，工具数永不同步漂移。
  _Avoid_: 在 harness 之外另起 tool 注册表；在 entry point 手写工具数组。
- **executor truncation authority**（契约 X）: executor 是工具结果截断元数据的唯一权威——自测序列化后字符数、自截断、自合成标记；executor 兜底 `OUTPUT_HARD_CAP=20000`（ADR-0006）。
  _Avoid_: 工具自填 truncated/total 字段；executor 凭工具标记跳过兜底截断。
- **blob 引用模式**（`IKNOW_TRACE_MESSAGES=blob`，默认 `full`）: llm_call 行内 messages 元素替换为内容寻址引用 `{sha, bytes}`、正文写 `<traceDir>/blobs/<sha>` 的 opt-in trace 存储模式；`messages_captured` 捕获语义不变，物理去重（实测 98.2% 重复）。ADR-0036。
  _Avoid_: 默认开启；当成对 ADR-0014「模型实际所见」不变量的修订；与写侧 delta/off 截断混同
- **tool_result projection**: 从已解引用的 `llm_call.messages` 抽出的工具结果摘要（`tool_use_id` / name / is_error / chars / preview）。供 `query_trace` 列表与下钻；**不是** `tool_call` 行上的 stdout 副本。`specs/query-trace-tool-results.md`。
  _Avoid_: 打开 `resultCaptured` 往 tool_call 抄正文；把投影当会话账本；默认下钻倒 messages 全文

## Assumptions（2026-08-29 操作员讨论锁定）

1. 不把 `resultCaptured: true` / `argumentsCaptured: true` 打开；不往 `tool_call` 行抄 stdout。
2. 投影只读 trace JSONL（+ blob 解引用）。**不** join 会话账本。
3. 末轮工具执行后模型直接 `end_turn`、没有下一次 `llm_call` 时，trace **看不到**该批 tool_result。契约写明；本 spec 不堵。
4. 纯函数 SSOT 一处，`query_trace` 与日后 MCP 共用；本 spec **不**做 MCP。
5. 响应仍受 `query_trace` 4000 字符帽。
6. Tech stack：既有 traceserver reader + `query-trace.ts`；无新依赖。

→ 以上视为已确认。

## Objective

主代理用 `query_trace` 能看见工具输出摘要，而不把整段 `messages` 倒进 4000 帽。列表与下钻都走投影。成功 = SC 全绿。

## Boundaries

- **Does:**
  - 新增纯函数（建议 `src/traceserver/` 或 `query-trace.ts` 旁，禁止第二份拷贝）：输入已解引用的 `messages`，输出 `tool_results: [{ tool_use_id, name?, is_error, chars, preview }]`。`preview` 单条 ≤400 字符，超长截断并带标记。从 user 块的 `tool_result` 与配对 assistant `tool_use` 取 name。
  - **列表**（无 `record_id`）：`llm_call` 在现有 `messages_count` / 首末 preview 上增加 `tool_result_count`；若 count>0，附加最多 2 条短 preview（≤200 字/条）。`tool_call` 行仍为元数据（name / status / duration / error），不塞正文。
  - **下钻**（有 `record_id` 且该行为 `llm_call`）：默认返回投影（含 `tool_results`），**默认不含** messages 全文。新增可选 `detail: "messages" | "tool_results"`（缺省 `tool_results`）。`detail: "messages"` 才返回 messages（仍受 4000 帽与既有 compact）。
  - blob 行：reader 先解引用再投影。
  - 工具 description 写明：末轮无后续 `llm_call` 则无 tool_result 投影。
- **Confirms with human:** （无。）
- **Out of this spec:** 写侧捕获开关；join 会话 JSONL；trace MCP（#803）；P2 resume_offset 前端；sandbox stdout 截断；改 `recordToolCall` 字段填写。

## Success Criteria

1. 夹具 `llm_call.messages` 含一对 tool_use / tool_result → 列表投影 `tool_result_count >= 1` 且 preview 含结果片段（vitest）。
2. 无 tool_result 的 `llm_call` → `tool_result_count === 0`，无 `tool_results` 键或空数组（ vitest 钉一种）。
3. `record_id` 下钻默认响应 JSON **不含** 顶层 `messages` 数组（或仅有投影字段）；含 `tool_results`（vitest）。
4. `detail: "messages"` 下钻含 messages（或等价全文通道）（vitest）。
5. 单条 tool_result 正文 >400 字 → preview 以截断标记结尾且长度有界（vitest）。
6. blob 形态 messages 解引用后与 full 形态投影字段一致（vitest）。
7. `loop-engine` 对 `recordToolCall` 仍 `resultCaptured: false`（既有或新断言）。
8. `detail` 非法值 → 既有 `QueryTraceValidationError`（或同族 typed），不返回投影（vitest）。
9. 同一已解引用 `messages` 上并行两次投影（`Promise.all`）→ 字段一致且函数无共享可变累积（vitest）。
10. blob 解引用失败 → 该 `llm_call` 投影为空 `tool_results`（或 count 0）且 `// EXIT:`，不抛进用户 turn（vitest）。
11. `npx vitest run tests/harness/aci/tools/query-trace.test.ts` 加本票测（及投影单测文件）EXIT 0。

## Open Questions

(none)

## Inherits / Changes

- Inherits：`specs/trace-agent-readability.md` T9 `query_trace`；ADR-0003 A-scope JSONL；ADR-0006 不落可再生工具输出第二份盘；ADR-0036 blob。
- Inherits：`createJsonlTraceReader` 为读侧 SSOT。
- Changes：`projectRecord` / `record_id` 路径；可选 `detail`；纯函数抽出 tool_result。
- Test command: `npx vitest run tests/harness/aci/tools/query-trace.test.ts` 及投影函数测。
- Surfaces: 凡装配 `query_trace` 的入口（chat / tui / serve）；web `/trace` 面板本票不改除非零成本复用同一函数。

## ACR

```
bounded-context-guardian: yes — 投影在 traceserver/query-trace；loop-engine 写路径零改
defensive-contract-validator: yes — empty SC2；negative SC8；overflow SC5+4000 帽；concurrent SC9 纯函数并行；exception blob 解失败降级空投影 + EXIT（SC6 夹具）
error-handling-enforcer: yes — 非法 detail 走既有 QueryTraceValidationError；解引用失败不抛进 turn
complexity-anti-drift: yes — 一纯函数 + 两处接线（列表/下钻）
minimal-change-verifier: yes — 只读投影；禁止写侧 resultCaptured；禁止 MCP
```

## 待写入

已 flush（`plans/query-trace-tool-results.md` T1）。无新 ADR。
