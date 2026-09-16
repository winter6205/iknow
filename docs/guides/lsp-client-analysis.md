# LSP 客户端现状与升级分析

> 范围：iknow harness 的 headless agent LSP 栈（`src/harness/lsp/` + `aci/tools/symbol*.ts`）。
> SSOT：`specs/251-lsp-tool.md`（活）、`plans/lsp-client-hardening.md`（活）。
> **SSOT 缺口**：源码 ~20 处引用 `spec 302-lsp-multilang` 与 `symbol-primary-aci`，
> 但两份文件已被删除且**未归档**（`5ae9889a` 删 `specs/302-lsp-multilang.md`；
> `a6987b05` 删 `specs/symbol-primary-aci.md` + `plans/symbol-primary-aci.md`）。
> 多语言 dispatch 与符号身份工具面的裁决只剩代码注释与本文件可查。

## 1. 现状

    10|### 1.1 架构

```
agent 符号工具（15 件）
  → aci/tools/symbol.ts（10 件查）+ symbol-mutate.ts（5 件改）
  → aci/tools/symbol-resolver.ts（符号身份 → 行列译码 + 内容指纹缓存）
  → lsp/client.ts（连接池、spawn、请求级打开窗口、诊断订阅）
  → vscode-jsonrpc（JSON-RPC 传输）
  → language server 子进程（stdio）
```

- **模型面是符号身份，不是坐标**：工具收 `{ file, symbol_path }`，行列译码封在
  20| `symbol-resolver.ts`。#251 的 10 件坐标面 `lsp_*` 已在 symbol-primary-aci T5
  退役——`createLspToolSet`（`aci/tools/lsp.ts:857`）**零生产调用方**，只有
  `tests/harness/aci/lsp.test.ts` 在调。但 `getClientForWorkspaceDetailed` 与
  `renderNoServer` / `stringifyResult` 等共享件仍住在该文件里，被活的
  `symbol.ts` import——文件已死、其中的函数还活着。
- **传输层**：依赖 `vscode-jsonrpc`（`dependencies`）。
- **客户端逻辑**：自研薄封装（`client.ts`），不用完整 LSP client SDK。
- **翻译层**：各语言 npm wrapper / PATH 二进制，不自写 tsserver 桥。

### 1.2 依赖

    30|

| 类型       | 包                                          |
| ---------- | ------------------------------------------- |
| 协议       | `vscode-jsonrpc`                            |
| TS/JS      | `typescript-language-server` + `typescript` |
| Python     | `pyright`                                   |
| YAML       | `yaml-language-server`                      |
| JSON       | `vscode-json-languageserver`                |
| Dockerfile | `dockerfile-language-server-nodejs`         |

    40|`web/` 子包无 LSP 依赖。

### 1.3 模型面 15 件工具 → 实际发出的 10 个 method

| 工具                                             | method                        |
| ------------------------------------------------ | ----------------------------- |
| `find_declaration`                               | `textDocument/definition`     |
| `find_referencing_symbols`、`safe_delete_symbol` | `textDocument/references`     |
| `find_implementations`                           | `textDocument/implementation` |
| `get_hover`                                      | `textDocument/hover`          |
| `get_symbols_overview`、`symbol-resolver`        | `textDocument/documentSymbol` |

    50|| `prepare_call_hierarchy`                                                   | `textDocument/prepareCallHierarchy` |

| `list_incoming_calls` / `list_outgoing_calls` | `callHierarchy/{incoming,outgoing}Calls` |
| `find_symbol` | `workspace/symbol` |
| `rename_symbol` | `textDocument/rename` |
| `get_diagnostics_for_file` | `textDocument/publishDiagnostics`（推送订阅，非请求） |
| `replace_symbol_body`、`insert_before_symbol`、`insert_after_symbol` | **无 LSP method** —— 见 §3.4 |

外加文本同步三件 `didOpen` / `didChange` / `didClose`。

### 1.4 已具备能力

    60|- 连接池三件套：`(root, serverId)` 缓存 / broken 记忆 / inflight 去重

- **请求级打开窗口**：`withDocumentOpen` 进入开、退出关（含抛错与超时路径），
  refs 计数 + `pinned` 例外；tsserver 不为未打开文件建 project，故这是 project
  上下文的**前提**而非优化（词条见 `docs/CONTEXT.md`）
- **盘外变更对齐**：发 RPC 前 `alignToDisk` 比对 mtime，变了才发 `didChange`
  （`client.ts:560-580`，调用点 `:665`）
- **子进程收口**：三条回收缝（idle sweep / rebind stale sweep / `disposeAll`）
  - `shutdownAll` 统一走关连接 + `SIGTERM`（`client.ts:187-197`）
