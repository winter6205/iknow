# Spec: iknow 身份认知装配（identity 认知 + soul 人格 + 启动引导 + 用户画像）

> **Lean spec.** 本 spec 锁定实施层决策：身份层独立成段（`assembleIdentityContext` 注入缝）、认知/人格分层、装配顺序、文件归位、状态机、入口覆盖、测试 / Boundaries / Success Criteria。已在 spec 阶段由操作员逐条确认的 5 个决策点（issue #196 决策点 §1-§5）作为先决决议直接引用，不在本 spec 体内重开。

> ## ✅ Rev 2026-08-11 决策修订（已落地，12-bullet tracker `docs/plans/196-identity-bootstrap-align.md` 全部完成）
>
> **本次修订记录 7 项对齐 openharness 的决策，均已实施**（D1 决策 + T1-T10 落地，T11 本 spec 收口，T12 E2E）：
>
> 1. bootstrap 完成机制从 **flag 驱动** 改为 **文件驱动**（agent 自己 `rm BOOTSTRAP.md` 隐式完成，对齐 ohmo）✅
> 2. `bootstrap.ts` 不再导出 `IKNOW_BOOTSTRAP_PROMPT`，改成导出 `BOOTSTRAP_TEMPLATE`（文件内容）✅
> 3. `initializeIknowWorkspace` 在 `bootstrap_seeded=false` 时 seed `~/.iknow/BOOTSTRAP.md` 并翻旗 ✅
> 4. 装配层 `readBootstrapIfNeeded` 不再读 `bootstrap_seeded`，改读文件存在 ✅
> 5. 删 `/profile done` 斜杠命令（chat-session / hub / app.tsx 三入口）✅
> 6. 删 `appendIknowUserSections` / `BOOTSTRAP_COMPLETE_SECTIONS` ✅
> 7. ACI 写工具**保持 cwd-scoped**（不放行 `~/.iknow/` 写），agent 写 user.md / 删 BOOTSTRAP.md 走 bash（操作员裁决；`resolveWithinRoot` `extraWriteRoots` 基础设施保留待未来启用）✅
>
> **supersede 关系**——以下旧段是旧产品决策（2026-08-06 的"应急设计"，基于错误沙箱前提）的产物，新决策 supersede 旧段；本文保留旧段文字以备溯源，但实施以本 Rev 块 + §"Bootstrap 机制（rev 2026-08-11）"+ §"ACI 写工具 extraWriteRoots 对称（rev 2026-08-11）" 为准：
>
> - §A12「激活 BOOTSTRAP 按 bootstrapActive 开关」→ superseded by 决策 1/4（装配层看 BOOTSTRAP.md 文件存在与否，不看 flag、不看 surface）
> - §Project Structure `bootstrap.ts` 注释「导出 IKNOW_BOOTSTRAP_PROMPT（首启对话脚本）」→ superseded by 决策 2（导出 BOOTSTRAP_TEMPLATE 文件内容）
> - §Code Style「bootstrap 是首启唯一一次注入（bootstrap_seeded=false 时挂上）」→ superseded by 决策 1/4（注入 = 文件存在）
> - §Style「state.json 写入只发生在 BOOTSTRAP 完成钩子」→ superseded by 决策 3（state.json 写入只发生在 seed BOOTSTRAP.md 后翻 flag）
> - §Testing「`bootstrap.test.ts` BOOTSTRAP 首启触发 + state.json 写入」→ 改测 BOOTSTRAP.md 文件存在/不存在 → 装配注入/不注入
> - §Success Criteria 第 2/6 条「首启时 agent 走 BOOTSTRAP 脚本引导用户填 user.md / 二次启动跳过 BOOTSTRAP 段」→ 改测 BOOTSTRAP.md 存在/缺失语义
> - §Success Criteria「`npm test ... bootstrap.test.ts`」→ 改测 `bootstrap-file.test.ts`
> - §ADR Reference 「bootstrap.ts 移到代码（非工作区）」→ 与决策 2 不冲突（仍是代码常量），但表述改为「BOOTSTRAP_TEMPLATE 在代码；BOOTSTRAP.md seed 后在工作区」
>
> **本 Rev 块不动既有段落**，全文翻新留待后续 12-bullet tracker 收口时合并。本次 spec 修订按"1 commit = 1 logical task"约定只做"决策记录 + 全文 supersede 标记"，不重写其它段落。
>
> 决策依据（决策 4/5/6）：commit 14cd709 "修复首启引导死胡同"基于"ACI 沙箱把 home 三路封死 + bash 复合命令被 hard-wall 拦"为前提——实测证伪：`bwrap.ts:49-72` 把整个 home `--bind` 进沙箱（bash 可自由读写）、`hard-walls.ts:230` 明示 non-allowlisted 走 ask tier 而非 hard-wall deny、`SENSITIVE_PATH_FRAGMENTS`（`fs-policy.ts:5-12`）不含 `.iknow`。
>
> 决策依据（决策 7）：`src/harness/aci/tools/read-file.ts:36` 已有 `extraReadRoots: [~/.iknow]`；写工具无对应 `extraWriteRoots` 是配置缺失，不是沙箱要求。

## Assumptions (confirmed)

> 以下 14 条假设经操作员逐条确认（2026-08-06），构成本 spec 的实施层决策基础。issue #196 §1-§5 决议作为先决决议直接引入，不在 list 重开。

