# Session Handoff — 子代理 token 限额过低（2026-08-28）

## 当前 live 状态

- **任务**: 用 systematic-debugging 判定「正常任务里子代理失败」是否**只**因为 token 限额过低；若是，对照公开做法做完整修复并开 PR。本 session **未进入 Phase 4**，工作树已建、根因未钉死。
- **为什么重要**: 墙钟超时（ACI 5min/30min）已在 #641 修过；用户认为剩余失败是 token 超限被误报/误杀，限额对正常任务过紧。
- **operator 显式指令**: `/systematic-debugging` 查是否只此原因，搜网上做法但最终提交不要参考说明，开 PR 完整修复；随后「切回主分支，开工作树就行」；本轮 `/session-handoff` 推远端 PR 以便下一会话继续。

## 已固化工件（引用，不复制 inline）

| 类型              | 路径 / URL                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 领域词汇          | `docs/CONTEXT.md`（cancelled vs timeout、per-task vs per-call、前景 spawn）                                                     |
| 已合入的墙钟修复  | PR #641 / `plans/632-subagent-aci-timeout-alignment.md` / commit `5dd2fb2`                                                      |
| per-task 缺省链   | `specs/358-subagent-runtime-observability.md`；`src/harness/subagent/manager.ts` `PER_TASK_TIMEOUT_MS`                          |
| worker 信封       | `src/harness/subagent/worker.ts`（`runWorkerOnce` / `applyEnvelopeOverrides`）                                                  |
| envelope 字符截断 | `src/harness/subagent/envelope.ts`（`TRUNCATE` 20000 chars，**不是** LLM max_tokens）                                           |
| LLM 默认帽        | `src/config/env.ts`：`maxOutputTokens` 32000；`timeoutMs` 300000；`idleTimeoutMs` 120000；`hardCapMs` 900000                    |
| 先前同类会话      | agent-transcript `bed135df-1bd8-43e5-a4ba-cb3541c642c9`（#641 那轮，勿当未修）                                                  |
| 本机 settings     | `~/.iknow/settings.json`：仅 `model` / `apiKey` / `fallback` / `thinking: adaptive`（无显式 maxOutputTokens → 走 32k fallback） |

## 本 session 变更

| 变更                                              | 一行效果                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 主仓 `git checkout master` @ `7ed8e58`            | 从 `research/tui-run-graph-view-primitives` 切回 master（与 `origin/master` 同步） |
| `.claude/worktrees/fix-subagent-token-limit`      | 新工作树；分支 `worktree-fix-subagent-token-limit` 跟踪 `origin/master`            |
| `docs/handoff/2026-08-28-subagent-token-limit.md` | 本交接（本 commit）                                                                |

无生产代码改动。未跑完整修复、未写 RED 测试。

## 已验证状态

```
git checkout master && git pull --ff-only origin master
=> Already up to date. HEAD 7ed8e58 Merge pull request #733 …  exit 0

git worktree add .claude/worktrees/fix-subagent-token-limit -b worktree-fix-subagent-token-limit origin/master
=> HEAD is now at 7ed8e58  exit 0

git -C .claude/worktrees/fix-subagent-token-limit status -sb
=> ## worktree-fix-subagent-token-limit...origin/master  exit 0
```

未跑 `npm test`（无代码 diff）。未复现到一条确定的「子代理因 token 超限失败」命令。

## 调查半成品（下一会话从这里续，勿当结论）

systematic-debugging **停在 Phase 1（REPRODUCE）**：Q1 失败测试、Q2 根因句子都还没有。

已排除 / 已合入、不要再当现网 bug：

1. `spawn_subagent` ACI `timeoutTier: long`（30min）+ description「5 min default」提前 abort → #641 已改为 `unbounded` + 文案 2h。

仍待用失败命令钉死的候选（可能不止一个，用户问「是不是只这一个」）：

1. **LLM `max_tokens` / thinking 吃预算**：worker `maxTokens: env.llm.maxOutputTokens`（与父同帽 32k）。`thinking: adaptive` 时 thinking tokens 计入 output；父会话历史上因此截断（CHANGELOG 2048→8192→16384→32000）。**未证明子代理路径仍在撞顶**，也未证明撞顶会被标成 `timeout`。
2. **worker 对 truncation 的映射**：`runWorkerOnce` 只把 SIGTERM（`signal.reason === "subagent-timeout"`）标 `reason:timeout`；`MaxTurnsExceeded` 标 `maxTurnsExceeded`。`stopReason === timeout`（per-call）与 `nonSuccessStop`（含 `supplierStop=truncation`）会落到 `toOkEnvelope` —— 若用户看到的是「超时失败」，需要对照真实 envelope / trace，不能默认等于 max_tokens。
3. **其它钟**：per-call `timeoutMs` 5min、流式 `idleTimeoutMs` 2min、`hardCapMs` 15min、manager per-task 2h。可能被口头叫成超时，与 token 无关。
4. **envelope 2万字符截断**：浓缩回传，不是模型 token 帽。
5. **模型显式传入过小的 `timeoutMs` / `maxTurns`**：schema 仍允许；#641 后 description 不再写 5min，但未抓 live 参数分布。

未完成：网上 Claude Code / OpenHarness 子代理 token 做法检索（用户要求搜完，且**最终修复 commit / PR 正文不要写参考来源**）。

## Open blockers + next steps

**[NEXT] 在工作树 `.claude/worktrees/fix-subagent-token-limit` 完成 systematic-debugging Phase 1：找出一条可复现的失败命令或写 RED 测试，证明子代理任务失败的 ground truth 是 token 帽还是墙钟/idle/maxTurns/截断映射；用该证据回答「是否只此一个原因」。**

- Q1=YES、Q2 一句根因之后才许 Phase 4 改代码。
- 若确认只是限额过低：对照公开做法改默认/分档（子代理 vs 父），补测试，跑 `npm test`，再 `code-review` + `verification-before-completion`，commit **不要**附参考链接或「参考某某」说明。
- 若还有第二原因：同一 PR 只修已证明的根因，其余写进本 handoff 的 blocker，不要捆绑猜测补丁。
- 凭据：`ANTHROPIC_AUTH_TOKEN`（本机 settings 占位符）；live 复现用 `npm run test:real-llm` 仅在 Phase 1 需要时。

## Suggested skills（下个 agent 建议 invoke）

- `systematic-debugging` — 当前槽位仍是 Phase 1–4，用户已点名
- `test-driven-development` — Phase 4 才 invoke；先 RED
- `architecture-change-reviewer` — 仅当修复跨 >3 文件或跨模块
- `code-review` + `verification-before-completion` — 改完收尾；本 handoff PR 只含文档，不跑那两步当「修复完成」

## 脱敏

- 无 API key / token / password / credential 值
- 凭据名：`ANTHROPIC_AUTH_TOKEN`
