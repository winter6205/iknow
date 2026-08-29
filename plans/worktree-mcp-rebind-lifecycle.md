# Plan: worktree MCP rebind lifecycle

**Goal:** 把 session worktree rebind 后的 MCP 配置根、stdio 子进程 cwd、工具文件系统根和 reload 生命周期收敛为一条可验证、fail-closed 的路径。
**Approach:** 先交付 typed lifecycle error 与双根 resolver，再按依赖接通配置读取、transport manager、单点 engine wiring，最后贯通 chat/serve/TUI 与 Hub 的 active-root reload 事务。每个 tracer bullet 都是可单独验证的窄纵切片；最终 boundary matrix 覆盖 MCP × rebind 的五类输入。
**Spec link:** `specs/337-skill-mcp-extension.md`
**ADR link:** `docs/adr/0037-worktree-isolation-on-mutate.md`
**Tracker:** local `plans/*.md` fallback — Cloud-agent plan-only handoff explicitly keeps the tracker local; no GitHub issue publication is requested.
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit per tracer bullet on the implementation branch

本计划是一个逻辑任务；实施阶段按下列 tracer bullet 各自提交，保持每个提交可回滚、可验证。本文件本次只作为 ACR handoff 产物，不实施 source/test 改动。

## Root contract

### Two named roots

- `workspaceRoot`：当前 session/task root。初始值是 session 绑定的主 checkout；首次 mutate 成功后变为 `<productRoot>/.iknow/worktrees/<conversationId>`。它是 stdio child 的 `cwd`，也是 MCP 工具及 ACI 文件系统工具的 FS root。rebind 只更新当前 session 的这个值。
- `mcpConfigRoot`：稳定的 product/main checkout root。它在 session 首次装配时由主 checkout 捕获，之后跨 rebind 保持不变；只用于读取 `<mcpConfigRoot>/.iknow/mcp.json`，绝不改成 task worktree，也不作为 task worktree 的写入根。用户级配置仍为 `<home>/.iknow/mcp.json`。

`productRoot` 是 host 在首次装配前确定的主 checkout root；rebuild 时必须原样透传，禁止从 task worktree 反推。serve 的显式 workspace bind、chat 的启动 workspace、TUI 的启动 workspace 分别成为其 session 的稳定 `productRoot`。任何缺少这两个根、非绝对根、或根值与当前 engine 请求不一致的输入都在 spawn/config/reload 前拒绝，不回退 `process.cwd()`。

### One resolver and one-way parameters

唯一根策略模块：`src/harness/mcp/roots.ts`。

```ts
resolveMcpRoots({
  workspaceRoot,
  productRoot,
}): {
  workspaceRoot: string;
  mcpConfigRoot: string;
}
```

该纯 resolver 负责非空、绝对路径、规范化和 root-mismatch 校验；`mcpConfigRoot` 只由 `productRoot` 派生。调用方不得在 `config.ts`、`build-engine.ts`、`manager.ts`、`hub.ts`、TUI 或 CLI 中自行拼接 `.iknow/mcp.json`、读取 `process.cwd()` 作为 project root、或判断 task worktree 所有权。task worktree 所有权继续由 ADR-0037 既有 `worktree-rebind`/`worktree-gate` 合同负责；MCP resolver 不复制该策略。

工具 FS root 与 MCP root 不再允许分叉：`buildHarnessEngine` 将 resolver 返回的 `workspaceRoot` 接到 sandbox/ACI FS root，并把同一字段传给 manager；若已有显式 sandbox root 与它不一致，返回 typed `root_mismatch`，不启动 MCP、不执行工具。

### Call graph

```text
host startup/rebind context
  → resolveMcpRoots({ workspaceRoot, productRoot })
  → returned { workspaceRoot, mcpConfigRoot }
      ├─ loadMcpConfig({ home, mcpConfigRoot })
      │    └─ read <mcpConfigRoot>/.iknow/mcp.json
      ├─ buildHarnessEngine / ACI FS fence
      │    └─ consume workspaceRoot as tool FS root
      ├─ createMcpManager({ config, workspaceRoot })
      │    └─ createRealClient(server, { cwd: workspaceRoot })
      └─ hub.reloadMcp / TUI reload
           └─ consume active engine's returned roots; never invent cwd/config policy
```

`BuiltEngine`/per-root engine entry保存 `mcpRoots`，hub 不再保存单一含糊的 `mcpCwd`。chat、TUI、serve 的 rebuild closure 都接收当前 `workspaceRoot` 与稳定 `productRoot`，再次调用同一 resolver；hub 的 reload 使用当前 active engine 的 `mcpRoots`，因此 task cwd 会更新而 `mcpConfigRoot` 不会漂移。

