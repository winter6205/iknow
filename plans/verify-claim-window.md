# Plan: verify-claim-window

**Goal:** 声称窗口用 messages 下标（与 `finalText` 同源）；HITL 不因毁测试打回、闲聊不打绿勾；goal 功能硬否决保留。  
**Approach:** 三笔垂直切片——先让检查器看得见，再改 HITL 怎么用 CONTRADICTED，最后改人对面投影。不改 checker 认哪些命令算测试，不接 todo。  
**Spec link:** `specs/verify-claim-window.md`  
**ACR:** all-yes（与 spec 块相同）  
**Per-ticket loop (all bullets):** tdd → typecheck+tests → verification-before-completion → one commit on the ticket branch. End-of-round code-review after T3。

```
bounded-context-guardian: yes — 接线留在 harness/verify；投影留在 tui/cli；checker 仍纯函数；不新开 bounded context
defensive-contract-validator: yes — SC1–SC5 覆盖 empty / negative / overflow / exception；concurrent N/A
error-handling-enforcer: yes — 无声称点 fail-closed；HITL CONTRADICTED 与 INSUFFICIENT 同 EXIT
complexity-anti-drift: yes — 回扫与 deriveFinalText 同源；循环只改坐标与一处模式分叉
minimal-change-verifier: yes — 三笔各一逻辑任务一 commit；不混 todo / 补跑 / MCP
```

## 待写入

本 plan 起草时清单已由 persist 落到 ADR-0073 + CONTEXT；实施期勿再发明词。

## Tasks (ordered by dependency)

1. **声称窗口坐标** — tag: `[implementation]`
   - **Inherits:** spec SC1 / SC5 / SC6；`claimIndex` = 与 `deriveFinalText` 同源回扫的 messages 下标；找不到 → INSUFFICIENT；`round` 不当窗口。
   - **Surface:** `src/harness/verify`（调用方传入）；`src/harness` 上已有的 `deriveFinalText` 回扫。
   - **Acceptance:** 绿测不在 `messages[0]`、声称在后、`round === 1` → 经循环接线 SUFFICIENT；无非空 text assistant → INSUFFICIENT。`three-stage-flow` 不再把「证据必须在 messages[0]」写成合同。定向 `npx vitest run tests/harness/verify/` EXIT 0。
   - Status: [x] done

2. **HITL 不因 CONTRADICTED 打回** — tag: `[implementation]`
   - **Inherits:** spec SC3 / SC4；ADR-0073；checker 仍可报 CONTRADICTED；HITL 不当 `true-failure`；goal 功能（接线 `completionMode === "auto"`，goal 功能模块，不是自动模式）仍硬否决。
   - **Surface:** `src/harness/verify` 循环消费；不改 `evidence-checker` 的 A7 探测规则（除非实现期证明必须抽消费层）。
   - **Acceptance:** HITL 夹具 `rm` 或写空测试文件 → 不打回干活模型；同一夹具走 goal 功能 → 仍硬否决。
   - Status: [x] done
   - [blocks: T1]

3. **闲聊不打绿勾** — tag: `[implementation]`
   - **Inherits:** spec SC2；HITL + INSUFFICIENT + `hitl_skip_completion_judge` 对人不是「验证通过」；SUFFICIENT 短路仍可绿勾。
   - **Surface:** TUI verify banner 投影；CLI `formatVerifyReport` 调用点。
   - **Acceptance:** 无框架绿测的 HITL completed → banner 静默（或等价 `none`）、CLI 不印 `[验证] 验证通过`；有 SUFFICIENT 的 HITL 仍可显示通过。
   - Status: [x] done
   - [blocks: T2]
