# Spec: 357 — 子进程工具面（sandboxRoot 收窄 + 判官 allow-list + output-mask + 4 类探针）

> 来源：#357 [SPEC] 子代理能力 V1 · SPEC-2 子进程工具面。父图 #331（已 cleared 2026-08-10）；源决议 #332（T2 沙箱装配）+ #334（T4 verifier 角色）。
> 假设闸门：operator 于 2026-08-18 grilling 逐条定案 D1–D5、D10、D11 + A/B/C/D 假设清单（spec-driven-development Step 1 confirmed）。
> 调研修正：第一轮审计「worker.ts 零 import sandbox → 子代理 bash 未走 bwrap」为**误报**——worker 内 bash 与主代理共用同一份 `createBashTool` 工厂，fence 六件装配完整（深化调研实证 `registry.ts:248` → `bash.ts:46-92`）。真实缺口收窄为本 spec 四项。

## Glossary（exact copy from docs/CONTEXT.md）

- **ACI tool set**: Harness 装配层（`src/harness/aci/`）注册的工具集；当前 8 件：`bash` / `read_file` / `grep` / `glob` / `edit_file` / `write_file` / `web_fetch` / `web_search`，SSOT 工厂 = `src/harness/aci/tools/registry.ts:createDefaultAciRegistry`，所有入口（`build-engine` / `tui/deps`）从这里取，工具数永不同步漂移（#141 / #191 / a277f68）。每次工具调用经 permission middleware（ADR-0004）与 timeout tier 装饰。
  _Avoid_: 在 harness 之外另起 tool 注册表；在 entry point 手写工具数组（#228 决议 D4——`memory_recall` / `memory_save` 入 SSOT 8+2=10）；让工具返回结构化 metadata。
- **声明工具面 vs 实际工具面**: `SubAgentDefinition.disallowedTools` 写进 `WorkerEnvelope` 的是声明面；worker 进程装配后真正可被模型调用的工具集是实际面，二者必须相等——裁剪发生在 `createAciRegistry(tools)` **之前**的 def-list 期（`createDefaultAciRegistry` 工厂内），由构造期快照保证，不事后修补（`AciRegistry.inner` 是冻结快照）。
  _Avoid_: 给 `AciRegistry` 加 `.tools` 字段在产物上事后裁剪；声明 deny-list 但 worker 不消费（#468 修复对象）。
- **判官（judge）**: command 缺失时接管「任务完成了吗」判定的子代理 LLM 分类器；工具面只读（deny `bash / edit_file / write_file / web_fetch / web_search`，由 def-list 期裁剪保证声明面 = 实际面）；#449 重构后为证据感知、四态输出（pass / fail / unverified / abort）。
  _Avoid_: 给判官执行能力（G1 决议只读）；与 evidence-checker（确定性纯函数规则引擎，零 LLM）混同。
- **前景 spawn / 后景 spawn**: `spawn_subagent` 的两种结果契约（#361 裁决，ADR-0014）——前景（`wait:true`，默认）= handler 同步等 worker 到终态、envelope 直接作 tool_result 返回，当回合闭环；后景（`wait:false`，显式选项）= 立即返回 task_id，结果经 host 唤醒/drain 通道回传。worker 恒为独立进程，与前景/后景正交。
  _Avoid_: 把前景/后景与进程隔离混同；泛化的"同步/异步"；把 V1"立即返回 task_id"当默认契约（已被反转）。
- **secret-roundtrip mask（#406）**（Flagged ambiguities 条）: 用户文本中的密钥形态被识别层替换为 `<<<SECRET_N>>>` 占位符；bash 工具 spawn 前 `restore()` 回填真值；输出 mask 经 `currentSecretValues(registry.values())` 兜底遮蔽。`settings.secrets.mode` 控制 `roundtrip`（默认）| `block`。
- **executor truncation authority**（契约 X）: executor 是工具结果截断元数据的唯一权威；工具返回纯数据、不带 truncated/total 元字段。#140 裁决，ADR-0004 / ADR-0006。
- **plain-string tool output**: 原生产工具输出为纯字符串；bash 例外保留 `{code, stdout, stderr}`（Y1b）。#140 裁决，ADR-0004。

