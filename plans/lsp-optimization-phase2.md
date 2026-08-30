# Plan: LSP 优化二期（续 plans/lsp-optimization.md 一轮；spec 302 遗留收口）

**范围裁决（user 2026-08-30）**：除 Go/Rust server 外全部实施。共 11 项，分 3 批。
工作树：`.iknow/worktrees/lsp-optimization`（一轮已提交 5b2b43c0）。

## Batch 1 — 诊断闭环 + 可用性基建

- **B1 编辑后诊断收敛**：client.ts diagStore 从 `Map<uri, items>` 升级为
  `Map<uri, { items, pushVersion? }>`（publishDiagnostics params.version 透传，
  缺省 undefined）。`notifyChange` 维护 per-uri didChange version（已有）；
  `lsp_diagnostics` 等待语义升级：等待目标 = pushVersion ≥ 当前 didChange
  version（编辑后必须等到**新**诊断）或首推到达（未编辑过）或 2s deadline。
  `getDiagnostics(uri)` 签名保留（兼容），新增 `getDiagnosticsEntry(uri)`。
- **B2 批量诊断**：`lsp_diagnostics` schema 加可选 `files?: string[]`
  （`file` 与 `files` 二选一，ajv 校验互斥；files 封顶 10 个，超出报错），
  输出按文件分组 `<diagnostics file=...>` 段。
- **B3 哨兵信息分层**：client.ts 新增 `getClientDetailed(ctx, file, opts?)` 返回
  `{ client?, reason?: "no-server" | "no-root" | "spawn-failed", serverId? }`；
  `getClient` 改为薄包装（签名不变）。`LspServerInfo` 加 `installHint?: string`
  （pyright → `npm i -g pyright`、typescript-language-server → `npm i -g typescript typescript-language-server`、yaml/json/dockerfile → `npm i -g <pkg>`）。
  工具层哨兵渲染：no-server → 列出支持的扩展名；no-root → 说明缺项目标记；
  spawn-failed → 带 installHint。broken 记忆的 key 复用时同样给 spawn-failed 语义
  （client.ts broken Set 升级为 Map<key, reason>）。
- **B4 warmup 深化**：warmup 成功 getClient 后对样本文件 `ensureOpen`
  （预热 project 加载），try/catch 单文件失败不中断。
- **B5 空闲回收**：client.ts 记录每 key lastUsedAt；getClient 入口 lazy sweep，
  超过 idleTimeoutMs（默认 10min，settings 可配，见 B7）dispose + 逐出
  （dispose 触发子进程 stdin EOF → server 自行退出；exit 逐出幂等已有）。
- **B6 worker 接线**：`subagent/worker.ts` createWorkerRuntime 内同构装配
  `createLspNotifier({ directory: sandboxRoot })` + registry `onEdit` +
  `startLspWarmup(lspCtx)`；更新 :248-49 注释。
- **B7 settings lsp 段**：`src/config/settings.ts` 加
  `lsp?: { requestTimeoutMs?, diagnosticsWaitMs?, idleTimeoutMs?, disabledServers? }`
  （按 mergeIsolation 三件套样板：interface + per-field 守卫 + parse/merge +
  mergeSettings 接线 + deepFreeze）。build-engine 从 opts.settings 取出注入
  LspCtx（types.ts 扩展可选字段）；工具层超时/等待与 client idle sweep 消费之；
  `disabledServers` 在 resolveServer/getClientDetailed 过滤（记录跳过原因
  no-server：视为未配置）。worker 不接 settings（走默认值，记录于 plan）。

## Batch 2 — 写类操作 + type hierarchy（新工具 +7）

