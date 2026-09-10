# 0080. 开着 graph mode 时每次调模型在尾部贴短现势；不靠 compact 特补

Date: 2026-09-10
Status: superseded by 0081

`run_graph` 怎么交图仍只在常驻 tools description（会话内不变）。「此刻开着图」是本轮现势：holder 仍 on 时，**每次即将调模型**在 messages 尾追加一句短 `<graph_mode>`（有依赖用 `run_graph`，单发 spawn）。不进 system，不进 `run_graph` 回执，不进 `<agent_status>`。关着或从未开过：不贴现势。切模式仍只在**下一次 `run()`** 生效；翻转当拍可保留现有长 ON/OFF 各一次，同一拍已贴长 ON 则不再叠短句。

不再为 compact 单开补丁（#979 取消）：压掉旧现势后，下一跳只要还开着再贴短句。#978 / 操作员 2026-09-10 锁定。

编号避开已占用的 ADR-0079（`skill()` 二次短路）。本 ADR 取代 ADR-0078 的「只靠 compact 再贴」合同。

**Why not 只翻转一次 / 只 compact 再贴：** 忘用发生在未压缩的长会话里；说明书在 tools 里不等于本轮会选这把工具。
