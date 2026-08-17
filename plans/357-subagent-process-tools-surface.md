# Plan: 357 — 子进程工具面（sandboxRoot 收窄 + 判官 allow-list + output-mask + 4 类探针）

**Goal:** 补全子代理子进程工具面的四个真实缺口：sandboxRoot 收窄入口（manager 单点校验）、判官工具面从硬编码 deny 改为 allow-list fail-closed 推导、bash output-mask 补 #406 roundtrip 缺口、4 类子代理越权探针。

**Architecture:** 四项改动各自单点收口——校验放 `buildWorkerPayload`（所有 spawn 必经）；allow-list 推导放 `run-classifier-adapter.ts`（名单内容来源换成 registry 全量面反推）；output-mask 接在 `createBashTool` 工厂内（主+子共用一次生效）；探针独立脚本走真实 spawn。fence 工厂（bwrap/fs-policy/network-policy/resource-limits）零改动。

**Tech Stack:** TypeScript + Node（ESM，tsc strict）。无新依赖。

**Spec link:** `specs/357-subagent-process-tools-surface.md`（ACR Round 1 5/5 PASS）

**前置依赖:** 无。与 `plans/358-subagent-runtime-observability.md` 互不依赖，可并行；operator 定序先 357 后 358。

**Tracker:** GitHub（label `ready-for-agent`，native blocking via addBlockedBy；票创建留待 operator 放行——沿用 #468 先例）。创建命令与 blocking 边见文末。

---

## Architecture Change Reviewer verdict

引自 spec（Round 1 PASS，2026-08-18）：

```
bounded-context-guardian: yes — 所有改动落在各自归属模块内（spawn-subagent-tool/manager/errors/bash/
  run-classifier-adapter），sandboxRoot chain 在 worker.ts → registry.ts → bash.ts → bwrap.ts 已实证通；
  envelope.ts 不改（sandboxRoot 必填已存在）。
defensive-contract-validator: yes — Testing Strategy 表覆盖正常/失败/边界/权限/空非法输入/并发 6 类；
  输出遮罩分支 secretRegistry 在场/缺席双测；4 类探针 = fs 敏感/fs 写/etc/net 越权各 1 条。
error-handling-enforcer: yes — 新增 typed error SubAgentSandboxRootError（仿 SubAgentCapacityError 带
  context 字段）；拒绝路径 = 同步抛 typed，不走裸 Error。
complexity-anti-drift: yes — sandboxRoot 校验 = realpath+relative 单点线性；allow-list 推导 = 全量面减
  常量；bash mask 接入 = 三元 + handler 返回前过 mask；4 类探针 = 既有数组结构。
minimal-change-verifier: yes — 范围 = #357 单父图下 4 项子任务，全部围绕 sub-process tool surface 同一
  概念层；不碰 mcp/memory/tui/lsp/permission/harness-loop，不重构既有模块。
```

ACR 补充观察（已消化进 bullets）：① allow-list 推导的跨模块导入方向 verify → aci/tools/registry（新边无循环）；② realpath 用 async（对齐 helpers.ts 惯例），buildWorkerPayload 当前同步——异步化方式由实施定；③ 缺省行为变更（process.cwd() → 父 sandboxRoot）须显式断言锁定；④ 探针 npm script 名锁定 `probe:sandbox:subagent`。

---

## Tracer bullets

> Per-ticket loop（ADR-0012）强制：每个 `[implementation]` bullet 的 `Per-ticket loop` 行不可省略。
> 编号约定：bullet 在本文件内编号 T1–T4；tracker 票名带 `#357` 前缀防撞名。
> 实施自由度：Implementation notes 是指向性线索，不是硬编码指令——文件内具体行号、变量名、测试组织方式由实施 ticket 自定；验收标准（Acceptance）才是契约。

### T1. `[implementation]` sandboxRoot 收窄入口（schema 字段 + manager 单点校验 + typed error）