## Architectural Constraints（ADR 引用）

- **ADR-0016**（ACI deny-list def-time trim）：工具裁剪时机锁在 def-list 期（`createAciRegistry` 之前），不给 `AciRegistry` 加 `.tools` 字段。本 spec 只改名单**内容的来源**（hard-coded → allow-list 推导），不改裁剪时机。
- **ADR-0014**（subagent foreground spawn default）：worker 恒为独立进程、前景 `wait:true` 默认契约不动；`spawn_subagent` schema 加字段不改变前景/后景语义。
- **ADR-0004 / ADR-0006**：bash 输出遮罩是 #406 roundtrip 闭环的一环（secret guard），不碰 executor 截断权威（遮罩在 tool 内部、截断在 executor，两层职责不混）。

## Objective

补全子代理子进程工具面的四个真实缺口（调研修正后）：

1. **sandboxRoot 收窄入口**：`spawn_subagent` schema 加 `sandboxRoot?` 字段，模型可声明「子代理只在某子目录干活」；manager `buildWorkerPayload` 单点校验 prefix-of-parent（realpath 防符号链接逃逸），违反 typed error 拒绝。**边界承诺（operator 确认）**：收窄 = 锁落脚目录 + 防任意路径提权，**不承诺 home 级数据隔离**（fsPolicy 本就允许 home，与主代理同）。
2. **判官 allow-list 推导**：`JUDGE_ROLE` 的 5 件硬编码 deny 改为 allow-list 白名单推导——工具面 = 本地纯只读白名单（基线 `read_file` / `grep` / `glob`），白名单外一律禁（fail-closed）。ACI 工具集扩件时判官默认拿不到新工具，除非显式加白名单（operator 拍板节奏）。
3. **output-mask 补漏**：`createBashTool` 接 `createOutputMask`——bash stdout/stderr 在成为 tool_result 前过遮罩，补 #406 roundtrip「输出遮罩」环缺失（主代理与子代理共用同一工厂，一次修复双生效）。
4. **4 类子代理场景探针**：`scripts/sandbox-probe-subagent.ts`——spawn 真实子代理喂 4 条越权命令（fs 敏感 / fs 写 /etc / net 越权 / tmp 越限），断言 bwrap 拦得住且 worker 正常收尾。

用户：主代理（收窄表达）+ verify 闭环（判官只读可信）+ 全体 bash 消费者（密钥不外泄）。成功 = 四项 Success Criteria 全绿 + 12 类探针全绿。

## Tech Stack

不变：TypeScript + Node（ESM，tsc strict）。无新依赖。全部复用既有模块：`src/harness/sandbox/`（fence / output-mask）、`src/harness/aci/tools/registry.ts`（def-list 期裁剪既有机制）、`src/harness/subagent/`（manager / role / envelope）。

## Commands

```bash
npm run typecheck                        # tsc -p tsconfig.json --noEmit
npm test                                 # vitest：unit + harness + integration
npx vitest run tests/subagent            # 本模块定向
npm run lint
npm run probe:sandbox                    # 既有 8 类主代理探针（回归）
npx tsx scripts/sandbox-probe-subagent.ts  # 新增 4 类子代理探针
```

## Project Structure

```
src/harness/subagent/spawn-subagent-tool.ts  # inputSchema 加 sandboxRoot?: string；handler 透传 def
src/harness/subagent/manager.ts              # buildWorkerPayload 单点校验：prefix-of-parent（realpath）
                                             # + typed error（SubAgentSandboxRootError）拒绝，不 spawn
src/harness/errors.ts                        # + SubAgentSandboxRootError（typed，带 context）
src/harness/verify/run-classifier-adapter.ts # JUDGE_ROLE：disallowedTools 硬编码 → allow-list 推导
                                             # （白名单基线 read_file/grep/glob，从 registry 全量面反推 deny）
src/harness/aci/tools/bash.ts                # createBashTool 接 createOutputMask（secretRegistry 在场时）
scripts/sandbox-probe-subagent.ts            # 新增：4 类子代理场景探针（独立于 sandbox-probe.ts）
package.json                                 # + probe:sandbox:subagent script
tests/subagent/                              # + sandboxRoot 校验用例 / allow-list 推导用例
tests/harness/aci/tools/                     # + bash output-mask 用例（主+子同工厂断言）
```

