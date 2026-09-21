/**
 * CI guard: verify the CI vitest exclude sets are self-consistent
 * (SSOT: `vitest.ci-excludes.ts`).
 *
 * After the exclude sets moved from workflow command strings into the SSOT
 * module, this script imports the module instead of grepping
 * `.github/workflows/test.yml`; the workflow only passes the matching config
 * overlay to vitest. Three checks:
 *
 *   Forward (bwrap dependency coverage): scan every vitest-collectable test
 *     file under tests/; any file hitting a bwrap-dependency anchor must be in
 *     the test-fast exclude aggregate (CI_EXCLUDES ∪ CI_FAST_EXCLUDES). This
 *     is the strictest necessary condition: test-fast does not install bwrap,
 *     so one miss fails loudly at assembly time. Not enforced per-job against
 *     test-full — the rationale is in the forward-check comment below (with
 *     bwrap installed, assembly-only files genuinely pass there).
 *
 *   Reverse (no dead entries): every entry in an exclude set must match at
 *     least one test file on disk (`dir/**` glob semantics). Entries pointing
 *     at deleted files are configuration rot — the illusion of "already
 *     excluded" hides what is really collected.
 *
 *   tests/tui ban: any exclude entry matching `tests/tui/` is an error. That
 *     directory runs under bun:test (OpenTUI native FFI requires bun) and
 *     vitest.config.ts already excludes `tests/tui/**`, so vitest never
 *     collects it — a tui entry is dead config for vitest. Historically the
 *     combination of a guard scanning all of tests/ plus tui entries added to
 *     silence its warnings produced dead entries; the forward scan domain is
 *     now narrowed to what vitest can collect and tui entries are judged
 *     violations outright.
 *
 * Background: GitHub Actions runners lack user-namespace → bwrap cannot
 * execute physically; but requireBwrap() throws already during assembly in
 * createBashTool / createDefaultAciRegistry / createWorkerDeps /
 * runInSandbox, so CI fails loudly at assembly time — including the past
 * regression where a bwrap-dependent test leaked into the exclude set and
 * reddened test-fast. This script makes CI alert immediately when such a
 * test is merged next (naming the missing file) instead of silently breaking
 * the PR flow.
 *
 * Anchors (hitting any one marks the file bwrap-dependent):
 *   - requireBwrap(...): explicit guard in src/harness/sandbox/runner.ts
 *   - runInSandbox(...): sandbox entry
 *   - createBashTool(...): bash tool constructor calls requireBwrap
 *   - createDefaultAciRegistry(...): ACI assembly → createBashTool
 *   - createWorkerDeps(...): subagent worker assembly → createBashTool
 *   - buildHarnessEngine(...): buildEngine → createDefaultAciRegistry
 *
 * Only call shapes match (`\bidentifier\s*\(`) to avoid false positives from
 * type-only imports or vi.mock paths — the real dependency is an assembly-time
 * requireBwrap throw, so only files actually invoking those factories fail
 * loudly.
 *
 * Usage: `npx tsx scripts/ci-check-test-excludes.ts` (exit 0 = pass).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { globSync } from "tinyglobby";

import baseConfig from "../vitest.config.js";
import { CI_EXCLUDES, CI_FAST_EXCLUDES } from "../vitest.ci-excludes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const BWRAP_PATTERNS: ReadonlyArray<RegExp> = [
  /\brequireBwrap\s*\(/,
  /\brunInSandbox\s*\(/,
  /\bcreateBashTool\s*\(/,
  /\bcreateDefaultAciRegistry\s*\(/,
  /\bcreateWorkerDeps\s*\(/,
  // Transitive chain: buildHarnessEngine → createDefaultAciRegistry →
  // createBashTool → requireBwrap. CI-verified: build-engine hook/trace tests
  // assemble through this path and fail loudly when bwrap is missing.
  /\bbuildHarnessEngine\s*\(/,
];

/**
 * The collection domain is read straight from vitest.config.ts (include +
 * exclude), never hand-copied — a copy would drift silently on config
 * changes, and preventing exactly that rot is why this guard exists.
 *
 * Both values must exist and be non-empty: if the config ever becomes a
 * function / projects form, fail loudly here instead of degrading into a
 * vacuous pass comparing against undefined.
 */
const testConfig = baseConfig.test;
if (
  !Array.isArray(testConfig?.include) ||
  testConfig.include.length === 0 ||
  !Array.isArray(testConfig?.exclude) ||
  testConfig.exclude.length === 0
) {
  console.error(
    "FAIL: 无法从 vitest.config.ts 读出非空的 test.include / test.exclude。\n" +
      "       本守卫按「收集域 = include 减去 exclude」校验 CI 排除集，" +
      "读不到就无从判断 → 直接报错而不是静默放过。\n" +
      "       修法：确认 vitest.config.ts 仍是静态对象，或在守卫里适配新的 config 形状。"
  );
  process.exit(1);
}

/** Candidate domain vitest collects from (include in vitest.config.ts). */
const TEST_INCLUDE: readonly string[] = testConfig.include;

/** Directories vitest never collects (exclude in vitest.config.ts; includes tests/tui). */
const VITEST_UNCOLLECTED: readonly string[] = testConfig.exclude;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.test\.tsx?$/.test(entry)) {
      out.push(relative(repoRoot, full).split("\\").join("/"));
    }
  }
}

/** All test files under tests/ on disk (input for the reverse dead-entry check). */
const testsDir = join(repoRoot, "tests");
const allTestFiles: string[] = [];
walk(testsDir, allTestFiles);