- **Affects**: `src/harness/subagent/spawn-subagent-tool.ts`（inputSchema 加可选字段 + handler 透传 def）；`src/harness/subagent/manager.ts`（`buildWorkerPayload` 单点 prefix-of-parent 校验，realpath 防符号链接逃逸）；`src/harness/errors.ts`（+ `SubAgentSandboxRootError` typed，带 context）；`tests/subagent/`（校验六类用例）。
- **Acceptance**:
  1. spec SC1：`grep -n "sandboxRoot" src/harness/subagent/spawn-subagent-tool.ts` 命中 schema 定义 + handler 透传。
  2. spec SC2：越界 / 符号链接逃逸 → typed error 拒绝、不 spawn（`npx vitest run tests/subagent` 越界用例绿）。
  3. spec SC8：缺省路径断言 envelope.sandboxRoot === 父 sandboxRoot（不是 process.cwd()）——行为变更显式锁定。
  4. spec SC7 局部：`git diff --stat -- src/harness/sandbox/` 为空（fence 零改动）。
  5. `npm run typecheck` → exit 0。
- **Implementation notes**（非验收命令，实施可调整）:
  - 校验单点 = 所有 spawn 路径必经（模型工具 + 判官 + 将来角色），不放工具 handler 层（spec Code Style 理由段）。
  - `buildWorkerPayload` 当前同步，realpath 需 async（ACR 观察 2）——校验前置 await 或 spawn 内异步化，实施方式自定，约束 = 校验失败不 spawn。
  - typed error 仿 `SubAgentCapacityError` 形态（命名 + readonly name + context 字段）；错误消息面向模型（文案属 spec「Ask first」面，实施给初版即可）。
  - 边界承诺：收窄 = 锁落脚目录 + 防提权，不承诺 home 级数据隔离（spec Objective 1）。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T2. `[implementation]` 判官 allow-list 推导（硬编码 deny → fail-closed 白名单）

- **Affects**: `src/harness/verify/run-classifier-adapter.ts`（JUDGE_ROLE disallowedTools 改为白名单推导）；判官工具面断言测试（落点随既有测试目录结构，实施定）。
- **Acceptance**:
  1. spec SC3：判官装配后工具面 = 白名单基线（双面断言：inner + visibleSchemas），白名单外缺席。
  2. 白名单常量冻结（`Object.freeze`）且为显式声明——grep 命中常量定义。
  3. 既有 verify 相关测试不退化（对应 tests 目录 vitest run exit 0）。
  4. `npm run typecheck` → exit 0。
- **Implementation notes**:
  - deny = ACI 全量工具面 − 白名单（从 registry catalog 反推，ACR 观察 1）；导入方向 `run-classifier-adapter.ts` → `../aci/tools/registry.js`（新边，ACR 验证无循环——命名真值单一来源语义）。
  - fail-closed：ACI 扩件时判官默认拿不到新工具；加白名单 = 显式改常量 + operator 拍板，不接受运行时配置（spec Objective 2）。
  - 白名单为空时判官零工具仍可跑（纯文本路径，spec Testing Strategy 边界行）。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T3. `[implementation]` bash output-mask 接入（#406 roundtrip 输出遮罩补漏） `[parallel]`

- **Affects**: `src/harness/aci/tools/bash.ts`（createBashTool 接 createOutputMask）；`tests/harness/aci/tools/`（mask 用例）。
- **Acceptance**:
  1. spec SC4：bash 输出含密钥值时经 mask 不含原值——secretRegistry 在场分支绿。
  2. 缺席分支：secretRegistry undefined → 不 mask、不 crash。
  3. bash 返回形状不变（`{code, stdout, stderr}` Y1b 契约，只洗内容不改形）。
  4. `npx vitest run tests/harness/aci/tools` → exit 0；`npm run typecheck` → exit 0。
- **Implementation notes**:
  - 缝已就位：`createBashTool` opts 已有 `secretRegistry`（restore 路径已消费），本 bullet 只补输出侧。
  - mask 取值形态对齐既有消费者（cli/stream-draft.ts 的 `createOutputMask(currentSecretValues(...))` 模式，每次现取不模块级缓存）。
  - 职责分层：遮罩在 tool 内部，截断在 executor（契约 X 不碰，ADR-0004/0006）。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T4. `[implementation]` 4 类子代理场景探针 `[blocks: T1]`

- **Affects**: `scripts/sandbox-probe-subagent.ts`（新文件）；`package.json`（+ `probe:sandbox:subagent` script，ACR 观察 4 锁定名）。
- **Acceptance**:
  1. spec SC5：`npx tsx scripts/sandbox-probe-subagent.ts` exit 0——4 类越权（fs 敏感 / fs 写 /etc / net 越权 / tmp 越限）全拦 + worker 正常 completed 收尾。
  2. spec SC6：`npm run probe:sandbox` exit 0（既有 8 类主代理探针不回归）。
