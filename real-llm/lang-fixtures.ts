import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";

/**
 * Non-TypeScript fixtures for the ADR-0117 role-substitution real-model set
 * (#1078 golden set, #1089 sections B/C4 and the sampling probe).
 *
 * Tracked here on purpose: `.evals/` is gitignored, so on a clean clone the
 * python/go arm of the set would otherwise be pointed at files that do not
 * exist, and a run would measure the model's reaction to a missing file rather
 * than the gate's behaviour on Go/Rust keywords. Consumers call
 * `ensureLangFixtures` and get back the paths it had to (re)create.
 *
 * Line numbers are part of the contract, asserted by the real-model cases:
 * `def build_report` @6, `DRAFT_MARKER` @3 and @7, `const draftMarker` @7,
 * `func buildReport` @9, `func main` @13.
 */
export const LANG_FIXTURES: Readonly<Record<string, string>> = {
  ".evals/fixtures/lang/report.py": [
    '"""Non-TypeScript fixture for the ADR-0117 boundary walk-through (#1089 C4)."""',
    "",
    'DRAFT_MARKER = "draft"',
    "",
    "",
    "def build_report(rows):",
    '    """Return the rendered report text for the given rows."""',
    '    lines = [f"# {DRAFT_MARKER} report"]',
    "    for name, count in rows:",
    '        lines.append(f"- {name}: {count}")',
    '    return "\\n".join(lines)',
    "",
    "",
    "def summarize(rows):",
    "    total = sum(count for _, count in rows)",
    '    return {"total": total, "report": build_report(rows)}',
    "",
  ].join("\n"),
  ".evals/fixtures/lang/main.go": [
    "// Package main is a non-TypeScript fixture for the ADR-0117 boundary",
    "// walk-through (#1089 C4): Go keywords must not trip the structure-shaped gate.",
    "package main",
    "",
    'import "fmt"',
    "",
    'const draftMarker = "draft"',
    "",
    "func buildReport(rows int) string {",
    '\treturn fmt.Sprintf("%s report over %d rows", draftMarker, rows)',
    "}",
    "",
    "func main() {",
    "\tfmt.Println(buildReport(3))",
    "}",
    "",
  ].join("\n"),
};

/** Write only what is missing; returns the relative paths created. */
export async function ensureLangFixtures(root: string): Promise<string[]> {
  const created: string[] = [];
  for (const [rel, body] of Object.entries(LANG_FIXTURES)) {
    const path = join(root, rel);
    if (existsSync(path)) continue;
    await mkdir(dirname(path), { recursive: true });
    writeFileSync(path, body);
    created.push(rel);
  }
  return created;
}
