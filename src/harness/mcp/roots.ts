/**
 * T2 (plans/worktree-mcp-rebind-lifecycle.md) — MCP 双根解析器。
 *
 * **消费者，不是根策略点**：规范化与 fail-closed 规则的 SSOT 已升格为
 * `harness/session-roots.ts` 的会话三根（T2, plans/worktree-session-roots.md /
 * ADR-0037 §4）。本模块只做 MCP 侧的**投影与错误映射**：
 *
 *  - `workspaceRoot`（MCP 说法）= 会话 `taskRoot`——stdio child 的 cwd，也是
 *    工具 FS root；rebind 后指向 `<productRoot>/.iknow/worktrees/<conversationId>`。
 *  - `mcpConfigRoot` = 会话 `productRoot`（首次装配捕获的主 checkout），跨
 *    rebind 不变；项目级配置只读 `<mcpConfigRoot>/.iknow/mcp.json`。
 *
 * 纯函数：不读 git、不碰文件系统、不持会话状态。缺根 / 空白 / 相对 /
 * 无法规范化 / 与既有根不一致一律 fail-closed 抛 `McpLifecycleError`
 * (kinds 见 `src/harness/errors.ts`)，**绝不**回退 `process.cwd()`。kind 分工
 * 与消息文本对既有调用方逐字节不变——`installRoot` 不参与 MCP 面。
 */
import { McpLifecycleError } from "../errors.js";
import type { McpLifecycleErrorKind } from "../errors.js";
import {
  MAX_ROOT_DETAIL_CHARS,
  normalizeRootCandidate,
  quoteRoot,
} from "../session-roots.js";

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
  const result = normalizeRootCandidate(value);
  if (result.ok) return result.root;

  const { rejection } = result;
  if (rejection.reason === "missing") {
    throw new McpLifecycleError(
      "missing_cwd",
      `${label} is required and was not provided`
    );
  }
  const requirement =
    rejection.reason === "not_absolute"
      ? "must be an absolute path"
      : "must be a normalizable absolute path";
  throw new McpLifecycleError(
    invalidKind,
    `${label} ${requirement}, got ${quoteRoot(rejection.shown, MAX_ROOT_DETAIL_CHARS)}`
  );
}
