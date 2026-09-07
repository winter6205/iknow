/**
 * src/harness/hooks/user-lane.ts
 *
 * user-hook-router（specs/user-hook-router.md）T2/T3/T4 —— user lane 的
 * 声明式 deny-only hook router 工厂 + multiplexer 组合器。
 *
 * 职责：把 merged settings 的 `hooks` 段（IknowSettingsHooks）编译成挂
 * permission 5 步链 Step 1 的 PreToolUseHook。V1 三事件：
 *   - PreToolUse：matcher（tool 精确名 / toolPrefix 前缀 / pattern 正则）
 *     全命中 → 拦；缺席 matcher 视为通配（SC2）。
 *   - PreWrite：先过 tool matcher，再要求 classify(call) === "mutate"
 *     （SC3；mutate SSOT = isolation/worktree-gate.ts classifyCall，经
 *     opts.classify 注入）。pattern matcher（若有）在 classify 通过后再
 *     对扫描串匹配。
 *   - PreCommit：不依赖 classify。检测 bash（或等价 shell 工具）调用是否
 *     为 git commit 形态（SC4，见 isGitCommitCall）。
 *
 * 纪律（抄 permission/secrets-guard.ts 先例）：
 *  - 构造期逐条 `new RegExp` 编译；非法正则 → 整条规则剔除 + onHookError
 *    （phase "user-rule-init"，HookErrorEvent 的最小扩展），绝不让坏
 *    pattern 毒化其他规则或全工具面（SC6）。剔除整条而非只剔 pattern
 *    字段：部分剔除会让规则以比用户声明更宽的拦截面生效，违反 deny-only
 *    的最小意外原则。
 *  - 运行期 `JSON.stringify(input)` 截断至 20000 字符后扫描；超长尾部不
 *    参与匹配（SC10）；stringify 失败 → pattern 视为未命中，不抛异常。
 *  - 规则匹配顺序 = rules 数组顺序；先拦先赢（SC5）：命中第一条 deny 即
 *    返回，不评估后续规则。
 *  - enabled 缺席 / 非 true → 返回恒 undefined 的透明 hook，不编译任何
 *    pattern（SC1；工厂恒返回 hook 而非 undefined —— 简单且调用方无需
 *    判空，disabled 时透明即「不挂」语义）。
 *  - 返回的 hook 是纯函数、无状态、同步（#126 D3）：编译产物构造期固化，
 *    运行期只读 → 并发安全。
 *  - deny-only：返回 {reason} = 拦（executor 包装 `[hook_blocked] <reason>`
 *    回灌模型）；返回 undefined = 放行。拦截面保守：形态不可判 → 放行
 *    （与 classifyCall 对 bash 非字符串 fail-closed mutate 的方向相反 ——
 *    那里有写根风险必须 fail-closed，这里只有拦截风险，宁可漏拦不误拦）。
 *
 * 依赖方向（bounded context）：hooks → permission（type-only）/ tools
 * （type-only）/ config（type-only）。classify 的运行时实现（isolation
 * 的 classifyCall）由装配层（build-engine T5）注入，本模块不运行时
 * import isolation —— isolation 内部 import aci/tools，把它拖进 hooks
 * 的运行时依赖会扩边界；type-only 的 MutateClass 引用无运行时代价。
 */
import type { PreToolUseHook } from "../permission/types.js";
import type { HookErrorEvent } from "../permission/permission-executor.js";
import type { ToolCall } from "../tools/types.js";
import type { MutateClass } from "../isolation/worktree-gate.js";
import type {
  IknowSettingsHooks,
  IknowSettingsHookRule,
} from "../../config/settings.js";
import { splitShellSegments } from "../permission/hard-walls.js";
import { MAX_SCAN_LENGTH } from "../permission/secrets-guard.js";

/** PreCommit 检测的 shell 工具名闭集（V1：bash）。 */
const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set(["bash"]);

/** 构造期选项。 */
export interface CreateUserHookRouterOpts {
  /**
   * mutate 分类器（PreWrite 消费）。产品装配（build-engine / worker）注入
   * isolation/worktree-gate.ts 的 `classifyCall`（mutate SSOT，ADR-0037）。
   * 必填：缺省「保守 read」会让忘注入的调用方 PreWrite 规则静默全不拦
   * （fail-open 掩盖接线错误），编译期要求显式传入。
   */
  readonly classify: (call: ToolCall) => MutateClass;
  /** 构造期告警观测（非法 pattern 剔除时调用）。缺席 = 静默剔除。 */
  readonly onHookError?: (e: HookErrorEvent) => void;
}

