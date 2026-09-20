/**
 * Pure logic layer for the picker's subdirectory browser.
 *
 * Extracts the two decisions from the React component — "pick the base
 * default" and "split a path into breadcrumbs" — so node-env unit tests
 * cover them without jsdom / fetch. The component only renders and handles
 * side effects; the behavior contracts live here.
 *
 * Naming: "Browser" not "Browse" — `browse` is the verb
 * (`listWorkspaceSubdirs`); `browser` is the component / pure-function layer.
 */

/**
 * Minimal WSL probe — simply hardcoded to `/home/winner`. WSL path
 * translation (\\wsl$\Ubuntu\... ↔ /home/winner/...) is explicitly out of
 * scope. A later v2 with dynamic probing
 * (`navigator.userAgent` containing "Linux", or reading /proc/version via
 * backend) only needs to replace this constant; call sites stay put.
 */
export const WSL_DEFAULT_BASE = "/home/winner";

/**
 * Base default resolution when the picker mounts:
 *  - currentRoot wins (if already bound, the user changes it on purpose;
 *    don't jump back to the default every time the picker opens).
 *  - no currentRoot → WSL_DEFAULT_BASE.
 *
 * Empty / whitespace-only input counts as absent (currentRoot is normalized
 * via `?? ""`; "" / "   " take the fallback).
 */
export function resolveBrowserRoot(
  currentRoot: string | null,
  defaultBase: string = WSL_DEFAULT_BASE
): string {
  if (currentRoot && currentRoot.trim().length > 0) return currentRoot;
  return defaultBase;
}

/** One breadcrumb segment: name (displayed) + path (absolute path passed to browse on click). */
export interface BreadcrumbSegment {
  readonly name: string;
  readonly path: string;
}

/**
 * Split an absolute path into breadcrumb segments
 * ([/, home, winner, projects, iknow]).
 *  - POSIX `/a/b/c` → 5 segments including the root `/`.
 *  - Root `/` → single `{"name":"/", "path":"/"}` (the picker always shows ≥1 segment).
 *  - Empty string → same fallback, aligned with WorkspaceChip.basename.
 *  - Windows backslash paths split on `\\` (useless over WSL, but the picker
 *    basename accepts them; accepting here too avoids two inconsistent
 *    forms inside the picker).
 *
 * Odd segments (`/foo/..`, double slashes) are kept verbatim, no normalize —
 * a failing browse surfaces as a backend 422 through the onNotice channel
 * instead of being silently fixed in the frontend.
 */
export function breadcrumbs(path: string): ReadonlyArray<BreadcrumbSegment> {
  const trimmed = path.trim();
  if (trimmed === "") {
    return [{ name: "/", path: "/" }];
  }
  const isWindows = path.includes("\\") && !path.startsWith("/");
  // Split on "/" uniformly; backslashes are converted to forward slashes first
  const normalized = isWindows ? trimmed.replace(/\\/g, "/") : trimmed;
  const parts = normalized.split("/").filter((p) => p.length > 0);
  // root: "/"
  const segs: BreadcrumbSegment[] = [{ name: "/", path: "/" }];
  let acc = "";
  for (const p of parts) {
    acc += "/" + p;
    segs.push({ name: p, path: acc });
  }
  return segs;
}

/**
 * Value to put in the input when a subdir entry (`{name, path}`) is clicked.
 * Take `path` (the backend-given absolute path) as-is — it is the SSOT; no
 * re-`join`, which would risk path-splitting errors.
 */
export function entryToInputPath(entry: {
  readonly name: string;
  readonly path: string;
}): string {
  return entry.path;
}
