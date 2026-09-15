# Handoff: LSP client 连接卫生（T1–T4 + review 修复轮）

日期：2026-09-15
分支：`feat/lsp-client-hardening`（base `172f5391`）
契约：`specs/251-lsp-tool.md`「生命周期 / EXIT 合同」（S15–S18）
计划：`plans/lsp-client-hardening.md` T1–T4

## 交付内容

| Task                  | 内容                                                                                                                                                                                                                                                                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1 `[decision]`       | spec 251 新增「生命周期 / EXIT 合同」：进程生命周期（工具 cancel 只发 `$/cancelRequest`；idle/rebind sweep 与 `disposeAll` = dispose + SIGTERM + 逐出、无 latch；`shutdownAll` 额外置单向 latch）、打开文档生命周期（请求级 refcount + pin 例外）、盘外变更对齐（无 watcher，请求前 stat mtime）、initialize 能力广告 + 缺方法哨兵。补 S15–S18 |
| T2 `[implementation]` | 池回收终结子进程：统一 `terminate(key, client)`；`sweepStaleClientsForRebind` 改池方法 `sweepStaleForRebind` 并**去掉 serverId 过滤**（修真实泄漏：rebind 后旧根下其它语言的 client 永久扫不到）                                                                                                                                               |
| T3 `[implementation]` | 请求级 `withDocumentOpen<T>(file, fn)`：单一 `openDocs` 记录（`{version, refs, pinned, fingerprint, mtimeMs}`）、`opening` in-flight 去重、try/finally 归零、归零丢打开记录与诊断缓存。调用方全量迁移（`lsp.ts` / `symbol.ts` / `symbol-mutate.ts`）                                                                                           |
| T4 `[implementation]` | `alignToDisk` 请求前 mtime 对齐；`initialize` 改发真实能力广告；`METHOD_NOT_FOUND` / `serverDeclaresUnsupported`（**缺席 ≠ 不支持**，只有显式 `false` 裁剪）；`renderMethodNotFound` 哨兵；probe 哨兵判定从 src 侧复用                                                                                                                         |

## Review 修复轮（`code-review` GATE: BLOCKED: 1 High）

| 簇                      | Finding                                                                                                                                                      | 修复                                                                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A 并发 / refcount       | **High**：`withDocumentOpen` 占位跨两个 await，`closeDocument` 同步 delete → 重叠作用域第二个可能**不占 ref** 就进 body（文档已关窗口），违反接口 doc 与 S16 | 占位与在册判定同 tick：`while (!entry) { await openDocument; entry = openDocs.get(uri) }` → `entry.refs += 1`；`alignToDisk` 移到占位之后；释放按**捕获的 entry 身份**判定（条目被重开成新对象则不误关） |
| A 并发 / refcount       | Low：`notifyChange` 新分支无直接单测                                                                                                                         | 补两条（未打开 → didOpen→didClose；已打开 → 恰好一次 full-sync didChange）                                                                                                                               |
| B 能力闸门 / 哨兵覆盖面 | Medium（Spec）：`symbol-resolver` 的 `documentSymbol` 直连 `sendRequest`，绕过能力闸门与 `-32601` 哨兵 → 符号族拿不到两条语义                                | 收敛到 `requestOrMethodNotFoundSentinel` 单一入口；`SymbolResolution` 加 `method_not_found` 失败态；工具层统一 `renderMethodNotFound`；补 20 条用例                                                      |
| B 能力闸门 / 哨兵覆盖面 | Low：指纹缓存键改动无单测                                                                                                                                    | 补双向用例（内容变 → 重取；内容不变 → 命中缓存）                                                                                                                                                         |
| C fallback 分支         | Medium：新增裸 `catch` 缺 `// EXIT:` marker                                                                                                                  | `mtimeOf` / `alignToDisk` 各补 marker（说明退出条件与行为）                                                                                                                                              |
| D 文档与代码漂移        | Medium：spec 写「两次调用之间不对 server 保持打开」为绝对句，实现保留 pin 旁路（warmup 生产可达）                                                            | spec 补「pin 例外（预热）」小节 + Boundaries 与 S16 同步；`:259` 过时的「不预热」一并改准                                                                                                                |
| D 文档与代码漂移        | Low：`METHOD_CAPABILITY_KEYS` doc 举例 `workspace/symbol` 却在表内；注释仍写 `ensureOpen`；describe 拼写                                                     | 三处均改（doc 举例改 `callHierarchy/incomingCalls`；注释改 `withDocumentOpen`；`capabilitiy`→`capability`）                                                                                              |

## 实测证据（MCP 真实交互 + 真实 language server）

TUI 实机面**不可用**（见「未覆盖」）；以下为真实进程 / 真实 server / 真实模型会话的证据。

