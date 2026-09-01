/**
 * T2 (plans/worktree-mcp-rebind-lifecycle.md) — MCP 双根解析器。
 *
 * 唯一根策略点:session worktree rebind 前后,MCP 的 stdio cwd / 工具 FS root
 * 与配置根都由这里派生,调用方(config / manager / build-engine / hub / CLI /
 * TUI)只消费返回值,不再自行拼路径、读 `process.cwd()` 或判断 task worktree。
 *
 *  - `workspaceRoot`:当前 session/task root——stdio child 的 cwd,也是工具 FS root;
 *    rebind 后指向 `<productRoot>/.iknow/worktrees/<conversationId>`。
 *  - `mcpConfigRoot`:**只**由稳定的 `productRoot`(首次装配捕获的主 checkout)
 *    派生,跨 rebind 不变;项目级配置只读 `<mcpConfigRoot>/.iknow/mcp.json`。
 *
 * 纯函数:不读 git、不碰文件系统、不持会话状态。缺根 / 空白 / 相对 /
 * 无法规范化 / 与既有根不一致一律 fail-closed 抛 `McpLifecycleError`
 * (kinds 见 `src/harness/errors.ts`),**绝不**回退 `process.cwd()`。
 */
import path from "node:path";

import { McpLifecycleError } from "../errors.js";
import type { McpLifecycleErrorKind } from "../errors.js";

/** 诊断里回显根值的上限:长路径也要保持有限诊断。 */
const MAX_ROOT_DETAIL_CHARS = 120;

/** resolver 的唯一输出:两个已规范化的绝对根。 */
export interface McpRoots {
  readonly workspaceRoot: string;
  readonly mcpConfigRoot: string;
}

export interface ResolveMcpRootsInput {
  /** 当前 session/task root(rebind 后是 task worktree)。 */
  readonly workspaceRoot: string | undefined;
  /** 首次装配捕获的稳定主 checkout root;`mcpConfigRoot` 的唯一来源。 */
  readonly productRoot: string | undefined;
  /**
   * 已固定的根(显式 sandbox / ACI FS root,或 reload 时 active manager 的 cwd)。
   * 传入即参与校验:与解析出的 `workspaceRoot` 不一致 → `root_mismatch`。
   */
  readonly expectedWorkspaceRoot?: string | undefined;
}

/**
 * 解析双根。任何校验失败都在 config 读取 / spawn / 工具执行之前抛出。
 *
 * kind 分工:
 *  - 根缺席(未提供 / 非字符串)→ `missing_cwd`
 *  - `workspaceRoot`(含 `expectedWorkspaceRoot`)空白 / 非绝对 / 无法规范化 → `invalid_cwd`
 *  - `productRoot` 空白 / 非绝对 / 无法规范化 → `invalid_config_root`
 *  - `expectedWorkspaceRoot` 与解析结果不同 → `root_mismatch`
 */
export function resolveMcpRoots(input: ResolveMcpRootsInput): McpRoots {
  const workspaceRoot = normalizeRoot(
    input.workspaceRoot,
    "workspaceRoot",
    "invalid_cwd"
  );
  const mcpConfigRoot = normalizeRoot(
    input.productRoot,
    "productRoot",
    "invalid_config_root"
  );

  if (input.expectedWorkspaceRoot !== undefined) {
    const expected = normalizeRoot(
      input.expectedWorkspaceRoot,
      "expectedWorkspaceRoot",
      "invalid_cwd"
    );
    if (expected !== workspaceRoot) {
      const half = MAX_ROOT_DETAIL_CHARS / 2;
      throw new McpLifecycleError(
        "root_mismatch",
        `expected workspace root ${quoteRoot(expected, half)} does not match resolved workspace root ${quoteRoot(workspaceRoot, half)}`
      );
    }
  }

  return { workspaceRoot, mcpConfigRoot };
}

/** 缺席 → `missing_cwd`;在场但不可用 → 调用方指定的 invalid kind。 */
function normalizeRoot(
  value: string | undefined,
  label: string,
  invalidKind: McpLifecycleErrorKind
): string {
  if (typeof value !== "string") {
    throw new McpLifecycleError(
      "missing_cwd",
      `${label} is required and was not provided`
    );
  }

  const trimmed = value.trim();
  if (trimmed === "" || trimmed.includes("\0")) {
    throw new McpLifecycleError(
      invalidKind,
      `${label} must be a normalizable absolute path, got ${quoteRoot(trimmed, MAX_ROOT_DETAIL_CHARS)}`
    );
  }

  const normalized = stripTrailingSeparators(path.normalize(trimmed));
  if (!path.isAbsolute(normalized)) {
    throw new McpLifecycleError(
      invalidKind,
      `${label} must be an absolute path, got ${quoteRoot(trimmed, MAX_ROOT_DETAIL_CHARS)}`
    );
  }
  return normalized;
}

/** 去掉结尾分隔符,但保留文件系统根本身(posix `/`、win32 `C:\`)。 */
function stripTrailingSeparators(p: string): string {
  const { root } = path.parse(p);
  let out = p;
  while (
    out.length > root.length &&
    (out.endsWith(path.sep) || out.endsWith("/"))
  ) {
    out = out.slice(0, -1);
  }
  return out;
}

/** 诊断回显:截断到有限长度,避免超长路径撑爆错误消息。 */
function quoteRoot(value: string, limit: number): string {
  const shown = value.length > limit ? `${value.slice(0, limit)}…` : value;
  return `'${shown}'`;
}