## Scope inventory (non-prescriptive)

以下是 ACR/spec 提供的当前触点清单，用于界定 seam 闭包，不是实现者必须采用的 patch 文件形状；Tasks 的 Surface、Acceptance 和 Completion headroom 才是实施依据。

### Runtime

1. `src/harness/errors.ts` — 增加与既有 `ToolExecutionError`/`WorktreeIsolationError` 形态一致的 MCP typed lifecycle error/kind。
2. `src/harness/mcp/roots.ts` — 新增唯一 `resolveMcpRoots` 与根合同类型；不放配置读取、git 操作或 session 状态。
3. `src/harness/mcp/config.ts` — `loadMcpConfig` 改为消费 `mcpConfigRoot`，保留 user/project 两级合并和缺失文件空集语义。
4. `src/harness/mcp/manager.ts` — manager 持有 `workspaceRoot`；stdio transport 明确接收 child `cwd`；reload/迟到连接/失败状态遵守同一生命周期合同。
5. `src/harness/build-engine.ts` — 单次解析并透传 `McpRoots`，使 ACI FS root、config load、manager spawn 同源；向 `BuiltEngine` 暴露 active `mcpRoots`/reload 所需句柄。
6. `src/cli/runtime.ts` — 透传稳定 `productRoot` 与当前 `workspaceRoot`，不在 wrapper 内解析第二套规则。
7. `src/cli.ts` — chat 初次装配捕获 product root，rebind rebuild 保持该 root，只替换 workspace root。
8. `src/session-api/serve.ts` — serve 启动/bind 时确定稳定 product root，并注入 hub；不把 task worktree 作为 MCP project config source。
9. `src/session-api/hub.ts` — 删除 `mcpCwd` 单值状态，改用 per-engine `McpRoots`；reload 只消费 active roots，串行化/收敛失败，避免旧新 manager 同时成为可见成功面。
10. `src/tui/deps.ts` — 透传同一 roots 参数，TUI reload 不再以本地 `cwd` 拼 config 路径。
11. `src/tui/run.tsx` — TUI 初次装配捕获 product root，per-root rebuild 只替换 workspace root。
12. `src/tui/hub-bridge.ts` — 将双根请求/重建参数单向传入 SessionHub，不保存或重算 MCP 路径策略。

### Tests

13. `tests/mcp/roots.test.ts` — resolver 双根合同、缺失/非法/foreign root、root mismatch。
14. `tests/mcp/config.test.ts` — config root 读取位置、缺失文件空集、空 servers、配置加载失败 typed 语义。
15. `tests/mcp/manager.test.ts` — transport cwd、spawn/connect/reload 失败、超时、迟到连接、manager 状态与无悬挂。
16. `tests/harness/build-engine.test.ts` — resolver 返回值同时接入 config、manager、ACI FS root，且不读取 task root config。
17. `tests/session-api/hub-worktree-isolation.test.ts` — rebind 后 workspace cwd 更新、mcpConfigRoot 稳定、reload 使用 active roots 且无 split-brain。
18. `tests/cli/chat-session-rebind.test.ts` — chat rebuild 保持启动 product root，旧 manager 收口，新 manager 使用 task cwd。
19. `tests/tui/deps-skill-mcp.test.ts` — TUI 初次/重建装配与 reload 的双根透传。

## Error contract

错误继续沿用 `src/harness/errors.ts` 的 typed error 形态；新增的 MCP error 继承 `ToolExecutionError`，保留 `name`、`kind`、`detail`、可选 `cause`，不另起一套 envelope 或字符串解析框架。每个错误的 `message` 与 `detail` 必须非空、面向用户可见，且不得包含 env secret、完整 command 参数或凭据。

```text
McpLifecycleErrorKind =
  missing_cwd
  | invalid_cwd
  | invalid_config_root
  | root_mismatch
  | config_load_failed
  | reload_failed
```

