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
  `symbol-resolver.ts`。#251 的 10 件坐标面 `lsp_*` 已在 symbol-primary-aci T5
  从**模型面**退役，但**没有退役出代码库**——`createLspToolSet`
  （`aci/tools/lsp.ts:857`）是 `scripts/lsp-probe.ts:266` 的真实栈烟测仪器
  （经 `package.json` 的 `probe:lsp` 接线）。共享件（`getClientForWorkspaceDetailed` /
  `renderNoServer` / `stringifyResult` / `isLspFailureSentinel` 等）仍被活的
  `symbol.ts` / `symbol-mutate.ts` / `symbol-resolver.ts` import。该文件是
  **名字起错**，不是死了；删掉它会砸掉 `probe:lsp`。
  注意：probe 调的是 `lsp_workspace_symbol({ file })`（永远带 `file`），
  **从不**走 `find_symbol` 无 `file` 分岔——所以 probe 矩阵不是该路径的覆盖。
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

### 3.3 `find_symbol` 的 `file` 缺省分岔

`file` 缺省时走 `getClientForWorkspaceDetailed`（`lsp.ts:447-459`）：拿伪路径
`<directory>/iknow-workspace.ts` 去 spawn，随后**裸发请求、不开打开窗口**
（`symbol.ts:354-356`）。

**根因已实测确立**（收口本节原「根因尚未确立」的疑问，旧归因「无文件可
打开」已被推翻）：`workspace/symbol` 的搜索集合由锚点文件所属 project 决定
（tsserver 对 `include` 外锚点只建 inferred project）；无 `file` 即无锚点，
覆盖不可信。完整机制、翻转实验与复现命令见 §8。修后无锚点返分层哨兵
（`renderNoProjectAnchor`，`lsp.ts`），`[]` 只表示「真没这个符号」。

**覆盖**：哨兵契约 + 真无符号 `[]` 共 12 条 fake-client 契约测试
（`tests/harness/aci/lsp.test.ts`，plan `lsp-silent-degradation` T3）；真实
tsserver 复验证据在 §8.3 / §8.8。

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

---

## 7. Probe 矩阵（实测）

**定义：「支持一门语言」= 本矩阵里有那一行。** 行的成立只从探针实跑取得，不从
server capabilities 声明推断（刻意否决见 §4）。

`npm run probe:lsp [-- --lang <lang>]`（`package.json:51`）是唯一走**真实栈**的
LSP 实测面：生产 `createLspToolSet`（`aci/tools/lsp.ts:857`，见 §1.1）→
`lsp/client.ts` → spawn 真实 language server 子进程。`--lang` 取值 =
`PROBE_TARGETS` 的 key（`scripts/lsp-probe-targets.ts`）：typescript / python /
yaml / json / dockerfile。

### 7.1 坐标面声明（引用本矩阵前必读）

本矩阵量的是**坐标面** `lsp_*`。探针调 `lsp_workspace_symbol({ file: target })`
（`scripts/lsp-probe.ts:319-321`）——**永远带 `file`**。

它**不覆盖** `find_symbol` 无 `file` 的分岔：那条路径走
`getClientForWorkspaceDetailed`（`aci/tools/lsp.ts:447`），拿伪路径
`<directory>/iknow-workspace.<ext>` 只为 spawn，随后裸发请求、不进请求级打开窗口
（`symbol.ts:354-356`）。探针从不调 `find_symbol`，也从不进这条分岔。

**不得把本矩阵当 `find_symbol` 无 `file` 路径的覆盖引用**——本矩阵只量坐标面
`lsp_*`；`find_symbol` 无 `file` 分岔的根因与契约见 §8 与 §3.3。

### 7.2 判定词汇

探针的三种 verdict（`scripts/lsp-probe.ts:141-145` 的 `ProbeVerdict`）：

