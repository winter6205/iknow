# Plan: 状态栏（模型向现势，追加注入）

**Goal:** 每次调用模型前，把代码算出的现势（有未勾项才带 todo 段 + `last_tool`）以 user 消息追加进 `messages`；TUI 只读同一份快照。
**Approach:** 先做出与 IO 无关的现势快照并在 loop 里、每次 `adapter.step` 前追加（todo 段按未勾项在场门控）；再把静态读规则写进 soul，并在 `todo_write` description 加一句可操作的跳过条件；最后 TUI 订阅读口。不改 add/check/list 语义、不新开注入缝、不把栏写进 `deps.system`。写入口硬顶（条数/长度/禁换行）不绑本轮，见 [#648](https://github.com/winter6205/iknow/issues/648)。
**Spec link:** 无 spec（gh-22 skip-spec：契约以 [ADR-0028](../docs/adr/0028-agent-status-bar-append.md) + CONTEXT「状态栏」为准）。
**Tracker:** GitHub 主路径（`ready-for-agent` + 原生 blocking）。[T1 #645](https://github.com/winter6205/iknow/issues/645) blocks [T2 #646](https://github.com/winter6205/iknow/issues/646) · [T3 #647](https://github.com/winter6205/iknow/issues/647)。写入口治理停车位 [#648](https://github.com/winter6205/iknow/issues/648)（无 `ready-for-agent`，不挡本轮）。本文件与 ADR-0028 / CONTEXT「状态栏」在 worktree `agent-status-bar`，合进 `master` 后再跑 agent。
**ACR:** 全 yes（见下）

```
bounded-context-guardian: yes — 快照与注入留在 harness loop；TUI 只订阅读口；不新开限界上下文
defensive-contract-validator: yes — 缺席/空/全勾→todo 段缺席；有未勾→只投影 `- [ ]`；本回合无工具→last_tool=idle；ask / worker 不注入
error-handling-enforcer: yes — 读 todos.md 失败→当无 todo 段，不抛进模型回合；不把栏接入 verify
complexity-anti-drift: yes — 追加缝一次、快照纯函数、TUI 只读；不改 add/check/list
minimal-change-verifier: yes — 3 bullet = 3 commit；禁把账本改版绑进本轮（条数/长度/禁换行 → #648）
```

**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

## 待写入（persist 段）

（空 — 词条「状态栏」与 ADR-0028 已在本 worktree 落盘，合进 master 时一并带上。）

## Tasks (ordered by dependency)

Each numbered item is one tracer bullet: one vertical-slice outcome, one tag, one commit, headroom for the implementer.

1. **T1 现势快照 + 每次 step 前追加 user 栏** — tag: `[implementation]`
   - **Inherits:** ADR-0028：每次即将调用模型前以 user 消息追加（含同一用户回合内 tool loop）；旧栏保留、不 splice、不写 `deps.system`。字段：`last_tool`（上一跳刚完成的工具名；本回合尚未跑过工具则为 idle）+ 仅当存在 `- [ ]` 时才带的 todo 段（只投影未勾行）。CONTEXT：user 角色、接 `messages` 尾；空槽不广告。
   - **Surface:** `src/harness`（loop 在 `adapter.step` 之前；session 的 `todos.md` 只读）。
   - **Acceptance:** ① stub 模型下，同一用户回合内两次 step（一次无工具、一次 tool 后再 step）各在当时 `messages` 末尾多一条 user 栏，历史栏仍在。② 无 `todos.md` / 空文件 / 只有 `- [x]` → 栏内无 todo 段且回合不失败。③ 有未勾项 → 栏内 todo 段仅含那些 `- [ ]` 行，不含已勾行。④ 同一跳 `check` 掉最后一条未勾后再 step → **新栏**才去掉 todo 段（当跳开始前注入的旧栏不变）。⑤ 第一跳 `last_tool=idle`；工具成功后再 step → `last_tool` 为该工具名（一批多个工具则取该批最后一个成功名）。⑥ compact 若在本跳发生，栏追加在 compact 之后，请求里能看到最新一条栏。⑦ `ask` 与 worker 路径不追加栏。⑧ 既有 loop 停止语义测试不降级。
   - Status: [x] done — commit 7e96189a（#645）

2. **T2 system 前缀一句读规则 + todo_write 跳过条件** — tag: `[implementation]`
   - **Inherits:** ADR-0028：读规则写进系统提示词一次，跨回合字节不变；不印在每条栏上。栏内不含政策散文。跳过条件只写 tool description：下一步就能做完用户这句、不需要跨多轮盯进度时不要 `add`；正面仍是多步骤跨多轮才建清单。无「简单任务」字样。
   - **Surface:** `src/harness/identity`（soul / 装配进 `deps.system` 的静态段）；`todo_write` description 仅加一句（不改 handler / schema）。
   - **Acceptance:** ① 装配后的 system 文本含一句稳定读法（以最后一条状态栏为准；todo 段缺席即当前无未勾项）。② 相邻两轮若身份文件与 skills/MCP 快照不变，该句字节级相同。③ 栏消息本身不含该读法、不含跳过条件。④ `todo_write` description 含上述跳过条件且无「简单任务」禁令。⑤ 既有 identity 装配测试与 todo_write 描述测试更新后全绿。
   - [blocks: T1]
   - Status: [x] done — commit b1c077c8（#646）

3. **T3 TUI 只读最新现势** — tag: `[implementation]` `[parallel]`
   - **Inherits:** ADR-0028：UI 只读最新一份现势，不另建账本；in-flight 只给 TUI，不进模型栏。CONTEXT：TUI 是副产物。
   - **Note（review 追认）:** 显示侧最多投影 4 行未勾项，溢出以 footer 披露精确计数——#648 写入口硬顶落地前的显示侧防线，chrome 行账不随账本无界而无界。
   - **Surface:** `src/tui`（只订阅读口；不写 `todos.md`）。
   - **Acceptance:** ① 主 HITL 会话进行中，TUI 能显示与即将送进模型的同一份现势：有未勾项则显示那些未勾项 + `last_tool`；无未勾项则不显示 todo 清单，仍显示 `last_tool`。② 不出现第二份 todo 状态源（例如另缓存一份与文件不一致的清单）。③ in-flight 若展示，与栏字段分开，不写进模型栏。④ 既有 ContextBar / 会话测试不因本 bullet 失败。
   - [blocks: T1]
   - Status: [x] done — commit 32a71827（#647）

## Out of scope（本轮不做）

账本写入口硬顶（未勾条数上限、title 收到 80–120、`item` 禁换行、可选的每回合 `add` 配额）→ [#648](https://github.com/winter6205/iknow/issues/648)。栏合入并看到实际用法后再做；不要在 T1–T3 关掉时把这张票当已完成。

仍否决（不是延期）：verify 读 todos、按「简单任务」藏工具、宿主代写清单。

## Code review phase

三 bullet 全部落地后，整轮改动过一次 end-of-round code review，再收尾。
