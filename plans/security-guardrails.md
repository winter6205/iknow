# Plan: ③ 安全护栏（权限三层 · 沙箱 · 中断/超时）

**Goal:** 把 wayfinder map #115 的四票决议（#122 权限三层 / #123 零信任沙箱 / #124 中断超时 / #162 askUser 平权）从决策落地为 iknow harness 的生产控制层。
**Architecture:** 两个新模块（`src/harness/permission/` 中间件链、`src/harness/sandbox/` bwrap 围栏策略）+ 原型层 `src/harness/aci/` 原地毕业修订（类型契约收紧 + executor 路由加固）+ CLI 三入口装配 askUser。冻结面不动：`tools/executor.ts`（ADR-0005）、Loop Engine StopReason 联合（016/017）——违规杀会话复用 `protocolError + reason` 编码。
**Tech Stack:** TypeScript ESM / vitest / bubblewrap（bwrap ≥ 0.11.1，运行时硬依赖）/ ajv（项目设置校验）/ smol-toml（新增，T6）。
**Spec link:** `specs/security-guardrails.md`（同目录；上游决议 = GitHub #115/#122/#123/#124/#162）
**Tracker:** GitHub（主路径；tickets 带 `ready-for-agent` label，blocking 走 GraphQL `addBlockedBy`）

## Section 2 — architecture-change-reviewer verdict（2026-08-04 re-gate，all yes）

```
bounded-context-guardian:    yes — permission/ + sandbox/ 新目录单职责并立于冻结 harness 旁；tools/executor.ts 不动；CLI 三入口装配独立；env 名从 env.ts SSOT 消费，无反向依赖。
defensive-contract-validator: yes — 空/危险命令/资源超限/并发 interrupt/异常（askUser 缺失）五类边界在 SC6/12/13/15/16/19 覆盖；tests/harness/{permission,sandbox,aci}/ 各 ≥1 文件钉死。
error-handling-enforcer:     yes — [network_denied] / [user_denied] / ask_inlet_missing 启动 throw 三型错误信封固化；OQ4 复用 protocolError + reason，不新增 StopReason（016/017 冻结契约不碰）。
complexity-anti-drift:       yes — ≤300 行/文件、≤30 行/函数、≤4 嵌套、≤3 参数（余走 options bag）、Object.freeze 工厂；bash.ts ≤200 行、permission-executor ≤120 行、sandbox 每 policy 单文件。
minimal-change-verifier:     yes — 6 tracer bullets（1 decision + 5 implementation），各 1 commit，依赖显式命名，无 logical task 合并。
```

## Section 3 — Tasks (ordered by dependency)

Each numbered item is one tracer bullet: vertical slice, one tag, one commit, binary acceptance.
分支约定：每 ticket 自当前 base（`worktree-security-guardrails-spec`）开 `<ticket-slug>` 分支，1 commit 后 PR 回合。

### T1. `[decision]` OQ 决议冻结确认（gate bullet）

- **Affects**: `specs/security-guardrails.md`（只读核对，无代码；若发现残留「plan 期定」失败路径则回 spec-driven-development Step 2）
- **Acceptance**: `grep -c "plan 期定" specs/security-guardrails.md` 仅出现在 OQ4 以外的非失败路径条目（OQ1/OQ2/OQ4 三条失败路径必须已带 typed envelope）；OQ1 `[network_denied]`、OQ2 `[user_denied]`+`ask_inlet_missing`、OQ4 `protocolError + reason` 三者 grep 命中 ≥ 1。
- Commit: 1 commit = 决议冻结记录（可并入 plan 提交；若无修订则本票以核对记录关闭）
- Status: [ ] pending

### T2. `[implementation]` [parallel] 权限三层毕业（#122）

- **Affects**:
  - 新增 `src/harness/permission/`：`types.ts` / `policy.ts`（三层规则 + 硬墙）/ `hooks.ts`（v0 no-op 骨架）/ `ask-user.ts` / `session-grants.ts`（in-memory）/ `permission-executor.ts`（五步中间件链装饰器，≤120 行）/ `index.ts`
  - 修订 `src/harness/aci/types.ts`：`PermissionDecision` 删 `pass_through` 改 `allow/deny/ask`；`AciMeta` 删 `isReadOnly`/`isDestructive`（#122 Q5 毕业删除）
  - 修订 `src/harness/aci/permission.ts` / `aci-executor.ts`：内部转调 `permission/`，deny 路径零副作用保持
  - 修订 `src/cli/chat-session.ts` / `runtime.ts` / `session-io.ts`：三入口装配各自 askUser（chat=TTY 交互；ask=oneshot fail-closed；serve=SPA 通道）；缺 askUser 启动即 throw
  - 新增 `tests/harness/permission/*.test.ts` + `.evals/tasks/010-permission-hardwall.yaml`