| verdict | 输出标记                     | 含义                                                    |
| ------- | ---------------------------- | ------------------------------------------------------- |
| pass    | `✓ <op>`                     | 返回非空纯字符串，且不是任何失败哨兵                    |
| skip    | `- <op> (skipped: <reason>)` | server 未实现该方法（MethodNotFound）；**不计入 total** |
| fail    | `✗ <op> (<detail>)`          | 空返回 / 非字符串 / 失败哨兵 / 其他 RPC error           |

- **skip 不计分**：`passed === total` 只对**实际检查过的** op 判定；能力缺口的
  op 既不算过、也不减分（`scripts/lsp-probe.ts:195-198`）。
- 因此 **`all green` ≠ server 实现了全部方法**：下表的 json 行只有 3 件真正被
  检查过。读 `all green` 必须连带读 `(passed/total)`。
- **失败哨兵判 FAIL 不判 skip**：spawn 失败 / 无 server / 无 root 走
  `isLspFailureSentinel`（`scripts/lsp-probe.ts:176-178`），记 `✗`。
- 退出码：`passed === total ? 0 : 1`（`scripts/lsp-probe.ts:379`）。本次 5 门
  全部退出 **0**。

### 7.3 矩阵（2026-09-16 实跑）

`lsp_` 前缀在表头省略；列名即探针的 op 名。`passed/total` 即探针末行
`all green (passed/total)`。

| 语言       | serverId                            | definition            | references            | hover | document_symbol | workspace_symbol      | go_to_implementation  | prepare_call_hierarchy | incoming_calls        | outgoing_calls        | diagnostics | passed/total |
| ---------- | ----------------------------------- | --------------------- | --------------------- | ----- | --------------- | --------------------- | --------------------- | ---------------------- | --------------------- | --------------------- | ----------- | ------------ |
| typescript | `typescript`                        | ✓                     | ✓                     | ✓     | ✓               | ✓                     | ✓                     | ✓                      | ✓                     | ✓                     | ✓           | 10/10        |
| python     | `pyright`                           | ✓                     | ✓                     | ✓     | ✓               | ✓                     | skip (MethodNotFound) | ✓                      | ✓                     | ✓                     | ✓           | 9/9          |
| yaml       | `yaml-language-server`              | ✓                     | skip (MethodNotFound) | ✓     | ✓               | skip (MethodNotFound) | skip (MethodNotFound) | skip (MethodNotFound)  | skip (MethodNotFound) | skip (MethodNotFound) | ✓           | 4/4          |
| json       | `json-language-server`              | skip (MethodNotFound) | skip (MethodNotFound) | ✓     | ✓               | skip (MethodNotFound) | skip (MethodNotFound) | skip (MethodNotFound)  | skip (MethodNotFound) | skip (MethodNotFound) | ✓           | 3/3          |
| dockerfile | `dockerfile-language-server-nodejs` | ✓                     | skip (MethodNotFound) | ✓     | ✓               | skip (MethodNotFound) | skip (MethodNotFound) | skip (MethodNotFound)  | skip (MethodNotFound) | skip (MethodNotFound) | ✓           | 4/4          |

**全表 0 格 FAIL，0 格未测。** skip 的原因只有一条 —— MethodNotFound，探针原文：

```
MethodNotFound sentinel — server 未实现该方法
```

skip 明细（matrix 列名 → 探针实发的 LSP method）：

