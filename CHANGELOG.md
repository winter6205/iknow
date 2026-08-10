# Changelog

## 0.1.0 (unreleased)

### Changed

- **TUI 渲染后端迁移 ink → @opentui/react 0.5.1（#321/#343，2026-08-10）**: 一次性替换渲染后端，四大已知渲染问题全部收口 — (1) **scrollback 污染**：ink 每帧重绘泄漏到终端历史 → OpenTUI alternate-screen + Zig 双缓冲 dirty-cell diff 架构消除；(2) **行计数漂移**：删除整条行计数路径（`markdown-lines.ts` / `message-rows.ts` / `row-window.ts` / `chat-flow.ts` 窗口函数 9 文件），滚动交给 `<scrollbox stickyScroll>` 布局位置 ref 直查（`.scrollTop` / `.screenY`）；(3) **ANSI 着色测试脆弱**：5 个 skip 用例删除/重写，着色断言用 `captureSpans()` 结构化表达；(4) **keyboard probe 吞键**：自实现 Kitty 解析删除，全走 OpenTUI 内置键盘解析器 + `mockInput` 模拟。输入协议：`<text selectable>` 拖选 → `renderer.copyToClipboardOSC52`（OSC52 失败退回原生 `clipboard.ts` fallback 链）。旧 TUI 全量归档 `archive/tui-ink/`（只读参考，禁 import）。测试运行器 D2 裁决 B：`tests/tui/` 切 bun:test（Node 22 无 FFI），`npm test` = `vitest run && ~/.bun/bin/bun test tests/tui/`。平台：Linux（含 WSL2）实测验收；**macOS / Windows 未验证**。`ask` / 管道 / `serve` 路径零影响（`src/cli/` `src/harness/` `src/session-api/` 零改动）。

- **TUI 启动 banner 改版**（2026-08-06）：从「大号方形点阵 + 单线外框 + 整体水平居中」改为「占满整行宽度的圆角线框（与输入框 PromptInput 同款 borderStyle="round"）+ 小号扁平眼睛居左（16×6 braille，16 列 × 6 行）+ info 栏（Version / Cwd / Data dir）居右垂直居中 + 顶框左对齐 `◆ iknow tui`」。眼睛不再是大号方形（用户复看裁定"不要放太大、放左边一小块"），窄终端降级阈值随小眼 96 → 64 列。`src/tui/banner-art.ts` / `banner.ts` / `tests/tui/render-smoke.test.tsx` / `docs/design/DESIGN-BANNER.md` 同步更新；`scripts/gen-banner-art.py` 保留为旧全构图大眼存档档。
- **TUI 启动 banner 二轮**（2026-08-06，复看裁定）：首轮裁瞳孔 ±95px 方窗生成 16×6 小眼，**把眼睛裁掉了**——完整眼形（眼睑 / 眼框 / R 符文周围）丢失。改用操作员提供的新源图 `docs/design/eyeshape.png`（836×836 RGBA 透明底，主体 = 完整眼睛），alpha 隔离背景后**不裁切**，点阵改为 24×12 braille（24 列 × 12 行终端，显示比 1.000 近方形）。`BANNER_MIN_COLS` 随眼睛宽度 64 → 72；金色 R 符文仍在中间显示。`src/tui/banner-art.ts` / `banner.ts` / `tests/tui/render-smoke.test.tsx` / `docs/design/DESIGN-BANNER.md` 同步更新；旧 `scripts/gen-banner-art.py` 仍为旧全构图大眼存档档。
- **TUI 启动 banner 三轮**（2026-08-06，复看裁定）：眼睛扩到 **32×13 braille**（32 列 × 13 行终端，显示比 1.231 略扁；操作员确认贴图同款）；顶框 title 从 `◆ iknow tui` 改为 **居中** `◆ iknow`（去 tui）。`BANNER_MIN_COLS` 随眼睛宽度 72 → 80。`src/tui/banner-art.ts` / `banner.ts` / `tests/tui/render-smoke.test.tsx` / `docs/design/DESIGN-BANNER.md` 同步更新。

### Feature