const tuiFiles = allTestFiles.filter((f) => f.startsWith("tests/tui/"));

/**
 * The domain vitest actually collects: tinyglobby (the same engine vitest uses
 * for collection) with ignore=VITEST_UNCOLLECTED, matching the real CI
 * collection scope.
 */
const collectible = new Set(
  globSync(TEST_INCLUDE, {
    cwd: repoRoot,
    dot: true,
    ignore: VITEST_UNCOLLECTED,
    expandDirectories: false,
  })
);

const bwrapFiles = [...collectible]
  .filter((f) =>
    BWRAP_PATTERNS.some((re) =>
      re.test(readFileSync(join(repoRoot, f), "utf8"))
    )
  )
  .sort();

/**
 * Files matched by glob(s), single or array, cwd always the repo root.
 *
 * The forward check ("which files the exclude aggregate covers") and the
 * per-entry check ("which files this one glob hits") share one globSync
 * semantics and differ only in argument shape, so both use this
 * implementation.
 */
function globMatches(patterns: string | readonly string[]): Set<string> {
  return new Set(globSync(patterns, { cwd: repoRoot, dot: true }));
}

/** Files hit by one exclude entry (glob) within a given file set. */
function matchesAny(entry: string, files: readonly string[]): string[] {
  const hit = globMatches(entry);
  return files.filter((f) => hit.has(f));
}

const problems: string[] = [];

// ---- Forward: bwrap-dependent files must be covered ----
//
// The strictest necessary condition is "no misses even for test-fast without
// bwrap": without bwrap the assembly throws, so the test-fast exclude
// aggregate (CI_EXCLUDES ∪ CI_FAST_EXCLUDES) must cover every bwrap-touching
// file. CI_EXCLUDES ⊆ that aggregate, so this single check covers both jobs.
//
// Deliberately not enforced per-job against test-full: full installs bwrap,
// and files where buildHarnessEngine only assembles without really running
// the bash tool (tests/e2e/subagent-*.test.ts etc., stub model scripting only
// run_graph / spawn_subagent / skill) genuinely pass on those runners
// (observed green in nightly test-full). Forcing them into CI_EXCLUDES would
// shrink test-full coverage — a CI semantics change, not rot repair.
const fastAggregate = [...CI_EXCLUDES, ...CI_FAST_EXCLUDES];

const fastCovered = globMatches(fastAggregate);
const missing = bwrapFiles.filter((f) => !fastCovered.has(f));

if (missing.length > 0) {
  problems.push(
    `[正向] ${missing.length}/${bwrapFiles.length} 个 bwrap 依赖测试文件不在任何 exclude 集内：\n` +
      missing.map((f) => `         ${f}`).join("\n") +
      "\n       修法：加进 vitest.ci-excludes.ts 的 CI_EXCLUDES" +
      "（整目录慢路径才用 CI_FAST_EXCLUDES）。\n" +
      "       原因：runner 无 user-namespace ⇒ requireBwrap() 在装配期 throw，" +
      "test-fast（不装 bwrap）会红。"
  );
}

/**
 * Per-entry check lists: (display name, entries).
 *
 * The reverse dead-entry check and the tests/tui ban both key off "how many
 * files one glob hits in a given set", so they share one traversal and one
 * entry list — adding or removing lists can never leave one check behind.
 */
const EXCLUDE_LISTS = [
  ["CI_EXCLUDES", CI_EXCLUDES],
  ["CI_FAST_EXCLUDES", CI_FAST_EXCLUDES],
] as const;

// ---- Reverse + tests/tui ban: one pass per entry ----
for (const [listName, entries] of EXCLUDE_LISTS) {
  for (const entry of entries) {
    const hitAll = matchesAny(entry, allTestFiles);
    if (hitAll.length === 0) {
      problems.push(
        `[反向] ${listName} 的条目匹配 0 个磁盘上的 test 文件：${entry}\n` +
          "       该文件已删除或改名 → 从 SSOT 移除该条（死条目会让排除集失去意义）。"
      );
    }

    // tests/tui ban: vitest never collects tui (OpenTUI native FFI is
    // bun-only), so entries here are dead config that only hides the real
    // collection scope.
    const hitTui = matchesAny(entry, tuiFiles);
    if (hitTui.length > 0) {
      problems.push(
        `[tui] ${listName} 的条目命中 tests/tui/ 下文件（vitest 永不收集）：${entry}\n` +
          `       命中：${hitTui.join(", ")}\n` +
          "       tests/tui 由 bun:test 驱动，vitest 收集域已由 vitest.config.ts 排除；" +
          "此处再排是死配置，删除该条。"
      );
    }
  }
}

if (problems.length > 0) {
  console.error("FAIL: CI exclude 集校验不通过。\n");
  for (const p of problems) console.error(`${p}\n`);
  process.exit(1);
}

console.log(
  `OK: ${bwrapFiles.length} bwrap-dependent test files 全部被 CI 排除集覆盖；` +
    `无死条目、无 tests/tui 条目。`
);
console.log(
  `    条目统计：CI_EXCLUDES=${CI_EXCLUDES.length}, CI_FAST_EXCLUDES=${CI_FAST_EXCLUDES.length}` +
    `（fast 合计 ${fastAggregate.length}）。`
);
console.log(
  `    扫描域：tests/ 下 ${allTestFiles.length} 个 test 文件，其中 vitest 可收集 ` +
    `${collectible.size}（tests/tui/ 由 bun 驱动，${tuiFiles.length} 个不计入正向校验）。`
);
