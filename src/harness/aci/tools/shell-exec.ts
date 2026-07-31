/**
 * PROTOTYPE（throwaway）— ACI 原型 Layer 1:执行工具 shell_exec (allowlist-first 沙箱)。
 *
 * Code review 后重写为 **allowlist-first** 安全模型：
 *   - 主门：首 token 必须在 allowlist（`echo node npm git ls cat pwd wc head
 *     tail dir type where`），且整条命令不含任何 shell 元字符；
 *   - 双保险：isDangerousCommand(cmd) 也命中（黑名单补全缺失模式:> >> \n \r
 *     rm 变体 find -delete chmod -R chown <( $）；
 *   - handler 签名改 (input, ctx?)：ctx?.signal 透传给 exec()（防超时/取消
 *     时子进程泄漏，Executor 透传）；
 *   - env 净化：只给 PATH（防 `printenv`/`echo $SECRET` 泄密——虽然 allowlist
 *     已挡 $，这是纵深防御）。
 *
 * 诚实注释：cwd 只设工作目录，**不是安全边界**。真正的边界是：
 *   1. allowlist-first（首 token + 无元字符）；
 *   2. 黑名单纵深双保险；
 *   3. 毕业约束：realpath 防符号链接 + 真实 OS 级沙箱（见
 *      docs/drafts/aci-prototype-contract.md §7）。
 *
 * 行为：
 *   - 入口先 isAllowedCommand 自保（即使权限层漏放也不会落库）；
 *   - 再 isDangerousCommand 自保（双保险）；
 *   - 用 node:child_process.exec 在 cwd=sandboxDir 走 shell 执行；
 *   - 捕获 stdout / stderr / exit code，各截断 ~4000 字符；
 *   - 超时由 Executor 外包（不在本工具内 setTimeout，避免引入被禁概念）。
 *
 * 边界：
 *   - 不修改冻结 4-tool 协议；返回 AciToolDef 扩展层；
 *   - 返回值 JSON-compatible（无 undefined / Error instance）。
 */

import { exec } from "node:child_process";

import type { AciToolDef } from "../types.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import { ToolExecutionError } from "../../errors.js";
import {
  isAllowedCommand,
  isDangerousCommand,
} from "../permission.js";

const MAX_OUTPUT_CHARS = 4000;

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}\n[truncated ${s.length - n} chars]`;
}

/**
 * 工厂：createShellExecTool(sandboxDir) — 沙箱执行工具。
 *
 * 不在 allowlist / 命中黑名单 → 立即拒绝；安全命令走 shell 执行并返回
 * code/stdout/stderr。子进程通过 ctx?.signal 接受取消信号。
 */
export function createShellExecTool(sandboxDir: string): AciToolDef {
  const handler = (
    input: unknown,
    ctx?: ToolExecutionContext,
  ): Promise<unknown> => {
    const obj = input as { command?: unknown };
    if (typeof obj?.command !== "string" || obj.command.length === 0) {
      return Promise.reject(
        new ToolExecutionError("shell_exec: command must be a non-empty string"),
      );
    }
    const cmd = obj.command;

    // 主门 allowlist：首 token + 无 shell 元字符
    if (!isAllowedCommand(cmd)) {
      return Promise.reject(
        new ToolExecutionError(
          `shell_exec: command not in allowlist: ${cmd}`,
        ),
      );
    }
    // 黑名单双保险（即便 allowlist 已挡，再扫一次）
    if (isDangerousCommand(cmd)) {
      return Promise.reject(
        new ToolExecutionError(
          `shell_exec: dangerous command rejected: ${cmd}`,
        ),
      );
    }

    return new Promise((resolveP) => {
      exec(
        cmd,
        {
          cwd: sandboxDir,
          env: { PATH: process.env.PATH ?? "" }, // env 净化：只透传 PATH
          signal: ctx?.signal, // 透传取消信号（防超时/取消时子进程泄漏）
          windowsHide: true,
        },
        (err, stdout, stderr) => {
          // exec 失败时 err.code 可能是 number；成功时 code = 0。
          const code = typeof (err as { code?: unknown })?.code === "number"
            ? ((err as { code: number }).code as number)
            : err
              ? 1
              : 0;
          resolveP({
            code,
            stdout: truncate(String(stdout ?? ""), MAX_OUTPUT_CHARS),
            stderr: truncate(String(stderr ?? ""), MAX_OUTPUT_CHARS),
          });
        },
      );
    });
  };

  return Object.freeze({
    name: "shell_exec",
    description:
      "Execute an allowlisted shell command in sandboxDir. Allowlist + blacklist double-check; cwd is not a security boundary.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
    handler,
    aci: {
      category: "execute" as const,
      isReadOnly: false,
      isDestructive: true,
      isConcurrencySafe: false,
      interruptBehavior: "cancel" as const,
    },
  });
}