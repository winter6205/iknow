/**
 * PROTOTYPE（throwaway）— ACI 原型工具层：权限检查。
 *
 * 验证问题：三层权限决策（规则层 → 类别默认 → 危险拦截）能否以纯函数
 * 装饰在 Executor 之前，不修改协议、不引入人工回路。
 * ask 在原型里收敛为 allow + reason 标记（deferred：真产品才需人工确认回路，
 * 原型 explicitly not 构建人工审批路径）。
 *
 * Code review 后回填（Security CRITICAL）：
 *   - 黑名单经对抗测试 21/21 payload 被绕过 → execute 类别必须
 *     **allowlist-first**（白名单为主门），黑名单只作纵深双保险；
 *   - 安全兜底**不可被 byName always_allow 绕过**（策略只豁免 ask 门）。
 */

import type {
  AciPermissionPolicy,
  AciToolDef,
  PermissionOutcome,
  PermissionRule,
} from "./types.js";

/**
 * 构造权限策略。默认 defaultRule="ask"，denyDangerousExecute=true。
 * 工厂返回 Object.freeze，与 harness 既有不可变风格一致。
 */
export function createPermissionPolicy(
  opts?: Partial<AciPermissionPolicy>
): AciPermissionPolicy {
  return Object.freeze({
    defaultRule: opts?.defaultRule ?? "ask",
    byName: opts?.byName ? Object.freeze({ ...opts.byName }) : undefined,
    denyDangerousExecute: opts?.denyDangerousExecute ?? true,
  });
}

/**
 * shell_exec allowlist（白名单）—— execute 类别工具的主门。
 *
 * 仅允许这些首 token（小写、剥掉路径前缀）。任何其他首 token 直接拒绝。
 * 故意保守：原型验证形状用，**真产品应使用 OS 级沙箱 + 完整命令解析**，
 * 而非依赖白名单（毕业约束：见 docs/drafts/aci-prototype-contract.md §7）。
 */
const ALLOWED_COMMAND_TOKENS: ReadonlySet<string> = Object.freeze(
  new Set([
    "echo",
    "node",
    "npm",
    "git",
    "ls",
    "cat",
    "pwd",
    "wc",
    "head",
    "tail",
    "dir", // Windows 友好
    "type", // Windows 友好
    "where", // Windows 友好
  ])
);

/**
 * shell 元字符——只要命令里出现这些字符，一律拒绝（allowlist 的一部分，
 * 与首 token 检查**两者都满足**才放行）。
 *
 * 覆盖：管道、重定向、命令链、变量展开、命令替换、反引号、换行（多行命令）、
 * 括号（subshell/分组）。allowlist-first 的安全模型不允许任何 shell 元字符，
 * 因为这些都能在白名单 token 上构造逃逸。
 */
const SHELL_METACHARS: readonly string[] = Object.freeze([
  "|",
  ";",
  "&",
  "<",
  ">",
  "(",
  ")",
  "$",
  "`",
  "\n",
  "\r",
]);

/**
 * 提取首 token：按空白切第一个词，去掉常见路径前缀（`/bin/`、`/usr/bin/`、
 * Windows `C:\...\`）后小写化。若命令是空字符串，返回 ""。
 */
function firstToken(command: string): string {
  const trimmed = command.trim();
  if (trimmed.length === 0) return "";
  const firstWord = trimmed.split(/\s+/)[0] ?? "";
  // 剥掉路径前缀：basename 等价。
  const lastSlash = Math.max(
    firstWord.lastIndexOf("/"),
    firstWord.lastIndexOf("\\")
  );
  const basename = lastSlash >= 0 ? firstWord.slice(lastSlash + 1) : firstWord;
  return basename.toLowerCase();
}

/**
 * 判断命令是否在 allowlist 内。
 *
 * 条件（**两者都满足**）：
 *   1. 首 token（小写、剥路径前缀）匹配 ALLOWED_COMMAND_TOKENS；
 *   2. 整条命令**不含任何** shell 元字符（管道 / 重定向 / 链式 / 变量展开 /
 *      命令替换 / 反引号 / 换行 / 括号）。
 *
 * 不在 allowlist → false；安全放行 → true。
 */
export function isAllowedCommand(command: string): boolean {
  const token = firstToken(command);
  if (!ALLOWED_COMMAND_TOKENS.has(token)) return false;
  for (const m of SHELL_METACHARS) {
    if (command.includes(m)) return false;
  }
  return true;
}

/** 黑名单模式列表（小写子串匹配）—— 仅作纵深双保险。 */
const BLACKLIST_PATTERNS: readonly string[] = Object.freeze([
  "rm -rf",
  "rm -fr",
  "rm -r ",
  "rm -f ",
  "rm --recursive",
  "rmdir",
  "remove-item",
  "mkfs",
  "dd if=",
  ":(){ :|:& };:", // fork bomb
  "shutdown",
  "reboot",
  "format",
  "del /f",
  "rd /s",
  " -delete", // find ... -delete / find / -delete
  "chmod -r",
  "chown",
]);

