#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createTraceMcpServer } from "./server.js";
import { resolveTraceDir, validateTraceDir } from "./trace-dir.js";

export function startTraceMcp(
  argv: readonly string[] = process.argv.slice(2),
  env = process.env
): void {
  try {
    const traceDir = validateTraceDir(resolveTraceDir(argv, env));
    serveStdio(() => createTraceMcpServer({ traceDir }), {
      onerror: (error) => {
        console.error(`iknow-trace-mcp: ${error.message}`);
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`iknow-trace-mcp: ${message}`);
    process.exitCode = 1;
  }
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) return false;
  try {
    return (
      realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entrypoint)
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  startTraceMcp();
}
