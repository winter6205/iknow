# Session Handoff — trace-mcp 读侧三面拆分（T1–T6 已交付，T7–T8 待续）(2026-09-02)

## 当前 live 状态

- **任务**: 把 trace 读侧拆成三条正交轴（目录 / 行 / 内容），共用一个 `src/traceserver/` 核，各挂两张薄皮（进程内 ACI + stdio MCP），并在过程中消灭「工具自带字符帽」这个伪分页机制。
- **为什么重要**: 拆之前 `query_trace` 一次只看一个文件、下钻要么被静默缩成 preview 要么拿不到，且两张皮都在 description 里宣称有 4000 字符帽（MCP 那句是假称）。外部 agent 因此无法可靠地读到一条大记录的任何一段。
- **operator 显式指令**: 进入工作树 `.qoder/worktrees/trace-mcp-read-side-split`，按 `plans/trace-mcp-read-side-split.md` 串行执行 T1→T8，每票走 tdd → 门禁 → 两轴 code-review → verification → 单 commit；本轮结束时「整理好、把你这边部分的开个 PR，剩下的任务交接，下一个会话新开一个 PR 继续」。

## 已固化工件（引用，不复制 inline）

| 类型                                                        | 路径 / URL                                                                                                                                                  |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 计划（含 15 条开工前/收尾订正，**实现判据以这些订正为准**） | `plans/trace-mcp-read-side-split.md`                                                                                                                        |
| 现役 spec                                                   | `specs/trace-mcp-server.md`（v1.1，SC6/SC7/SC8/SC15/SC16/SC18/SC20 在本轮生效）                                                                             |
| 行轴旧 spec（T7 须同步）                                    | `specs/query-trace-tool-results.md`                                                                                                                         |
| 决策记录                                                    | `docs/adr/0004-tool-layer-six-tool-set.md`（契约 X，`:23`）、`docs/adr/0006-*`（`:22` 读单元 vs 兜底帽、`:29` 双层截断）、`docs/adr/0020-*`（面板信封语义） |
| 领域词（**尚未写入**）                                      | `docs/CONTEXT.md` — read unit / window / tool face / panel face 四条在 plan §待写入，等整轮收尾走 `domain-modeling`                                         |
| 面板面（SC15 冻结件）                                       | `src/traceserver/http.ts` — 本轮全程 0 字节改动                                                                                                             |
| PR                                                          | 见本分支 `worktree-trace-mcp-read-side-split`（T1–T6，本轮开出）                                                                                            |

## 本 session 变更

分支 `worktree-trace-mcp-read-side-split`，基线 `e9409fc2`（其父 = master `b99492f2`）。**master 是本分支祖先**，PR 无冲突面。

