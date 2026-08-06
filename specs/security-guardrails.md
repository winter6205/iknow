# Spec: ③ 安全护栏（权限三层 · 沙箱 · 中断/超时）

> **Lean spec.** 上游权威决议 = wayfinder map [#115](https://github.com/winter6205/iknow/issues/115) + 子票 [#122](https://github.com/winter6205/iknow/issues/122)（权限三层）/ [#123](https://github.com/winter6205/iknow/issues/123)（零信任沙箱）/ [#124](https://github.com/winter6205/iknow/issues/124)（中断/超时）/ [#162](https://github.com/winter6205/iknow/issues/162)（askUser 三入口平权装配）。本 spec 只补充决议未钉死的实施层细节（文件布局 / TS 类型骨架 / 配置格式 / 验收映射）；未重述内容以四票 Resolution 为准。
>
> 假设门：2026-08-04 操作员确认 29 条假设（A1–G28），无修正项。

## Glossary（exact copy from docs/CONTEXT.md，不重定义）

- **Loop Engine**: Foundation 的状态机运行内核，驱动模型 -> 工具 -> 真实结果 -> 下一轮模型 -> 明确停止；位于 `src/harness/`。
- **StopReason**: Loop Engine 的七类停止判别联合（含 017 两类 `cancelled` / `timeout`）。
- **LoopTrace**: `run()` 的第二返回面 `{ result, trace }`；A 层结构元数据，严格不含 payload。`cancelKind` 是取消来源四值枚举 `"none" | "callerAbort" | "timerTimeout" | "hostCancel"`。
- **ToolExecutionContext**: Executor 透传给 handler 的执行上下文 `{ signal }`；超时由 Executor 外包而非 ctx 携带。
- **in-flight closeout**: abort/timeout 发生时的收尾语义——在途 tool call 填 `execution_failed`（message 固定 "cancelled"/"timeout"），signal 优先于 timeout。
- **NINE_ROUTER_KEY**: SSOT env var name for the 9router API key；baked into `src/config/env.ts` as the code default of `IKNOW_LLM_API_KEY_ENV` (ADR-0001)。

### Flagged ambiguities（沿用 CONTEXT.md，与本 spec 相关者）

- **cancelled vs timeout**: 两条独立停止路径；signal 优先，不在 signal 层合并超时。
- **chat vs ask**: product CLI 是 TTY/pipe-aware；oneshot JSON ask 是脚本路径。#162 澄清：CLI `ask` 子命令（oneshot 入口）与权限三层的 `ask` 决策不是一个东西——前者是入口，后者是三值之一。

## Architectural Constraints（ADR 引用）

- **ADR-0004**（工具层六工具集）：bash 安全边界 = OS 沙箱（#123 阻塞前置）；allowlist 降级为沙箱落地前的过渡措施；契约 X（executor 截断权威）/ Y1（纯字符串输出，bash 例外保 `{code, stdout, stderr}`）不动。
- **ADR-0005**（executor 加固）：统一停止信号（超时与取消合并为一个 AbortSignal）；有子进程工具（bash/grep）必须监听信号并杀整棵进程树（SIGTERM → 2s → SIGKILL，detached + 负 pid）；isJsonCompatible 白名单。
- **ADR-0006**（封顶策略）：20000 字符硬截断 + executor 截断权威不变。
- **ADR-0001**（9router 栈默认）：密钥 env 名 SSOT 在 `src/config/env.ts`；沙箱层只消费、不重新声明。

## Objective

**What**: 在 iknow harness（`src/harness/`）上实施③安全护栏的三块决策：

1. **权限三层**（#122）：独立中间件链（preToolUse hook → checkPermission → askUser → inner → postToolUse hook），三值决策 `allow/deny/ask`，规则三层（代码内置 → 项目设置 → 会话授予）+ 硬墙不可覆盖，askUser 作为装配参数。
2. **零信任沙箱**（#123）：bash 工具（及未来 execute 类）在 bwrap 围栏内执行——FS 白名单减敏感清单、网络默认 deny + 静态白名单、rlimit + tmpfs 资源限制、违规分级处置、密钥 env 隔离 + 输出 mask 红线。
3. **中断/超时分级**（#124）：`interruptBehavior`（cancel/block）在 AciExecutor 路由层运行时生效、per-tool 四档超时、bash 超时/取消保留 partial output。v0 不做后台任务管理器。

**Why**: ch05 验收「越权/危险操作被稳定拦截，长任务不阻塞主循环」+ map Destination「密钥永不进入运行生成代码的 sandbox」。原型（`src/harness/aci/`）已验证形态（permission 装饰 + allowlist-first 21/21 对抗结论），毕业进产品路径是既定债务（ADR-0004 bash 沙箱阻塞前置）。

**Who**: 用户 = iknow CLI/serve 的操作员（chat/ask/serve 三入口）。本 spec 的下游消费者 = `architecture-change-reviewer`（Step 4 gate）→ `writing-plans`。

**Success**: 见 Success Criteria 20 条 binary 判定，全部对应四票 Resolution 的验收标准（#122 Q6 六维度 / #123 Q7 六类矩阵 / #124 五条验收 / #162 fail-loud）。

## Tech Stack

- **Language/Runtime**: TypeScript（tsconfig: ES2022 / NodeNext / strict / verbatimModuleSyntax），Node ≥ 20，ESM。
- **沙箱机制**（#123 Q6 实测定案，方案 A）：`bubblewrap`（bwrap ≥ 0.11.1）+ user namespace + seccomp（`--seccomp FD`，v0 可不启用，接口预留）；rlimit（setrlimit 经 bwrap `--rlimit` 或 wrapper）+ tmpfs（`--tmpfs`）双层资源限制。AppArmor 不需要（WSL2 最小内核 enabled=N）。cgroup v2 留 v1。
- **bwrap 是运行时硬依赖**：启动期探测，缺失 → fail-loud（清晰报错 + 安装指引），bash 工具拒绝装配。不 fallback 到 allowlist-only 生产模式（allowlist 仅是沙箱落地前的过渡，ADR-0004）。
- **既有依赖**：`@anthropic-ai/sdk` / `ajv` / `ajv-formats`（v0 项目设置文件校验用 ajv）。
- **新增依赖**：`smol-toml`（TOML 解析，项目设置文件格式；选它因为零依赖、只读场景）。**此项已进假设门（A19）并确认**。
- **测试**：vitest（既有）+ bwrap 探针脚本（`scripts/`，真起 bwrap）。
- 技术栈变更需新假设门。

## Commands

```bash
Build:  npm run build            # tsc -p tsconfig.json
Test:   npm test                 # vitest run（unit + harness + integration）
Type:   npm run typecheck        # tsc --noEmit
Lint:   npx prettier --check src tests   # 无独立 lint script；pre-commit 走 husky + lint-staged
Dev:    npm run dev              # tsx src/cli.ts
Probe:  npm run probe:sandbox    # 新增 script：tsx scripts/sandbox-probe.ts（真起 bwrap，Q7 矩阵）
```

## Project Structure

生产路径落点（毕业去向）：

```
src/harness/
├── permission/                 # 新增：权限三层（#122）
│   ├── types.ts                # PermissionDecision / PermissionOutcome / PermissionRule / Policy
│   ├── policy.ts               # 规则三层 + 硬墙（代码内置层；项目设置；会话授予）
│   ├── project-settings.ts     # .iknow/permissions.toml 加载 + ajv schema 校验（构造期，不热加载）
│   ├── session-grants.ts       # in-memory 会话授予（不持久化）
│   ├── hooks.ts                # PreToolUse/PostToolUse 骨架（v0 no-op，调用位齐全）
│   ├── ask-user.ts             # AskUser 接口 + 三入口各自实现
│   └── permission-executor.ts  # 装饰 Executor：五步中间件链（D1）
├── sandbox/                    # 新增：零信任沙箱（#123）
│   ├── bwrap.ts                # bwrap argv 构造 + spawn（FS/网络/资源参数合成）
│   ├── fs-policy.ts            # 白名单（cwd + $HOME + tmpdir）− 敏感清单；只读系统目录
│   ├── network-policy.ts       # 默认 deny + 静态白名单 + unshare-net
│   ├── resource-limits.ts      # rlimit + tmpfs 数值（可配）
│   ├── env-isolation.ts        # env 白名单（拥有层）；密钥名从 env.ts SSOT 取 + 兜底正则
│   ├── output-mask.ts          # 输出 mask（显示层）；密钥值集合从 env.ts 取
│   └── violation-handling.ts   # 三档违规处置 + 计数升级（N=3 可配）+ 杀会话执行流
├── aci/                        # 现 PROTOTYPE：毕业改造（不是删除重写）
│   ├── types.ts                # 修订：删 pass_through；三值改 allow/deny/ask；
│   │                           #   删 isReadOnly/isDestructive（毕业删除，#122 Q5）；
│   │                           #   保留 category / interruptBehavior / isConcurrencySafe（#124）；
│   │                           #   新增 timeoutTier: "fast"|"default"|"build"|"long"
│   ├── permission.ts           # 修订：接 permission/ 三层，allowlist 降为沙箱前过渡（已有注释）
│   └── aci-executor.ts         # 修订：#124 路由（interruptBehavior）+ 四档超时 + partial output
├── aci/tools/                  # 6 工具（bash/read_file/grep/glob/edit_file/write_file）
│   └── bash.ts                 # 修订：走 sandbox/bwrap 装配；env 白名单生效；cwd 工厂参数是预留钩子
└── tools/executor.ts           # 不动（ADR-0005 统一停止信号已在 017 落地）

src/cli/                        # 三入口装配（#162 平权）
├── chat-session.ts             # chat：TTY askUser 实现
├── runtime.ts                  # ask：oneshot askUser 实现（具体形态 Open Question）
└── session-io.ts               # serve：SPA 交互通道 askUser

.iknow/permissions.toml         # 新增：v0 项目设置层（仓库根；TOML；git 友好）
scripts/sandbox-probe.ts        # 新增：Q7 验收矩阵探针（真起 bwrap）
specs/security-guardrails.md    # 本 spec
plans/security-guardrails.md    # writing-plans 产物（Step 5 后）
```

## Code Style

沿用 harness 既有风格（016/017 先例）：工厂函数返回 `Object.freeze`；纯函数导出 + 装配与判定分离（#122 D4：校验动作 vs 校验来源分离）；类型用 TS 联合不用 enum（#122 Q3）；注释只解释 why/约束/边界（code-quality 规则）。

示例（决策对象，#122 Q3 定案形态）：

```typescript
/** 三值联合（裸字符串），整体结果 opt-bag；不用 TS enum。 */
export type PermissionDecision = "allow" | "deny" | "ask";

export interface PermissionOutcome {
  readonly decision: PermissionDecision;
  /** deny 原因带来源前缀：hook_blocked / permission_denied / user_denied */
  readonly reason: string;
}
```

## Testing Strategy

- **框架**：vitest（既有）。新测试落 `tests/harness/permission/`、`tests/harness/sandbox/`、`tests/harness/aci/`。
- **应用层单测**（#123 Q7 + #122 Q6）：危险命令拒绝、`read_file` 墙拒绝、env 白名单生效、违规计数升级、硬墙不可覆盖、三层覆盖语义、中间件链 deny 零副作用、block 工具 abort 不打断。
- **集成探针**（`scripts/sandbox-probe.ts`，#123 Q7 方案 B）：真起 bwrap 验物理层——`process.env` 仅剩白名单、`~/.ssh` tmpfs 盖空、围栏内 fetch 非白名单 → EAI_AGAIN、写 `/etc` → Read-only、写 cwd → 成功。
- **运行时缺口补齐**（#124 验收 5 条）：bash abort 杀子进程测试、glob abort 测试、真实 spawn 的 tool timeout 测试（非 in-process 慢 handler）、`interruptBehavior` 路由两分支单测、block 工具「跑完再报 cancelled」测试。
- **回归**：S12–S17（signal/timeout/trace）+ 原型 permission 既有断言保持绿，不删不降。
- 覆盖率目标：权限/沙箱新模块行覆盖 ≥ 80%（test.md 规范）。

## Boundaries

- **Always do**: 跑 `npm test` + `npm run probe:sandbox` 后才 commit；deny 路径零副作用（不调 inner）；密钥名/值只从 `env.ts` SSOT 取；违规处置复用 `spawnWithStopSignal` 进程组 kill（017/023 成熟机制）；单次误碰敏感路径只拒单次 + 计数，不杀会话。
- **Ask first**: 新增运行时依赖（smol-toml 已确认，其余需新授权）；锁文件变更；`interruptBehavior`/`timeoutTier` 之外的 AciMeta 字段增删；网络白名单条目增删；违规计数 N 的默认值变更。
- **Never do**: 硬编码 `NINE_ROUTER_KEY` 字面量进沙箱层；把 `~/.ssh` 等敏感清单条目放进白名单；为让构建过而删/降测试；把 bwrap 缺失静默降级成无沙箱执行；allowlist 作为沙箱落地后的生产主门（它只是过渡 + 纵深双保险）；会话授予持久化到磁盘（v0）。

## Success Criteria（binary）

**权限三层（#122 Q6）**

1. 21/21 原型对抗 payload + ch05 §6 十类敏感路径变体，在最大宽松配置下全部 reject（硬墙不可绕过）。
2. 6 件工具零配置：read-only 放行 / write 问 / execute 问 + 硬墙；bash 包安装子类别有补充提示（Q4）。
3. 上层放宽普通规则 ✓；上层不能放宽硬墙 ✓；会话授予仅本次会话 ✓（Q2b）。
4. Hook v0 no-op 但调用位存在且可替换；hook_blocked 与 permission_denied 前缀不同；askUser 未注入时启动即 throw（fail-loud，#162）。
5. deny 走 `execution_failed` 通道，来源前缀可区分（hook_blocked / permission_denied / user_denied），deny 路径零副作用。
6. 权限模块既有测试全绿 + 新增验收测试通过（零回归）。

**沙箱（#123 Q7）**

7. `rm -rf /` / fork bomb 类命令应用层 deny（危险命令拒绝）。
8. 围栏内 `process.env` 不含任何密钥 env（探针断言 absent）；`node -e "console.log(process.env.NINE_ROUTER_KEY)"` 围栏内输出 undefined。
9. 围栏内 `ls ~/.ssh` 空（tmpfs 盖住）；写 `/etc` → Read-only file system；写 cwd → 成功。
10. 围栏内 fetch 非白名单域 → 失败（EAI_AGAIN）；白名单域（github.com / registry.npmjs.org / pypi.org）可连。
11. 资源超限（/tmp > 1GB 或 rlimit 触发）→ 配额拒绝/进程被限。
12. 中档违规（敏感命中/危险命令）拒单次 + 计数，N=3 升级杀会话 + chat 通知；单次误碰会话继续；高档（逃逸尝试/读密钥 env）立刻杀会话。

**中断/超时（#124 验收）**

13. bash 在 build 档（5min）内不超时；超时后结果携带 partial output（≤ 12000 字符），不是裸 `execution_failed timeout`。
14. caller abort：bash/grep/glob 子进程被 SIGTERM → 2s → SIGKILL 终止，报 `cancelled`（含 bash abort 杀子进程新测试）。
15. caller abort：edit_file/write_file 不被打断，跑完再报 `cancelled`（block 路由新测试）。
16. 超时/取消后主循环正常进入下一轮调度不挂死（S12–S15 保持绿 + trace 断言）。
17. `interruptBehavior` 运行时真读：AciExecutor 路由覆盖 cancel/block 两分支（单测）。

**跨层集成**

18. 三入口（chat/ask/serve）装配同一权限管线，各自 askUser 实现注入成功；任一入口缺 askUser → 启动 throw。
19. `npm run probe:sandbox` 全绿（Q7 矩阵物理层）。
20. 输出边界（chat/ask JSON/trace）已知密钥值被替换 `***`（mask 兜底单测）。

## Complexity Budgets（per-file, plan-time decomposition 不允许漂移）

- **新文件基线**：每个新模块文件 ≤ 300 行；每个函数 ≤ 30 行；嵌套 ≤ 4；函数参数 ≤ 3（多余参数走 options bag）；文件不持有可变状态（工厂返回 Object.freeze）。
- **bash.ts 改造**：当前 119 行；partial-output 改造 + bwrap 装配化 ≤ 200 行；partial-output 捕获通过 `spawnWithStopSignal` 扩展（已收集 stdout 直接对外暴露），不在 bash handler 内重写子进程管理。
- **permission-executor.ts**：装饰器外壳 + 五步中间件，预期 ≤ 120 行；任一中间件可独立抽函数 / 文件，不得内联超 30 行。
- **sandbox/ 内部模块**：每个 policy（fs / network / env / resource / output-mask / violation）单独文件、单职责；不允许一个文件涵盖多策略。
- **违规计数状态**：会话级 counter 走闭包，不引入类层；N=3 默认值与升级动作必须同函数内，避免配置漂移。
- **测试文件**：每个新模块至少 1 个测试文件，6 边界类全覆盖（空 / 负 / 溢出 / 并发 / 异常 / 畸形）；测试函数无行数限制但保持单文件 ≤ 600 行。

## Plan Decomposition（spec → plan 拆分预期，commit-count expectation）

本 spec 在 plan 阶段将按 bounded context 拆为 **≥ 6 个 tracer bullets**（不强制单提交；1 个 [decision] + 5 个 [implementation]，分别落地 4 票决议）：

1. **T1 [decision]** 落 OQ1/OQ2/OQ4 + 复杂度预算 → 决议定型（无代码，仅决策注释写入 spec/plan）
2. **T2 [implementation]** 权限三层毕业（#122）：新建 `src/harness/permission/`，改 `aci/types.ts` 删 pass_through/双真值，CLI 三入口装配 askUser。独立 commit。
3. **T3 [implementation]** 零信任沙箱（#123）：新建 `src/harness/sandbox/`（6 个 policy 文件），`scripts/sandbox-probe.ts`，`.iknow/permissions.toml` schema。独立 commit。
4. **T4 [implementation]** bash 工具生产化：bash.ts 走 bwrap 围栏 + partial output；不动 `tools/executor.ts`（ADR-0005 已在 017 落地）。独立 commit。
5. **T5 [implementation]** 中断/超时运行时接通（#124）：`aci-executor.ts` 路由 interruptBehavior + 四档超时表 + bash partial-output 接管；新增 bash abort 杀子进程、block 工具不打断、4 档超时测试。独立 commit。
6. **T6 [implementation]** 项目设置 + 违规处置 + 集成：`permission/project-settings.ts`、`.iknow/permissions.toml` 加载、violation-handling 三档升级；scripts/sandbox-probe 跑通 #123 Q7 14 行矩阵；新增 `npm run probe:sandbox` script。独立 commit。

T1 决策定型后 T2–T6 之间无强依赖约束（最多 T6 依赖 T3 的 bwrap 装配），可按 Plan 顺序执行。commit 数 6 个，spec 1 个 file = 7 commit，符合 minimal-change-verifier 的"1 logical task = N commits"语义。

## Open Questions（实施期细化，归 writing-plans，不阻塞 spec）

以下 Open Question 在 spec 阶段已 **决议定型**（typed error envelopes 已固化），plan 阶段只需落地：

1. **OQ1 — 网络白名单的过滤代理形态**：v0 形态 = `bwrap --unshare-net` 全封 + 静态域名白名单（github.com / registry.npmjs.org / pypi.org）的 DNS/IP 预解析放行；不引入独立代理进程（plan 期可升级为 sidecar，不影响契约）。
   - **错误信封**：网络违规（不在白名单）→ `execution_failed.message = "[network_denied] domain not in whitelist: <host>"`，prefix 与 permission 三层前缀区分（`[hook_blocked]` / `[permission_denied]` / `[user_denied]`）。
   - **类型契约**：`NetworkViolationError extends ToolExecutionError`，沙箱出口捕获后归一化为 `[network_denied]` execution_failed。
2. **OQ2 — `iknow ask` 入口 askUser 形态**：oneshot 场景下 askUser 默认 = `() => Promise.resolve(false)`（fail-closed deny），但**入口装配期必须显式传入**，不可默认隐藏。
   - **错误信封**：ask 决策且 askUser 未注入 → 启动即 throw（#162 已 lock），启动失败原因带 `ask_inlet_missing` 子串。
   - **运行时违规**：ask 决策走 askUser → 用户拒 → `execution_failed.message = "[user_denied] user declined tool call: <tool>"`，deny 来源前缀可追溯。
3. **OQ4 — 杀会话执行流的 trace 呈现**：**已决议 = 复用 `protocolError + reason`**。不复用新 StopReason 值，不改 016/017 冻结契约。
   - **trace 形态**：`LoopTrace.totals.finalState = "protocolError"`，reason 携带 `{ kind: "violation", tier: "high" | "mid-escalation", tool, message }`。
   - **取消 / 超时复用既有 cancelKind**：违规不产生 cancelKind（违反与正常停止来源不同），与 cancel/timeout 路径不混。
   - **stop 落地**：kill-session 流 = `engine.abort()` + `spawnWithStopSignal` 杀剩余子进程 + 写 violation reason 到 trace + chat 内通知（不入 messages 权威历史，trace 携带）。
4. **seccomp 过滤集 v0 是否启用**：v0 不启用（仅 bwrap mount 命名空间 + env 白名单），接口预留 `seccompProfile?: SeccompProfile` 在 `createBwrapFence` 上；v1 启用。
5. **原型毕业方式**：本 spec 定为「`src/harness/permission/` + `src/harness/sandbox/` 新建 + `src/harness/aci/` 原地修订保留」；旧 `src/harness/aci/permission.ts` + `aci-executor.ts` 内部重写为薄封装（导出原 API 但内部转调新模块）；不引入兼容 shim，旧名称（`shell_exec` / `fs_view` / `fs_search` / `fs_edit`）6 工具已统一在 ADR-0004 落地，本 spec 不重复处理。
