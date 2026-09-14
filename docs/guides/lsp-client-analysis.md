# LSP 客户端现状与升级分析

> 范围：iknow harness 的 headless agent LSP 栈（`src/harness/lsp/` + `aci/tools/lsp.ts`）。  
> SSOT：`specs/251-lsp-tool.md`、`specs/302-lsp-multilang.md`。

## 1. 现状

### 1.1 架构

```
agent lsp_* 工具
  → aci/tools/lsp.ts（10 件 handler，纯字符串 Y1）
  → lsp/client.ts（连接池、spawn、缓存、编辑同步）
  → vscode-jsonrpc（JSON-RPC 传输）
  → language server 子进程（stdio）
```

- **传输层**：依赖 `vscode-jsonrpc`（`dependencies`）。
- **客户端逻辑**：自研薄封装（`client.ts` ~600 行），不用完整 LSP client SDK。
- **翻译层**：用各语言 npm wrapper / PATH 二进制，不自写 tsserver 桥。

### 1.2 依赖

| 类型       | 包                                          |
| ---------- | ------------------------------------------- |
| 协议       | `vscode-jsonrpc`                            |
| TS/JS      | `typescript-language-server` + `typescript` |
| Python     | `pyright`                                   |
| YAML       | `yaml-language-server`                      |
| JSON       | `vscode-json-languageserver`                |
| Dockerfile | `dockerfile-language-server-nodejs`         |

`web/` 子包无 LSP 依赖。

### 1.3 已具备能力

- 10 件 agent 工具：9 件 position 操作 + `lsp_diagnostics`
- 连接池三件套：`(root, serverId)` 缓存 / broken 记忆 / inflight 去重
- `edit_file` 写盘后 `notifyChange`（full sync）
- push diagnostics 订阅 + 读前等待（`pushVersion` 追平）
- warmup 预热（按扩展名样本 spawn + ensureOpen）
- worktree rebind：`directoryCell` flip 时 lazy sweep 旧根 client
- 多语言 dispatch：`resolveServer(file)` 按扩展名路由

### 1.4 验证

```bash
npm run probe:lsp
npm run probe:lsp -- --lang python
npm test   # tests/harness/lsp/ + tests/harness/aci/lsp.test.ts
```

---

## 2. 设计边界

iknow LSP 服务于 **loop 内 agent 符号定位与诊断**，不是编辑器集成：

- handler 返回纯 JSON 字符串（契约 Y1），不做 UI decoration
- 单项目本机：`LspCtx.directory` + `NearestRoot` 足够，不做 multi-root workspace
- cancel 走 `$/cancelRequest`，常规路径不杀 language server 子进程
- spec 251 刻意「handler 极薄、payload 透传」——部分升级需 amend spec

---

## 3. 已知缺口

| 缺口                 | 现状                                                 | 影响                                                             |
| -------------------- | ---------------------------------------------------- | ---------------------------------------------------------------- |
| Capability 未用      | `initialize` 发 `capabilities: {}`，不读 server 返回 | agent 可能对不支持的方法发起请求（yaml 等 MethodNotFound）       |
| 无 didClose          | `openedUris` 只增不减，直到 connection dispose       | 长 session 多文件编辑，server 侧内存涨                           |
| rebind/idle 不杀进程 | sweep 只 `dispose()` 连接；rebind 注释明确不 `kill`  | worktree 切换 / idle 回收后子进程可能泄漏                        |
| 盘外变更             | 仅 `edit_file` → `notifyChange`；git/手工改盘不同步  | 诊断、跳转可能 stale                                             |
| full sync            | 每次变更读全文发 `didChange`                         | 大文件频繁 edit 时 IO + RPC 开销                                 |
| 语言覆盖             | Go/Rust 等在 spec 302 二期                           | PATH server 未落地                                               |
| 单 server 命中       | `resolveServer` 按声明序取第一个                     | 未来 `.ts` 多 server 并集未支持                                  |
| Payload raw          | LSP 响应原样 stringify                               | Location/LocationLink 形态不一；line 0-based vs 工具输入 1-based |