| serverId                            | skip 的 op                                                                                                                                          | 对应 method                                                                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typescript`                        | 无                                                                                                                                                  | —                                                                                                                                                               |
| `pyright`                           | `lsp_go_to_implementation`                                                                                                                          | `textDocument/implementation`                                                                                                                                   |
| `yaml-language-server`              | `lsp_references` / `lsp_workspace_symbol` / `lsp_go_to_implementation` / `lsp_prepare_call_hierarchy` / `lsp_incoming_calls` / `lsp_outgoing_calls` | `textDocument/references` / `workspace/symbol` / `textDocument/implementation` / `textDocument/prepareCallHierarchy` / `callHierarchy/{incoming,outgoing}Calls` |
| `json-language-server`              | 同 yaml 六件 + `lsp_definition`                                                                                                                     | 同 yaml 六件 + `textDocument/definition`                                                                                                                        |
| `dockerfile-language-server-nodejs` | 同 `yaml-language-server` 六件                                                                                                                      | 同 yaml 行                                                                                                                                                      |

matrix 列名 → method 全表：

| op                           | method                                                |
| ---------------------------- | ----------------------------------------------------- |
| `lsp_definition`             | `textDocument/definition`                             |
| `lsp_references`             | `textDocument/references`                             |
| `lsp_hover`                  | `textDocument/hover`                                  |
| `lsp_document_symbol`        | `textDocument/documentSymbol`                         |
| `lsp_workspace_symbol`       | `workspace/symbol`                                    |
| `lsp_go_to_implementation`   | `textDocument/implementation`                         |
| `lsp_prepare_call_hierarchy` | `textDocument/prepareCallHierarchy`                   |
| `lsp_incoming_calls`         | `callHierarchy/incomingCalls`                         |
| `lsp_outgoing_calls`         | `callHierarchy/outgoingCalls`                         |
| `lsp_diagnostics`            | `textDocument/publishDiagnostics`（推送订阅，非请求） |

### 7.4 夹具与 root 标记

| --lang     | 目标文件                                                   | 类型           | root 标记                                                  |
| ---------- | ---------------------------------------------------------- | -------------- | ---------------------------------------------------------- |
| typescript | `src/harness/lsp/client.ts`（line 94, char 22）            | 真实仓库文件   | `package-lock.json`（`TS_LOCKFILES`，`server.ts:157-163`） |
| json       | `tsconfig.json`（line 2, char 1）                          | 真实仓库文件   | 无（`JsonLS.root = ctx.directory`，`server.ts:323`）       |
| python     | `.iknow/probe-lsp/python/probe.py`（line 1, char 4）       | 运行时生成夹具 | `pyrightconfig.json`（`ProbeTarget.rootMarkers`）          |
| yaml       | `.iknow/probe-lsp/yaml/probe.yml`（line 5, char 9）        | 运行时生成夹具 | 无（`YamlLS.root = ctx.directory`，`server.ts:295`）       |
| dockerfile | `.iknow/probe-lsp/dockerfile/Dockerfile`（line 1, char 5） | 运行时生成夹具 | 无（`DockerfileLS.root = ctx.directory`，`server.ts:354`） |

夹具全部写在 `.iknow/probe-lsp/<lang>/`（`.iknow/*` 被 gitignore），不落 repo 根，
避免被误当真实部署文件。为何这三门必须用夹具（结论原只活在夹具注释里）：

- **python**：仓库根没有任何 pyright 认的 root 标记（`pyproject.toml` /
  `setup.py` / `setup.cfg` / `requirements.txt` / `Pipfile` / `pyrightconfig.json`
  全无——根上只有 `package-lock.json`，那是 TS 标记）。夹具目录自带
  `pyrightconfig.json`，让 `NearestRoot` 立刻命中。
- **yaml**：真实目标 `.github/workflows/*.yml` 上 yaml-language-server 的
  definition / hover **实测为空**（无锚点）。夹具改写成含 YAML 锚点 `&defaults`
  的源，`*defaults` 别名的 definition 实测返回非空（跳到锚点定义处）。
- **dockerfile**：仓库根本没有 `Dockerfile`。夹具另带一层实测结论：该 server 对
  `FROM` 镜像名 / `ARG` 引用位置的 definition **实测为 `null`**；但对
  `ARG NAME=value` 的**变量名**（`BASE_VERSION`，line 1 char 4-16）definition
  返非空（自指 range），hover 返回 value（`{"contents":"20"}`）。夹具因此带
  `ARG` 引用 + 变量名定位，让 definition / hover 有真实非空返回。该 server 的
  references / implementation / workspaceSymbol / callHierarchy 未声明 provider
  （即上表 skip 六件的来源）。

### 7.5 复现环境

本次实跑（矩阵全部数值的来源）：

```bash
git rev-parse --short HEAD   # 21bd5805 (feat/lsp-silent-degradation)
node -v                      # v22.23.2
npx tsx --version            # tsx v4.23.0

npm run probe:lsp                          # typescript 保底
npm run probe:lsp -- --lang python
npm run probe:lsp -- --lang yaml
npm run probe:lsp -- --lang json
npm run probe:lsp -- --lang dockerfile
```

5 个 server 包全部在 `node_modules`，经 `resolveNpmBin` 第 1 步
（`createRequire` 同源解析）命中，未走 PATH `which` 兜底：

| serverId                            | 包                                  | 实测版本 | bin 名                       |
| ----------------------------------- | ----------------------------------- | -------- | ---------------------------- |
| `typescript`                        | `typescript-language-server`        | 5.3.0    | `typescript-language-server` |
| `pyright`                           | `pyright`                           | 1.1.411  | `pyright-langserver`         |
| `yaml-language-server`              | `yaml-language-server`              | 1.24.0   | `yaml-language-server`       |
| `json-language-server`              | `vscode-json-languageserver`        | 1.3.4    | `vscode-json-languageserver` |
| `dockerfile-language-server-nodejs` | `dockerfile-language-server-nodejs` | 0.15.0   | `docker-langserver`          |

### 7.6 未测格的记录约定

**本次 0 格未测**：5 门 server 二进制全部在位，全部实跑，上方矩阵即实测输出。

二进制缺失时：探针打印 `✗ <op> (LSP server unavailable)`，计入 FAIL、退出码 1
（spawn 失败走 `renderNoServer` 的 spawn-failed 哨兵，被 `isLspFailureSentinel`
认出，`scripts/lsp-probe.ts:176-178`）。**此时文档按「未测」记，不按「该 server
不支持该方法」记**，并附缺失包名与 `SERVERS.installHint`（`server.ts:216/259/294/322/353`）：

| serverId                            | installHint                                      |
| ----------------------------------- | ------------------------------------------------ |
| `typescript`                        | `npm i -g typescript typescript-language-server` |
| `pyright`                           | `npm i -g pyright`                               |
| `yaml-language-server`              | `npm i -g yaml-language-server`                  |
| `json-language-server`              | `npm i -g vscode-langservers-extracted`          |
| `dockerfile-language-server-nodejs` | `npm i -g dockerfile-language-server-nodejs`     |

---

## 8. `find_symbol` 无 `file` 分岔：根因（实测）

本节是 §3.3「根因尚未确立」的收口（plan `lsp-silent-degradation` T2 调查票）。
所有结论都在本 worktree 上用**真实 tsserver**（`typescript-language-server` 5.3.0 +
`typescript` 5.9.3）复跑取得，无 mock、无 stub。凡推断处逐条标注。

**一句话结论**：`find_symbol` 无 `file` 返 `[]` 不是「无文件可打开」，而是
`workspace/symbol` 的**搜索集合本身不是工作区**——它由 tsserver 当前已加载的
**project graph** 决定，而 project graph 由 LSP `file:` 参数指向的那个文件决定。
锚点越界时 graph 为空 → 可观测结果 `[]` / `No Project.` / 命中数少于实际；
锚点落在 tsconfig `include` 内时 graph 正确 → 结果可信。

### 8.1 被推翻的既有归因（先记，避免下游沿用）

| 原说法                                                                | 实测                                                                                                                                                                                   |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lsp.ts:495` 注释 / §3.3：空结果归因「无文件可打开」                  | 归因不够准确。**有**文件打开（warmup 的裸 `ensureOpen`）也能返 `[]`，甚至**刚返回过命中**之后又返 `[]`（§8.4 的 flip）。决定因素是锚点文件所属 **project**，不是「是否打开过任何文件」 |
| leader 交接事实 4：`ensureOpen(registry.ts)` 后同查询返 3 hits 并稳定 | 复现，但数字是 **4 hits / 3 files**，且 **6–8 s 后回落到 0–1 hits**。该次观测落在 project 重建的**瞬态窗口**内（§8.4）                                                                 |
| leader 交接事实 4：等待 10 s 不改变 `[]`                              | 对本 worktree 的**生产锚点场景**成立（§8.3 的 40 s 窗口全程 `0`），但**不可一般化**：换一个 in-project 锚点，10 s 内会从 `0` 变 `4`（§8.2 锚点 A）                                     |

### 8.2 机制定位

`typescript-language-server` 的 `workspace/symbol` 实现（`node_modules/typescript-language-server/lib/cli.mjs:24650-24660`，实测阅读）：

```js
async workspaceSymbol(params, token) {
  const response = await this.tsClient.execute(CommandTypes.Navto, {
    file: this.tsClient.lastFileOrDummy(),   // ← 搜索集合的锚点
    searchValue: params.query
  }, token);
```

- `lastFileOrDummy()`（`cli.mjs:19819`）= `this.documents.files[0]`，即 **LSP 层最近一次
  被触碰的打开文档**（`didOpen` 时 `_files.unshift`，`didChange` 时再 unshift，`didClose`
  时 splice 移除；`cli.mjs:17713/17740/17755`）。全部文档关闭时回落到 workspace folder
  路径（= 本客户端的 `rootUri` = pool key 的 root）。
- tsserver 侧 `navto`（`typescript.js:194428` → `IpcIOSession.getNavigateToItems` →
  `getFullNavigateToItems`，`194322`）：**`file` 在场**时只搜该文件所属 project
  （`getProjects(args)`）；**`file` 缺省**时才 `forEachEnabledProject` 搜全部。
  `No Project.` 由 `ThrowNoProject`（`typescript.js:186170`）在
  `getProjects(file)` 找不到任何 project 时抛出。

**锚点 → project 的映射**（实测，非读码推断）：锚点在 tsconfig `include` 内 →
tsserver 加载该 tsconfig project，搜索集合 = entire tsconfig program；
锚点在 tsconfig `include` **外** → tsserver 为它加载 inferred project，
而 inferred project **只含该文件 + 其 import closure**，不扫目录。

**实测对照（同一仓库，仅换锚点文件）**：A = `src/harness/aci/tools/symbol.ts`
（在 `include` 内），B = `archive/onetime-probes/closed-world-inventory-probe.ts`
（在 `include` 外）：

| 查询                                                  | 锚点 A（in `include`）  | 锚点 B（out of `include`） |
| ----------------------------------------------------- | ----------------------- | -------------------------- |
| `createAciRegistry`（`src/`，未打开）                 | `4` hits（~7 s 后稳定） | `0`（40 s 全程稳定）       |
| `createSymbolQueryToolSetForTest`（`tests/`，未打开） | `0`（30 s+ 稳定）       | —                          |

`tests/` 一行是第二个实测：`tsconfig.json:26` 的 `include` 为
`["src/**/*.ts", "src/**/*.tsx"]`，`tests/` 被 `exclude`（`tsconfig.json:27`），
于是**在正确 project 下也检索不到**——证明搜索集合的边界是 tsconfig program，
不是目录树。

