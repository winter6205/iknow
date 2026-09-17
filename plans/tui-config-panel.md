# Plan: TUI `/config` 设置面板（ADR-0096）

**Goal:** TUI 无参 `/config` 打开与 `/model` 同族的浮层面板，首版三行（FS 隔离档 / worktree 门禁 / 子代理并发上限）选行改值、Esc 落盘用户层 settings；有参 `/config …` 行为不变。

**Approach:** 三行设置中只有 FS 档已有全链路（`FsModeContext` holder + `mergeFsModePatch` 持久化），cap 与 worktree 都还是启动期一次性读取（无 holder、无 setter）。因此按「面板先立、行逐个变活」切三枚 tracer bullet：T1 立面板骨架并激活唯一现成的 FS 行；T2 补 cap 的运行期 seam（holder + unlimited + 动态 description）；T3 补 worktree 门禁的运行期 seam。每行变活都是端到端可演示的独立行为，面板 UI 交付与引擎能力解耦——这是 ACR `minimal-change-verifier: no` 的裁决消化方式（见下 ACR block 与 Resolution）。

**Spec link:** `docs/adr/0096-config-panel.md`（proposed，形状 SSOT）；`docs/CONTEXT.md:335`（config 面板词条）；issue #977（票面范围，注意其三行清单含 `worktreeExclusive`，ADR-0096 首版未收——占用锁归「后续只加行」）。

**ACR:**（architecture-change-reviewer，2026-09-16）

```
bounded-context-guardian: yes — picker family + persist-settings.ts are established modules; new patches and new config-panel.tsx leaf fit without reverse deps.
input-contract-tests: unclear — plan does not list the 5 boundary classes; unlimited semantics + live-cap setter have no specified tests.
error-handling-enforcer: unclear — persist failure path uses existing describeError notice pattern (good); but live-cap setter and live worktree-flip failure paths are un-specified.
complexity-anti-drift: yes (conditional) — plan must explicitly extract to src/tui/config-panel.tsx leaf; existing ratchet comments show the pattern; inline in app.tsx would breach S5.
minimal-change-verifier: no — the plan conflates UI delivery (picker) with new engine capabilities (live hot-reload of cap, live flip of worktree gate, dynamic tool description); per ADR-0096 amendments these are non-trivial new behavior, should be separate tasks; without sequencing, this is scope-creep in one PR.
```

**Resolution（planner 消化）：** `no` 与 2×`unclear` 通过计划结构解决，不返工架构——(a) UI 交付与引擎能力分 bullet 序列化（T1 无新引擎行为；T2/T3 各自独立引入且钉死失败契约）；(b) 5 类边界与失败契约钉进下方 Contract section，T2/T3 的 Acceptance 直接引用；(c) 面板强制独立 leaf 模块（ACR 模块结构裁决，不内联进 4000+ 行的 app.tsx）。

**Contract（输入 / 错误契约，全 bullet 适用）：**

- 值域闭集：FS 行 `global|workspace`、worktree 行 `ON|OFF`、cap 行 `3|5|9|15|unlimited`。面板键入路径只产闭集值，非法态不可达；persist 层仍以 TypeError 拒非法值（对齐 `mergeFsModePatch` 既有纪律），防未来调用方绕过面板。
- persist 失败：fire-and-forget + `describeError` notice（`runConfigSlashCommand` app.tsx:676 既有形态）。禁止 `err instanceof Error ? err.message : String(err)`（typed-error catch 契约，code-quality.md）。
- 5 类边界（各 persist merge 函数与面板落盘路径的测试面）：empty/bad-JSON 读盘 → notice 不写；负值/非正 cap → TypeError；overflow（超大数）→ 值域守卫拒；并发双写（两面板 Esc）→ 原子写（同目录 tmp + rename）后写胜；写盘异常（rename 中途失败）→ catch → notice，holder 值不回滚（运行期已生效，文件态以下次读盘为准）。
- 行账：面板行数经 `configPickerRows` 进 `chromeReserveRows({ pickerRows })`，与 thinking/memory picker 同账（guard：tests/tui/chrome-budget.test.ts）。

**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion（landing grain: operator global commit section）

## Tasks (ordered by dependency)

1. **面板骨架 + FS 隔离档行变活** — tag: `[implementation]`
   - **Inherits:** ADR-0096：「无参 `/config` 打开与 `/model` 同族的浮层面板（↑↓ 选行、Enter 改值、Esc 保存退出并落盘用户层 settings）」「有参 `/config …` 仍留给 chat/serve 与脚本，语义与面板同一 holder + 同一持久化」；SC13：「运行期经 holder 就地翻转，权限模式控件不被本开关替换（正交）」。ACR 模块裁决：面板为 `src/tui` 新 leaf 模块（镜像 model-picker 的 reducer/组件/行账三件套），不内联进 app.tsx。
   - **Surface:** `src/tui`（新 leaf `config-panel.tsx` + app.tsx 的 slash case 与互斥接线）+ `src/config/persist-settings.ts`（复用既有 `mergeFsModePatch` / `persistFsModeChanges`，本票不加新 merge）。
   - **Acceptance:** 无参 `/config` 打开三行面板（cap、worktree 两行本票只显示现值，不可改）；FS 行 Enter 翻转、Esc 落盘后 `~/.iknow/settings.json` 的 `isolation.fsMode` 变化，且下一次 bash 调用即按新档生效（复用既有 holder，无新引擎行为）；重开面板 seed 自当前 holder 值；面板打开时其余 picker 互斥关闭；`chromeReserveRows` 行账正确（面板不挤 transcript、无文本重叠，guard：tests/tui/chrome-budget.test.ts 既有断言形态）；有参 `/config fs …` 与 chat 端 `/config` 行为不变（guard：tests/config/fs-mode.test.ts 既有断言不回归）。
   - Status: [x] done（T1/T2/T3 全部落地 + code-review 修复轮，2026-09-17）