- server capabilities 快照 + **只认显式 `false`** 的裁剪判定（见 §4 的刻意否决）
- push diagnostics 订阅 + 读前等待（`pushVersion` 追平，默认 2s deadline）
  70|- warmup 预热：扫真实样本文件 spawn + 裸 `ensureOpen` 永久 pin（`warmup.ts`）
- worktree rebind：`directoryCell` flip 时 lazy sweep 旧根 client
- 多语言 dispatch：`resolveServer(file)` 按扩展名单命中路由
- per-request 超时 + abort 桥接：统一走 `$/cancelRequest`，不杀 server

### 1.5 验证

````bash
npm run probe:lsp                  # 真实 server 烟测（5 server × 夹具）
npm run probe:lsp -- --lang python
npm test                           # tests/harness/lsp/ + tests/harness/aci/lsp.test.ts
    80|```

---

## 2. 设计边界

iknow LSP 服务于 **loop 内 agent 符号定位、诊断与符号级改写**，不是编辑器集成：

- handler 返回纯字符串（契约 Y1），不做 UI decoration
- 单项目本机：`LspCtx.directory` + `NearestRoot` 足够，不做 multi-root workspace
- cancel 走 `$/cancelRequest`，常规路径不杀 language server 子进程
    90|- 失败与能力缺口都走**分层哨兵**（带括号的纯字符串），由 `isLspFailureSentinel`
  / `isMethodNotFoundSentinel` 分类；`scripts/lsp-probe.ts` 靠这两个判定决定
  记 FAIL 还是 skip

---

## 3. 已知缺口

### 3.1 能力缺口（按 agent 价值排序）

   100|| 缺口                                          | 现状                                                              | 影响                                                       |
| --------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------- |
| **`codeAction` + `workspace/executeCommand`** | 完全没有（`executeCommand` 在 `src/` 零出现）                     | agent 看得到诊断却**不能让 server 修**：无 quick-fix、无 auto-import、无 organize-imports；所有修都得自己拼文本 |
| **`prepareRename`**                           | 零出现；`rename_symbol` 直接发 `textDocument/rename`              | 「该位置能否改名」只能靠请求失败发现，拿不到干净前置判定   |
| **`typeHierarchy/*`**                         | 零出现                                                            | 调用图有（双向），类型图没有；`find_implementations` 只覆盖一半 |
| **pull diagnostics**                          | `textDocument/diagnostic` 在 capability 表里但无人发，只有 push    | 得靠「编辑后等重推 + deadline」凑，`waitForDiagnostics` 的复杂度即此代价 |
| **`willRenameFiles` / `didRenameFiles`**      | 零出现                                                            | 移动 / 重命名文件时 server 不更新 import                   |
| `completion` / `signatureHelp` / `formatting` / `codeLens` | 零出现                                              | 对 agent 价值低（见 §5）                                   |

### 3.2 语言覆盖

   110|只 5 个 server（`server.ts:376` 的 `SERVERS`），`resolveServer` 按扩展名**单命中、无并集**：

- 覆盖：`.ts .tsx .js .jsx .mjs .cjs .mts .cts` / `.py .pyi` / `.yaml .yml` / `.json` / `.dockerfile` `Dockerfile`
- 不覆盖（全落 `(no LSP server configured…)` 哨兵）：`.go` `.rs` `.java` `.rb`
  `.php` `.c` `.cpp` `.cs` `.sh` `.css` `.html` `.md` `.toml` `.sql` …
- 同扩展名多 server（如 `.ts` 同时 tsserver + Biome）未支持

### 3.3 `find_symbol` 的 `file` 缺省分岔（根因未钉）

`file` 缺省时走 `getClientForWorkspaceDetailed`（`lsp.ts:447-459`）：拿伪路径
   120|`<directory>/iknow-workspace.ts` 去 spawn，随后**裸发请求、不开打开窗口**
（`symbol.ts:354-356`）。实测返 `[]`，而 `[]` 同时表示「真没这个符号」和
「查询链路没上下文」。

**根因尚未确立**：`lsp.ts:495` 的注释归因于「无文件可打开」，但 `warmup.ts`
在同一池键的同一 client 上已用裸 `ensureOpen` 把一个真实样本文件 `pinned`
永久钉住（理由与该注释同一条），且 warmup 已接线（`build-engine.ts:771`、
`worker.ts:552`）。若 warmup 跑成，project 早已加载，缺请求级 didOpen 不该返空。
候选机制：warmup 静默失败（fire-and-forget，只写 stderr）／池键不匹配／根因另在他处。

   130|**覆盖状态：零**。唯一断言 `[]` 的测试（`tests/harness/aci/lsp.test.ts:1009-1019`）
测的是已退役的 `lsp_workspace_symbol`，不构成活路径覆盖。

### 3.4 协议本身没有的原语

`replace_symbol_body` / `insert_before_symbol` / `insert_after_symbol` **不走
LSP `textDocument/*`**——`symbol-mutate.ts:519` 写明「无『替换 body』原语」，
实现是拿 `documentSymbol` 的 range 自己算文本编辑。这是协议缺口，不是实现偷懒。

### 3.5 结构性杂物

- **`METHOD_CAPABILITY_KEYS` 有 11 行死行**：表有 19 项（`client.ts:789`），
   140|  实际有工具在发的只有 8 项（`definition` / `references` / `hover` /
  `documentSymbol` / `implementation` / `rename` / `prepareCallHierarchy` /
  `workspace/symbol`）。`typeDefinition` / `declaration` / `signatureHelp` /
  `codeAction` / `foldingRange` / `selectionRange` / `documentHighlight` /
  `semanticTokens/full` / `inlayHint` / `inlineValue` / `diagnostic` 无人发。
  死行无害（只被 `serverDeclaresUnsupported` 查），但会让人误以为已接通。
- **`find_declaration` 发的是 `definition` 不是 `declaration`**：declaration 与
  definition 的区分被折叠（C++ 头文件、TS `declare` 场景可见差异）。
- **`aci/tools/lsp.ts` 是死文件活函数**：见 §1.1。
- **full sync**：`notifyChange` 每次读全文发 `didChange`，无 incremental。
   150|- **payload 原样 stringify**：`Location` / `LocationLink` 形态不一，行号
  0-based 与工具输入 1-based 并存。符号身份面缓解了大半（模型不再填坐标），
  但返回值仍是 server 原始结构。

---

## 4. 已关闭的缺口（勿重复提案）

以下曾列为缺口，现已落地——旧版本的本文件仍写着它们没做：

| 曾缺                   | 现状                                                          |
   160|| ---------------------- | ------------------------------------------------------------- |
| `initialize` 发空 capabilities、不读 server 返回 | 已广告非空能力并存快照（`client.ts:467-478`） |
| 无 `didClose`，`openedUris` 只增不减 | 请求级打开窗口，退出即关 + refs 计数        |
| rebind / idle 不杀子进程 | 三条回收缝统一 `SIGTERM`（`client.ts:187-197`）              |
| 盘外变更不同步         | 发 RPC 前 `alignToDisk` mtime 比对                            |

**刻意否决**：「按 server 声明的 capabilities 裁剪工具注册 / 描述」——
typescript-language-server 实测**不声明** `callHierarchyProvider` 却实现了 call
hierarchy，据此裁剪会误伤 TS 的保真面。现行纪律是**缺席 ≠ 不支持，只认显式
`false`**，能力缺口靠 `-32601` → 缺方法哨兵在运行期发现（`client.ts:811-825`）。
   170|
---

## 5. 不在范围内

- 换完整 LSP client SDK（document model、middleware 与 harness 缝冲突）
- `completion` / `signatureHelp`：agent 不逐字符打字，价值低
- semantic tokens / inlay hints / codeLens：对人展示，对 LLM 价值低
- on-type formatting；格式化交给项目自己的 prettier / eslint
- 完整 `didChangeWatchedFiles` watcher（`alignToDisk` 的 mtime 比对通常够用）

   180|> 注意：早期版本把 **rename** 也列在本节（理由「`edit_file` 已覆盖写路径」）。
> 该判断已被推翻——`rename_symbol` 走 `textDocument/rename` 让 server 计算跨文件
> `WorkspaceEdit`，是 `edit_file` 无法替代的能力。

---

## 6. 相关路径

| 路径                                    | 角色                                                     |
| --------------------------------------- | -------------------------------------------------------- |
| `src/harness/lsp/client.ts`             | 连接池、spawn、请求级打开窗口、mtime 对齐、诊断订阅、子进程收口 |
   190|| `src/harness/lsp/server.ts`             | 5 语言 server 声明 + `NearestRoot` + `resolveServer`     |
| `src/harness/lsp/language.ts`           | 语言判定                                                 |
| `src/harness/lsp/notifier.ts`           | edit 后 invalidate                                       |
| `src/harness/lsp/warmup.ts`             | 装配后预热（真实样本 + pinned open）                     |
| `src/harness/aci/tools/symbol.ts`       | 10 件查工具（模型面）                                    |
| `src/harness/aci/tools/symbol-mutate.ts`| 5 件改工具（模型面，category=write）                     |
| `src/harness/aci/tools/symbol-resolver.ts` | 符号身份 → 行列译码 + 内容指纹缓存                    |
| `src/harness/aci/tools/lsp.ts`          | 已退役的 10 件坐标面 + 仍在用的共享件（哨兵 / stringify / workspace client） |
| `scripts/lsp-probe.ts`                  | 真实 server 烟测                                         |
````
