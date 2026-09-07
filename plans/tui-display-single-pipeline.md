# Plan: TUI 显示单管线

**Goal:** live 与历史只消费同一套落定 slot；成功 bash 只留命令标题；思考只画一行秒数；同一条工具不得双画。
**Approach:** 不重开留/收/点名三类。先把 CONTEXT 已收口的 keep / 思考表面落到策略核与折叠行，再收掉 live/历史/legacy 叠画，最后给 Markdown `html` 加行帽并把预览前缀换成终端稳的 ASCII。Web 不做。
**Spec link:** `specs/tui-tool-settled-appearance.md`（D4「成功 bash 五行走」被本轮 CONTEXT keep class 改写，见 T1 Inherits）
**ACR:** all-yes（见下方）
**Tracker:** 本地 markdown。操作员裁定不开 GitHub issue tracker；无 issue 边。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on `worktree-tui-display-single-pipeline`

## ACR

```
bounded-context-guardian: yes — 只动既有 TUI 能力，不新开仓库级 context，禁止 services/utils/tool-display 预拆。
defensive-contract-validator: yes — 空输出/无秒数、失败横切、溢出行帽、running vs idle 互不串、未知工具仍 retract；纯函数 concurrent N/A。
error-handling-enforcer: yes — 失败仍走 failure overlay（typed slot、一行短错误、不 null）；无 thinkingMs 不画行不回落括号；空预览不画空块。
complexity-anti-drift: yes — 渲染只消费 slot；删叠画路径，不把折叠/预览/live 再写进 ChatView 平行策略。
minimal-change-verifier: yes — 一逻辑任务一 commit，按下方 tracer bullet 切，不混 Web。
```

## 待写入

（空 — 已刷入本 worktree `docs/CONTEXT.md`：keep class / result preview / unit fold / settled vs result preview）

## Tasks (ordered by dependency)

1. **成功 bash 落定只留标题** — tag: `[implementation]`
   - **Inherits:** CONTEXT keep class：bash 成功只留带命令的标题，不带结果预览；write/edit 仍留完成态 6 行预览。result preview 只属于 live running。failure overlay 不变。
   - **Inherits (spec 冲突):** > Contradicts `specs/tui-tool-settled-appearance.md` D4 / SC3「bash 成功五行走」— worth reopening because 2026-09-07 操作员确认足迹是命令标题不是 stdout 尾巴。本 bullet 以 CONTEXT 为准，不改模型视野。
   - **Surface:** TUI
   - **Acceptance:** idle 成功 bash 有标题、无 stdout/`⎿` 尾巴；同帧 write/edit 预览仍在；失败 bash 仍是红标题 + 一行短错误。`bun test tests/tui/` 中落定/预览相关套件绿。
   - Status: [ ] pending

2. **[parallel] 思考只一条表面** — tag: `[implementation]`
   - **Inherits:** CONTEXT unit fold：落定只画一行 `思考了 N 秒`（有 thinking duration）；无秒数不画该行、不回落 `[思考]`；正文默认收，Ctrl+O 展开。进行中 `思考中…` + 末 ≤3 行 peek。
   - **Surface:** TUI
   - **Acceptance:** 同一 assistant 回合 idle 帧里 `思考了 N 秒` 至多出现一次；无秒数时既无该行也无全文思考；Ctrl+O 后思考正文可见。现有 `tests/tui/` 思考折叠套件按此合同绿。
   - Status: [ ] pending
   - [parallel]

3. **同一条工具只画一次** — tag: `[implementation]`
   - **Inherits:** CONTEXT settled appearance + unit fold：retract 只进计数；keep/accent/失败出独立标题；渲染只消费 slot。live 完成件不得与历史再叠一份；legacy 工具行不得再挂尾巴。
   - **Surface:** TUI
   - **Acceptance:** 一轮含成功 retract + 成功 bash 的 idle（或 running 但该件已落定）帧：retract 无标题无预览且计数含它；bash 标题只出现一次；画面无第二套完成工具行。`bun test tests/tui/` 折叠与 live tail 相关套件绿。
   - Status: [ ] pending
   - [blocks: T1, T2]

4. **[parallel] html 行帽与可读预览前缀** — tag: `[implementation]`
   - **Inherits:** CONTEXT fence display cap（围栏 32 行、溢出 `还有 N 行`）。html token 走同一行帽，不把 `<style>` 原文无界画出。预览装饰前缀必须是 Windows Terminal 不回退成 `|__` 的 ASCII。
   - **Surface:** TUI
   - **Acceptance:** 含大段 html/style 的 assistant 正文被截行并带溢出标记；结果预览溢出行不依赖 `⎿` 字形。`bun test tests/tui/` 中 markdown / 预览相关套件绿。
   - Status: [ ] pending
   - [parallel]

## Out of scope

- Web AgentCard / session-api activity 投影
- 把 bash 改成 retract class
- Ctrl+O 以外的展开快捷键
- 模型 tool_result 编码、meta 进模型

## Code review phase

全部 bullet 落地后对整轮 diff 做一次 `code-review`（Standards + Spec），再 `verification-before-completion`。
