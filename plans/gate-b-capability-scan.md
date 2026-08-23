# Plan: Gate B 扫能力泄漏，不扫文档用词

**Goal:** Gate B 继续禁止 conditional remediation 能力进入 `src/harness/` 可执行面；允许注释 / JSDoc 使用 `checkpoint` / `retry` 等词说明边界。
**Approach:** 抽出扫描器：先把 `//` 与 `/* */` 空白化（保留换行），再扫剩余代码（含字符串与 import 路径）。去掉 `span` / `metric` 泛词与「豁免句式」正则。checkpoint 落盘仍在 session-api。
**Spec link:** 无新 spec；对齐 `docs/CONTEXT.md` required runtime / conditional remediation layer 与 `specs/session-jsonl-resume.md` Boundaries。

## 5-line verdict

```
bounded-context-guardian: yes — 新代码只在 tests/harness/；src/harness 行为不变；checkpoint 能力仍在 session-api
defensive-contract-validator: yes — empty / 注释-only 无泄漏 / 标识符泄漏 / session-api 与 otel import / overflow（≥10k 注释行）/ concurrent（Promise.all 重复扫描）/ exception（未闭合 /* 不抛，余下当注释）
error-handling-enforcer: yes — 扫描器是全函数、永不抛；未闭合块注释 EXIT：余下空白化为注释；public-exports 仍用聚合列表失败（既有 assert 风格）
complexity-anti-drift: yes — blank-out 与规则表分函数；public-exports 只遍历 src/harness 调用扫描器
minimal-change-verifier: yes — 1 逻辑任务 1 commit；无生产行为改动
```

## Files

- `tests/harness/gate-b-capability.ts`
- `tests/harness/gate-b-capability.test.ts`
- `tests/harness/public-exports.test.ts`
- `docs/CONTEXT.md`
- `specs/session-jsonl-resume.md`
- `plans/gate-b-capability-scan.md`（本文件）