1. **A1 spec 路径**：`specs/196-identity-assembly.md`（对齐本仓 spec 命名惯例：`<issue-number>-descriptive-slug.md`）。
2. **A2 spec 形态**：lean spec。先决决议来自 issue #196 决策点 §1-§5（注入位置 / 触发面 / 与 #121 关系 / 文件归位 / 认知 vs 人格边界），spec 只补实施层细节与决策点未钉死的派生约束。
3. **A3 spec 不替代 #121 / 014 / 015 / 016 / 017 已落契约**：#121 装配顺序为 `user AGENTS+rules → PRIORITY_DECLARATION → project AGENTS+rules → EXISTENCE_POINTER → promote`（锁定）。本 spec 在第 1/2 步（identity / soul 层）插入新段，第 3-9 步沿用 #121 既有契约，不重排。
4. **A4 术语 SSOT = `docs/CONTEXT.md`**：loop-engine / append-only messages / LoopTrace / StopReason / in-flight closeout / ToolExecutionContext / agent 真值层 / HarnessStreamEvent / turnCount / caller_role / `deps.system` 注入缝。spec 不重定义，只在 Architectural Constraints 段引用。
5. **A5 架构 SSOT = `docs/architecture.md` Capability modules 表**（Harness 行 + Session API 行 + CLI 行）。spec 仅引用，不重画架构。
6. **A6 tech stack 零新增依赖**：继承 016 / 017 / 020 / 022 spec Tech Stack（TypeScript ES2022 / ESM / Node ≥20 / vitest）。本 spec 不引入任何新 runtime / dev 依赖。
7. **A7 测试框架沿用 vitest**。不引入 jsdom / fs-mock 增强。
8. **A8 数据路径**：`~/.iknow/` 已是 `permissions.toml`（#172）+ `sessions/`（#120）+ `memory/`（#121）根目录。本 spec 复用同根，新增 `user.md`（用户画像）+ `state.json`（bootstrap 状态机）。不入 git、不进 commit；跨机器路径在实施期 `homedir()` 解析。
9. **A9 既有 8 工具集（ACI 0004 / 141-T11 + Web 扩展）路径不动**：本 spec 不注册新工具、不动工具目录、不动 `createAciRegistry` 拓扑。identity 注入 = `deps.system` 缝的 hook，不新增工具。
10. **A10 reference 关系**：`upstream-openharness/ohmo/{workspace,prompts}.py` 是行为真值（issue #196 决策点 §1）。本 spec 引用其 4 文件模式 + 装配顺序 + 状态机结构，但**不用 import / 不依赖 `upstream-openharness` runtime**（按 CLAUDE.md / `docs/CONTEXT.md` 规则）。
11. **A11 架构改造范围**：`master` 分支当前 `buildHarnessEngine` 产物 `LoopEngineDeps` **没有** `system` 字段（identity 注入缝在 #121 worktree 分支已存在但未合入 master）。本 spec 确认改造范围 = **把 `deps.system` 缝从 #121 worktree 提升到 master baseline**（不是只在 #121 分支上挂，是 harness 本身补齐）。触发 / 装配 / 测试逻辑直接走基线缝。
12. **A12 入口覆盖**：4 入口走 `buildHarnessEngine`（chat / serve / tui / ask），都注入身份；对话型入口（chat / tui / serve）激活 BOOTSTRAP；仅脚本型（ask）跳过 BOOTSTRAP 段（按 `bootstrapActive` 开关）。serve 是同一主体的浏览器交互面（iknow serve + SPA），与 chat / tui 共享同一 `~/.iknow/state.json` 状态机，不再单独降级（用户 2026-08-08 裁定）。`trace` 入口走 `src/traceserver/`，不调 `buildHarnessEngine`，与本 spec 无关。
13. **A13 认知 vs 人格边界**：identity（认知层 / 本体性事实）只放 Name / Kind / Signature；soul（人格层 / 行为风格）放 core truths / boundaries / **vibe** / continuity。判断标准 "删掉后 agent 是不是 iknow"：identity 删了 = 认知崩塌；soul 删了 = 还是 iknow 但行为不可预测。**Vibe 归 soul**（行为风格）。
14. **A14 Open Questions 默认空**：所有 5 个决策点已收敛；任何 unresolved 项必须先 grill 再写 spec，不允许"先写 plan 后盘"。

## Objective

**What**: 在 harness 的 `deps.system` 注入缝上挂一个**身份认知装配层**——为 iknow agent 装上"我是 iknow"的自指认知（identity / soul 段），并通过 user.md + BOOTSTRAP 完成"用户画像 + 首启引导"两个动作。装配沿 `deps.system` 同一缝按 5 段顺序注入；不分缝。

**Why**: issue #196 当前问题——`AGENTS.md` 里写"我是 iknow"是**指示性**的（prompt 层），模型不一定遵守（Claude 训练身份倾向强）。需要在 #121 既有 7 段装配之前插入**结构性强制**的认知/人格段（identity + soul 代码锁死），让"我是 iknow"从"提示词"上升到"运行时结构事实"。同时引入 user.md 完成用户画像交互，BOOTSTRAP 完成首次引导，state.json 追踪引导完成状态。

**Who**:

- 实施者：本 spec 的下游 `writing-plans` 消费者 + 实施 agent。
- 用户：CLI / Web / TUI 用户，期望 agent 能"认得自己是 iknow"、能基于用户画像（user.md）个性化、能首次启动时完成引导并记住。
- 维护者：后续若需调整身份 / 人格 / 引导内容，**改代码不动用户**（除非调 user.md 模板）。

**Success**: 4 入口（chat / serve / tui / ask）真实跑通时 agent 自报"我是 iknow"；首启时 agent 走 BOOTSTRAP 脚本引导用户填 user.md；第二次启动不再注入 BOOTSTRAP 段；user.md 改动在 turn 级别生效（`deps.system` 每 turn 解析）；state.json 持久化；`npm run typecheck` + `npm test` 全过；`deps.system` 缝从 #121 worktree 提升到 master baseline 闭环。

## Tech Stack

继承 016 / 017 / 020 / 022 spec Tech Stack，零新增依赖：

- **Language**: TypeScript（ES2022 / NodeNext / strict / noUnusedLocals / verbatimModuleSyntax / isolatedModules）。
- **Module**: ESM（`"type": "module"`）；TS 源码内部相对导入用 `.js` 后缀。
- **Runtime**: Node ≥20。`node:fs/promises` / `node:os` / `AbortController` 均为 Node 内建，不引入 polyfill。
- **Test runner**: vitest（022 沿用）。
- **Filesystem**: `fs.promises.readFile / writeFile / mkdir / stat / unlink`，`homedir()`（来自 `node:os`）解析 `~/.iknow/`。

> Tech stack 变更需新假设门（spec-driven-development Iron Law）。本 spec 不新增任何 runtime / dev 依赖。

## Commands

```bash
# Type check（项目根）
npm run typecheck

# Full test suite（vitest，含 #121 回归 + 新 identity 装配测试）
npm test

# 手动冒烟（实施期，对齐 i9 / i10 / i11 命名惯例）
npx tsx scripts/i12-identity-assembly-smoke.ts
```

> 实施期新增 `scripts/i12-identity-assembly-smoke.ts`，对齐 i9 / i10 / i11 命名惯例（`scripts/i<N>-<feature>-smoke.ts`）。覆盖 6 条断言：identity 段注入 / soul 段注入 / user.md 存在性 / BOOTSTRAP 首启触发 / state.json 写入 / 二次启动跳过 BOOTSTRAP。

## Project Structure

继承 020 / 022 已有结构 + #121 worktree 身份缝接入，零新根目录。具体改动文件清单留给 implementation，但 spec 必须给出**模块级责任**：