---

## 4. 升级建议

按 ROI 排序；均可在现有 `vscode-jsonrpc + 自研 client` 上增量做，无需换 SDK。

### P0 — agent 直接受益

**4.1 Capability 感知**

- 存 `initialize` 返回的 capabilities
- 工具注册/描述按能力裁剪或标注「本语言不支持」
- 收益：减无效 RPC、减 token 浪费

**4.2 响应归一化（可选，需 spec amendment）**

- 薄翻译层：统一 `{ file, line, character, kind }` 等 agent 友好 schema
- 收益：模型少猜 LSP 结构、少搞错行号
- 成本：偏离 spec 251「不翻译 payload」原则

**4.3 补 agent 向工具**

| 候选                 | LSP method                   | 用途                          |
| -------------------- | ---------------------------- | ----------------------------- |
| `lsp_completion`     | `textDocument/completion`    | 类型感知补全                  |
| `lsp_signature_help` | `textDocument/signatureHelp` | 参数提示                      |
| `lsp_code_action`    | `textDocument/codeAction`    | 快速修复（import、unused 等） |

仍走 Y1 纯字符串；不加 format/rename 管线（agent 已有 `edit_file`）。

### P1 — 稳定性 / 长跑

**4.4 didClose + 子进程收口**

- 长期未访问 uri 发 `textDocument/didClose`
- idle sweep / rebind sweep：`dispose()` + `SIGTERM` 子进程（与 `shutdownAll` 对齐）
- 优先级最高：TUI 常驻、worktree 频繁切换

**4.5 盘外变更同步（轻量）**

- 请求前对目标 file 做 mtime 比对，变了则 `notifyChange`
- 不必上完整 file watcher

### P2 — 语言广度

**4.6 PATH server（spec 302 二期）**

- `gopls`、`rust-analyzer`：复用 `resolveNpmBin` 模式为 `resolvePathBin`
- CI 无二进制：probe graceful skip（待决策）

**4.7 多 server 同扩展名（远期）**

- 如 `.ts` 同时 tsserver + ESLint/Biome
- 需单独 spec；并集 dispatch 对 agent 有用但复杂度高

### P3 — 性能

**4.8 Incremental sync**

- `edit_file` 若能提供 diff/range，发 incremental `didChange`
- 小文件现状够用；大文件收益明显

**4.9 Warmup 调优**

- 并行预热（现串行）
- 按扩展名只扫相关目录；深度自适应

---

## 5. 不在范围内

以下与 headless agent 目标不匹配，本期不推：

- 换完整 LSP client SDK（document model、middleware 与 harness 缝冲突）
- rename / on-type formatting（`edit_file` 已覆盖写路径）
- semantic tokens / inlay hints（对人展示，对 LLM 价值低）
- 完整 `didChangeWatchedFiles` watcher（mtime check 通常够用）

---

## 6. 建议落地顺序

```
1. rebind/idle 子进程收口 + didClose     ← client.ts，稳定性
2. capability 感知                       ← 减 agent 无效调用
3. mtime 盘外同步                        ← 小改，诊断/跳转更准
4. gopls / rust-analyzer                 ← spec 302 二期
5. 响应归一化 或 completion/codeAction   ← 需 spec，按产品优先级
```

---

## 7. 相关路径

| 路径                           | 角色                                               |
| ------------------------------ | -------------------------------------------------- |
| `src/harness/lsp/client.ts`    | 连接池、spawn、didOpen/didChange、diagnostics 订阅 |
| `src/harness/lsp/server.ts`    | 5 语言 server 声明 + `resolveServer`               |
| `src/harness/lsp/notifier.ts`  | edit 后 invalidate                                 |
| `src/harness/lsp/warmup.ts`    | 装配后预热                                         |
| `src/harness/aci/tools/lsp.ts` | 10 件 ACI 工具                                     |
| `scripts/lsp-probe.ts`         | 真实 server 烟测                                   |
