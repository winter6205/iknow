# Plan: 可写合同与 hard-wall 层退休

**Goal:** 合法耐久写能落到活 `taskRoot`（含子代理），hard-wall 不再用语法补丁当沙箱。
**Approach:** ADR-0068 已落盘。先改 hard-wall 匹配与文案，再拆 spawn `sandboxRoot` 错误类，最后改写工具越界文案。不改 prompt 当主修复；不做旁路草稿纸。
**Spec link:** `specs/mutate-write-contract.md`
**ACR:** PASS（见下方五维）
**Per-ticket loop (all bullets):** tdd → typecheck+tests → verification-before-completion → one commit on the ticket branch；全部 bullet 落地后再跑一轮 `code-review`。

**Tracker:** 本地 markdown（无 GitHub issue）。范围外方向写在 spec「后续（本 spec 不做）」，不另开 tracker。

## ACR

```
bounded-context-guardian: yes — stays in existing harness seams (`hard-walls.ts`, `aci/tools/helpers.ts`, `subagent/manager.ts`, `errors.ts`) plus ADR/CONTEXT persist; no new layer dirs; ADR-0040 same write root.
defensive-contract-validator: yes — spec 「输入五类（S2）」tables A+B allocate empty/negative/overflow/concurrent (`// N/A: pure`) /exception; B pins `tests/subagent/sandbox-root.test.ts` for SC6/7.
error-handling-enforcer: yes — SC3 pattern-id deny; SC4 `/tmp` durable reject; SC5 missing subdir ≠ outside; table B exception splits ENOENT copy vs outside vs non-ENOENT rethrow.
complexity-anti-drift: yes — declared as per-segment scan + write-root copy + lexical prefix taxonomy in those existing functions, not one god-flow.
minimal-change-verifier: yes — one session 方案 A write-contract (spec Changes); persist is the same decision, not a second feature.
```

## 待写入

（空 — ADR-0068 与 CONTEXT `hard-wall` 已在 specify persist flush。）

## Tasks (ordered by dependency)

1. **hard-wall 按段扫描，换行与 format 子串退役** — tag: `[implementation]`
   - **Inherits:** ADR-0068；spec SC1–3、SC8；输入五类表 A
   - **Surface:** `src/harness/permission`（hard-walls）+ 既有 permission 单测
   - **Acceptance:** 表 A 五类可观察；`echo a\nls` 类不 deny；段内 `rm -rf` 仍 deny；deny reason 带 pattern id；`text-transform` 不因 `format` 子串 deny
   - Status: [ ] pending

2. **sandboxRoot 词法包含 vs 不存在 vs 越界** — tag: `[implementation]`
   - **Inherits:** spec SC6–7；输入五类表 B；省略字段继承父根
   - **Surface:** `src/harness/subagent`（manager 单点校验）+ `src/harness/errors` + `tests/subagent/sandbox-root.test.ts`
   - **Acceptance:** 父根下尚未存在的子路径不再报 outside；`/tmp` 或父根外仍拒；省略 `sandboxRoot` 继承父根；非 ENOENT I/O 仍 rethrow
   - Status: [ ] pending
   - [parallel]

3. **耐久写越界文案带活写根** — tag: `[implementation]`
   - **Inherits:** spec SC4–5；ADR-0068 耐久写只落 `taskRoot`；`/tmp` 不是交付落点
   - **Surface:** ACI 写工具路径解析（既有 `path outside workspace` 缝）
   - **Acceptance:** `write_file` 到 `/tmp` 仍失败；文案含当前 `taskRoot` 且说明 `/tmp` 非交付落点；相对 `taskRoot` 的合法写成功（父与子代理同一规则）
   - Status: [ ] pending
   - [blocks: T1]
