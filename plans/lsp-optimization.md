# Plan: LSP 能力最大化优化（spec: 本 plan 自含，对标 specs/251 + specs/302 遗留）

## 目标

在不改变 10 件 `lsp_*` 工具对外契约（Y1 纯字符串输出、Q2/A9 不杀进程）的前提下，
按 5 个维度优化 LSP 功能：

| 维度 | 问题（现状 evidence） | 改动 |
|---|---|---|
| 精确度 | edit_file 后 notifier 发非标准 `workspace/xrefs`，server 侧文本**永远停留在 didOpen version:1**，后续 definition/references 基于陈旧内容 | notifier 改发标准 `textDocument/didChange`（full sync，version++） |
| 精确度 | `lsp_diagnostics` 在 ensureOpen 后**立即读** diagStore，push 诊断尚未到达 → 返回空 | 读前等待首个该 uri 诊断或短 deadline（~2s） |
| 响应速度/加载 | 首次 `lsp_*` 调用承担 spawn+initialize 冷启动（tsserver 可达数秒） | build-engine 装配后 fire-and-forget warmup（按 sandboxRoot 内文件扩展名探测预 spawn） |
| 可用程度 | executor 30s race 超时后请求继续占用 server；连接内无独立超时/取消 | client 层 per-request 超时（默认 20s），超时经 CancellationTokenSource 自动发 `$/cancelRequest` 后抛错 |
| 可用程度 | server 进程意外退出后死连接留在 `clients` 缓存，会话内不自愈 | child `exit` 事件 → 从 `clients` 逐出（不记 broken），下次调用自动重启 |
| 缓存/上下文 | references 等大响应原样 JSON.stringify 进上下文，可撑爆预算 | 输出封顶（默认 48KB）+ 截断 footer |
| 智能度/适配度 | `lsp_workspace_symbol` schema 必填 `file` 但 buildParams 忽略之，query 恒为 `""` | `file` 改可选，新增可选 `query` 参数；更新 description |

## 非目标

- 不新增语言 server（Go/Rust 留 spec 302 二期）。
- 不做多 root workspace 并集（spec 302 Open Question，另行立项）。
- 不做 pull diagnostics、rename/format 等**新**工具。
- 不引入持久化缓存（进程级即弃，维持 spec S14 语义）。

## 任务

- **T1 client.ts — didChange 支持 + 自愈 + 超时**
  - `LspClient` 新增 `notifyChange(file): Promise<void>`：未打开过 → 走 ensureOpen
    （此时读到的就是新文本）；已打开 → `textDocument/didChange` full sync
    `{ textDocument: { uri, version: ++ver }, contentChanges: [{ text }] }`。
    per-connection per-uri version 计数器与 `openedUris` 同源维护。
  - spawnClient 内监听 `child.once("exit", ...)`：从模块级 `clients` 按 key 逐出
    （**不**进 `broken`——spawn 成功过，属可重启失败）。注意 exit 回调需拿到 key，
    可把逐出逻辑经回调注入或在 getClient 层 wrap。
  - `sendRequest` 包装默认超时（`DEFAULT_REQUEST_TIMEOUT_MS = 20_000`，可用
    `LspCtx.timeoutMs` 覆盖——若不加字段则模块常量即可）：内部
    `CancellationTokenSource` + timer，超时 `source.cancel()`（自动 `$/cancelRequest`）
    后 reject `Error("LSP request <method> timed out after 20s (cancelled)")`。
    与 executor 30s race 叠加不冲突（20s 先触发、干净取消）。
- **T2 notifier.ts — 标准 didChange**
  - `notifyInvalidation` 改调 `client.notifyChange(file)`；保留 best-effort 降级
    （try/catch + stderr 留痕）；删除 `workspace/xrefs` 发送。
