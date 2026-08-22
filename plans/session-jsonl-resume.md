# Plan: 会话 JSONL 续跑

**Goal:** 会话历史改为单文件 JSONL；边跑边写、半截 turn 按 `process` 补洞、rewind fork 留分支且头指针落盘。
**Approach:** 先 expand（新旧形态并存）再 migrate 旧 JSON，再接 mid-turn commit 与补洞，最后 rewind 从截断改为改 head。Loop 零 IO，host 注入钩子。
**Spec link:** `specs/session-jsonl-resume.md`（grilling Resolution 五段已写入该 spec）
**Tracker:** GitHub — spec [会话 JSONL 续跑](https://github.com/winter6205/iknow/issues/617)；T1 [#618](https://github.com/winter6205/iknow/issues/618)；T2 [#619](https://github.com/winter6205/iknow/issues/619) blocked-by T1；T3 [#620](https://github.com/winter6205/iknow/issues/620) blocked-by T1；T4 [#621](https://github.com/winter6205/iknow/issues/621) blocked-by T1；T5 [#622](https://github.com/winter6205/iknow/issues/622) blocked-by T2。来源提案 [#615](https://github.com/winter6205/iknow/issues/615)。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → verification-before-completion → one commit on the ticket branch（整轮改完再跑 code-review，中途 WIP 不重复）

> Contradicts `specs/120-session-persistence.md` Q1（「本期不迁 JSONL」）— worth reopening because 那是第一轮整 JSON 脚手架；#615 grilling 已改为对齐 Claude Code 流水账。当时声称的 ADR-0007 文件不存在；新决策见 ADR-0027。

## ACR

bounded-context-guardian: yes — JSONL 与 rewind 头在 session-api/store；loop-engine 只吃 commit 钩子、零 IO；trace JSONL 仍 traceserver/harness/trace；记忆层不碰
defensive-contract-validator: yes — spec Testing Decisions 覆盖 empty / negative / overflow / concurrent / exception
error-handling-enforcer: yes — 未配对 tool_use 的 EXIT 是 process closeout；坏末行 load 有命名 EXIT
complexity-anti-drift: yes — log 与 rewind 投影分开；补洞复用 encodeToolResults
minimal-change-verifier: yes — 1 个逻辑任务拆成下列 tracer bullets 各 1 commit；温度/记忆/占坑表不进本计划

## Tasks (ordered by dependency)

1. **JSONL 形态与旧 JSON 并存可读** — tag: `[implementation]`
   - **Inherits:** spec D1–D2、D7 的 load 半边：新形态有 id/parent/head；旧 `SessionFileV1` 仍能 load；#120 Q6 入口仍走同一 store。ADR-0027。
   - **Surface:** `session-api` store
   - **Acceptance:** 新会话可写成 JSONL 并 load 回同一 head transcript；旧 JSON fixture load 不炸且能投影为当前 messages；trace JSONL 路径无改
   - Status: [ ] pending

2. **旧 JSON 在下一次 save 迁成 JSONL** — tag: `[implementation]`
   - **Inherits:** spec D7：load 不炸；随后 save 为 JSONL；迁后 API 合法前缀与迁前 messages 等价。
   - **Surface:** `session-api` store
   - **Acceptance:** v5 JSON fixture → load → save → 盘上是 JSONL；再 load 的当前头与原 messages 在发给模型的前缀上一致
   - Status: [ ] pending
   - [blocks: T1]

3. **turn 内 commit：assistant 随后每个工具一条** — tag: `[implementation]`
   - **Inherits:** spec D4、Solution：模型结束后 append assistant；`runOne` 返回后立刻 append 该 tool_result；harness 零 IO（host 注入钩子）；serialize 队列不得绕开。
   - **Surface:** `session-api` hub / chat-session 注入；`src/harness` 只加 deps 钩子
   - **Acceptance:** stub 两工具串行，第一个结果已 commit 后中断 → 盘上有第一条、无第二条；loop-engine 源码无直接 store.save / writeFile
   - Status: [ ] pending
   - [blocks: T1]

4. **load/resume 补未配对 tool_use（process closeout）** — tag: `[implementation]`
   - **Inherits:** spec D5–D6：`encodeToolResults` + `execution_failed`/`process`；不加 `Interrupted by user.`；mutating 工具文案含先检查再重跑；只读工具不含该句；补后不得把孤儿 tool_use 送给 adapter。
   - **Surface:** `session-api` load 投影 + 现有 adapter encoder；必要时 harness 只读复用 encoder
   - **Acceptance:** 盘上孤立 tool_use → 组 API messages 已配对；`process` 路径无 system 中断句；`cancelled` 路径仍有；bash/edit_file/write_file 的 process 文本含检查指令，grep 类不含
   - Status: [ ] pending
   - [blocks: T1]
   - [parallel] 与 T3 可并行（都只依赖 T1）

5. **rewind 改 head、旧链保留** — tag: `[implementation]`
   - **Inherits:** spec Solution + `checkpoint-rewind.md` UX：锚点仍是用户消息边界；空态文案不变；**不再** `rewindFile` 截断。head 落盘；重启后仍停在退到的头。
   - **Surface:** `session-api` rewind + TUI/Web 已有 picker 消费同一 bridge
   - **Acceptance:** rewind 到更早锚点 → reload 后 head 仍是该锚点；被跳过事件仍在同一 JSONL；TUI `/rewind` 与空态行为与 spec UX 一致
   - Status: [ ] pending
   - [blocks: T2]

## 待写入

（已 flush：CONTEXT `session transcript` / `rewind head` / `in-flight closeout` 扩 `process`；ADR-0027；`specs/README.md` + `checkpoint-rewind.md` 头注。清单空 → persist skip。）
