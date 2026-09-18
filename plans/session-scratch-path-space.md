# Plan: session scratch as first-class path root (加强版 A)

**Goal:** 模型用 `read_file` / 写工具碰到会话 tmp 时，走同一条宿主路径身份：能读、拒 `/tmp` 时看见展开后的 `$TMPDIR`，成功回执抄得到 canonical 路径；guest Linux `/tmp` 仍不 alias。
**Approach:** 加深已有 `resolveWithinRoot` / `tmpWriteRoot` / `resolveSessionFenceTmp`，不新开 bounded context，不重开 ADR-0092 bind。先让 `read_file` 与写工具共用会话 tmp 根（不再靠 `~/.iknow` extraReadRoots 碰巧放行）；再劈开 path-outside 文案的 EXIT（交付越界 vs OS `/tmp`）；近邻提示与写回执是同一条身份上的可见面。不改 soul、不把草稿拷进 `taskRoot`、不修邻仓只读（#972）。
**Spec link:** 无独立 spec（本轮跳过 spec-driven-development）。合同来自 ADR-0092、`docs/CONTEXT.md`「会话 tmp」、logicsync 加强版 A。
**ACR:** all-yes（2026-09-18 architecture-change-reviewer-agent）
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion（落地粒度：操作者全局提交段）

## 待写入

无。沿用 CONTEXT「会话 tmp」与 ADR-0092；不修订 bind `/tmp`。

## ACR

```
bounded-context-guardian: yes — stays in `src/harness/aci/tools` (`helpers.ts` `resolveWithinRoot`/`assertContained`, `read-file.ts` `computeExtraReadRoots` missing pad vs `write-file.ts:152-162` `tmpWriteRoot`); ADR-0092 + CONTEXT「会话 tmp」already name taskRoot ∪ session tmp; no new context, no `/tmp` alias
input-contract-tests: yes — `tests/harness/aci/tools/helpers.test.ts:231-236` already maps empty/negative/overflow/concurrent/exception on path-outside copy; `write-file-fence-tmp.test.ts` empty/negative/SC4 no-alias; plan extends those plus existing extra-root read tests
error-handling-enforcer: yes — containment stays `ToolExecutionError` (`helpers.ts:188-190`); named branches are expand `$TMPDIR` pad and drop taskRoot-retry when target looks like OS `/tmp`/scratch, optional near-miss only if `<sessionScratch>/X` exists
complexity-anti-drift: yes — deepen existing `resolveWithinRoot` / `assertContained` / `computeExtraReadRoots` plus receipt `displayPath` (`write-file.ts:258`); no new module or one-function whole-flow intent
minimal-change-verifier: yes — one containment-identity task (scratch as first-class read root + hint/receipts); out of scope is guest `/tmp` rebind, soul rewrite, `.recon` copy, issue #972
OVERALL: PASS — hand to writing-plans
```

**affects:** `src/harness/aci/tools/helpers.ts` `src/harness/aci/tools/read-file.ts` `src/harness/aci/tools/write-file.ts` `src/harness/aci/tools/edit-file.ts` `src/harness/aci/tools/registry.ts` `tests/harness/aci/tools/helpers.test.ts` `tests/harness/aci/tools/write-file-fence-tmp.test.ts`

## Tasks (ordered by dependency)

1. **`read_file` 以会话 tmp 为一等读根** — tag: `[implementation]`
   - **Inherits:** ADR-0092：会话 tmp 是独立 containment 根，宿主真路径，由 `$TMPDIR` 指向；`write_file` 已用 `resolveSessionFenceTmp` + `tmpWriteRoot`。CONTEXT：会话 tmp 不是交付落点。guest `/tmp` 不 alias。
   - **Surface:** ACI `read_file` 工厂与 registry 装配（与写工具同一套 `tmpDir` / `projectDir` / `conversationId` 解析）
   - **Acceptance:** 工厂接到与写工具相同的会话 tmp 解析后，`read_file` 能读垫底上已有文件，即使该垫底不在 `~/.iknow` extraReadRoots 下；`/tmp/...` 仍 `ToolExecutionError` 且不写入垫底。既有 profile / identity-root extra 读面不回退。现有 `tests/harness/aci/tools/write-file-fence-tmp.test.ts` 的 SC4 不 alias 仍绿。
   - Status: [ ] pending

