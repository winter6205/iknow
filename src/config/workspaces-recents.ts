/**
 * serve-workspace T3 — workspaces recents + trust list (home-side).
 *
 * Persisted file: `<home>/.iknow/workspaces.json`
 *   {
 *     "rev": <number>,
 *     "recents": [
 *       { "root": "<abs path>", "lastUsedAt": "<ISO-8601>" },
 *       ...
 *     ]
 *   }
 *
 * Recents membership == trust (ADR-0023 rule 3: "recents 已信任").
 * The file is the single trust roster — paths outside it cannot be bound
 * without an explicit confirmTrust=true on the PUT.
 *
 * Concurrency: optimistic rev-CAS on every write. `saveWorkspacesRecents`
 * reads the current rev before writing; mismatch → `concurrent_write`.
 * Reads treat a missing file as the empty fresh state (rev:0).
 *
 * Errors are plain objects (`satisfies WorkspacesRecentsError`), never Error
 * instances, mirroring `WorkspaceRootError` / `SessionStoreError` discipline
 * so callers branch on `kind` and the typed-error renderer never prints
 * `[object Object]`.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Filename under `<home>/.iknow/`. */
export const WORKSPACES_RECENTS_FILENAME = "workspaces.json";

/** Initial rev for a fresh (missing) file. */
export const RECENTS_INITIAL_REV = 0;

export interface WorkspaceRecent {
  readonly root: string;
  readonly lastUsedAt: string;
}

export interface WorkspacesRecentsFile {
  readonly rev: number;
  readonly recents: readonly WorkspaceRecent[];
}

export type WorkspacesRecentsError =
  | { kind: "parse_failed"; cause: string }
  | { kind: "io_error"; cause: string }
  | {
      kind: "concurrent_write";
      expectedRev: number;
      actualRev: number;
    };

/**
 * Type guard (plain-object, shape-aware). Same `kind` strings exist in
 * `SessionStoreError` (parse_failed / io_error / concurrent_write) but with
 * `conversation_id` payloads — recents errors are home/file-level and NEVER
 * carry `conversation_id`, so requiring the shape (kind + payload field) is
 * what keeps http.ts's precedence (recents guard BEFORE SessionStoreError)
 * from misrouting a store error into the recents message.
 */
export function isWorkspacesRecentsError(
  err: unknown
): err is WorkspacesRecentsError {
  if (err === null || typeof err !== "object") return false;
  if (err instanceof Error) return false;
  const maybe = err as Record<string, unknown>;
  if (typeof maybe.kind !== "string") return false;
  if ("conversation_id" in maybe) return false;
  switch (maybe.kind) {
    case "parse_failed":
      return typeof maybe.cause === "string";
    case "io_error":
      return typeof maybe.cause === "string";
    case "concurrent_write":
      return (
        typeof maybe.expectedRev === "number" &&
        typeof maybe.actualRev === "number"
      );
    default:
      return false;
  }
}

/**
 * Test helper — narrows unknown into the typed error union or throws.
 * Mirrors `asWorkspaceRootError` in workspace-root.test.ts.
 */
export function asWorkspacesRecentsError(err: unknown): WorkspacesRecentsError {
  if (isWorkspacesRecentsError(err)) return err;
  throw new Error(
    `expected WorkspacesRecentsError, got: ${
      err instanceof Error ? err.message : String(err)
    }`
  );
}

/** Resolve the canonical path for a given home (DI). */
export function resolveWorkspacesPath(opts: { home?: string }): string {
  const home = opts.home ?? homedir();
  return join(home, ".iknow", WORKSPACES_RECENTS_FILENAME);
}

/**
 * Read the current recents file. Missing file → fresh empty state
 * (`rev: 0`, `recents: []`). Errors:
 *   - parse_failed — corrupt JSON or non-object top-level
 *   - io_error — filesystem failure (EISDIR, EACCES, ...)
 */
export async function loadWorkspacesRecents(opts: {
  home?: string;
}): Promise<WorkspacesRecentsFile> {
  const file = resolveWorkspacesPath(opts);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if (isEnoent(err)) {
      return { rev: RECENTS_INITIAL_REV, recents: [] };
    }
    throw {
      kind: "io_error",
      cause: errMsg(err),
    } satisfies WorkspacesRecentsError;
  }
  return parseRecentsFile({ file, raw });
}

interface ParseRecentsFileOpts {
  readonly file: string;
  readonly raw: string;
}

function parseRecentsFile(opts: ParseRecentsFileOpts): WorkspacesRecentsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(opts.raw);
  } catch (err) {
    throw {
      kind: "parse_failed",
      cause: errMsg(err),
    } satisfies WorkspacesRecentsError;
  }
  if (!isPlainObject(parsed)) {
    throw {
      kind: "parse_failed",
      cause: "top-level JSON must be an object",
    } satisfies WorkspacesRecentsError;
  }
  const recents = parsed["recents"];
  const rev = parsed["rev"];
  if (!Array.isArray(recents) || typeof rev !== "number") {
    throw {
      kind: "parse_failed",
      cause: "recents must be an array and rev must be a number",
    } satisfies WorkspacesRecentsError;
  }
  const out: WorkspaceRecent[] = [];
  for (const entry of recents) {
    if (!isPlainObject(entry)) continue; // discard malformed entry
    const root = entry["root"];
    const lastUsedAt = entry["lastUsedAt"];
    if (typeof root !== "string") continue;
    if (typeof lastUsedAt !== "string") continue;
    out.push({ root, lastUsedAt });
  }
  return { rev, recents: out };
}

/**
 * Atomic save with optimistic rev-CAS. Errors:
 *   - concurrent_write — file rev ≠ expectedRev at write time
 *   - io_error         — filesystem failure
 */
export async function saveWorkspacesRecents(opts: {
  readonly home?: string;
  readonly file: WorkspacesRecentsFile;
  readonly expectedRev: number;
}): Promise<WorkspacesRecentsFile> {
  const target = resolveWorkspacesPath(opts);
  const current = await loadWorkspacesRecents({ home: opts.home });
  if (current.rev !== opts.expectedRev) {
    throw {
      kind: "concurrent_write",
      expectedRev: opts.expectedRev,
      actualRev: current.rev,
    } satisfies WorkspacesRecentsError;
  }
  const bytes = `${JSON.stringify({ rev: opts.file.rev, recents: opts.file.recents }, null, 2)}\n`;
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(tmp, bytes, { encoding: "utf8", flag: "w" });
    await rename(tmp, target);
  } catch (err) {
    throw {
      kind: "io_error",
      cause: errMsg(err),
    } satisfies WorkspacesRecentsError;
  }
  return opts.file;
}

/**
 * Convenience: load → merge `root` (move to head, refresh `lastUsedAt`) →
 * save with rev CAS. Errors propagate from `loadWorkspacesRecents` /
 * `saveWorkspacesRecents`.
 */
export async function upsertWorkspaceRecent(opts: {
  readonly home?: string;
  readonly root: string;
  readonly lastUsedAt: string;
}): Promise<WorkspacesRecentsFile> {
  const current = await loadWorkspacesRecents({ home: opts.home });
  const filtered = current.recents.filter((r) => r.root !== opts.root);
  const next: WorkspaceRecent[] = [
    { root: opts.root, lastUsedAt: opts.lastUsedAt },
    ...filtered,
  ];
  return saveWorkspacesRecents({
    home: opts.home,
    file: { rev: current.rev + 1, recents: next },
    expectedRev: current.rev,
  });
}

// -- private helpers ----------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnoent(err: unknown): boolean {
  return (
    err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
