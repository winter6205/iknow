# Plan: interrupt frozen prefix keep

**Goal:** Esc 前台打断时，钉住的流式前缀进入权威历史与墙，只丢掉还在长的块；三面对齐。
**Approach:** 先把 freeze 切刀迁到 harness 可 import 的 `src/shared` 缝（TUI 改为调用方），再改模型在途 closeout keep 与 persist。不在 harness 里引用 TUI。工具在途与键位不动。
**Spec link:** `specs/interrupt-frozen-prefix-keep.md`
**ACR:** all-yes（相对本计划切片，不是相对改前代码）
**待写入:** 空（ADR-0108 与 CONTEXT 已在本 worktree 落盘）
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion (landing grain: operator global commit section)

## ACR

- bounded-context-guardian: yes — T1 先把切刀放到 `src/shared`；harness 只 import shared；禁止 `src/harness` → `src/tui`
- input-contract-tests: yes — spec 表覆盖 freeze split 与 `run()` cancelled/timeout 的 empty / invalid / overflow / concurrent / exception
- error-handling-enforcer: yes — 非 string typed throw；commit 失败 **MessageCommitError**；顺序 split → prefix commit → interrupt commit，失败不得只留 interrupt
- complexity-anti-drift: yes — 一把 `splitStreamingMarkdown`；closeout 调用、TUI 调用；不设第二套 lexer
- minimal-change-verifier: yes — 只做模型在途 freeze keep + 切刀搬家；不改键位、continue 合同、落定态、工具在途形状

## Tasks (ordered by dependency)

1. **切刀可被 harness import** — tag: `[implementation]`
   - **Inherits:** spec invariant 3；ADR-0108 Decision 6；禁止 harness import TUI
   - **Surface:** `src/shared`；现有 TUI Markdown 调用方
   - **Acceptance:** 切刀行为与现行 freeze 单测同纪律（空串 / 钉住前缀 / 边界只前进）；TUI 流式 markdown 仍用同一函数；`src/harness` 仍无 tui import
   - Status: [x] done（a39b476b；tests/shared 6 用例 vitest 绿；SC6 grep 零命中）

2. **模型在途 cancelled keep 前缀** — tag: `[implementation]`
   - **Inherits:** spec invariants 1, 2, 7, 8；SC1, SC2, SC7；input-contract 表 `run()` cancelled 五行
   - **Surface:** Loop Engine closeout（`src/harness`）
   - **Acceptance:** 有 prefix → messages 含 assistant(prefix) 再 interrupt；无 prefix → 无本轮 assistant 仍有 user+interrupt；工具在途四条形状不变；commit 抛则 MessageCommitError 且无孤儿 interrupt
   - Status: [x] done（afa4da0b + 守卫钉死 85ac68a0；pty 实测：Esc 后盘面 assistant(1388 字前缀)+interrupt）
   - [blocks: T1]

3. **模型在途 timeout 同一刀、无 interrupt 句** — tag: `[implementation]`
   - **Inherits:** spec invariant 5；SC5；ADR-0091 钟 abort ≠ user cancel
   - **Surface:** Loop Engine closeout
   - **Acceptance:** timeout 模型在途 keep 规则同 T2 的 prefix/无 prefix；messages 末尾不是 `Interrupted by user.`
   - Status: [x] done（0938cd0c；SC5 用例含 cancelKind=timerTimeout 归属 assert）
   - [blocks: T2]

4. **盘面与 load 对齐三面** — tag: `[implementation]`
   - **Inherits:** spec invariants 4, 6；SC3, SC4；persist 表
   - **Surface:** `src/session-api` persist / continue prior
   - **Acceptance:** cancelled 有 prefix 时 load 出 assistant+interrupt；`/continue` 本次 prior 可去掉末尾 interrupt、前缀仍在；普通下一句 prior 带着前缀与 interrupt
   - Status: [x] done（5b926454；真实 store+fresh conv 集成测试；pty 实测 /continue 从 keep 前缀续跑成功、盘上 interrupt 保留）
   - [blocks: T2]

5. **TUI settle 只画 store** — tag: `[implementation]`
   - **Inherits:** spec invariant 2；input-contract 表 TUI settle
   - **Surface:** `src/tui` chat 墙
   - **Acceptance:** idle 后墙与 session.messages 同形状（有 prefix 则看得见钉住正文，无 overlay 残尾）；不把已卸 draft 写回历史
   - Status: [x] done（a661467a + teardown 修 58c3b687；无需改码，settle 既有路径满足；pty 实测墙=store 无残尾）
   - [blocks: T2]
