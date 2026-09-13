# Spec: grep 一波可活过坏 output 与单 call 超时

## Objective

模型一波里并行 `grep` + 其它工具时：常见 `output` 别名能搜；单条工具撞上 ACI default 档超时只失败这一 call，回合继续，成功兄弟的 tool_result 仍交给模型写终答。验收会话形态：校验失败或单 grep 超时不得把 session/turn 标成 timeout。

## Boundaries

- **Does:** `grep.output` 入参别名归一到既有三种出法；loop 把「单 call 工具超时」与「回合超时」拆开；大目录 `grep` 在工具侧可提前短失败（不必空转到档位钟）；TUI auto 权限下一轮真会话 + trace 读侧三工具核验。
- **Confirms with human:** （已确认）`files_with_matches` → `paths`；单 call timeout ≠ 整回合 timeout。大仓提前停的具体闸（文件数 / 字节 / 早于 30s）实施可定，须可测。
- **Out of this spec:** 围栏 / 垫底路径 / 全局档 vs 工作区档；把 `files_with_matches` 做成第四种搜引擎出法；改 `timeoutTier` 毫秒表；子代理 per-task 钟；权限模式本身。

## Success Criteria

- **SC1（别名）**：`output=files_with_matches` 与 `output=paths` 对同一夹具目录得到同一路径名单（相对路径、排序、条数规则仍 D2/D3）。未知 `output` 仍 typed 失败，文案含合法值。
- **SC2（默认不变）**：不写 `output` 仍是 `paths`；`content` / `count` 字节级语义不变（`specs/aci-file-search-surface.md` D2/SC5）。
- **SC3（单 call 超时）**：一波 ≥2 个 tool_use，其中恰好一条 `execution_failed` 且 `message` 为 `"timeout"`、另一条 `ok`，且调用方 `signal` 未 abort → loop **continue**，turn/session **不是** `StopReason: timeout`。
- **SC4（真回合超时）**：调用方 `signal.aborted`（既有 cancelled 优先）仍按 `computeToolStopFlags` 停回合；不把 `"timeout:…"` 前缀误判为 timeout（既有 SC16 严格 equal 保留在 **signal** 判定上，不再用「结果里有一条 timeout」当回合钟）。
- **SC5（大仓）**：`path` 指向过大树且无缩小 `glob` 时，`grep` 在档位钟之前返回短错误（范围太大 / 请收窄），`kind` 不是把整回合标 timeout 的那条路径。
- **SC6（说明书）**：改 `grep` description / schema 枚举则夹具或登记缺口（`docs/guides/prompt-development.md`）。
- **SC7（真会话）**：TUI **auto** 权限模式下一轮：并行非法-or-别名 `grep` + 慢 `grep` + 成功只读 `bash`；结束后 trace 读侧 `list_sessions` → `query_trace`：最新会话 `session.status` 不是 timeout；存在 `ok` 的 bash tool_call；工作轮有终答或 continue 后的 assistant 文本（不是只剩超时 summarize）。

## Open Questions

（none）

## Inherits / Changes

**Inherits:** `specs/aci-file-search-surface.md` D2 三种出法 `paths` / `content` / `count`、默认 `paths`、`head_limit`；ADR-0005 单 call 超时仍返回 `"timeout"` 给 **该条** 结果；`tests/harness/aci/interrupt-routing.test.ts` cancelled 优先于 timeout；signal 未 abort 时 `"timeout:foo"` 不误判。

**Changes:** D2 增加入参别名 `files_with_matches` ≡ `paths`（只换标签，搜法仍 paths）。Loop：`StopReason: timeout` **不再**由「结果数组 `some` 一条 `"timeout"`」触发，只由外层 abort/回合钟触发。单 call 超时走 in-flight closeout 的 **该条** `execution_failed`，回合 `continue`。

**Amends:** `specs/aci-file-search-surface.md` D2。

> Contradicts 现行 `computeToolStopFlags`「任意一条 message===timeout → timedOut」（`loop-engine.ts` + interrupt-routing SC16 第一例）— worth reopening as ADR-0091 because 档位钟是单 call 护栏，升格为会话死因会丢掉同波成功结果。