- `missing_cwd`：未提供 `workspaceRoot`/`productRoot`，或 rebind 请求没有当前根；立即失败，不调用 config loader、spawn 或工具 handler。
- `invalid_cwd`：空白、非绝对、无法规范化或无法作为 child cwd 使用的 `workspaceRoot`；不得回退 `process.cwd()`。
- `invalid_config_root`：`productRoot` 缺失、非法，或不是稳定的 main checkout root；不得把 task worktree 当配置根。
- `root_mismatch`：sandbox/ACI FS root、manager cwd 与 resolver 返回的 `workspaceRoot` 不一致；fail-closed。
- `config_load_failed`：配置根上的非缺失 IO、JSON/顶层结构或不可恢复读取异常。`<mcpConfigRoot>/.iknow/mcp.json` 不存在是合法 empty config，不是失败；坏 server 条目继续按现有条目级 skip+warn 合同隔离。整体加载失败必须保留 typed kind，启动边界可降级为无 MCP，但要有非空 visible warn；代码标明 `// EXIT: config load failed → no MCP manager, preserve harness startup`。
- `reload_failed`：reload 的 config 解析、manager shutdown/rebuild、unregister/register 或后台连接收敛失败。reload 必须在切换前完成 root 校验；失败时旧 manager 不得继续与新 manager 共同对外成功，工具注册表不得留下 stale/重复的 split-brain 面。调用方得到 typed failed 结果/可见消息，且 promise 必须终结；所有可保留旧状态的 fallback 标明 `// EXIT: reload failed → retain one coherent failed/old state; never report mixed success`。

MCP server 的运行时失败继续映射到现有 `McpServerState = "failed"` 与非空 `status.error`；stdio spawn、connect throw、onclose、listTools、reload mid-flight 都不得裸抛普通 `Error` 给产品面。`WorktreeIsolationError` 仍专属 ADR-0037 的建树/改绑失败，MCP error 只承载 MCP lifecycle，二者通过既有 host/tool error 映射衔接。

## Test matrix

所有用例都断言：typed kind、非空可见消息、无 secret 泄露、promise 不悬挂；涉及失败时还断言不执行错误根上的工具、不产生双注册或 split-brain。

| Boundary class | MCP × rebind seam assertions |
| --- | --- |
| empty | `mcpConfigRoot/.iknow/mcp.json` 缺失 → project level 空集，不误读 task root；`servers: []` → manager 无 slot，start/reload/shutdown 幂等且不 spawn。 |
| negative | 相对 command 在错误 cwd 下不得启动成功，正确 task `workspaceRoot` 下才解析；foreign/invalid root → `invalid_cwd`/`invalid_config_root`/`root_mismatch`；针对错误 root 的 reload 在 shutdown 前拒绝，或被 resolver 修正后只使用返回的双根。 |
| overflow | 大量 server 与长 `workspaceRoot`/config path 仍保持确定排序和有限诊断；rebind overlap 中连接/manager timeout 到期后进入 typed failed，不无限等待、不把迟到旧连接翻成当前成功。 |
| concurrent | old manager late-connect 与 rebind 后 new manager 同时到达时，旧 manager 不能注册新工具或覆盖新 cwd；多个 mutate 在 pending rebind 时 coalesce 为一棵 worktree/一个 manager 生命周期，不双写主仓。 |
| exception | stdio spawn fail、connect throw、reload mid-flight throw/abort 均收敛到 typed failed/reload_failed；旧工具先撤回或保持为唯一一致面，new manager 不与 old manager 并存为成功面；所有路径有明确终结，无 hang。 |

## Tasks (ordered by dependency)

每个 bullet 都是一个可演示的纵切片、恰好一个 tag，并以该 bullet 的独立提交收口。实现者可选择文件、类拆分和测试布局，只需满足 Acceptance。

1. **`McpLifecycleError` typed error contract** — tag: `[implementation]`
   - **Inherits:** `src/harness/errors.ts` 的 typed error 形态；错误必须保留 `name`、`kind`、`detail`、可选 `cause`，且错误消息与 detail 非空、不得泄露 secret、完整 command 参数或凭据。
   - **Surface:** `harness` error boundary 与 MCP lifecycle failure tests
   - **Acceptance:** `missing_cwd`、`invalid_cwd`、`invalid_config_root`、`root_mismatch`、`config_load_failed`、`reload_failed` 六类失败均能以稳定 typed kind 被调用方区分；错误信息可见且安全，普通 SDK/transport 异常不会成为产品面的裸 `Error`。
   - **Completion headroom:** 实现者可以选择继承层级、kind 的表示方式和错误构造 helper；只要公开错误观察面及安全约束保持一致即可。
   - Status: [ ] pending

2. **`resolveMcpRoots` dual-root resolver** — tag: `[implementation]`
   - **Inherits:** `workspaceRoot` 是当前 session/task root；`productRoot` 是首次装配捕获的稳定主 checkout root；`mcpConfigRoot` 只能由 `productRoot` 派生。缺根、非绝对根或 root mismatch 在 spawn/config/reload 前 fail-closed，禁止回退 `process.cwd()`。
   - **Surface:** `harness/mcp` root-resolution boundary
   - **Acceptance:** 一次纯解析产生规范化的 `{ workspaceRoot, mcpConfigRoot }`；空白、相对、无法规范化或不一致的输入在任何文件读取、spawn 或工具执行前返回 T1 typed kind；同一 product root 始终得到同一 config root，且 resolver 不读 git、不持有 session 状态。
   - **Completion headroom:** 实现者可以选择规范化库、返回类型的声明位置和校验 helper；调用方只能消费 resolver 的结果，不得复制 root policy。
   - Status: [ ] pending
   - [blocks: T1]