| commit                           | 一行效果                                                                                                                                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bc560655`                       | spec v1.1：三面白名单 + read unit 词表 + SC6–SC8 改写 + SC16 前缀归属                                                                                                                         |
| `7d445e67` `f75ad5a1` `65274cf9` | plan 订正：T3 逃生口被实测证伪后改形、record_id 扫描测给 120s、标注派生量非实测                                                                                                               |
| `b71cb9c3`                       | 现役核 characterization 测（动手前钉住今天的真实行为，含 P0 静默降级）                                                                                                                        |
| `b5f75e63`                       | **P0**：下钻整条返回，`compactRecord` / `response_truncated` 退场                                                                                                                             |
| `27edf413`                       | plan 订正：残留 4000 假称全部划归 T6；记录破基线门                                                                                                                                            |
| `19248392`                       | `newestConversationId` 与响应信封各收一个 owner（`envelope.ts`），`http.ts` 零改动仍绿                                                                                                        |
| `2f2b2940`                       | T5a：工具名前缀从共核搬到两张皮各自的 catch arm                                                                                                                                               |
| `16a6c773`                       | T5b：`list_sessions`（目录轴）上两张皮，registry 40→41                                                                                                                                        |
| `4013ef58`                       | **T6**：`get_record`（内容轴窗）上两张皮 + 4000 字符帽退场（新核 `get-record-core.ts` / `record-lookup.ts` / `output-backstop.ts`，ACI `get-record.ts`，registry 41→42），31 文件             |
| `1f232b17`                       | 本交接件（+ plan 第 15 条一处「没点过数」的口径纠正）                                                                                                                                         |
| `3e1776a7`                       | `.github/workflows/test.yml`：3 个 bwrap 依赖测试补进两个 vitest job 的 `--exclude`（本 PR 的 `list-sessions.test.ts` / `get-record.test.ts` + master 旧账 `build-engine-mcp-roots.test.ts`） |
| `b4295a4e`                       | 把 CI 那一轮收进交接件与 plan 第 15 条（含 `3e1776a7` 正文一处 passed 计数的订正）                                                                                                            |

**给 T7 的硬性提醒**：新增测文件里只要出现 `createDefaultAciRegistry(` 或 `buildHarnessEngine(`，`scripts/ci-check-test-excludes.ts`（#467 守卫）就会让 `test-fast` 在跑 vitest 之前红掉（Actions runner 无 user-namespace ⇒ bwrap 在装配期 throw，不是断言失败）。**同批**加 `--exclude`（两个 job 各一份），别等 PR 开出来才发现。

工作树遗留：无代码遗留。docs 侧 T6 之后共两笔收尾 —— `b4295a4e`（交接件 + plan 第 15 条 CI 门订正）与本 commit（交接件加「回查 CI + 补 PR 正文」一条 next step）。

## 已验证状态

T6 commit 前实跑（同一工作树状态）：

```
npx tsc --noEmit                                     => EXIT 0
npx vitest run                                       => Test Files 5 failed | 387 passed (392)
                                                       Tests 32 failed | 5643 passed (5675)
                                                       失败集 = identity/{assemble,coordinator-segment,
                                                       mcp-overview-segment} + memory/{assembly,refresh}
                                                       = plan 第 6 条 master b99492f2 基线，逐文件同构
$HOME/.bun/bin/bun test tests/tui/deps-tools.test.ts  => 5 pass / 1 fail（与基线同签名，plan 第 9 条）
git diff 16a6c773 -- src/traceserver/http.ts | wc -c => 0（SC15）
npx prettier --check <所有改动的 .ts/.md（plan 文件除外）> => All matched files use Prettier code style!
npx vitest run tests/cli/register-shutdown.test.ts   => 7 passed（全量并行下该文件曾红 1 例，判为时序 flaky）
```

CI commit `3e1776a7` 前另跑：`npx tsx scripts/ci-check-test-excludes.ts` => **EXIT 0**（41 个 bwrap 依赖测试文件全在两个 job 的 `--exclude` 列）；被排除的三份本地实测全绿 —— `tests/harness/aci/tools/` 27 文件 / 568 例、`tests/trace-mcp/` 2 文件 / 25 例、`build-engine-mcp-roots.test.ts` 4 例。

一次性探针（跑完即删，`/tmp` 下，未进仓）：主仓 81 个真实会话的摘要条目宽度 = entry JSON 本体 **71–124 字符**、页内连写每条再 +1 逗号 ⇒ **72–125**。这个数字对是 `LIST_SESSIONS_MAX_LIMIT = 128` 的依据，也是本轮第三次「单位是字符不是字节」的订正来源。

两轴 review（commit 前，pinned ref `16a6c773` → 工作树）：Standards **0 High / 5 Medium / 5 Low**，Spec **1 High / 1 Medium / 5 Low** → 门 = **GATE: PASS**（High 与两条 Medium 已在 commit 前处置；其余落在 plan 第 15 条，逐条写了去处）。

## Open blockers + next steps

**[NEXT] 从 merge 后的 master 开新分支执行 plan 第 7 票 T7**：第一个动作是在 `src/traceserver/query-trace-core.ts` 的 `parseInput` 暴露行 `offset`（`TraceQuery` 早已有、reader 已支持、`tests/traceserver/query-trace-core.test.ts` 先写失败测），随后删 `record_id` / `detail` / `resume_offset` 三个参数与过渡别名 `QUERY_TRACE_MAX_RECORD_ID_SCAN`，并把行轴 `conversation_id` 缺失/不存在改抛 `TraceSessionNotFoundError`。T7 判据 = plan 第 7 票 AC + 第 14 条第 5 小条（行轴收窄机制此时才拆）。

其余 next steps（每条都是具体动作）：

- **回查本 PR 的 CI + 补 PR 正文**：`3e1776a7`/`b4295a4e` 已 push，但本机 GitHub API 持续 `dial tcp 198.18.0.124:443 i/o timeout` ⇒ 两件事都没做成：① 「guard 修好后 `test-fast` 是否转绿」**未验证**（唯一一次读到的是 `s4-check` / `test-fast` pending、`test-full` skipping，网络可用时跑 `gh pr checks 867`）；② PR #867 正文停在 T6 收尾，**没提** `3e1776a7` 这个 CI exclude commit、没写 guard 本地 EXIT 0 与三份被排除测试的本地实测，也**没订正**两个 commit 正文里的错数（T6 的「14 处下游字面量」= 没点过数的估计，可验证说法是 T6 改 16 个测试文件；`3e1776a7` 的「612 passed」= 旧合计数，真相是 `aci/tools` 27 文件 / 568 例、`trace-mcp` 2 / 25、`mcp-roots` 4 例）。正文按 plan 第 15 条重写，别引用本机的临时文件。
- T7 里同步 `specs/query-trace-tool-results.md`，并**另立**一个 tool face 信封构造（不得给 `toResponseEnvelope` 加「哪张皮」开关，plan §序列化 对 T7 的约束）。两套 parser 不合并。
- T8：`.iknow/mcp.json` 的 cwd 依赖修复 + `docs/trace-mcp-server.md` 给真实例子 + 一条脚本化 spawn 断言。
- 整轮收尾（两件都在 plan §待写入，走 `domain-modeling`）：① 四条新词写进 `docs/CONTEXT.md`；② **改名 `TraceQueryValidationError`**（自 T5b 起是读侧共用校验错误，名字里带 `QueryTrace` 是误名）连同 `query-trace-errors.ts` 文件名 —— 单独开票，因为它动判别名与消息字符串面。
- plan 第 15 条列的 5 条 Standards Medium（截断/守卫重复、`row["messages"]` 归属、三参数团、清单臂无 part 总数）—— 建议折进 T7 或单开 refactor 票，别留给「以后再说」。
- `tsconfig.json` 的 `exclude` 含 `tests/`，`tsc --noEmit` **从不检查测试**：本轮就因此吃掉过 6 条「import 了一个已删常量 ⇒ 比较恒假 ⇒ 测试静默绿」。去处 = 加 `tsconfig.tests.json` + `npm run typecheck:tests`（已记在 plan §待写入）。

需要 operator 拍板的三件（本轮不擅自做）：

1. `.husky/pre-commit` 与 `pre-push` 权限是 `-rw-r--r--` ⇒ **hooks 从来没跑过**，`npx lint-staged` 在 `package.json` 里也没有配置。本轮所有门禁都是手敲的。要不要单独修（改 hooks 属仓库级配置）。
2. executor 的校验失败文案 `[validation_failed] invalid input at /limit: must be >= 1` **不含工具名**（ACI ajv 门自己出的），42 件工具共用。要不要让它点名工具 —— 影响面超出本轮。
3. `plans/trace-mcp-read-side-split.md` 在本仓 prettier 判据下不合规（HEAD 即如此），且 `--write` 会重排 prose 把 diff 冲成噪音。本轮只按 80 列手排。**不要**对该文件跑 `prettier --write`。

## Suggested skills（下个 agent 建议 invoke）

- `arthurpower:using-agent-skills` — 新会话第一件事，先把 T7 路由到 per-ticket 循环。
- `arthurpower:test-driven-development` — T7 是删参 + 暴露 `offset` 的行为变更，先写失败测。
- `arthurpower:code-review` → `arthurpower:verification-before-completion` — 每票收尾两件套，顺序不能反（本轮 T6 的 High 就是 review 抓到、verification 之前修掉的）。
- `arthurpower:domain-modeling` — 整轮结束时消化 plan §待写入（含改名票）。

## 脱敏

- 无 API key / token / password / credential 值出现。
- 凭据一律以环境变量名指代：本机 `IKNOW_*` / `GITHUB_TOKEN`（`gh` 已登录 `winter6205`，push 与 `gh pr create` 可直接用）。