不改：`envelope.ts` wire schema（sandboxRoot 已是必填字段，无 diff）；`bwrap.ts` / `fs-policy.ts` / `network-policy.ts` / `resource-limits.ts`（fence 工厂零改动，D1 定案不建 override 通道）；`worker.ts` 装配链路（sandboxRoot 消费链路已通，调研实证 envelope → createWorkerDeps → registry → bash.ts → bwrap --chdir）。

## Code Style

沿用既有风格（显式类型、纯函数优先、typed-error 判别联合、注释只解释 why）。

```ts
// manager.ts — buildWorkerPayload 内 sandboxRoot 校验（单点，所有 spawn 必经）
// realpath 用 async（对齐 helpers.ts:1 既有惯例）；buildWorkerPayload 当前同步调用，
// 校验前置于 opts.spawn 前 await（或 spawn 内异步化）——plans 阶段落实
const resolvedParent = await realpath(parentSandboxRoot);
if (def.sandboxRoot !== undefined) {
  const resolvedChild = await realpath(resolve(def.sandboxRoot));
  const rel = relative(resolvedParent, resolvedChild);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new SubAgentSandboxRootError({
      parentSandboxRoot,
      requested: def.sandboxRoot,
    });
  }
  return { ...base, sandboxRoot: resolvedChild };
}
return { ...base, sandboxRoot: resolvedParent }; // 缺省 = 父 sandboxRoot（不是 process.cwd()）

// run-classifier-adapter.ts — allow-list 推导（fail-closed）
const JUDGE_ALLOWED_TOOLS: ReadonlyArray<string> = Object.freeze([
  "read_file",
  "grep",
  "glob",
]);
// disallowedTools = 全量 ACI 工具面 − JUDGE_ALLOWED_TOOLS（装配期从 registry catalog 反推）
// 加白名单 = 显式改 JUDGE_ALLOWED_TOOLS 常量 + operator 拍板，不接受运行时配置

// bash.ts — output-mask 接入（secretRegistry 在场时，与 cli/hub 消费同款形态）
const mask =
  secretRegistry !== undefined
    ? createOutputMask(currentSecretValues(secretRegistry.values()))
    : undefined;
// handler 返回前：stdout/stderr 过 mask（Y1b 的 {code, stdout, stderr} 形态不变，只洗内容）
```

**为什么校验放 manager 而不是工具 handler**：`buildWorkerPayload` 是所有 spawn 路径（模型工具 + 判官 + 将来角色）的必经单点，一次收口全生效；handler 层校验则只覆盖模型路径。

**为什么 allow-list 而不是 deny-by-category**：判官语义 = 「只许本地纯只读」，`aci.category="write"` 只覆盖 edit_file/write_file 两件，`bash`（execute）与 `web_*`（联网读）还需另写规则；allow-list 与语义精确对齐，且 fail-closed（新工具默认拿不到）。

## Testing Strategy

vitest，落 `tests/subagent/` + `tests/harness/aci/tools/`。覆盖测试规范六类：

| 层          | 内容                                                                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 正常        | sandboxRoot 合法子路径 → 通过校验、envelope 捎带 resolved 值；判官装配后工具面 = 白名单三件                                                    |
| 失败        | sandboxRoot 越界（`/etc`、父目录之外）→ SubAgentSandboxRootError，不 spawn；符号链接指向父外 → realpath 解析后拒绝                             |
| 边界        | sandboxRoot = 父 sandboxRoot（相等，合法）；sandboxRoot 缺省 → 继承父 sandboxRoot（不是 process.cwd()）；白名单空 → 判官零工具仍可跑（纯文本） |
| 权限        | 判官实际面不含白名单外任何工具（inner + visibleSchemas 双面断言）；4 类探针越权全拦                                                            |
| 空/非法输入 | sandboxRoot 相对路径 → resolve 后校验；含 `..` 的路径 → 拒绝                                                                                   |
| 并发        | N/A（校验是 spawn 期同步单点；判官装配是进程启动期一次性）                                                                                     |

