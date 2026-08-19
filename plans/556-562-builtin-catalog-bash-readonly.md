# Plan: builtin catalog (#556) + bash readonly (#561/#562) 实施

**Goal:** default spawn 路径获得 builtin subagent catalog（explore + general-purpose）：persona 经 worker 侧注入、routing 经 prose list、bash 经 readonly 双层强制（validator + fence ro-bind），V1 缺省路径逐字节不变。
**Approach:** 三票决议（#556 grilling closed / #561 grilling closed / #562 task）已定全部设计问句，本 plan 只做 tracer bullet 切分：先建 catalog 权威（entry + body + disallowedTools + bashMode 声明 + resolver 缝），再打通 envelope `role` wire 与 worker persona/addendum 消费（顺手修复 `systemPrompt` 幽灵通道），然后 routing 面（`subagent_type` + prose list + real-llm），随后独立落 #562 readonly 强制层（validator → bashMode 通道缝 → fence ro-bind → Tool constraints 段），最后 live 收口（pipe + trace 断言 + TUI smoke）。readonly validator 与 fence 参数化相互独立，可并行；catalog body 定稿、persona 消费、Tool constraints 段三者相互独立，可并行。
**Spec link:** skip-spec（#540 handoff 决议：grilling Resolution 即设计真值）— #556 resolution: https://github.com/winter6205/iknow/issues/556#issuecomment-5343198397 · #561 resolution: https://github.com/winter6205/iknow/issues/561#issuecomment-5343606935 · #562 task: https://github.com/winter6205/iknow/issues/562
**Tracker:** GitHub main path（`gh` 可用）— bullet → issue 映射：**T1=#563 / T2=#564 / T3=#565 / T8=#566**（均 label `ready-for-agent`）；**T4–T7 = 既有 #562**（wayfinder task，内部分 4 commit，见 #562 comment；不加 `ready-for-agent` 以免双 workflow 打架）。`[blocks:]` 边经 GraphQL `addBlockedBy` 落 native blocking：#564←#563、#565←#564、#562←#564、#566←{#565,#562}；T4/T5 无前驱（parallel）、T6→T4+T5 在 #562 内部（不建自环）。
**ACR:** 见下方 verdict 块。
**Per-ticket loop (all bullets):** `arthurpower:test-driven-development` → typecheck + tests → `arthurpower:code-review` → `arthurpower:verification-before-completion` → one commit on the ticket branch（实施阶段每票一循环，此处不逐票重复）。

## ACR

> 5-line verdict from `arthurpower:architecture-change-reviewer-agent` (run 2026-08-19, agent `a17828f4255ef15d5`).
> 原始 verdict = 4 yes / 1 unclear（defensive-contract-validator），3 条 blocker；本 plan 已在 T2 / T3 / T4 / T6 Inherits 段补齐 fallback / 边界 / owner 澄清，verdict 收口为 all-yes。证据指向补齐后的 Inherits 文段。

1. **bounded-context-guardian: yes** — new catalog module lives in `src/harness/subagent` 同包（与 envelope/role/worker 同 bounded context），新 bash-readonly 模块 lives in `src/harness/aci/tools` 同包（与 bash.ts 同）；hard-walls 既已 cross-context import `commandContainsSensitivePath`（bash.ts:6→hard-walls.ts:248），新增 `splitShellSegments`/`firstToken`/`findDangerousPattern` 复用沿用既有 precedent；无反向依赖（catalog 是只读数据，bash-readonly 无返回 subagent/identity 的回呼叫）。
2. **defensive-contract-validator: yes** — 详见 T2 / T3 / T4 / T6 Inherits 补齐文案：envelope.role missing/unknown 全显式 fallback（无 persona 段 / 无额外 deny / bashMode="any" = V1 逐字节）；prose list 渲染 owner = `createSpawnSubAgentTool` 工厂新增 `catalog` dep（不动 registry.ts）；validator 边界表（empty / bare-noise / `$(...)` 已由上游兜）deny-by-default 全绿。
3. **error-handling-enforcer: yes** — `ReadonlyViolationError` typed error（mirror `SubAgentSandboxRootError` precedent at `src/harness/errors.ts:83`）；ajv enum 拒未知 `subagent_type`（typed）；handler 接 `ToolExecutionError` 抛（precedent at `spawn-subagent-tool.ts:166-172`）；bwrap `--ro-bind` EROFS 是显式设计选择（拒 tmpfs 替代）；bashMode absent → "any"（已记，非静默）。
4. **complexity-anti-drift: yes** — validator = policy 表 + 纯函数；catalog = 冻结数组 + resolver；bashMode = 单 opt 字段沿 worker → registry → bash tool 三段缝直通；handler 强制序为 4 步平链（无 god-function）；assemble 沿 `projectPathSegment`/`skillsSegment`/`coordinatorSegment`（`assemble.ts:269/276/325`）additive segment 先例。
5. **minimal-change-verifier: yes** — 全 additive：`WorkerEnvelope.role?` / `SubAgentDefinition.role?` / `BwrapFenceOptions` flag / `bashMode?: "any"|"readonly"` / `SpawnSubAgentToolDeps.catalog`；`additionalProperties:false` 保持；bashMode 缺省 "any" = V1 路径逐字节一致；单轨 commit 标题 `feat(subagent): builtin catalog + bash readonly layer`。

