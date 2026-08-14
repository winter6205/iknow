# Plan: #120 会话持久化增强 + 跨入口共享池（server 侧）

> Spec: `specs/120-session-persistence.md`（ACR 5/5 PASS，2026-08-04）
> Origin: wayfinder:grilling #120（M3 会话持久化，6 问收口）
> Base branch: `worktree-spec-120-session-persistence`（commit 落在本分支，一 bullet 一 commit）
> Tracker: local markdown —— 仓库无既有 plan→issue 工作流；gh 可用，如操作员要求 GitHub issue 可后补（见 §Tracker）
> Eval baseline: `.evals/tasks/009-session-persistence.yaml`（`bash .evals/run.sh --task 009`）

---

## Section 1 — Context-Loop Pre-Check

- **docs/CONTEXT.md 已读**：`append-only messages`（内存权威历史，唯一事实来源）、`Session HTTP API / session-api`、`iknow serve`、`turnCount`、`in-flight closeout`。spec Glossary 原样引用，无新术语引入。
- **docs/adr/ 已读**：ADR-0001（9router 栈，不动 env/模型配置）、ADR-0003（TraceService，本 spec 不改 trace）、ADR-0004/0005/0006（工具层，正交）。
- **无 ADR 矛盾**：spec 声明的 ADR-0007 候选（M3 磁盘形态三合一）尚未落档。
  - ⚠️ **落档动作不在本 plan**：`docs/adr/` 写入权归 `domain-modeling`（三条件门槛），writing-plans 不代行决策落档。ADR-0007 内容已由 grilling 裁决齐备（spec L30-32），本 plan 仅消费其结论；落档作为后继项（见 §非目标与后继）。
- **spec Open Question 1 定位修正**：spec L115 称地图仍写 "append-only JSONL + resume"。Explorer 核查：`docs/CONTEXT.md` 内**无**该字面措辞；冲突源在外部 #114 wayfinder map（不在本仓库）。本 plan 不复述该措辞；ADR-0007 落档时由 domain-modeling 同步触发地图更新。
- **#114 Standing preferences 遵守**：SessionStore 类保留演进不重写；append-only 纪律不破（Q3 裁决把 CLI host 状态改为 ReadonlyArray + Object.freeze，与旧 slash.ts:24-28 注释里的旧裁决相冲 —— grilling #120 Q3 是后出裁决，实施时替换该注释）。
- **spec Boundaries Always 明示行**：`validateSessionFile` 的 schemaVersion 严格等值检查（现 `src/session-api/store/schema.ts:34`）必须放宽为范围检查 —— 已入 T2 验收。

## Section 2 — ACR 5-Verdict Block（引自 spec L120-128）

- bounded-context-guardian: **yes** — 改动限于 store/{schema,session-store}.ts、hub/serve.ts、cli/{slash,chat-session}.ts；无反向依赖 harness 内部；明确排除复活 host 多轮袋。
- defensive-contract-validator: **yes** — sanitize / extractSummary / resolveProjectSessionDir / Q6 集成全覆盖；并发写显式记为已知边界。
- error-handling-enforcer: **yes** — `schema_invalid` 结构化错误，不静默吞、不修复；load 零写盘副作用。
- complexity-anti-drift: **yes** — sanitize / extractSummary 顶层纯函数；复用 SessionHub 不发明第二保存路径。
- minimal-change-verifier: **yes** — 单一逻辑任务；out-of-scope 干净排除。

## Section 3 — Tracer Bullets（依赖序）

编译耦合拆分依据（explorer 实测）：

- schema.ts 是类型源头：SessionFileV1 字面量硬编码 `schemaVersion: 1` 于 hub.ts 3 处（createSession / resetSession / conditionalSave）+ 测试 fixture `sampleFile()` 2 处（session-store.test.ts / hub.test.ts）。类型收紧必须与所有构造点同 commit，否则 typecheck 红。
- SessionStore 构造器接 baseDir、内部 `join(baseDir, "sessions")`；serve.ts 默认 `<cwd>/data`；cli.ts runServe 不传 dataDir；parse-args 无 `--data-dir`；usage 无该行。默认根迁移 = 4 文件 + serve.test.ts 默认分支用例。
- Q6 集成只依赖 T2+T3 落地后的公共 API，与 T5（CLI readonly）零共享文件 —— `[parallel with T5]`。
- T4（CLI 状态 readonly 化）与 session-api 无编译依赖 —— 可与任何 bullet 并行，排在 T3 后仅因序读方便。