```
src/
├── harness/                                  # 【改】Foundation 补齐 deps.system 缝
│   ├── loop-engine.ts                        #   沿用 #121 raceModel call site（每 turn 调 deps.system?.()）
│   ├── build-engine.ts                       #   【改】buildHarnessEngine 装入 identity 缝 + 触发 initializeIknowWorkspace
│   ├── model-adapter/                        #   【不动】types.ts / anthropic-adapter.ts 透传 request.system
│   ├── memory/                               #   【改】assembleSystemPrompt(ctx) 沿用 #121 T4契约
│   │   ├── assembly.ts                       #   #121 T4 既有；本 spec 1+N 层待其前置插入（见 ACR 注）
│   │   ├── discovery.ts                      #   【不动】#121 既有
│   │   ├── promote.ts                        #   【不动】#121 既有
│   │   └── schema.ts                         #   【不动】#121 既有
│   └── identity/                             # 【新增】本 spec 核心模块
│       ├── identity.ts                       #   导出 IKNOW_IDENTITY_DEFAULT（认知：Name/Kind/Signature）
│       ├── soul.ts                           #   导出 IKNOW_SOUL_DEFAULT（人格：core truths/boundaries/vibe/continuity）
│       ├── bootstrap.ts                      #   【rev 2026-08-11】导出 BOOTSTRAP_TEMPLATE（BOOTSTRAP.md 文件模板，非对话脚本）
│       ├── user-template.ts                  #   导出 USER_TEMPLATE（seed user.md 模板）
│       ├── index.ts                          #   导出 assembleIdentityContext(ctx) + IKNOW_WORKSPACE_ROOT 常量
│       └── workspace.ts                      #   【新增】initializeIknowWorkspace(opts) — eager + idempotent seed
│                                                 + read/write state.json + bootstrap_seeded 状态机
│                                                 + bootstrapFilePath(workspace)
│                                                 + 【rev 2026-08-11】bs=false 时 seed ~/.iknow/BOOTSTRAP.md + 翻旗
├── cli/                                      # 【改】runtime.ts 注入 init 触发
│   ├── runtime.ts                            #   buildHarnessEngine 调 initializeIknowWorkspace per init
│   └── {chat-session,slash,format,ask-user,parse-args}.ts # 【不动】020 / 022 既有
├── session-api/                              # 【改】serve.ts 入口加 init 调用
│   └── serve.ts                              #   进程启动时 initializeIknowWorkspace
└── tui/                                      # 【改】tui 入口加 init 调用
    └── tui.ts                                #   进程启动时 initializeIknowWorkspace

tests/
├── harness/identity/                         # 【新增】identity 装配单元测试
│   ├── identity.test.ts                      #   identity / soul 段拼装 + identity vs soul 边界
│   ├── bootstrap-file.test.ts                #   【rev 2026-08-11】BOOTSTRAP_TEMPLATE 文件模板 + bootstrapFilePath
│   ├── bootstrap.test.ts                     #   BOOTSTRAP 状态机（seed 即翻旗）+ 文件驱动
│   ├── workspace.test.ts                     #   initializeIknowWorkspace 幂等 + seed 行为
│   └── system-injection.test.ts              #   buildHarnessEngine 装入 deps.system + 4 入口覆盖（mock）
└── harness/memory/assembly.test.ts           # 【改】回归 #121 既有 7 段；新增 1+N 段装配总测

scripts/
└── i12-identity-assembly-smoke.ts            # 【新增】实施期手动冒烟

docs/
├── handoff/<date>-identity-assembly/         # 【新增】实施完成截图证据（按 022 惯例）
└── CHANGELOG.md                              # 【改】加 ### Feature 条目
```

> 文件名 / 子模块拆分 / 内部函数排序留给 implementation；模块级责任（identity.ts = 认知层 / soul.ts = 人格层）不可变；ACR bounded-context-guardian 闸门。

## Code Style

### 装配顺序约束（Spec 锁死，实施层不得重排）

```ts
// src/harness/identity/index.ts — assembleIdentityContext(ctx) 约束（实施期微调实现，顺序不可变）

/** IKNOW-196 装配顺序（5 段，#228 收敛后）。 */
export const IKNOW_ASSEMBLY_ORDER = [
  "identity", // 1. 认知层（代码 LOCKED）：Name/Kind/Signature
  "soul", // 2. 人格层（代码 LOCKED）：core truths/boundaries/vibe/continuity
  "user_profile", // 3. 用户画像（~/.iknow/user.md）— 用户可改
  "bootstrap", // 4. 首启引导（仅当 bootstrap_seeded=false 注入）
  "memory_layer", // 5. 记忆层单 slot（#121/#228 收敛：委托 createSystemResolver）
] as const;
```

**关键不变量**：

- `identity` / `soul` 是**绝对权威**（代码锁死，最高优先级，所有用户统一）
- `user_profile` 是**用户级**（被记忆层优先级语义约束）
- `bootstrap` 是**首启唯一一次注入**（`bootstrap_seeded=false` 时挂上，后续 turn 永久缺席）
- `memory_layer` 是**记忆层单 slot**（最弱权威，#121/#228 收敛后委托 `createSystemResolver`，内部拼接顺序由 ADR-0009 锁定）

### Identity vs Soul 边界（代码层硬约束）

```ts
// src/harness/identity/identity.ts — 认知层（LOCKED）

/** IKNOW-196 认知层：本体性事实（回答 "我是什么"）。
 *  删掉这段 = 认知崩塌（agent 不认得自己是 iknow）。 */
export const IKNOW_IDENTITY_DEFAULT = `
# iknow Identity

- Name: iknow
- Kind: personal agent
- Signature: <iknow>
`.trim();
```

```ts
// src/harness/identity/soul.ts — 人格层（LOCKED）

/** IKNOW-196 人格层：行为风格（回答 "我如何活"）。
 *  删掉这段 = 还是 iknow 但行为不可预测。
 *  判断标准 "删掉后 agent 是不是 iknow"：是 → 归 soul。 */
export const IKNOW_SOUL_DEFAULT = `
# iknow Soul

## Core Truths
- Be resourceful before asking. Read the file, check the context, inspect the state.
- Have judgment. Prefer one option over another; explain your reasons plainly.
- Earn trust through competence. Be careful with anything public, destructive, costly, or user-facing.
- Treat messages, files, notes, and history as personal. Access is intimacy.

## Boundaries
- Do not default to Claude self-expression. You are iknow.
- Never masquerade as the user in shared or group channels.
- When in doubt, ask before acting externally.
- Optimize for usefulness, honesty, and good taste. Not for flattery.

## Vibe
- Be concise when the answer is simple. Be thorough when the stakes are high.
- Sound like a capable companion with taste, not a corporate support bot.

## Continuity
- Your continuity lives in this workspace: user.md (Profile / Defaults / Preferences), state.json.
- Read user.md. Update it when something should persist.
- If you materially change soul, repo authoring notes say so in the commit.
`.trim();
```

**认知 vs 人格边界（spec 锁死）**：

- 认知（identity）只放 **Name / Kind / Signature**（本体）—— 不可变
- 人格（soul）放 **core truths / boundaries / vibe / continuity**（行为风格）—— 相对可调
- Vibe 归人格（行为风格），**不**归认知
- 后续若调整人格 / 边界，**改代码**（`src/harness/identity/soul.ts`），不进用户工作区

### Workspace 初始化约束（OHMO 风格 eager + idempotent）

