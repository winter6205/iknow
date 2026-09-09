# Spec: verify-claim-window — 声称窗口坐标 + HITL 不因毁测试打回 + 闲聊不打绿勾

> 来源：2026-09-09 会话 `8ff77b89` 复盘 + operator 逐问拍板。  
> 本 spec **amends** `449-evidence-checker.md`（`claimIndex` 语义）、`verify-goal-gate.md`（HITL 对 CONTRADICTED 的消费）、ADR-0024（HITL 硬失败范围）。决策落 ADR-0073。  
> 假设闸门：本会话已确认下列假设，不再另等一轮回复。

## Assumptions（本会话已确认）

1. 窗口右端是 `messages` 下标，不是 verify `round`；与 `deriveFinalText` 同一次从后往前回扫「有非空 text 的 assistant」。
2. 找不到这样的 assistant → fail-closed：INSUFFICIENT，不装 SUFFICIENT。
3. 闲聊 / 无框架绿测：不失败、不打回；HITL + INSUFFICIENT + 跳过完成向判官 → **不显示「验证通过」绿勾**。
4. HITL 对 checker 的 `EVIDENCE_CONTRADICTED`（`rm` 测试路径 / `write_file` 写空测试文件）**不当** `true-failure` 打回；整理测试是合法任务。
5. **goal 功能**仍把 CONTRADICTED 当硬否决（接线 flag `completionMode === "auto"`，是 goal 功能模块，不是自动模式）。
6. todo 账本不接入 verify（CONTEXT 已禁「把栏接入 verify」）；补跑信封、证据本体（哪些命令算测试）本票不动。
7. 检查器纯函数仍可报 CONTRADICTED；改的是 **HITL 循环怎么用它**，不是拆掉 A7 规则。

## Glossary（exact copy / 本票要改的词见 待写入）

- **append-only messages**: Foundation 的权威 Anthropic 原生会话历史，是唯一事实来源；消息只能以不可变追加更新。
- **checker 三态 verdict**: 证据充分性判定 = `EVIDENCE_SUFFICIENT` / `EVIDENCE_CONTRADICTED` / `EVIDENCE_INSUFFICIENT`；6 条检查封装在 `evidence-checker.ts` 内部。
- **正常模式**: 默认 HITL 产品：每轮说完把回合还给用户；完成向 LLM 关闭；硬失败打回干活模型。（硬失败范围由本 spec / ADR-0073 收窄为命令非零等，**不含** HITL 下的 CONTRADICTED。）
- **判官（judge）**: 共用的只读 LLM 分类器系统；完成向评价只挂 goal 功能逻辑模块。
- **green marker**: 测试框架输出里的通过摘要行（白名单 pytest / jest / vitest / go test / cargo test）。

## Architectural Constraints

- **ADR-0024**：HITL 不请完成向 LLM；`INSUFFICIENT` 必请仅覆盖完成向邀请（goal）。本票不推翻该模块划分。
- **ADR-0017** checker 三级流 shape 保留；消费面按模式分叉（本票）。
- **ADR-0073**（本票 persist）：声称窗口 ≠ `round`；HITL 不因 CONTRADICTED 打回。
- checker 保持纯函数：不 import loop-engine；`claimIndex` 仍由调用方传入。

## Objective

让证据前级在真实多 turn transcript 上**看得见**声称完成之前的测试跑与代码编辑；同时让普通聊天不再把「没验过」显示成「验证通过」，也不再把「整理/删除旧测试」打回干活模型。**goal 功能**仍可用 CONTRADICTED 防「删测试装绿」。

用户：TUI / CLI 正常聊天与 `/goal`。成功 = 窗口坐标与 `finalText` 同源；HITL 闲聊无绿勾、删测试不打回；goal 功能硬否决仍在；单测不再把「证据必须在 messages[0]」当成合同。

## Boundaries

- **Does:**
  - 调用方传入的 `claimIndex` = 声称位置（messages 下标），由与 `deriveFinalText` 同源的回扫得出。
  - `round` 只表示验证闭环第几轮，写 `VerificationRecord.round`，不当窗口。
  - HITL：`EVIDENCE_CONTRADICTED` 与 INSUFFICIENT 同消费——不请完成向判官、不 `true-failure` 打回。
  - HITL + INSUFFICIENT + `hitl_skip_completion_judge`：人对面不出现「验证通过」绿勾（TUI banner / CLI `formatVerifyReport` 的 passed 文案）。
  - HITL + SUFFICIENT 短路：仍可显示通过（证据真的够）。
  - **goal 功能**：CONTRADICTED → 仍 `true-failure`。