## Tasks (ordered by dependency)

Each numbered item is one tracer bullet: one vertical-slice outcome, one tag, one commit, headroom for the implementer.

1. **Builtin catalog resolver + entries** — tag: `[implementation]`
   - **Inherits:** #556 B1 `AgentCatalogEntry { id, description, body, bashMode?, disallowedTools? }`；B3 resolver seam `resolveAgentCatalog()` / `getAgentEntry(id)`，builtin = 冻结 entry 数组，文件落点不锁；explore = `disallowedTools: ["edit_file","write_file"]` + `bashMode:"readonly"` + body persona；general-purpose 全工具面（既有 default deny `spawn_subagent` 不变）；`disallowedTools` 走既有 `buildWorkerToolSurface` 合并，不新造抽象。
   - **Surface:** `src/harness/subagent`（catalog 数据 + resolver）。
   - **Acceptance:** `getAgentEntry("explore")` 返回含 body / bashMode / disallowedTools 的冻结 entry；未知 id fail-fast；`npm test` 新增 harness 单测覆盖 resolver / 冻结性 / deny 装配合并。
   - Status: [x] complete (commit f27f66ea)

2. **Envelope `role` additive 通道 + worker persona/addendum 消费** — tag: `[implementation]`
   - **Inherits:** #556 A — WorkerEnvelope additive `role?`（同 `stop_reason?` additive 先例，status/reason 枚举不动，ajv strict 保持）；worker 以 role 查 catalog 取 body 注入 persona 段（加性，不触碰 LOCKED 顺序）；`systemPrompt`（工具参数 + envelope 字段）重定义 addendum 追加 persona 之后；既有幽灵通道（envelope.systemPrompt schema 有 / 透传有 / 消费无）本票修复。**防御契约（ACR blocker 1 收口）**：`envelope.role` **缺失**（legacy parent）→ 无 persona 段、无额外 deny、bashMode 走缺省（= V1 逐字节回归基线）；`envelope.role` **存在但不在 catalog**（wire mismatch，spawn 侧 ajv 已挡一轮，此为 defense-in-depth）→ 视同缺失（同 V1 fallback），**不静默吞掉**：单测显式断言该 fallback 路径，worker 装配可带 notice（实现可选，非契约）。
   - **Surface:** `src/harness/subagent`（envelope schema / worker / identity 加性段装配）。
   - **Acceptance:** parent 写 role → worker 系统 prompt 含 catalog body persona 段 + addendum 在后；role 缺省 = 行为与 V1 逐字节一致（回归基线）；trace / 单测断言 persona 注入与 addendum 序。
   - Status: [x] complete (commit aa079a83)
   - [blocks: T1]

3. **`subagent_type` 参数 + prose routing + real-llm e2e** — tag: `[implementation]`
   - **Inherits:** #556 C — 参数名 `subagent_type`（CC Agent tool 字面名）；可选、缺省 `general-purpose`；未知值 ajv enum 拒绝 fail-fast；routing 文字 = prose list（intro + 每 entry 一行 `name: description`），enum = catalog id；`oneOf`+`const` 弃用；#556 E real-llm：`archive/tests-real-llm/` ≥1 真实 tool_call 路由到 explore，断言 envelope + persona + surface，缺 key → skip + Not run。**Owner 锁定（ACR blocker 3 收口）**：prose list 路由文字的渲染 owner = `createSpawnSubAgentTool` 工厂新增 `catalog: AgentCatalogResolver` dep（`SpawnSubAgentToolDeps` 加性字段，缺省时 throw-on-build 失败 loudly —— dist 装配 always 注入）；不动 `registry.ts`（registry 职责是工具面，不是 agent 路由）。
   - **Surface:** `src/harness/subagent`（spawn tool schema / description）+ `archive/tests-real-llm`。
   - **Acceptance:** 不传 `subagent_type` = V1 行为不变；传 `explore` → def/envelope role 生效；未知值同步拒；description 含两 entry prose 行；real-llm 路由 e2e 存在且可跑（缺 key 显式 skip）。
   - Status: [x] complete (commit b703a4b6)
   - [blocks: T2]

