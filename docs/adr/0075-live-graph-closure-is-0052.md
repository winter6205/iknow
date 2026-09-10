# 0075. Destination 第四句沿用 ADR-0052；不做 host 收口停闸

Date: 2026-09-10
Status: accepted

[wayfinder:map] 长程图执行 — Dynamic Pipeline + replan 的 Destination 第四句「明确收口」验收为 ADR-0052：空剩余 + 人停 / `/reset` / 主 loop 既有停条件。不写 `specs/live-graph-phase3.md` 实施项；不加外环次数硬顶；host 不广播「管线完成」，也不因空账本拒绝再交剩余子图。effort 8 仍只熔一次 `run_graph` 内空转。空剩余 ≠ 任务完成——后者在主代理与人。#974。

**Why not host 完成事件 / 外环硬顶：** 会把账本无 pending 抬成任务预言机，重开 ADR-0052，并滑向 `wait:false` / mailbox。
