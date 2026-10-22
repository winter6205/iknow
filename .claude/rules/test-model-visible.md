---
paths:
  - "docs/guides/prompt-development.md"
  - "docs/guides/agent-qa-eval.md"
  - "scripts/eval/agent-qa/**"
  - "vitest.ci-excludes.ts"
  - "tests/scripts/eval/**"
  - "src/harness/aci/tools/**"
  - "real-llm/**"
  - "vitest.real-llm.config.ts"
  - "tests/**/*.fixtures.ts"
---

# 模型可见行为、黄金集与真模型测试

红线在 `test.md`，这里只写做法。

- 改 prompt、模型输入、工具描述或 schema、轨迹，或它们的装配时：先读 `docs/guides/prompt-development.md`，跑登记表里对应的黄金集（文件是 `tests/**/*.fixtures.ts`）；工具描述和 schema 在 `src/harness/aci/tools/`；没有对应集合时补一个，或在 `docs/test-gaps.md` 登记。
- 轨迹集必须跑真模型那一半（`npm run test:real-llm`，用例在仓库根 `real-llm/`，配置 `vitest.real-llm.config.ts`）。离线 fixture 和 stub 模型的结果不算这一半。
- 离线 Agent QA：先读 `docs/guides/agent-qa-eval.md`。离线报告全部通过只是工具层证据，真模型基线按上一条跑 L5。
- 启动 harness 的测试登记在 `vitest.ci-excludes.ts`（需要 bwrap）。`tests/scripts/eval/` 下的 `attempt.test.ts`、`tool-cases.test.ts` 不进 CI 的 `test-full`，但本地 `npm test` 会跑它们。

## 测试专用 key

- 在模型提供方单独创建，设额度上限，不复用日常开发或产品用的 key。key 从 iknow 自己的 settings 读取（不是固定环境变量，旧的 `ANTHROPIC_AUTH_TOKEN` 读法已退役）。`tests/config/env.test.ts` 里的 `IKNOW_TEST_API_KEY` 只是假值。
- key 不得出现在命令行参数或内联赋值（`--api-key ...`、`KEY=... npm run ...`）、快照、报告、trace 或提交信息里。检查是否已配置时只汇报有或没有，不要读出或打印 key 值。是否有 key 以 `npm run test:real-llm` 的输出为准：没有 key 时用例打 `[SKIP] ... Not run`，汇报写 `Not run: L5 <原因>`。

## 录制回复与测试产物

- 录制器是 `real-llm/role-substitution-recorder.ts`。只有人工挑选过、且人工确认不含真实密钥与用户数据的录制回复，才能作为 fixture 提交；里面的密钥样式内容换成占位值。原始录制文件不提交。
- 测试产物（trace、原始录制、覆盖率、截图、PTY 录屏）写到已被 `.gitignore` 忽略的目录，不提交，也不随公开镜像发布。仓库里没有专门的录制目录；`.evals/real-llm/` 目前是空目录，用作产物目录前先确认已被忽略。确认方式：`git check-ignore -q <产物目录>/ || echo "NOT IGNORED"`；`git ls-files -- <产物目录>` 应无输出。