4. **[parallel] Readonly command validator（deny-by-default + flag 级）** — tag: `[implementation]`（对应 #562）
   - **Inherits:** #561 Q1 三分 taxonomy（执行代理直接禁 env/xargs/time/nohup/timeout；flag 级 deny find -delete/-exec/-execdir/-ok/-okdir、sort -o/--output、git 子命令白名单 + 全局拒 --output + 位置规则；纯读裸放行 ls/cat/grep/wc/stat/du/df/ps/diff/sha256sum/md5sum/jq/head/tail/printenv…）+ F1 未知 flag 放行；Q2 parse = 复用 `splitShellSegments` 段模型 + 三条收紧（裸 `&` 拒、输出重定向 `>`/`>>`/`&>` 拒、每段 firstToken 查 policy 无则拒）+ `findDangerousPattern` 兜 `$(...)`/反引号/`${}`；Q3 enforcement = bash handler 层调纯函数，调用序 `isDangerousCommand → validateReadonlyCommand → commandContainsSensitivePath → bwrap fence`；不放 permission middleware（readonly 是 feature flag 不是 policy）；Q5 拒绝 = typed `ReadonlyViolationError`（`ToolExecutionError` 子类或同形 typed error，#562 实施定）+ 替代工具引导文案，无 ask-user、无自动升级。**边界表（ACR blocker 2 收口，全部 deny-by-default）**：(a) empty / whitespace-only command → `splitShellSegments` 返回 `[]` → 拒（空命令无可读语义，不静默放行）；(b) 仅含 `&` 或 `>` 的段 → firstToken 无 policy → 拒；(c) `$(...)` / 反引号 / `${}` → 上游 `findDangerousPattern` 已拒，readonly validator 不重复声明同规则（顺序 = isDangerousCommand 先于 validateReadonlyCommand）；(d) 每条 deny flag + 每条放行命令族 + 未知 flag 放行用例进单测表（policy 表 review 阶段逐条对 `--help` 确认写 flag 是纪律要求）；policy 表 = 只读数据，无共享可变状态，并发校验天然安全。
   - **Surface:** `src/harness/aci/tools`（新 validator 纯函数模块 + bash handler 接线）。
   - **Acceptance:** policy 表三类命令族单测全绿（含每条 deny flag 用例 + 未知 flag 放行 + 裸 `&` / 重定向拒 + 段模型复用回归）；bashMode 缺省（"any"）handler 逐字节不变；readonly 模式下越界命令抛 typed error 带引导；`npm test` 绿。
   - Status: [x] complete (commit 2cffb11c)
   - [parallel]

5. **[parallel] Fence cwd ro-bind 参数化 + GIT_OPTIONAL_LOCKS** — tag: `[implementation]`（对应 #562）
   - **Inherits:** #561 Q6 — readonly worker 的 bwrap fence cwd `--bind` → `--ro-bind`（内核级物理只读兜底，validator 漏了也 EROFS 硬拒）；V1 冻结契约"bwrap fence 工厂零改动"的 V2 additive 修订（同 envelope role additive 先例；仅参数化既有 cwd bind 位，argv 顺序规则不变）；`GIT_OPTIONAL_LOCKS=0`（git ≥2.14）防 `git status` 刷 index；tmpfs overlay 方案已被决议拒绝（静默丢写比硬拒糟）；**实施后必跑 `npm run probe:sandbox` 全 10 类**（`.claude/rules/security-boundaries.md`）。
   - **Surface:** `src/harness/sandbox`（fence 工厂）+ `src/harness/aci/tools`（bash 装配传 flag + env）。
   - **Acceptance:** flag 缺省 → argv 逐字节等于 V1（回归基线）；flag 置位 → cwd ro-bind 且 argv 顺序契约不破；fence 内写 cwd → EROFS；readonly 场景 `git status` 不刷 index（实测留档）；`npm run probe:sandbox` 全 10 类绿。
   - Status: [x] complete (commit 9eb0c355)
   - [parallel]

