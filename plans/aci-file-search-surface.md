# Plan: ACI 文件/搜索工具面升级

**Goal:** last-read 硬拒只罩非空 `write_file`；`edit_file` 沿用 ADR-0004 唯一精确 + 显式 `replace_all`（无长度门槛）；`read_file` 默认整文件；`grep` 默认只给路径并带齐出法/行窗/自带引擎。
**Approach:** 一张契约、两个 logical task（禁混 PR）。Task A 只动写闸、read 窗与账本。Task B 只动搜面（出法、解析、引擎同批）。说明书夹具或登记缺口跟各自 task。
**Spec link:** `specs/aci-file-search-surface.md`
**ACR:** all-yes（见 spec 内 5-line；2026-09-12 改口后 SC1/SC1b/SC2 已重写）
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion（落地粒度按操作员全局 commit 节）

**待写入：** (空 — 改口已回写 ADR-0084 / CONTEXT / ADR-0004 / ADR-0006)

## Tasks (ordered by dependency)

1. **会话 last-read 表 + 无 id 拒非空覆写** — tag: `[implementation]`
   - **Inherits:** D1：表按 conversationId **内存分桶、不落盘**；入账 = `read_file` 成功或白名单单文件 `bash` 成功；无 id 则已存在且 size>0 的 `write_file` fail-closed；禁止进程全局表。`edit_file` 不查表。不复用只读校验当入账。
   - **Surface:** harness ACI / session 工具上下文 + bash 命令抽 path
   - **Acceptance:** 无 conversationId 时非空文件 `write_file` 失败且字节不变；有 id 时 `read_file` 或白名单 `bash`（如 `cat path`）成功后表含该规范 path。`ls` / 管道不入表。进程重启后表空。`edit_file` 无 id 仍可按自证写入。
   - Status: [x] done — `last-read-ledger.ts`（`ledgerFor(undefined) === undefined` 是「无桶」判据本身）+ `bash-read-extract.ts` + `registry.ts` 接线；`9497ae8e` 起，`8d23aa23` / `8415c08b` 收窄假阳性。测：`last-read-ledger.test.ts` 11 / `write-file-last-read.test.ts` 15 / `bash-last-read.test.ts` 13 全绿；`bash-read-extract.test.ts` 39（提交态计）。
   - **Follow-up（本分支补）:** 子代理侧原本**无桶**（worker 装配漏传 `conversationId`）→ 同回合读后覆写永久被拒。已修 `b322aa6a`（`worker.ts` + `worker-last-read-ledger.test.ts` 8 条），走真实装配路径，非直调 handler。

2. **write_file 非空未读硬拒、新建/空文件免检** — tag: `[implementation]`
   - **Inherits:** SC3；size==0 免检。
   - **Surface:** harness ACI `write_file`
   - **Acceptance:** 已存在 size>0 未读失败；不存在的 path 与空文件写入成功。
   - [blocks: T1]
   - Status: [x] done — `write-file.ts:281` `assertLastRead` 四条 EXIT（host 缺席 → 闸整体不生效 / stat 失败不制造新拒绝面 / 新建或 size==0 免检 / 账上有 → 放行），判据用 `stat().size` 不用 best-effort 降级的 `oldContent`。typed `LastReadRequiredError`（`kind = last_read_required`）落 `fb9b2a86`。测：`write-file-last-read.test.ts` 15 条，`write-file.test.ts` / `write-file-iknow.test.ts` 现有套件全绿。

3. **edit_file 无新行为** — tag: `[implementation]`
   - **Inherits:** D1b / SC2；沿用 ADR-0004。否决短锚禁 `replace_all`。
   - **Surface:** harness ACI `edit_file`
   - **Acceptance:** 不改 handler。现有 `edit-file.test.ts` 保持绿（多处拒绝、任意长度 `replace_all`）。
   - Status: [x] n/a — 无 diff
   - [parallel] with T1

4. **read_file 默认整文件** — tag: `[implementation]`
   - **Inherits:** D1c / SC13。
   - **Surface:** harness ACI `read_file`
   - **Acceptance:** 不传 `limit` 从 offset 起最多 16000 code point，未完则正文续读提示（不得默认 200/2000 行）。显式 `limit` 硬顶 2000。`>1MB` 仍拒。不改 pad roster 的独立 200 窗。
   - Status: [x] done — `read-file.ts:40` `MAX_READ_CODE_POINTS = 16_000` / `read-file.ts:32` `MAX_LIMIT = 2000`；不写 `limit` → `undefined` 走整读路径（`read-file.ts:337`）。`133c4364` 补单行截断显式化 + 页预算加 UTF-16 闸，`81f36609` 补显式 `limit` 路径同一对页预算（ADR-0006 Decision 4）。测：`read-file.test.ts` 36 / `read-file-profile.test.ts` 5，全绿。
   - [parallel] with T1

