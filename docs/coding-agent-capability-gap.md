# 编程智能体能力补全评估

> **评估日期**：2026-08-25（包2 合入后修订）  
> **方法**：能力标尺梳理 + iknow 能力盘点 + harness 内核深度核验  
> **结论口径**：以代码与活跃 `specs/` 为准；STATUS §1/§3 已于 2026-08-25 对齐 horizon-653 包1+包2；故障恢复合同见 `specs/672-fault-recovery.md`（#672 清图，代码未落地）。

---

## 1. 总判

生产级编程智能体可概括为：

> **Agent = Model + Harness**  
> **Harness = 上下文管理 + 工具接口 + 约束 + 验证 + 纠正**

iknow **已越过「最小七工具 ReAct Demo」**，内核处在 **早期生产级 Harness**。  
待补全的重点不在「再堆工具」，而在 **可靠性工程深度、工程化工作流一等公民化、以及产品/观测面**。

一句话定位：

> **iknow 处在 Claude Code / Codex 类开源 Harness 的中段**：工具、验证骨架、TUI 感知（包1，PR #666）以及前台/后台沙箱纪律 + `isConcurrencySafe` 并行调度（包2，PR #671）已落地。近端缺口转向故障恢复、流式宿主面、以及澄清/设计审批工作流。

---

## 2. 能力标尺（压缩）

### 2.1 可操作定义

完整编程智能体应同时满足：

- 能自主编写、修改并执行代码；
- 以文件系统为记忆 / 知识 / 产物中枢；
- 极简可组合工具箱（七工具或等价 Bash）；
- Harness 落实约束—验证—纠正：目标明确时可自动验收（测试 / CI / lint），危险动作受沙盒与语义级护栏约束，故障有分级恢复与熔断；
- **完成标准是验证通过，不是模型自称写完**。

成熟度高的主因通常不是模型更强，而是测试、类型检查、版本控制等工程基础设施构成了强 Harness。

### 2.2 成熟度阶梯

| 阶           | 含义                                                       |
| ------------ | ---------------------------------------------------------- |
| 最小可运行   | LLM + ReAct + 七工具（或单 Bash）+ 结果回写                |
| 生产可靠     | + 权限 / 沙盒 / 语义约束、分层压缩、故障恢复熔断、人机升级 |
| 开放任务通用 | + FS 记忆、Skills / MCP、子代理隔离、项目指令文件          |
| 前沿         | 后训练、多委托忠诚度、Graph / Loop、自举、符号级 IDE       |

### 2.3 架构原则 TOP 5

1. **Harness 重于换模**——竞争力在约束 / 验证 / 纠正。
2. **约束优先于指导；验证自动化；反馈快且结构化；回退可靠**。
3. **完成由验证判定，不由模型自称**。
4. **文件系统为中枢 + 知识在仓库内**（Agent 看不到 ≈ 不存在）。
5. **观察 / 动作空间与 ACI**——扩展接口常比换模更有效。

---

## 3. iknow 现状摘要

### 3.1 产品定位

独立打包的 tool-calling LLM agent harness（loop engine + Anthropic adapter + ACI 工具集），经 CLI / TUI / Session HTTP + Web 交付本机编程助手。

证据：`docs/architecture.md`、`docs/STATUS.md` §1.1。

### 3.2 内核已具备

| 能力                       | 状态                                  | 主要证据                                                                |
| -------------------------- | ------------------------------------- | ----------------------------------------------------------------------- |
| Loop + 停止语义            | 已落地                                | `src/harness/loop-engine.ts`；7 类 StopReason                           |
| ACI 工具面                 | 已落地（条件装配约 30 名 + `mcp__*`） | `src/harness/aci/tools/registry.ts`                                     |
| 上下文压缩                 | 已落地                                | `src/harness/compress/`；proactive + reactive                           |
| 权限–沙箱–密钥             | 偏强（硬墙 ≠ 语义 AST）               | `permission/` + 共享 bwrap 围栏 + `secret-roundtrip/`                   |
| Verify 闭环                | 内核强 / TUI 人读已补（PR #666）      | `src/harness/verify/`；`src/tui/verify-banner.tsx`；hub 投影含 `passed` |
| Subagent                   | 进程隔离成熟；编排未产品化            | `src/harness/subagent/`；`graph/` 未接线                                |
| Skill / MCP / Memory / LSP | 已落地（范围有边界）                  | `skill/`、`mcp/`、`memory/`、`lsp/`                                     |
| 多表面                     | 已落地                                | CLI / TUI / serve+SPA / Trace（ADR-0020）                               |

