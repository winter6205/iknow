# Plan: grep 一波可活过坏 output 与单 call 超时

**Goal:** `grep` 认 `files_with_matches` 为 `paths`；单条工具超时不把回合判死；大仓 `grep` 可提前短失败；TUI auto + trace 读侧真会话验收。
**Approach:** 先锁 ADR-0091（回合钟 ≠ 档位钟），再并行改 grep 入参与 loop 判定，然后大仓闸，最后真 TUI。不碰围栏/垫底，不新增第四种搜法。
**Spec link:** `specs/grep-wave-survive.md`（amends `specs/aci-file-search-surface.md` D2）
**Worktree:** `.iknow/worktrees/grep-wave-survive`（branch `feat/grep-wave-survive`）
**ACR:** all-yes（block below）
**T1–T4:** all done（TC/TDD/实测见各 T 与 T4 Evidence）
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion

## 黄金集登记

按 `docs/guides/prompt-development.md` 名册 + `specs/aci-file-search-surface.md` D7，`grep` 本轮改了 `output` schema enum（加 `files_with_matches` 别名）+ 失败文案（列出合法值）。两条都是模型可见的、归 1 类。本轮不补轨迹集，理由：纯值集扩展 + 更清楚的失败文案（模型能直接复用 enum 给出合法值），不开新分支、不动工具选择分歧；真模型 e2e 的成本不抵收益。在名册「tool description」行留痕。

## Architecture Change Reviewer verdict

```
bounded-context-guardian: yes — grep 入参留在 harness ACI 搜面；回合停因留在 loop-engine；trace 读侧只作验收消费，不改 MCP 契约。
defensive-contract-validator: yes — 别名 empty/未知值/合法三态；超时 mixed ok+timeout / 仅 timeout / signal abort / 前缀 timeout:foo；大仓 overflow；并发 N/A（handler 无共享可变状态，isConcurrencySafe 已声明）。
error-handling-enforcer: yes — 未知 output typed 失败；单 call timeout 仍是该条 execution_failed；回合 timeout 只走外层 abort；大仓短错误 EXIT 为 tool_result 非会话死。
complexity-anti-drift: yes — 别名归一一个函数；computeToolStopFlags 收窄判定；大仓闸不塞进 grep handler 主路径一坨。
minimal-change-verifier: yes — 一逻辑任务（一波工具可活过坏 output 与单 call 超时）；围栏/全局档/工作区档不进本 diff。
```

## 待写入（persist）

- CONTEXT：`per-call tool timeout` vs 回合 `StopReason: timeout`（本轮 ADR-0091 + CONTEXT 对照条已在 worktree 落地）。
- ADR-0091 accepted（本 worktree 已写）。

## Tasks (ordered by dependency)

1. **T1 入参别名 `files_with_matches` → `paths`** — tag: `[implementation]` `[parallel]`
   - **Inherits:** spec SC1/SC2；`aci-file-search-surface` D2 三种出法不变；未知值仍拒。
   - **Surface:** harness ACI `grep` 入参（schema 与 handler 入口归一）。
   - **Acceptance:** `files_with_matches` 与 `paths` 同夹具路径名单一致；默认仍 `paths`；乱 `output` 失败文案含合法值；`npx vitest run tests/harness/aci/tools/grep.test.ts tests/harness/aci/search/options.test.ts` exit 0。改 description/schema 则夹具或登记缺口。
   - Status: [x] done

2. **T2 单 call timeout 不升格为回合 timeout** — tag: `[implementation]` `[parallel]`
   - **Inherits:** ADR-0091；spec SC3/SC4；cancelled 仍优先；`"timeout:foo"` 仍不误判。
   - **Surface:** loop-engine 工具阶段停因（`computeToolStopFlags` 及其调用点）；interrupt-routing 验收。
   - **Acceptance:** 一波 ok + `"timeout"` 且 signal 未 abort → continue、turn 非 timeout；signal abort 仍停；单测改写 SC16「仅一条 timeout 无 signal」为 **timedOut false**（回合不因该条停）；`npx vitest run tests/harness/aci/interrupt-routing.test.ts` 及相关 loop 套件 exit 0。
   - Status: [x] done
   - **Note:** > Contradicts 旧 SC16 第一例 — 以 ADR-0091 为准。

