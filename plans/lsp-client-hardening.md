# Plan: lsp-client-hardening

**Goal:** 现有 LSP 连接在长 session / worktree rebind 下不漏子进程；已打开文档与磁盘在下一次工具调用前对齐；缺方法时返回可读哨兵。不加语言、不加 ACI 工具、不上盘监听。
**Approach:** 未打开的文件由 language server 自己跟磁盘，harness 不接收、也不需要实时推送。已打开的文件以 client 缓冲为准：`edit_file` 成功仍即时 `didChange`；盘外变更不 watch，在下一次请求前对当前仍打开的 uri 比对 mtime，过期则 `didChange`。请求级 `didOpen`/`didClose`（refcount）让两次调用之间文件关上，下次 `didOpen` 直接读盘。idle / rebind / `disposeAll` 与退出路径一样终结子进程；工具 abort/超时仍只 `$/cancelRequest`。`initialize` 只广告实际会发的 method；server 欠声明的能力仍尝试，`-32601` 转哨兵。
**Spec link:** `specs/251-lsp-tool.md`（T1 amend）；`specs/302-lsp-multilang.md` 只消费现有 5 门语言，不开 PATH 二期。
**ACR:** all-yes（见下块）
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion（landing grain: operator global commit section）
**待写入:** 无

## ACR

affected files (planned): `specs/251-lsp-tool.md`, `src/harness/lsp/client.ts`, `src/harness/aci/tools/lsp.ts`, `scripts/lsp-probe.ts`, `tests/harness/lsp/client-shutdown.test.ts`, `tests/harness/lsp/client.test.ts`, `tests/harness/aci/lsp.test.ts`

affected files (actual, 落地后回填): 上述 7 件全部命中，另加 4 件 —— T3 的 Surface「现有 `ensureOpen` 调用方」把它们纳入：`src/harness/aci/tools/symbol.ts`、`src/harness/aci/tools/symbol-mutate.ts`、`src/harness/aci/tools/symbol-resolver.ts`（缓存键改内容指纹，T3 的强制推论）、`tests/harness/lsp/live-directory.test.ts`（T2 rebind 语义更新 + 多 server 回收用例）。均为同一逻辑任务内的调用方迁移，非 scope creep。

bounded-context-guardian: yes — 改动留在 `src/harness/lsp` 与 ACI `lsp.ts` / probe 消费方；`permission/`、`server.ts` 语言表、registry 工具件数不动，无新 bounded context。
input-contract-tests: yes — 公开 ACI 入参 schema 不变；新增的是输出哨兵与生命周期。T4 覆盖 MethodNotFound/显式 false 两条失败输出，empty client / timeout 仍走现有 sentinel 与 `ToolExecutionError`。
error-handling-enforcer: yes — 工具路径仍不 `kill`；池回收杀进程是 EXIT 明确的生命周期终态；RPC `-32601` 转 Y1 哨兵，不空 catch；initialize 失败仍 broken/spawn-failed。
complexity-anti-drift: yes — 三刀切开：进程收口、打开文档 refcount、请求前 mtime + 缺方法哨兵；不在 `client.ts` 加 watcher 或 document editor。
minimal-change-verifier: yes — 一逻辑任务（现有 5 门语言上的连接卫生）；不做新语言、新工具、payload 1-based 翻译、incremental sync、`didChangeWatchedFiles`。

## Tasks (ordered by dependency)

1. **Amend spec 251 生命周期与打开文档契约** — tag: `[decision]`
   - **Inherits:** spec 251 Q2/A9：工具 cancel 不杀 language server 子进程；handler 仍 Y1 纯字符串、不增工具。本票改写「唯一杀进程点是宿主退出」为：池回收（idle / rebind / `disposeAll`）与退出路径终结子进程。打开文档：请求级 refcount，归零 `didClose`。盘外变更：无实时通知；下一次请求前对齐仍打开的 uri。`initialize` 广告实际使用的 textDocument/workspace 能力；server 返回缺席 ≠ 不支持。语言表与 `ACI_TOOLSET_NAMES` 不变。
   - **Surface:** `specs/251-lsp-tool.md`
   - **Acceptance:** spec 合同段写齐上述 EXIT；明确不做 watcher / 新语言 / 新 ACI / 坐标 payload 翻译；正文无代码。
   - Status: [x] done

