# settings.json 文件级热更新 — plan

> **Tracker**: local markdown（fallback）—— 无 GitHub remote 操作授权；tracer bullets 以本文件 + 独立分支 / 串行 commit 呈现。
> **来源**: 用户在 PR #395 合并后追问「为什么 settings.json 不体现思考字段」→ 顺藤确认「文件级热更新未实现」→ 选择补齐。SSOT = ADR-0015（settings 单承载，已存在）+ `docs/llm-config-quickstart.md` §3.1。
> **目标**: 修改 `~/.iknow/settings.json` 或 `<cwd>/.iknow/settings.json` 后，**运行中的 iknow 进程无需重启**，下一轮 postMessage 起以新 env 调 LLM（adapter / thinking / model / apiKey / fallback 全部生效），同时 ContextBar 等显示层同步刷新；reload 失败（坏 JSON / model 缺失 / apiKey 解析失败）**降级保留旧 env** + 通过 callback 提示，不让进程崩。

## 边界 / 范围

### In scope

- **chat / tui / serve** 三个产品入口均受益（同一 SessionHub 接缝）。
- settings.json 内字段：`model` / `apiKey` / `fallback` / `thinking` / `thinkingEffort` / `maxTurns` / `compress.contextWindow` / `compress.thresholdTokens`。
- 显示层刷新：ContextBar 的 model 名 + thinking 基线（`app.tsx` 的 `defaultThinking` / `model` props）。
- `.env.local` / `.env` 同样热重读（因为 `loadIknowEnv` 是同链路）。

### Out of scope（不动）

- **subagent worker**：每个 worker fork 是新进程，启动时 `loadIknowEnv()`，已天然热更新。
- **MCP / skill / permission**：这些不是 settings.json 驱动；热更新只重读 settings + env 文件，不重走 `build-engine` 的装配期副作用（MCP connect / subagent spawn / skill scan）。
- **apiKey 之外的 .env 变量**（如 `IKNOW_LLM_BASE_URL`）：同样走 `loadIknowEnv` 链路，所以也会热更新；不额外写测试，但接受同款验收。
- **chat showThinking / web.proxy / mcp.connectTimeoutMs 等 env-only 字段**：env 链路热更新自然覆盖；doc 后续 §T5 一起更新。

### 关键设计决策（已固化，implementer 不再纠结）

1. **不引入新 npm 依赖**（避免 lockfile 变更）。watcher 用 Node 内置 `fs.watchFile`（轮询） + `fs.watch`（事件，回退路径）。`package.json` 不动。
2. **debounce = 100ms**：编辑器原子保存多次 `writeFile` 只触发一次 reload。
3. **reload 失败降级**：`loadIknowEnv()` 抛错（坏 JSON / model 缺失 / apiKey 解析失败）→ 保留旧 env，调用 `onError(err)` 通知上层（默认写到 stderr `[settings-hot-reload] reload failed: ...`，后续 app 端可挂 hook）。
4. **adapter 重建最小面**：从 `build-engine.ts` 抽出 `createAnthropicClientFromEnv(env)` 帮助函数（`new Anthropic({ apiKey, baseURL })`）+ `createAdapterFromEnv({ env, client })`（`createRealAnthropicAdapter`）。hot-reload 只走这两步，**不重跑** `buildHarnessEngine` 整条装配链（MCP / subagent / skill 跳过）。热重建的 adapter 替换 `hub.cachedDeps.adapter` 字段，`registry` / `executor` / `maxTurns` / `timeoutMs` 等复用。
5. **TUI 显示层刷新**：env 变化时 `run.tsx` 触发 React state setter（注入 `app.tsx` 一个 `useEffect(() => updateModel(newEnv.llm.model), [envVersion])` 形式），让 ContextBar `model` / `defaultThinking` 跟着改。

## Tracer bullets（顺序严格，1 bullet = 1 commit）

### T1. `[implementation]` settings-watch 纯函数模块