- **Implementation notes**:
  - 走真实 spawn（同 `scripts/sandbox-probe.ts` 形态与数组结构），不 mock bwrap。
  - 断言形态按 D5 修正：bash tool_result 或 trace 含 bwrap 违规信息 + worker completed——不扩 envelope reason 枚举（Q4 契约）。
  - 依赖 T1：探针在 sandboxRoot 收窄生效后的装配上跑，顺带覆盖缺省继承路径。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

---

## Cross-references

### SC ↔ T 覆盖矩阵

| SC  | 验收句（摘要）                                         | 主覆盖                                         |
| --- | ------------------------------------------------------ | ---------------------------------------------- |
| SC1 | 收窄入口存在（schema + handler 透传）                  | T1 acceptance 1                                |
| SC2 | 越界拒绝（typed error，不 spawn）                      | T1 acceptance 2                                |
| SC3 | 判官 allow-list（双面断言）                            | T2 acceptance 1                                |
| SC4 | output-mask 接入（主+子同工厂）                        | T3 acceptance 1-2                              |
| SC5 | 4 类探针全绿                                           | T4 acceptance 1                                |
| SC6 | 既有 8 类不回归                                        | T4 acceptance 2                                |
| SC7 | fence 零改动                                           | T1 acceptance 4（T2/T3 天然不碰，T4 只读消费） |
| SC8 | 缺省行为变更锁定（父 sandboxRoot，不是 process.cwd()） | T1 acceptance 3                                |

### 并行面

- T1 / T2 / T3 互不依赖，`[parallel]`——三者触碰文件集不相交（manager+errors+spawn-tool / run-classifier-adapter / bash.ts）。
- T4 `[blocks: T1]`：探针需在收窄装配上跑；与 T2/T3 无依赖。
- 跨 plan：与 #358 全部 bullets 无依赖，可整 plan 并行（operator 定序先 357 是执行顺序偏好，非技术依赖）。

### 路径速查

- spec: `specs/357-subagent-process-tools-surface.md`
- 校验单点: `src/harness/subagent/manager.ts`（`buildWorkerPayload`，现状 sandboxRoot fallback 在 process.cwd()）
- 裁剪机制（不改，只换名单来源）: `src/harness/aci/tools/registry.ts`（def-list 期，ADR-0016）
- 判官声明源: `src/harness/verify/run-classifier-adapter.ts`（JUDGE_ROLE 硬编码 deny）
- bash 工厂: `src/harness/aci/tools/bash.ts`（secretRegistry 缝已存在）
- mask 真值: `src/harness/sandbox/output-mask.ts` + `env-isolation.ts`（currentSecretValues）
- 探针参照: `scripts/sandbox-probe.ts`（8 类形态模板）

### 验证（plan done 三项）

1. `grep -E "^### T[0-9]+\." plans/357-subagent-process-tools-surface.md` → 4 条 tracer bullet 编号齐全
2. 实施后 `git log --oneline` → 4 commits（每个 T 对应一次 commit，1 commit = 1 logical task）
3. `git diff --stat` 每 commit 改动 scope 与 bullet 的 Affects 行匹配（`src/harness/sandbox/` 四件 fence 文件全程零 diff）

---

## Tracker commands（票创建留待 operator 放行）

```bash
gh issue create --label 'ready-for-agent' --title "[#357] T1 sandboxRoot 收窄入口（schema + manager 单点校验 + typed error）" --body-file <ticket-t1.md>
gh issue create --label 'ready-for-agent' --title "[#357] T2 判官 allow-list 推导（fail-closed 白名单）" --body-file <ticket-t2.md>
gh issue create --label 'ready-for-agent' --title "[#357] T3 bash output-mask 接入（#406 输出遮罩补漏）" --body-file <ticket-t3.md>
gh issue create --label 'ready-for-agent' --title "[#357] T4 4 类子代理场景探针" --body-file <ticket-t4.md>
# blocking 边（T4 blocked by T1）：addBlockedBy GraphQL mutation，mechanics 见 writing-plans references/tracker.md
```

票 body = 对应 bullet 全文 + spec link + per-ticket loop 行。
