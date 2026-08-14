# Spec: 钩子系统引擎内承载面（类型收窄 · 异常语义 · secrets guard）

> 来源：wayfinder 地图 [wayfinder:map] ⑤ 评估闭环 (#116) · 票 #126 resolution（D1–D7，2026-08-12 operator 确认）
> 假设闸门：operator 显式授权自审（「没疑问了，剩下的流程你全自己审查并走完」），10 条假设逐条以代码证据自证，见文末 Assumptions。
> 范围：仅引擎内承载面（Pre/PostToolUse）。引擎外承载面（Stop = #128 外挂自检层）不在本 spec——其 spec/plan 已独立落地（specs/128-auto-correction-loop.md），代码零交叠。

## Glossary（exact copy from docs/CONTEXT.md）

- **双重承载面 (hook dual surfaces)**: (#126 决议 D1) 钩子系统的正式形态——引擎内承载面（Pre/PostToolUse，挂 permission-executor 5 步链，工具级/同步/无状态）+ 引擎外承载面（Stop，host/orchestrator 层订阅 `run()` completed 返回，任务级/多轮/有策略状态，实现即 #128 外挂自检层）。Stop 钩子的触发事件是 host 侧观察到的 run() 返回，不是引擎 Transition。
- **hook failure semantics (fail-closed / fire-and-forget)**: (#126 决议 D3) 引擎内钩子的异常语义分裂——Pre 钩子抛异常 fail-closed（该调用判 `execution_failed` + `hook_error` 前缀回灌模型，loop 不炸）；Post 钩子抛异常 fire-and-forget（只记录、不影响结果，观测层不反噬执行层）。钩子必须同步纯函数、禁慢 IO；慢验证归 Stop 承载面。
- **secrets guard**: (#126 决议 D6) Pre 缝第一个真实产品消费者——密钥模式拦截钩子，拦「工具调用参数内容夹带密钥/凭据」，与 hard-wall（命令形态 + 敏感路径）互补不重叠；模式来源双层：代码内置默认集 + 项目 settings 覆盖/追加，接入 `createAciExecutor` 产品路径。
- 关联既有条目：**executor truncation authority**（契约 X，钩子不得改结果）、**append-only messages**（钩子不得注入消息）、**ACI tool set**（装配 SSOT）、**project stack defaults (settings 单承载)**（ADR-0015）。

## Architectural Constraints（ADR 引用）

- **ADR-0015**：settings 单承载——secrets guard 的项目级模式配置扩 `settings.json`（`secrets` 段），不开新配置口。
- **ADR-0004 / ADR-0006**：钩子不触碰工具结果内容（截断与内容权威归 executor）；`hook_error` reason 走既有 `VIOLATION_PREFIXES` SSOT 前缀表。
- **冻结契约**：5 步链顺序不变（pre → checkPermission → askUser → execute → post）；`ToolExecutionResult` 四变体不新增（D5）；StopReason 不动（Stop 归引擎外承载面）。
- **权威边界**：钩子不能改工具参数、不能改结果、不能读消息历史、不能注入消息（D2）；消息注入唯一通道是 host 层 `priorMessages`。
- **guard 自身失败路径**（ACR 第一轮补强）：(a) pattern 编译期校验——坏正则构造期剔除并经 `onHookError` 告警，**绝不允许坏 pattern 落入 fail-closed 拦死所有调用**（等效 DoS）；(b) `hook_error` reason 脱敏限长——只含异常类名 + 截断后的 message（≤ 200 字符），禁止回灌原始 input 内容（security-boundaries「错误信息不泄露敏感细节」）；(c) 扫描输入长度上限——`JSON.stringify(input)` 截断至 20000 字符再匹配（ADR-0006 封顶精神），超长尾部不扫描（内置模式均为短特征，截断不损召回）。

## Objective

把 v0 no-op 钩子骨架升级为 V1 产品级钩子系统（引擎内承载面）：消除 `PreToolUseHook` 类型与 executor 行为的漂移、落地 fail-closed / fire-and-forget 异常语义、接入第一个真实 Pre 消费者（secrets guard）。用户：iknow 全体交互面（chat / tui / ask / serve）——危险调用被拦截且原因回灌模型，密钥不再可能经工具参数外泄。成功 = #126 D7 七条验收全绿。

## Tech Stack

不变：TypeScript + Node（项目既有栈）。无新依赖。新增代码为纯 TS 模块 + vitest 测试。任何栈变更需重开假设闸门。

## Commands

```bash
npm run typecheck      # tsc -p tsconfig.json --noEmit
npm test               # vitest：unit + harness + integration
npx vitest run tests/harness/permission   # 权限/钩子模块定向
npm run probe:sandbox  # 本 spec 不涉及 sandbox flag，仅作回归基线（不改 bwrap argv）
```

## Project Structure

```
src/harness/permission/
  types.ts            # PreToolUseHook 类型收窄（deny-only）
  hooks.ts            # createNoOpHooks / createHooksPair 签名跟随收窄
  prefixes.ts         # VIOLATION_PREFIXES 增 hookError: "[hook_error]"
  permission-executor.ts  # pre/post 调用点包异常语义
  secrets-guard.ts    # 新：createSecretsGuardHook 工厂 + 内置默认模式集
src/config/settings.ts    # settings 扩 secrets 段（parse/merge/freeze 既有模式）
src/harness/build-engine.ts  # 产品装配组合 guard + 既有 postToolUse
tests/harness/permission/    # 单测落点（既有目录惯例）
```

## Code Style

沿用 permission/ 既有风格：readonly 接口 + Object.freeze 工厂 + 纯函数。示例（类型收窄后的形状）：

```ts
/** Pre 钩子只表达拦截；返回 undefined = 放行（进入 checkPermission）。 */
export interface PreHookBlock {
  readonly reason: string; // executor 包装为 [hook_blocked] <reason>
}
export interface PreToolUseHook {
  (ctx: {
    readonly tool: string;
    readonly input: unknown;
  }): PreHookBlock | undefined;
}
```

异常语义（executor 调用点）：

```ts
let hookDecision: PreHookBlock | undefined;
try {
  hookDecision = pre({ tool: def.name, input: call.input });
} catch (err) {
  // fail-closed：拦不下就拒，绝不静默放行
  out.push({
    kind: "execution_failed",
    toolUseId: call.id,
    message: `${HOOK_ERROR_PREFIX} pre-hook threw: ${errMsg(err)}`,
  });
  continue;
}
```

## Testing Strategy

vitest，单测为主（无集成/e2e 新增需求——装配缝已由既有集成路径覆盖）：

1. **类型收窄**：typecheck 通过即验（收窄后所有旧调用点编译报错处已同步修正）。
2. **异常语义**：pre 抛异常 → `execution_failed` + `[hook_error]`，inner executor 零调用；post 抛异常 → 结果原样返回、`onHookError` 回调被触发。
3. **链顺序回归**：guard 放行时 hard-wall 仍拦（构造 hard-wall 必拦调用 + 放行型 guard，断言 `[permission_denied]`）。
4. **secrets guard**：内置模式正例（私钥块 / 典型 key 前缀 / id_rsa 外传形态）拦截、反例（普通命令、含 "key" 字样的无害文本）放行；settings 追加模式生效。
5. **五类输入边界**（S2 defensive contract）：
   - empty：`secrets.patterns` 缺失 / 空数组 → 内置默认集生效（enabled 默认 true）；`secrets.enabled: false` → guard 透明不拦；
   - 非法输入：settings 含非法正则串（如 `"[unclosed"`）→ 构造期剔除该条 + `onHookError` 告警，其余 pattern 正常生效（单测断言不拦正常调用）；
   - overflow：input stringify 超 20000 字符 → 仅扫描前 20000 字符、不抛异常、不误拦；
   - exception：guard 内部异常（非 pattern 编译类）→ 走 pre fail-closed 路径（`[hook_error]`），reason 脱敏断言（不含 input 原文、≤ 200 字符）；
   - concurrent：guard 为无状态纯函数，同 input 并发调用结果一致（双调用断言即可，不引入并发设施）。
6. 不得删测、不得降断言强度（项目测试规范）。

## Boundaries

- **Always do**：先跑 typecheck + tests 再 commit；前缀文案走 `VIOLATION_PREFIXES` SSOT；settings 新字段走既有 parse/merge/freeze 模式。
- **Ask first**：settings `secrets` 段字段名与 128 `verify` 段并列的 schema 变更；内置默认模式集的具体条目增删。
- **Never do**：给钩子加改参数/改结果/读历史/注入消息能力（D2 写死）；动 5 步链顺序；把 Stop 逻辑拉回引擎；内置模式集包含任何真实密钥。

## Success Criteria（binary）

1. `PreToolUseHook` 返回类型为 deny-only（`PreHookBlock | undefined`），`npm run typecheck` 零错误。
2. Pre 钩子抛异常 → 该调用 `execution_failed` + `[hook_error]` 前缀，inner 零执行，loop 继续（单测断言）。
3. Post 钩子抛异常 → `ToolExecutionResult` 与无异常时逐字段相同（单测断言）。
4. 钩子放行时 hard-wall 兜底仍拦（链顺序单测断言 `[permission_denied]`）。
5. secrets guard 接入 `build-engine` 产品装配路径：默认启用、内置模式拦截正例、settings 可追加模式（各 1 条单测）。
6. Stop 相关能力零新增（diff 中无 StopReason / loop-engine 收尾路径改动——git diff 可查）。
7. 五类输入边界测试全过：empty（patterns 缺失/空/enabled:false）· 非法正则剔除不毒化 · 超长 input 截断不误拦 · guard 内部异常 fail-closed 且 reason 脱敏 · 并发一致性（Testing Strategy §5 各项各至少 1 条断言）。
8. 坏 pattern 不拦正常调用（guard 失败路径 EXIT 明确：剔除 + 告警，无静默降级、无拦死全量）（单测断言）。
9. `npm test` 全绿，无 skip/降断言。

## Open Questions

无——operator 已授权自审通过；实施期如发现内置模式集误报率高，按 Boundaries「Ask first」处理，不阻塞 PLAN。

## Architecture Change Reviewer verdict（第二轮复审 PASS，2026-08-12）

- bounded-context-guardian: yes — 新代码全落 `src/harness/permission/`，settings 走 ADR-0015 单承载，装配仅经 build-engine 组合缝，Stop 显式排除引擎，无反向依赖。
- defensive-contract-validator: yes — Testing Strategy §5 逐条覆盖 empty / 非法正则 / overflow 20000 截断 / exception / concurrent 五类，SC7 要求各类至少 1 条断言。
- error-handling-enforcer: yes — Constraints (a)(b)(c) 定义坏 pattern 剔除+告警、reason 脱敏 ≤200 字符禁回灌 input、构造期一次编译；SC8 明确 EXIT「无静默降级、无拦死全量」。
- complexity-anti-drift: yes — 增量均为小段 try/catch 与字段扩展，guard 为纯函数+截断匹配，无超阈值函数/文件。
- minimal-change-verifier: yes — 单一逻辑任务（V1 引擎内承载面），scope 明确排除 Stop，1 commit 可落。

第一轮 2 项 no（defensive-contract-validator / error-handling-enforcer）修订记录：补五类输入边界测试、20000 字符扫描截断、坏 pattern 构造期剔除 + 告警、hook_error reason 脱敏限长。

---

## Assumptions（自审记录，operator 授权代确认）

1. **类型收窄形状** = 专用 `PreHookBlock { reason }` 而非沿用 `PermissionOutcome` 子集——证据：executor 现状对任何非 undefined 返回一律拦（permission-executor.ts:133），ask/allow 语义从未生效；专用类型让「只拦」成为编译期事实。✔ 代码证据成立。
2. **`hook_error` 前缀进 `VIOLATION_PREFIXES` SSOT**——证据：prefixes.ts 已有 hookBlocked/permissionDenied/userDenied 三前缀同表。✔ 惯例成立。
3. **Post 异常「记录」的落点** = executor 新增可选 `onHookError` 回调（默认不传 = 静默吞），不引入 logger 依赖——证据：executor 无日志设施，既有消费者（TUI wrapTuiHook）经回调缝接入。✔ 与既有接缝模式一致。
4. **settings 字段** = `secrets.enabled?: boolean`（默认 true）+ `secrets.patterns?: string[]`（追加于内置集）；缺失/空数组回退内置集，非法正则构造期剔除（不毒化 guard）——证据：settings.ts user>project merge/freeze 模式现成；ADR-0015 单承载。✔ 成立。
5. **内置默认模式集在代码中为常量**（出厂兜底，非空）——证据：D6 裁决「出厂带默认集而非空转」，与 #128「未配置透明关闭」有意不同（安全兜底责任）。✔ 裁决已定。
6. **guard 与自定义 pre 钩子的组合顺序** = guard 先行、短路优先——证据：安全拦截应最早生效；createAciExecutor 现经 opts.hooks?.preToolUse 透传，组合点在 build-engine。✔ 成立。
7. **扫描面** = `JSON.stringify(input)` 截断至 20000 字符后匹配；pattern 构造期一次编译（`new RegExp` 失败即剔除），运行期不做动态编译——证据：Q2 裁决钩子只看 `{tool, input}`；截断 + 编译期校验封住 catastrophic backtracking 与超长输入两个 DoS 面（ACR 第一轮补强）。✔ 成立。
8. **不改 loop-engine / StopReason / ToolExecutionResult**——证据：D1/D5 裁决；git diff 可验（SC6）。✔ 成立。
9. **测试目录** = tests/harness/permission/——证据：既有测试按模块镜像落位。✔ 惯例成立。
10. **无新依赖、无 CI 变更**——证据：纯 TS + vitest 既有栈。✔ 成立。