### 8.3 生产形态：本 worktree 实测全程返 `[]`

`ctx.directory = <repo root>`（生产形状），走真实 `startLspWarmup` + `find_symbol`：

```text
[lsp-warmup] partial: pyright: no client available
warmup status=partial pinned=["typescript:archive/onetime-probes/closed-world-inventory-probe.ts","json-language-server:package-lock.json"]
pool keys after warmup   = ["<ROOT>:typescript","<ROOT>:json-language-server"]
pool keys after no-file = ["<ROOT>:typescript","<ROOT>:json-language-server"]
0s=0 2.8s=0 4.8s=0 6.8s=0 9.0s=0 11.1s=0 ... 38s=0 40s=0   （20 次采样，40 s 窗口）
```

机制链（每一环都有实测）：

1. warmup 扫描目录**递归深度 2、遇到第一个命中扩展名即 pin**
   （`warmup.ts:107-124`）。本 repo 根 `readdir` 序里第一个 `.ts` 是
   `archive/onetime-probes/...`（实测 scan 序：`.env.example, .git, .gitignore, ...,
archive/onetime-probes/closed-world-inventory-probe.ts`）——该文件在 `archive/`，
   **不在 tsconfig `include` 内**（`tsconfig.json:26`）。
2. `find_symbol` 无 `file` → `getClientForWorkspaceDetailed` 用伪路径
   `<ctx.directory>/iknow-workspace.ts` 取 server/root（`lsp.ts:447-459`）。
   伪路径贴着 repo 根，`NearestRoot` 命中根上的 `package-lock.json`
   → **root = ctx.directory，pool key = `<ROOT>:typescript`，与 warmup 共用同一个
   tsserver 进程**（实测 pid 相同）。
