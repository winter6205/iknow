# Plan: bash-service-loop（Bash 服务启动 + 测试闭环）

**Goal:** 让 iknow 的 Bash 工具能完成「起长驻服务 → 验证 → 停服务」闭环：background 执行 + 日志回读 + 终止句柄 + 网络可见性 opt-in。

**Architecture:** 双轨独立推进。Track A（background 基建，map #440 票 [#502](https://github.com/winter6205/iknow/issues/502)）：新增 `src/harness/background/` 子系统（模式复用 `subagent/manager.ts` SC12，不发明新概念）——bash 加 `background` 参数立即返回 task_id，registry 落 `<workspaceRoot>/.iknow/tasks/`，配套 `bash_output` / `bash_stop` 两件工具进 ACI 装配。Track B（network opt-in，票 [#503](https://github.com/winter6205/iknow/issues/503)）：bwrap argv 分支（`network: true` 去掉 `--unshare-net`，其余 fence 全保留）+ permission 强制 ask（full_auto 不豁免）。两轨各以 ADR 前置（`arthurpower:domain-modeling` 三条件闸门）。

**Tech Stack:** Node.js / TypeScript / bwrap 沙箱 / vitest（stub-vitest 主矩阵 + `scripts/sandbox-probe.ts` 物理探针）

