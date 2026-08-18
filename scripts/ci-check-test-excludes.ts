/**
 * CI guard:扫 `tests/` 下所有 test 文件找 bwrap-依赖,与
 * `.github/workflows/test.yml` 的 --exclude 列表 diff;不在列表里则 exit 1。
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
 *
 * 只匹配调用形态(`\bidentifier\s*\(`),避免 type-only import / vi.mock
 * 路径里的符号命中误报 —— 真依赖是装配期 requireBwrap throw,只有实际
 * 调到那几个 factory 的文件才会 fail-loud。
 *
 * 排除目录通配:'tests/foo/**' 涵盖该目录下所有文件。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

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
  // CI 实证:build-engine-hooks / build-engine-subagent-trace 均经此
  // 装配,bwrap 缺失即 fail-loud)。
  /\bbuildHarnessEngine\s*\(/,
];

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

const testsDir = join(repoRoot, "tests");
const files: string[] = [];
walk(testsDir, files);

const bwrapFiles = new Set<string>();
for (const f of files) {
  const src = readFileSync(join(repoRoot, f), "utf8");
  if (BWRAP_PATTERNS.some((re) => re.test(src))) bwrapFiles.add(f);
}

// Extract --exclude paths from both test-fast and test-full jobs.
const workflowPath = join(repoRoot, ".github", "workflows", "test.yml");
const workflow = readFileSync(workflowPath, "utf8");
const excludes = new Set<string>();
for (const m of workflow.matchAll(/--exclude\s+(['"]?)([^'"\s]+)\1/g)) {
  excludes.add(m[2]!);
}

function isExcluded(file: string): boolean {
  if (excludes.has(file)) return true;
  for (const ex of excludes) {
    if (ex.endsWith("/**")) {
      const prefix = ex.slice(0, -3);
      if (file === prefix || file.startsWith(prefix + "/")) return true;
    }
  }
  return false;
}

const missing = [...bwrapFiles].filter((f) => !isExcluded(f)).sort();
const total = bwrapFiles.size;
if (missing.length > 0) {
  console.error(
    `FAIL: ${missing.length}/${total} bwrap-dependent test files NOT in CI exclude list.`
  );
  console.error(
    "Add each to BOTH test-fast and test-full jobs in .github/workflows/test.yml:"
  );
  for (const f of missing) console.error(`    --exclude ${f} \\`);
  console.error("");
  console.error(
    "Reason: GitHub Actions runner has no user-namespace → bwrap is"
  );
  console.error(
    "unavailable; requireBwrap() throws at createBashTool / assembly time."
  );
  process.exit(1);
}
console.log(
  `OK: ${total} bwrap-dependent test files all in CI exclude list (${excludes.size} --exclude entries total).`
);
