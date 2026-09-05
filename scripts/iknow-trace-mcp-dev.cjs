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
// Resolve the tsx loader through Node's resolver anchored at the repo root:
// when this wrapper is invoked from a foreign cwd (the T8 case), `node
// --import tsx/esm` cannot find `tsx/esm` because it walks up from cwd, not
// from this script. require.resolve walks up from the repo root itself, so it
// finds `node_modules/tsx` installed at the repo root AND hoisted to an
// ancestor (project worktrees share the main checkout's node_modules — a
// pinned absolute path breaks there), and it honours the package exports map
// so the dist path can't drift across tsx versions.
let tsxEsmPath;
try {
  tsxEsmPath = require.resolve("tsx/esm", { paths: [repoRoot] });
} catch {
  // tsx not installed anywhere up the chain: keep the legacy pinned path so
  // node reports the same ERR_MODULE_NOT_FOUND as before.
  tsxEsmPath = resolve(
    repoRoot,
    "node_modules",
    "tsx",
    "dist",
    "esm",
    "index.mjs"
  );
}

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