- **Acceptance**: `npm test` 绿，且新增测试覆盖：SC1（21/21 payload + 十类敏感路径最大宽松下全拒）/ SC2（6 工具分类默认）/ SC3（覆盖语义：会话授予 > 项目设置 > 代码内置；硬墙不可覆盖）/ SC4（hook no-op 调用位 + 前缀区分 + askUser 缺失 throw）/ SC5（deny 零副作用 + 来源前缀）；`npm run typecheck` 绿；既有 S 系测试零回归。eval：`bash .evals/run.sh` 含 010 通过。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- Commit: 1 commit
- Status: [ ] pending
- [blocks: T1]

### T3. `[implementation]` [parallel] 沙箱策略层（#123 Q1/Q2/Q3/Q5）

- **Affects**:
  - 新增 `src/harness/sandbox/`：`fs-policy.ts`（白名单 cwd+$HOME+tmpdir − 敏感清单 .ssh/.aws/.gnupg/.config-gh/.kube/.docker；/etc /usr /bin /lib 只读）/ `network-policy.ts`(默认 deny + github.com/registry.npmjs.org/pypi.org 静态白名单，`[network_denied]` 信封) / `resource-limits.ts`（CPU 30s / 内存 1GB / /tmp 1GB / 进程 256 / fd 1024）/ `env-isolation.ts`（env 白名单，密钥名自 `env.ts` SSOT + 兜底正则，禁硬编码字面量）/ `output-mask.ts`（密钥值集合自 env.ts，输出边界替换 `***`）/ `bwrap.ts`（argv 合成，seccomp 接口预留 v0 不启用）/ `index.ts`
  - 新增 `tests/harness/sandbox/*.test.ts` + `.evals/tasks/011-sandbox-policy.yaml`
- **Acceptance**: `npm test` 绿，且：env-isolation 测试断言白名单不含任何密钥 env（SSOT 取名，`grep -rn "NINE_ROUTER_KEY" src/harness/sandbox/` 零命中字面量）；output-mask 测试断言已知密钥值 → `***`（SC20）；fs-policy 测试断言敏感清单六目录永不进白名单；network-policy 测试断言非白名单 → `[network_denied]`；resource-limits 数值单测；`npm run typecheck` 绿。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- Commit: 1 commit
- Status: [ ] pending
- [blocks: T1]

### T4. `[implementation]` bash 围栏化 + 物理探针（#123 Q6/Q7，解锁 ADR-0004）

- **Affects**:
  - 修订 `src/harness/aci/tools/bash.ts`（≤200 行）：经 `sandbox/bwrap.ts` 装配执行；bwrap 缺失 fail-loud；超时/abort 保留已收集 stdout（partial output，≤12000 字符 code point 截断）
  - 修订 `src/harness/aci/tools/helpers.ts`：`spawnWithStopSignal` 对外暴露已收集 stdout（abort/timeout 时可取）
  - 新增 `scripts/sandbox-probe.ts`（Q7 矩阵物理层探针）+ `package.json` script `probe:sandbox`
  - 新增 `tests/harness/aci/bash-sandbox.test.ts` + `.evals/tasks/012-bash-fence-probe.yaml`（tier: slow）
- **Acceptance**: `npm run probe:sandbox` 实跑全绿（围栏内 env 仅剩白名单 / `~/.ssh` 空 / 写 `/etc` RO / 写 cwd 成功 / fetch 非白名单失败 / node 可运行）；bash partial-output 测试：真实 spawn + 小 timeoutMs → 结果含已收集 stdout 非裸 timeout（SC13 半边，超时档位由 T5 接通）；bash abort 杀进程树测试（SC14 bash 半边）；`npm test` + `npm run typecheck` 绿。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- Commit: 1 commit
- Status: [ ] pending
- [blocks: T3]

### T5. `[implementation]` 中断/超时运行时接通（#124）

