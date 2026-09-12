#!/usr/bin/env node
/**
 * 工作区 `.iknow` 存量挪盘 — ADR-0087 / ADR-0088 的一次性操作（plan T3）。
 *
 * 背景：ADR-0019 T2 一度让会话池与后台任务登记落 `<workspaceRoot>/.iknow/`。
 * ADR-0087 把会话池钉回 home（显式 `--data-dir` 除外），ADR-0088 让 tasks 跟
 * 同一棵 home 项目树。工作区里因此残留三类 harness 落盘：
 *
 *   - `<ws>/.iknow/projects/<slug>/<convId>/`  误写的工作区会话文件夹
 *   - `<ws>/.iknow/sessions/<proj>/<id>.jsonl` 退役扁 jsonl 旧树
 *   - `<ws>/.iknow/tasks/<task_id>.{json,log}` 误写的后台任务登记
 *
 * 语义 = **按项并入对应池位置**，冲突 skip 不覆盖：
 *   - `projects/` → `<pool>/projects/<slug>/<convId>/`（ADR-0087 «存量» 明确：
 *     误写的会话文件夹迁到 `~/.iknow/projects/`，同 conversation 叶子冲突保留池侧）。
 *   - `sessions/` → `<pool>/sessions/` 退役旧池（ADR-0087：产品零写入、**不**自动
 *     迁成会话文件夹 —— 扁 jsonl 保形并入同形旧树，不转 `projects/` 叶子）。
 *   - `tasks/` → `<pool>/projects/<identity-slug>/tasks/`（ADR-0088：登记者挪进
 *     home 项目树，目标已存在 skip）。
 *
 * 行为契约：
 *   - 只并入，不转换：`sessions/` 的扁 jsonl 永远不变成会话文件夹（ADR-0071 L3）。
 *   - 不覆盖：目标已存在的**项**（会话叶子 / jsonl / task 文件）SKIP 并计数。
 *   - 幂等：源不存在 / 已空 → 0 条；移空后的源目录（含中间的 slug / 类别目录）
 *     按空即删，非空保留 —— 「残留要么空/删除，要么仅冲突 SKIP 叶子」。
 *   - 默认 report-only；`--apply` 才动盘（对齐 scripts/task-worktree-gc.ts）。
 *   - 不是 grep 排除的替代：本脚本动的是落点，搜面修法见 #1000。
 *
 * 用法：
 *   npx tsx scripts/workspace-iknow-migrate.ts [--workspace <dir>] [--pool <dir>]
 *                                              [--identity-root <dir>] [--apply]
 *
 * 缺省 `--workspace` = 仓库根（import.meta.url 上溯）；`--pool` = `~/.iknow`
 * （ADR-0087 公式；显式 `--data-dir` 用户自行传 `--pool`）；`--identity-root`
 * = `deriveProjectIdentityRoot({ cwd: workspaceRoot })`（task 落点 slug 用，
 * 与产品代码同一公式 —— 不新发明第二套 slug）。
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveProjectSessionDir } from "../src/session-api/store/index.ts";
import { deriveProjectIdentityRoot } from "../src/harness/session-roots.ts";

/** 一条按项挪动：一个源路径 → 池侧目标路径。 */
export interface WorkspaceIknowMove {
  /** 类别（报告分组用）。 */
  readonly category: "projects" | "sessions" | "tasks";
  /** 源绝对路径。 */
  readonly source: string;
  /** 池侧目标绝对路径。 */
  readonly target: string;
}

/** 计划：可挪项 + 因目标已存在而跳过的项。 */
export interface WorkspaceIknowPlan {
  /** 可执行的按项挪动。 */
  readonly moves: ReadonlyArray<WorkspaceIknowMove>;
  /** 目标已存在、绝不覆盖的项（源路径）。 */
  readonly conflicts: ReadonlyArray<WorkspaceIknowMove>;
}

/** 执行结果。 */
export interface WorkspaceIknowReport {
  readonly moved: ReadonlyArray<WorkspaceIknowMove>;
  readonly conflicts: ReadonlyArray<WorkspaceIknowMove>;
  /** 移空后删掉的目录（含中间 slug / 类别目录）。 */
  readonly removedDirs: ReadonlyArray<string>;
}

