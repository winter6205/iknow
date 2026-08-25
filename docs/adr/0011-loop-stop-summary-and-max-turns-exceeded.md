# 0011. maxTurns 超限 / 异常停: throw MaxTurnsExceeded + 模型收尾摘要

Date: 2026-08-08
Status: accepted

## Context

`src/harness/loop-engine.ts:593-603` 在 turn 数达到上限时静默返回
`{ kind: "stop", reason: "maxTurns" }` —— 无摘要、无通知、不进 turn 记录
(`turn: null`)。外部 `stepWithTrace` 消费这个 stop 结果,但若调用方不读它就
"无声死亡",用户看到的就是"6 轮就挂了"且不知道为什么。解决"直接停止就不知道
做了什么"的痛点,需要把超限从"可被忽略的返回值"升级为"强制感知的异常"。

## Decision

超限 (maxTurns) 与其它异常停 (timeout / protocolError / cancelled) 统一改为:

1. **出口形态 = throw**: 超限抛 `MaxTurnsExceeded` (上游参考实现风格,
   `query.py:129-134` + `ui/runtime.py:681-682`),强制调用方感知,替代
   silent-stop。异常沿调用栈冒泡到外层 catch,由外层写盘保存当前会话。
2. **异常只做信号**: `MaxTurnsExceeded` 携带已跑轮数 + 原因,不携带
   messages 快照 / usage。数据留在 session 权威状态 (`_messages` 是
   append-only 唯一权威),外层 catch 可拿到一切。避免"异常里一份、
   session 里一份"的双份重复 (SSOT)。
3. **收尾 = 真·模型摘要**: 任何异常停后,额外跑**一轮**纯文本模型调用,
   模型解析当前 transcript 尾部 + 停因,输出"做了什么 + 为什么停"的总结。
   摘要轮**不计入 maxTurns** (固定 1 次 epilogue,非循环迭代)。
4. **三个砍法保简单**:
   - 固定尾部窗口 (~8K token) 作摘要输入,天然在窗内,避免超窗躲开
     reactive-compact 兜底;
   - 独立短超时 (~15s) + catch-all,摘要失败即跳过,绝不阻塞原始停因,
     不递归处理"摘要的摘要";
   - 摘要结果挂到已有 `HarnessStreamEvent` 终态成员的字段上 (或
     `MaxTurnsExceeded` 字段),不另起机制。
5. **不 append 进 `_messages`**: 摘要是展示产物,不污染权威历史 (否则
   resume 时像一轮真 turn)。usage 照落 `LlmCallRecord` (ADR-0008 合规)。

## Considered Options

- **raise vs return**: 保留 return 但接通 UI 是"最小破坏"路线,但它保留了
  silent-stop 的根源 —— 外部仍可忽略返回值。本次明确**抛弃旧设计的
  silent-stop 契约**作为改进目标,选 throw 强制感知。
- **模型摘要 vs 结构化停因快照**: 曾考虑"loop 把已有状态打包成 snapshot"
  (零模型调用、更简单),但用户明确要**真·模型摘要** —— 让 AI 解析当前
  情况 + 异常终止原因,产出自然语言总结。snapshot 路线被否。
- **摘要计入 vs 不计入 maxTurns**: 计入会让"设 20 实际只有 19 轮工具工作 +
  1 轮摘要",违背 least-astonishment;摘要是不调工具的纯文本 epilogue,
  不消费"工具迭代"预算,选不计入。

## Consequences

- (+) throw 强制感知,用户不再"不知道为什么停"。
- (+) 摘要覆盖所有异常停 (maxTurns / timeout / protocolError / cancelled),
  不只是 maxTurns —— 因为摘要不依赖模型稳定性 (best-effort,失败即跳过),
  无"在不稳时再依赖一次模型"的顾虑。
- (−) 三个 surface (chat REPL / ask / serve) 需适配 throw 契约 —— 这是
  有意为之的破坏,不是为了保留 silent-stop 而做的妥协。
- (−) 摘要轮多一次模型调用 (usage + 延迟),但 best-effort + 独立短超时
  把成本收敛到有界。
- 回退 = 把 throw 改回 return stop + 去掉摘要调用;但一旦 surface 消费者
  已适配 throw 契约,回退成本上升 —— 故属 hard-to-reverse。

## Evidence pointers

- `src/harness/loop-engine.ts:593-603` — 当前 silent stop。
- `docs/harness-report/p02-architecture-loop.html` §2.2 — 上游参考实现
  `run_query()` 状态机,`max_turns` 超限 raise `MaxTurnsExceeded`。
- `src/harness/stream.ts:20-23` — `HarnessStreamEvent` 三成员,无终态事件,
  需加终态成员承载摘要。
- `specs/trace-service.md:124` — `recordTurn` decision 已预声明
  `max_turns_exceeded` 停因。
- `docs/adr/0008-token-accounting-usage-placement.md` — usage
  observability-first,`LlmCallRecord` 承载 token。
- `loop-engine.ts:215` — `DEFAULT_TIMEOUT_MS = 60_000`,超时可能伪装成"挂了",
  是摘要/停因要覆盖的另一条路径。