- **Confirms with human:** （none — 本会话已拍死）
- **Out of this spec:**
  - todo 接入 verify；自动勾账本；对照 transcript 推断 todo 是否做完。
  - 扩证据本体（截图 / HTML / `mv` 归档算 CONTRADICTED）。
  - 补跑信封（INSUFFICIENT 时探测 pytest）行为变更。
  - MCP `--trace-out` / 会话两级树。
  - 把 CONTRADICTED 从 checker 纯函数里删掉。

## Success Criteria

每条均可 `npx vitest run` 定向集 EXIT 0 判定（实现期落在既有 `tests/harness/verify/` + TUI/CLI 投影测）。

1. **SC1 窗口**：绿测在 `messages[2]`、声称 assistant 在更大下标、`round === 1` → `checkEvidence`（经循环接线）为 SUFFICIENT。同一夹具在改前（`claimIndex: 1`）必须不能 SUFFICIENT（回归钉「不是只看第 0 条」）。
2. **SC2 闲聊**：无框架测试跑的 HITL completed → outcome 对人不是「验证通过」（banner `kind: none` 或等价静默；CLI 不打印 `[验证] 验证通过`）。不注入修正轮。
3. **SC3 HITL 毁测试**：HITL 夹具含 `rm` 测试路径或 `write_file` 写空测试文件 → 不进入 `true-failure` 打回（不因 CONTRADICTED 再跑干活模型）。
4. **SC4 goal 功能毁测试**：goal 功能（接线 `completionMode === "auto"`）同一毁测试夹具 → 仍 `true-failure` / 硬否决。
5. **SC5 无声称点**：messages 中无带非空 text 的 assistant → INSUFFICIENT；不 SUFFICIENT；HITL 无绿勾。
6. **SC6 合同**：`449-evidence-checker.md` 的 `claimIndex` 行写明 messages 下标；`three-stage-flow.test.ts` 不再把「证据必须在 messages[0]」写成 B4 精确语义。

## Open Questions

(none)

## Inherits / Changes

- **Inherits:** `checkEvidence({ messages, claimIndex })` 形状（`449-evidence-checker.md`）；`deriveFinalText` 回扫算法（`loop-engine`）；HITL skip 完成向判官 EXIT（ADR-0024 / `REASON_HITL_SKIP_COMPLETION_JUDGE`）；checker 认的框架绿 / 弱绿 / 吞失败 / stale（不改）。
- **Changes:** `claimIndex` 的权威值从 `round` 改为声称下标；HITL 不再把 CONTRADICTED 映射为打回；HITL 未验过不投影「验证通过」。
- **待写入（persist）:**
  - CONTEXT：`声称位置` 词条；改 `checker 三态 verdict` 的 HITL 消费句。
  - ADR-0073：窗口坐标 + HITL 不因 CONTRADICTED 打回。
  - 修订 `449-evidence-checker.md`、`verify-goal-gate.md`、`specs/README.md`、`docs/STATUS.md`。

## Commands

```bash
npx vitest run tests/harness/verify/
npx vitest run tests/tui/ tests/cli/format.test.ts
npm run typecheck
```

## architecture-change-reviewer

```
bounded-context-guardian: yes — 接线留在 harness/verify；投影留在 tui/cli；checker 仍纯函数；不新开 bounded context
defensive-contract-validator: yes — SC1–SC5 覆盖 empty（无声称）、negative（毁测试 HITL/goal 功能分叉）、overflow（多 turn 绿测不在 [0]）、exception（无 text assistant fail-closed）；concurrent N/A 纯函数窗口
error-handling-enforcer: yes — 无声称点命名 fail-closed；HITL CONTRADICTED 降为与 INSUFFICIENT 同 EXIT（不打回）；不新增空 catch
complexity-anti-drift: yes — 回扫与 deriveFinalText 同源抽取，不复制第二套「最后一条」；循环只改坐标与一处模式分叉
minimal-change-verifier: yes — 一票三笔 tracer（坐标 / HITL 消费 / 人读投影），不混 todo、补跑、MCP
```
