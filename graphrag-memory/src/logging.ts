/**
 * Minimal structured logger for graphrag-memory.
 *
 * Why: this package is decoupled from iknow and must not import its
 * runtime utilities. A leveled wrapper around `console.*` is the
 * smallest honest thing — no external logger dep, no async writes,
 * no JSON line protocol until we need one.
 *
 * Logs go to stderr to keep stdout reserved for the MCP stdio transport.
 * Never log secrets; callers are responsible for redacting.
 */
import type { LogLevel } from "./config.js";

const ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  level: LogLevel;
  debug: (msg: string, fields?: Record<string, unknown>) => void;
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  error: (msg: string, fields?: Record<string, unknown>) => void;
}

function emit(
  level: LogLevel,
  threshold: LogLevel,
  msg: string,
  fields?: Record<string, unknown>
): void {
  if (ORDER[level] < ORDER[threshold]) return;
  const line = fields
    ? `${level.toUpperCase()} ${msg} ${JSON.stringify(fields)}`
    : `${level.toUpperCase()} ${msg}`;
  // stderr keeps stdout clean for the MCP stdio transport.
  (level === "error" ? process.stderr : process.stderr).write(line + "\n");
}

export function createLogger(level: LogLevel): Logger {
  return {
    level,
    debug: (msg, fields) => emit("debug", level, msg, fields),
    info: (msg, fields) => emit("info", level, msg, fields),
    warn: (msg, fields) => emit("warn", level, msg, fields),
    error: (msg, fields) => emit("error", level, msg, fields),
  };
}