### T1. `[implementation]` schema v2 纯函数层：sanitizeSessionFile + extractSummary + validate 范围检查

- **Affects**: `src/session-api/store/schema.ts` · `src/session-api/store/index.ts`（新导出）· `tests/session-api/store/schema.test.ts`（扩展）
- **Acceptance**:
  - □ TDD 先行：`extractSummary` 失败测试覆盖 spec Testing Strategy 全部 case（首条含 text block 的 user 消息 / 跳过纯 tool_result user 消息 / 空 messages → "" / 80 字符截断 / strip 首尾空白 / 多 text block 取首个）；`sanitizeSessionFile` 失败测试覆盖（v1 补齐 summary+cwd("")+sanitized_at(=该文件 updatedAt) / schemaVersion ≤ 2 的未知字段原样保留 / messages 形状坏拒绝 / schemaVersion > CURRENT 拒绝 / root 非对象拒绝）
  - □ `CURRENT_SCHEMA_VERSION` = 2；`validateSessionFile` 的 schemaVersion 检查从等值改范围（≤ 2 接受，> 2 返回 "schemaVersion"）——spec Boundaries Always 点名行（schema.ts:34）
  - □ sanitize 顺序契约（reject-first）：schemaVersion > CURRENT 立即拒绝，不进入字段保留分支（spec Code Style）
  - □ sanitize 永不修复 messages（形状坏 = 拒绝加载，返回失败字段名）；load 无写盘副作用（本 bullet 纯函数，T2 接线）
  - □ `npm run typecheck` 退出码 0；`npx vitest run tests/session-api/store/schema.test.ts` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **实施要点**：约束来源 = spec Code Style（sanitize 纯函数签名、reject-first、Object.freeze 无关本层）+ Testing Strategy Unit 清单 + SC 3-7 的 schema 半区。v2 新字段 summary/cwd 设为 required，v1 输入由 sanitize 补齐 —— 构造点收紧放 T2，本 bullet 不动 hub（保持绿）。

### T2. `[implementation]` store 接线：load→sanitize 零写盘 + save 写 v2 + list() 加 summary

- **Affects**: `src/session-api/store/session-store.ts` · `src/session-api/hub.ts`（3 处构造点 + summary 重算）· `src/session-api/store/index.ts`（SessionListEntry 变更透传）· `tests/session-api/store/session-store.test.ts` · `tests/session-api/hub.test.ts` · `tests/session-api/http.test.ts`（list 端点条目断言扩展）
- **Acceptance**:
  - □ TDD 先行：store 层失败测试 —— v1 文件 load 成功且 summary 重算补齐 / cwd 补 "" / sanitized_at 补 updatedAt / **load 前后文件字节不变（零写盘断言）**；v2 文件 save→load 往返全等；schemaVersion 3 文件 load → `schema_invalid`（不崩）；messages 元素形状非法 → `schema_invalid`；损坏 JSON → `parse_failed` 不变
  - □ hub.ts createSession / resetSession / conditionalSave 写入 `schemaVersion: CURRENT_SCHEMA_VERSION` + 顶层 `cwd`（hub 进程 cwd）+ `summary`；**save 时 summary 从 messages 重算**（messages 是唯一权威，summary 是可再生投影 —— spec Boundaries Always）
  - □ `SessionListEntry` 增 `summary: string`（从文件顶层读；v1 经 sanitize 重算补齐）；`conversation_id / updatedAt / lastFinalText` 三字段保留（SC 12 非破坏）；`GET /api/v1/sessions` 条目含 summary 且既有字段不变（http.test.ts 断言）
  - □ list() 的 issue #96 跳过规则（无 assistant 文本则跳过）行为不变
  - □ 两处 `sampleFile()` fixture（session-store.test.ts / hub.test.ts）随类型收紧同步更新
  - □ `npm run typecheck` + `npm test` 全绿（含 6 种 SessionStoreError kind 契约表回归）
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **实施要点**：约束来源 = SC 3/5/6/7/12 + spec Project Structure（load/save/list 保留，不新增 store API）。hub 的 `summarize()`（SessionSummary wire DTO）**不动** —— 与 SessionListEntry 是两个类型（explorer 核实），SC 12 只作用于 list 端点。[blocks: T3, T6]

