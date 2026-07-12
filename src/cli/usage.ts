/**
 * CLI usage / version strings (stdout).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FALLBACK_VERSION = "0.1.0";

/** Resolve package version from package.json; fall back to 0.1.0. */
export function getVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // src/cli or dist/cli → repo root
    const pkgPath = join(here, "..", "..", "package.json");
    const raw = readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    if (typeof pkg.version === "string" && pkg.version.length > 0) {
      return pkg.version;
    }
    return FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

/** Full usage text (no trailing newline required by caller). */
export function usageText(): string {
  const v = getVersion();
  return `iknow ${v} — enterprise knowledge-base Q&A agent

Usage:
  iknow                         Interactive chat (TTY only)
  iknow chat [options]          Interactive / piped chat session
  iknow ask "<query>" [options] One-shot answer as JSON (scripts)
  iknow "<query>" [options]     One-shot answer as JSON (compat)
  iknow -h | --help             Show this help

Options:
  --mode deterministic|llm      Agent mode (default: deterministic / env)
  --role employee|manager|admin Caller role (default: employee)
  --embeddings                  Enable embedding vector arm
  --json                        Chat: start with JSON answer output
  --governance-timeout          Simulate governance timeout degrade path

Chat commands (inside session):
  /help  /status  /quit  /json on|off  /role <r>  /mode <m>  /reset

Notes:
  • No args on a TTY opens chat; no args when piped prints usage.
  • ask / bare query with empty text exits 1 (no default demo query).
  • One-shot always prints G2 JSON on stdout; chat human view is default.`;
}

/** Print usage to stdout. */
export function printUsage(): void {
  process.stdout.write(`${usageText()}\n`);
}
