# 0027. 会话权威历史改为单文件 JSONL

Date: 2026-08-22
Status: accepted

Context: #120 第一轮把会话做成整份 JSON + tmp/rename，并写明「本期不迁 JSONL」（`specs/120-session-persistence.md` Q1；声称的 ADR-0007 未落文件）。那是可落地的脚手架，不是与 Claude Code 分叉。#615 grilling 要把崩溃续跑和 rewind 留分支做上，线性 `messages[]` 做不到 fork。

Decision: 会话权威历史是带 id/parent 的单文件 append-only JSONL；进程内工作副本跟落盘的 rewind head。trace JSONL 仍只做观测。旧 SessionFileV1 可 load，下一次 save 迁走。不把续跑状态塞进 `CheckpointRecord`。

Why: Claude Code 用 JSONL 流水账才能边写边留分支；整文件覆盖加截断 rewind 会丢掉半截 turn 和退回去的历史。#120 Q6（任何入口读同一份盘）仍成立，只换文件形态。
