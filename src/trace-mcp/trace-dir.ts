import { statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * review-fix (L-tracedir):trace-mcp stdio MCP 入口的**旧 wire 默认** —— 该
 * MCP server 是独立进程(T1 之前形态,见 `iknow-trace-mcp` bin),其 argv
 * `--trace-out` 或 env `IKNOW_TRACE_OUT` 都缺省时的退路;不在本仓库 serve
 * 路径的 `resolveServeDataDir()` 默认链上(T1 已迁移)。
 *
 * 不改成 `resolveServeDataDir()` 同源 —— 该默认值在 trace-mcp stdio 进程
 * 上下文中不应触发数据目录派生(后者依赖 `dataDir / workspaceRoot` 派生,
 * trace-mcp 进程无 workspaceRoot 概念);保留 `./trace/` 退路保向下兼容。
 */
const DEFAULT_TRACE_DIR = "./trace/";

export interface TraceMcpEnvironment {
  readonly IKNOW_TRACE_OUT?: string;
}

export interface TraceMcpArgs {
  readonly traceOut?: string;
}

export function parseTraceMcpArgs(
  argv: readonly string[] = process.argv.slice(2)
): TraceMcpArgs {
  let traceOut: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--trace-out") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--trace-out requires a directory path");
      }
      if (value.trim().length === 0) {
        throw new Error("--trace-out must not be empty");
      }
      traceOut = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return traceOut === undefined ? {} : { traceOut };
}

export function resolveTraceDir(
  argv: readonly string[] = process.argv.slice(2),
  env: TraceMcpEnvironment = process.env
): string {
  const parsed = parseTraceMcpArgs(argv);
  const selected = parsed.traceOut ?? env.IKNOW_TRACE_OUT ?? DEFAULT_TRACE_DIR;
  if (selected.trim().length === 0) {
    throw new Error("IKNOW_TRACE_OUT must not be empty");
  }
  return selected;
}

export function validateTraceDir(traceDir: string): string {
  const resolved = resolve(traceDir);
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(resolved);
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      throw new Error(`trace directory does not exist: ${resolved}`, {
        cause: error,
      });
    }
    throw error;
  }
  if (!stats.isDirectory()) {
    throw new Error(`trace path is not a directory: ${resolved}`);
  }
  return resolved;
}
