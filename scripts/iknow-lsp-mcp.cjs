#!/usr/bin/env node

const { spawn } = require("node:child_process");
const { resolve } = require("node:path");

const child = spawn(
  process.execPath,
  [
    resolve(__dirname, "..", "dist", "lsp-mcp", "main.js"),
    ...process.argv.slice(2),
  ],
  { stdio: "inherit" }
);

child.once("error", (error) => {
  console.error(`iknow-lsp-mcp: ${error.message}`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
