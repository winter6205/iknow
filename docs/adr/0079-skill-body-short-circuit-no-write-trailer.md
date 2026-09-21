# 0079. skill() 二次短路；写处境不进 skill 正文

Date: 2026-09-10
Status: accepted

`skill()` 灌的是技能程序，不是写哪。同名再调时，若可见 messages 仍有该名成功全文 `tool_result`，只回短回执、不重装正文；compact 丢掉该条后才再灌。闸只罩 ACI `skill()`，不用只增不减的会话 Set（会和截断窗口打架，也会把已加载集合写进可变会话态）。slash / Web `getSkillBody` 不闸。磁盘 SKILL.md 本会话变了不自动再灌。写处境变化不是再灌理由。

写处境的告知面组成在此收窄：去掉 skill 正文 trailer。剩余告知面 = 子代理 worker prior + 改绑后主会话一次（用户消息缝）。回执仍是门禁与 typed 错误。不在写工具成功路径另注写处境段。未绑树时模型可能按 skill 先伸手写一次再看到回执——用一次自洽失败换两条轴不再互绑。

**Why not 会话 Set / 写时另注 / 维持三面 trailer：** Set 在 compact 后误禁再灌；写时另注是门禁回执之外的第三份同类信息；挂在 skill 上会把「还要用这个技能」误读成「要重载技能」。