### T3. `[implementation]` 共享池根 + 项目命名空间 + serve/CLI 默认迁移

- **Affects**: `src/session-api/store/session-store.ts`（或 store 内新文件，`resolveProjectSessionDir` 纯函数）· `src/session-api/store/index.ts` · `src/session-api/serve.ts` · `src/cli.ts`（runServe 透传 dataDir）· `src/cli/parse-args.ts`（`--data-dir` flag + `ParsedCli.dataDir`）· `src/cli/usage.ts`（serve flag 行）· `tests/session-api/store/session-store.test.ts` · `tests/session-api/serve.test.ts` · `tests/cli-session.test.ts` 或新增 parse-args/serve 测试
- **Acceptance**:
  - □ TDD 先行：`resolveProjectSessionDir(base, cwd)` 产出 `<base>/sessions/<basename>-<sha1(cwd)[:12]>/`（digest 12 hex）；不同 cwd 不碰撞、同 cwd 稳定（纯函数断言，SC 1 布局）
  - □ `SessionStore` 默认池根 = `os.homedir() + "/.iknow"`；`serve --data-dir <dir>` 覆盖生效（parse-args 解析 + runServe 透传 + startSessionServe 消费全链）
  - □ serve.test.ts 原 "defaults to <cwd>/data" 用例改为 "defaults to ~/.iknow"（mkdtemp 内建目录断言或注入 homedir 的确定性断言，不污染真实 HOME）；旧 `<cwd>/data/sessions/` 不被读取 / 不迁移 / 不删除（SC 10 —— 路径不再指向它即满足）
  - □ usage.ts serve 段含 `--data-dir <dir>` 行；tests/cli-session.test.ts usage 断言不回归
  - □ `npm run typecheck` + `npm test` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **实施要点**：约束来源 = SC 1/2/10 + spec Tech Stack（node:crypto / node:os 内置，零新依赖）。homedir 默认值的测试确定性是实施者设计选择（注入 / chdir+mkdtemp 均可），验收只认"默认 = homedir/.iknow 可断言"。[parallel with T4]

### T4. `[implementation]` CLI 状态 readonly 化（Q3：ReadonlyArray + Object.freeze 两处赋值点）

- **Affects**: `src/cli/slash.ts` · `src/cli/chat-session.ts` · 对应测试（`tests/cli/process-chat-line-harness.test.ts` 等按需）
- **Acceptance**:
  - □ TDD 先行：`/reset` 后 `ctx.state.messages` 为冻结空数组的断言；run 后赋值为冻结数组的断言（`Object.isFrozen`）
  - □ `CliChatState.messages` 类型 = `ReadonlyArray<AnthropicNativeMessage>`；slash.ts:24-28 旧注释（解释为何用可变数组）替换为 Q3 裁决说明（grilling #120 Q3 全链路 ReadonlyArray + Object.freeze）
  - □ 两处赋值点均 `Object.freeze`：chat-session.ts run 后 `ctx.state.messages = Object.freeze([...result.messages])` + slash.ts `/reset` 的 `= Object.freeze([])`（spec SC 9 / Code Style 明示"空数组同样冻结"）
  - □ `npm run typecheck` 零错误（编译即证明无残留 push / 原地修改调用点）；`npm test` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **实施要点**：约束来源 = SC 9 + grilling #120 Q3 裁决。explorer 核实 tests/cli 无 messages 原地修改（仅索引读取），预计零回归；若 typecheck 暴露隐藏变异点，修复属本 bullet 范围。[parallel with T3]

### T5. `[implementation]` Q6 验收集成：双入口读写一致 + 续跑可见

