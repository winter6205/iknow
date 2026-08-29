import { statSync } from "node:fs";
import { resolve } from "node:path";

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
  } catch {
    throw new Error(`trace directory does not exist: ${resolved}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`trace path is not a directory: ${resolved}`);
  }
  return resolved;
}