/** 构造期编译产物：规则 + 编译后的 pattern（若有）。 */
interface CompiledRule {
  readonly rule: IknowSettingsHookRule;
  readonly pattern: RegExp | undefined;
}

/**
 * tool matcher：tool 精确名 / toolPrefix 前缀，两者都须命中（AND）；
 * 都缺席 = 通配。
 */
function toolMatcherMatches(
  rule: IknowSettingsHookRule,
  tool: string
): boolean {
  if (rule.tool !== undefined && rule.tool !== tool) return false;
  if (rule.toolPrefix !== undefined && !tool.startsWith(rule.toolPrefix)) {
    return false;
  }
  return true;
}

/**
 * 构造期编译：逐条规则编译 pattern。非法正则 → 整条剔除 + onHookError
 * （SC6 纪律：坏 pattern 不毒化其他规则，也不以更宽拦截面残存）。
 */
function compileRules(
  rules: ReadonlyArray<IknowSettingsHookRule>,
  onHookError: ((e: HookErrorEvent) => void) | undefined
): ReadonlyArray<CompiledRule> {
  const compiled: CompiledRule[] = [];
  for (const rule of rules) {
    if (rule.pattern === undefined) {
      compiled.push({ rule, pattern: undefined });
      continue;
    }
    try {
      compiled.push({ rule, pattern: new RegExp(rule.pattern) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onHookError?.({
        phase: "user-rule-init",
        message:
          `invalid user hook rule pattern dropped (rule id=${JSON.stringify(rule.id)}): ` +
          `${JSON.stringify(rule.pattern)}: ${message}`,
      });
      // 整条剔除（见文件头注释）
    }
  }
  return compiled;
}

/**
 * 构造扫描串：stringify 截断 20000（SC10）；失败 → undefined（无可扫描
 * 内容，pattern matcher 视为未命中，不抛）。
 */
function buildScanText(input: unknown): string | undefined {
  let raw: string | undefined;
  try {
    raw = JSON.stringify(input);
  } catch {
    return undefined; // 循环引用 / BigInt 等 → 无可扫描内容
  }
  if (raw === undefined) return undefined;
  return raw.length > MAX_SCAN_LENGTH ? raw.slice(0, MAX_SCAN_LENGTH) : raw;
}

/** pattern matcher：扫描串构造失败或未命中 → false。 */
function patternMatches(pattern: RegExp, input: unknown): boolean {
  const scanned = buildScanText(input);
  return scanned !== undefined && pattern.test(scanned);
}

/**
 * PreCommit 的 git commit 形态判定（SC4）。
 *
 * V1 边界（钉住）：按 `splitShellSegments`（hard-walls SSOT 切段器）切成
 * shell 段后逐段判定，任一段为 commit 形态即拦；段内只认首 token 序列，
 * 不做完整 shell 解析（子 shell / 命令替换 / 变量展开不在 V1 范围）。
 * 每段形态：
 *   - 首个 token 精确等于 "git"（`npm commit` 等不命中；token 剥一层成对
 *     引号 —— `git 'commit'` 与 `git commit` 同形态，双空格由空白切分吸收）；
 *   - `git` 之后跳过 option token，取第一个非 option token 为子命令；
 *     已知带值全局 option（`-C` / `-c` / `--git-dir` 等）连同其值一起跳过
 *     —— `git -C <path> commit` 的子命令是 commit，`<path>` 不是子命令；
 *   - 子命令 token 必须精确等于 "commit"（`commit-tree` 等复合子命令不
 *     命中）；`--help`（无论在子命令位还是参数位）视为帮助查询 → 该段
 *     不拦（SC4 显式要求 `git commit --help` 不拦）；
 *   - 非 shell 工具、command 非字符串 → 不拦（保守放行，见文件头注释）。
 */
export function isGitCommitCall(tool: string, input: unknown): boolean {
  if (!SHELL_TOOL_NAMES.has(tool)) return false;
  const command = (input as { command?: unknown } | null)?.command;
  if (typeof command !== "string") return false;
  for (const segment of splitShellSegments(command)) {
    if (segmentIsGitCommit(segment)) return true;
  }
  return false;
}

/** 带独立值的全局 git option 闭集（V1；`--opt=value` 内联形态不受影响）。 */
const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-C",
  "-c",
  "--exec-path",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
]);

