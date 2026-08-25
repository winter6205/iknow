/**
 * #121 T3: discovery.ts (read-side metadata scanner for the static layer).
 *
 * Spec: specs/121-memory-injection.md (Project Structure discovery.ts, Testing
 * Strategy discovery half). Returns mtime + size metadata only — NEVER reads
 * file content (content loading is assembly.ts's job in T4).
 *
 * v0 design choices:
 *   - symlinks: rejected (v0 find filters them out — spec OQ5 explicitly leaves
 *     symlink resolution to a future ticket; same choice).
 *   - non-UTF-8: skipped + stderr warning (spec Boundaries Always — 坏文件跳过
 *     不中断会话; assembly still needs valid UTF-8 for body).
 *   - rules: filename asc sort (deterministic order → stable assembly output).
 */
import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { MemoryIOError } from "./errors.js";

/** Metadata-only entry; content stays on disk until assembly.ts reads it. */
export interface MemoryLayerEntry {
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
}

/** Read dir entries synchronously and return them in deterministic order. */
async function* safeDir(path: string): AsyncIterable<string> {
  let dir;
  try {
    dir = await opendir(path);
  } catch {
    return;
  }
  // for await over a Dir auto-closes the handle on completion.
  for await (const e of dir) yield e.name;
}

/** Build a MemoryLayerEntry for a path if it exists; null otherwise. */
async function tryReadEntry(path: string): Promise<MemoryLayerEntry | null> {
  try {
    // lstat so we can detect symlinks without following them (spec OQ5 v0
    // rejects symlinks; same choice).
    const s = await lstat(path);
    if (s.isSymbolicLink()) return null;
    if (!s.isFile()) return null;
    return { path, mtimeMs: s.mtimeMs, size: s.size };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new MemoryIOError(`discovery: lstat failed for ${path}`, {
      cause: e,
    });
  }
}

/** Project-level AGENTS.md (<cwd>/AGENTS.md). */
export async function findProjectAgents(
  cwd: string
): Promise<MemoryLayerEntry | null> {
  return tryReadEntry(join(cwd, "AGENTS.md"));
}

/** User-level AGENTS.md (~/.iknow/AGENTS.md). */
export async function findUserAgents(
  userHome: string
): Promise<MemoryLayerEntry | null> {
  return tryReadEntry(join(userHome, ".iknow", "AGENTS.md"));
}

/** Return all *.md entries under the matching rules dir, sorted by filename asc. */
export async function listRulesFiles(
  cwd: string,
  scope: "user" | "project"
): Promise<ReadonlyArray<MemoryLayerEntry>> {
  // Both scopes live under `<root>/.iknow/rules/` — for scope 'user' the first
  // arg is the user home (~), for 'project' it is the project cwd. The `.iknow`
  // suffix is identical for both (spec OQ5: user/project rules both glob
  // `.iknow/rules/*.md`).
  const rulesDir = join(cwd, ".iknow", "rules");
  const names: string[] = [];
  for await (const name of safeDir(rulesDir)) {
    if (name.endsWith(".md")) names.push(name);
  }
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const out: MemoryLayerEntry[] = [];
  for (const name of names) {
    const fullPath = join(rulesDir, name);
    const entry = await tryReadEntry(fullPath);
    if (entry === null) continue;
    // v0: skip non-UTF-8 files (warn on stderr so perms layer can surface it).
    try {
      const { readFile } = await import("node:fs/promises");
      const buf = await readFile(fullPath);
      // Buffer.toString('utf8') is lossy for invalid sequences — Node replaces
      // with U+FFFD, which is detectable in the round-trip length.
      const text = buf.toString("utf8");
      const decoded = Buffer.from(text, "utf8");
      if (decoded.length !== buf.length) {
        process.stderr.write(
          `[memory/discovery] skipping non-UTF-8 ${scope} rule: ${fullPath}\n`
        );
        continue;
      }
    } catch {
      continue;
    }
    out.push(entry);
  }
  return out;
}