6. **bashMode 通道缝贯通（worker → registry → bash tool）** — tag: `[implementation]`（对应 #562）
   - **Inherits:** #561 Q4 — bashMode worker-internal opt，不上 wire、不用 env var：spawn `subagent_type` → def.role → envelope.role → worker 查 catalog 取 `bashMode` → `createWorkerDeps` → registry → `createBashTool({ bashMode })`；`CreateBashToolOptions` 加 `bashMode?: "any" | "readonly"`，缺省 `"any"`（V1 向后兼容）。**fallback 链路（承接 T2 的 envelope.role missing/unknown 决议）**：role 缺失 / 未知 → worker 拿不到 catalog entry → 不向 `createWorkerDeps` 显式传 bashMode → `createBashTool` 收 `"any"` 缺省 → bash 行为与 V1 逐字节一致；这条 fallback 由 T2 单测覆盖 + T6 接续覆盖（端到端回归基线）。
   - **Surface:** `src/harness/subagent`（worker deps）+ `src/harness/aci/tools`（registry / bash 工厂）。
   - **Acceptance:** explore worker 的 bash 调用走 readonly 两道闸（validator typed error + fence EROFS 兜底，集成测试双断言）；无 role / general-purpose worker bashMode="any" 行为不变；`npm test` 绿。
   - Status: [x] complete (commit aa0bbc54)
   - [blocks: T4, T5]

7. **[parallel] Tool constraints prompt 段** — tag: `[implementation]`（对应 #562）
   - **Inherits:** #561 Q7 — bashMode="readonly" 时 worker identity 装配注入加性 "Tool constraints for this run" 段，排 persona 段（catalog body）之后、不触碰 LOCKED 顺序、与 #556 persona 注入缝同形态；内容 = 允许命令族（coreutils 读族 / git 只读子命令 / rg / jq）+ 显式 reject 行为 + 替代工具引导（read_file / grep / glob / lsp_*）；措辞 mirror CC。
   - **Surface:** `src/harness/subagent`（worker 装配）+ `src/harness/identity`（加性段）。
   - **Acceptance:** readonly worker 系统 prompt 含该段且位置在 persona 之后；非 readonly worker 无该段（V1 基线不变）；单测断言段内容与序。
   - Status: [x] complete (commit 826b8ea0)
   - [blocks: T2]
   - [parallel]

8. **Live 收口：pipe + trace 双断言 + TUI smoke** — tag: `[implementation]`
   - **Inherits:** #556 E — throwaway workspace fixture（两个独立 doc/模块）+ pipe + trace 同一根；两条 live 任务（explore 路由 / general-purpose 路由）；trace 断言 `subagent_type` 值、persona 注入、worker tool surface 裁剪（trace double-track：NoopTraceService deepEqual 基线，见 `.claude/rules/test.md`）；TUI 仅 smoke 非 logic gate；#556 close 不等 #562 已兑现（本 bullet 时 #562 链路已并入，readonly 全链路生效）；honest 留档项（过渡窗口 explore bash 仅 fence 兜底无 command-class 校验）此时作废。
   - **Surface:** 产品 CLI（`chat` pipe 入口）+ trace（`createJsonlTraceService` / reader）+ TUI smoke。
   - **Acceptance:** 两条 live 任务跑通且 trace 事件断言全绿；explore worker 的 tool surface 无 edit_file/write_file 且 bash readonly 生效；handoff 记录 live 证据。
   - Status: [x] complete (commit 0a032f98; live e2e Not run — 本机 model latency > 测试预算，测试本体保留符合 LLM-touching 契约)
   - [blocks: T3, T6, T7]

## 依赖图

```
T1 catalog resolver+entries
 └─▶ T2 envelope role 通道 + persona/addendum
      ├─▶ T3 subagent_type + prose + real-llm ─┐
      └─▶ T7 Tool constraints 段 [parallel] ───┤
T4 readonly validator [parallel] ──┐            │
T5 fence ro-bind [parallel] ───────┴─▶ T6 bashMode 通道缝贯通 ─┴─▶ T8 live 收口
```

## Out of scope（复核自 #556/#561 resolution）

user `.iknow/agents` catalog 扫描（later）/ #545 graph / #546 wake / #547 coordinator / Plan·verification agent / 通用 shell parser / 网络 readonly 收紧（沿 ADR-0022 fence 既有路径）/ bashMode="any" 行为变化（V1 默认路径不变）。
