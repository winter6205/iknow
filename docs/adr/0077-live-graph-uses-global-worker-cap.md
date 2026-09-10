# 0077. 活图节点计入同一条子代理并发上限；不另起 per-graph inflight

Date: 2026-09-10
Status: accepted

图节点走同一 `SubAgentManager`，占用 **子代理并发上限**（默认 15，`settings.subagent.maxConcurrentWorkers` / `IKNOW_SUBAGENT_MAX_CONCURRENT_WORKERS`）。不另起每图预算、不另起独立池。溢出仍 typed 拒绝、不排队。ADR-0052 已排除把 inflight 当收口。#976。

**Why not 图内第二顶：** 跑图时父不能另派（ADR-0065）；第二顶与全局 `min` 同效，独立池会叠两份进程。