2. **子代理并发上限行变活：holder + unlimited + 动态 description** — tag: `[implementation]`
   - **Inherits:** ADR-0096：「上限可在运行中经同一 manager 顶调整；图节点仍计入同一顶；`unlimited` 视为该顶不拒绝」「description 里的 N 与错误回执必须同一数字」「Why not 写进 system 前缀——闸是 manager 硬顶；模型侧靠 description 插值 + 超限 `SubAgentCapacityError` 回执」；ADR-0077（图节点同顶）。**Resolved**（T2 实施期决议，2026-09-17）：面板显示 **effective 值**（holder 初值走 `currentEnv.subagent.maxConcurrentWorkers`，env > settings > 默认 15 链与 manager 闸同源）；不发「env 覆盖 settings」notice；会话内 Enter 翻转写 user 层，env 优先级更高时下次 env reload 仍由 env 胜（与 /model 显示语义同向）。
   - **Surface:** `src/harness/subagent/manager.ts`（构造期闭包捕获 → capacity holder，`spawn()` 读当前值；`unlimited` 分支）+ `src/harness/subagent/spawn-subagent-tool.ts`（description N 从静态常量改动态插值）+ `src/config/persist-settings.ts`（新增 cap merge/persist 对，仅用户层，ADR-0084 纪律）+ `src/tui/config-panel.tsx`（cap 行激活）。
   - **Acceptance:** 面板改 cap 为 3 → 会话内第 4 张并发 spawn 得 typed 回执含 `active/max=3`，description 同帧反映 3（guard：tests/subagent/manager.test.ts 的 `SubAgentCapacityError` 路径扩展）；`unlimited` → manager 不做并发拒绝（OS 仍兜底）；改 15 默认档、图节点 spawn 计入同一顶（guard：tests/harness/graph/run-graph-executor.test.ts 既有同顶断言不回归）；cap 补丁仅写 user 层且 5 类边界齐（guard：tests/config/persist-settings.test.ts 既有形态扩展）；值域闭集非法值在 persist 层 TypeError。
   - Status: [x] done（T1/T2/T3 全部落地 + code-review 修复轮，2026-09-17）
   - [blocks: T1]

3. **worktree 门禁行变活：isolation holder + gate 改造** — tag: `[implementation]`
   - **Inherits:** ADR-0096 Amends ADR-0037：「`worktreeOnMutate` 可在会话内由面板翻转并落盘，不改变门禁从不 auto-provision」；ADR-0037 §1：「ON 拦未绑树的写、OFF 主仓可写」「bash `git worktree add` 仍不是 rebind」「本开关属用户层 settings」。
   - **Surface:** `src/harness/isolation/worktree-gate.ts` + `src/harness/build-engine.ts`（`resolveWorktreeOnMutate` 启动单读点 → holder，装配期初值注入）+ `src/config/persist-settings.ts`（新增 boolean merge/persist 对，仅用户层；浅拷贝 `isolation` 段不丢邻键——对齐 `mergeFsModePatch` 形态）+ `src/tui/config-panel.tsx`（worktree 行激活）。
   - **Acceptance:** 面板翻转 ON → 未绑树 mutate 被拦且**不**自动建树；OFF → 主仓可写；翻转对下一次 tool call 生效、无 auto-provision 副作用（guard：worktree gate 既有测试扩展）；落盘仅 user 层 `isolation.worktreeOnMutate`，`isolation.fsMode` 等邻键不丢（round-trip 断言）；新会话从 settings 恢复上轮值。
   - Status: [x] done（T1/T2/T3 全部落地 + code-review 修复轮，2026-09-17）
   - [blocks: T1, T2]

**Code review phase:** 三枚 bullet 全落地后走一轮 `arthurpower:code-review`（`GATE: BLOCKED` → 下一槽 `review-report-repair`），再 `arthurpower:verification-before-completion` 收尾；TUI 面属实测面，T1 起每票以 `mcp__aiterm__pty_*` 起真实 TUI 注键读屏取证据（操作 + 屏上结果写入票）。

## 待写入（persist 清单，实现落地后走 domain-modeling，不在 slicing 期写）

- `docs/CONTEXT.md`「worktree isolation mode」词条（:558）：删「只在启动加载点读取一次」，改为「启动读取一次为初值；会话内可经 config 面板翻转并落盘（ADR-0096 amends ADR-0037）」。T3 落地后写。
- `docs/STATUS.md` §1.2 交互表面表：补 config 面板行（三行 + 有参保留）。全部落地后写。
- `docs/adr/0096-config-panel.md`：Status `proposed` → `accepted`。T1 落地（形状开始兑现）时写。
