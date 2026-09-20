/**
 * command-probe — pure function for automatic verify-command detection.
 *
 * Pure layer: zero IO, zero LLM, zero fs. The caller reads candidate files
 * and flattens their content (or paths) into this call; here only shape
 * recognition and JSON parsing happen.
 *
 * Two-shape contract for the files array (why — callers hold fs access, this
 * function stays pure computation):
 *   - flag file names (plain path strings, not starting with {):
 *       pyproject.toml | pytest.ini | go.mod | Cargo.toml
 *     a hit maps directly to its framework (`package.json` as a bare path
 *     contributes nothing — without file content the deps are unknowable,
 *     fail-closed: never guess);
 *   - package.json JSON content strings (start with {): caller reads and
 *     passes them; we parse and look for vitest / jest in `dependencies` /
 *     `devDependencies`; found → matching runner; absent / parse failure →
 *     no contribution.
 *
 * Conflict rule (fail-closed, "never guess"): >= 2 candidate commands → null;
 * 0 candidates → null; exactly 1 → that command. Multiple flag files
 * (pyproject+go.mod), dual deps in one package.json (vitest+jest), split
 * entries (one vitest + one jest), or mixed content+flag all → null.
 */

/** Flag file name → default verify command. */
const FLAG_FILE_COMMANDS: ReadonlyMap<string, string> = new Map([
  ["pyproject.toml", "pytest"],
  ["pytest.ini", "pytest"],
  ["go.mod", "go test ./..."],
  ["Cargo.toml", "cargo test"],
]);

/**
 * Parse a package.json content string and collect candidate commands from
 * vitest / jest hits in dependencies and devDependencies. Parse failure /
 * shape mismatch → empty set (no candidates contributed; fail-closed, never a
 * silent pass).
 */
function packageJsonCandidates(content: string): ReadonlySet<string> {
  const out = new Set<string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object") return out;
  const obj = parsed as { dependencies?: unknown; devDependencies?: unknown };
  for (const field of ["dependencies", "devDependencies"] as const) {
    const deps = obj[field];
    if (!deps || typeof deps !== "object") continue;
    for (const name of Object.keys(deps as Record<string, unknown>)) {
      if (name === "vitest") out.add("npx vitest run");
      else if (name === "jest") out.add("npx jest");
    }
  }
  return out;
}

/**
 * probeVerifyCommand — main detection entry.
 * Returns the unique candidate command, or null (no candidate / conflict /
 * parse failure — all fail-closed).
 */
export function probeVerifyCommand(
  files: ReadonlyArray<string>
): string | null {
  const candidates = new Set<string>();
  for (const file of files) {
    if (file.startsWith("{")) {
      // package.json content shape: parse, then check dep hits.
      for (const cmd of packageJsonCandidates(file)) {
        candidates.add(cmd);
        if (candidates.size > 1) return null;
      }
    } else {
      // Flag-file-name shape: static table lookup; a hit is the command.
      const cmd = FLAG_FILE_COMMANDS.get(file);
      if (cmd !== undefined) {
        candidates.add(cmd);
        if (candidates.size > 1) return null;
      }
    }
  }
  if (candidates.size !== 1) return null;
  return candidates.values().next().value ?? null;
}