- **Affects**: `tests/session-api/cross-entry-consistency.test.ts`（新文件）
- **Acceptance**:
  - □ tmpdir 池 + stub adapter（`makeDeps` / `assistantResult` from `tests/cli/_fixtures.ts`），两个独立 `SessionHub` 实例共享同一 `SessionStore`（模拟 serve / TUI 两进程）
  - □ hub A `createSession` + `postMessage` N 轮 → hub B `getSession`/`store.load` 断言 messages / conversation_id / turnCount / summary / cwd / schemaVersion / updatedAt / jsonMode 全等
  - □ hub B 续跑第 N+1 轮保存 → hub A 再读断言第 N+1 轮在（SC 8 = #120 Q6 唯一验收标准）
  - □ 跨实例并发写不在本测试范围（spec Open Question 3 = 已知边界，测试文件注释标明）
  - □ `npx vitest run tests/session-api/cross-entry-consistency.test.ts` 全绿；`npm test` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **实施要点**：约束来源 = SC 8 + spec Testing Strategy Integration。只写测试不改产品代码 —— 若此 bullet 暴露 T2/T3 缺口，回改属本 bullet commit 范围并在提交正文说明。

### T6. `[implementation]` eval baseline + CHANGELOG

- **Affects**: `.evals/tasks/009-session-persistence.yaml`（新）· `CHANGELOG.md`
- **Acceptance**:
  - □ `.evals/tasks/009-session-persistence.yaml` 存在且 `bash .evals/run.sh --task 009` 退出码 0（test_command 覆盖 store+hub+cross-entry 测试集）
  - □ CHANGELOG `0.1.0 (unreleased)` 区新增条目：共享池根迁移 + schema v2 + summary + Q3 readonly
  - □ `npm test` 全绿（CHANGELOG 不破坏任何测试）
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **实施要点**：约束来源 = writing-plans 闭环 backstop（`.evals/run.sh`）+ 项目 Completion 惯例。eval yaml 格式对齐 007-session-api.yaml（id / description / test_command / success: "pass"）。

---

## Dependency Graph

```
T1 (schema 纯函数)
 └─ T2 (store 接线 + hub 写 v2 + list summary) ─ [blocks: T3, T6]
     ├─ T3 (共享池根 + 命名空间 + serve/CLI) ─ [parallel with T4]
     │   └─ T5 (Q6 双入口集成)
     └─ T4 (CLI readonly) ─────────────────────┘
                                                  └─ T6 (eval + CHANGELOG)
```

执行序（串行主线 + 并行对）：T1 → T2 → {T3 ∥ T4} → T5 → T6。
并行对 T3/T4 由两个子代理同时实施（零共享文件，编译耦合 explorer 已核实）。

## 非目标与后继（不在本 plan）

- **ADR-0007 落档**：决策内容齐备（spec L30-32），写入权归 `domain-modeling`；本 plan 完成后建议单独走 domain-modeling（含 #114 map 措辞同步，spec Open Question 1/4）。
- **TUI spec 实施**（`specs/146-tui.md`）：blocked by 本 spec，另行起 plan；ink/react lockfile 授权仅属该 spec。
- **web 侧 `SessionListItem` 加 `summary`**：wire 新增字段对 web 非破坏（explorer 核实 web 只消费 `lastFinalText`）；SC 12 未要求 web 消费 summary，不扩 diff。
- **并发写文件锁 / 流式 / 会话删除交互 / chat 持久化**：spec Boundaries Never / Open Questions 明示排除。

## Verification Checklist（writing-plans 自检）

- [x] 6 tracer bullets，均编号（T1-T6），1 bullet = 1 commit
- [x] 每 bullet 1 组二进制验收标准（退出码 / 测试全绿 / 字段断言）
- [x] 依赖序排列 + `[parallel]` / `[blocks]` 标注
- [x] 每 bullet 带 `[decision]` 或 `[implementation]` 标签（全部 implementation；唯一决策 ADR-0007 落档归 domain-modeling，见 Section 1 与非目标）
- [x] 每 `[implementation]` bullet 嵌入 Per-ticket loop 行（ADR-0012）
- [x] Section 2 ACR 5-verdict（5/5 yes，OVERALL PASS）
- [x] Section 1 context-loop 预检（CONTEXT.md + docs/adr/ 已读，无矛盾静默覆盖）
- [x] 实施要点只写约束来源，不写代码片段
