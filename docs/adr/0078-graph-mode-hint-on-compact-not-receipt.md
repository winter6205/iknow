# 0078. 图编排不进 system、不进 run_graph 回执；compact 后若仍开着则尾部再贴短提示

Date: 2026-09-10
Status: superseded by ADR-0080

ADR-0041 的「回执重提」不采用：每次 `run_graph` settle 都贴编排，时刻错（刚跑完图最不缺说明书）。本图不改 condense。

遗忘补救钉在 **compact 成功且 graph mode 仍 on**：proactive / reactive / 手动 `/compact` 只要改写了 messages，就在尾部追加一条短 `<graph_mode>` user 消息（与 `appendGraphModeChange` 同形：尾部、不进 system、不改 tools）。不是翻转，不碰 `lastSeenEnabled`。关着或从未开过：零追加。不探测旧提示是否还在窗内——摘要可能改写标签，每次成功 compact 都贴一条短的。

短提示只说「仍开着、有依赖用 `run_graph`、单发用 spawn、关着会拒」；不复述整段 ON 通知，不进 `<agent_status>`。ask / worker 无 overlay 则缝缺席。#978。

**Why not 回执 / 每跳栏：** 回执打在错拍；每跳灌说明书会把现势栏变成第二套 system。

> **Amendment 2026-09-10**：开图现势**不进 system**（ADR-0041）仍成立。补救从「compact 后再贴」改为 **每次即将调模型、holder 仍 on 则贴短现势**（ADR-0080）。`#979` 已取消，不为 compact 单开补丁。#978。
