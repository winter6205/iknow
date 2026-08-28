# iknow 功能现状与展望

> 维护说明：描述产品/工程事实。  
> 最后对齐代码线：harness foundation（`src/harness/`）→ CLI `chat`/`ask` + `serve`（Session HTTP + Vite React SPA，`web/` → `web/dist`）。

---

## 1. 已实现功能

### 1.1 运行时核心

| 能力                     | 说明                                                                                                                                       | 位置                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Agent 执行层             | harness foundation（loop-engine + anthropic-adapter + executor / registry）+ ACI 装饰层（条件装配下远多于 8 件，见 `registry` / gap 文）   | `src/harness/`（含 `src/harness/aci/`）                                          |
| 故障恢复                 | FaultClass（retry/fuse/none）；ModelAdapter 有界传输重试；工具环 `StopReason: fused` + LOOP_DETECTED；`src/harness/verify/` 零改           | `src/harness/fault-class.ts` + `with-transport-retry.ts` + `tool-loop-detect.ts` |
| 授权（per-tool-call）    | harness ACI 装饰层逐次工具调用授权                                                                                                         | `src/harness/aci/`                                                               |
| 配置加载                 | `.env` / `.env.local` + `process.env`；密钥只读 env 名                                                                                     | `src/config/env.ts`                                                              |
| LLM 配置单承载           | `settings.llm.model` 字面值 + `settings.llm.apiKey` 字面/占位符 + `llm.fallback`；`IKNOW_LLM_API_KEY_ENV`/`IKNOW_LLM_MODEL` 退役(ADR-0015) | `src/config/settings.ts` + `src/config/env.ts`                                   |
| **会话持久化**           | `~/.iknow` 跨进程池 + SessionStore JSON v2(#120)                                                                                           | `src/session-api/store/`                                                         |
| **记忆层**               | 三层落盘记忆库 + BM25-lite 检索 + `memory_recall` / `memory_save` + promote 门槛（ADR-0009/0010；`ask` 全 opt-out）                        | `src/harness/memory/`                                                            |
| **自动记忆（默认 OFF）** | `autoExtract === true` 时：completed 后异步 extract + 机械 GC（ADR-0031）；读路径短目录进 `system`、每轮最多 5 条预取进用户消息、`memory_recall` 仍 10 条原文（ADR-0034） | `src/harness/memory/` + `src/harness/auto-memory-wire.ts`                        |

**自动记忆（ADR-0031 / ADR-0034，2026-08-28）**：兑现 ADR-0009 D5 的延期项。**默认关**——`settings.memory.autoExtract` 缺失或非 `true` 时钩子不装配，宿主零调用、零额外 LLM、零写盘、无目录、无预取，与现网逐字节一致。开启后：chat / tui / serve 在 `StopReason=completed` 之后异步触发（累计 N≥2 完成 turn 一趟抽取，`ask` 不接线），LLM 抽原子候选 → BM25-lite 近邻 → 裁定 `ADD` / `UPDATE` / `SUPERSEDE` / `NOOP` → 复用 `memory_save` 的肯定句门禁与 tmp+rename 原子写，落盘打 `source: auto`。读路径（ADR-0034）：`system` 在 EXISTENCE_POINTER 之后可带现行条短目录 + 固定英文纪律句（未 promote 的 body 仍不得进 `system`）；每轮按用户原文用同一 `scoreMemoryEntries` 预取最多 5 条正文叠在用户消息侧（零词命中剔除）；`memory_recall` 默认仍最多 10 条 title+frontmatter+body 原文，并加同一英文低信任包装。清理是零 LLM 的机械 GC（TTL 过期 / 被 supersede / 超 cap 按 `importance × recency × (1 + recall_count)` 驱逐），**只软禁不删文件**。自动条目不豁免 promote 门槛。抽取 / 目录 / 预取 IO 失败经 host `// EXIT: log-and-continue` 吞掉，用户 turn 仍成功。**未做**：向量 / 图检索、默认 ON、auto-promote、记忆管理 UI、把预取或未 promote 正文写入 `system`。已知限制与遗留见 §2.5。

### 1.2 交互表面（I1–I3）

| 能力                         | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 位置                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **产品 CLI 多轮**            | TTY REPL + 管道串行；默认 TTY 无参进 chat                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `src/cli/*` + `src/cli.ts`                                                                            |
| 人读输出                     | 答案文本流（markdown）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `src/cli/format.ts`                                                                                   |
| 机器输出                     | `/json on` 或 one-shot JSON                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 同上                                                                                                  |
| Slash                        | CLI chat: `/help` `/quit` `/json` `/reset`; TUI 扩展 9 条(见 CHANGELOG #337/#321/#119): `/compact` `/thinking` `/effort` `/skill-name` `/mcp` 等                                                                                                                                                                                                                                                                                                                                                                                                         | `src/cli/slash.ts` + `src/tui/`                                                                       |
| 单次脚本                     | `ask "…"` / 裸 query → JSON（CI 兼容）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `cli.ts`                                                                                              |
| **Session HTTP API**         | 进程内多会话：create / message / command / reset；JSON 每轮                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `src/session-api/`                                                                                    |
| **Web 产品 UI**              | Vite + React + TS SPA（`web/`）；build → `web/dist`；`iknow serve` 优先托管 dist（无 dist 时回退 `web/`）；空/载入/错/数据四态 + 侧栏 JSON 投影；SSE 路径仍 **501**                                                                                                                                                                                                                                                                                                                                                                                      | `web/` + `iknow serve`                                                                                |
| **Trace 面板（同进程入口）** | 检测面板随 `iknow serve` 同进程同端口（8787）交付——`/trace` SPA + `/api/v1/traces/*` 路由子树（filter/paginate + `/fields` + `/sessions`）；header 全局 Trace 链接 + 会话行 ⇱trace deep-link（`/trace?session=<id>`）+ 面板返回对话链接。`iknow trace` 默认探测 serve health 后打印 `/trace` URL，`--separate` escape hatch 保留独立进程 24881（ADR-0020）。写侧 `src/harness/trace/` 零改动。                                                                                                                                                           | `src/traceserver/` + `src/session-api/` + `web/src/components/TracePanel.tsx`                         |
| Web thinking/工具/markdown   | markdown 渲染（react-markdown + remark-gfm + rehype-highlight）+ 代码块高亮复制；thinking 折叠显示（默认收起 + redacted 计数占位）；工具调用卡片（截断预览 + mask）；思考开关与强度（localStorage 持久化，随请求下发 override，env `IKNOW_LLM_THINKING*` 为默认 SSOT）；非 completed stopReason 提示 + turnCount 元信息；SSE 仍 **501**。注：`turnCount` 双语义——`POST /messages` 返回该次 `run()` 内层 loop 轮次（`RunResult.turnCount`，每次 run 从 0 起）；`GET /sessions/:id` 历史回放返回会话回合序号（`projectMessagesToTurns` 按 query 顺序计数） | `web/src/components/` + `src/session-api/turn-projection.ts` + `src/session-api/thinking-override.ts` |
| **Web MVP 原型（独立）**     | Next.js 15 + React 19 + Tailwind/shadcn + Zustand/TanStack；亮色非 AI 化；已接真实 Session HTTP API（mock 已移除）；JSON 机器面板（工具轨迹/引用）；角色·模式 → `/commands`                                                                                                                                                                                                                                                                                                                                                                              | `iknow-prototype/`                                                                                    |

**TUI 渲染后端平台声明（#321/#343，2026-08-10）**：TUI 已从 ink 迁移到 @opentui/react 0.5.1（Zig 原生渲染器，仅 bun 可驱动 FFI）。**Linux（含 WSL2）实测验收通过；macOS / Windows 未验证**（原生二进制跨平台行为属上游责任）。旧 ink 实现归档 `archive/tui-ink/`（只读参考）。

**TUI skill + MCP 扩展源（#337，2026-08-11）**：TUI 入口与 chat/serve 对齐 skill 与 MCP 扩展源装配——`skill` / `skill_search` 工具 + `<available_skills>` 系统段 + MCP manager 连接（`mcp__*` 工具经 tool_search discover）。slash 输入 `/` 混显静态命令 + 动态 skill 候选，Tab 补全；`/skill-name [提示词]` 确定性加载（skill 正文拼入 user message 发送）；`/mcp` 看板查看 server 状态 / 工具详情 / reload。

**TUI 可见闭环（horizon-653 包1，PR #666，2026-08-24）**：验证终态对人可见（`VerifyBanner`，HITL + 自动模式）；**环境现势**（cwd / git / diff 要点，上限 2000 codepoints）挂在 TUI chrome，与 ADR-0028 状态栏分离。模型侧 verify 长信封仍隐藏。

**内核包2（horizon-653，PR #671，2026-08-25）**：前台 `runInSandbox` 与后台 `bash` spawn 共用同一套 bwrap 围栏参数；同一 tool 阶段连续 `isConcurrencySafe` 调用可重叠执行，unsafe 仍串行，`tool_result` 顺序与 `tool_use` 一致。spec/plan 已归档。

### 1.3 评测与质量门禁

| 能力          | 说明                                                     |
| ------------- | -------------------------------------------------------- |
| 单元/契约测试 | `npm test`（含 harness / chat-session / llm mock / env） |
| 结构化 trace  | harness `trace`（JSONL via `src/traceserver/`）          |
| 审查修复闭环  | 多轮 live-review 根因修复已合入主干                      |

### 1.4 工程与协作

| 能力         | 说明                                                            |
| ------------ | --------------------------------------------------------------- |
| 独立仓库     | 私有 GitHub `winter6205/iknow`，`master` 跟踪 `origin`          |
| 接入材料模板 | 网络 API + Key 画像（`docs/integration-materials.env.example`） |

---

## 2. 未实现 / 仅部分实现

### 2.1 产品与数据

| 缺口           | 说明                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------- |
| **鉴权生产化** | 授权由 harness ACI 装饰层逐次工具调用承接；完整 ACL/审批流待 ADR                              |
| **Web 生产化** | SPA 构建链已定（Vite React → `web/dist` + 同进程 API）；无鉴权 / 无多租户 / 无 CDN 发布流水线 |
| **流式输出**   | SSE 路径预留 `…/events` → **501**；无 token streaming                                         |

### 2.2 交互与 Agent 体验

| 缺口                    | 说明                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------- |
| **9router key 对齐**    | shell key 与 9router chat 对齐仍为运维项（探针 `scripts/i4-probe-nine-endpoints.ts`） |
| **指代/省略续问鲁棒性** | LLM 依赖模型与 harness history，未系统评测                                            |
| **澄清轮（0 tool）**    | 设计允许「意图不清先问」；未作为一等状态机落地                                        |
| **anthropic_tools**     | 仅 openai_tools；选 anthropic 会 fail-closed                                          |
| **全量 context 打包**   | history 有字符预算；未从窗口严格扣 system/tools/检索正文                              |

### 2.3 协议开放项（设计未决，禁止静默定稿）

> 设计待决见 `specs/README.md`（活跃 spec 索引）与 `docs/adr/`（决策 SSOT）；已落地/superseded spec 归档 `docs/archive/025-retire-completed-specs-and-plans/`。

### 2.4 运维与上线（P4）

| 缺口       | 说明                                    |
| ---------- | --------------------------------------- |
| 可观测性   | 无统一 trace_id、指标、告警、成本看板   |
| 限流与配额 | 无租户级 RPM/TPM 产品封装               |
| 部署与发布 | 无标准镜像/编排/健康检查发布流水线      |
| 密钥托管   | 依赖本机/OS env；无集成密钥管理系统说明 |

### 2.5 自动记忆已知限制 / 遗留（ADR-0031 code-review follow-up）

> 来源：2026-08-26 自动记忆整轮 code-review（Standards + Spec 双轴）判定「不阻塞合入」的 3 Medium + 6 Low。默认 OFF 时钩子不装配，以下全部不可达；**扩大 opt-in（尤其改默认 ON、或让 serve 多 workspace 用自动记忆）前须逐条处置或显式接受**。

| 级别        | 项                              | 现状与影响                                                                                                                                                                                                                                                                    | 处置方向                                                                                       |
| ----------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Medium      | SessionHub 多 root「首根胜出」  | `src/session-api/hub.ts` 懒取写 `this.autoMemory = this.autoMemory ?? built.autoMemory`：engine 本身按 root 缓存（`engineByRoot`），钩子却是进程级单例，只认第一个建成的 root。一个 serve 进程绑多个 workspace 时，root B 的 transcript 会写进 root A 的 `memoryDir`          | 与 `engineByRoot` 同形态改成 per-root 持有；在此之前 serve 的自动记忆按「单 root」使用并文档化 |
| Medium      | BM25 / CJK 分词                 | `src/harness/memory/bm25.ts` 的 `tokenize` 与 `ingest.ts` 的 `tokens` 都按 `[^a-z0-9_]+` 切分（ASCII-only）。纯中文候选切不出 token → 近邻检索无命中、containment 恒等退化，四态裁定实际退化为**全 ADD**，UPDATE / SUPERSEDE / NOOP 形同虚设                                  | 中文分词或 n-gram 兜底；未做前中文项目的自动记忆会持续堆重复条目                               |
| Medium      | `notifyAutoMemory` 双份实现     | `src/cli/chat-session.ts` 与 `src/session-api/hub.ts` 各有一份同语义的 try/catch 转发（钩子缺席即 no-op + 失败吞掉）。两处漂移会让 chat 与 serve 的吞错语义不一致                                                                                                             | 抽到 `src/harness/auto-memory-wire.ts`（已是该场景的组合缝），两 host 共用一份                 |
| Low         | 错误类型命名域不匹配            | `src/harness/memory/auto-hook.ts` 的 `requireGate` 校验的是 hook 选项 `minCompletedTurns`，抛的却是 `MemoryGcOptionInvalid`（GC 域）                                                                                                                                          | 提取共用的 option-invalid 类型，或新增 hook 域错误类                                           |
| Low         | `ingest.ts` 变量遮蔽            | `extractMemoryCandidates` 内层 `for (const raw of parsed)` 遮蔽了外层 `let raw: string`（LLM 原始输出）。当前无行为 bug，只是可读性与后续改动风险                                                                                                                             | 内层改名（如 `item`）                                                                          |
| Low         | 启发式阈值未校准                | 四态判定的 `SAME_SUBJECT_FLOOR` / `NEAR_DUPLICATE_FLOOR` / `RESTATEMENT_FLOOR` / `CONTRADICTION_FLOOR` 与 `MIN_CANDIDATE_CONFIDENCE` 均为拍脑袋常量，无调参证据（ADR-0031 consequences 已承认）                                                                               | 有真实语料后统一校准；常量已集中在 `ingest.ts` 一处便于改                                      |
| Low（Spec） | UPDATE 吞并邻居 provenance      | `persistMemoryOps` 的 UPDATE 复用邻居 slug 但整条重写 entry：`ttl_days` 取本次入参、`source` 覆写为 `auto`、`supersedes` 归 `null`。手写条目（`memory_save` 落盘、无 `source`）被自动 UPDATE 命中后，其 TTL 与来源标记被吞掉                                                  | UPDATE 走「读旧条目 → 合并字段」而非全量重建，至少保留 `ttl_days` / `source`                   |
| Low（Spec） | `drain()` 未挂 host shutdown    | `AutoMemoryHook.drain` 注释自称「Test seam and shutdown hook」，实际只有 `tests/harness/memory/auto-hook.test.ts` 调用；`build-engine` 组合 shutdown 与 `hub.shutdown()` 都没挂。进程退出时 in-flight ingest 会被截断（写是 tmp+rename 原子的，不会半条，但这一趟记忆丢失）   | 挂进 host 组合 shutdown，或把注释改成「测试缝」以与接线一致                                    |

---

## 3. 未来展望

### 3.1 近端（建议 1–2 个迭代）

1. **horizon-653**
   - 包1 感知：**已合入** PR #666（TUI Verify 终态 + 环境现势）。
   - 包2 内核：**已合入** PR #671（沙箱纪律 + `isConcurrencySafe` 调度）。
2. **可靠性 / 工作流**
   - 故障恢复：**已在工作树落地**（T1 FaultClass → T2 传输重试 → T3 环检测+`fused`；PR #683/#684/#685）。澄清轮 / 设计审批仍 defer。手动 `/compact` 不走 token 门挂 #270，不在 672 spec。
3. **观测最小集**
   - 结构化日志：conversation_id、turn、tool 耗时、是否 llm。

### 3.2 中期

1. **多轮 / 会话质量**：跨 run 会话持久化、注入 history 的 N 步样本评测。
2. **Harness 工具扩展**：按需追加工具（受 harness ACI 装饰层约束，permission / timeout tier 必须先固化）。
3. **LLM 护栏硬化**：可配置 host 规则（强制 first-hop read_file、sensitive approval 等）。
4. **Session API 增强**（鉴权、SSE、会话持久化）— Web 已走 Vite React SPA，不重开协议。

### 3.3 远期

1. **P4 工程化**：多租户、审计合规、审批流与企业 IdP 对接。
2. **人机协同**：approval 流产品化（受 harness ACI 装饰层授权机制承接）。
3. **持续评测**：生产抽样 + 漂移告警 + 成本门禁。

### 3.4 非目标（刻意不做）

- 在 harness 通用 agent 之外另起 KB suite 取代当前工具集
- 用「展示层省略 trace 字段」换取简洁 UI

---

## 4. 能力地图（一句话）

| 层                       | 状态                                                                 |
| ------------------------ | -------------------------------------------------------------------- |
| Harness foundation       | **有**（loop-engine + anthropic-adapter + ACI registry，件数见 gap） |
| CLI 多轮交互             | **有**（进程内会话）                                                 |
| HTTP 会话 + Web SPA      | **有**（Vite React `web/`→`dist`；SSE/鉴权未做）                     |
| 生产数据 / 持久化 / 上线 | **会话 JSONL 有**（`~/.iknow`）；无多租户 / 无上线流水线             |

---

## 5. 常用命令（现状）

```bash
npm test
npx tsx src/cli.ts chat
npx tsx src/cli.ts ask "单次问题"

# Session API + static host (prefers web/dist after SPA build)
npx tsx src/cli.ts serve --port 8787
# or: npm run serve

# Trace 面板（ADR-0020：同进程入口；HTTP 探测 serve 后打开 /trace SPA）
npx tsx src/cli.ts trace
# 同进程未起 / 想独立跑：保留独立进程 24881
npx tsx src/cli.ts trace --separate

# Frontend SPA (package under web/)
npm install --prefix web
npm run dev --prefix web      # Vite :5173, proxy /api → :8787 (run serve in another terminal)
npm run build --prefix web    # → web/dist  (root alias if present: npm run web:build)
# root alias if present: npm run web:dev
```

配置：`.env.local` + 环境变量中的 API Key（见 `docs/integration-materials.env.example`）。

---

## 6. 文档索引

| 文档                                                 | 用途                                                                 |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| `specs/README.md`                                    | 活跃 module spec 活索引（SSOT；只列当前活跃，新增/归档只改那里一处） |
| `docs/architecture.md`                               | 运行时能力切分                                                       |
| `docs/coding-agent-capability-gap.md`                | 编程智能体能力补全评估（差距矩阵 + 优先级；#653 输入 SSOT）          |
| `docs/CONTEXT.md`                                    | 领域术语                                                             |
| `CHANGELOG.md`                                       | 版本变更                                                             |
| `docs/archive/025-retire-completed-specs-and-plans/` | 已落地 spec / plan                                                   |
| `docs/archive/026-historical-research/`              | 上游映射 / 原型调研（非产品 SSOT）                                   |
| 本文 `docs/STATUS.md`                                | **已实现 / 未实现 / 展望**                                           |

---

_更新本文时：改代码能力后同步 §1–§2；改路线图时同步 §3；并在 CHANGELOG 留一条引用。_