/**
 * 返回命中的危险模式描述；未命中返回 null。
 * 内部辅助：供 isDangerousCommand 与 checkPermission 共用，避免重复扫描。
 */
function findDangerousPattern(command: string): string | null {
  const lower = command.toLowerCase();
  for (const pat of BLACKLIST_PATTERNS) {
    if (lower.includes(pat)) return pat;
  }
  // shell 操作符链：命中即视为危险（原型保守策略；allowlist-first 模型下此层
  // 通常先被 SHELL_METACHARS 在 isAllowedCommand 拦下,这里作为纵深双保险）。
  if (/&&/.test(command)) return "&&";
  if (/\|\|/.test(command)) return "||";
  if (/\|/.test(command)) return "|";
  if (/;/.test(command)) return ";";
  if (/`/.test(command)) return "`";
  if (/\$\(/.test(command)) return "$(";
  if (/\$\{/.test(command)) return "${";
  if (/\$[A-Za-z_]/.test(command)) return "$VAR"; // bare $VAR 变量展开
  if (/>\s?>?/.test(command)) return ">";
  if (/<\s?\(/.test(command)) return "<(";
  if (/\r|\n/.test(command)) return "\\n";
  return null;
}

/**
 * 危险命令黑名单 poka-yoke：纯字符串判定，不执行任何命令。
 *
 * ⚠️ Code review verdict：黑名单经对抗测试 21/21 payload 全部绕过，**无法
 * 修补成安全**。ACI execute 类工具必须 **allowlist-first**，黑名单只作纵深
 * 双保险层；详见 docs/drafts/aci-prototype-contract.md §7。
 */
export function isDangerousCommand(command: string): boolean {
  return findDangerousPattern(command) !== null;
}

/**
 * 三层权限决策（ch04 阶段④），Security review 后重排：
 *
 *   1. `byName[name] === "always_deny"` → 直接 deny（策略优先级最高，可关闭工具）；
 *   2. **execute 类别安全兜底（不可被 always_allow 绕过）**：
 *      a. command 非字符串 → deny；
 *      b. !isAllowedCommand(cmd) → deny `"command not in allowlist: <token>"`；
 *      c. isDangerousCommand(cmd) → deny `"dangerous command blocked"`（双保险）；
 *   3. `byName[name] === "always_allow"` → allow（仅豁免 ask 门，不豁免安全兜底）；
 *   4. 类别默认：read-only → allow；write/collaborate → allow（reason 注明
 *      "ask→auto-allow in prototype"）；execute → 到此说明已过兜底，allow。
 *
 * 未知工具（catalog 查不到）由 executor 层处理，不在这里。
 */
export function checkPermission(opts: {
  def: AciToolDef;
  input: unknown;
  policy: AciPermissionPolicy;
}): PermissionOutcome {
  const { def, input, policy } = opts;
  // 层 1：byName always_deny 短路（最高优先级，可关闭工具）
  const byNameRule: PermissionRule | undefined = policy.byName?.[def.name];
  if (byNameRule === "always_deny") {
    return { decision: "deny", reason: `byName always_deny: ${def.name}` };
  }

  // 层 2：execute 类别安全兜底（不可被 always_allow 绕过）
  const { category } = def.aci;
  const cmdRaw = (input as { command?: unknown } | null | undefined)?.command;
  if (category === "execute") {
    if (typeof cmdRaw !== "string") {
      // 非字符串 command → deny（防御对象/数字/undefined 等绕过）
      return {
        decision: "deny",
        reason: `execute: command must be a string (got ${typeof cmdRaw})`,
      };
    }
    const cmd = cmdRaw;
    if (!isAllowedCommand(cmd)) {
      return {
        decision: "deny",
        reason: `command not in allowlist: ${firstToken(cmd) || "(empty)"}`,
      };
    }
    // allowlist 之后的黑名单双保险
    if (policy.denyDangerousExecute ?? true) {
      const pattern = findDangerousPattern(cmd);
      if (pattern !== null) {
        return {
          decision: "deny",
          reason: `dangerous command blocked (matched: ${pattern}): ${cmd}`,
        };
      }
    }
  }

  // 层 3：byName always_allow（只能豁免 ask 门，不能豁免安全兜底）
  if (byNameRule === "always_allow") {
    return { decision: "allow", reason: `byName always_allow: ${def.name}` };
  }

  // 层 4：类别默认
  if (category === "read-only") {
    return { decision: "allow", reason: "read-only: auto-allow" };
  }
  if (category === "write" || category === "collaborate") {
    // 原型无人工回路；ask 收敛为 allow + 标记（deferred to real product）
    return { decision: "allow", reason: "ask→auto-allow in prototype" };
  }
  // execute 到这里说明已通过安全兜底
  return { decision: "allow", reason: "execute: safe command allowed" };
}
