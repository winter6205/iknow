/**
 * src/harness/permission/secrets-guard.ts
 *
 * T3 secrets-guard：deny-only PreToolUseHook 工厂（内置模式集 + 自定义 pattern）。
 *
 * 职责：在调用进入权限层之前，把工具 input 里携带的密钥形态拦下来
 * （executor 会把 PreHookBlock.reason 包装成 `[hook_blocked] ...` 回灌模型）。
 *
 * 设计决策（spec Decisions 定稿）：
 *  - 占位形态 only：内置模式全是正则占位符，绝不含真实密钥。
 *  - 全 case-sensitive：不做 i 标志，避免误拦放大。
 *  - Constraints (a)：构造期逐条 `new RegExp` 编译；非法正则条目剔除 + guard-init
 *    告警，其余正常生效 —— 绝不允许坏 pattern 拦死所有调用。
 *  - Constraints (c)（ADR-0006 封顶精神）：运行期 `JSON.stringify(input)` 截断至
 *    20000 字符后扫描；超长 input 的尾部密钥特征不参与匹配，宁可漏拦不误拦、
 *    不抛异常。
 *  - 返回的 hook 是纯函数、无状态：编译产物在构造期固化，运行期只读 → 并发安全。
 */

import type { PreToolUseHook } from "./types.js";
import type { HookErrorEvent } from "./permission-executor.js";

/** stringify 截断上界（ADR-0006 封顶精神；spec Constraints (c)）。 */
const MAX_SCAN_LENGTH = 20_000;

/**
 * 内置密钥占位模式集（全 case-sensitive，占位形态 only，绝不含真实密钥）。
 * 顺序即优先级（首中即拦），但各类模式互斥，顺序不影响语义。
 */
export const DEFAULT_SECRET_PATTERNS: ReadonlyArray<string> = Object.freeze([
  // 1. 私钥块（RSA / EC / OPENSSH / DSA / PGP，前缀可选）
  "-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----",
  // 2. 通用 API key 形态（sk- 前缀 + ≥20 个 base64url 字符）
  "sk-[A-Za-z0-9_-]{20,}",
  // 3. AWS access key（AKIA + 16 位大写字母数字）
  "AKIA[0-9A-Z]{16}",
  // 4. GitHub token（ghp_ + 36 位 / github_pat_ + ≥50 位）
  "ghp_[A-Za-z0-9]{36}",
  "github_pat_[A-Za-z0-9_]{50,}",
  // 5. Slack token（xoxb / xoxa / xoxp / xoxr / xoxs + ≥10 位）
  "xox[baprs]-[A-Za-z0-9-]{10,}",
  // 6. 私钥文件外传形态（cat / head / tail / curl / scp / rsync 触及 id_<name>）
  "(cat|head|tail|curl|scp|rsync)\\b.*\\bid_[a-z]+\\b",
]);

/** guard-init 告警载荷（phase 统一 "guard-init"，无 tool 归属）。 */
export interface SecretsGuardHookOpts {
  readonly patterns?: ReadonlyArray<string>;
  readonly enabled?: boolean;
  readonly onHookError?: (e: HookErrorEvent) => void;
}

/**
 * 构造 secrets-guard PreToolUseHook。
 *
 *  - enabled 默认 true；false → 返回透明 hook（恒 undefined，不做任何编译/扫描）。
 *  - 构造期把 `[...DEFAULT_SECRET_PATTERNS, ...(opts.patterns ?? [])]` 逐个编译；
 *    非法正则剔除并触发 guard-init 告警，其余正常生效（Constraints (a)）。
 *  - 运行期：input stringify 截断 20000 字符后逐模式匹配；命中 →
 *    `{ reason: "secret pattern matched: <pattern源串>" }`，未命中 → undefined。
 *  - stringify 失败（循环引用等）按「无可扫描内容」处理 → 放行，不抛异常。
 */
export function createSecretsGuardHook(
  opts?: SecretsGuardHookOpts
): PreToolUseHook {
  if (opts?.enabled === false) {
    return Object.freeze(() => undefined);
  }

  // 编译产物固化在构造期；源串保留用于 reason 与告警（RegExp.toString 会加 / 定界符）。
  const compiled: ReadonlyArray<{
    readonly source: string;
    readonly re: RegExp;
  }> = Object.freeze(
    [...DEFAULT_SECRET_PATTERNS, ...(opts?.patterns ?? [])].flatMap(
      (source) => {
        try {
          return [{ source, re: new RegExp(source) }];
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          opts?.onHookError?.({
            phase: "guard-init",
            message: `invalid secret pattern dropped: ${JSON.stringify(source)}: ${message}`,
          });
          return [];
        }
      }
    )
  );

  const hook: PreToolUseHook = Object.freeze(({ input }) => {
    if (compiled.length === 0) return undefined;

    let scanned: string;
    try {
      const raw = JSON.stringify(input);
      scanned =
        raw.length > MAX_SCAN_LENGTH ? raw.slice(0, MAX_SCAN_LENGTH) : raw;
    } catch {
      // stringify 失败（循环引用 / BigInt 等）→ 无可扫描内容，放行不抛。
      return undefined;
    }

    for (const { source, re } of compiled) {
      if (re.test(scanned)) {
        return { reason: `secret pattern matched: ${source}` };
      }
    }
    return undefined;
  });

  return hook;
}