2. **[parallel] path-outside 文案按目标劈 EXIT** — tag: `[implementation]`
   - **Inherits:** ADR-0037 §4 (e) / helpers T3：交付路径越界时文案仍含 `current write root` 与活 `taskRoot`，模型可用相对路径重试。ADR-0092 SC4：guest `/tmp/...` 必须可观察拒绝。加强版 A：OS `/tmp`（或明显草稿误拼）拒绝时展开本身份会话 tmp 绝对路径，**不**再说「Retry with a path relative to the taskRoot」。
   - **Surface:** `resolveWithinRoot` / `assertContained`（ACI helpers）
   - **Acceptance:** 非 `/tmp` 的越界路径：既有 `tests/harness/aci/tools/helpers.test.ts` T3 五类（empty / negative / overflow / concurrent / exception）仍要求文案含 `current write root`。`/tmp/...` 拒绝：文案含垫底绝对路径；不含「Retry with a path relative to the taskRoot」；文件未落到垫底（与 `write-file-fence-tmp.test.ts` SC4 同观察）。失败路径仍是 `ToolExecutionError`，分支有 EXIT 注释。改的是工具错误回执，不靠加长 soul；若动 `FENCE_WRITE_GUIDANCE` 则按 `docs/guides/prompt-development.md` 补夹具或登记缺口。
   - Status: [ ] pending
   - [parallel]

3. **拒 `/tmp/X` 且垫底已有 `X` 时给出近邻路径** — tag: `[implementation]`
   - **Inherits:** 仍不 alias（ADR-0092）。加强版 A：仅当 `<sessionScratch>/X` **已经存在** 时，错误里带上那条 canonical 宿主路径；不存在则只走 T2 的展开 `$TMPDIR`，不暗示文件在。
   - **Surface:** 同上 containment 拒绝面（与 T2 同一解析）
   - **Acceptance:** 垫底有 `ok.txt`、请求 `/tmp/ok.txt` → 拒绝且文案含垫底上该文件的绝对路径，垫底内容不变。垫底无该文件 → 拒绝且不把不存在的路径写成「去读这个文件」。无垫底解析结果时行为与 T2 相同。
   - Status: [ ] pending
   - [blocks: T2]

4. **[parallel] 写工具回执对会话 tmp 给出 canonical 宿主路径** — tag: `[implementation]`
   - **Inherits:** 可写集 = 活 `taskRoot` ∪ 会话 tmp。`displayPath` 今日相对 `taskRoot` 计算；写在垫底上会得到 `../` 链，模型会抄错。交付写仍可相对 `taskRoot`。
   - **Surface:** `write_file` / `edit_file` 成功回执
   - **Acceptance:** 写入会话 tmp 后，回执字符串含该文件的绝对宿主路径（或与 `$TMPDIR` 垫底相对且可拼接回绝对路径），不含把垫底假装成 `taskRoot` 相对路径。相对 `taskRoot` 的交付写回执形态不回退。`write-file-fence-tmp.test.ts` 落地断言仍绿。
   - Status: [ ] pending
   - [parallel]

## Out of scope

- 把 guest `/tmp` bind 或 alias 成会话 tmp（方案 B / 修订 ADR-0092）
- 加长 soul / usage 当主修复
- 把 scratch 拷进 worktree `.recon/` 当正规通道
- 主进程读邻仓过严（GitHub #972）
- `grep` / `glob` 扩到会话 tmp（本任务不需要搜索面）

## Code review phase

全部 tracer 落地后跑一轮 `code-review`；`GATE: BLOCKED` 则下一槽 `review-report-repair`，再 `verification-before-completion`。