- **T3 tools/lsp.ts — 诊断等待 + 输出封顶 + workspace_symbol**
  - `makeDiagnosticsTool`：ensureOpen 后 `waitForDiagnostics(uri)`：每 100ms 查
    `client.getDiagnostics(uri)`，首查即有 → 立即返回；deadline 2s → 用现有内容。
    等待可被 execCtx?.signal abort 提前结束。
  - `stringifyResult` 加 cap（48KB）：超限时截断 + `\n...[truncated, N of M bytes shown]`
    footer。cap 为模块常量。
  - `lsp_workspace_symbol`：schema 改 `{ file?: string, query?: string }`
    （均 optional，`additionalProperties: false`）；buildParams 传
    `{ query: input.query ?? "" }`；description 更新（query 支持说明）。
  - 各工具 description 与新行为同步（diagnostics 等待语义、超时提示可省）。
- **T4 build-engine.ts — warmup 预热**
  - `createLspWarmup(lspCtx)`（放 `src/harness/lsp/warmup.ts` 新文件）：
    扫 sandboxRoot（浅层 + node_modules 剔除）收集每 server 命中的首个文件样本
    （复用 `SERVERS[].extensions`），对命中 server 逐个 `getClient`（复用三件套
    天然去重），fire-and-forget，全量 catch。
  - build-engine 装配处（lspNotifier 旁）调用；`surface === "ask"` 时同样执行
    （ask 也装配 lsp 工具）。不得阻塞 build 主路径（不 await）。
- **T5 测试**
  - client.test.ts：didChange version 递增、未打开先 didOpen、exit 自愈逐出后
    respawn、超时取消路径。
  - aci/lsp.test.ts：workspace_symbol 新 schema（file 可选/query 可选）、
    diagnostics 等待（注入假时钟或缩短 deadline）、输出封顶 footer。
  - notifier 相关断言从 `workspace/xrefs` 迁移到 `textDocument/didChange`。
- **T6 验证**
  - `npx vitest run tests/harness/lsp tests/harness/aci/lsp.test.ts` 全绿；
  - `npx tsc --noEmit` 干净；
  - `npm test` 全量不回归（如耗时则至少跑 tests/harness 全量）。

## 边界（不可违反）

- 永不 `process.kill`（Q2/A9）；dispose 只断连接。
- 契约 Y1：handler 永远返回纯字符串。
- 现有 `opts.server` 测试注入缝语义不变；`getClient` 签名向后兼容。
- notifier 保持 fire-and-forget，绝不抛回 edit_file 主路径。

## Review 收尾记录（code-review 双轴裁决，2026-08-30）

- **[已修/High] warmup 早退**：初版"首个 spawn 成功即止"违反 T4"逐个预热"，
  已改为按 SERVERS 声明序遍历全部命中 server，单失败留痕继续
  （tests/harness/lsp/warmup.test.ts 5 用例锁定）。
- **[裁决保留/Medium] per-request 超时在工具层实现**：plan T1 原文写 client 层，
  实现落在 `aci/tools/lsp.ts` 的 `createRequestCancellation`（token cancel 语义
  等价、仍发 `$/cancelRequest`）。裁决：保留工具层——10 件 lsp_* 工具是
  `client.sendRequest` 的唯一生产调用方，工具层实现能拿到 method 名转译错误；
  未来新增非工具调用方时再下沉。
- **[裁决保留/Low] workspace_symbol file 缺省探测语义**：按 `SERVERS` 声明序以
  伪路径试探首个可用 server；不做 per-call 目录扫描（会拖慢每次调用，与响应
  速度目标冲突）。语义已记录于此。
- **[已修/Low] 超时文案与截断 footer**：文案对齐
  `[lsp_xxx] LSP request <method> timed out after 20s (cancelled)`；footer
  对齐 `...[truncated, N of M bytes shown]`（N 为精确展示字节数）。
- **[已修/Medium] warmup readdir 静默 fallback**：加 `// EXIT:` 标注 + stderr 留痕。
- **[ticket 推后/Medium] 文件行数软阈值**：`aci/tools/lsp.ts` 697 行（净增 ~197）、
  `tests/harness/aci/lsp.test.ts` 1128 行（base 836 已超）> 500 软阈值。后续按
  helper 模块抽取 + describe 组拆分处理（含与 warmup 的 probeServer 去重、
  capResult 字节级截断优化、callHierarchy 超时转译收敛，Standards 轴 4 Low）。