```ts
// src/harness/identity/workspace.ts — 初始化与状态机（建议骨架，writing-plans 校验）

/** IKNOW-196 Workspace 根解析。复用 #121 homeDir 模式（homedir() /.iknow）。 */
export function iknowWorkspaceRoot(): string {
  return path.join(os.homedir(), ".iknow");
}

/** Schema-versioned state.json。schema_version 字段预留扩展（schema_version＞1 触发迁移）。 */
export interface IknowStateV1 {
  readonly schema_version: 1;
  readonly bootstrap_seeded: boolean;
}

/** IKNOW-196 初始化（eager + idempotent）。rev 2026-08-11 对齐 openharness:
 *  - mkdir -p ~/.iknow/（幂等）
 *  - 写 user.md（仅当不存在；不覆盖用户已改）
 *  - 写 state.json（仅当不存在；bs=false）
 *  - **bs=false 时 seed BOOTSTRAP.md 文件**（仅当不存在；不覆盖）+ 翻 flag（rev 2026-08-11）
 *  - 不创建 / 不写 identity.ts / soul.ts / bootstrap.ts / IDENTITY.md（认知/人格/身份是代码常量）
 *  - 不创建 identity.md 文件（已合并到 soul，不单独存在）
 */
export async function initializeIknowWorkspace(opts?: {
  workspace?: string;
}): Promise<{ root: string; state: IknowStateV1 }>;

/** 读取 state.json；不存在则返默认值（schema_version:1 / bootstrap_seeded:false）。 */
export async function readIknowState(workspace?: string): Promise<IknowStateV1>;

/** 写入 state.json（PATCH 单字段）。rev 2026-08-11：删去 created_at/updated_at
 *  字段（state.json 自愈时已用 random 备份，简化 schema；同 commit 5eeb835
 *  先例）。bs 翻旗后**只**用于审计/调试，**装配路径不再读它**。 */
export async function writeIknowState(
  patch: Partial<Omit<IknowStateV1, "schema_version">>,
  workspace?: string
): Promise<IknowStateV1>;

/** rev 2026-08-11 新增：BOOTSTRAP.md 文件路径解析（与 ohmo `get_bootstrap_path` 对齐）。
 *  seed 后只读、不写。完成 = 文件被删，**无需宿主钩子**。 */
export function bootstrapFilePath(workspace: string): string;
```

### Bootstrap 机制（rev 2026-08-11 对齐 openharness 隐式完成）

**问题溯源**：`bootstrap_seeded` flag 在 iknow 现状下被装配层每次会话读取（`readBootstrapIfNeeded` 读 state.json 决定是否注入 `IKNOW_BOOTSTRAP_PROMPT`）。openharness 同名 flag 只在 `initialize_workspace()` 内被读一次（决定是否 seed BOOTSTRAP.md 文件），runtime / prompts **从不读它**——行为由文件存在与否驱动，agent 自己 `rm BOOTSTRAP.md` 隐式完成。

**对齐决策**：

1. **完成机制从 flag 驱动改为文件驱动**：`bootstrap_seeded` 仅用于 `initializeIknowWorkspace` 一次性 seed 决策；装配层从读 flag 改为读 `BOOTSTRAP.md` 是否存在。
2. **bootstrap 段从代码常量改为种子文件**：`bootstrap.ts` 不再导出 `IKNOW_BOOTSTRAP_PROMPT`（对话脚本），改成导出 `BOOTSTRAP_TEMPLATE`（文件内容），内容结尾对齐 ohmo 风格"This file can be deleted when done. If gone later, do not assume it should come back."。
3. **`initializeIknowWorkspace` seed BOOTSTRAP.md**：`bootstrap_seeded=false` 且文件不存在时，把 `BOOTSTRAP_TEMPLATE` 原子写入 `~/.iknow/BOOTSTRAP.md`，随后翻 flag。幂等。
4. **删除 `/profile done` 钩子**（chat-session / app.tsx / hub）：bootstrap 完成不再靠宿主斜杠命令；agent 引导对话结束后 `rm BOOTSTRAP.md` 即可（bash 在 bwrap sandbox 内有 home `--bind`，可写）。
5. **删除 `appendIknowUserSections` / `BOOTSTRAP_COMPLETE_SECTIONS`**（commit d1beae5 已回撤）：基于"bash 复合命令被 hard-wall 拦"错误前提做的过度设计。实测 `bwrap.ts:49-72` 把整个 home `--bind` 进沙箱，`hard-walls.ts:230` 明示 non-allowlisted 命令走 ask tier 而非 hard-wall，`SENSITIVE_PATH_FRAGMENTS` 不含 `.iknow`，bash 可自由读写。
6. **保留** `~/.iknow/` 路径决策（跨项目用户画像，不污染仓库）—— **不**对齐 openharness 把 workspace 放 cwd 的做法。openharness = 项目级 workspace；iknow = 用户级 workspace。这是产品决策，不是设计失误。

### ACI 写工具 extraWriteRoots 对称（rev 2026-08-11）

`read_file` 已有 `extraReadRoots: [~/.iknow]`（`src/harness/aci/tools/read-file.ts:36`）。`write_file` / `edit_file` 当前走 `resolveWithinRoot(root, params.path)` 不带 extra roots——agent 在引导对话里**能读不能写** `~/.iknow/`。

**决策（rev 2026-08-11 — 已定：bash 路径）**：agent 写 `~/.iknow/user.md` / 删 `BOOTSTRAP.md` 走 **bash**。`write_file` / `edit_file` **保持 cwd-scoped**（不放行 `~/.iknow/` 写）。这是操作员裁决：写工具不放行 profile 目录，agent 用 bash（bwrap 把整个 home `--bind` 进沙箱，bash 可自由读写）完成引导写入。

**依据**：

- bwrap 把整个 home `--bind` 进沙箱（`bwrap.ts:49-72` `bindArgs`），bash 沙箱内可自由读写 `~/.iknow/`
- `hard-walls.ts:230` 明示 non-allowlisted 命令走 ask tier 而非 hard-wall deny；`SENSITIVE_PATH_FRAGMENTS`（`fs-policy.ts:5-12`）不含 `.iknow`，路径不撞硬墙
- 写工具保持 cwd-scoped 是既有安全边界（read-only 放行 profile 读；写不放行——避免 agent 意外覆写用户画像）

**落地**：T1 已把 BOOTSTRAP_TEMPLATE 文案改为"用 bash 写/删文件"。`resolveWithinRoot` 的 `extraWriteRoots` 第 4 参（T7）作为基础设施保留待未来启用，本 plan 不使用它。

### 注入缝（依赖 #121 aim，但**提升到 master baseline**）

```ts
// src/harness/identity/index.ts — 注入缝（约束）

/** IKNOW-196 装配流水线入口。buildHarnessEngine 在 deps.system 注册此函数（每 turn 调）。
 *  返回 string → 透传 adapter.step request.system；undefined → 跳过注入（行为零变化）。
 *  0 规格：5 段顺序 + 各段存在性条件 + 错误降级。 */
export async function assembleIdentityContext(ctx: {
  cwd: string;
  userHome: string;
  bootstrapActive: boolean;
}): Promise<string | undefined>;

/** IKNOW-196 入口范围判定。对话型入口（chat / tui / serve）激活 BOOTSTRAP；仅 ask 跳过。 */
export function shouldIncludeBootstrap(
  surface: "chat" | "tui" | "ask" | "serve"
): boolean;
```

