/**
 * CI guard: 校验 CI vitest 排除集（SSOT: `vitest.ci-excludes.ts`）双向自洽。
 *
 * 排除集从 workflow 命令行串迁到 SSOT 模块后，本脚本不再 grep
 * `.github/workflows/test.yml`，改为 import 模块本身；workflow 只负责把
 * 对应的 config overlay 传给 vitest。校验分三向：
 *
 *   正向（bwrap 依赖覆盖）：扫 tests/ 下所有 vitest 可收集的 test 文件，
 *     命中 bwrap 依赖装配链锚点的文件必须出现在 test-fast 的排除集
 *     （CI_EXCLUDES ∪ CI_FAST_EXCLUDES）内。这是最严格的必要条件：test-fast
 *     不装 bwrap，漏一个就在装配期 fail-loud。不按 test-full 逐 job 强校验
 *     的理由见下方「正向」注释（装了 bwrap 的 full 能跑通仅装配的那批文件）。
 *
 *   反向（无死条目）：exclude 集里每条必须至少命中一个磁盘上真实存在的
 *     test 文件（`dir/**` glob 语义）。指向已删除文件的条目是配置腐烂 ——
 *     它会让「已排除」的假象掩盖真实的收集范围。
 *
 *   tests/tui 禁令：exclude 条目命中 `tests/tui/` 即报错。该目录由
 *     bun:test 驱动（OpenTUI 原生 FFI 仅 bun 可用），vitest.config.ts 的
 *     exclude 已含 `tests/tui/**`，vitest 永不收集 —— 此处的 tui 条目对
 *     vitest 是死配置。历史上正是「守卫扫全 tests/ + 塞 tui 条目消警」的
 *     组合制造了 tests/tui/deps-tools.test.ts 这类死条目；现在把守卫的
 *     正向扫描域收敛到 vitest 可收集域，tui 条目直接判违规。
 *
 * 背景:GitHub Actions runner 无 user-namespace → bwrap 无法物理执行;
 * 但 requireBwrap() 守卫在 createBashTool / createDefaultAciRegistry /
 * createWorkerDeps / runInSandbox 装配阶段就 throw,导致 CI 在装配期
 * fail-loud(2026-08-19 #467 merge 时 tests/harness/aci/bash-background.test.ts
 * 漏入 CI exclude → test-fast 10/14 fail)。该脚本确保下一次 merge 进同类
 * 测试时 CI 立刻报警(指明漏了哪个文件),而不是沉默破坏 PR 流程。
 *
 * 锚点(必须命中其一即视为 bwrap-依赖):
 *   - requireBwrap(...):src/harness/sandbox/runner.ts 显式守卫
 *   - runInSandbox(...):sandbox 入口
 *   - createBashTool(...):bash 工具构造期调 requireBwrap
 *   - createDefaultAciRegistry(...):ACI 8 件装配 → createBashTool
 *   - createWorkerDeps(...):subagent worker 装配 → createBashTool
 *   - buildHarnessEngine(...):buildEngine → createDefaultAciRegistry
 *
 * 只匹配调用形态(`\bidentifier\s*\(`),避免 type-only import / vi.mock
 * 路径里的符号命中误报 —— 真依赖是装配期 requireBwrap throw,只有实际
 * 调到那几个 factory 的文件才会 fail-loud。
 *
 * 用法:`npx tsx scripts/ci-check-test-excludes.ts`（exit 0 = 通过）。
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
  // 传递链:buildHarnessEngine → createDefaultAciRegistry → createBashTool
  // → requireBwrap(与既有排除集注释"装配依赖 bwrap 类"同链;
  // CI 实证:build-engine-hooks / build-engine-subagent-trace 均经此装配,
  // bwrap 缺失即 fail-loud)。
  /\bbuildHarnessEngine\s*\(/,
];

/**
 * 收集域直接读自 vitest.config.ts 本体（include + exclude），不手抄 ——
 * 手抄副本会在配置变更时静默漂移，而本守卫的存在理由正是防配置腐烂。
 *
 * 两个值都必须存在且非空：若将来 config 形状换成函数式 / projects 形式，
 * 这里直接 fail-loud，绝不退化成「拿 undefined 比较而 vacuous 通过」。
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

/** vitest 收集的候选域（vitest.config.ts 的 include）。 */
const TEST_INCLUDE: readonly string[] = testConfig.include;