| 项                         | 手法                                                                                                  | 观测                                                                                                                                                                                                         | 判定 |
| -------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| V1 池回收终结真实子进程    | `getClientDetailed()` 起真实 `typescript-language-server`，逐缝断言 `/proc/<pid>` 消失                | 4 缝全 `alive=false`：idle sweep / rebind / `disposeAll` / `shutdownAll`；`disposeAll` 后**可重新 spawn**（新 pid），`shutdownAll` 后返 `{"reason":"spawn-failed"}`（latch）；孙进程 tsserver 一并消失无孤儿 | ✅   |
| V2 请求级 didOpen/didClose | 经 `LspCtx.resolveBin` 注入帧记录 shim，抓 harness↔server 原始 JSON-RPC 帧                            | 单请求帧序 `didOpen → documentSymbol → didClose`；3 并发同 uri `didOpen=1 / documentSymbol=3 / didClose=1`；重开再次 didOpen；回程符号树非空（228 symbols）                                                  | ✅   |
| V3 盘外 mtime 对齐         | `ensureOpen` pin 住 → 会话外 `appendFile + utimes` 改盘（**绕过 edit_file**）→ 再发请求               | 帧序 `documentSymbol(id:6) → didChange(version 1→2, 全文) → documentSymbol(id:7)`；id:6 无 probe 符号、id:7 **含** `lspMtimeProbe`；对照（mtime 未变）**零**冗余 didChange；探针写入已复原                   | ✅   |
| V4 缺方法哨兵              | 真实 yaml-language-server `lsp_references` / `lsp_workspace_symbol`；`serverDeclaresUnsupported` 直调 | 返回纯字符串哨兵、`isMethodNotFoundSentinel=true`、`isLspFailureSentinel=false`；哨兵后 client 仍可复用；显式 `renameProvider:false` → 哨兵且 **RPCs sent=0**，缺席（`callHierarchyProvider` 缺声明）→ 照发  | ✅   |
| V4 探针层                  | `npm run probe:lsp -- --lang typescript` / `--lang yaml`                                              | TS **10/10 all green**（含三件 call hierarchy，未被哨兵短路）；yaml **4/4** + 6 条 `skipped: MethodNotFound sentinel`；两者 exit 0                                                                           | ✅   |
| 真实会话（chat REPL）      | `script -q -f -c "npm run dev chat"` 真 TTY，`/quit`                                                  | 两个 language server 在 **REPL 进程之前**消失（11.439 vs 11.597，差 158ms）→ 是 `shutdownDefaultLspPool()` 主动终结，非父死连带；终态本 worktree LSP 进程数 = 0                                              | ✅   |
| 真实会话（ask）            | 真实模型一次 turn 调 `get_symbols_overview`                                                           | tool_call `status=ok`，模型真实消费到结果                                                                                                                                                                    | ✅   |

## 自动化验收

| 命令                                                              | 结果                                        |
| ----------------------------------------------------------------- | ------------------------------------------- |
| `npx tsc -p tsconfig.json --noEmit`                               | exit 0                                      |
| `npx vitest run tests/harness/lsp/ tests/harness/aci/lsp.test.ts` | **200 passed / 6 files**（修复轮前 183）    |
| `npx vitest run tests/harness/aci/`                               | **1605 passed / 71 files**（修复轮前 1585） |
| `npm run probe:lsp -- --lang typescript`                          | 10/10 all green，exit 0                     |
| `npm run probe:lsp -- --lang yaml`                                | 4/4（6 skip），exit 0                       |
| `npm run lint:s5`                                                 | 全部 touched function within baseline       |
| pre-commit 全量（commit 时钩子）                                  | **236 files / 3454 tests passed**           |

**承重取证（mutation）**：把 H1 修复还原成修复前形态 → 新增用例红（`openedInBody` 期望 `[true,true]` 实得 `[true,false]`，即第二个作用域进入时文档已关）；恢复后 44 passed。Cluster B 侧同法验过能力闸门（短路回直连 → 5 failed）与指纹缓存（双向回退各红一条）。

## 未覆盖 / 缺口

| 项                              | 状态               | 原因                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TUI 实机验收面**              | **未覆盖（缺口）** | 本机 TUI **环境级损坏**：`npm run dev:tui` 报 `TUI 渲染后端初始化失败：[object Object]`。**已实证与本次改动无关** —— 同一失败在 master 主 checkout 同样复现，且本 diff 未触碰 `src/tui/`。用户指示勿修。替代面为 chat REPL + ask（同一 `build-engine` 装配）。按 `.claude/rules/test.md` 记 `Validation: Not run / Expected command: npm run dev:tui / Blocking issue: 渲染后端初始化失败（环境级，master 同现）` |
| ask 面 turn 后进程不退出        | 预存在（非本分支） | `runOneShot` 无退出缝（`src/cli.ts`），master 对照同样 `RC=124`；turn 本身 `stopReason: completed`                                                                                                                                                                                                                                                                                                                |
| piped chat 的 ask 提示饥饿      | 预存在（非本分支） | `createTtyAskUser` 内层 readline 关闭后 `input.isPaused=true`，外层永久收不到行；三个相关文件与 master 逐字节相同                                                                                                                                                                                                                                                                                                 |
| `get_symbols_overview` 双层截断 | 观察项（非缺陷）   | `lsp.ts` 48KB 截 + executor 20KB 硬顶（契约 X），模型拿到残片                                                                                                                                                                                                                                                                                                                                                     |

## 风险

1. **TUI 面零覆盖**：TUI 特有路径（ink `useInput`、busy 期模式切换）未验证；建议 TUI 可用环境补跑，或明确接受该缺口。
2. **master 已删 `specs/` 与 `plans/`**（commit `5ae9889a`）：本分支 T1 的交付物落在 `specs/251-lsp-tool.md`，与 master 合并时产生 **modify/delete 冲突**（`git merge-tree` 已实证）。该删除经查证为**过宽误删**（同一 commit 新增的 `docs/guides/lsp-client-analysis.md` 仍把 `specs/251-lsp-tool.md` 声明为 SSOT；删除前 20 分钟的 commit 明写「活约定是根 `plans/`」；master 自身 README/CLAUDE/STATUS/CONTEXT 大面积悬空引用）。归档副本 `docs/archive/025-.../specs/251-lsp-tool.md` 与 base 版本**逐字节相同**，可无损取回。落地方向需 operator 决策：恢复 master 的 `specs/`+`plans/`，或确认新落点后重放 T1。