**入口覆盖矩阵**（spec 锁死）：

| 入口    | 注入 identity              | 注入 soul | 注入 user.md | 注入 BOOTSTRAP | 注入 user AGENTS | 注入 project AGENTS |
| ------- | -------------------------- | --------- | ------------ | -------------- | ---------------- | ------------------- |
| `chat`  | ✅                         | ✅        | ✅           | ✅（首启）     | ✅               | ✅                  |
| `tui`   | ✅                         | ✅        | ✅           | ✅（首启）     | ✅               | ✅                  |
| `ask`   | ✅                         | ✅        | ✅           | ❌ 跳过        | ✅               | ✅                  |
| `serve` | ✅                         | ✅        | ✅           | ✅（首启）     | ✅               | ✅                  |
| `trace` | ❌ 不调 buildHarnessEngine | —         | —            | —              | —                | —                   |

### 风格要点

继承 016 / 017 / 020 / 022 风格要点：

- **数据单源**：`identity.ts` / `soul.ts` / `bootstrap.ts` 三个 const string 是 SSOT，不能在 `assembleIdentityContext` 内重新拼段。
- **错误降级**：user.md / state.json 读失败时（文件不存在 / IO 异常）→ 跳过该段（不抛、不凝 500），装配继续（与 #121 readOrEmpty 行为一致）。
- **写入显式**：rev 2026-08-11 — state.json 写入只发生在 `initializeIknowWorkspace` seed BOOTSTRAP.md 后翻旗（`bootstrap_seeded: true`）；装配路径不写。BOOTSTRAP.md 完成 = agent 自己删文件（文件驱动，无宿主钩子）。
- **不构造第二份权威副本**：identity / soul 字符串只在 `deps.system` 装配时存在，不缓存进 `LoopState.messages`（守 014 附加原则）。
- **eager + idempotent**：`initializeIknowWorkspace` 可被任意入口任意次调用，幂等。

### 复杂度阈值约束（spec 层钉死，实施层不得超）

继承 022 spec §Complexity thresholds（项目 `code-quality.md` 同款）：

- **Cyclomatic complexity ≤ 10 / 函数**
- **Nesting depth ≤ 4**
- **Function ≤ 40 行**（soft review-trigger；超 60 行 = 拆函数硬闸门）
- **File ≤ 500 行**（超 = 拆模块硬闸门）
- **Params ≤ 4 / 函数**（超 = 引入 options object 硬闸门）
- **Clone rate ≤ 3%**（项目 jscpd 门）

适用对象（实施 agent 必须守住）：

- `src/harness/identity/` 全部 6 文件
- `src/harness/build-engine.ts` 改动段（deps.system 注册 + init 触发）
- `src/cli/runtime.ts` 改动段
- `src/session-api/serve.ts` 改动段
- `src/tui/tui.ts` 改动段
- `tests/harness/identity/*.test.ts` 全部 4 文件

> 阈值是**约束**不是**实现**。A3 仍保留"不规定具体函数签名"，但实施层函数一旦越过阈值必须拆。ACR complexity-anti-drift 在 writing-plans 完成后会复检。

### 错误契约（typed error contract）

state.json / user.md IO 错误必须 typed，不允许坍缩到裸异常：

```ts
// src/harness/identity/workspace.ts — 错误分类（建议命名，writing-plans 微调）

/** IKNOW-196 装配错误分类。出现时降级处理（skip 段，不抛）；写入路径抛 typed error。 */
export type IknowIdentityError =
  | { kind: "state_parse_failed"; path: string; reason: string } // JSON 损坏
  | { kind: "state_schema_invalid"; path: string; field: string } // schema_version 不匹配
  | { kind: "write_failed"; path: string; cause: string } // mkdir / writeFile 失败
  | { kind: "io_error"; path: string; cause: string }; // 其他 fs IO 错误
```

**降级契约**（读路径必守）：

| 错误来源                    | 行为                               | 装配影响       |
| --------------------------- | ---------------------------------- | -------------- |
| `user.md` 不存在            | 跳过 user_profile 段               | 装配继续       |
| `state.json` 不存在         | 视为 `bootstrap_seeded=false`      | BOOTSTRAP 注入 |
| `state.json` JSON 损坏      | 跳过 bootstrap 段（log warning）   | 装配继续       |
| `state.json` schema_invalid | 跳过 bootstrap 段（log warning）   | 装配继续       |
| `user.md` 读失败（IO）      | 跳过 user_profile 段               | 装配继续       |
| `~/.iknow/` 不存在          | 调 `initializeIknowWorkspace` lazy | 装配继续       |

**写入路径**（`initializeIknowWorkspace` / `writeIknowState`）允许抛 typed `IknowIdentityError`，由 `buildHarnessEngine` 入口降级（log + 不阻塞装配）—— 不阻塞保证：**用户级文件 IO 失败不应让 agent 永远跑不起来**。

## Testing Strategy

- **测试框架**：vitest（022 沿用）。不引入 fs-mock / memfs 增强。
- **测试层**：
  - **unit**：identity 装配 / workspace 初始化 / state.json 状态机 / 入口判定
  - **integration**：`buildHarnessEngine` 装入 `deps.system`（mock harness 退化为 stub-model 路径）+ 4 入口覆盖（mock entry 调用）
  - **manual smoke**（实施期手动，不进 vitest）：对齐 i9 / i10 / i11 惯例，新增 `scripts/i12-identity-assembly-smoke.ts`，覆盖 6 条断言（identity 段注入 / soul 段注入 / user.md 存在性 / BOOTSTRAP 首启触发 / state.json 写入 / 二次启动跳过 BOOTSTRAP）

- **测试覆盖维度**（5 类边界）：
  - **empty**：`~/.iknow/` 完全不存在 → 触发 `initializeIknowWorkspace` → 4 段 seed + state.json 写入
  - **negative**：user.md 损坏 / state.json JSON 损坏 / state.json schema_version 不匹配 → 装配降级（skip 段，继续）
  - **overflow**：user.md 极大（> 100KB）→ 装配 token 截断（守 #121 FILE_CAP = 12000；soul.ts 全文 < 2000 字符预期）
  - **exception**：mkdir 失败 / writeFile 失败（EACCES / EROFS）→ 入口降级（log + 不阻塞）
  - **concurrent**：同时跑 2 个 iknow 实例 → state.json 单写（last-write-wins；不引入文件锁）

