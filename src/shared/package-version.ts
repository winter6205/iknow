/**
 * Package version reader (single source for the fallback constant).
 *
 * Shared by `src/cli/usage.ts` (CLI surface) and `src/traceserver/serve.ts`
 * (standalone health) so both report the same version for the same process.
 * Lives in `src/shared/` because traceserver must not reverse-import the CLI
 * module (ADR-0020 D1.4) while the duplication of two readers with diverging
 * fallbacks ("0.0.0" vs "0.1.0") was a review finding — one reader, one
 * fallback. Path depth is identical from `src/shared/` and `dist/shared/` to
 * the repo-root package.json.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FALLBACK_VERSION = "0.1.0";

/** Resolve package version from package.json; fall back to 0.1.0. */
export function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // src/shared or dist/shared → repo root
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
