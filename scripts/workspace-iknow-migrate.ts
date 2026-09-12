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
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
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
  /**
   * review-fix:若该 entry 被归为 conflict 的原因(target 已存在 / 源是
   * symlink / 路径敌意 / 之类),由 plan 写入;非 conflict 留 undefined。
   * apply 阶段不再重算(avoid second walk)—— 仅展示用。
   */
  readonly reason?: string;
}

/** 计划：可挪项 + 因目标已存在而跳过的项。 */
export interface WorkspaceIknowPlan {
  /** 可执行的按项挪动。 */
  readonly moves: ReadonlyArray<WorkspaceIknowMove>;
  /** 目标已存在、源是 symlink / 路径敌意等绝不处理的项（源路径）。 */
  readonly conflicts: ReadonlyArray<WorkspaceIknowMove>;
}

/** 执行结果。 */
export interface WorkspaceIknowReport {
  readonly moved: ReadonlyArray<WorkspaceIknowMove>;
  readonly conflicts: ReadonlyArray<WorkspaceIknowMove>;
  /** 移空后删掉的目录（含中间 slug / 类别目录）。 */
  readonly removedDirs: ReadonlyArray<string>;
  /**
   * review-fix:本趟挪不动的项 —— 非 EXDEV 类失败 / 路径敌意 / 符号链接等。
   * 不抛错，继续跑剩余 moves；调用方按 `failed.length > 0` 设 exitCode=1。
   * 之前在非 EXDEV 上 `throw`,前序 move 已落盘但剩余 moves 不再执行,
   * 重入时计划自然重算(已挪走的项消失)—— 与本字段语义收敛为「尽可能
   * 完成 + 报告失败」。
   */
  readonly failed: ReadonlyArray<{
    readonly category: "projects" | "sessions" | "tasks";
    readonly source: string;
    readonly error: string;
  }>;
}

/**
 * 路径敌意判定 —— 包含 `/` / `\` / NUL 之一,或等于 `.` / `..` 的名字
 * 视为 unsafe:即便绕过 readdir 也不得参与 join(否则可逃出目标目录或
 * 撞上 NUL 系统调用 reject)。命中时由 plan/apply 各自归类为 conflict。
 *
 * readdirSync 的返回是单段 basename(无分隔符),但磁盘上真实路径可能
 * 含这些字符(罕见但合法),需在 join 之前过滤 —— 这是 fail-closed 守卫,
 * 不是 UX 优化。
 */
export function isHostileName(name: string): boolean {
  if (name === "." || name === "..") return true;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
    return true;
  }
  return false;
}