- **覆盖率目标**（unit + integration 层，vitest `--coverage`）：
  - **Line coverage ≥ 80%** for `src/harness/identity/**/*.ts` + `src/harness/build-engine.ts` 改动段
  - **Branch coverage ≥ 70%** for 同上文件
  - **认知 vs 人格边界必测**：`identity.test.ts` 至少 1 个测试 assert identity.ts 不含 core truths / boundaries / vibe / continuity 段；soul 段（融入 identity.test.ts 或独立）assert soul.ts 不含 Name / Kind / Signature 段
  - **入口覆盖矩阵每行至少 1 个测试**：`shouldIncludeBootstrap` 4 个 case（chat / tui / ask / serve）
  - **5 段装配顺序必测**：固定拼接测试，assert 5 段顺序字符串索引（identity 在 soul 之前；user AGENTS 在 PRIORITY 之前；project AGENTS 在 EXISTENCE_POINTER 之前）
  - **state.json 状态机必测**：bootstrap_seeded false → true 唯一迁移路径；schema_version 字段必写
  - **回归套件**（016 / 017 / 020 / 022 / #121）coverage 不下降（基线 = 当前 master vitest coverage，实施前 `npm test -- --coverage` 留底）

- **回归约束**：
  - 016 S1-S11 + 017 S12-S17 + 020 CLI 集成测试 + 022 Session API 集成测试 + #121 T1-T8 装配测试**全过不回归**
  - 019 i9 smoke 6 条 + 020 i10 smoke 6 条 + 022 i11 smoke 6 条全过不回归

> Success Criteria 区把每条转成二元判据。

## Boundaries

- **Always do**：
  - 跑 `npm run typecheck` + `npm test` 全绿后才算完成。
  - 严格遵守 014 append-only messages：deferred 段（identity / soul / user.md / BOOTSTRAP / AGENTS.md / memory）**不进入** `state.messages`，仅透传 `request.system`（守 014 附加原则）。
  - 装配路径**只读**（除 `initializeIknowWorkspace` 显式 seed + `writeIknowState` 显式 PATCH 外，**不写盘**）。
  - `initializeIknowWorkspace` 走 **eager + idempotent**（4 入口都调）：mkdir / 写 user.md / 写 state.json 三类操作都用 `if not exists` 守卫。
  - `bootstrap_seeded` 状态机仅在 `bootstrapActive: true` 的入口（chat / tui / serve）激活；ask 跳过（用户 2026-08-08 裁定：serve 不再单独降级）。
  - identity / soul / bootstrap 三个 const string 是 SSOT；装配时只能引用，绝不复制 / 切片（防 drift）。
  - user.md 行为：对**用户可改**段（Profile / Defaults / Ongoing / Preferences / Notes）纯净读；首启时通过 USER_TEMPLATE 占位 seed。
  - state.json 写 atomic write（write to temp + rename）—— 防止半写导致 JSON 损坏。
  - 不动 `src/config/env.ts` 栈默认（守 ADR-0001）。
  - 不动既有 8 工具集拓扑（守 ADR-0004 / 141-T11）。
  - 不动 #121 既有 7 段装配顺序（守 A3）；仅在 1-2 步前置插入。
  - 不动 `upstream-openharness`（守 CLAUDE.md / `docs/CONTEXT.md`）：仅做行为参考，不 import / 不 symlink / 不加载。
  - 不新增 npm 依赖（守 A6）。

- **Ask first**：
  - 修改 `src/harness/loop-engine.ts`（Foundation 已 016 / 017 / 021 冻结；A11 已要求把 `deps.system` 缝从 #121 worktree 提升到 master，但本身等同于 freeze 提升，**询问后才能改**）。
  - 修改 `tsconfig.json` 或 `package.json` scripts（除新增 i12 smoke 脚本）。
  - 调整 `src/harness/identity/` 子模块内部文件切分（模块级责任不可变）。
  - 触发 issue #196 之外的临近修改（如合并 #121 worktree 到 master 的分支策略）。
  - 修改 014 / 015 / 016 / 017 / 020 / 022 / #121 已冻类型形状（`RunResult` / `LoopTrace` / `StopReason` / `LoopEngineDeps`）。

- **Never do**：
  - 把 identity 内容塞回 `~/.iknow/AGENTS.md`（issue #196 清理记录已删，回归就是回滚）。
  - 单独创建 `identity.md` 文件（已合并到 soul 顶部；按决策点 §3-5 锁定）。
  - 把 soul 内容塞回用户区（用户区只有 user.md 一个文件）。
  - 让装配路径在 `debounce` / `cache` / `TTL` 基础上**静默跳过** identity 段（identity 段必须每次注入）。
  - 缓存 identity 字符串到 `state.messages`（破 014 附加原则）。
  - 用 `console.log` / `console.warn` 替代 typed warning（spawn structured logger 路径留 writing-plans 定）。
  - 让 IO 错误凝成裸 `throw new Error(...)`（ACR error-handling-enforcer 闸门）。
  - 引入文件锁 / 跨进程 IPC / 共享内存（守 022 A15）。
  - 引入新状态机框架 / Observable / FSM 库（守 022 A16）。
  - 留 `AGENTS.md` 身份占位 / 字段映射（issue #196 清理目的）。
  - 删除失败测试让构建通过 / 把失败测试改成跳过（项目 `code-quality.md`）。
  - 重开 014 / 015 / 016 / 017 / 020 / 022 / #121 已冻契约。
  - **超复杂度阈值不拆函数**（ACR complexity-anti-drift 闸门）。
  - **identity 段混入 soul 内容 / soul 段混入 identity 内容**（ACR bounded-context-guardian 闸门）。

## Success Criteria

二元判据（每条 yes/no）：

### 基础功能（10 条）

1. `node -e "import('./src/harness/identity/identity.js').then(m => console.log(typeof m.IKNOW_IDENTITY_DEFAULT === 'string' && m.IKNOW_IDENTITY_DEFAULT.length > 0))"` 退出码 0 → identity const string 存在
2. `node -e "import('./src/harness/identity/soul.js').then(m => console.log(typeof m.IKNOW_SOUL_DEFAULT === 'string' && m.IKNOW_SOUL_DEFAULT.length > 0))"` 退出码 0 → soul const string 存在
3. `node -e "import('./src/harness/identity/bootstrap.js').then(m => console.log(typeof m.BOOTSTRAP_TEMPLATE === 'string' && m.BOOTSTRAP_TEMPLATE.includes('delete this file')))"` 退出码 0 → BOOTSTRAP_TEMPLATE const string 存在（rev 2026-08-11:BOOTSTRAP.md 文件模板）
4. `grep -c "iknow" src/harness/identity/identity.ts` ≥ 1 → identity 段含 "iknow" 自指
5. `grep -c "core truths" src/harness/identity/soul.ts` ≥ 1 → soul 段含 core truths 段
6. `grep -c "vibe" src/harness/identity/soul.ts` ≥ 1 → soul 段含 vibe 段（按 A13 Vibe 归人格）
7. `test -f src/harness/identity/identity.ts` && `test -f src/harness/identity/soul.ts` → 独立文件存在
8. `test ! -f src/harness/identity/identity.md` → 不存在独立 identity.md（已合并到 soul 顶部）
9. `node -e "import('./src/harness/identity/workspace.js').then(m => console.log(typeof m.initializeIknowWorkspace === 'function'))"` 退出码 0 → 初始化函数存在
10. `node -e "import('./src/harness/identity/workspace.js').then(m => console.log(typeof m.readIknowState === 'function'))"` 退出码 0 → state 读取函数存在