3. **`config.ts` mcpConfigRoot-only loading** — tag: `[implementation]`
   - **Inherits:** MCP 配置只读取 `~/.iknow/mcp.json` 与 `<mcpConfigRoot>/.iknow/mcp.json`；项目级同名条目整体覆盖用户级；task worktree 的 `.iknow/mcp.json` 不是项目配置真相；缺失文件是合法 empty config。
   - **Surface:** `harness/mcp` configuration loading boundary
   - **Acceptance:** 配置加载在 rebind 前后都从稳定 `mcpConfigRoot` 读取项目级文件，不读取 task root 或 `process.cwd()`；两级合并、disabled 语义和坏条目隔离保持可观察；非缺失 IO/JSON/顶层结构失败返回 T1 的 `config_load_failed`，并按启动合同降级为无 MCP、给出非空安全 warning，不阻塞其他配置级别。
   - **Completion headroom:** 实现者可以保留或重组两级读取与合并的内部 helper；Acceptance 不规定 JSON 解析器、函数数量或文件布局。
   - Status: [ ] pending
   - [blocks: T2]

4. **`manager.ts` workspaceRoot transport lifecycle** — tag: `[implementation]`
   - **Inherits:** `workspaceRoot` 是 stdio child 的 cwd 及 MCP 工具 FS root；连接后台化；注册超时、调用超时、shutdown、onclose 与 list_changed 遵守 spec 的失败/并发合同；onclose 不自动重连。
   - **Surface:** `harness/mcp` transport and manager lifecycle
   - **Acceptance:** 每个 stdio server 只在 resolver 提供的 `workspaceRoot` 下启动；connect/listTools/callTool/reload/close 的失败都可收敛为 typed 状态或结果，promise 必须终结；shutdown 取消在途调用、关闭 client 和 stdio 子孙；list_changed 不打断在途调用、不重复注册同名工具，且迟到连接不能越过已终结的 manager 生命周期。
   - **Completion headroom:** 实现者可以选择 manager 内部状态机、AbortSignal 合并方式和 transport wrapper；不得要求调用方直接操作 SDK transport 或依赖某个具体 client mock 形状。
   - Status: [ ] pending
   - [blocks: T1, T2, T3]

5. **`buildHarnessEngine` single-root wiring** — tag: `[implementation]`
   - **Inherits:** resolver 是唯一根策略；ACI/sandbox FS root 与 manager 的 `workspaceRoot` 必须相同；config loader 只消费 `mcpConfigRoot`；`BuiltEngine` 需暴露 active roots 与 reload/shutdown 所需的生命周期句柄；`ask` 不装配 MCP。
   - **Surface:** `harness` engine assembly, ACI FS fence, and built-engine lifecycle
   - **Acceptance:** 一次 engine build 能证明同一组 roots 同时驱动 config、stdio cwd、ACI FS fence 和返回句柄；显式 sandbox root 不一致时以 `root_mismatch` fail-closed，且不 spawn、不执行工具；ask 的 registry/executor/catalog 不含 MCP 工具或连接行为；缺 root 不触达任何 MCP side effect。
   - **Completion headroom:** 实现者可以选择 holder、factory 参数或 `BuiltEngine` 字段的具体组织；禁止在 build-engine 之外再造第二套 root 解析规则。
   - Status: [ ] pending
   - [blocks: T2, T3, T4]

6. **chat/serve/TUI stable productRoot threading** — tag: `[implementation]`
   - **Inherits:** chat、serve、TUI 的启动 workspace bind 成为各自 session 的稳定 `productRoot`；rebind 只替换当前 `workspaceRoot`；ADR-0037 的 session-only rebind 不改变 serve 主根、recents/trust 或 settings 来源。
   - **Surface:** `cli`, `session-api/serve`, `tui`, and their thin runtime/bridge assembly
   - **Acceptance:** 三个产品入口初次装配都捕获并透传稳定 `productRoot`；rebind rebuild 保留该 root、只把当前 `workspaceRoot` 切到 task worktree，并让新 engine 的 stdio cwd/ACI FS 跟随 task root、配置读取仍留在 product root；runtime wrapper 与 hub bridge 只透传参数，不从本地 cwd 重算 MCP policy。
   - **Completion headroom:** 实现者可以选择 closure、依赖对象或 host callback 的参数形态；只要三入口在初次装配与 rebuild 的可观察 roots 满足同一合同即可。
   - Status: [ ] pending
   - [blocks: T5]

