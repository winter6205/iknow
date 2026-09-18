# 0100. 策略预算窗口默认 256k；auto-compact 缺省 95%

Date: 2026-09-18
Status: accepted

## Context

用量显示分母与 proactive auto-compact 闸曾跟供应商模型上限混用，缺省闸是 `window − 33k`。操作员策略预算（256k）上那条公式会过早压缩；1M 卡也不该当百分比分母。编号避开已占用的 ADR-0099（home 项目树 memory）。

## Decision

`env.compress.contextWindow` 是操作员的 **策略预算窗口**（用量显示分母与 proactive 闸同一 SSOT），不是供应商模型上限。仓库缺省 256000。未设 `thresholdTokens` 时闸为 `floor(0.95 × contextWindow)`，不再用 `window − 33k`。显式阈值仍必须 `< window`。把分母设成真上限的人自己压低 `IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS`。

## Why not

**Why not 显示 256k、压缩仍按 1M / 两套窗口：** CONTEXT 禁止第二本 token 账。  
**Why not `min(95%, window − 33k)`：** 256k 上仍是 87%，95% 落不下去。  
**Why not 只改本机 settings：** 策略预算是产品缺省，不是个人 override。  
**Why not 维持 `window − 33k`：** 那是分母≈真上限时的余量；策略预算上会过早压。