2. **池回收终结子进程** — tag: `[implementation]`
   - **Inherits:** T1：idle sweep、worktree rebind stale sweep、`disposeAll` 与 `shutdownAll` 一样结束子进程；`shutdownAll` 仍 latch 禁止再 spawn；工具超时/abort 不 `kill`。
   - **Surface:** harness LSP client 连接池
   - **Acceptance:** idle / rebind / `disposeAll` 之后真实子进程退出；`shutdownAll` 后再 `getClient` 为 spawn-failed；现有 `tests/harness/lsp/client-shutdown.test.ts` 所守的退出缝不回归。`npm test` 中该文件与 `tests/harness/lsp/client.test.ts` 绿。
   - **落地补记（超出字面、落在 Goal 内）:** rebind sweep 原先按当前 serverId 过滤，导致旧根下**其它语言**的 client 在 `lastSeenTaskRoot` 更新后永久扫不到（真实泄漏）。去过滤后按根整体回收；`client-shutdown.test.ts` 与 `live-directory.test.ts` 各有用例钉住。
   - Status: [x] done
   - [blocks: T1]

3. **请求级 didOpen / didClose（refcount）** — tag: `[implementation]`
   - **Inherits:** T1：同一连接上对同一 uri 的重叠请求共享打开；refcount 到 0 发 `didClose` 并丢掉打开记录与该 uri 诊断缓存。两次调用之间文件不对 server 保持打开。
   - **Surface:** harness LSP client + 现有 `ensureOpen` 调用方
   - **Acceptance:** 单次请求顺序为打开 → RPC → 关闭；两次并发同文件只关一次（最后一位）；**重叠作用域内文档始终处于打开态**（第二个作用域不得落在已 `didClose` 的窗口 —— refcount 占位须与在册判定同一 tick，见 S16）；关闭后下次请求重新 `didOpen`。`tests/harness/lsp/client.test.ts` 绿。
   - **落地补记（T3 的强制推论）:** `symbol-resolver` 的缓存键从 `getOpenVersion` 改为内容指纹 `getDocumentFingerprint` —— 请求级打开使 version 每次从 1 起重来，版本号无法区分两次打开，沿用旧键会在盘外改动后永久返回陈旧符号树。
   - Status: [x] done
   - [blocks: T2]

4. **请求前对齐打开文档 + 缺方法哨兵** — tag: `[implementation]`
   - **Inherits:** T1：`edit_file` 即时 `didChange` 保留。盘外变更无 watcher。发 RPC 前对**当前仍打开**的 uri `stat` mtime，变了则 full `didChange`（含即将使用的目标文件）。`initialize` 非空、仅广告已用 method。provider 显式 `false` 不发 RPC；缺席或 `true` 照发。`-32601` / Unhandled method → Y1 哨兵，**不算** spawn 失败。probe 将该哨兵视为现有 MethodNotFound-skip；TS call hierarchy 仍真实执行。
   - **Surface:** harness LSP client、ACI `lsp.ts`、`scripts/lsp-probe.ts`
   - **Acceptance:** 打开后改磁盘 mtime、不经 `edit_file`，下一次符号/诊断请求前发出 `didChange`；yaml 类缺方法返回哨兵且 probe skip；`npm test` 中 `tests/harness/aci/lsp.test.ts` 与 lsp client 测试绿；`npm run probe:lsp`（typescript）不丢 call hierarchy。
   - **落地补记（review 修复）:** 哨兵/能力闸门原只挂在 `requestOrMethodNotFoundSentinel` 一条路径，`symbol-resolver` 的 `textDocument/documentSymbol` 直连 `sendRequest` 绕过了它 —— 符号族（所有 symbol-* 工具的入口）因此拿不到「显式 false 不发 RPC」与「`-32601` 转哨兵」两条语义。修复后该路径同样走门控。
   - Status: [x] done
   - [blocks: T3]

## Out of scope

- 新语言 / PATH server
- 新 ACI 工具（completion、codeAction、rename）
- `didChangeWatchedFiles` 或其它实时盘监听
- Location 1-based 翻译、incremental `didChange`、换 JSON-RPC 栈
- `workspaceFolders` 多根（现有 `rootUri` + `NearestRoot` 足够）

## Code review phase

全部子弹落地后跑一轮 `code-review`；`GATE: BLOCKED` 则下一槽 `review-report-repair`。
