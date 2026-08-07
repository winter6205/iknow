# Spec: #121 实施着陆 — PR #194 vs master (#196) `deps.system` 接缝整合（#228 / ADR-0010）

> **Lean spec.** 本 spec 锁定实施层决策：D1–D6 全部裁决来自 issue #228（closed 2026-08-07），ADR-0010（commit 850470b + PR #229 draft）。先决决议 ADR-0009（commit bcc12cb on `worktree-wayfinder-121-memory-injection`）随本 spec 落地一并进入 master。本 spec **不含**：向量召回、自动抽取、cache_control 断点（归 #119 Q6a）、TUI/SPA 单独 spec、不动 env.ts / 上游参考（`upstream-openharness/`）。

## Assumptions (confirmed)

> 以下 8 条假设经操作员逐条确认（2026-08-07），构成本 spec 的实施层决策基础。issue #228 §D1–§D6 决议作为先决决议直接引入，不在 list 重开。

1. **A1 集成 PR base = 当前 master HEAD**(非 release tag，沿用 PR #194 模式，落后 master 25 commits 时仍可合入)。
2. **A2 既有 `~/.iknow/state.json`(post-#196 BOOTSTRAP completed)** 与 #121 注入路径兼容，**无需 migration 脚本**。只新增 `~/.iknow/memory/<basename>-<sha1(cwd)[:12]>/` 目录，首次写入由 `memory_save` 工具触发。
3. **A3 8-tool → 10-tool registry 是加法变更**，不停服、不破坏既有 chat session；既有 `~/.iknow/AGENTS.md` / `~/.iknow/user.md` 自动成为装配输入（无破坏性读取）。
4. **A4 `specs/196-identity-assembly.md:122-132` 的"9 段 LOCKED"散文** 在 D6 docs-layer commit 一并改写为"5 段 LOCKED + `memory_layer` 单 slot"，**不另立 spec 同步 PR**。
5. **A5 `README.md` / `docs/STATUS.md` 用户可见文档** 更新推迟到 landing 之后的独立 docs PR（本次仅 `docs/adr/` + `docs/CONTEXT.md` + `specs/228-…md` 内部 spec 同步）。
6. **A6 CI 门槛沿用 master 当前 pre-commit 钩子**：`npm test` + `npm run typecheck`，**不新增 CI gate**（`s4-check` 与 `bash .evals/run.sh --task 016` 由 #194 PR 自带触发，本 landing 复用）。
7. **A7 集成测试用真 FS tmp 目录**（`/tmp/iknow-workspace-test-*`，沿用 `tests/harness/identity/workspace.test.ts:13` 模式），不引 SQLite / 不 mock 文件系统。
8. **A8 PR #194 关闭机制**：`gh pr close 194` 关闭原因填"Superseded by #NNN"（新 landing PR 号）；**分支 `worktree-wayfinder-121-memory-injection` 保留**（开发历史可追溯），worktree 不清。

## Objective

**What**: 把 PR #194（`worktree-wayfinder-121-memory-injection`，12 commits：ADR-0009 + spec + plan + T2–T8 + code-review fix，CI 绿，1456/1456 tests）整合到 master，消除与 #196 身份装配的 `deps.system` 缝双重接线冲突（5 文件），落地为一份新 PR，按 5 层结构（docs / memory 模块 / 工具注册 / 接线 / 测试）逐 commit 推进。

**Why**: #121 设计真值（ADR-0009）已固化 5 周但 master 一直没接；master 的 #196 身份装配（PR #213 merged 2026-08-06）抢先焊 `deps.system` 缝，形成双重接线。`git merge-tree` 报告 5 文件冲突，核心 = `src/harness/build-engine.ts` 两套 system resolver。`#119 Q6`（阈值 + cache_control 断点）的重启前置 = system prompt 形状定型，本 PR 是其解锁步骤。

**Who**:

- 实施者：本 spec 下游 `writing-plans` 消费者 + 实施 agent。
- 操作员：审核每个 layer commit 的方向裁决落地是否与 D1–D6 一致。
- 维护者：未来若调整接缝仲裁（ADR-0010 推翻需要重新走 #228 grilling）。

**Success**: PR merge 后 `npm test` + `npm run typecheck` 全绿，IKNOW_ASSEMBLY_ORDER 形式上从 9 段变 5 段（identity / soul / user_profile / bootstrap / memory_layer），`memory_recall` / `memory_save` 在 `createDefaultAciRegistry` 注册（8+2=10），`ask` 入口剥离 memory 工具 + `memory_layer` slot 不挂，PR #194 关闭带 supersede 指针。

## Glossary（CONTEXT.md 原样引用，不重新定义）

- **deps.system injection seam**: Each-turn 系统文本装配的唯一权威缝——loop-engine 调 `deps.system?.()`（`loop-engine.ts:358`），结果透传 `adapter.step request.system`；`undefined` 时不发送 `system` 字段（`anthropic-adapter.ts:577-580` 条件 spread），KV cache 前缀字节级稳定。
- **memory_layer slot**: #196 9 段流水线 slots 5-9（user AGENTS / `PRIORITY_DECLARATION` / project AGENTS / `EXISTENCE_POINTER` / promote 段）收敛后的单 slot 名，位置仍在 bootstrap 之后；委托 #121 `createSystemResolver`（mtime 缓存 + inflight 去重 + 装配失败不毒化缓存），内部拼接顺序由 ADR-0009 锁定。
- **surface split (identity vs memory)**: 入口面（`chat` / `tui` / `ask` / `serve`）的两层语义——身份认知层（`identity` / `soul` / `user_profile` + 仅 chat / tui / serve 触发的 `bootstrap`）恒在；记忆层（`AGENTS.md` + rules + 记忆库 + `memory_recall` / `memory_save` 工具）只对 chat / tui / serve 装配，`ask` 全 opt-out。
- **ACI tool set**: Harness 装配层（`src/harness/aci/`）注册的工具集；SSOT 工厂 = `src/harness/aci/tools/registry.ts:createDefaultAciRegistry`，所有入口（`build-engine` / `tui/deps`）从这里取，工具数永不同步漂移（#141 / #191 / a277f68）。
- **Loop Engine**: Foundation 的状态机运行内核，位于 `src/harness/`，驱动模型 → 工具 → 真实结果 → 下一轮模型 → 明确停止。
- **append-only messages**: Foundation 的权威 Anthropic 原生会话历史，是唯一事实来源；消息只能以不可变追加更新。
- **in-flight closeout**: abort / timeout 发生时的收尾语义——模型在途则整回合不进历史（finalState = 入口 state）；工具在途则 assistant 回合已原子追加（不可回滚），在途 tool call 填 `execution_failed`。
- **memory-file layered injection**: iknow harness 的三层持久上下文注入——用户级 `~/.iknow/AGENTS.md`、项目级 `<cwd>/AGENTS.md`、自动记忆 `~/.iknow/memory/<basename(cwd)>-<sha1(cwd)[:12]>/`（MEMORY.md 索引 + slug 文件 + frontmatter）；静态层 session-start 一次性加载 + mtime refresh，自动记忆按需 recall、默认不入 system。ADR-0009。
- **affirmative phrasing rule**: 内容纪律硬规则——硬禁止归 `.iknow/permissions.toml` 机械层强制（不进模型上下文）；记忆与指令只写肯定式；负向禁令在写入时拒绝。
- **executor truncation authority（契约 X）**: executor 是工具结果截断元数据的唯一权威；工具返回纯数据、不带 truncated/total 元字段（防 MCP 第三方伪造绕过封顶）。
- **plain-string tool output（契约 Y1）**: 生产工具输出为纯字符串（对齐 OpenHarness wire 形态）；bash 是唯一例外。
- **streaming arm**: LLM 客户端默认流式臂（`IKNOW_LLM_STREAM` 值域 `on` | `off`，默认 `on`），`off` 回退非流式臂；原生 SSE 事件不出 adapter 边界。

## Architectural Constraints（按编号引用 ADR）

- **ADR-0001**: 9router 栈代码默认（不动 env / 模型配置）。
- **ADR-0003**: TraceService 领域接口（memory recall/save 不属于 A 层结构元数据，亦不属 B 层 token usage）。
- **ADR-0004**: 6 工具集 ACI 重写范围声明（实际 live registry 8 工具，web_fetch / web_search 先例增长无需新 ADR；本 spec 8→10 = +memory_recall / +memory_save，harness 自管工具按 web 工具先例入 registry）。
- **ADR-0005**: executor 统一停止信号 + JSON 白名单收紧（memory_recall / memory_save 作为普通 ACI 工具走同一 executor；纯字符串输出天然放行）。
- **ADR-0006**: 工具结果封顶契约 X（`OUTPUT_HARD_CAP=20000`，memory_recall 输出天然走此封顶）。
- **ADR-0008**: token accounting usage placement（TraceService LlmCallRecord 单承载）—— 本 spec 不引入 memory 区独立 token 核算，对齐 ADR-0008 Q6 推迟裁决；压缩路径 blocked by 失败证据。
- **ADR-0009**: 记忆文件分层注入设计真值（commit bcc12cb on branch）—— 本 spec 落地路径。
- **ADR-0010**: #121 实施着陆接缝整合策略（本 spec 是其唯一落地路径，1:1 对应 D1–D6）。
- **#114 Standing preferences**: append-only 纪律不可破、现有 session-store 是基础不推翻（用户级路径复用同根 `~/.iknow/`）、不依赖 token 核算落地（与 #119 无硬耦合）。

## Tech Stack

- TypeScript + Node ≥20；本 spec **无新增 npm 依赖**（`node:crypto` createHash / `node:os` homedir / `node:fs/promises` / `node:path` 均内置）。
- vitest 既有，无新测试依赖。
- 不动 web/、src/session-api/ 装配层（只触 `ensureDeps` 接 SSOT）、src/knowledge-store/、src/kb-*（已归档）、`upstream-openharness/`。

## Commands

```
Build:      npm run build
Typecheck:  npm run typecheck
Test:       npm test                          # vitest：unit + harness + integration
Smoke:      bash .evals/run.sh --task 016     # 沿用 #194 自带 baseline
Landing PR: gh pr create --base master --draft \
              --title "feat(harness): #121 记忆注入 v0 着陆（#228 / ADR-0010 D1-D6）"
Close 194:  gh pr close 194 --comment "Superseded by #<new PR number>"
```

## Project Structure

变更集中在 5 个目录，每个 layer 1 commit：

```
docs/adr/
  0009-memory-file-layered-injection.md       [layer 1 — 从 #194 分支搬运]
  0010-memory-injection-landing-seam-integration.md  [layer 1 — 已落档于 PR #229]

docs/CONTEXT.md
  4 词条新增（deps.system injection seam / memory_layer slot / surface split /
  ACI tool set SSOT 指针修正）                  [layer 1 — 已落档于 PR #229]

specs/196-identity-assembly.md
  line 122-132 "9 段 LOCKED" → "5 段 LOCKED + memory_layer 单 slot"  [layer 1]

src/harness/memory/                           [layer 2 — 整体搬 #194]
  paths.ts / schema.ts / frontmatter.ts / errors.ts / index.ts
  discovery.ts / bm25.ts / promote.ts / assembly.ts / refresh.ts
  tools/recall.ts / tools/save.ts

src/harness/aci/tools/registry.ts             [layer 3 — createDefaultAciRegistry 加 memory_recall + memory_save]
src/harness/aci/tools/                        [layer 3 — 2 个工具定义文件搬 #194]

src/harness/identity/assemble.ts              [layer 4 — slots 5-9 收敛为 memory_layer slot,委托 createSystemResolver + catch 降级]
src/harness/build-engine.ts                   [layer 4 — `BuildEngineOpts.memory.enabled=false` 改 ask 剔除语义]
src/harness/loop-engine.ts                    [layer 4 — merge-tree 冲突文件之一:保 master 的
                                               runModelPhase-resolves-system 缝(loop-engine.ts:358
                                               deps.system?.()),drop #194 分支的 createRaceOutcome
                                               重写;本 layer 不新增 system 逻辑]
src/cli.ts                                    [layer 4 — merge-tree 冲突文件之一:ask 分支传
                                               memory:{enabled:false}(D3);chat/tui/serve 默认 true]
src/cli/runtime.ts                            [layer 4 — ask 路径剥 memory 工具注册]
src/model-adapter/anthropic-adapter.ts        [layer 4 — 无变更（条件 spread 已有）]

# 5 个 merge-tree 冲突文件全数归位:docs/CONTEXT.md(layer 1)+ build-engine.ts
# + cli.ts + cli/runtime.ts + loop-engine.ts(layer 4),与 5-layer commit 一一对应。

tests/harness/memory/                         [layer 5 — 整体搬 #194,12 文件]
  assembly.test.ts / bm25.test.ts / discovery.test.ts / frontmatter.test.ts
  paths.test.ts / promote.test.ts / refresh.test.ts / schema.test.ts
  tools-recall.test.ts / tools-save.test.ts / integration.test.ts
  ← 这些文件以 byte-faithful 整体搬；seam 锚测基线化 (#196) 的不动
tests/harness/build-engine.test.ts            [layer 5 — 以 master 为基增量改写,D1-D4 语义]
tests/harness/integration.test.ts             [layer 5 — ask 路径按 3a 重写]
```

## Code Style

继承项目既有 ES2022 / strict / noUnusedLocals / verbatimModuleSyntax。本 spec 新增代码段只示范 `memory_layer slot` 接线(D2 A2a)的最小形态:

```ts
// src/harness/identity/assemble.ts:resolveSegment() — D2 A2a
case "memory_layer": {
  if (!ctx.memoryEnabled) return undefined;      // ask 全 opt-out (3a)
  try {
    return await ctx.memoryResolver();           // #194 createSystemResolver
  } catch (err) {
    // 对齐 #196 降级契约（assemble.ts:117-131 readUserProfile 模式）：
    // warn + skip + 不毒化下一 turn。#194 的 refresh.ts:76-83 已自含
    // cache-not-poisoned（错误丢弃 tracked/lastMtime，下次调用重新 discovery），
    // 此处兜底是同层语义的二次防御（不让 resolver throw 透传到 loop-engine
    // 把整回合 abort）。
    console.warn(`[identity/assemble] memory_layer resolver failed: ${err}`);
    return undefined;
  }
}
```

`createDefaultAciRegistry` 加 2 工具(D4 4a):

```ts
// src/harness/aci/tools/registry.ts
import { createMemoryRecallTool } from "./memory-recall.js";
import { createMemorySaveTool } from "./memory-save.js";

export function createDefaultAciRegistry(opts) {
  return [
    createBashTool(opts.sandboxRoot),
    createReadFileTool(opts.sandboxRoot),
    createGrepTool(opts.sandboxRoot),
    createGlobTool(opts.sandboxRoot),
    createEditFileTool(opts.sandboxRoot),
    createWriteFileTool(opts.sandboxRoot),
    createWebFetchTool(opts.env),
    createWebSearchTool(opts.env),
    createMemoryRecallTool(opts.memoryDir), // #121 工具入 SSOT
    createMemorySaveTool(opts.memoryDir), // #121 工具入 SSOT
    // ask 入口在 buildHarnessEngine 处用 .filter(t => t.kind !== "memory_*") 剔除
  ];
}
```

`buildHarnessEngine` 的 ask 剔除形态(D3 3a):

```ts
// src/harness/build-engine.ts
const memoryEnabled = opts.memory?.enabled !== false;
const reg = createDefaultAciRegistry({ env, sandboxRoot, memoryDir });
const filteredTools = memoryEnabled ? reg.inner : reg.inner.filter(
  t => t.name !== "memory_recall" && t.name !== "memory_save"
);

const deps: LoopEngineDeps = {
  adapter, executor, registry: filteredTools,
  ...
  system: memoryEnabled
    ? createSystemResolver({ cwd, userHome, memoryDir })
    : undefined,                                  // ask 时整个键缺席
};
```

## Testing Strategy

- **Layer 2**（memory 模块）：整体搬 #194 的 12 个 memory 测试文件，零改动；`tests/harness/memory/` 在 master 上首次出现，但测试本身已验证过（1456/1456 绿于 #194 分支 CI）。
- **Layer 5**（接缝层）：以 master 为基增量改写。
  - `build-engine.test.ts` 新增 D4（10 工具 SSOT）、D3（ask 剥离 memory 工具 + `deps.system` undefined）测试用例
  - **seam 降级契约测试**:`tests/harness/identity/assemble.test.ts` 新增 `memory_layer resolver throws → segment returns undefined, console.warn emitted, no rethrow`(对齐 #196 readUserProfile 降级模式;ACR error-handling-enforcer gate 标的缺口)
  - 移除旧 `buildHarnessEngine — memory opt-out (ask path, SC 12)` 描述符中的"registry 8"措辞，改"registry 10 → ask 剥离为 8"
  - `integration.test.ts` 沿用 mtime refresh / promote 链 / chat-serve 字节一致；ask 路径断言按 3a 重写
- **测试路径**：真 FS tmp（`/tmp/iknow-workspace-test-*`），不引 SQLite、不 mock fs（A7）。
- **覆盖目标**：沿用 #194 + master 既有（line ≥ 80% / branch ≥ 70%）；不在本 spec 提新阈值。
- **不动测试**：不删除任何既有测试（`tests/harness/identity/*` / `tests/harness/build-engine.test.ts` 既有 it() 全部保留）；不降低断言强度；不把失败改成 skip。

## Boundaries

- **Always do**:
  - 每个 layer commit 后跑 `npm test` + `npm run typecheck`(沿用 pre-commit husky 钩子)
  - 5 文件冲突内容从 `git merge-tree origin/master origin/worktree-wayfinder-121-memory-injection` 输出取；不读 #194 的 build-engine.ts 全文以外部分
  - `memory_recall` / `memory_save` 在 `createDefaultAciRegistry` 注册,严格走 #141 / #191 / a277f68 立场
  - `ASK` 路径剥离 memory 工具后,`ask "你是谁"` 应答路径完整(走 identity 4 段)
- **Ask first**:
  - 任何 #194 分支文件未在本 spec "Project Structure" 列出的改动(如动 `src/cli/chat-session.ts` 装配逻辑)
  - 改 pre-commit husky 钩子配置
  - 关闭 PR #194(确认 supersede PR 已开 + 全部 commit landed)
- **Never do**:
  - 直接修改 master 的 `docs/CONTEXT.md` 或 `docs/adr/`(domain-modeling 写入主权);本 spec 仅 PR #229(已落档)覆盖
  - 修改 `src/harness/identity/assemble.ts` 的 `IKNOW_ASSEMBLY_ORDER` 顺序(灵魂 LOCKED)
  - 改 `anthropic-adapter.ts` `buildMessageParams` 形态(条件 spread 已有,无需调整)
  - 推 `worktree-wayfinder-121-memory-injection` 分支(实施分支独立开)
  - commit 凭证 / `.env.local` / `secrets.*` 进 git

## Success Criteria

binary,yes/no 全部应可在 PR merge 后 1 次 typecheck + 1 次 test 全跑验证:

- **SC1** `npm run typecheck` exit 0
- **SC2** `npm test` 全绿(line + branch 阈值沿用 master 既有 80% / 70%)
- **SC3** `bash .evals/run.sh --task 016` 1/1 passed(沿用 #194 baseline)
- **SC4** `git grep "createDefaultAciRegistry" src/` 命中 ≥ 3 处(`registry.ts` 定义 + `build-engine.ts` 调用 + `tui/deps.ts` 调用)
- **SC5** `git grep "memory_layer" src/harness/identity/assemble.ts` 命中 ≥ 1 处(D2 单 slot 收敛落地)
- **SC6** `git grep "memory_recall\|memory_save" src/harness/aci/tools/registry.ts` 命中 ≥ 2 行(D4 SSOT 入场)
- **SC7** `IKNOW_ASSEMBLY_ORDER` 数组长度 ≤ 5(`identity` / `soul` / `user_profile` / `bootstrap` / `memory_layer`)
- **SC8** `git grep "PRIORITY_DECLARATION\|EXISTENCE_POINTER" src/harness/identity/assemble.ts` 命中 ≥ 2 处(字符串 LOCKED 字符级不变;顺序在 `memory_layer` slot 内)
- **SC9** `src/harness/build-engine.ts` 中 `BuildEngineOpts.memory?.enabled` 分支保留 + `memoryEnabled ? ... : undefined` 双分支完整
- **SC10** PR #194 状态 = CLOSED,关闭原因含"Superseded by #NNN"(NNN = 新 landing PR 号)
- **SC11** 新 landing PR 已 merged 进 master
- **SC12** docs/adr/ 最大号 ≥ 0010(ADR-0010 已随 #229 入 master)
- **SC13** `docs/CONTEXT.md` 含新词条 `memory_layer slot` / `deps.system injection seam` / `surface split`
- **SC14** `specs/196-identity-assembly.md` 第 122-132 行的"9 段 LOCKED"散文描述已改写
- **SC15** `src/cli.ts` 包含 ask 分支显式传 `memory:{enabled:false}`(D3);`src/harness/loop-engine.ts` 第 358 行 `deps.system?.()` 调形态保留(master 既有,无新增 system 逻辑)
- **SC16** `tests/harness/identity/assemble.test.ts` 含 `memory_layer resolver throws → undefined + warn` 用例(D2 降级契约落地;ACR gate 标的缺口)
- **SC17** 5 个 `git merge-tree` 冲突文件(`docs/CONTEXT.md` / `src/cli.ts` / `src/cli/runtime.ts` / `src/harness/build-engine.ts` / `src/harness/loop-engine.ts`)全部在 5-layer commit 计划内归位

## Open Questions

无。本 spec 全部前置已 grounding（ADR-0009 + ADR-0010 + 8 条 confirmed assumptions + 6 个 D1-D6 HITL 裁决）。任何未决议应在 D6 实施期 surface 到 #228 评论区，不在本 spec 内重开。

---

## ACR Verdict Block (Step 4)

由 `architecture-change-reviewer` 跑（命令：`arthurpower:architecture-change-reviewer-agent --spec specs/228-memory-injection-landing.md`）：

### Round 1（2026-08-07，BLOCKED，2/5 NO）

| Verdict                      | Result  | Reason                                                                                                                                                                                                                                                             |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| bounded-context-guardian     | **yes** | `src/harness/memory/` 是清洁 bounded context:import 图 = node 内置 + 兄弟模块 + `aci/types`(types-only leaf);无回环;build-engine → memory / identity/assemble → memory/refresh 单向接线                                                                            |
| defensive-contract-validator | **yes** | 12 个 memory 测试文件齐全;5 boundary classes(empty / negative / overflow / concurrent / exception)在 tools-recall / refresh / promote 全部覆盖;seam 层以 master 为基改写                                                                                           |
| error-handling-enforcer      | **no**  | `createSystemResolver` throw(refresh.ts:76-83 + refresh.test.ts:123)未被 `memory_layer` slot 接线捕获,与 #196 warn+skip 降级契约矛盾;无 seam 测试覆盖 throw 路径                                                                                                   |
| complexity-anti-drift        | **yes** | D2 收敛后 `resolveSegment` 平 switch(9 → 5 cases),nesting ≤2;最大文件 tools/save.ts:268 + promote.ts:213 均 ≤300 行;helper ≤20 行,无函数超 cyclomatic 10 / nesting 4 / 30 行阈值                                                                                   |
| minimal-change-verifier      | **no**  | 5-layer commit 计划 Project Structure 只列 3 个 merge-tree 冲突文件(`docs/CONTEXT.md` + `build-engine.ts` + `cli/runtime.ts`),漏 `cli.ts`(D3 ask `memory:{enabled:false}`)+ `loop-engine.ts`(master `runModelPhase-resolves-system` 缝保留);5 冲突 vs 5 layer 不齐 |

**Blocking fixes applied**:

- `memory_layer` slot 接线加 try/catch + console.warn + 返回 undefined(对齐 `assemble.ts:117-131 readUserProfile` 降级模式;`#194 refresh.ts:76-83` 自含 cache-not-poisoned 二次防御)
- Project Structure layer 4 补 `src/cli.ts` + `src/harness/loop-engine.ts` 接线说明(覆盖 5/5 冲突文件)
- Success Criteria 加 SC15(`cli.ts` ask 传 `memory:{enabled:false}` + `loop-engine.ts` `deps.system?.()` 形态保留)、SC16(seam 降级契约测试落地)、SC17(5 冲突文件全数归位)
- Testing Strategy 加 seam 降级契约测试项(`tests/harness/identity/assemble.test.ts` 新增 `memory_layer resolver throws → undefined + warn` 用例)

### Round 2 (2026-08-07，PASS，5/5 yes)

| Verdict                      | Result  | Reason                                                                                                                                                                 |
| ---------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bounded-context-guardian     | **yes** | layer 4 now enumerates `src/cli.ts` + `src/harness/loop-engine.ts`;reconciliation note confirms 5/5 冲突文件归位;memory module import 图仍清洁(per Round 1)            |
| defensive-contract-validator | **yes** | 12 memory 测试 + seam 降级测试覆盖 exception boundary class;SC2 + SC16 gate                                                                                            |
| error-handling-enforcer      | **yes** | Code Style 加 try/catch + console.warn + return undefined 对齐 `assemble.ts:117-131 readUserProfile` 降级;seam 测试强制;SC16 gate。Round 1 的 unguarded throw 矛盾消除 |
| complexity-anti-drift        | **yes** | try/catch 仅 6 行嵌入 `case` block,nesting ≤3;`resolveSegment` ≤30 行;layer 4 文件 ≤300 行;无新超阈值函数                                                              |
| minimal-change-verifier      | **yes** | layer 4 列全 5 个 merge-tree 冲突文件;SC15 + SC17 gate;1 logical task = 5 commit units                                                                                 |

**OVERALL: PASS** → handoff writing-plans(`plans/228-memory-injection-landing.md`)

---

## Handoff to writing-plans (Step 5)

Spec 路径：`specs/228-memory-injection-landing.md`
下游：`arthurpower:writing-plans plans/228-memory-injection-landing.md`
实施分支：`worktree-wayfinder-228-domain-modeling-landing`（独立 worktree，base = master HEAD）
5 commit 单元 = docs layer / memory 模块层 / 工具注册层 / 接线层 / 测试层（一一映射 D6 5 层移植结构）。
