#!/usr/bin/env node

// Dev-mode stdio launcher for the trace MCP server.
//
// Purpose (plan `trace-mcp-read-side-split` T8): `.iknow/mcp.json` wants to
// start the MCP server from any cwd. The bin `iknow-trace-mcp` requires a
// built `dist/`, which a dev workflow does not always have. This wrapper
// resolves both the script directory and the trace directory relative to the
// repo root, so the host's cwd no longer enters the equation.
//
// Usage:
//   node scripts/iknow-trace-mcp-dev.cjs [--trace-out <dir>]

const { spawn } = require("node:child_process");
const { resolve } = require("node:path");

const repoRoot = resolve(__dirname, "..");
const mainPath = resolve(repoRoot, "src", "trace-mcp", "main.ts");
// Resolve the tsx loader through its absolute path: when this wrapper is
// invoked from a foreign cwd (the T8 case), `node --import tsx/esm` cannot
// find `tsx/esm` because it walks up from cwd, not from this script. The
// loader package lives next to us in `node_modules/tsx`; its exports field
// maps `tsx/esm` to `dist/esm/index.mjs`.
const tsxEsmPath = resolve(
  repoRoot,
  "node_modules",
  "tsx",
  "dist",
  "esm",
  "index.mjs"
);

const child = spawn(
  process.execPath,
  ["--import", tsxEsmPath, mainPath, ...process.argv.slice(2)],
  { stdio: "inherit" }
);

child.once("error", (error) => {
  console.error(`iknow-trace-mcp-dev: ${error.message}`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