3. 第一个查询到达时 `lastFileOrDummy()` = warmup pin 的 archive 文件
   → 空 inferred project → `[]`；该 inferred project 被 tsserver 缓存住，
   后续查询持续 `[]`。
4. 本 repo 的 `src/` 下任何文件都**没有被 pin**（warmup 只 pin 第一个样本；
   请求级窗口 `withDocumentOpen` 退出时发 `didClose`，把该 src 文件从 `_files`
   移走，`_files[0]` 又回到 warmup 的 archive pin——实测无 warmup 时
   `_files` 为空，`lastFileOrDummy()` 回落到 workspace folder 路径，
   查询直接抛 `No Project.`），所以正确 project 永远建不起来。

**这一条不是「warmup 静默失败」**：`getWarmupOutcome()` 实测为
`partial` / `pinned` 非空 / `failures` 只有无关的 `pyright: no client available`。
warmup 成功跑完，它就是**选错了样本**。

### 8.4 更坏的一面：正确锚点也会**翻转回** `[]`

同一 client 上再打开第二个文档，会改变 `_files[0]`，从而改变搜索集合。
实测两种 arm（每次 opened 后等 9 s 再开第二个）：

```text
archive(9s) -> src     : 10.7s=4 12.8s=4 14.8s=0 16.9s=0 ... 33.0s=0     （先给结果，再清空）
src(9s)     -> archive :  9.3s=0 11.5s=0 14.0s=4 16.1s=4 ... 32.6s=4     （先空，后给结果）
```