### 认知 vs 人格边界（4 条）

11. `grep -c "core truths" src/harness/identity/identity.ts` = 0 → identity 段不含 core truths
12. `grep -c "name:" src/harness/identity/soul.ts` = 0 （case-insensitive，去除注释后的实义匹配）→ soul 段不含 Name 字段
13. `grep -c "vibe" src/harness/identity/identity.ts` = 0 → identity 段不含 vibe（按 A13 Vibe 归人格）
14. `grep -c "signature" src/harness/identity/soul.ts` = 0 → soul 段不含 Signature 字段

### 入口覆盖（5 条）

15. `node -e "import('./src/harness/identity/index.js').then(m => console.log(m.shouldIncludeBootstrap('chat') === true && m.shouldIncludeBootstrap('tui') === true && m.shouldIncludeBootstrap('ask') === false && m.shouldIncludeBootstrap('serve') === true))"` 退出码 0 → 入口矩阵正确
16. `npm test -- tests/harness/identity/system-injection.test.ts` 退出 0 → 4 入口 mock 覆盖
17. `grep -c "initializeIknowWorkspace" src/cli/runtime.ts` ≥ 1 → CLI 入口接 init
18. `grep -c "initializeIknowWorkspace" src/session-api/serve.ts` ≥ 1 → serve 入口接 init
19. `grep -c "initializeIknowWorkspace" src/tui/tui.ts` ≥ 1 → tui 入口接 init

### 注入缝（4 条）

20. `grep -c "deps.system" src/harness/build-engine.ts` ≥ 1 → deps.system 缝已装入
21. `grep -c "deps.system?.()" src/harness/loop-engine.ts` ≥ 1 → loop-engine 每 turn 调 deps.system
22. `grep -c "assembleIdentityContext" src/harness/build-engine.ts` ≥ 1 → buildHarnessEngine 装入身份装配
23. `node -e "import('./src/harness/identity/index.js').then(m => m.assembleIdentityContext({cwd: process.cwd(), userHome: os.homedir(), bootstrapActive: true}).then(s => console.log(s.includes('iknow'))))"` 退出码 0 → 装配产物含 identity

### 状态机（4 条）

24. `npm test -- tests/harness/identity/bootstrap.test.ts` 退出 0 → BOOTSTRAP 状态机测试（seed 即翻旗）
    24b. `npm test -- tests/harness/identity/bootstrap-file.test.ts` 退出 0 → BOOTSTRAP_TEMPLATE 文件模板 + bootstrapFilePath（rev 2026-08-11）
25. `npm test -- tests/harness/identity/workspace.test.ts` 退出 0 → workspace 初始化测试
26. `npm test -- tests/harness/identity/workspace.test.ts -t "roundtrip"` 退出 0 → state.json 读写往返（schema_version=1 + bootstrap_seeded 字段必写）
27. `npm test -- tests/harness/identity/system-injection.test.ts -t "second skip"` 退出 0 → 二次启动（BOOTSTRAP.md 已删）跳过 BOOTSTRAP 段（rev 2026-08-11:文件驱动隐式完成）

### 装配顺序（3 条）

28. `npm test -- tests/harness/identity/system-injection.test.ts -t "order"` 退出 0 → 5 段顺序固定
29. `npm test -- tests/harness/identity/identity.test.ts -t "identity before soul"` 退出 0 → identity 在 soul 之前（用测试 fixture 控制 cwd/userHome，不用真实 `/tmp`）
30. `npm test -- tests/harness/identity/system-injection.test.ts -t "user agents before priority"` 退出 0 → user AGENTS 在 PRIORITY 之前（守 #121）

### 错误降级（3 条）

31. `npm test -- tests/harness/identity/workspace.test.ts -t "JSON corrupt"` 退出 0 → state.json 损坏降级
32. `npm test -- tests/harness/identity/workspace.test.ts -t "schema invalid"` 退出 0 → schema_version 不匹配降级
33. `npm test -- tests/harness/identity/workspace.test.ts -t "user.md missing"` 退出 0 → user.md 缺失跳过

### 回归（3 条）

34. `npm test -- tests/harness/memory/assembly.test.ts` 退出 0 → #121 装配测试不回归
35. `npm test` 退出 0 → 全测试套件通过
36. `npm run typecheck` 退出 0 → TypeScript 0 误

### 自动化 evidence（3 条）

37. `npx tsx scripts/i12-identity-assembly-smoke.ts` 退出 0 → 实施期 6 条断言全过
38. `mkdir -p docs/handoff/2026-08-06-identity-assembly && cp /tmp/i12-smoke-output.txt docs/handoff/2026-08-06-identity-assembly/` → smoke 证据落档
39. `grep -c "### Feature" CHANGELOG.md` ≥ 1 → CHANGELOG 加 Feature 条目

> 总计 39 条 SC。每条 yes/no 形式可机器验证。ACR 5 闸门在 writing-plans 完成后复检。

## Open Questions

（无。所有 5 个决策点已收敛，A14 已确认默认空。）

---

## Architectural Constraints（架构约束 - 必有段）

- **A-N1** 014 消息单源：identity / soul / user.md / BOOTSTRAP / AGENTS.md / memory 段不出 `state.messages`，仅透传 `request.system`。
- **A-N2** 016 / 017 Foundation 冻结：`LoopEngineDeps` 增加 `system` 字段是从 #121 worktree 提升的（A11 锁），不是新增 freeze。
- **A-N3** 020 / 022 既有契约：CLI / Session API 路径不动；assembly.ts 7 段顺序不动；trace 路径不动。
- **A-N4** #121 装配契约：assembly.ts 7 段顺序为 `user_agents → priority_dec → project_agents → existence_pointer → promote`；本 spec 在 1-2 步前置插入 identity / soul，不重排。
- **A-N5** ADR-0001（9router stack code defaults）：不动 `src/config/env.ts` 栈默认。
- **A-N6** ADR-0004 / 141-T11（8 工具集）：不动既有工具拓扑，本 spec 不注册新工具。
- **A-N7** ADR-0008（token accounting）：identity / soul 段不计 token 成本（仅作 `request.system` 字段透传，不进入 prompt-cache key 之外的 cost 计算路径）。
- **A-N8** doc SSOT：`docs/CONTEXT.md` 是术语词典；`docs/architecture.md` 是模块责任真值。本 spec 不重定义术语，不重画架构。

---