5. **写闸并发** — tag: `[implementation]`
   - **Inherits:** SC1b（只罩 write）。
   - **Surface:** harness ACI `write_file` + 账本
   - **Acceptance:** 同 conversation 同非空 path 未读时并行 write 均失败；有读后并行覆写不丢表、无隐式全局表。
   - [blocks: T2]
   - Status: [x] done — 三条在 `write-file-last-read.test.ts:261-355`（未读并行均拒 / 有读并行均执行且表未清空 / 无 id 并行不共享隐式全局表，`ledger.size() === 0`）。
   - **未结（不在本切片）:** `write_file-last-read.test.ts:321` 的「最终内容必是两次之一」在 2026-09-12 证据跑里失败过一次（实测得 `"first\n\n"`）。直调 handler 放大样本 300 次复现 8 次——两次并发 `writeFile` 的全量覆写会撕裂，**是测试断言在全量覆写语义下的假前提**，不是闸的问题（`write_file` 声明 `isConcurrencySafe: false`，引擎经 `partitionConcurrencyWaves` 串行化，生产面到不了这个交错）。未在本分支修：该文件非本 task 范围。

6. **写/读说明书** — tag: `[implementation]`
   - **Inherits:** D7 / prompt-development：先夹具或登记缺口。
   - **Surface:** `read_file` / `edit_file` / `write_file` description 与失败文案
   - **Acceptance:** D9/description 闸仍绿；本面补轨迹集或该 commit 登记缺口。
   - [blocks: T2, T4]
   - Status: [x] done — 走「登记缺口」臂：`3a52f397` 在 `docs/guides/prompt-development.md:46` 登记 `grep` / `read_file` / `edit_file` / `write_file` 四件**不建**轨迹集（D7 一次性结论：contract-statement 确定性，非工具选型分歧，由 D9 STATIC 锁 + schema 断言覆盖）。`write_file` / `read_file` description 已在 `9497ae8e` 随闸改写、`81f36609` 随页预算改写。测：`d9-description-guard.test.ts` 21 条全绿。

---

7. **安装根钉死搜引擎** — tag: `[implementation]`
   - **Inherits:** D6 / SC9：只 exec 安装根二进制；起不来 Node 全语义；不 PATH `rg`。
   - **Surface:** harness ACI `grep` + 安装/发版脚本
   - **Acceptance:** 生产路径不 `which rg`；注入缺失二进制走 Node 且行为仍满足 D2–D5。
   - Status: [ ] pending
   - [parallel] with T1–T6（禁写入同一 PR）

8. **默认 paths + content/count + head_limit 50** — tag: `[implementation]`
   - **Inherits:** D2 / D3；`head_limit` 默认 50 硬顶 2000；不叫 `limit` / `grep_limit`。
   - **Surface:** harness ACI `grep`
   - **Acceptance:** SC4 / SC5。现有 `tests/harness/aci/tools/grep.test.ts` 更新后绿。schema 无 `limit` 条数字段。
   - [blocks: T7]
   - Status: [ ] pending

9. **稳定排序、parser、附近几行** — tag: `[implementation]`
   - **Inherits:** D3；`:` / `-` / `--` 分列；排序在切片前。
   - **Surface:** harness ACI `grep` 解析/投影（须拆函数，SC12）
   - **Acceptance:** SC6。complexity-anti-drift 门过。
   - [blocks: T8]
   - Status: [ ] pending

10. **结果名单分页** — tag: `[implementation]`
    - **Inherits:** D3 `offset`；过头回执精确 `No entries at this offset`。
    - **Surface:** harness ACI `grep`
    - **Acceptance:** SC7。
    - [blocks: T9]
    - Status: [ ] pending

11. **glob + type 归因** — tag: `[implementation]`
    - **Inherits:** D4 / SC10
    - **Surface:** harness ACI `grep`
    - **Acceptance:** 文件名模式生效；未知 type 与坏正则两种 typed 错误、文案不混。
    - [blocks: T8]
    - Status: [ ] pending
    - [parallel] with T9–T10 after T8

12. **行窗（附近过滤）** — tag: `[implementation]`

- **Inherits:** D5；不做裸跨行正则。是过滤不是展示。
- **Surface:** harness ACI `grep`
- **Acceptance:** SC8。Node 与安装根引擎两条后端都满足。
- **实测：** Task B 落地后跑真实轨迹，看模型会不会带 `also`、过滤是否减噪。无效或误伤写入本计划收尾汇报（勿只记 Not run）。
- [blocks: T9]
- Status: [ ] pending

13. **搜面说明书** — tag: `[implementation]`
    - **Inherits:** D7
    - **Surface:** `grep` description / schema
    - **Acceptance:** D9 闸绿；补轨迹集或登记缺口。
    - [blocks: T8]
    - Status: [ ] pending

## architecture-change-reviewer

```
bounded-context-guardian: yes — 落在 harness ACI read/edit/write/grep + 安装根；TUI/CI 装引擎在 Out。
defensive-contract-validator: yes — 空/负/溢/并发（SC1b 只罩 write）/异常（SC10、D6）五类有 SC。
error-handling-enforcer: yes — 无 conversationId 时非空 write fail-closed；edit 不因无 id 拒；D6 起不来唯一 EXIT = Node 全语义。
complexity-anti-drift: yes — Task B 按 flag/argv/解析/计数/命中拆。
minimal-change-verifier: yes — 两 logical task、禁混 PR。
```

## 收尾须提（不做本切片）

- **裸 `multiline`**：本切片不上。Task B 实测后若跨行结构（拆行函数头、块锚）经常对不上，写入本计划汇报再开票，不要静默加开关。
- **D5 `also` 过滤**：同上，无效或误伤也写入汇报。
