# 0029. FaultClass 并行于 StopReason，工具环以 fused 停止

Date: 2026-08-25
Status: accepted

StopReason 继续只回答「这一次 run 为什么停」（追加不重排）。失败要不要传输重试、要不要计入工具环，用并行闭集 FaultClass（retry / fuse / none），避免把 API/工具/上下文/控制流塞进停止联合。本 run 内工具环在结果已写入 append-only messages 之后判定停滞，则注入 LOOP_DETECTED 信封并以新停因 `fused` 结束（017 追加 cancelled/timeout 的同一纪律）。传输重试装饰 ModelAdapter，不进 loop、不进 session-api、不绑某一家 SDK。子代理必须把 fused 当失败信封。否决：新停因却不改 worker；只给人看熔断、下一轮不喂模型；用连续 N=3 代替周期+停滞。

## Why not

- **把故障类写进 StopReason**：与 completed/cancelled 混语义，session-api 与 worker 穷尽分支会静默错。
- **复用 nonSuccessStop**：那是供应商截断/拒绝，测试无法断言环检测。
- **环检测放进 verify-loop**：verify 只在 completed 后跑，管不到 run 内工具空转。
