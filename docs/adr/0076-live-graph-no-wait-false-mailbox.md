# 0076. 活图不吸收 wait:false / 节点完成唤醒 / mailbox

Date: 2026-09-10
Status: accepted

[wayfinder:map] 长程图执行 — Dynamic Pipeline + replan 不给 `run_graph` 或图节点加 `wait:false`，不按节点完成唤醒父代理，不把 **mailbox** 接到图上。后景臂与事件唤醒留在 [子代理取消等待 — mailbox 回传 + 事件驱动唤醒](https://github.com/winter6205/iknow/issues/815)。[enhancement(graph): 性能优化 + 编排 prompt 实测迭代](https://github.com/winter6205/iknow/issues/727) 旧 Destination 不并入本图。沿用 ADR-0065 / ADR-0048。#975。

**Why not 整图或节点后景：** 会与外环修订、按 id 冻结抢同一张活图，并把管线拖回按事件对话。