7. **hub active-root reload transaction** — tag: `[implementation]`
   - **Inherits:** Hub-visible provision seam 只观察 session rebind 返回根；reload 必须先完成 root 校验；失败时不得让旧、新 manager 同时成为对外成功面；`mcpConfigRoot` 稳定而 `workspaceRoot` 随 active engine 更新。
   - **Surface:** `session-api` SessionHub active-engine cache and MCP reload bridge
   - **Acceptance:** Hub reload 只消费 active engine 的 `mcpRoots`，不再依赖单一含糊 cwd；rebind 与 reload 重叠时旧 manager 先收口或被明确标记失败，再公开新 manager，工具注册表不留 stale/duplicate/split-brain；错误 root 在 shutdown 前被拒绝；串行化或 coalesce 后每个 promise 都有明确 typed 成功/失败终点。
   - **Completion headroom:** 实现者可以选择锁、队列、版本号或事务快照；Acceptance 只约束唯一可见成功面、根稳定性和 promise 收敛，不冻结并发实现。
   - Status: [ ] pending
   - [blocks: T5, T6]

8. **MCP×rebind five-boundary test matrix** — tag: `[implementation]`
   - **Inherits:** 测试必须覆盖 empty / negative / overflow / concurrent / exception 五类边界；每类断言 typed kind、非空可见消息、无 secret 泄露、promise 不悬挂，并在失败时断言错误根不执行工具、无双注册或 split-brain。
   - **Surface:** `tests` MCP, harness, session-api, CLI, and TUI integration boundaries named by the spec
   - **Acceptance:** 矩阵可复现证明：缺失 project config 不误读 task root；正确 task cwd 才解析相对命令；长路径/大量 server 有确定排序和有限诊断；late old manager、多个 mutate、list_changed、shutdown overlap 均收敛；spawn/connect/reload exception 均到达 typed failed 状态。`npm test` 与 `npm run typecheck` 均 exit 0。
   - **Completion headroom:** 实现者可以按现有测试分层拆 fixture、stub 和集成用例；不得以缩窄覆盖、静默 skip 或固定某个测试文件路径替代五类可观察合同。
   - Status: [ ] pending
   - [blocks: T1, T2, T3, T4, T5, T6, T7]

## 待写入（已刷新）

无。`productRoot` 与 `mcpConfigRoot` 已持久化至 `docs/CONTEXT.md`。

## Explicit non-goals

- 不做 remote MCP transport、OAuth、SSE 或网络协议改造。
- 不重写 settings 系统；启动 settings 仍按既有生命周期读取，root resolver 不读 settings/git。
- 不改变 MCP 工具命名、permission category、timeout tier、ACI registry Gate 2/3 或 executor truncation 语义。
- 不把 task worktree 提升为 product workspace 多根，不修改 ADR-0037 的建树、分支、session rebind 合同。
- 不让 task worktree 的 `.iknow/mcp.json` 成为项目配置真相；也不扫描 `.claude.json`、`.kiro/settings/mcp.json`。
- 不混入无关重构；本计划保持一个逻辑任务，但实施按 tracer bullet 各自一个 commit，便于逐片验证与回滚。

## ACR verdict

bounded-context-guardian: yes — `src/harness/mcp/roots.ts` 是唯一双根解析边界；config 只读 `mcpConfigRoot`，manager 只用 `workspaceRoot`，hub/TUI/CLI 只单向透传返回字段，不跨模块重造 root policy。
defensive-contract-validator: yes — test matrix 明确覆盖 empty、negative、overflow、concurrent、exception 五类，并为每类锁定 typed error、无 hang、无错误根执行和无 split-brain。
error-handling-enforcer: yes — `McpLifecycleError` 明确定义 cwd/config/reload kinds；所有消息非空可见，server failed 状态复用既有模式，所有 fallback 都写明 `// EXIT:` 条件与出口。
complexity-anti-drift: yes — 一个小型纯 resolver 加 thin config/manager/hub callers；双根只在 resolver 派生，engine entry 保存结果，reload 不复制路径策略，不计划 god-function 或深层嵌套。
minimal-change-verifier: yes — 目标只有 MCP×session worktree rebind 生命周期根合同与验证；Affected files 是该单一 seam 的实现/测试闭包，明确保持 1 logical task / 1 commit，非目标不混入。
OVERALL: yes — 五项 verdict 全部通过，可 hand off 给 writing-plans。