### 3.3 工具面 SSOT（摘录）

`ACI_TOOLSET_NAMES` 含：`bash`、`read_file`、`grep`、`glob`、`edit_file`、`write_file`、`web_*`、`memory_*`、`tool_search`、`lsp_*`（×10）、`skill` / `skill_search`、`spawn_subagent` / `subagent_result`、`todo_write`、`list_mcp_resources` / `read_mcp_resource`、`bash_output` / `bash_stop` 等（条件装配）。

### 3.4 明确非目标（刻意不做）

- 在 harness ACI 外另起专用 tool suite
- 耐用多租户 / 生产鉴权（architecture Non-goals）
- 模型后训练 / Agent 自举（当前产品定位之外）

---

## 4. 能力补全矩阵

| 维度                | 目标能力                           | iknow                                                 | 补全等级                                                   |
| ------------------- | ---------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------- |
| 核心工具箱          | 七工具                             | 已覆盖且更广（含 LSP×10 等）                          | **已超标**                                                 |
| Loop / 停止语义     | ReAct + 明确停止                   | loop-engine + StopReason                              | **已对齐**                                                 |
| 上下文压缩          | 分层压缩 + 熔断                    | proactive / reactive compact                          | **基本对齐**（预算未严格扣 system/tools）                  |
| 权限 / 沙箱         | 默认授权；bwrap；语义级 shell 约束 | per-call ask + 前后台同一 bwrap 围栏 + hard-walls     | **部分**（硬墙 ≠ 语义 AST；包2 已对齐纪律，**不是**裸跑）  |
| 验证闭环            | 测试/CI 判完成                     | verify-loop + evidence-checker + 判官                 | **内核强 / TUI 人读已补**（PR #666）；Trace/Web 产品面仍弱 |
| 环境现势 vs 状态栏  | 人读 cwd/git/diff；模型栏另约      | TUI 环境现势已落地；ADR-0028 栏仍仅 `last_tool`+todos | **人读已补**（刻意不进状态栏）                             |
| 持久 shell          | 默认共享终端会话                   | 未见产品级持久 PTY                                    | **待补全**                                                 |
| 并行工具            | 流式启动 + 并发 + 故障边界         | `isConcurrencySafe` 波次调度；unsafe 仍串行           | **已对齐内核**（#671）；流式启动产品面仍弱                 |
| 澄清 / 设计审批     | 复杂任务一等流程                   | identity 有；澄清轮非一等状态机                       | **部分**                                                   |
| Skill / MCP         | 渐进披露 + 发现                    | 已接线                                                | **已对齐**（远程 OAuth 等非目标）                          |
| 记忆                | FS 中枢长期记忆                    | BM25 memory + identity                                | **部分对齐**                                               |
| Subagent / 多 Agent | spawn + 隔离；有新信息才拆         | 进程级成熟；`graph/` 未进产品路径                     | **部分**                                                   |
| 故障恢复            | 四层故障 + 指纹循环 + 熔断         | 有局部重试，未达完整分类学                            | **待补全**                                                 |
| 流式产品面          | 流式交互                           | 内核/TUI 有；HTTP SSE **501**                         | **待补全**                                                 |
| 评测 / 进化         | 边界集、轨迹驱动改进               | `npm test` + JSONL；无成本/漂移门禁                   | **待补全**                                                 |
| 后训练 / 自举       | 前沿能力                           | 非目标                                                | **不做**                                                   |

---

## 5. 三类结构性债

### A. 可靠性债

1. Shell 安全靠硬墙模式，非语义解析 → 组合爆炸绕过面仍在。
2. 故障分类学 / 指纹死循环 / 熔断阈值表未系统化。

### B. 工作流债

理想流程：项目文档化 → 澄清 → 设计审批 → 实现 → 测试修复 → 自审 → 文档同步。  
iknow 有工具与 verify；TUI 环境现势已给人看 cwd/git/diff（不进 ADR-0028 状态栏）。澄清 / 设计审批未成一等状态机；无默认持久 shell。Harness 尚未强制把任务推向「目标明确 + 可自动验证」象限。

### C. 产品化债

- Verify **TUI 人读已落地**（PR #666）；Trace / Web 仍弱 → 多表面感知未齐。
- Web SSE 501、无鉴权 → 宿主面未闭环。
- Graph / 多 agent 编排代码存在但未接线 → 不宜过早叙事「多 agent 平台」。
- 观测停在 JSONL，缺统一成本 / 漂移门禁；OTel 桥 stub throw。

