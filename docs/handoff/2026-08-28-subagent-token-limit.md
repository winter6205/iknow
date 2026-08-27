# Session Handoff — 子代理 token 限额过低（2026-08-28）

## 当前 live 状态

- **任务**: 判定「正常任务里子代理失败」是否**只**因为 token 限额过低；已完成 systematic-debugging Phase 1–4 中**已证明**的错映射修复。
- **结论（是否只此一个）**: **不是**。token 帽撞顶是上游触发之一；根因是 `runWorkerOnce` 把 `nonSuccessStop` / per-call `timeout` 漏映成 `{status:"ok", result:""}`。
- **本 PR 已修**: 诚实失败映射（`worker.ts` + RED→GREEN 测试）。**未做**: 抬 worker `maxOutputTokens`、补齐 worker `modelIdleTimeoutMs`/`modelHardCapMs`。

## 已固化工件（引用，不复制 inline）

| 类型 | 路径 / URL |
| --- | --- |
| 领域词汇 | `docs/CONTEXT.md`（cancelled vs timeout、per-task vs per-call） |
| 已合入墙钟 ACI | PR #641 |
| 本修复 | `src/harness/subagent/worker.ts`（`nonSuccessStop`→`protocolError`；per-call `timeout`→`timeout`） |
| RED/GREEN | `tests/subagent/nonsuccess-stop-mapping.test.ts` |
| 分支 / PR | `worktree-fix-subagent-token-limit` / https://github.com/winter6205/iknow/pull/755 |

## 本 session 变更

| 变更 | 一行效果 |
| --- | --- |
| `d3e41b4` | RED：非成功停因被报成 ok |
| `0716c2d` | fix：映射为 failed + 非空 summary + EXIT；五类边界测试转绿 |

## 已验证状态

```
npx vitest run tests/subagent/nonsuccess-stop-mapping.test.ts
=> 7/7 passed  exit 0

npx vitest run tests/subagent/
=> 341/341 passed  exit 0
```

未跑全仓 `npm test`（改动限于 subagent worker 映射）。未跑 `test:real-llm`（hermetic stub 已钉死映射）。

## Q1 / Q2

- **Q1 = YES**（`nonsuccess-stop-mapping.test.ts`）
- **Q2**: `runWorkerOnce` 漏处理 `nonSuccessStop`（含 truncation）与 per-call `timeout`，经 `toOkEnvelope` 变成父侧 `completed` + 空结果。

## Open blockers + next steps

**[NEXT] 另开逻辑提交：worker 模型双钟与父对齐（`modelIdleTimeoutMs` / `modelHardCapMs`），并评估是否分档抬高 `IKNOW_SUBAGENT_MAX_OUTPUT_TOKENS`（父 32k 不动）；须独立 RED，勿与本映射修复捆绑。**

- 仍开放：模型显式传过小 `timeoutMs`/`maxTurns`；live trace 是否真撞 32k 帽（可选 `test:real-llm`）。
- Commit/PR **不要**附外部参考链接。

## Suggested skills（下个 agent）

- `test-driven-development` — worker 双钟 / 分档 maxTokens
- `architecture-change-reviewer` — 若触及 env + worker + 多测试
- `verification-before-completion` — 收尾前

## 脱敏

- 无 API key / token / password / credential 值
- 凭据名：`ANTHROPIC_AUTH_TOKEN`