3. **T3 大仓 `grep` 提前短失败** — tag: `[implementation]`
   - **Inherits:** spec SC5；档位钟仍可作后盾；不把该失败写成回合 timeout。
   - **Surface:** harness ACI 搜面（walk/引擎入口的范围闸，`src/harness/aci/search/scope-guard.ts` 集中 SSOT）。
   - **Acceptance:** 无 `glob` 的过大 `path` 在 default 档到点前返回短错误；小夹具目录行为不变；grep 单测 + 既有搜面测绿。
   - **Tradeoff（产品可见）**：workspace 文件计数超 `GREP_SCOPE_FILE_LIMIT = 10_000`、且调用方没传肯定 `glob` 时，`grep` 直接给短错误——用户必须先收窄（`glob` / 子目录）才能跑。SC5 授权「具体闸…实施可定」，门限与豁免规则见 `scope-guard.ts` 文件头 + `docs/STATUS.md` 同步登记。
   - **Cost（工程可见）**：闸走 `walkFiles` 一次（命中 cap+1 即停）作为前置判定，**每个目录 `grep` 都付这一遍**，即使自带 rg 在场、即使最终会走 rg。两条引擎共用本模块（D6/SC9「同一个 `path` 同判」）让这一遍无法按引擎跳过。闸只看文件数，目录多但文件少的树仍可能穿过 → 档位钟仍是后盾。
   - [blocks: T1]（共用 grep 入口，避免两波改 schema/handler 互踩）
   - Status: [x] done

4. **T4 TUI auto + trace 读侧真会话** — tag: `[implementation]`
   - **Inherits:** spec SC7；读侧三工具既有契约（`list_sessions` → `query_trace`）；TUI 权限 **auto**（ADR-0032：auto 是权限档，不是 goal）。
   - **Surface:** TUI 真进程 + 本机会话池 + trace 读侧（MCP 或同进程等价三工具）。
   - **Acceptance:** auto 档下一轮并行：别名或曾非法的 `output` grep、一条会超时的宽 `grep`、一条成功只读 bash。结束后读侧：最新 `conversation_id` 的 session 记录 **不是** timeout；有 bash `status=ok`；工作轮有模型终答（非只超时 summarize）。证据写入本计划 T4 Evidence（命令、conversation_id、query_trace 摘录）。
   - [blocks: T1, T2, T3]
   - Status: [x] done

### T4 Evidence

会话 `5b595496-83c1-42a8-a661-5db80834d39d`（TUI `--auto-mode` = `full_auto`；隔离 `--data-dir` / `--workspace-root`）。
一轮并行波（同一 `parent_llm_call_id` `0d22185e`）三条调用，trace 原始记录：

| tool_use input                                                        | tool_result                                           | 读侧 `status` |
| --------------------------------------------------------------------- | ----------------------------------------------------- | ------------- |
| `{"pattern":"needle0","path":"narrow","output":"files_with_matches"}` | `narrow/one.txt`                                      | `ok`          |
| `{"pattern":"anything","path":"blocked.pipe"}`                        | `[execution_failed] timeout`（`duration_ms`=30067.8） | `error`       |
| bash `echo wa`                                                        | `{"code":0,"stdout":"wa\n","stderr":""}`              | `ok`          |

- session 根记录：`status: "ok"`、`error` 缺席（**不是** timeout）；turn `decision: completed`。
- 工作轮模型终答存在（指明哪条成功 / 哪条失败），不是只剩超时 summarize。
- 提示词被 TUI 输入框在 `echo wa` 处截断（草稿输入框字符限制），所以模型收到的是 `echo wa`，trace 落 `{"command":"echo wa"}` → `{"code":0,"stdout":"wa\n","stderr":""}`；`echo wave-ok` 属于稍后一轮被取消的回合，不混入本 ok-turn 证据。
- 读侧路径：`scripts/iknow-trace-mcp-dev.cjs`（真 stdio MCP）→ `list_sessions` → `query_trace`（`record_type: session` / `tool_call` / `llm_call`）。
- 「慢 `grep`」用命名管道 `blocked.pipe` 造**真** 30s 档位钟（rg 在 FIFO 上阻塞），非 stub —— 旧行为此 session 会落 `StopReason: timeout`。
- 备注：T4 期间 `/quit` 曾在草稿输入未清时二次成回合（trace 第二条 session 记录 `cancelled`）；上表取首回合（`status=ok`）为准，该噪声与本次改动无关。

## Code review phase

全部 implementation bullet 落地后跑一轮 `code-review`；`GATE: BLOCKED` → `review-report-repair`。
