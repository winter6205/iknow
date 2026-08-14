# Plan: 钩子系统引擎内承载面（类型收窄 · 异常语义 · secrets guard）

Spec: `specs/126-hook-system.md`（ACR 五维全 yes，第二轮复审，2026-08-12）
Source: #116 [wayfinder:map] ⑤ 评估闭环 · #126 resolution（D1–D7）
Tracker: GitHub（label `ready-for-agent`，native blocking via addBlockedBy；票创建留待 operator 放行，见文末）

---

## Architecture Change Reviewer verdict

引自 spec（第二轮复审 PASS）：

- bounded-context-guardian: yes — 新代码全落 `src/harness/permission/`，settings 走 ADR-0015 单承载，装配仅经 build-engine 组合缝，Stop 显式排除引擎。
- defensive-contract-validator: yes — 五类输入边界（empty/非法正则/overflow/exception/concurrent）逐条入 Testing Strategy §5。
- error-handling-enforcer: yes — 坏 pattern 剔除+告警、reason 脱敏 ≤200 字符、构造期一次编译。
- complexity-anti-drift: yes — 增量均小段，无超阈值函数/文件。
- minimal-change-verifier: yes — 单一逻辑任务，1 commit/票。

---

## Decisions（PLAN 阶段定稿）

- **内置默认模式集**（出厂兜底常量，spec Boundaries「Ask first」项由 operator 全权授权代定；实施期误报率高则回炉）：
  1. `-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----` — 私钥块
  2. `sk-[A-Za-z0-9_-]{20,}` — 通用 API key 形态
  3. `AKIA[0-9A-Z]{16}` — AWS access key
  4. `ghp_[A-Za-z0-9]{36}` / `github_pat_[A-Za-z0-9_]{50,}` — GitHub token
  5. `xox[baprs]-[A-Za-z0-9-]{10,}` — Slack token
  6. `(cat|head|tail|curl|scp|rsync)\b.*\bid_[a-z]+\b` — 私钥文件外传形态
     全部 case-sensitive 按需、构造期 `new RegExp` 编译，失败剔除。
- **类型收窄形状**：专用 `PreHookBlock { reason: string }`（spec Assumption 1）；`PermissionOutcome` 保留给权限层（policy/checkPermission），钩子不再共用。
- **`onHookError` 缝**：`PermissionExecutorOptions` 与 `createSecretsGuardHook` 各自带可选 `onHookError?: (e: { phase: "pre" | "post" | "guard-init"; tool?: string; message: string }) => void`；默认不传 = 静默（post）/ 无告警渠道（guard-init 剔除仍生效）。
- **commit 序列**：5 票 5 commit；T1/T2 并行、T3/T4 并行、T5 收口。类型收窄虽波及 13 文件，但行为零变化（executor 现状即「任何返回皆拦」），不走 expand–contract，单 commit 落。

---

## Tracer bullets

1. **T1** `[implementation]` 类型收窄：PreToolUseHook → deny-only `[parallel]`
2. **T2** `[implementation]` 钩子异常语义：Pre fail-closed / Post fire-and-forget `[parallel]`
3. **T3** `[implementation]` secrets-guard 模块：内置模式集 + 工厂 `[parallel]`
4. **T4** `[implementation]` settings `secrets` 段：parse/merge/freeze `[parallel]`
5. **T5** `[implementation]` 产品装配组合：guard + settings + build-engine `[blocks: T1, T2, T3, T4]`

---

#### T1. `[implementation]` 类型收窄：PreToolUseHook → deny-only

- **Affects**: `src/harness/permission/types.ts`（新增 `PreHookBlock`，`PreToolUseHook` 收窄）· `hooks.ts`（no-op/工厂签名跟随）· `permission-executor.ts`（调用点类型）· `index.ts` 导出 · `src/harness/aci/{types,permission,index,aci-executor}.ts`（透传签名）· `tests/harness/permission/{permission-executor,types,policy}.test.ts` + `tests/harness/aci/aci-executor.test.ts`（调用点同步）
- **Acceptance**: `npm run typecheck` 零错误；`grep -rn "PermissionOutcome" src/harness/permission/types.ts src/harness/aci/` 不出现在钩子签名中；既有 hook 相关测试全绿（行为零变化——拦截语义与现状逐条一致）。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

#### T2. `[implementation]` 钩子异常语义：Pre fail-closed / Post fire-and-forget

