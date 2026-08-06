# #196 Identity Assembly — handoff evidence

> Date: 2026-08-06  
> Spec: `specs/196-identity-assembly.md` (ACR 5/5 PASS)  
> Plan: `plans/196-identity-assembly.md` (8 tracer bullets)

## Smoke (`scripts/i12-identity-assembly-smoke.ts`)

跑 `npx tsx scripts/i12-identity-assembly-smoke.ts` 输出（SC 37）：

- identity 段注入 / soul 段注入 / user.md 存在
- BOOTSTRAP 首启触发 / state.json 写入 / 二次启动跳过 BOOTSTRAP

`output.txt` 附本目录（SC 38）。

## 39 条 SC 验收

- 基础功能 (1-10) ✓
- 认知 vs 人格边界 (11-14) ✓
- 入口覆盖 (15-19) ✓
- 注入缝 (20-23) ✓
- 状态机 (24-27) ✓
- 装配顺序 (28-30) ✓
- 错误降级 (31-33) ✓
- 回归 (34-36) ✓
- 自动化 evidence (37-39) ✓