同一 arm 内 `No Project.` ⇄ `[]` ⇄ 命中数变化也都被观测到（scoped window 关闭后
1 s 抛 `No Project.`，5 s 后同一查询变 `<semantic>` 前缀的另一形态异常）。
**推论（推断，非直测）**：tsserver 在 inferred project 之间切换时会卸载/重建
project，重建窗口内 `navto` 可能落到半构建状态——这正是「先给 4 命中、2 s 后
归 0」的形态。该瞬态与 `getProjects` 的 project 选择规则没有逐行读码证实，
标为推断。

**对 T3 的含义**：即使 T3 把「无锚点」变成 typed 失败，**「返回非空」也不等于
「结果完整」**，而且**空结果在任何锚点下都可能只是瞬态**。

### 8.5 候选机制裁决表

| #   | 候选                                    | 裁决                                                 | 决定性证据                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | --------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | warmup 静默失败                         | **RULED OUT**（单独不成因）                          | `getWarmupOutcome()` 实测 `status=partial`、`pinnedSamples` 非空、`failures` 只有 pyright。warmup 成功跑完。但它**选错样本**（pin 了 tsconfig `include` 之外的第一个 hit）——这一半与 (d) 同源                                                                                                                                                                                                                                                                   |
| b   | 池键不匹配                              | **RULED OUT**（生产形态）；**REACHABLE**（一般形态） | 生产形态实测：warmup pin 与伪路径 dispatch 的 pid 相同、pool 只有 1 个 `typescript` key（§8.3）。一般形态可构造：嵌套 lockfile 时 warmup 的样本根 ≠ 伪路径根，产生 2 条 key、2 个 tsserver 进程，warmup 的 pin 对无 `file` 路径**完全不可见**（`<ROOT>/sub:typescript` vs `<ROOT>:typescript`，实测）。本 repo 不触发                                                                                                                                           |
| c   | `ctx.directory` 非仓库根                | **RULED OUT**（生产路径）                            | `build-engine.ts:620-632` 非 ask 面取 `mcpRoots.workspaceRoot`；`resolveWorkspaceRoot` 三级链 `[opts.workspaceRoot, env IKNOW_WORKSPACE_ROOT, cwd]`（`config/workspace-root.ts:151-171`），子目录不校验、原样返回——用户从子目录起会话时理论可达，本 repo 不触发。相关事实：worktree 场景下 `ctx.directory` = worktree（ADR-0019），与「用户心里的仓库根」同值                                                                                                   |
| c′  | **工作区级 dispatch 落到非目标 server** | **ESTABLISHED**（一般形态）                          | 目录内有 `.ts` 但**无 TS root marker** 时，typescript / pyright 各返 `no-root`（实测），第三个声明的 `yaml-language-server`（`root = ctx.directory`）**成为活 client**，`find_symbol` 返回**缺方法哨兵** `(LSP server does not implement workspace/symbol; use another tool for this query)`。模型读到的是「改用别的工具」，真相是「TS 从未被问过」——**误导性信号**。实测 `process.spawnargs[0]` = `node_modules/yaml-language-server/bin/yaml-language-server` |
| d   | `workspace/symbol` / tsserver 行为本身  | **ESTABLISHED**（主因）                              | §8.2–8.4：搜索集合 = `lastFileOrDummy()` 所指文件所属 project；inferred project 只含该文件 + import closure；tsconfig project 以 `include` 为界；锚点切换触发 project 重建并出现「有 → 无」的翻转                                                                                                                                                                                                                                                               |

