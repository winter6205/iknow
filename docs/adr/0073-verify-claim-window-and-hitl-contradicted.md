# 0073. 声称窗口用 messages 下标；HITL 不因 checker CONTRADICTED 打回

Date: 2026-09-09
Status: accepted

Context: `checkEvidence` 的 `claimIndex` 被 `verify-loop` 传成验证 `round`（首轮恒 1），现场只看 `messages[0]`，证据前级对真实多 turn transcript 失明。同时 HITL 把 checker `EVIDENCE_CONTRADICTED`（`rm` / 写空测试文件）映射成打回，会惩罚「整理测试」这种合法会话。ADR-0024 的模块划分（HITL 不请完成向 LLM）仍然成立；本决策只改**窗口坐标**和 **HITL 对 CONTRADICTED 的消费**。

Decision: （1）`claimIndex` 是声称位置 = `messages` 下标，与 `deriveFinalText` 同一次回扫「最后一条有非空 text 的 assistant」；`round` 只记账。找不到该 assistant → INSUFFICIENT。（2）正常模式不把 CONTRADICTED 当 `true-failure`；**goal 功能**仍硬否决（接线 flag `completionMode === "auto"`，是 goal 功能模块，不是自动模式）。（3）HITL 且证据不够且跳过完成向判官时，人对面不显示「验证通过」。

Why: 检查器要看见声称之前的测试与编辑，否则 CONTRADICTED / SUFFICIENT / stale 都是空转。HITL 人在键盘旁，删旧测试不是作弊信号；把「没验过」显示成绿勾是假通过。goal 功能仍要防「删测试装绿」。

Evidence: specs/verify-claim-window.md；会话 8ff77b89 两条 verification 均为 `hitl_skip_completion_judge` + `EVIDENCE_INSUFFICIENT` + `passed`。
