# Session Handoff — ADR-0081 graph 短现势 once-per-run（2026-09-11）

## 本轮做了什么

1. **合入 PR #989**（squash `19fde472`）：`appendGraphModePresence` 用 `graphModePresence.appendedThisRun` latch，`run()` 开头重置；同 deps 连续 `step()` 视为同一 run 的 hop。
2. **SEAM 锁** `tests/harness/loop-engine/graph-mode-presence.test.ts` 从 ADR-0080 每跳改为 0081：两 hop 一条、长 ON 后本 run 不再贴、compact 重试不二次注入、跨 `run()` 各一条。
3. **文档对齐**（本 commit）：ADR-0081 补 Landed 指针；`docs/STATUS.md` 增短现势行；`CHANGELOG.md` Feature；黄金集 handoff 去掉「0081 未合入」表述。

## 未做

- 未新建 `specs/graph-mode-presence.md`（节奏 SSOT 仍是 ADR-0081；人读过滤在 `specs/tui-human-display.md`）。
- 未跑完整 `npm test`（合入前 CI `test-fast` + `s4-check` 绿）。

## 复跑入口

```bash
npx vitest run tests/harness/loop-engine/graph-mode-presence.test.ts
```
