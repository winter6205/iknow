# 0026. compact 保焦改用任务摘录，不再把 taskFocus 写进会话

Date: 2026-08-21
Status: accepted

Context: ADR-0018 把 `session.taskFocus` 做成常驻焦点（首条像样任务句 seed 一次、compact 用 240+history 渲染）。盘问后确认：模型要的是压缩当时的用户任务原话，不是会话里一张会过期的卡；每回合填卡和压缩 LLM 填卡都浪费一轮。

Decision: 正常模式 compact 只从当时 `messages` 现抽现贴至多 3 句合格用户任务原文（任务摘录）；不落盘、不 seed、自动模式不贴。ADR-0018 的 `session.goal` 拆分与模型零写入仍成立；`session.taskFocus` 常驻与焦点渲染段作废。

Why: 原话比摘要卡可核对；现抽避免卡与对话分叉；复用 `isTurnQuery` + 寒暄过滤，不为摘录加模型。
