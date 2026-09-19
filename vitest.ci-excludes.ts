/**
 * CI vitest 排除集 SSOT（single source of truth）。
 *
 * 背景：GitHub Actions 标准 runner 的容器不允许 user-namespace 网络隔离
 * （bwrap --unshare-net → RTM_NEWADDR: Operation not permitted），而 bwrap
 * 是运行时硬依赖（spec security-guardrails.md #123）。requireBwrap() 守卫
 * 在装配期就 throw，所以依赖 bwrap 的测试在 runner 上结构性跑不了 ——
 * CI 排除它们，不删测试，本地 WSL 全量验证。
 *
 * 为什么收拢到这里：排除集原来是一条 68 项的 `--exclude` 命令行串，散在
 * `.github/workflows/test.yml` 两个 job 里。它出过两次事故：一次是注释被
 * 写进 `\` 续行块导致整段 exclude 静默失效（docs/handoff/2026-09-02-
 * trace-mcp-read-side-split-t8-ci-flake.md），一次是条目指向已删除文件而
 * 无人察觉。现在由 `scripts/ci-check-test-excludes.ts` 做双向校验（正向：
 * bwrap 依赖文件必须在列；反向：在列条目必须命中磁盘上真实存在的文件）。
 *
 * 消费方：
 *   - vitest.ci.config.ts      （test-full：装 bwrap，跑全量兜底）
 *   - vitest.ci-fast.config.ts （test-fast：不装 bwrap，PR 快速门）
 *   - scripts/ci-check-test-excludes.ts（守卫，import 本模块而非 grep workflow）
 *
 * 注意：`tests/tui/**` 由 bun:test 驱动（OpenTUI 原生 FFI 仅 bun 可用），
 * vitest.config.ts 的 exclude 已含 `tests/tui/**`，vitest 永不收集该目录。
 * 因此这里不应再出现任何 tests/tui 条目 —— 那对 vitest 是死配置，只会
 * 掩盖真实的收集范围。守护脚本会对该形态直接报错。
 */

/**
 * 两个 CI job 共同的排除集。
 *
 * 语义 = 「GHA runner 上结构性跑不了」，两类：
 *   1. bwrap 物理执行类 —— 真实 spawn bwrap，runner 无 user-namespace，起不来。
 *   2. 装配依赖 bwrap 类 —— 测试本身不 spawn bwrap，但装配链经
 *      createBashTool / createDefaultAciRegistry / createWorkerDeps /
 *      runInSandbox / buildHarnessEngine → requireBwrap，bwrap 缺失即
 *      fail-loud（test-full 装了 bwrap 能装配，但物理执行仍不行）。
 *
 * 每条目旁的尾注给出归类与引入缘由；新增条目必须同时满足「真实存在」
 * 与「命中 bwrap 依赖链」（守卫会强制前者，BWRAP_PATTERNS 会强制后者）。
 */
