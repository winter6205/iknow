#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createLspMcpServer } from "./server.js";
import { LspMcpRootError, resolveLspRoot, validateLspRoot } from "./root.js";

export function startLspMcp(
  argv: readonly string[] = process.argv.slice(2),
  env = process.env
): void {
  try {
    const directory = validateLspRoot(resolveLspRoot(argv, env));
    const { server, pool } = createLspMcpServer({
      directory,
      warmup: true,
    });
    const dispose = (): void => {
      void pool.disposeAll();
    };
    process.once("SIGTERM", dispose);
    process.once("SIGINT", dispose);
    serveStdio(() => server, {
      onerror: (error) => {
        console.error(`iknow-lsp-mcp: ${error.message}`);
      },
    });
  } catch (error: unknown) {
    const message =
      error instanceof LspMcpRootError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    console.error(`iknow-lsp-mcp: ${message}`);
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
  } catch (error: unknown) {
    if (error instanceof Error) return false;
    throw error;
  }
}

if (isMainModule()) {
  startLspMcp();
}