function listEntries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** 深度 2 列举 `<base>/<a>/<b>`（b 为文件或目录），a/b 均须存在。 */
function listTwoLevel(
  base: string
): Array<{ readonly a: string; readonly b: string }> {
  const out: Array<{ a: string; b: string }> = [];
  for (const a of listEntries(base)) {
    const aPath = join(base, a);
    if (!statSync(aPath).isDirectory()) continue;
    for (const b of listEntries(aPath)) out.push({ a, b });
  }
  return out;
}

/** 深度 1 列举 `<base>/<a>`（a 为文件或目录）。 */
function listOneLevel(base: string): string[] {
  return listEntries(base);
}

/**
 * 只读计划：算出三类遗留目录下每个可并入项、以及目标已存在的冲突项。
 *
 * 纯查询（不建目录、不移动）。排序稳定（字典序），便于报告与测试。
 */
export function planWorkspaceIknowMigrate(opts: {
  readonly workspaceRoot: string;
  readonly poolRoot: string;
  readonly projectIdentityRoot: string;
}): WorkspaceIknowPlan {
  const wsRoot = resolve(opts.workspaceRoot);
  const poolRoot = resolve(opts.poolRoot);
  const identityRoot = resolve(opts.projectIdentityRoot);
  const legacyRoot = join(wsRoot, ".iknow");
  const targetTaskDir = join(
    resolveProjectSessionDir(poolRoot, identityRoot),
    "tasks"
  );

  const candidates: WorkspaceIknowMove[] = [];

  // projects/<slug>/<convId> → <pool>/projects/<slug>/<convId>（逐会话叶子）
  for (const { a, b } of listTwoLevel(join(legacyRoot, "projects"))) {
    candidates.push({
      category: "projects",
      source: join(legacyRoot, "projects", a, b),
      target: join(poolRoot, "projects", a, b),
    });
  }
  // sessions/<proj>/<item> → <pool>/sessions/<proj>/<item>（保形，不转会话文件夹）
  for (const { a, b } of listTwoLevel(join(legacyRoot, "sessions"))) {
    candidates.push({
      category: "sessions",
      source: join(legacyRoot, "sessions", a, b),
      target: join(poolRoot, "sessions", a, b),
    });
  }
  // tasks/<item> → <pool>/projects/<identity-slug>/tasks/<item>
  for (const a of listOneLevel(join(legacyRoot, "tasks"))) {
    candidates.push({
      category: "tasks",
      source: join(legacyRoot, "tasks", a),
      target: join(targetTaskDir, a),
    });
  }

  candidates.sort((x, y) =>
    x.source < y.source ? -1 : x.source > y.source ? 1 : 0
  );
  const moves: WorkspaceIknowMove[] = [];
  const conflicts: WorkspaceIknowMove[] = [];
  for (const c of candidates) {
    if (existsSync(c.target)) conflicts.push(c);
    else moves.push(c);
  }
  return { moves, conflicts };
}

/**
 * 执行计划：同盘 `rename` 优先（原子、零拷贝），跨盘（EXDEV）回落 `cp -R` +
 * 删源。移走的项若把源目录（及其中间 slug / 类别目录）掏空，按空即删。
 *
 * 冲突项在计划阶段已剔除；任一条失败 → 抛错并保留已完成条目（可重入：
 * 源已移走的项下次计划自然消失）。
 */
export function applyWorkspaceIknowMigrate(
  plan: WorkspaceIknowPlan,
  opts: { readonly workspaceRoot: string }
): WorkspaceIknowReport {
  const moved: WorkspaceIknowMove[] = [];
  for (const move of plan.moves) {
    mkdirSync(dirname(move.target), { recursive: true });
    try {
      renameSync(move.source, move.target);
    } catch (err) {
      if (!isExdev(err)) throw err;
      cpSync(move.source, move.target, {
        recursive: true,
        verbatimSymlinks: true,
      });
      rmSync(move.source, { recursive: true, force: true });
    }
    moved.push(move);
  }
  const removedDirs = pruneEmptyLegacyDirs(resolve(opts.workspaceRoot), moved);
  return { moved, conflicts: plan.conflicts, removedDirs };
}

