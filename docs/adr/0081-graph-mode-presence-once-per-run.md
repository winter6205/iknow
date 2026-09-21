# 0081. 开着 graph mode 时每个 run() 开头贴一次短现势

Date: 2026-09-10
Status: accepted
Landed: PR #989（`19fde472`，2026-09-11）

「此刻开着图」按**一次 `run()`**（一条人话的那一轮）在 messages 尾贴一句短 `<graph_mode>`，不按内环每一次即将调模型。翻转当拍仍可一条长 ON/OFF；同一 `run()` 已贴长 ON 则不叠短句。不进 system、不进 `run_graph` 回执、不进 `<agent_status>`。关着或从未开过：不贴。人读面：TUI/CLI 不把 `<graph_mode>` 画成用户气泡，与 `<agent_status>` 同纪律。

忘用仍靠常驻 `run_graph` description + 每轮人话一次短现势 + 翻转长句，不靠同一轮工具循环里反复追加同一句。

**Why not 每跳（0080）：** 同一短句每跳追加会把 transcript 刷成重复现势；人读若不过滤更会当成用户气泡。一轮开头一次已经标明本轮 overlay。