- **B8 WorkspaceEdit applier**（新文件 `src/harness/lsp/workspace-edit.ts`）：
  `applyWorkspaceEdit(root, edit, opts { onEdit })` —— 遍历
  `documentChanges`（优先，含 textDocumentEdit）或 `changes`；每文件
  `resolveWithinRoot(root, path)`（软沙箱，复用 helpers.ts:51）→ 读盘 →
  按 TextEdit range **倒序**应用（0-based LSP range → 磁盘偏移按行/列换算，
  只支持 utf-16 code units 与 JS string index 一致的 BMP 情形，surrogate
  位置 fail-closed 报错）→ writeFile → 每文件成功后 `onEdit(file)`。
  位置漂移防护：写盘前对比文件 mtime?不引入——以 didChange 保持 server 新鲜
  为前提，applier 拒绝跨大版本（不校验，记录约束）。
  command-only change 拒绝（`Unsupported: command`）。
- **B9 lsp_rename**：`textDocument/rename`（新 RENAME_SCHEMA
  `{ file, line, character, newName }`），响应 WorkspaceEdit → applier。
  category **"write"**，interruptBehavior "block"，`ALWAYS_MUTATE_TOOLS`
  加 `lsp_rename`（worktree-gate.ts:206）。输出：应用的文件数 + per-file
  edit 计数摘要（Y1 字符串）。preconditions（server 支持 prepareRename）
  由 rename 请求自然失败转译。
- **B10 lsp_format**：`textDocument/formatting`
  （`{ file, tabSize?, insertSpaces? }`，options 透传 FormattingOptions），
  TextEdits → 单文件应用（复用 applier）。category "write"。
- **B11 lsp_code_action + lsp_code_action_apply**：前者 read-only
  （`textDocument/codeAction`，`{ file, line, character, diagnostics? }`——
  context.diagnostics 透传当前 uri 诊断），列出 actions（title/kind/edit 摘要）；
  后者 write（输入 `{ file, line, character, index }` 取第 index 个 action，
  edit 存在 → applier；仅 command → 拒绝并说明）。两步模式与 call hierarchy 同构。
- **B12 type hierarchy 三件**：`lsp_prepare_type_hierarchy` /
  `lsp_type_supertypes` / `lsp_type_subtypes`，模式复制 call hierarchy 双步工厂。
- **B13 注册面同步**：registry.ts ACI_TOOLSET_NAMES（+7 → 39）+ factories；
  `tests/harness/aci/tools/registry.test.ts` 长度锁 32→39 + 分段锁；
  subagent/catalog.ts explore body 工具清单更新；identity/assemble.ts:559-560
  bash-readonly 替代工具清单更新。
- **B14 probe 扩展**：scripts/lsp-probe.ts run() 加 rename/format/code-action/
  type-hierarchy safeCall 段（MethodNotFound 自适应跳过语义沿用）。

## Batch 3 — 缓存 + 可观测 + 重构 + spec 收口

- **B15 结果级缓存**：client.ts per-connection result cache
  `Map<cacheKey, unknown>`，key = `method + JSON(params) + uriVersion(file)`；
  仅缓存 7 件 position op + document_symbol（工具层声明 cacheable method 集）；
  didChange/didOpen version bump 天然失效；LRU 封顶 100 条（超限驱逐最旧）。
  workspace_symbol / call hierarchy / rename / format / diagnostics 不缓存。
- **B16 trace per-call 精确时间戳**：loop-engine.ts:1804 记录点改用 executor
  `onSettled`（tools/types.ts:149-153）取 per-result startedAt/endedAt/durationMs
  （现状批内共享同一份时间戳——修掉）；LSP handler 内 >5s 请求 stderr 留痕一行。
- **B17 重构 ticket 收口**：aci/tools/lsp.ts 拆出 `lsp-internal.ts`（schemas /
  stringify+cap（Buffer 字节级截断）/ cancellation / diagnostics-wait /
  sentinel 渲染 / probeServer 共享 helper），lsp.ts 目标 <500 行；
  callHierarchy 超时转译统一 method 跟踪（一轮 Standards Low）。