export const CI_EXCLUDES: readonly string[] = [
  // ---- bwrap 物理执行类（真实 spawn bwrap，runner 无 user-namespace）----
  "tests/harness/aci/bash-sandbox.test.ts",
  "tests/harness/aci/bash-background.test.ts",
  "tests/harness/aci/bash-output-stop.test.ts",
  "tests/harness/aci/bash-service-loop.e2e.test.ts",
  "tests/harness/aci/demo.test.ts",
  "tests/harness/aci/interrupt-routing.test.ts",
  "tests/harness/aci/tools/bash.test.ts",
  "tests/harness/aci/tools/bash-readonly.test.ts",
  // ADR-0084 last-read 账本走真实 bash 工具：createBashTool 装配期
  // requireBwrap，且每条用例真实 spawn bwrap 跑 cat / grep / sed / rg 再断言
  // 入账 —— 无 user-namespace 的 runner 上装配期即 throw。
  "tests/harness/aci/tools/bash-last-read.test.ts",
  "tests/harness/aci/tools/grep.test.ts",
  "tests/harness/aci/tools/query-trace.test.ts",
  "tests/harness/aci/tools/list-sessions.test.ts",
  "tests/harness/aci/tools/get-record.test.ts",
  "tests/harness/aci/bash-live-task-root.test.ts",
  // ADR-0092 Round 2 SC11/SC12：工作区档围栏的真实 bwrap 行为认证
  // （home 读成功 / home 写 EROFS / 两处白名单可写 + S2 五类越界写）。
  "tests/harness/aci/bash-workspace-mode-fence.test.ts",
  // ADR-0092（全局档）：闭世界读根测试已归档，同族不变式改由本文件认证。
  "tests/harness/aci/bash-global-mode-visibility.test.ts",
  "tests/harness/aci/bash-main-session-fence-tmp.test.ts",
  "tests/harness/verify/sandbox-run.test.ts",
  // ADR-0092 SC11/SC12：**verify 命令面**的工作区档真实 bwrap 行为认证
  // （`$TMPDIR` = 嵌套在 home 之下的会话 tmp、写 home EROFS、读 home 成功）。
  // 与 bash-workspace-mode-fence.test.ts 平行：那条钉 bash 工具面，这条钉
  // verify 闭环缺省执行体（同 `it.skipIf(!hasBwrap())` 形态，runner 缺
  // user-namespace 时物理执行起不来）。
  "tests/harness/verify/workspace-mode-fence.test.ts",
  "tests/harness/isolation/worktree-gate-live-taskroot-e2e.test.ts",
  "tests/harness/mcp/zero-linkage-guard.test.ts",
  "tests/harness/sandbox/runner.test.ts",
  "tests/harness/sandbox/server.test.ts",
  "tests/harness/aci/tools/skill-output-cap.test.ts",
  // #349 首跑实证失败集：真子进程 MCP stdio 链路（spawn fixture server →
  // createMcpManager → AciRegistry.registerExternal → tool_search discover
  // → 真实调用），无 user-namespace 的 runner 上起不来。
  "tests/integration/mcp-chain.test.ts",
  // #337 T11 E2E A：buildHarnessEngine → createDefaultAciRegistry →
  // createBashTool → requireBwrap，runner 上装配期即 fail-loud
  // （#349 rebase 到 master 后补入）。
  "tests/e2e/skill-mcp-acceptance.test.ts",
  // #467 前引入：build-engine 系列真实跑 ACI 工具回路。
  "tests/harness/build-engine.test.ts",
  "tests/harness/build-engine-mcp-roots.test.ts",
  "tests/harness/build-engine-tool-overflow.test.ts",
  "tests/harness/build-engine-auto-memory.test.ts",
  // Locked sentence 5：装配期不得 warmup —— 验收面就是「真 buildHarnessEngine
  // / createWorkerDeps 装配后零 spawn」，装配链 → createBashTool → requireBwrap，
  // runner 上装配期即 fail-loud。本地 WSL 全量验证。
  "tests/harness/lsp/lazy-warmup.test.ts",
  "tests/harness/graph/run-graph-assembly.test.ts",
  "tests/harness/prefix-stability/assertion2-matrix.test.ts",
  "tests/harness/disclosure-index-align/sc7-index-demotion.test.ts",

  // ---- 装配依赖 bwrap 类（requireBwrap fail-loud，装配期即 throw）----
  // ACI 注册表装配 → createBashTool → requireBwrap
  "tests/harness/aci/permission.test.ts",
  // ADR-0097 egress 缝：批准 gate / typed failure / 代理接线三条 bash 面
  // 与 build-engine 装配源头接线测试都经 createBashTool → requireBwrap。
  "tests/harness/aci/bash-egress-approval.test.ts",
  "tests/harness/aci/bash-egress-inner-bridge.test.ts",
  "tests/harness/aci/bash-egress-typed-failure.test.ts",
  "tests/harness/aci/bash-egress.test.ts",
  "tests/harness/build-engine-egress-wiring.test.ts",
  // ADR-0105 sentinel：三装配点入口 wiring 经 fence 装配 → requireBwrap。
  "tests/harness/egress-entry-wiring.test.ts",
  // ADR-0107 ssh 桥：三形态生命周期 wiring 经 fence 装配 → requireBwrap。
  "tests/harness/egress-three-form-lifecycle.test.ts",
  "tests/harness/aci/registry-workspace-root.test.ts",
  "tests/harness/aci/tools/d9-description-guard.test.ts",
  "tests/harness/aci/tools/registry.test.ts",
  "tests/harness/agent-status-bar.test.ts",
  "tests/harness/identity/agent-status-read-rule.test.ts",
  "tests/harness/identity/system-injection.test.ts",
  // ADR-0092：installRoot 读根退役（全局档无逐根读白名单），文件已归档；
  // 同族装配面改由 bash-wiring 认证。
  "tests/harness/build-engine-bash-wiring.test.ts",
  "tests/harness/build-engine-hooks.test.ts",
  "tests/harness/build-engine-subagent-trace.test.ts",
  // ADR-0088 T2：真 buildHarnessEngine 装配取 tasksDir（host 注入 / 缺省
  // 池根两种装配）→ createDefaultAciRegistry → createBashTool → requireBwrap。
  "tests/harness/build-engine-tasks-dir.test.ts",
  // ADR-0099：真 buildHarnessEngine 装配取 memoryDir → createBashTool → requireBwrap。
  "tests/harness/build-engine-memory-dir.test.ts",
  // ADR-0084 Slice B SC5：真 buildHarnessEngine 装配读项目 permissions
  // → createDefaultAciRegistry → createBashTool → requireBwrap。
  "tests/harness/build-engine-permission-project.test.ts",
  "tests/harness/mcp/build-engine-mcp-overview.test.ts",
  "tests/harness/mcp/build-engine-mcp-startwire.test.ts",
  // ADR-0098 T5/T7：增量注入 / worker 快照走真 buildHarnessEngine 装配
  // （ACI 注册表 → createBashTool → requireBwrap），装配期即 throw。
  "tests/harness/skill-index-delta-inject.test.ts",
  "tests/harness/skill-index-snapshot-wiring.test.ts",
  "tests/subagent/worker-skill-index-snapshot.test.ts",
  "tests/build-engine-hooks.test.ts",
  // session-api 路径 → 真实 store + ACI 装配
  "tests/session-api/max-turns-serve.test.ts",
  "tests/session-api/workspace-bind.test.ts",
  "tests/session-api/ensure-deps-aci-tools.test.ts",
  // ADR-0098 SC8：绑根 hub 走 buildProductionEngine → buildHarnessEngine
  // → requireBwrap（传递链，测试文件本体不命中守卫 pattern）。
  "tests/session-api/skills-hot.test.ts",
  // ADR-0037 / #814 实证：hub executor 真 mutate → runInSandbox → requireBwrap
  "tests/session-api/hub-worktree-isolation.test.ts",
  // 子代理 worker 装配 → createWorkerDeps → createBashTool → requireBwrap
  // ADR-0092 Round 2 SC11：fs 档跨进程传播（父 spawn env → worker holder）
  // 经 createWorkerDeps / createDefaultAciRegistry 装配链，runner 上装配期即
  // fail-loud（spawn 出口与 bwrap 均在测试内被挡，但锚点命中）。
  "tests/subagent/fs-mode-propagation.test.ts",
  "tests/subagent/worker-identity-root.test.ts",
  "tests/subagent/worker-session-layout.test.ts",
  "tests/subagent/worker-tool-surface.test.ts",
  "tests/subagent/worker.test.ts",
  // ADR-0084 last-read：createWorkerDeps → createDefaultAciRegistry →
  // createBashTool → requireBwrap（装配期 throw，test-fast 不装 bwrap）。
  "tests/subagent/worker-last-read-ledger.test.ts",
  // #562：subagent 契约测试同走 createWorkerDeps 装配链
  "tests/subagent/envelope-role.test.ts",
  "tests/subagent/tool-constraints.test.ts",
  "tests/subagent/bash-mode-channel.test.ts",
  "tests/subagent/git-work-discipline.test.ts",
  "tests/subagent/user-agents-wiring.test.ts",
  "tests/subagent/envelope-freeze.test.ts",
  // ADR-0084 Slice B SC5：真 createWorkerDeps 装配读项目 permissions
  // → createDefaultAciRegistry → createBashTool → requireBwrap。
  "tests/subagent/worker-project-permission.test.ts",
  // CLI 侧 harness / subagent trace 装配
  "tests/cli/tui-deps-subagent-trace-factory.test.ts",
  "tests/cli/chat-subagent-trace.test.ts",
  // #406：chat × roundtrip 用例 createBashTool 真实 spawn echo 还原占位符
  // （full 只排 e2e.test.ts；fast 是整目录，见 CI_FAST_EXCLUDES）。
  "tests/harness/secret-roundtrip/e2e.test.ts",
];

/**
 * test-fast（PR 快速门，不装 bwrap）在 CI_EXCLUDES 之上额外排除的整目录。
 *
 * 语义 = 「不装 bwrap 时整目录都跑不通 / 慢路径」，故 fast 直接排整目录，
 * full 装了 bwrap 则只排其中物理执行的那一份（如 secret-roundtrip 只排
 * e2e.test.ts，patterns/recognize/registry 三个纯逻辑用例照跑）。
 */
export const CI_FAST_EXCLUDES: readonly string[] = [
  // 端到端装配验收：每条都起真实引擎，不装 bwrap 时装配即 throw。
  "tests/e2e/**",
  // 跨模块集成：mcp-chain 等经 ACI 装配。
  "tests/integration/**",
  // 不装 bwrap 时整目录无意义（full 只排 e2e.test.ts 一条）。
  "tests/harness/secret-roundtrip/**",
];
