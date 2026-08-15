# 0017. verify 判定改为证据优先三级流：证据核对 → 补跑 → 证据感知判官，证据充分永不重跑

Date: 2026-08-16
Status: accepted

Context: master 的 verify 是 A/B 二选一模型——「settings 配 command → 沙箱重跑 / command 缺失 → 判官盲查」，`verify.command` 是唯一激活验证的钥匙；判官实际拿全量工具面且只收到 task 字段。

Decision: 重构为三级判定流（缝在 `verify-loop.ts` produceObservation）：① `checkEvidence` 三态 verdict 先行——`EVIDENCE_SUFFICIENT` 零 LLM 成本直接 PASS，**即使配了 command 也永不重跑**；② `INSUFFICIENT` → 至多 1 次补跑信封（命令 = `verify.command` 优先，否则 D2 探测）；③ 仍不足 → 证据感知只读判官兜底（task #459 公式不重绑 + evidenceContext），四态输出，`unverified`/`abort` → `unstable` 停止、不注入信封、结果原样返回用户。`verify.command` 降级为可选补跑/强制重跑覆盖，字段不删不改名。

Why: 证据扎实的 completed 零成本 PASS；fail-closed——拿不准永不 PASS（"a verifier that bluffs is worse than none"）。命令路径既有机制（沙箱 fence / 确认阶梯 / 趋势裁判 / escalate）冻结不改，只在其前级插入证据优先；checker 三态进 trend 评估前先映射回闭环 Verdict（SUFFICIENT→pass / CONTRADICTED→true-failure / unverified·abort→unstable）。

Evidence: `specs/449-verify-evidence-first-loop.md` + `specs/449-evidence-checker.md`（均 ACR PASS 5/5）；#449 map G1-G5 决议；`plans/449-evidence-checker.md` + `plans/449-verify-evidence-first-loop.md`。
