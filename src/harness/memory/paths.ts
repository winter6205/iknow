/**
 * #121 T2: memory dir path resolvers (Paths bounded context).
 *
 * Spec: specs/121-memory-injection.md (Project Structure paths.ts, SC 6,
 * Boundaries Always — user-level root ALWAYS = ~/.iknow, decoupled from
 * --data-dir).
 *
 * Naming rule reuses session-store.ts:42-45
 * `<basename(cwd)>-<sha1(cwd)[:12]>` but lives under `~/.iknow/memory/` (user
 * level) rather than the project-level session pool. Pure: no IO.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

/**
 * Project namespace under the user-level memory root. Normalize cwd first
 * (path.resolve) so `foo` and `./foo` collapse to the same hash, and so the
 * digest is stable across calls.
 */
export function resolveProjectMemoryDir(cwd: string): string {
  const normalized = resolve(cwd);
  const hash = createHash("sha1").update(normalized).digest("hex").slice(0, 12);
  return join(homedir(), ".iknow", "memory", `${basename(normalized)}-${hash}`);
}

/** User-level memory root. Independent of cwd and --data-dir. */
export function resolveUserMemoryDir(): string {
  return join(homedir(), ".iknow", "memory");
}