---

## 6. 内核级待补全清单（≤10，带路径）

1. **~~并行工具执行~~** — **已落地**（PR #671：`concurrency-waves` + ACI `executeAll` 批处理 + `runToolPhase` 真批）。
2. **~~后台/前台沙箱纪律对齐~~** — **已落地**（PR #671；共享围栏构造缝）。
3. **graph 产品路径接线** — `src/harness/graph/` 无外部 import。
4. **~~内置工具 lazy~~** — **作废**（[#635](https://github.com/winter6205/iknow/issues/635) 否决内建 lazy；渐进披露走 discovered append + MCP 概览，见 #640）。
5. **spawn_subagent `background:true`** — `spawn-subagent-tool.ts`。
6. **Context 预算统一扣减** — `docs/STATUS.md` §2.2。
7. **Observability B-scope** — `trace/observability-bridge.ts` throw。
8. **非交互入口 fail-closed 摩擦** — ask/worker 无交互时 mutating 易被拒。
9. **Shell 约束从硬墙升级到语义级** — 边界仍依赖 bwrap + 危险模式。
10. **SSE / 流式产品面** — `session-api` `/events` → 501。

---

## 7. 补全优先级

| 优先级        | 动作                                                                   | 理由                                      |
| ------------- | ---------------------------------------------------------------------- | ----------------------------------------- |
| **P0 已落地** | 并行工具调度 + 前后台沙箱纪律（包2）                                   | PR #671                                   |
| **P0 已落地** | TUI 环境现势 + verify 终态人读（包1）                                  | PR #666；**不**改 ADR-0028 状态栏         |
| **P1**        | 故障恢复：FaultClass + 传输重试装饰器 + 工具环检测（#672 spec；三 PR） | 可靠性上限；合同已收口，代码未落地        |
| **P1**        | 澄清轮 / 设计审批最小状态（复杂任务门）                                | 推进可验证象限                            |
| **P2**        | SSE 产品化；context 统一预算                                           | 宿主完整度                                |
| **P2**        | 语义 shell 解析（或 Sidecar 复核危险命令）                             | 安全上限                                  |
| **P3**        | Graph 接线 / 多 agent 协商                                             | 单 agent 闭环稳定后再做；无新信息不要硬拆 |
| **不做**      | 后训练、自举、Computer Use 全栈                                        | 与非目标一致                              |

---

## 8. 最强 / 最弱

### 最强 5

1. Loop + 明确停止语义 + append-only 历史
2. ACI 工具面广度（含 LSP 符号能力）
3. 权限–沙箱–密钥三角
4. 多表面同引擎交付
5. 压缩 + 身份 / 记忆注入 + 状态栏骨架

### 最弱 5

1. HTTP/Web 实时流与生产化（SSE 501）
2. 运维可观测与评测产品化
3. Subagent 编排产品化（graph 未接线；live 路由仍脆弱）
4. 澄清轮 / 严格 context 预算 / 指代续问未系统评测
5. Shell 语义级约束（硬墙仍在）

---

## 9. 证据与边界

### 已核验

- 本地：`docs/STATUS.md`、`docs/architecture.md`、`specs/README.md`、`src/harness/**`
- 交叉：`ACI_TOOLSET_NAMES`、包2 波次调度（`concurrency-waves.ts` / `runToolPhase`）、`agent-status` 仅 last_tool + todos（ADR-0028）；TUI 环境现势 + VerifyBanner = PR #666

### 未核验

- 未跑端到端 live 任务对照 Claude Code / Codex
- macOS / Windows TUI 未验（STATUS 已声明）

### 文档风险

- `docs/STATUS.md` 已于 2026-08-25 同步 horizon-653 包1+包2；仍可能滞后于 registry 细节——冲突时以代码 + 本文为准。

---

## 10. 相关文档

| 文档                           | 关系                     |
| ------------------------------ | ------------------------ |
| `docs/architecture.md`         | 运行时能力切分 SSOT      |
| `docs/STATUS.md`               | 功能现状（部分字段滞后） |
| `docs/CONTEXT.md`              | 领域术语                 |
| `specs/README.md`              | 活跃 spec 索引           |
| `specs/verify-goal-gate.md` 等 | Verify 双模式            |
| `specs/security-guardrails.md` | 权限 / 沙箱 / 中断       |

---

_本评估为能力补全输入，不替代 ADR。包1/包2 无新路线 ADR；STATUS §1/§3 已随 PR #666 / #671 + 本文修订同步。_