/** vitest 永不收集的目录（vitest.config.ts 的 exclude；含 tests/tui）。 */
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

/** 磁盘上 tests/ 下全部 test 文件（用于反向「死条目」核验）。 */
const testsDir = join(repoRoot, "tests");
const allTestFiles: string[] = [];
walk(testsDir, allTestFiles);

const tuiFiles = allTestFiles.filter((f) => f.startsWith("tests/tui/"));

/**
 * vitest 实际会收集的域。用 tinyglobby（vitest 收集用的同一引擎）
 * 以 ignore=VITEST_UNCOLLECTED 求差，与 CI 上真实的收集范围一致。
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
 * glob（单条或数组）命中的文件集合，cwd 恒为仓库根。
 *
 * 正向的「排除集并集覆盖了哪些文件」与逐条目的「这条 glob 命中了哪些
 * 文件」是同一套 globSync 语义，只是入参形态不同（数组 vs 单条），故共用
 * 此处一个实现。
 */
function globMatches(patterns: string | readonly string[]): Set<string> {
  return new Set(globSync(patterns, { cwd: repoRoot, dot: true }));
}

/** 单条 exclude 条目（glob）在给定文件集中命中的文件。 */
function matchesAny(entry: string, files: readonly string[]): string[] {
  const hit = globMatches(entry);
  return files.filter((f) => hit.has(f));
}

const problems: string[] = [];

// ---- 正向：bwrap 依赖文件必须被覆盖（#467 契约）----
//
// 最严格的必要条件是「不装 bwrap 的 test-fast 也不漏」：无 bwrap 时装配期
// 即 throw，所以 test-fast 的排除集（CI_EXCLUDES ∪ CI_FAST_EXCLUDES）必须
// 覆盖全部 bwrap 触达文件。CI_EXCLUDES ⊆ 该并集，故这一条同时覆盖两个 job。
//
// 有意不按 test-full 逐 job 强校验：full 装了 bwrap，`buildHarnessEngine`
// 只装配、不真跑 bash 工具的那批文件（tests/e2e/subagent-*.test.ts 等，stub
// model 只脚本化 run_graph / spawn_subagent / skill）在 runner 上真实通过
// （nightly run 34576438392 实测 418 passed，其中含这 4 份 e2e）。要求把它们
// 塞进 CI_EXCLUDES 等于收缩 test-full 覆盖 —— 那是 CI 语义变化，不是修腐烂。
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
 * 逐条目校验的两张清单：(对外展示名, 条目集)。
 *
 * 反向（死条目）与 tests/tui 禁令都以「单条 glob 在某个文件集里命中多少」
 * 为判据，故合并成一趟遍历 —— 两个检查共用同一份条目清单，避免清单增删
 * 时两处漏改。
 */
const EXCLUDE_LISTS = [
  ["CI_EXCLUDES", CI_EXCLUDES],
  ["CI_FAST_EXCLUDES", CI_FAST_EXCLUDES],
] as const;

// ---- 反向 + tests/tui 禁令：逐条目一趟校验 ----
for (const [listName, entries] of EXCLUDE_LISTS) {
  for (const entry of entries) {
    const hitAll = matchesAny(entry, allTestFiles);
    if (hitAll.length === 0) {
      problems.push(
        `[反向] ${listName} 的条目匹配 0 个磁盘上的 test 文件：${entry}\n` +
          "       该文件已删除或改名 → 从 SSOT 移除该条（死条目会让排除集失去意义）。"
      );
    }

    // tests/tui 禁令：vitest 不收 tui（OpenTUI 原生 FFI 仅 bun 可用），
    // 此处的条目对 vitest 是死配置，只会掩盖真实收集范围。
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