- **Affects**: `src/config/settings-watch.ts`（新建）、`tests/config/settings-watch.test.ts`（新建）
- **接受**: 导出 `watchSettings({ cwd, home, onChange }) → { stop }`。监听 `~/.iknow/settings.json`（user）+ `<cwd>/.iknow/settings.json`（project）两个文件。
  - **技术**: 主路径 `fs.watchFile(path, { interval: 500 }, listener)`（轮询保险，跨平台一致）；附加 `fs.watch(dir, { recursive: false })` 捕获「文件创建」事件（避免用户首次创建 settings 时漏触发）。两个文件都没存在 → 仍然注册 watcher 等用户创建（**不抛错**）。
  - **去重**: 同一文件的多次 listener 触发在 100ms 内合并为一次 `onChange(reason: 'change' | 'rename')`。
  - **回调签名**: `onChange({ path: string; reason: 'change' | 'rename' })` —— 异步 fire-and-forget；回调内抛错被 watcher 捕获不阻断后续事件。
  - **`stop()`**: 关闭两个 `fs.watchFile` + `fs.watch`，幂等可重复调；停后 onChange 不再触发。
- **验收**: `bun test tests/config/settings-watch.test.ts` 全绿（≥8 用例）。覆盖：
  - touch 现有 settings.json → onChange 触发，含 path + reason。
  - 创建 settings.json（首次）→ onChange 触发（rename 事件）。
  - 100ms 内多次连续 write → onChange 只触发一次。
  - `stop()` 后 write → 不触发。
  - 两个文件都监听：user 改 → onChange(user 路径)；project 改 → onChange(project 路径)。
  - onChange 回调内 throw → 不阻断后续事件。
  - 文件不存在不抛错（启动期常见）。
- **commit**: `feat(config): settings.json 文件级热更新 — settings-watch 纯函数模块 (T1)`
- **依赖**: 无。

### T2. `[implementation]` EnvLoader 工厂 + 热更新集成

- **Affects**: `src/config/env-loader.ts`（新建）、`tests/config/env-loader.test.ts`（新建）
- **接受**: 导出 `createEnvLoader(opts?: { cwd?, home? })` 返回 `{ get(): IknowEnv; reload(): IknowEnv; subscribe(fn): () => void; stop(): void; readonly onError: (fn) => void }`。
  - **内部**: 持 `loadIknowEnv()` 调用结果缓存；首次 `get()` lazy load。`reload()` 强制重读（settings + .env.local + .env + process.env），失败抛错且不更新缓存（保持旧值）。
  - **集成 watchSettings**: 构造时 `subscribe` 自己到 watcher；watcher 触发 → 自动 reload → 成功后通知所有外部 subscriber（新 env 作为参数），失败通知所有 `onError` 注册（错误作为参数）。
  - **可测性**: opts.cwd/home 透传（与 `loadIknowEnv(cwd, settings, home)` 同形），测试可注入 tmp settings 路径。
  - **`stop()`**: 关 watcher + 清所有 subscriber 引用 + 幂等。
- **验收**: `bun test tests/config/env-loader.test.ts` 全绿（≥6 用例）。覆盖：
  - `get()` 首次 lazy load；再次 `get()` 返回同一引用（缓存命中）。
  - `reload()` 强制重读返回新引用。
  - watch 触发后 subscriber 自动收到新 env。
  - reload 抛错（坏 JSON）→ 缓存不变 + onError 注册收到错。
  - `stop()` 后 watch 不再触发 + subscribe 的回调不被调用。
  - `createEnvLoader` 多次实例化互不干扰。
- **commit**: `feat(config): EnvLoader 工厂 + 热更新集成 (T2)`
- **依赖**: T1。

### T3. `[implementation]` SessionHub env 源接缝 + adapter 热重建