- **Affects**:
  - 修订 `src/harness/aci/aci-executor.ts`：按 `interruptBehavior` 路由 caller abort（cancel=下传 handler；block=不下传，跑完再报 `cancelled`）；按 `timeoutTier` 映射四档 timeoutMs（fast 5s / default 30s / build 5min / long 30min）
  - 修订 `src/harness/aci/types.ts`：`AciMeta` 增 `timeoutTier`
  - 修订 `src/harness/aci/tools/*.ts`：归位 read_file/glob=fast；grep/edit_file/write_file=default；bash=build；long 档无默认工具
  - 新增 `tests/harness/aci/interrupt-routing.test.ts`（真实 spawn）+ `.evals/tasks/013-interrupt-timeout.yaml`
- **Acceptance**: `npm test` 绿，且：SC13（bash build 档超时带 partial output）/ SC14（caller abort：bash/grep/glob 子进程 SIGTERM→2s→SIGKILL，报 cancelled；glob abort 新测试）/ SC15（edit_file/write_file block 跑完再报 cancelled 新测试）/ SC16（超时/取消后主循环下一轮不挂死，S12–S15 保持绿）/ SC17（interruptBehavior 路由两分支单测）；`npm run typecheck` 绿。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- Commit: 1 commit
- Status: [ ] pending
- [blocks: T2, T4]

### T6. `[implementation]` 项目设置 + 违规处置 + 集成收口（#122 Q2 项目层 + #123 Q4）

- **Affects**:
  - 新增 `src/harness/permission/project-settings.ts`（`.iknow/permissions.toml` 加载 + ajv schema 构造期校验，不热加载）+ 仓库根 `.iknow/permissions.toml`（示例 + schema 注释）
  - 新增 `src/harness/sandbox/violation-handling.ts`：三档处置（低=拒+ask；中=拒+计数 N=3 可配升级杀会话；高=立刻杀）；ask 路径不计计数；单次误碰不杀；杀会话执行流复用 `spawnWithStopSignal` 进程组 kill + trace 记 `protocolError + reason`（OQ4 冻结形态）
  - `package.json` + lockfile：新增 `smol-toml`（已在假设门确认）
  - 修订 `src/cli/*`：kill-session 通知（chat 内展示违规详情）
  - 扩展 `scripts/sandbox-probe.ts`：Q7 违规终止行（3 次敏感命中杀会话 / 单次误碰继续）
  - 新增 `tests/harness/permission/project-settings.test.ts` / `tests/harness/sandbox/violation-handling.test.ts` + `.evals/tasks/014-violation-settings.yaml`
- **Acceptance**: `npm test` 绿，且：SC12（N=3 升级杀会话 + 通知；单次误碰会话继续；高档立刻杀；ask 不计计数）/ SC3 项目设置覆盖语义集成测试 / SC18（三入口装配同一管线，缺 askUser throw）/ SC19（`npm run probe:sandbox` Q7 矩阵全绿）；`npm run typecheck` 绿；`npm install` 后 lockfile 只增 smol-toml 一条。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- Commit: 1 commit
- Status: [ ] pending
- [blocks: T5]

## 依赖图

```
T1 (decision gate)
 ├── T2 权限三层 ─────┐   [T2 ∥ T3]
 └── T3 沙箱策略 ──┐  │
        │          │  │
        ▼          │  │
      T4 bash 围栏 │  │
        │          │  │
        ▼          ▼  ▼
      T5 中断/超时（blocks: T2, T4）
        │
        ▼
      T6 设置+违规+集成（blocks: T5）
```

并行面：T2 ∥ T3（文件集不相交：permission/+aci 类型 vs sandbox/ 新目录）。T4 起串行（aci-executor 与 bash.ts 相继承重，避免同文件竞争）。

## Cross-references

- architecture-change-reviewer verdict: 5×yes（Section 2，2026-08-04 re-gate；首轮 BLOCKED 的三项 unclear 已按修订要求钉死：OQ4 冻结 protocolError+reason / 复杂度预算成文 / OQ1/OQ2 typed envelopes）
- affected arthurpower skills: S1 bounded-context（新目录切片）/ S2 defensive-contract（每票 6 边界类）/ S3 error-handling（三型信封 + fail-loud）/ S5 complexity-anti-drift（预算段）/ S6 minimal-change（1 bullet = 1 commit）
- 上游决议: wayfinder #115 → #122 / #123 / #124 / #162；ADR-0004 / 0005 / 0006 / 0001
- parallelization surface: T2 ∥ T3；其余串行
- eval backstop: `.evals/tasks/010–014`，完成判据 = `bash .evals/run.sh` 5/5 通过（010/011/013 medium，012/014 slow）