function listEntries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * 列举一层目录,把路径敌意名 / symlink 剥离出来单独归类:
 *
 *   - `safe`:可继续参与 join 的普通条目(常规文件 / 目录,名字单段无分隔符);
 *   - `rejected`:含 `/` / `\` / NUL 或等于 `.` / `..` 的名字 —— 绝不 join
 *     进目标路径(否则可逃出目标根或触发 NUL 系统调用 reject);
 *   - `symlinks`:lstat 显示为符号链接的条目 —— 绝不 rename/cp 穿过
 *     (renameSync 会跟随链目标,cpSync 的 verbatimSymlinks 又会保留原链,
 *     两套语义在同一字段里互斥,直接拒收最安全)。
 *
 * 返回结构而非裸数组:调用方要按 (a,b) 的层级位置分别归类,不能丢层级信息。
 */
function scanLevel(dir: string): {
  readonly safe: string[];
  readonly rejected: Array<{ readonly name: string; readonly reason: string }>;
  readonly symlinks: Array<{ readonly name: string; readonly reason: string }>;
} {
  const safe: string[] = [];
  const rejected: Array<{ name: string; reason: string }> = [];
  const symlinks: Array<{ name: string; reason: string }> = [];
  for (const name of listEntries(dir)) {
    if (isHostileName(name)) {
      rejected.push({ name, reason: "路径敌意名（含分隔符 / NUL / . / ..）" });
      continue;
    }
    try {
      if (lstatSync(join(dir, name)).isSymbolicLink()) {
        symlinks.push({ name, reason: "符号链接（不穿过链接移动）" });
        continue;
      }
    } catch {
      continue;
    }
    safe.push(name);
  }
  return { safe, rejected, symlinks };
}

/**
 * 深度 2 列举 `<base>/<a>/<b>`（b 为文件或目录），a/b 均须存在。
 * review-fix:每层 scanLevel 后把 rejected / symlinks 一并以带 reason 的
 * conflict 形态返回,让 plan 阶段就能把它们计入 `conflicts`(exit-code 也
 * 非零),而不是静默 skip。
 */
function listTwoLevel(base: string): {
  readonly items: Array<{ readonly a: string; readonly b: string }>;
  readonly rejected: ReadonlyArray<{
    readonly path: string;
    readonly reason: string;
  }>;
} {
  const items: Array<{ a: string; b: string }> = [];
  const rejected: Array<{ path: string; reason: string }> = [];
  const levelA = scanLevel(base);
  for (const r of [...levelA.rejected, ...levelA.symlinks]) {
    rejected.push({ path: join(base, r.name), reason: r.reason });
  }
  for (const a of levelA.safe) {
    const aPath = join(base, a);
    const levelB = scanLevel(aPath);
    for (const r of [...levelB.rejected, ...levelB.symlinks]) {
      rejected.push({ path: join(aPath, r.name), reason: r.reason });
    }
    for (const b of levelB.safe) items.push({ a, b });
  }
  return { items, rejected };
}

/**
 * 深度 1 列举 `<base>/<a>`（a 为文件或目录），同 listTwoLevel 的
 * conflict 归类语义。
 */
function listOneLevel(base: string): {
  readonly items: readonly string[];
  readonly rejected: ReadonlyArray<{
    readonly path: string;
    readonly reason: string;
  }>;
} {
  const level = scanLevel(base);
  return {
    items: level.safe,
    rejected: [...level.rejected, ...level.symlinks].map((r) => ({
      path: join(base, r.name),
      reason: r.reason,
    })),
  };
}

/**
 * 只读计划：算出三类遗留目录下每个可并入项、以及目标已存在的冲突项。
 *
 * 纯查询（不建目录、不移动）。排序稳定（字典序），便于报告与测试。
 *
 * review-fix:把 scanLevel 列出的 rejected / symlinks 折叠进 `conflicts`
 * —— 它们不是「目标已存在」类冲突,而是「源类型/名字不允许 migrate」
 * 类冲突,但语义同(都不覆盖、不继续),CLI 一并按 conflict 报告并把
 * exit code 顶到 1。
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
  const rejected: WorkspaceIknowMove[] = [];

  // projects/<slug>/<convId> → <pool>/projects/<slug>/<convId>（逐会话叶子）
  {
    const { items, rejected: bad } = listTwoLevel(join(legacyRoot, "projects"));
    for (const r of bad) {
      rejected.push({
        category: "projects",
        source: r.path,
        target: r.path,
        reason: r.reason,
      });
    }
    for (const { a, b } of items) {
      candidates.push({
        category: "projects",
        source: join(legacyRoot, "projects", a, b),
        target: join(poolRoot, "projects", a, b),
      });
    }
  }
  // sessions/<proj>/<item> → <pool>/sessions/<proj>/<item>（保形，不转会话文件夹）
  {
    const { items, rejected: bad } = listTwoLevel(join(legacyRoot, "sessions"));
    for (const r of bad) {
      rejected.push({
        category: "sessions",
        source: r.path,
        target: r.path,
        reason: r.reason,
      });
    }
    for (const { a, b } of items) {
      candidates.push({
        category: "sessions",
        source: join(legacyRoot, "sessions", a, b),
        target: join(poolRoot, "sessions", a, b),
      });
    }
  }
  // tasks/<item> → <pool>/projects/<identity-slug>/tasks/<item>
  {
    const { items, rejected: bad } = listOneLevel(join(legacyRoot, "tasks"));
    for (const r of bad) {
      rejected.push({
        category: "tasks",
        source: r.path,
        target: r.path,
        reason: r.reason,
      });
    }
    for (const a of items) {
      candidates.push({
        category: "tasks",
        source: join(legacyRoot, "tasks", a),
        target: join(targetTaskDir, a),
      });
    }
  }

  candidates.sort((x, y) =>
    x.source < y.source ? -1 : x.source > y.source ? 1 : 0
  );
  const moves: WorkspaceIknowMove[] = [];
  const conflicts: WorkspaceIknowMove[] = [];
  for (const c of candidates) {
    if (existsSync(c.target)) {
      conflicts.push({ ...c, reason: "目标已存在（不覆盖）" });
    } else moves.push(c);
  }
  // source-only 类冲突(symlink / 路径敌意)没有可比较的 target —— 显式带
  // reason 归 conflict,不进入 moves 也绝不 join 进目标路径。
  conflicts.push(...rejected);
  conflicts.sort((x, y) =>
    x.source < y.source ? -1 : x.source > y.source ? 1 : 0
  );
  return { moves, conflicts };
}

/**
 * 执行计划：同盘 `rename` 优先（原子、零拷贝），跨盘（EXDEV）回落 `cp -R` +
 * 删源。移走的项若把源目录（及其中间 slug / 类别目录）掏空，按空即删。
 *
 * review-fix (Medium-2 / 失败语义)：**任一条失败不再抛错** —— 之前
 * 非 EXDEV 错误直接 throw,前序已完成 move 落盘但剩余 moves 跳过,重入
 * 计划重算会自然吸收已挪走的项,但一次性 dry-run 看不完整。当前改成
 * 单条失败累积进 `failed`,继续剩余 moves;CLI 入口按 `failed.length > 0`
 * 设 exitCode=1。报告阶段一并打印 failed 列表。
 */
export function applyWorkspaceIknowMigrate(
  plan: WorkspaceIknowPlan,
  opts: { readonly workspaceRoot: string }
): WorkspaceIknowReport {
  const moved: WorkspaceIknowMove[] = [];
  const failed: Array<{
    readonly category: "projects" | "sessions" | "tasks";
    readonly source: string;
    readonly error: string;
  }> = [];
  for (const move of plan.moves) {
    try {
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
    } catch (err) {
      failed.push({
        category: move.category,
        source: move.source,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const removedDirs = pruneEmptyLegacyDirs(resolve(opts.workspaceRoot), moved);
  return {
    moved,
    conflicts: plan.conflicts,
    removedDirs,
    failed,
  };
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
    } catch (err) {
      // review-fix (Medium-2): 显式 ENOENT-tolerant —— 目录已不存在 =
      // 已达成「空/删除」契约;其它 readdir 错误属「读失败」,**不静默吞**,
      // 留给调用方/操作员在日志中看见(避免掩盖 fs 故障)。
      if (!isEnoent(err)) {
        throw err;
      }
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

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
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
    const why = c.reason ?? "目标已存在（不覆盖）";
    console.log(`  SKIP  [${c.category}] ${c.source} — ${why}`);
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const plan = planWorkspaceIknowMigrate({
    workspaceRoot: args.workspaceRoot,
    poolRoot: args.poolRoot,
    projectIdentityRoot: args.identityRoot,
  });
  let failedCount = 0;
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
    // review-fix (Medium-2):非 EXDEV 失败不再抛错,单条失败累积在此 ——
    // 逐条列出,exit code 顶到 1。之前在第一处失败即 throw,操作员看不到
    // 已完成 / 未完成的分布。
    failedCount = report.failed.length;
    if (report.failed.length > 0) {
      console.log(`  失败 ${report.failed.length} 项（继续跑完剩余项）：`);
      for (const f of report.failed) {
        console.log(`    ! [${f.category}] ${f.source} — ${f.error}`);
      }
    }
  } else {
    printPlan(plan, false);
  }
  // 非零退出条件:有冲突(含路径敌意 / symlink)或 apply 阶段有失败。
  process.exitCode = plan.conflicts.length > 0 || failedCount > 0 ? 1 : 0;
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