- **Affects**: `src/harness/permission/prefixes.ts`（`hookError: "[hook_error]"` 入 SSOT 表）· `permission-executor.ts`（pre 调用点 try/catch → `execution_failed` + 脱敏 reason ≤200 字符；post 调用点 try/catch → 吞 + `onHookError`；`PermissionExecutorOptions` 加 `onHookError?`）· `tests/harness/permission/permission-executor.test.ts`（新增：pre 抛异常 → `[hook_error]` + inner 零调用 + loop 继续；post 抛异常 → 结果逐字段不变 + 回调触发；reason 脱敏断言——不含 input 原文、≤200 字符）
- **Acceptance**: `npx vitest run tests/harness/permission/permission-executor.test.ts` 全绿，含上述 4 组新断言；spec SC2/SC3 对应测试各 ≥1 条。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

#### T3. `[implementation]` secrets-guard 模块：内置模式集 + 工厂

- **Affects**: `src/harness/permission/secrets-guard.ts`（新：`DEFAULT_SECRET_PATTERNS` 常量 + `createSecretsGuardHook({ patterns?, enabled?, onHookError? })` 工厂，构造期编译/剔除、input stringify 截断 20000 字符匹配）· `index.ts` 导出 · `tests/harness/permission/secrets-guard.test.ts`（新：正例 6 类模式拦截、反例放行、overflow 截断不误拦、非法正则剔除 + 告警不毒化、enabled:false 透明、并发双调用一致）
- **Acceptance**: `npx vitest run tests/harness/permission/secrets-guard.test.ts` 全绿；spec Testing Strategy §4/§5 各项 ≥1 条断言；`grep` 确认内置常量无真实密钥（占位形态 only）。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

#### T4. `[implementation]` settings `secrets` 段：parse/merge/freeze

- **Affects**: `src/config/settings.ts`（`secrets.enabled?: boolean`（默认 true）+ `secrets.patterns?: string[]`，走既有 user>project merge/freeze 模式，类型非法 → 明确报错或忽略的既有惯例）· `tests/config/settings.test.ts`（或既有 settings 测试落点：缺失/空数组回退、project 覆盖 user、非法类型处理）
- **Acceptance**: settings 测试全绿，含 empty（缺失/空数组）与非法输入两类断言；`npm run typecheck` 零错误。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

#### T5. `[implementation]` 产品装配组合：guard + settings + build-engine

- **Affects**: `src/harness/build-engine.ts`（装配点读 settings `secrets` 段 → `createSecretsGuardHook` → 与既有 `opts.hooks?.preToolUse`（如有）组合：guard 先行短路，再透传 postToolUse 不变）· `tests/harness/build-engine` 相关测试（装配集成断言：默认启用拦截正例、`secrets.enabled:false` 透明、settings 追加 patterns 生效、hard-wall 兜底链顺序回归——guard 放行时 `[permission_denied]` 仍拦）
- **Acceptance**: `npm test` 全绿；spec SC5/SC4/SC6/SC7/SC8 全对应：git diff 确认 `src/harness/loop-engine.ts` 与 StopReason 零改动（SC6）；`npm run typecheck` 零错误（SC9）。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

---

## Blocking 拓扑

```
T1 (类型收窄) ─────┐
T2 (异常语义) ─────┤
T3 (guard 模块) ───┼──► T5 (装配组合)
T4 (settings 段) ──┘
```

T1–T4 四票互不依赖可全并行（T1/T2 同触 permission-executor.ts 但改动区不重叠：T1 动类型与调用点形状，T2 动调用点 try/catch；若并行执行冲突，以先合入者为准 rebase）。T5 依赖全部四票。

- **执行期**：5 bullets = 5 commits（各自分支）；diff scope 与 Affects 一致
- **完成定义**：SC1–SC9 全绿 + #126 D7 七条验收映射覆盖（SC1↔D7④ · SC2/SC3↔D7③ · SC4↔D7② · SC5↔D7①⑥ · SC6↔D7⑤ · SC7/SC8↔D7③⑥ · SC9↔D7⑦）

---

## Tracker 票创建（待 operator 放行）

5 张 `ready-for-agent` GitHub issue（T1–T5）+ native blocking（T5 blockedBy T1–T4）。创建 issue 是对共享 tracker 的可见写操作，按项目规则留待 operator 一句放行即执行。