- **Affects**: `src/session-api/hub.ts`、`tests/session-api/hub-hot-reload.test.ts`（新建）
- **接受**: SessionHub 暴露 env 源订阅机制，**不动现有 `overrideEnv` 接口**（向后兼容）。
  - **新字段 `envProvider?: () => IknowEnv`**：构造 opts 可选；如果传入，每次 `ensureDeps` 用 `envProvider()` 拿 env（替代现有的 `loadIknowEnv()`）。T2 的 EnvLoader.get 就是这个 fn 的天然实现。
  - **新方法 `reloadFromEnv(): Promise<void>`**：清 `cachedDeps`（强制下次 lazy rebuild）+ 用最新 `envProvider()` env 走 `createAdapterFromEnv` 重建 adapter 替换 `cachedDeps.adapter`。**不重跑** `buildHarnessEngine` 整条装配链。
  - **抽出 `createAdapterFromEnv(env) → LoopEngineDeps['adapter']`** 从 `build-engine.ts`：把 `new Anthropic(...)` + `createRealAnthropicAdapter(...)` 抽成顶层 export 函数（纯函数，无 I/O），build-engine 内部继续调用它（保持整条装配链行为不变）；hub hot-reload 也调它。
  - **新事件 `onEnvChange?: (env: IknowEnv) => void`**：构造 opts 可选回调，hub `ensureDeps` 检测到 env 变化时（用对象身份比较 / version counter 两种实现都行）调用一次。**首次 ensureDeps 不触发**（没有「变化」）。
- **验收**: `bun test tests/session-api/hub-hot-reload.test.ts` 全绿（≥5 用例）。覆盖：
  - `envProvider` 注入后，`ensureDeps` 用其返回值建。
  - `reloadFromEnv` 后下一次 `postMessage` 拿到新 adapter）；`registry` / `executor` / `maxTurns` 引用保持稳定（**不重建**）。
  - `onEnvChange` 在 env 变化时触发一次（连续 reload 同值不重复触发）。
  - 不传 `envProvider` 行为零变化（向后兼容；测试用既有 fixture 回归）。
  - reload 抛错（model 缺失）→ cachedDeps 不动，process 不崩。
- **commit**: `feat(hub): SessionHub env 源接缝 + adapter 热重建 (T3)`
- **依赖**: T2。

### T4. `[implementation]` run.tsx 装配 EnvLoader + 重建 + 显示层刷新

- **Affects**: `src/tui/run.tsx`、`src/tui/app.tsx`
- **接受**: TUI chat 路径接入热更新。
  - **run.tsx**: 启动时 `const envLoader = createEnvLoader({ cwd, home })`，初次 `env = envLoader.get()` 拿初始 env。把 `envLoader` 通过 callback 方式传给 hub（`hub.setEnvProvider(envLoader.get)` 或新 opts 字段 `envProvider`）+ 订阅 `envLoader.subscribe(newEnv => hub.reloadFromEnv())`。**adapter 重建路径走 hub 的 hot-reload 通路，不直接碰 build-engine。**
  - **app.tsx**: 接收新的 `onEnvChange?: (env: IknowEnv) => void` props（在 `TuiApp` 上新增），用 `useEffect(() => setModel(env.llm.model); setDefaultThinking({mode: env.llm.thinking, effort: env.llm.thinkingEffort}), [envVersion])` 形式刷新 ContextBar 与 thinking 基线。env 用一个递增 `envVersion` counter 触发重渲染（避免对象身份比较陷阱）。具体刷新什么 state 由 implementer 看 app.tsx 现状决定（model 名 / thinking 显示）。
  - **serve / cli ask 路径**: 不在本 bullet 改；T3 已经让 hub 支持 envProvider，serve / ask 在后续若需要可单独立项（T3 已为它们铺路）。本 bullet 只接 TUI chat（用户当前问的主路径）。