### 8.6 无 `file` 路径可救吗？—— 可以，条件是**锚点必须落在目标 project 的 tsconfig `include` 内**

- **可救**（实测）：把锚点换成 `src/` 下任一文件，同一 client、同一查询在 ~7 s 内
  从 `0` 变 `4`，且 30 s+ 稳定（§8.2 锚点 A）。
- **不可救的地方**：无 `file` 的调用方**没有理由**知道该选哪个文件。warmup 现在的
  选择策略是「`readdir` 序第一个命中扩展名」——实测就是选错的那种（`archive/`）。
- **因此 T3 不该走「让 warmup 选得更聪明」这条路**（那是猜测项目布局）。可实施的
  修法只有两类：**(i) 把结果可信度做成返回值的一部分**（哨兵 / 警示），
  **(ii) 要求 `file` 锚点**（prompt / description 侧），二者不互斥。

### 8.7 哨兵措辞草案（T3 消费）

现有三前缀家族（`lsp.ts:181-239`）的判定语义：

| 前缀                                 | 语义                      | `isLspFailureSentinel` | probe verdict |
| ------------------------------------ | ------------------------- | ---------------------- | ------------- |
| `(no LSP server configured`          | 没有匹配的 server         | true（FAIL）           | fail          |
| `(no LSP project root found`         | 有 server、无 root marker | true（FAIL）           | fail          |
| `(LSP server … unavailable`          | spawn 失败 / bin 缺失     | true（FAIL）           | fail          |
| `(LSP server … does not implement …` | server 能力缺口           | **false**（skip）      | skip          |

**决定：家族不加第四条前缀分支。** 依据：

1. 三前缀判定的语义是「**这次调用没打成**」。`find_symbol` 无 `file` 返 `[]` 或
   瞬态——**调用打成了**，RPC 有响应。把它记成 probe FAIL，等于把
   `workspace/symbol` 记成 server 不可用，是**错误分类**（probe 的 FAIL 语义见
   `scripts/lsp-probe.ts:176-178`：`LSP server unavailable`）。
