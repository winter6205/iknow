/**
 * serve-workspace T2 — subdirectory probe (pure function + IO boundary).
 *
 * Wire contract (`GET /api/v1/workspaces/browse?root=<abs-existing-dir>`):
 *  - 200 → `{ entries: ReadonlyArray<{ name, path }> }` (direct subdirs only,
 *    hidden + deny-list filtered, sorted lexicographically by name).
 *  - 422 typed `validation` for missing / empty / non-absolute /
 *    non-existent / not-a-directory / permission-denied root.
 *
 * Why a pure function with a tagged union result (instead of throwing
 * typed errors):
 *  - The HTTP layer maps each failure kind to a single wire status
 *    (422 validation); the `kind` discriminates only the *internal*
 *    recovery hint, never leaks past `validation`. Throwing typed
 *    errors (like WorkspaceRootError) is overkill here because no
 *    caller needs to branch on the failure mode beyond "ok / not-ok".
 *  - Mirrors the `SessionListEntry`-shaped surface (`tryListEntry`'s
 *    `null` sentinel for "skip this entry"); the call site at the HTTP
 *    boundary never needs to `catch` to recover.
 *
 * Deny-list is hard-coded (≥ `{ ".git", ".claude", "node_modules" }`) per
 * plan T2 acceptance; an env var extension is explicitly out of scope.
 *
 * Symlink policy: NOT followed. `Dirent.isDirectory()` returns the
 * lstat-classified bit, so a symlink to a directory will be silently
 * dropped from the entry list — consistent with `readdir(path, { withFileTypes: true })`
 * on Linux/macOS which does NOT follow by default. (Windows behavior can
 * differ; see tests for the documented contract.)
 */
import { readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/** Single browse entry: subdirectory leaf name + absolute path under root. */
export interface BrowseEntry {
  readonly name: string;
  readonly path: string;
}

/**
 * Tagged union result.
 *  - `ok: true` carries `entries` (may be empty for an empty directory).
 *  - `ok: false` carries a single `message` for the wire body. The wire
 *    layer always emits `kind: "validation"` and HTTP 422; there is no
 *    second branch the caller can take today, so we keep the shape flat
 *    and add a discriminator only when one is actually needed.
 */
export type BrowseResult =
  | { readonly ok: true; readonly entries: ReadonlyArray<BrowseEntry> }
  | { readonly ok: false; readonly message: string };

/**
 * Hard-coded deny list (≥ { ".git", ".claude", "node_modules" } per plan
 * T2 acceptance). Exported for the test surface; intentionally NOT
 * configurable in v1 (env-extensibility is explicitly out of scope).
 */
export const BROWSE_DENY_NAMES: ReadonlySet<string> = new Set([
  ".git",
  ".claude",
  "node_modules",
]);

/**
 * List direct subdirectories of `root`. Pure I/O wrapper; never throws —
 * every failure mode is folded into the `ok: false` branch so callers
 * (HTTP layer, future TUI integrations) don't need a try/catch.
 *
 * Path policy:
 *  - absolute required (`path.isAbsolute`).
 *  - existing directory required (mkdir-not-found → validation;
 *    regular file → validation).
 *  - permission denied (EACCES / EPERM on readdir) → validation
 *    (NOT io_error / internal). The wire keeps a single 422 surface;
 *    the recovery hint lives in `message`.
 *
 * Filters applied:
 *  - `name.startsWith(".")` → excluded (hidden).
 *  - `BROWSE_DENY_NAMES.has(name)` → excluded.
 *  - non-directory Dirent → excluded (files + symlinks-to-dir, since
 *    `Dirent.isDirectory()` returns the lstat bit on Linux/macOS).
 *
 * Sort: ascending lexicographic by `name` (matches `readdir` ordering
 * with a stable JS sort, kept simple — `String.prototype.localeCompare`
 * would add a locale dep we don't need).
 */
export async function listSubdirectories(root: string): Promise<BrowseResult> {
  if (root === "") {
    return { ok: false, message: "root is empty" };
  }
  if (!isAbsolute(root)) {
    return {
      ok: false,
      message: `root must be an absolute path (got: ${root})`,
    };
  }

  let dirents;
  try {
    dirents = await readdir(root, { withFileTypes: true });
  } catch (err) {
    return readdirFailure(root, err);
  }

  const entries: BrowseEntry[] = [];
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    if (d.name.startsWith(".")) continue;
    if (BROWSE_DENY_NAMES.has(d.name)) continue;
    entries.push({ name: d.name, path: join(root, d.name) });
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { ok: true, entries };
}

/**
 * Map a readdir() rejection to the typed validation surface. All fs
 * errors at this layer are wired as `validation` (422); the HTTP layer
 * must never bubble them as 500. We surface the cause via message only —
 * the wire discriminator is owned by `ApiErrorBody.kind`.
 */
function readdirFailure(root: string, err: unknown): BrowseResult {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  switch (code) {
    case "ENOENT":
      return { ok: false, message: `root not found: ${root}` };
    case "ENOTDIR":
      return { ok: false, message: `root is not a directory: ${root}` };
    case "EACCES":
    case "EPERM":
      return { ok: false, message: `root is not readable: ${root}` };
    default:
      return { ok: false, message: `cannot list root: ${root}` };
  }
}