output-mask：单测断言含密钥值的 bash 输出经 mask 后不含原值（`secretRegistry` 在场/缺席两分支——缺席时不 mask、不 crash）。

探针：`scripts/sandbox-probe-subagent.ts` 走真实 spawn（同 `sandbox-probe.ts` 形态），4 类断言 = bash tool_result 或 trace 含 bwrap 违规信息 + worker 最终 `completed`（不扩 envelope reason 枚举）。

## Boundaries

- **Always do**：校验用 realpath（防符号链接逃逸）；拒绝走 typed error（不裸抛 Error）；判官白名单变更须 operator 显式拍板；探针跑在真实 spawn 上（不 mock bwrap）。
- **Ask first**：判官白名单加新工具（基线只有 read_file/grep/glob）；sandboxRoot 校验错误消息文案改动（面向模型的拒绝理由）。
- **Never do**：建 fence override 通道（D1 定案不做）；扩 envelope reason 枚举（Q4 顶层契约不扩）；改 bwrap argv 拼装顺序（security-boundaries 固化契约）；为探针删改既有 8 类主代理探针；把收窄承诺扩大到 home 级数据隔离。

## Success Criteria（binary，每条映射可执行检查）

1. **收窄入口存在**：`spawn_subagent` inputSchema 含 `sandboxRoot` 字段且透传 def。**Check**: `grep -n "sandboxRoot" src/harness/subagent/spawn-subagent-tool.ts` 命中 schema 定义 + handler 透传。✅/❌
2. **越界拒绝**：sandboxRoot 越界 / 符号链接逃逸 → typed error 拒绝、不 spawn。**Check**: `npx vitest run tests/subagent` 越界用例全绿。✅/❌
3. **判官 allow-list**：JUDGE_ROLE 工具面 = `{read_file, grep, glob}`，白名单外双面（inner + visibleSchemas）缺席。**Check**: 判官工具面测试断言。✅/❌
4. **output-mask 接入**：bash 输出含密钥值时经 mask 不含原值（主+子同工厂）。**Check**: `npx vitest run tests/harness/aci/tools` mask 用例绿。✅/❌
5. **4 类探针全绿**：`npx tsx scripts/sandbox-probe-subagent.ts` exit 0，4 类越权全拦 + worker completed 收尾。**Check**: 命令 exit 0。✅/❌
6. **既有 8 类不回归**：`npm run probe:sandbox` exit 0。**Check**: 命令 exit 0。✅/❌
7. **fence 零改动**：`src/harness/sandbox/bwrap.ts` / `fs-policy.ts` / `network-policy.ts` / `resource-limits.ts` 无 diff。**Check**: `git diff --stat -- src/harness/sandbox/` 为空。✅/❌
8. **缺省行为变更锁定**：sandboxRoot 缺省时 worker 收到**父 sandboxRoot**（不是 process.cwd()）——相对 manager.ts:341 现状的行为变更，显式断言防回归。**Check**: 缺省路径测试断言 envelope.sandboxRoot === 父 sandboxRoot。✅/❌

## Open Questions

无阻塞项。判官白名单将来扩件（如 `memory_recall`）走 Boundaries「Ask first」通道，不阻塞本 spec。

## Assumptions（operator confirmed 2026-08-18）

