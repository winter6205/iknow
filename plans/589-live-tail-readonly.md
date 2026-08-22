# Plan: #589 live tail 只钉 running（只读完成行离开尾巴）

**Goal:** 长 turn 连续 `read_file` / `grep`（及同类只读）时，贴底视口不再被已完成工具行刷满；用户问题与流式草稿仍能与输入框 / context-bar / spinner 同屏。
**Approach:** 结束折叠保持现状。进行中不把成功只读调用留在 `liveToolRuns` 尾巴；失败行保持可见。不把完成态写进 `session.messages`（turn 结束 `loadSessionFile` 仍是历史 SSOT）。
**Spec link:** 无独立 spec；契约来自 [issue #589](https://github.com/winter6205/iknow/issues/589) + `specs/146-tui.md` 滚动纪律（sticky 贴底，禁行账数学）。
**Tracker:** GitHub #589（已存在的实施 issue）。本会话在 `worktree-589-live-tail-readonly` 落地，不另拆 `ready-for-agent` 子 issue（避免与用户「本轮做完」冲突；依赖边写在下方 Tasks）。
**待写入:** 无（不新增 CONTEXT 词条）。
**ACR:** all-yes（见下）。
**Per-ticket loop (all bullets):** tdd → typecheck+相关 tests → one commit on `worktree-589-live-tail-readonly`。整轮结束后主会话做 code-review + verification-before-completion。

**为何 3 个 bullet：** 先钉契约（哪些工具离开尾巴），再改 reducer 真源，再用渲染面证明尾巴不再堆只读完成行。不可再拆文件树配方。

## Affected files (planned)

- `src/tui/live-tool-state.ts`（及同模块并列纯函数；文件名留给实现）
- `tests/tui/live-tool-state.test.ts`
- `src/tui/live-tool-preview.tsx` 和/或 `src/tui/chat-view.tsx`（仅当 reducer 之外仍会画出完成只读行）
- `tests/tui/live-tool-preview.test.tsx` 和/或 `tests/tui/chat-view-scroll.test.tsx`

## 0. ACR 5-verdict

- bounded-context-guardian: **yes** — 只动 TUI live-tool 展示状态；不改 HarnessStreamEvent、ACI、session store。
- defensive-contract-validator: **yes** — 覆盖 empty prev / 失败不丢 / 成功只读离开 / 非只读完成仍留 / 同 id 重复 post 幂等；无共享可变并发；无新 catch。
- error-handling-enforcer: **yes** — 不新增吞异常；未匹配 `post_tool_use` 仍 `return prev`（#578）。
- complexity-anti-drift: **yes** — 完成态去留集中在一处派生或 reducer 一步；ChatView 不复制工具名单。
- minimal-change-verifier: **yes** — 单一逻辑：进行中尾巴去掉成功只读；不混 write 预览、不改结束折叠、不改 max tokens。

**OVERALL: PASS**

## Settled (inherits)

- 进行中尾巴保留：`status === "running"`，以及 `status === "failed"`（失败不进结束计数、保持可见 — 本轮只保证 live 仍渲染失败行）。
- 成功完成且属于只读探测族（至少 `read_file`、`grep`；`glob` 与它们同类则一并离开）→ 立刻离开 `liveToolRuns`，不再占贴底尾巴。
- 成功 `write_file` / `edit_file` 完成态仍可留在 live（与 write 折叠预览同批，本 issue 不收口）。
- `bash` 等非只读成功完成：本轮不强制离开（issue 点名 read/grep）。
- 可选「最近 K 条成功」：本轮 K=0（只读成功不留尾巴）。
- 不在 turn 中途写入 `session.messages`；历史仍在 turn 结束加载。
- `activeToolNameOf` 仍只看 running；输入框 / context-bar / spinner 钉底不变。

## Tasks (ordered by dependency)

1. **钉只读离开尾巴的契约** — tag: `[decision]`
   - **Inherits:** 上节 Settled：成功 read/grep（及同类 glob）离开 live；failed 留下；running 留下；不写 messages。
   - **Surface:** 本 plan 的 Settled（本 bullet 的提交可只含 plan，若实现同一分支则与 T2 分 commit）
   - **Acceptance:** Settled 可被测试写成可判定谓词（工具名集合 + status），无第三种「暂时留 K 条」口径。
   - Status: [x] done（Settled 已写入本 plan）

2. **post_tool_use 后 live 数组不再堆成功只读** — tag: `[implementation]`
   - **Inherits:** T1：ok + 只读族 → 条目从 live 数组消失；failed / running / 非只读 ok 仍在。
   - **Surface:** TUI live-tool-state
   - **Acceptance:** 纯函数单测可 demo：空 prev 未匹配 post 仍不 append（#578）；start+ok `read_file`/`grep` → length 0；同序列 `failed` `read_file` → 仍 1 条 failed；`write_file` ok → 仍 1 条 ok；夹在中间的 running 不被误删。`npx vitest run`（或仓库既有 bun:test 入口）覆盖该测文件全绿。
   - Status: [x] done
   - [blocks: T1]

3. **贴底尾巴渲染不再列出已离开的只读完成行** — tag: `[implementation]`
   - **Inherits:** T2 为真源；渲染不得另维护一份工具名单。
   - **Surface:** TUI chat-view / live-tool-preview
   - **Acceptance:** 给 ChatView（或 preview 行账）一串「20 条 read_file ok + 1 条 running」时，输出不含那 20 条完成文案，仍含 running 状态行；一条 failed grep 仍可见。既有 live-tool-preview / chat-view-scroll 测不倒退。
   - Status: [x] done
   - [blocks: T2]

## Out of scope

- 结束折叠文案（`思考了 N 秒 · read_file × N`）。
- write/edit 完成态截断预览（既有 plan）。
- Web UI 工具卡。
- 进行中把 tool_result 插入 `session.messages`。
- 最近 K 条成功只读留尾巴。