/** 剥一层成对引号（`'commit'` / `"commit"` → `commit`）。 */
function unquote(token: string): string {
  if (
    token.length >= 2 &&
    ((token.startsWith("'") && token.endsWith("'")) ||
      (token.startsWith('"') && token.endsWith('"')))
  ) {
    return token.slice(1, -1);
  }
  return token;
}

/** 单个 shell 段是否为 git commit 形态（isGitCommitCall 的段级实现）。 */
function segmentIsGitCommit(segment: string): boolean {
  const tokens = segment.trim().split(/\s+/);
  if (unquote(tokens[0] ?? "") !== "git") return false;
  let subcommand: string | undefined;
  for (let i = 1; i < tokens.length; i += 1) {
    const token = unquote(tokens[i]!);
    if (GIT_VALUE_OPTIONS.has(token)) {
      i += 1; // 跳过 option 的值（如 -C <path>）
      continue;
    }
    if (token.startsWith("-")) continue; // boolean 全局 option（--bare 等）
    subcommand = token;
    break;
  }
  if (subcommand !== "commit") return false;
  // `git commit --help` 是手册页查询，不是提交动作（SC4 显式要求不拦）。
  // 位置语义：仅当 --help 紧随子命令（第一个参数位）才豁免该段 —— 段内
  // 任意位置豁免会误放 `git commit -m "fix --help rendering"` 这类真提交。
  const commitIdx = tokens.findIndex(
    (t, i) => i > 0 && unquote(t) === "commit"
  );
  if (
    commitIdx !== -1 &&
    commitIdx + 1 < tokens.length &&
    unquote(tokens[commitIdx + 1]!) === "--help"
  ) {
    return false;
  }
  return true;
}

/**
 * 构造 user lane 的 deny-only PreToolUseHook。
 *
 *  - hooks 段缺席 / enabled !== true / rules 非数组 → 恒 undefined 的
 *    透明 hook，不编译任何 pattern（SC1）。
 *  - 规则匹配顺序 = rules 数组顺序，先拦先赢（SC5）。
 *  - 返回的 hook 纯函数、无状态、同步（#126 D3）。
 */
export function createUserHookRouter(
  hooks: IknowSettingsHooks | undefined,
  opts: CreateUserHookRouterOpts
): PreToolUseHook {
  // SC1：enabled 缺席 / 非 true → 透明 hook，不编译任何 pattern。
  if (hooks?.enabled !== true || !Array.isArray(hooks.rules)) {
    return Object.freeze(() => undefined);
  }

  const classify = opts.classify;
  const compiled = compileRules(hooks.rules, opts.onHookError);

  const hook: PreToolUseHook = Object.freeze(({ tool, input }) => {
    for (const { rule, pattern } of compiled) {
      // 公共闸门：tool matcher（SC2）→ 事件专属判定（SC3/SC4 或通配）→
      // pattern matcher。任一闸门未过 → 评估下一条；全过 → 先拦先赢（SC5）。
      if (!toolMatcherMatches(rule, tool)) continue;
      const eventHit =
        rule.event === "PreToolUse"
          ? true
          : rule.event === "PreWrite"
            ? // SC3：read / root_flip 即使规则极宽也不拦
              classify({ id: "user-hook", name: tool, input }) === "mutate"
            : rule.event === "PreCommit"
              ? isGitCommitCall(tool, input)
              : // settings 层闭集（HOOK_EVENT_VALUES）之外的事件值不应到达
                // 这里（parseHooks 已剔除）；保守放行。
                false;
      if (!eventHit) continue;
      if (pattern !== undefined && !patternMatches(pattern, input)) continue;
      return { reason: rule.reason };
    }
    return undefined;
  });

  return hook;
}

/**
 * multiplexer 组合器（T5 装配面）：顺序执行各 Pre hook，第一个返回非
 * undefined 即短路返回该 deny（先拦先赢）；全部未命中 → undefined。
 *
 * T5 用它组合 builtin lane（secrets-guard）与 user lane：builtin 在前、
 * user 在后 —— user deny 时后续 hook 不再被调用，builtin 先命中时 user
 * 规则不评估。
 */
export function composePreHooks(
  hooks: ReadonlyArray<PreToolUseHook>
): PreToolUseHook {
  return Object.freeze(({ tool, input }) => {
    for (const hook of hooks) {
      const blocked = hook({ tool, input });
      if (blocked !== undefined) return blocked;
    }
    return undefined;
  });
}