/** 从已移走的项向上收空目录：类别/<slug> 与类别目录本身，空即删。 */
function pruneEmptyLegacyDirs(
  wsRoot: string,
  moved: ReadonlyArray<WorkspaceIknowMove>
): string[] {
  const removed: string[] = [];
  const candidates = new Set<string>();
  for (const m of moved) {
    let dir = join(m.source, "..");
    const stop = join(wsRoot, ".iknow");
    // 只收类别层及其下一层（sessions/<proj>、projects/<slug>、tasks 自身）
    while (dir.startsWith(stop) && dir !== stop) {
      candidates.add(dir);
      const parent = join(dir, "..");
      if (parent === stop) break;
      dir = parent;
    }
  }
  // 深的先删，父目录随后才可能变空
  const ordered = [...candidates].sort((x, y) => y.length - x.length);
  for (const dir of ordered) {
    try {
      if (readdirSync(dir).length === 0) {
        rmSync(dir, { recursive: true, force: true });
        removed.push(dir);
      }
    } catch {
      // 目录已不存在 → 已达成「空/删除」；读失败 → 保留，不动。
    }
  }
  return removed.sort();
}

function isExdev(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "EXDEV"
  );
}

// -- CLI main -----------------------------------------------------------------

const DEFAULT_WORKSPACE = resolve(
  fileURLToPath(new URL("..", import.meta.url))
);

interface CliArgs {
  readonly workspaceRoot: string;
  readonly poolRoot: string;
  readonly identityRoot: string;
  readonly apply: boolean;
}

function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  let workspaceRoot = DEFAULT_WORKSPACE;
  let poolRoot = join(homedir(), ".iknow");
  let identityRoot: string | undefined;
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") {
      apply = true;
    } else if (
      a === "--workspace" ||
      a === "--pool" ||
      a === "--identity-root"
    ) {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`missing value for ${a}`);
      if (a === "--workspace") workspaceRoot = resolve(value);
      else if (a === "--pool") poolRoot = resolve(value);
      else identityRoot = resolve(value);
      i += 1;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return {
    workspaceRoot,
    poolRoot,
    identityRoot:
      identityRoot ?? deriveProjectIdentityRoot({ cwd: workspaceRoot }),
    apply,
  };
}

function printPlan(plan: WorkspaceIknowPlan, apply: boolean): void {
  console.log("workspace-iknow-migrate（ADR-0087 / ADR-0088，plan T3）");
  console.log(`  模式: ${apply ? "apply" : "report-only（--apply 才动盘）"}`);
  if (plan.moves.length === 0 && plan.conflicts.length === 0) {
    console.log("  无工作区遗留项可迁移（源不存在或已空）。");
  }
  for (const m of plan.moves) {
    console.log(`  MOVE  [${m.category}] ${m.source}\n          → ${m.target}`);
  }
  for (const c of plan.conflicts) {
    console.log(`  SKIP  [${c.category}] ${c.source} — 目标已存在（不覆盖）`);
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const plan = planWorkspaceIknowMigrate({
    workspaceRoot: args.workspaceRoot,
    poolRoot: args.poolRoot,
    projectIdentityRoot: args.identityRoot,
  });
  if (args.apply) {
    const report = applyWorkspaceIknowMigrate(plan, {
      workspaceRoot: args.workspaceRoot,
    });
    printPlan({ moves: report.moved, conflicts: report.conflicts }, true);
    console.log(
      `  已移走 ${report.moved.length} 项；跳过 ${report.conflicts.length} 项。`
    );
    if (report.removedDirs.length > 0) {
      console.log(`  收空目录 ${report.removedDirs.length} 个：`);
      for (const d of report.removedDirs) console.log(`    - ${d}`);
    }
  } else {
    printPlan(plan, false);
  }
  process.exitCode = plan.conflicts.length > 0 ? 1 : 0;
}

/**
 * 直接执行（`npx tsx scripts/workspace-iknow-migrate.ts`）时运行 CLI；
 * 被测试 import 作模块时不触发。
 */
const isDirectRun =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) ===
    fileURLToPath(pathToFileURL(process.argv[1]));

if (isDirectRun) {
  main();
}