1. **D1 不建 fence override 通道**：fence 全复用主代理默认（选项 C）。来源：operator 定案 + 「从最简起步，只在可度量失败出现时才加复杂度」。
2. **D2 sandboxRoot 收窄 = schema 加字段 + manager 单点校验**（选项 1，不做 worker 端双层）；边界 = 锁落脚目录 + 防提权，不承诺 home 级隔离。来源：operator 定案 + 边界确认。
3. **D3 判官 allow-list 推导**（选项 3）：白名单基线 read_file/grep/glob，fail-closed，加白名单须显式拍板。来源：operator 定案。
4. **D4 output-mask 顺手修**（选项 1）：#406 roundtrip 输出遮罩缺口在 createBashTool 内补，主+子一次生效。来源：operator 定案。
5. **D5 4 类探针断言修正**（选项 1）：断言 = bash tool_result/trace 含 bwrap 违规 + worker completed，不扩 envelope reason 枚举（SPEC-2 原文的 `{status:"failed", reason:"fsDenied"}` 断言与实现不符，修正）。来源：operator 定案 + 调研实证。
6. **D10 限流不做，记 ADR 候选**：429 backoff / 跨进程 quota 协调本轮不做。来源：operator 定案。
7. **D11 worker secretRegistry 后置**：worker 内密钥还原记 #406 跟进票，本 spec 不做（output-mask 遮罩与 roundtrip 还原是两件事，遮罩本票做、还原后置）。来源：operator 定案。

→ 无静默假设。

## ACR Verdict（architecture-change-reviewer）

**Round 1（2026-08-18）**: `5/5 yes` → **OVERALL: PASS → hand to writing-plans**。

```
bounded-context-guardian: yes — 所有改动落在各自归属模块内（spawn-subagent-tool/manager/errors/bash/run-classifier-adapter），sandboxRoot chain 在 worker.ts:337 → registry.ts:248 → bash.ts:84 → bwrap.ts:150 已实证通；envelope.ts 不改（sandboxRoot 必填已存在 envelope.ts:35,80）。
defensive-contract-validator: yes — Testing Strategy 表覆盖正常/失败/边界/权限/空非法输入/并发 6 类；输出遮罩分支 secretRegistry 在场/缺席双测；4 类探针 = fs 敏感/fs 写/etc/net 越权各 1 条；overflow 类对路径/枚举域不适用（spec 不涉数值）。
error-handling-enforcer: yes — 新增 typed error SubAgentSandboxRootError（继承 errors.ts:18-20 命名+readonly name 惯例，仿 SubAgentCapacityError 带 context 字段）；拒绝路径 = 同步抛 typed，不走裸 Error；Boundaries Always 第 1 条「拒绝走 typed error（不裸抛 Error）」已显式守门。
complexity-anti-drift: yes — sandboxRoot 校验 = realpath+relative 单点 ~10 行线性；allow-list 推导 = ACI_TOOLSET_NAMES 减常量，filter 操作；bash mask 接入 = 6 行三元 + handler 返回前 stdout/stderr 过 mask；4 类探针 = sandbox-probe.ts:37-44 既有数组结构。无 god-function、无重复逻辑意图。
minimal-change-verifier: yes — 范围 = #357 单父图下的 4 项子任务（sandboxRoot 收窄 + 判官 allow-list + output-mask + 4 类探针），全部围绕 sub-process tool surface 同一概念层；无跨议题 scope creep（不碰 mcp/memory/tui/lsp/permission/harness-loop），不重构既有模块。
```

审查补充观察（非阻塞，writing-plans 消化）：

1. **allow-list 推导的跨模块导入**：run-classifier-adapter.ts 需 `import { ACI_TOOLSET_NAMES } from "../aci/tools/registry.js"`——verify → aci/tools/registry 是新边但非循环；plans 里写明导入方向与「命名真值单一来源」语义。
2. **realpath 同步/异步**：已按审查修正为 async（对齐 helpers.ts 惯例）；`buildWorkerPayload` 是同步调用，plans 阶段落实校验前置 await 或 spawn 内异步化。
3. **判官缺省行为变更**：「缺省 = 父 sandboxRoot（不是 process.cwd()）」相对 manager.ts:341 现状是行为变更——plans 阶段加显式断言锁定，避免回归。
4. **探针 npm script 名**：`probe:sandbox:subagent` 加进 package.json，plans 阶段锁定。