- **settings 机制完善——loop 配置继承通道 (#353)**: 新增 `.iknow/settings.json` 作为 loop 配置（maxTurns · 压缩 contextWindow/thresholdTokens）的用户可设置、跨进程可继承单一事实源。`src/config/settings.ts` 双层加载 `~/.iknow/settings.json`（user）+ `<cwd>/.iknow/settings.json`（project，覆盖 user），逐层合并 + 非法值回退 + 深 frozen；`loadIknowEnv(cwd, settings?)` 增加 settings 注入缝，precedence `process.env > .env.local > .env > settings.json (project > user) > hardcoded defaults`（仅 loop-config 三字段引入 settings 回退，其它字段行为不变）。子代理自装配走同一 `loadIknowEnv()` 自动读 settings 文件，跨进程天然继承。未设置时行为与现状一致（默认无限 maxTurns / 默认关 proactive compact），无回归。测试：`settings.test.ts` 19 例 + `env.test.ts` 新增 7 例（settings 注入 / env 覆盖 / 非法 env 回退 / 真实文件集成 / serve·hub 同源暴露 / 子代理继承·不继承）。

- **手动压缩会话（TUI `/compact` + web 压缩按钮）**: harness 层已有的 `compactMessages`（proactive/reactive 双保险共用收口）补手动入口。后端：`compactMessages` 从 `src/harness/index.ts` 公共出口导出；`SessionHub.compactSession` 走 serialize → load → compact → save（幂等 no-op：低于阈值不落盘、不 bump updatedAt），`POST /api/v1/sessions/:id/compact` 路由 + `CompactSessionResponse` wire 类型（session + turns + compacted + before/afterCount）。TUI：词表新增第 9 条 `/compact`（running 拒绝 / draft 提示无上下文 / 压缩后从磁盘刷新并保留 lastUsage 读数）。Web：`ContextUsageStrip` 右侧压缩按钮 + `useSessionChat.compact()`（轻操作不置 loading/error 全屏，失败局部提示）。测试：hub 4 边界 + http 2 例 + web hook 3 例 + strip 4 例 + slash 6 例 + session-state 2 例 + hub-bridge 2 例 + app 端到端 2 例。

- **TUI 鼠标拖选复制 (#238)**: 应用内选区层 — DECSET 1002h drag 模式上报拖动坐标，app 维护 anchor/active 选区并渲染反色高亮（ink `<Text inverse>`），mouseup 自动把选中文本复制到系统剪贴板（复用 `copyToClipboard` 多平台 fallback 链）。Ctrl+Y 作为键盘逃生口（复制当前选区；无选区提示先拖选）。移除 `/copy` 命令与 `extractLastAssistantText`（#237 取消，词表 9→8 条）。新模块 `src/tui/selection.ts`（选区模型/坐标映射/文本提取纯函数）、`src/tui/selection-render.tsx`（反色高亮组件）；`mouse.ts` 扩展 `parseMouseAllEvents` 全 SGR 解析 + DECSET 1002h。测试：`selection.test.ts`（29 例）、`mouse.test.ts` 扩展（23 例）、`copy-flow.test.tsx` 重写为拖选 e2e（3 例）。

- **Memory injection v0 (#121/#228, ADR-0009/0010)**: 记忆文件分层注入着陆 — `src/harness/memory/` 模块（paths/schema/frontmatter/errors/discovery/bm25/promote/assembly/refresh）+ `memory_recall` / `memory_save` 工具入 `createDefaultAciRegistry` SSOT（8→10）。`IKNOW_ASSEMBLY_ORDER` 9 段收敛为 5 段（identity/soul/user_profile/bootstrap/memory_layer），memory_layer 单 slot 委托 `createSystemResolver`（mtime 缓存 + inflight 去重 + 装配失败不毒化）。surface split：ask 入口剥离 memory 工具 + memory_layer 不挂（identity 层恒在）；chat/tui/serve 默认开启。

- **Shift+Tab 切换 auto 权限模式（W2 扩展，对齐 openharness `PermissionMode`/`_MODE_LABELS`）**: TUI 与 REPL 在 `default ↔ full_auto`（显示标签 `"Auto"`）之间就地翻转模式——不动 ask 桥接、不重建 engine、不绕 `/permissions` 命令。`plan` 模式保留但**不进 shift+tab 序列**（避免误触让 mutating 工具被静默拒绝）；按 shift+tab 在 `plan` 时直达 `full_auto`。TUI：`<TuiApp>` 持一个可变 `PermissionModeContext`，chat 视图右上 dim `mode: <Label>` 指示行（窄列降级 `[auto]`/`[def]`），全局 useInput 监听 `key.tab && key.shift`。PromptInput 让出 shift+tab（不消费），广播给 app 层 handler。REPL：`runInteractive` 挂 `process.stdin` keypress 监听，调抽出的 `applyShiftTabModeFlip()`（单测覆盖）。`modeLabel()` / `nextShiftTabMode()` 导出（`src/harness/permission/modes.ts`），TUI deps 直连 v2 `createPermissionPolicy`（不再用 aci prototype 包装）。测试：`modes.test.ts` +3 例（`modeLabel` / `nextShiftTabMode`），`tests/cli/chat-mode-shift-tab.test.ts` 新 6 例（含 shift+ctrl+tab 守卫 / ctx 缺省短路），`tests/tui/app.test.tsx` +1 例（CSI `Z` 发 stdin → mode 翻 + 标签可见）。1974 全绿。
- **Identity assembly (#196)**: 在 `deps.system` 注入缝上装配身份层 — `identity` (Name/Kind/Signature) + `soul` (core truths/boundaries/vibe/continuity) + `~/.iknow/user.md` 用户画像 + 首启 `BOOTSTRAP` 引导。所有 iknow 入口 (chat / tui / ask / serve) 走同一装配层。`state.json` 持久化 `bootstrap_seeded`,二次启动跳过 BOOTSTRAP 段。`initializeIknowWorkspace()` eager + idempotent,在 `build-engine.ts` 与 4 入口(chat / serve / tui / ask)各调一次,失败降级 warn 不阻塞装配。

- **ACI 8 工具集 SSOT 注册层 (`createDefaultAciRegistry`)**: 新增 `src/harness/aci/tools/registry.ts`,把 `build-engine.ts` 手写的 8 件工具数组(bash/read_file/grep/glob/edit_file/write_file + web_fetch/web_search)抽成单一装配工厂,并对齐 upstream `create_default_tool_registry()`(`tools/__init__.py:48`)。`build-engine.ts` 与 `tui/deps.ts` 改为共用该工厂,消除 TUI 入口工具集分裂 — 修复 `iknow tui` 漏注册 `web_fetch`/`web_search` 且不消费 `IKNOW_WEB_PROXY` 的历史问题。工厂入参收窄为 `Pick<IknowEnv,"web">` + `sandboxRoot`(不传 LLM key 等敏感字段);`proxyUrl` 非法在装配期 fail-fast;`sandboxRoot` 越界保持执行期由 fs 工具拒绝(装配期不做 fs IO)。测试:`registry.test.ts` 新 7 例(5 边界类)+ `deps-tools.test.ts` 新 3 例(TUI tracer bullet,重构前红后绿);1422 全绿;ask 端到端 web_search 真出结果。

### Breaking (internal, pre-release)

- `iknow serve` 不再托管 `/api/v1/traces` 读 API；检测面板改由独立 `iknow trace` 子命令进程提供（默认端口 24881；`iknow trace --trace-out <path>` 读 `serve --trace-out <path>` 写入的同一 JSONL）。`--trace-out` 在 `serve` / `chat` / `ask` 上的写语义未变（仍由 hub 写埋点落到 JSONL）。详见 #183。
- `src/session-api/http.ts` 移除 `handleTracesRequest` import + `/api/v1/traces` prefix-dispatch + `SessionHttpServerOptions.traceFilePath`；`SessionHttpServerOptions` 仅保留 `hub` / `webRoot` / `host` / `port`。`src/session-api/serve.ts` 不再将 `traceOut` 转发到 session server，但 `serve` 仍 `accept --trace-out` 用于写侧。web 端：`getTraces` / `getTraceFields` 走 `TRACE_API = import.meta.env.VITE_TRACE_API_BASE ?? "/api/v1/traces"`；其余 session API 端点仍 `/api/v1`。Vite dev proxy 新增 `/api/v1/traces` → `http://127.0.0.1:24881`（`IKNOW_DEV_TRACE_API` 可覆盖）。`TraceReadError` 包裹不带 fs 细节，仍 500 internal。

- `getApiKey` / `assertOfflineCompatible`（`src/config/env.ts`，经 `src/index.ts` re-export）改签名为单 `opts` 参数（`{ envVarName, fileMap? }` / `{ env, agentMode? }`）；随 024 全仓库位置参数 → options object 重构，全仓库 ≥2 位置参数函数统一改为 opts 形态（41 文件，纯重构行为零变更；014/015/016/017 冻结契约 step/run/LoopAdapter/Executor.executeAll/Registry/TurnTrace 与 Error 构造器均不动）。包状态 `private: true` + `0.1.0 (unreleased)` 未发布，无外部消费者，仅记录内部 API 变更，审计可追溯。详见 #97（024）。
- 归档 `src/kb-*` 4-tool 套件（`kb_retrieve` / `kb_verify_citation` / `kb_compile` / `kb_governance`）+ 装配 facade `src/tools/registry.ts` -> `docs/archive/023-retire-kb-tools/`。CLI 产品路径（`buildHarnessEngine`）在 020 切到 harness 后已不再消费 `kb_*`（只跑 `echo` / `get_time` demo 工具），4-tool 套件仅作为 `src/index.ts` 导出 + 4 个 test 文件存活，零生产消费者。连带修剪：`src/index.ts` 删 13 行 export；`src/shared/schema.ts` 删 `Kb*Input/Output` / `Chunk` / `PriorChunk` / `SourceSpan` / `CompiledFact` / `SnapshotPayload` / `RRF_K` 等类型（保留 `CallerRole` / `SessionContext`，CLI slash 仍用）；`src/runtime/create-runtime.ts` 删 embedding/vector-index 路径，简化为 `store + env`；`src/cli/runtime.ts` 的 `RuntimeBundle` 删 `vectorIndex` 字段；删 4 个 test（`verify` / `compile` / `rrf` / `embedding`）。**保留为孤儿待后续清理**：`SessionContext.simulate_governance_timeout` / `--governance-timeout` flag / `prepareRuntime.degrade`（0 消费者）；`--embeddings` flag（runtime 内 no-op）。归档非删除，对齐 021/022 惯例。
- 移除 `src/index.ts` 对旧 `src/agent-loop/` 与 `src/eval/` 的 re-export（13 旧 loop 符号 + 5 EVAL 符号 + `eval/types` type re-export）；包状态 `private: true` + `0.1.0 (unreleased)` 未发布，无外部消费者，仅记录内部 API 变更，审计可追溯。详见 #48（021）Resolution Q3。
- `TurnDto.answer` 从 `IknowAnswer`（G2 envelope）改为 `TurnAnswerDto {finalText, stopReason, turnCount}`（harness RunResult 投影）；G2 envelope 在 Session API wire 退役。详见 #51（022）Resolution Q1。
- `SessionSummary` 移除 `caller_role` 字段；wire 不再接受/返回 caller role（harness 路径退役）。详见 #51（022）Resolution Q2-G4。
- 删除 `POST /api/v1/sessions/:id/commands` slash 端点（404）；slash 命令在 harness 路径退役。详见 #51（022）Resolution Q3。
- 新增 `GET /api/v1/sessions` 列表端点（`{sessions: SessionListEntry[]}`）+ web 会话历史侧栏（`SessionSidebar`）。详见 #51（022）Resolution Q1。
- `src/shared/schema.ts` 删除 `IknowAnswer` + `ToolCallLog` 类型定义；公开面经 `export type *` 不再 export（BREAKING for internal consumers）。详见 #51（022）Resolution Q1。
- 归档 `src/interaction/`（5 文件）→ `docs/archive/022-retire-interaction/` + `src/agent-loop/`（7 文件）→ `docs/archive/022-retire-agent-loop/`；归档非删除，对齐 021 惯例。详见 #51（022）Resolution Q5。
- Session API 路径切到 harness foundation（`src/session-api/` 零 import 旧 loop）；`SessionHub` 直接调用 `run()` + `priorMessages` 续传。详见 #51（022）Resolution Q1-Q5。

- ACI Web 类工具出站代理臂（`IKNOW_WEB_PROXY`，对齐 upstream `OPENHARNESS_WEB_PROXY`，trust_env=False 语义 —— 显式配置才生效，不读系统 `HTTP(S)_PROXY`）：`network-guard.createDefaultGuardDeps` 接受 `proxyUrl` 选项，构造 `undici.ProxyAgent` dispatcher 挂到 fetch 路径；代理 URL 走与目标同套 SSRF 语法校验（http/https / host / 凭据），host 不做公网 IP 防线（本地代理必须允许）；`web_fetch` / `web_search` 工厂 fail-fast 在装配时验证 proxy 配置（坏的 `IKNOW_WEB_PROXY` 在 build 期即抛，CLI 启动可见而非首次搜索暴露）。`env.ts` 新增 `IknowEnv.web.proxy`（`IKNOW_WEB_PROXY` 经 `loadIknowEnv` SSOT 读取），`buildHarnessEngine` 透传到两 Web 工具。`undici@^7.29` 入 `dependencies`（fetch 的 dispatcher 类型在 `undici-types@6`（`@types/node`）与 `undici@7` 间结构不兼容，在单一赋值边界用 `as unknown as` 桥接，附类型注释）。新增依赖：`undici@^7.29`。测试：`network-guard.test.ts` +5 例（非法 / 凭据 / 合法 proxyUrl / 缺省 / 旧 UA 签名兼容）+ `build-engine.test.ts` +1 例（坏 proxy 装配时报错 / 空 proxy 装配成功）；1396 全绿；smoke 验证 in-process HTTP proxy 看到 `CONNECT html.duckduckgo.com:443`（dispatcher 端到端生效）。

- web_search 默认端点切到 Bing（`cn.bing.com/search`，B1 决策）：DDG html 端点（upstream 默认）在部分网络环境不可达——实测 WSL2 + Windows host 解析器把整个 duckduckgo.com 域族解析到 Facebook/Meta IP（199.59.149.239 + face:b00c IPv6）且直连超时/ENETUNREACH，Google DNS 却解析到真实 DDG IP（104.244.43.229），本地 DNS 污染 + egress 阻断双重叠加导致 `web_search failed: fetch failed`。Bing 实测本机 200 + 结果结构完整、中国区可达。结果解析按端点 hostname 分派：DDG html 走 `result__a` / `result-link` + `result__snippet`（保留，经 `search_url` / `IKNOW_WEB_SEARCH_URL` 覆写可达）；Bing 走 `li.b_algo → h2>a + div.b_caption`。DDG `/l/?uddg=` 重定向归一仅作用于 DDG 解析器。测试：`web-search.test.ts` +4 例（默认端点指向 Bing / Bing HTML 解析出 title/URL/snippet / max_results 截断 / 空结果）+ 旧 DDG fixture 显式声明 DDG 端点（`searchDeps` 第三参）；**真实端到端验证**：工具无 stub 在 `cn.bing.com` 搜索 "rust async" 返回 3 条带 title/URL/snippet 的结果（rust-lang.org / runoob.com 等），非 mock。1400 全绿 + typecheck 绿。

### Added

- 流式渲染接缝贯通 chat + TUI（#188 + #198，wayfinder #201 决策集落地）：新建 `src/cli/stream-draft.ts` 共享层（纯累积 `append`/`masked`/`raw`/`reset`/`subscribe`，全量重 mask currentSecretValues，跨 delta 截断密钥由累积后整段遮蔽，无 fd / 无 React 依赖）；`SessionHub.postMessage` 新增可选 `onStream` 透传到 `run()`；`buildTuiDeps` adapter 装配 `stream: env.llm.stream === "on"` 与 `build-engine.ts` SSOT 同源——TUI 真实走流式臂；TUI `runTurnOnce` 构造 `createStreamDraft`，`useState + subscribe` 等价 `useSyncExternalStore` 快照语义（避免 getSnapshot 每调用返新串无限 re-render），`ChatView` 在 spinner 前以 Markdown 渲染 `draftsMasked`，turn 结束 commit 进 transcript、abort 清空草稿 + 「已打断」提示。chat TTY `createStreamPreviewSink` 改用 stream-draft，`lastWrittenLen` 增量写 `masked()` 切片，**完整密钥 SC20 路径生效**（跨 delta 截断已知边界在 D4 裁决后文档化）。thinking 折叠态统一：chat `showThinking=true` 从「展开全文」改为「折叠摘要行」（新增 `renderThinkingSummary` 导出函数，TTY 无折叠交互，摘要即折叠态）；TUI 新增 `/thinking` 斜杠命令切换 ChatView 折叠面板（全局运行态，不落盘），`estimateMessageRows` / `buildMessageRowSpans` 联动 `thinkingExpanded`（折叠=1 行 / 展开按文本行数累加）。plan: `plans/streaming-rendering.md`（6 tracer bullets，T1-T6 各为独立 commit）。回归验证：1359 测试全绿。

- Trace inspection panel：新增 `src/traceserver/`（read-only）：同步 JSONL reader（`MAX_TRACE_BYTES = 8 MiB` + 行边界截断 + `TraceReadError` 包裹 fs 错误）+ `GET /api/v1/traces`（filter：conversation_id / record_type / status；pagination：limit 1..200 / offset ≥ 0；坏行计入 `skipped_lines`；snake_case wire）+ `GET /api/v1/traces/fields`（字段声明表 `TRACE_FIELD_DEFS` SSOT，加载时自检 key 唯一性，违则 throw）；`SessionHttpServerOptions.traceFilePath` 接线（`serve --trace-out` 经 `path.resolve` 相对 CWD，对齐 ADR-0003 D3）；未配置 traceFilePath → 404 `not_found`、`TraceReadError` → 500 `internal`、参数非法 → 400 `validation`（含 `field`）。前端：web `TracePanel` 容器 + `TraceStatsBar` / `TraceFilterBar` / `TraceTable` / `TraceExpandedRow` 子组件；`App.tsx` 顶层 view 切换 `对话` / `Trace 面板`，chat view 始终挂载（`useSessionChat` 状态不丢），TracePanel 卸载/挂载可重新拉数；字段列选择 / datetime 格式化 / cell tone 抽到 `web/src/components/traceFields.ts` 供单测。**新增 trace 字段 = `src/harness/trace/types.ts` 加类型 + `TRACE_FIELD_DEFS` 加一行，面板自动生效**；写侧（`src/harness/trace/jsonl.ts` / `loop-engine.ts` / `hub.ts.recordViolationTrace`）未触碰，验证：33 单测 + 集成全绿。

- Trace 检测面板独立成由 `iknow trace` 进程托管的页面（trace.html），从 chat SPA 摘除；chat 页面回归纯对话形态。共享 vite 多 entry + 共享 `web/dist/assets/` chunk；trace 进程经 `src/web/serve-static.ts` 复用 chat 的静态托管 helper，落地 `/` → trace.html、SPA fallback、路径穿越 403、`/api` 拒绝守卫四件套；`/api/v1/*` 路由优先于静态（health 不会被 trace.html 遮蔽）。`web/src/App.tsx` 删 `Root` / `ViewTabs` / `TracePanel` 装配块，回到 chat-only 形态。详见 `plans/trace-separate-page.md`。

- ACI Web 类工具 `web_fetch` / `web_search`（`src/harness/aci/tools/web-fetch.ts` / `web-search.ts`，行为真值 upstream-openharness `web_fetch_tool.py` / `web_search_tool.py`）+ 共享 SSRF 出口层 `network-guard.ts`（URL 语法 / 嵌入凭据 / 非公网 IP 字面量与 DNS 结果 / 本地主机名 / 单标签 / ≤5 跳重定向逐跳重验 / 非 2xx 拒绝；fetch + DNS 解析 deps 注入，测试全离线；生产默认出口 `createDefaultGuardDeps` SSOT）+ 共享原语 `html-text.ts`（HTML→文本 / 实体解码）与 `ip-classify.ts`（IPv4/IPv6 非公网分类）。两工具 `aci` 元数据：`category=read-only`（权限默认 allow）/ `isConcurrencySafe=true` / `interruptBehavior=cancel` / `timeoutTier=default`（30s）。`web_fetch` 输出含 `UNTRUSTED_BANNER` 防 prompt injection 横幅 + HTML→文本提取（跳过 script/style + 实体解码 + 收边 trim + 段落换行 `\n` 保留以对齐 upstream HTMLParser 状态机可读性）+ `max_chars` 截断（默认 12000，运行时 clamp 500..50000）；`web_search` 默认 DuckDuckGo html 端点（`search_url` 入参或 `IKNOW_WEB_SEARCH_URL` 可覆写，覆写同受 SSRF 校验；env 读取经 `loadIknowEnv` SSOT——`IknowEnv.web.searchUrl`，工具不直读 process.env），`max_results` 默认 5（1..10），`/l/?uddg=` 重定向链接归一。`buildHarnessEngine` 装配 append-only 6 → 8 工具（既有顺序不动，policy byName 键空间稳定）。生产默认出口 UA 改为浏览器伪装串 `DEFAULT_USER_AGENT`（network-guard.ts SSOT；Mozilla/Chrome/AppleWebKit + `iknow/0.1` 后缀）——对齐 upstream `Mozilla/... OpenHarness/0.1.7` 风格，应对 Cloudflare 等反爬 UA 过滤（实测：旧产品 UA 被 Ars Technica 返 202 challenge；新 UA 使 TechCrunch 完整通过 200 + 301KB + 191 链接）。测试：web 工具 3 文件 66 例 + env 3 例 + html-text 38 例 + UA 默认值 3 例，共新增 110 例（正常 / 失败 / 边界 / 权限 / 空输入 / 并发扇出 / pathological HTML 6 类）。code-review 双轴审查：Standards 0 High（4 Medium 全整改：decodeEntities/defaultLookup 去重抽共享层、fetchPublicResponse 拆 followGuardedRedirects ≤30 行、env.ts SSOT 接线、clamp 运行时测试补齐）。

### Changed

- #120 会话持久化：会话池根从 `<cwd>/data` 迁至 `~/.iknow`，项目命名空间采用 `<basename>-<sha1(cwd)[:12]>`（`resolveProjectSessionDir`）；`serve --data-dir` 覆盖保留，旧 `<cwd>/data` 不读、不迁移、不删除。`SessionFileV1` schema 升级为 v2，新增顶层 `summary` / `cwd` / `sanitized_at`；`sanitizeSessionFile` 前向兼容 v1（读取时补齐并零写盘），拒绝 `schemaVersion > 2` 及形状错误的 `messages`，不做修复。`SessionStore.list()` 条目新增 `summary`，既有 `conversation_id` / `updatedAt` / `lastFinalText` 保持不变；CLI `CliChatState.messages` 改为 `ReadonlyArray` + `Object.freeze`（#120 Q3）。详见 `specs/120-session-persistence.md`。

- 抽取共享静态托管 helper `src/web/serve-static.ts`（`resolveDefaultWebRoot` + `serveStaticRequest({res, webRoot, pathname, fallbackHtml})`），从 `src/session-api/http.ts` 抽出 `MIME` / `resolveDefaultWebRoot` / `tryServeStatic` + `pipeFile`。`/api` 拒绝守卫 + 路径穿越 403 + SPA fallback 三件套行为不变；`src/session-api/http.ts` 改为 import helper（chat 行为零变化），trace 进程复用同一 helper（fallbackHtml `"trace.html"`）。纯重构，行为字节对齐。

### Web thinking/tool/markdown 显示（wire 加法式扩展）

- **session-api wire 加法式扩展**：`TurnAnswerDto` 新增可选 `thinking`（entries 文本列表 + `redactedCount` 计数）与 `toolCalls`（name / inputPreview / outputPreview / isError / truncated）投影；新模块 `src/session-api/turn-projection.ts`（纯函数）：thinking 每条目截断 `MAX_THINKING_TEXT_CHARS=2000`，tool input 预览截断 `MAX_TOOL_INPUT_PREVIEW_CHARS=500`、output 预览截断 `MAX_TOOL_OUTPUT_PREVIEW_CHARS=1500`，全部先经 `createOutputMask` mask 再截断（SC20 输出边界，与 finalText mask 一致）；`redacted_thinking.data` / `thinking.signature` 永不上 wire（replay 材料，仅计数）。postMessage 与历史回放（GET session）共用同一投影。
- **每请求 thinking 覆盖**：`PostMessageRequest` 新增可选 `thinking: { mode: "off" | "adaptive", effort?: "" | low | medium | high | xhigh | max }`；新模块 `src/session-api/thinking-override.ts`：wire 解析 + 值域校验（非法 → `ValidationError` → 400 嵌套 envelope，不静默回退）+ 按回合一次性 adapter 重建（仅替换 adapter，executor/registry/maxTurns/timeoutMs 复用缓存 deps）。无覆盖请求行为与既有 wire 字节一致；env `IKNOW_LLM_THINKING` / `IKNOW_LLM_THINKING_EFFORT` 仍为默认 SSOT。
- **web 显示**：markdown 渲染（react-markdown + remark-gfm + rehype-highlight；`MarkdownBody` + `CodeBlock` 语言标签 + 复制按钮）；`ThinkingBlock` 思考内容默认折叠（aria-expanded），redacted 仅渲染 `[已加密思考]` 计数占位；`ToolCallList` 工具调用卡片（单展开 + 截断标记「已截断」）；`ThinkingControls` 思考开关 + 强度分段选择（localStorage `iknow:thinking` 持久化，`toWireOverride` 随每次 postMessage 下发）。
- **web 已有功能完善**：非 completed stopReason 停止原因提示 + turnCount「N 轮」元信息（`StopNotice`；文案映射纯函数 `web/src/lib/stop-reason.ts`，completed / 未知值不显示）。
- 测试：`tests/session-api/turn-projection.test.ts` / `thinking-override.test.ts` + hub/http 扩展；`tests/web/thinking-settings.test.ts` / `tests/web/stop-reason.test.ts`（根 vitest；web 包禁测试框架的 spec 约束不变）。
- **不变 / 不声明**：SSE `/events` 仍 **501**（non-goal 不变）；G2 evidence 未回 wire（spec 022 退役，独立票）；`ask` JSON 通道与 CLI 投影零变化；harness 零 diff。决策补录：`docs/design/frontend-stack-upgrade-v1.md` §0.1；计划与 ACR 门禁：`plans/web-thinking-tool-display.md`。

### Docs (CLAUDE.md + architecture.md 整理)

- CLAUDE.md 删除 `### Runtime map` 14 行 path 表（~80% 与 `docs/architecture.md` Capability modules 表重复，且漏 `src/harness/` 等新模块），替换为 5 行 `### Module boundaries`（仅保留非显而易见边界 callouts），并指向 architecture.md 为 SSOT
- `docs/architecture.md` Capability modules 表补 `src/harness/`（Foundation，标注暂不接产品流量）/ `src/runtime/` / `src/tools/` / `src/config/` / `src/eval/`，并标 `src/agent-loop/` 待退役（016->018 路线）
- CLAUDE.md 删除「下阶段焦点」行（动态路线信息归 `docs/STATUS.md`，避免 always-on 层持有易腐数据）
- CLAUDE.md 上下文读取顺序：删除两个死引用（`docs/git-workflow.md` / `docs/testing.md` 不存在），加 codebase-memory 定位提示
- CLAUDE.md Domain docs 补 `specs/minimum-sequential-agent-loop.md` + `plans/minimum-sequential-agent-loop.md`；修正 `CHANGELOG.md` 路径为根目录（原 `docs/CHANGELOG.md` 不存在）
- CLAUDE.md `npm test` 注释更新：vitest 入口，含 `tests/harness/**`
- CLAUDE.md「I4」行去掉展望尾巴（I5 退到 STATUS 展望）

### Web MVP prototype → CLI integration (iknow-prototype)

- Prototype `/api/chat` **mock removed**; frontend now consumes the real **Session HTTP API** (`iknow serve`)
- New Session API client with typed DTOs + error envelope + graceful degrade (`src/lib/iknow-api.ts`)
- Non-streaming chat hook (v0 API returns one full **G2** `IknowAnswer` per turn): lazy session, host-side fake typewriter, abort/reset/commands (`src/hooks/use-iknow-chat.ts`); shared via `chat-provider.tsx`
- **G2 machine panel** (`src/components/answer-meta.tsx`): governance-status badge, `snapshot_id`, tool-call trajectory, cited `source_spans`, hops, notes — replaces the demo weather card
- Caller role (`employee|manager|admin`) + mode (`deterministic|llm`) wired to `…/commands` on the live session (`ui-store.ts`, `sidebar.tsx`)
- Same-origin proxy `/api/v1/*` → `IKNOW_API_PROXY_TARGET` (default `127.0.0.1:8787`); or set `NEXT_PUBLIC_IKNOW_API_BASE` to call a backend directly (CORS-free static-export path)
- Removed `ai` / `@ai-sdk/react` / `zod` deps + `serverExternalPackages` workaround (were mock-only)
- E2E rewritten against real `iknow serve` (Playwright dual `webServer`): 6 specs green — G2 envelope (governance=conflict), snapshot, source/tool spans, role switch, new-session reset, sidebar
- Verified: `typecheck` / `biome check` / `next build` (2 static routes) / `test:e2e` green
- **Decision (proposed, needs ratification):** product UI stack A (prototype → Next static export, `iknow serve`-hosted) vs B (port look/components back to Vite `web/`) — recommend **A**, flags conflict with `frontend-stack-upgrade-v1`: `docs/design/prototype-cli-integration-and-ui-stack-decision-v0.md`

### Web MVP prototype (iknow-prototype, standalone)

- New **`iknow-prototype/`**: Next.js 15.5 + React 19 App Router MVP, TypeScript strict
- Stack: Vercel AI SDK (`@ai-sdk/react` `useChat`, streaming + tool-call render), Tailwind 3.4 + shadcn-style `Button`, Zustand (UI state) + TanStack Query (history), Framer Motion, Lucide, react-markdown + rehype-highlight (code copy)
- Design: light/white base, <=5-color palette, non-AI aesthetic, no emoji
- Backend is a **key-free mock**: `MockLanguageModelV1` streams a deterministic answer + a `getWeather` tool call (`src/lib/mock-model.ts`); no real LLM/auth
- E2E: Playwright 6 specs (empty state, streaming+copy, weather tool card, suggestions, sidebar toggle, role switch); uses installed Chrome (`channel: chrome`)
- Verified: `typecheck` / `biome check` / `next build` / `test:e2e` all green
- Branch `feat/web-mvp-prototype` (not pushed); commits `66208c4`→`58af68a`
- **Unchanged / not claimed:** existing `web/` SPA, Session API contract, 4 tool protocol; prototype not yet wired to the CLI backend
- Handoff + next task (原型接入 CLI): `docs/handoff/2026-07-21-web-mvp-prototype.md`

### I4 smoke + LLM client resilience

- Full I4 interaction smoke: deterministic / embeddings / llm CLI + Session HTTP (`docs/handoff/i4-smoke/`)
- LLM client: force `stream: false`; `parseLlmResponseJson` tolerates SSE `data: [DONE]` trailers
- Tests: `tests/llm-client-parse.test.ts`
- Note: env name is `NINE_ROUTER_API_KEY`; some agent shells saw `models` 200 but chat/embeddings 401 on the same value (endpoint auth / env inheritance)
- Session closeout: CONTEXT / Claude.md runtime map / `docs/handoff/2026-07-13-session-closeout.md`

### Frontend stack upgrade (Vite + React + TS)

- Product UI package under **`web/`**: Vite 6 + React 19 + TypeScript SPA (`iknow-web`)
- Build output **`web/dist`**; `iknow serve` prefers dist (fallback to `web/` when absent)
- Design language: forest cockpit tokens (`web/src/styles/tokens.css`); API client mirrors Session API DTOs
- Dev: `npm run dev --prefix web` (proxy `/api` → `:8787`); prod: `npm run build --prefix web` then `npm run serve`
- Decision record: `docs/design/frontend-stack-upgrade-v1.md` · plan: `plans/frontend-stack-upgrade.md`
- **Unchanged / not claimed:** Session API contract; SSE still **501**; no production auth

### Session HTTP API + Web UI (host interaction)

- **`iknow serve`**: in-process Session API (`src/session-api/`) + SPA static host (`web/dist` preferred)
- Routes: `GET /api/v1/health`, `POST/GET /api/v1/sessions`, `…/messages`, `…/commands`, `…/reset`
- Every message returns full **G2** `IknowAnswer`; human projection optional
- Reserved: `GET …/sessions/:id/events` → **501** (SSE future)
- Contract: `docs/design/session-http-api-v0.md` · plan: `plans/web-interaction-session-api.md`
- Tests: `tests/session-api.test.ts` (hub + HTTP + static index)

### Product CLI chat (host interaction)

- **TTY REPL** + **pipe-aware** serial turns (`src/cli/chat-session.ts`)
- Session: `ConversationState`, `prior_chunks` bridge, slash `/status` `/mode` `/role` …
- Human view default in chat; `ask` / oneshot remain G2 JSON for scripts
- Explicit `--mode` wins over `IKNOW_AGENT_MODE`; empty ask → usage (no demo query)
- SIGINT: first warns, second exits immediately (`process.exit(130)`)
- Commits of note: `ffc475e` (CLI polish), `f431436` (ffc475e review SIGINT/chain)

### M1 / M2 model wiring

- Embedding vector arm (OpenAI-compatible) + optional LLM tool agent
- Fail-closed offline/key/protocol checks; deterministic remains CI default

### Trajectory eval harness (ADLC Phase 4 / P3 closeout)

- **`npm run eval`**: full 32-sample trajectory suite (`src/eval/*`)
- Structured `tool_calls` on every answer (trajectory-eval-spec §1.2)
- Hard gates: G2 / hops / edge policies; Sprint-1 soft target mean trajectory ≥0.6
- Results artifact path gitignored: `docs/iknow-spec/docs/eval/results/`

### P3 scaffold

Standalone enterprise KB agent (no gbrain runtime dependency):

- **4 tools**: `kb_retrieve`, `kb_verify_citation`, `kb_compile`, `kb_governance`
- **Agent loop**: hop-bounded loop (`max_hops`) with G2 response envelope
- **Knowledge store**: in-memory store (fixture seed for demos/eval)
- **Capability layout**: `src/kb-retrieve/`, `src/kb-verify/`, `src/kb-compile/`, `src/kb-governance/`, `src/agent-loop/`, `src/knowledge-store/`
- **Tests**: `npm test` — unit + eval-set + trajectory
- **Upstream**: `_upstream_gbrain/` gitignored READ-ONLY reference only — runtime has zero link to gbrain

### Initial scaffold

Bootstrap scaffold from project template.

- `bash scripts/bootstrap.sh` — 6-step idempotent setup
- `bash .evals/run.sh` — default = tier=fast baseline
- tier-grouped eval framework: fast/medium/slow, parallel within tier
- 3-layer memory model: CLAUDE.md / auto memory / `docs/`

### Review hardening (trajectory OCR + staged reviews)

- Shared `src/eval/lexicon.ts` + policy-string scorer (`policy-checks.ts`)
- Data-driven `session_overrides` on eval samples; resilient suite runner
- `ToolCallLog.ordinal`; `release_gates`; draft eval-set warn
- Store/compile/loop root-cause fixes from prior staged review

### Ops

- Remote: private `https://github.com/winter6205/iknow` (`master` tracking `origin/master`)

### Next

- Web/TTY interaction polish; optional session export; SSE streaming behind reserved path
- Ratify `docs/iknow-spec/docs/protocol/ADR-v0.1-assumptions-p3.md`
- Replace draft eval samples with real queries; calibrate soft gates
- Persist sessions + KB / observability / deploy (P4)