2. probe **从不调用** `find_symbol`、**从不进**这条分岔（§7.1 已写死）。新前缀在
   probe 端只会是死判定，收益为零。
3. 该信息的消费者是**模型**，不是 probe：它需要的是「结论不可信，换条路」，
   不是「LSP 坏了」。让 `isLspFailureSentinel` 保持 false，模型不会被误导成
   「LSP 不可用」，也不会挡住后续符号工具的可用性判断。
4. 与既有判定的耦合为零：新文案不含 `" does not implement "`，天然不被
   `isMethodNotFoundSentinel` 吃掉；不含 `" unavailable"`、不以另两个前缀起头，
   天然不被 `isLspFailureSentinel` 吃掉。**无需改判定函数。**

**T3 应返回的确切字符串（两条，按可达状态二选一）：**

1. 无 project 锚点（`No Project.` / 空返回 / RPC 异常，模型无法据结果行动）：

```text
(LSP workspace/symbol has no project anchor under <ctx.directory>; an empty result from this path is not trustworthy — pass file=<a file inside the project to search> or use get_symbols_overview on a known file)
```

2. 有结果但覆盖不可保证（正常返回、含空数组）：

```text
(LSP workspace/symbol coverage is not authoritative: the server only has the documents it was asked to open; pass file=<a file inside the project to search> to anchor the search, or use get_symbols_overview on a known file)
```

两条都以 `(LSP ` 开头，与家族文风一致；实测
`isLspFailureSentinel=false`、`isMethodNotFoundSentinel=false`、
`classifyProbeResult → pass`，**即：按设计不被降级为 FAIL / skip**。

**T3 若选择只加第一条（降低噪声）**，则第二条降级为 `find_symbol` 的
description 文案（模型可见装配面 → 走 `docs/guides/prompt-development.md`
黄金集），哨兵家族仍**不加分支**。

### 8.8 复现环境与命令

```bash
git rev-parse --short HEAD        # 21bd5805 = 测量时的基线；此后 T1/T4/T5 已并入
                                  #   （a7badf7b / 835498c6 / f5506090）。本节所有
                                  #   行号已对照并入后的 HEAD 复核
node -v                           # v22.23.2
npx tsx --version                 # tsx v4.23.0
# typescript 5.9.3 / typescript-language-server 5.3.0（node_modules 实测版本）
```

全部实验经 `npx tsx -e '<script>'` 直跑真实栈（`createSymbolQueryToolSet` +
真实 `getClient` / `startLspWarmup`），夹具写在 `.iknow/t2-fixtures/<case>/`
（gitignored）。复现核心两行：pin 一个 tsconfig `include` 之外的文件 →
`find_symbol({ query: "<src 里的符号>" })` 观测 `[]`；把锚点换成 `include` 之内
的文件 → 同一查询在 ~7 s 内出现命中。

### 8.9 未建立的事项（如实记录）

1. **project 选择规则未逐行读码证实**。「inferred project 只含 pin 文件 + import
   closure」「project 切换触发卸载 / 重建」是从行为观测 + `getFullNavigateToItems`
   的 `getProjects(args)` 调用推出的模型。`getProjects` 内部的 project 优先级
   打分没有逐行读，§8.4 的瞬态成因因此标为**推断**。
2. **首查延迟无可信阈值**。~7 s 是本机（WSL2）单次观测，且 tsserver 仍在后台
   继续加载；没有做跨机器 / 冷热盘对照，不能据此定 wait 策略。
3. **`No Project.` 与 `[]` 之间的完整状态机未穷举**。已观测到：抛 `No Project.`
   （`<syntax>` / `<semantic>` 两种前缀）、返 `[]`、返部分命中、命中数回落。
   哪些条件组合产生哪一种，没有跑全矩阵。
4. **多语言 server 行为未测**。§8.2 的锚点机制只对 `typescript-language-server`
   - tsserver 成立。pyright / yaml / json / dockerfile 对 `workspace/symbol` 的
     锚点语义（多数直接 MethodNotFound）未单独测。