## Architectural Change Reviewer Verdict Block（Step 4 — 5 闸门）

> 计划在 writing-plans 完成后由 `architecture-change-reviewer` 子代理复检并填充。本 spec 草稿阶段暂留 placeholder。

```text
bounded-context-guardian: yes — src/harness/identity/ 是独立 bounded context（spec.md:80-87 列 6 文件归属该模块）；唯一跨 context 边缘是 `deps.system` 注入缝（spec.md:19 A11、spec.md:238-256）；Boundaries 明令 "identity 段混入 soul 内容" 为 Never do（spec.md:396），且 `state.messages` 不缓存 identity 字符串（spec.md:275 守 014 附加原则）。
defensive-contract-validator: yes — Testing Strategy 列出全部 5 边界类 empty/negative/overflow/exception/concurrent（spec.md:337-341）；覆盖率目标 80/70 显式声明（spec.md:344-345）；SC31-33 覆盖 JSON corrupt / schema invalid / user.md missing 三类降级（spec.md:452-454）；SC16/24-27/29-30 覆盖入口 + 状态机 + 装配顺序；认知/人格边界 11-14（spec.md:417-420）防 drift。
error-handling-enforcer: yes — `IknowIdentityError` discriminated union 四种 kind 定义（spec.md:308-312）；降级契约表覆盖 6 类失败（spec.md:317-325）；写入路径显式 allowed-throw（spec.md:326）；Never do 栏禁止裸 `throw new Error(...)`（spec.md:389）；构造 logger 路径虽留给 writing-plans（spec.md:388），但 read path 已 typed + skip + log warning 双轨。疑点：user.md 读 IO 失败（行 324）与 `~/.iknow/` lazy init（行 325）未显式要求 log warning，建议 writing-plans 阶段在对应日志策略里补回 log；不阻塞 spec 推进。
complexity-anti-drift: yes — 阈值全项钉死 cyclomatic≤10 / nesting≤4 / fn≤40 / file≤500 / params≤4 / clone≤3%（spec.md:282-287）；适用对象 6 文件 + 3 改动段 + 4 测试文件全部列出（spec.md:290-296）；`assembleIdentityContext` 5 段装配走 `IKNOW_ASSEMBLY_ORDER` const array table-driven dispatch（spec.md:122-132），单函数易守 ≤40 行；超阈值强制拆函数（spec.md:298）。建议 writing-plans 把每段装配拆成独立小函数（如 `identitySegment()` / `soulSegment()`），避免单函数内联 5 段。
minimal-change-verifier: yes — 依赖声明显式零新增（spec.md:507-513）；不修改 lockfile/tsconfig（spec.md:510-511）；不引入新 npm 依赖（spec.md:373 守 A6、spec.md:14）；frozen contracts 双重禁令：Ask first 拦 014/015/016/017/020/022/#121 形状改（spec.md:380），Never do 拦"重开已冻契约"（spec.md:394）+ "超阈值不拆函数"（spec.md:395）+ identity/soul 混段（spec.md:396）；锁 1 commit = 1 逻辑任务（CLAUDE.md 全局规则）。
```

> **ACR 复检结论（2026-08-06）**：5 闸门全部 `yes`，spec 可推进到 writing-plans。两条非阻塞建议已记入 writing-plans 消费清单：
>
> 1. **logger 缺口补回**：user.md IO 失败（spec.md:324）与 `~/.iknow/` lazy init（spec.md:325）走降级但未显式标 log warning；writing-plans 阶段在 logger policy 里补成 `log warning + skip`。
> 2. **`assembleIdentityContext` 实现策略**：5 段装配走表驱动（spec.md:122-132），单函数 ≤40 行需拆为 `identitySegment()` / `soulSegment()` / `userProfileSegment()` / `bootstrapSegment()` 等 helper，writing-plans 设计为 `for (const seg of IKNOW_ASSEMBLY_ORDER) yield await resolveSegment(seg, ctx)` 形态。

> 5 闸门全部 `yes` 或 `N/A with reason` 后 spec 进入 Step 5 writing-plans；任一 `no` / `unclear` → 回到本 spec 修订。

---

## Dependency Declaration（依赖声明）

本 spec 零新增依赖：

- **不新增** npm runtime 或 dev 依赖。
- **不修改** `package.json` / `package-lock.json`。
- **不修改** `tsconfig.json`。

> 实施 agent 不得新增任何依赖。如需工具辅助（如 terminal stdout 着色），用 Node 内建或现有 dev deps。

---

## Architectural Decision Record Reference（ADR 引用）

本 spec 不直接产生新 ADR。直接引用既有 ADR：

- **ADR-0001** 9router stack code defaults（守 env.ts 栈默认）
- **ADR-0004** tool-layer-six-tool-set（守 8 工具集拓扑）
- **ADR-0005** executor-hardening-stop-signal-json-whitelist（identity 段不受 stop signal 影响）
- **ADR-0006** tool-output-capping-hard-truncate-20000（identity 段不进 tool output 截断路径）
- **ADR-0008** token-accounting-usage-placement（identity 段不计 token cost）

新架构决策（identity 注入缝提升到 master baseline）是 #196 / #121 已开议题，非新 ADR 范围。

---

## Reference Implementation Mapping（参考实现映射）

| iknow 决策                               | OpenHarness/ohmo 真值                                   | 关键差异                                                                         |
| ---------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `identity.ts` (认知层)                   | `ohmo/identity.md` 4 行简表（Name/Kind/Vibe/Signature） | ① 移到代码（非工作区） ② Vibe 归 soul（只留 Name/Kind/Signature）                |
| `soul.ts` (人格层)                       | `ohmo/soul.md` SOUL_TEMPLATE 全文                       | ① 移到代码（非工作区） ② 仍含 vibe / continuity                                  |
| `bootstrap.ts` (首启脚本)                | `ohmo/BOOTSTRAP.md`                                     | 移到代码（非工作区）                                                             |
| `user-template.ts` (user.md seed)        | `ohmo/user.md` USER_TEMPLATE                            | 带位置（用户工作区）                                                             |
| `workspace.ts` (eager + idempotent init) | `ohmo/initialize_workspace`                             | 改 JSON（state.json 替代 marker 文件） + 精简 scope（只写 user.md + state.json） |
| `assembleIdentityContext` 5 段顺序       | `ohmo/build_ohmo_system_prompt` 8 段顺序                | 保持一致（identity 在 soul 之前）                                                |
| `state.json` 状态机                      | `state.json` `bootstrap_seeded` 字段                    | 保持一致（OHMO 风格）                                                            |

> 行为真值参考 `upstream-openharness/ohmo/{workspace,prompts}.py`。本 spec 不 import / 不依赖 / 不 symlink。

---

## End of Spec

spec 路径：`specs/196-identity-assembly.md`  
plan 路径（待 writing-plans 产出）：`plans/196-identity-assembly.md`（wait → Step 5 handoff）