- **B18 spec 302 小尾巴收口**：
  - `.pyi`：已映射 python（language.ts:23）——实测 probe `--lang python` 确认
    pyright 接受，deviation 转正；
  - YAML root：YamlLS rootMarkers 增加 `.yamllint`（保留 JS lockfile 集），
    probe 实测；
  - JSON/Dockerfile root = ctx.directory 语义：probe 实测后在此记录结论；
  - `resolveNpmBin`/`detectVenvPython` 留 server.ts（文件未到拆分阈值，记录裁决）；
  - 全部结论回写 specs/302-lsp-multilang.md Open Questions 节（逐条标注
    resolved + 证据），不新开 spec。
- **B19 真机 probe 回归**：`npm run probe:lsp -- --lang typescript/python/yaml/
  json/dockerfile` 全退出 0（一轮 + 二期 op 全量走真 server）。

## 不可违反边界（沿一轮）

永不 `process.kill`；Y1 纯字符串；`getClient`/`opts.server` 缝兼容；
notifier fire-and-forget；新写类工具必须 `category: "write"` + worktree gate
mutate 集合 + onEdit 接线（缺一不可，绕过权限语义 = High）。

## 完成判据（对照用）

1. B1-B19 全部落地；2. vitest LSP/registry/worker/build-engine/settings 相关
全绿 + `npx vitest run tests/harness` 不回归（预存 query-trace flake 除外）；
3. `tsc --noEmit` 干净；4. probe 五语言全 0 退出（B19）；5. code-review 双轴
0 High；6. 分批 commit（每批 1 commit，Conventional Commits）。

## ACR Verdict（architecture-change-reviewer · 5-verdict gate，2026-08-30）

affects: src/harness/lsp/{client,types,warmup,server}.ts src/harness/lsp/workspace-edit.ts(new) src/harness/lsp/lsp-internal.ts(new) src/harness/aci/tools/lsp.ts src/harness/aci/tools/registry.ts src/harness/isolation/worktree-gate.ts src/harness/subagent/{worker,catalog}.ts src/harness/identity/assemble.ts src/harness/loop-engine.ts src/config/settings.ts src/harness/build-engine.ts scripts/lsp-probe{,-targets}.ts specs/302-lsp-multilang.md tests/*

- bounded-context-guardian: yes —— LSP 语义（applier / cache / sentinel / internal helpers）全部归 `src/harness/lsp/` 上下文，aci/tools 只做 handler 装配；settings 归 `src/config/settings.ts`；worker 经既有 CreateWorkerDepsOptions 装配缝，不破 wire 协议；loop-engine 只动记录点不动引擎语义。
- defensive-contract-validator: yes —— 每批附边界矩阵：file/files 互斥与 10 文件封顶、surrogate 列 fail-closed、command-only change 拒绝、空 WorkspaceEdit、越界 TextEdit range、cache 版本失效、idle sweep 后 respawn、disabledServers 跳过、settings 非法值守卫、worker onEdit 失败不抛。
- error-handling-enforcer: yes —— 新失败路径全部类型化转译（B3 哨兵分层即主体）；applier 逐文件 fail-closed：任一文件写失败整体报错并列明已写盘文件（不静默半完成）；EXIT/留痕沿仓库惯例（stderr 单行）。
- complexity-anti-drift: yes —— 声明结构控制：B17 拆 `lsp-internal.ts` 使 tools/lsp.ts <500 行；applier 独立文件；7 件新工具全部复用既有工厂模式（operation / 双步工厂），无新抽象层级、无计划内深嵌套。
- minimal-change-verifier: yes（conflict sequenced）—— 全轮非单 commit：与 bounded-context 拆分冲突按 sequencing 解决 = 3 批各 1 commit（Batch1 诊断闭环+基建 / Batch2 写类+type hierarchy / Batch3 缓存+观测+重构+收口），批内不做无关顺手改。

GATE: PASS（all yes，conflict resolved by sequencing）。