- **验收**: `bun test tests/tui/` 全绿（既有 507 pass 全保，新加 ≥1 用例断言 envProvider 接通）；`bun test tests/session-api/` 全绿。手动烟测：`iknow chat` → `cat ~/.iknow/settings.json` 改 model → 下一轮 postMessage 看到 adapter 用新 model（验证方法：stub adapter 替换为 spy，记录 model 参数）。
- **commit**: `feat(tui): run.tsx 接入 EnvLoader 热更新 + ContextBar 实时刷新 (T4)`
- **依赖**: T3。

### T5. `[implementation]` 文档 + smoke 验证

- **Affects**: `docs/llm-config-quickstart.md`、新建 `scripts/i384-settings-hot-reload-smoke.ts`（探测号占位，按实际 issue 号调）
- **接受**:
  - docs 把 §3.1 后那段「settings.json 启动期一次性读入 → 改完重启生效」改成「热更新生效（watchFile 100ms debounce → 下一轮 postMessage 用新 env；reload 失败保留旧 env）」。
  - `scripts/i384-settings-hot-reload-smoke.ts` 跑真值：A 组（chat stub adapter）改 settings.json → 下一轮 model 名变化断言；B 组（serve HTTP）改 settings.json → 下一条 POST /messages 的 wire `model` 字段变化；C 组 reload 失败（坏 JSON）→ 旧 env 保留断言。
  - 跑完所有既有 test (`bun test tests/`) + `tsc --noEmit` + `prettier --check` 全绿。
- **commit**: `docs+smoke: settings 热更新落地文档 + smoke 真值验证 (T5)`
- **依赖**: T4。

## 验收（最终）

```
bun run typecheck                                    # exit 0
~/.bun/bin/bun test tests/                           # 全绿（不含预存 flaky）
npx prettier --check .                               # 全文件通过
bun run scripts/i384-settings-hot-reload-smoke.ts    # A/B/C 三组全过
```

## 完成标准

`grep -c "^\s*#### T" plans/settings-hot-reload.md` = 5；`git log --oneline | grep -i "hot.reload\|settings-hot" | wc -l` ≥ 5。

## 反向 / 风险

- **apiKey 变更走 placeholder 轮换**：`process.env[VAR]` 被 reload 取到最新（process.env 始终现读），没问题；占位符本身在 settings 里改（`${OLD_VAR}` → `${NEW_VAR}`）走同一 reload 路径，正常生效。
- **MCP / subagent 启动期配置变更**：不重读（MCP config 在 `build-engine.ts:288` 装配期读一次），本计划范围外；如果用户改了 `~/.iknow/mcp.json` 仍然需重启。可在 followup 单独 plan（**本期不做**）。
- **watcher 资源**：进程级单例 watcher，关停依赖 `envLoader.stop()`。run.tsx 路径：进程退出（SIGINT/SIGTERM）时由 `runtime.registerShutdown` 串到 envLoader.stop。**implementer 必须接到现有 shutdown 钩子上**，避免长程 serve 进程泄漏 watcher。
- **测试稳定性**：watcher 测试要避免真实文件 IO 在 tmpdir 里挂住；用 `mkdtempSync` + `afterAll rmSync` + 测试结束显式调 `stop()`。`bun:test` 的超时需放宽到 3000ms（fs.watch 在 WSL / CI 上偶发慢）。

## 调度方 = implementer（main 派）

main agent 直接派 `implementer` 子代理，prompt 里写清：

- cwd = 当前 worktree 根（已隔离，无需 EnterWorktree）。
- 工作模式：顺序执行 T1 → T2 → T3 → T4 → T5；每 bullet 末跑 `bun test tests/<本 bullet 新加 + 直接依赖>` + `tsc --noEmit`，绿了才 commit。
- commit message 严格按本计划列的格式（带 bullet 编号）。
- 不 push、不开 PR、不 merge（main 收尾时统一处理）。
- 任何 bullet 跑出来红，自行 debug 修；如果超出 2 个 commit 修不回去，上报 main 不要硬撑。