**Spec link:** none — 来源是 grilling 决议（[#491](https://github.com/winter6205/iknow/issues/491) Resolution + post-close 修订 comment，gh-22 skip path：resolution 已含 Problem / Solution / Implementation Decisions / Testing Decisions / Out of Scope 五段）

**不硬编码声明（operator 显式指令）：** 治理数值（并发上限、日志默认/上限字节、task_id 格式、stale 日志保留期）、permission 规则命名、probe 新类别编号——全部由 ADR 决议或实施 ticket 定稿，本计划只引用「#491 resolution D 段约定值」「ADR 定稿值」，不写死字面量。conversation lifecycle v2（createdAt/archivedAt schema、archive、session events、busy/idle、SSE 接缝）**不在本计划范围**——已单独发 grilling issue（见 Cross-references），其中 delete→reap 接缝在本计划 T6 只预留订阅点，不实现生命周期本体。

## Tasks (ordered by dependency)

Each numbered item is one tracer bullet: vertical slice, one tag, one commit, binary acceptance.

### Track A — background 基建（#502）

1. **T1 ADR: background task lifecycle** — affects: `docs/adr/0020-background-task-lifecycle.md`（编号以实际下一个为准）
   - `[decision]` 决议：生命周期单锚 = iknow 进程（退出前 reap + `--die-with-parent`）；registry 落盘形状（owner_pid + conversationId 记账）；启动 stale 清扫只动 owner 已死记录；task_id 格式；并发上限与日志截断治理值（引 #491 D6）。
   - Acceptance: `ls docs/adr/ | grep -i background` 非空，且 ADR 含 Status accepted + 三条件论证；#502 comment 附 ADR 链接。
   - Commit: 1 commit = this 1 task
   - Status: [ ] pending

2. **T2 BackgroundTaskManager + registry 落盘** — affects: `src/harness/background/manager.ts`（新）、`src/harness/background/registry.ts`（新）、`src/harness/background/paths.ts`（新，workspace-root 派生）、`tests/harness/background/manager.test.ts`（新）
   - `[implementation]` spawn（bwrap 内，detached 进程组）+ 内存 Map + `<workspaceRoot>/.iknow/tasks/<task_id>.{json,log}` 落盘 + 日志流式追加（stderr 合并）+ 状态机（running/exited/killed）。
   - Acceptance: `npx vitest run tests/harness/background/` exit 0，含用例：spawn→registry 读回一致 / json+log 落盘 / typed-error 五边界类（空 task_id / 未知 task_id / 并发重复 / kill 竞态 / 落盘 IO 失败）。
   - Per-ticket loop: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
   - Commit: 1 commit = this 1 task
   - [blocks: T1]
   - Status: [ ] pending

3. **T3 bash `background` 参数 e2e（tracer bullet）** — affects: `src/harness/aci/tools/bash.ts`、`src/harness/sandbox/runner.ts`（不阻塞 spawn 分支）、`tests/harness/aci/bash-background.test.ts`（新）
   - `[implementation]` bash schema 加 `background?: boolean`；命中时 handler 经 manager spawn 后立即 return `{task_id, log_path}`，不阻塞、不占 tier timer；前台路径零回归。
   - Acceptance: `npx vitest run tests/harness/aci/bash-background.test.ts` exit 0，含真实进程 e2e：起一个长驻子进程（如 `sleep`/简易 http server）→ handler 立即返回 task_id → 进程在 5 分钟 tier 超时后仍存活（前台对照调用则按既有 tier 语义超时）。
   - Per-ticket loop: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
   - Commit: 1 commit = this 1 task
   - [blocks: T2]
   - Status: [ ] pending

4. **T4 `bash_output` / `bash_stop` 工具 + 装配 28→30** — affects: `src/harness/aci/tools/bash-output.ts`（新）、`src/harness/aci/tools/bash-stop.ts`（新）、`src/harness/aci/tools/registry.ts`（ACI_TOOLSET_NAMES 4 处同步）、`tests/harness/aci/bash-output-stop.test.ts`（新）、装配一致性测试
   - `[implementation]` `bash_output(task_id, max_bytes?)` read-only 免 ask 回日志尾部 + `{status, exitCode}`；`bash_stop(task_id)` host 侧 kill 进程组（SIGTERM→SIGKILL 升级复用 `runner.ts` stopTree 模式）；条件化装配 + 装配层 SSOT 锁 4 处同步（#440 standing preference）。
   - Acceptance: `npx vitest run tests/harness/aci/bash-output-stop.test.ts` exit 0 + 全条件装配测试绿（30 件一致）；日志尾部截断用例（超上限只回尾部，截断值引 ADR 定稿）。
   - Per-ticket loop: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
   - Commit: 1 commit = this 1 task
   - [blocks: T3]
   - Status: [ ] pending

5. **[parallel] T5 conversation 可见性 scope + 并发上限治理** — affects: `src/harness/background/manager.ts`、`src/harness/aci/tools/bash-output.ts` / `bash-stop.ts`（handler ctx filter）、`tests/harness/background/scope.test.ts`（新）
   - `[implementation]` harness 注入 ctx.conversationId 过滤（仅入参 filter，无新生命周期事件）；越界 → typed-error `task_not_in_scope` 携带 owner_conversation_id；并发上限正面措辞拒绝（值引 #491 D6）。
   - Acceptance: `npx vitest run tests/harness/background/scope.test.ts` exit 0，含用例：跨 conversation 读/停被拒且错误体带属主 id / 上限达到后第 N+1 次 spawn 被正面拒绝 / fresh conversationId 端到端走读（test.md 命令 handler 契约）。
   - Per-ticket loop: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
   - Commit: 1 commit = this 1 task
   - [blocks: T4]
   - Status: [ ] pending

6. **[parallel] T6 进程级收尾 + 启动清扫 + reap 接缝** — affects: `src/harness/background/manager.ts`（shutdown/reap）、`src/cli/runtime.ts`（registerShutdown 接线）、`src/harness/background/stale-reap.ts`（新）、`tests/harness/background/lifecycle.test.ts`（新）
   - `[implementation]` 退出前 reap（mirror subagent SC12）；启动扫 tasks/ 只动 owner_pid 已死记录（杀进程组 + 标 dead + 日志卫生，pgid 复用用 `/proc` starttime 校验加固）；**reap 接缝**：manager 暴露 `onConversationDeleted(conversationId)` 订阅点（conversation lifecycle v2 的 delete 事件未来挂这里——本票只留缝不实现生命周期本体，见不硬编码声明）。
   - Acceptance: `npx vitest run tests/harness/background/lifecycle.test.ts` exit 0，含用例：shutdown 后无存活子进程组 / host 被 SIGKILL 后重启清扫回收孤儿 + json 标 dead / owner 存活的记录被跳过（多进程不误杀）/ 清扫幂等（连跑两次第二次零动作）。
   - Per-ticket loop: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
   - Commit: 1 commit = this 1 task
   - [blocks: T2]
   - Status: [ ] pending

7. **[parallel] T7 描述纪律 + description guard 扩面** — affects: `src/harness/aci/tools/bash.ts`（description 正面引导）、`bash-output.ts` / `bash-stop.ts`（description）、`tests/harness/aci/d9-description-guard.test.ts`（扩到 30 件）
   - `[implementation]` 纪律写 tool description（#440 D9 先例）：bash 描述加「服务/长驻进程设 background，bash_output 读日志，bash_stop 终止」正面触发条件；无负面禁令；guard NEGATIVE_PHRASES 全条件扩面。
   - Acceptance: `npx vitest run tests/harness/aci/d9-description-guard.test.ts` exit 0（30 件全条件装配 × blocklist 零命中）。
   - Per-ticket loop: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
   - Commit: 1 commit = this 1 task
   - [blocks: T4]
   - Status: [ ] pending

### Track B — network opt-in（#503，与 Track A 并行）

8. **T8 ADR: network opt-in（tool input → fence 形状新轴）** — affects: `docs/adr/0021-bash-network-opt-in.md`（编号以实际下一个为准）
   - `[decision]` 决议：`network: true` per-call opt-in 去掉 `--unshare-net`（其余 fence 全保留）；permission 强制 ask、full_auto 不豁免（fence 形状变化与动作批准是不同批准轴）；不做白名单端口映射/域名过滤（诚实声明整调用放行，理由引 #491 D4）；secret 警告与 egress 审计 fog 边界。
   - Acceptance: `ls docs/adr/ | grep -i network` 非空，ADR 含三条件论证；#503 comment 附 ADR 链接。
   - Commit: 1 commit = this 1 task
   - [parallel with Track A]
   - Status: [ ] pending

9. **T9 bwrap argv 分支（network:true）** — affects: `src/harness/sandbox/bwrap.ts`、`tests/harness/sandbox/bwrap.test.ts`、`tests/harness/aci/bash-sandbox.test.ts`、`scripts/sandbox-probe.ts`（新探针类别）
   - `[implementation]` argv 形状分支：`network: true` 去掉 `--unshare-net`；fence 顺序纪律（`.claude/rules/security-boundaries.md`「Sandbox argv」段）保持；默认路径零回归（全部既有 `--unshare-net` 断言保持绿）；sandbox-probe 新类别物理验证（host-net 分支内 curl 可达 / 默认分支不可达），probe 6+2 类别全绿 + 新类别。
   - Acceptance: `npm run probe:sandbox` 全绿（含新类别）且 `npx vitest run tests/harness/sandbox/ tests/harness/aci/bash-sandbox.test.ts` exit 0。
   - Per-ticket loop: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
   - Commit: 1 commit = this 1 task
   - [blocks: T8]
   - Status: [ ] pending

10. **T10 permission 强制 ask + ask hint** — affects: `src/harness/permission/policy.ts`（input-aware 规则，照 `code-allow-todo-write-list` 先例）、`src/harness/aci/tools/bash.ts`（schema `network?: boolean` + handler 双查）、`src/tui/ask-user.ts` + `src/harness/permission/ask-user.ts`（`PendingAskView` 字段）、`tests/harness/permission/policy.test.ts`
    - `[implementation]` `network === true` → 强制 ask（full_auto 不豁免）；ask hint 带「请求宿主网络」+ 命令摘要；命令含 `<<<SECRET_N>>>` 占位符时追加 secret 警告；TUI/serve 两侧视图字段。
    - Acceptance: `npx vitest run tests/harness/permission/` exit 0，含用例：network:true 在 default/full_auto 两模式下均触发 ask（full_auto 不豁免显式 assert）/ 无 network 参数走既有路径零变化 / 占位符命令 hint 含 secret 警告。
    - Per-ticket loop: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
    - Commit: 1 commit = this 1 task
    - [blocks: T9]
    - Status: [ ] pending

11. **T11 闭环集成：起服务 → 验证 → 停** — affects: `tests/harness/aci/bash-service-loop.e2e.test.ts`（新）、`tests/harness/sandbox/secrets-no-leak.test.ts`（network 分支补例）、`tests/harness/sandbox/violation-handling.test.ts`（新拒绝分类补例）
    - `[implementation]` 真实进程 e2e：`bash({command: 起 http server, background: true, network: true})` → 经 ask 批准 → `bash_output` 读到 listening → host 侧 client 真实连上并收到响应 → `bash_stop` → 端口释放（再连失败）。两轨能力在此汇合。
    - Acceptance: `npx vitest run tests/harness/aci/bash-service-loop.e2e.test.ts` exit 0，覆盖完整闭环 + 端口释放断言；`npm test` 全量绿（既有围栏零回归）。
    - Per-ticket loop: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
    - Commit: 1 commit = this 1 task
    - [blocks: T5, T6, T10]
    - Status: [ ] pending

## Cross-references

- **来源决议**: [#491](https://github.com/winter6205/iknow/issues/491) Resolution（D1-D6）+ post-close 修订（conversation 可见性恢复）；实施母票 [#502](https://github.com/winter6205/iknow/issues/502)（Track A）∥ [#503](https://github.com/winter6205/iknow/issues/503)（Track B），均为 [wayfinder map #440](https://github.com/winter6205/iknow/issues/440) 子票。
- **architecture-change-reviewer verdict**: PASS（2026-08-18，5/5 yes）——bounded-context: yes（`src/harness/background/` 单向切片无反向依赖无环）/ defensive-contract: yes（T2 五边界类 + T5 overflow + T4 数据溢出 + T6 跨进程异常）/ error-handling: yes（typed-error catch 契约 + `task_not_in_scope` 带 owner id）/ complexity-anti-drift: yes（模块内 manager/registry/paths/stale-reap 分文件，无 god-file 意图）/ minimal-change: yes（1 bullet = 1 commit，lifecycle 声明范围外仅留 T6 订阅缝）。
- **affected S1-S6 skills**: S1 bounded-context（新 `src/harness/background/` 模块 = 新能力切片，单向依赖 sandbox/aci）、S2 defensive-contract（registry/manager 公开接口五边界类测试）、S5 anti-drift（新模块复杂度阈值）、S6 minimal-change（1 bullet = 1 commit）。
- **parallelization surface**: Track B（T8-T11）与 Track A（T1-T7）全程并行；Track A 内部 T5/T6/T7 在各自前置后可并行；唯一汇合点 T11。
- **context-loop 注记**: CONTEXT.md「ACI tool set」词条仍为历史口径（8 件），本计划按 #440 Decisions-so-far 现状口径（28→30）执行；词条更新属 `arthurpower:domain-modeling` 职责，不在本计划内。ADR-0004（bash 安全边界 = OS 沙箱）/ ADR-0019（workspace root 落盘）构成本计划的约束输入，无矛盾。脚注：计划成稿时基线口径 25，实施时 #440 已 graduate todo_write + mcp 两件，基线实际 28（explorer 交叉验证），故 T4 / T7 数字按 28→30 / 30 件口径生效，与 `src/harness/aci/tools/registry.ts` 注释及 `tests/harness/aci/tools/d9-description-guard.test.ts` 30 件装配一致。
- **范围外（单独 issue 跟踪）**: conversation lifecycle v2（schema createdAt/archivedAt、archive、session events emitter、busy/idle 运行时、SSE 接缝、DB 升级信号清单）——见 tracker 上的独立 grilling issue；本计划 T6 仅预留 reap 订阅缝。
- **closed-loop backstop**: `.evals/tasks/` 下 bash-service-loop 相关 eval task，`bash .evals/run.sh` 全绿 = plan 实施完成。
