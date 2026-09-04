/**
 * spec §9 / plan B5 — git 块（"## Git"）的唯一 git 读取出口。
 *
 * 设计原则：
 *   - 装配层（`assemble.ts`）经注入缝消费，**绝不** 直接 shell 出 git ——
 *     守住 assemble.ts 的 fs / path-only 纯度。
 *   - `createGitSnapshotProvider({ cwd })` 返回一个闭包，闭包在工厂调用
 *     时取一次快照、会话内冻结（build-engine / worker 装配期同步执行）。
 *     装配层每 turn 调同一闭包 → 相邻两轮文本 byte-identical
 *     （D9 / spec §2 断言 ② / KV 缓存契约）。
 *   - 退化态（cwd 不可用 / 非 git 仓库 / git 不可用）→ 快照 = undefined →
 *     装配段整体缺席（spec §9：「接受缺席即字节变化」）。分型词汇表在
 *     `env-snapshot.ts`,本模块只做「退化即 undefined」收敛。
 *   - status 输出经 `truncateByCodepoints` 截断（`GIT_STATUS_MAX_CHARS`
 *     上限，2000 codepoints，与 `MAX_ENV_DIFF_CHARS` 同档）；四要素 + D1
 *     免责句全部走 SSOT 常量。
 *
 * 数据源：
 *   - branch         ← `git --no-pager status --porcelain=v1 -b` 的 `## ...` 行
 *                        （与 env-snapshot.ts parseBranchLine 同形态）。
 *   - mainBranch     ← `git --no-pager symbolic-ref --short refs/remotes/origin/HEAD`
 *                        缺席（无 origin / 离线）→ null（提示行标 "—"）。
 *   - status         ← 同上的 porcelain v1 全文（剥离 `## ...` 行），按
 *                        codepoint 上限截断。
 *   - recentCommits  ← `git --no-pager log --oneline -5` 拆行。
 *
 * 取值用 `spawnSync`：会话级一次性快照，开销可控；闭包返回冻结值不再 IO。
 * 本模块是 `git` 命令在本仓的唯一 spawn 出口（assemble.ts 测试套验证）。
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { truncateByCodepoints } from "../env-snapshot.js";

// ---------------------------------------------------------------------------
// SSOT 常量（装配层 / 测试只引用，不复制不切片）
// ---------------------------------------------------------------------------

/** `## Git` 段小标题（与 `projectPathSegment` / `coordinatorSegment` 同形态）。 */
export const GIT_SEGMENT_TITLE = "## Git";

/** D1 免责句（spec §9）：明示快照语义，模型不应把它当成实时状态。 */
export const GIT_SEGMENT_DISCLAIMER =
  "snapshot taken at session start; not refreshed during the session";

/**
 * status 截断 codepoint 上限（spec §9 用 `truncateByCodepoints`，未锁数字）。
 * 2000 与 `MAX_ENV_DIFF_CHARS` 同档：典型 git status（含 porcelain v1 + dirty
 * 列表）远低于此值；超限只见于有大量 untracked / modified 的工作树，marker
 * 仍计入预算。装配总预算不受影响（status 是 git 块唯一可截断的字段）。
 */
export const GIT_STATUS_MAX_CHARS = 2000;

/** status 之外其它字段的 codepoint 上限（兜底分支名 / commit 行过长场景）。 */
export const GIT_FIELD_MAX_CHARS = 200;

/** git 命令执行超时（秒）。快照取一次，开销可控；超过此值 → git_unavailable。 */
const DEFAULT_GIT_TIMEOUT_SECONDS = 5;

// ---------------------------------------------------------------------------
// 公共类型
// ---------------------------------------------------------------------------

/** 一次冻结的 git 快照。退化态不产出本对象（provider 返回 undefined →
 *  装配段整体缺席），因此没有 degradeReason 字段。 */
export interface GitSnapshot {
  /** 当前分支名；detached HEAD 时为 "HEAD"；退化态 → null。 */
  readonly branch: string | null;
  /** PR 基线分支（origin/HEAD 派生的上游分支）；无 origin / 离线 → null。 */
  readonly mainBranch: string | null;
  /** `git status --porcelain=v1 -b` 文本（剥离 `## ...` 行），已按 codepoint
   *  截断；clean 工作区 → ""；退化态 → null。 */
  readonly status: string | null;
  /** 最近 5 条 commit（`git log --oneline -5` 拆行）；退化 → []。 */
  readonly recentCommits: ReadonlyArray<string>;
}

/** spawn 注入缝（测试可替换；默认走 node:child_process.spawnSync）。 */
export type GitExec = (
  args: readonly string[],
  cwd: string,
  timeoutSeconds?: number
) => SpawnSyncReturns<string>;

/** `createGitSnapshotProvider` 的入参。 */
export interface CreateGitSnapshotProviderOpts {
  /** cwd 来源：build-engine 传 `projectIdentityRoot`（稳定根），worker
   *  传父会话同值；未传 → 退化 cwd_unavailable。 */
  readonly cwd: string;
  /** 测试可注入 exec；缺省走 spawnSync。 */
  readonly exec?: GitExec;
  /** 单次 git 命令超时（秒）；缺省 = 5。 */
  readonly timeoutSeconds?: number;
}

// ---------------------------------------------------------------------------
// 默认 exec（spawnSync git）
// ---------------------------------------------------------------------------

function defaultExec(
  args: readonly string[],
  cwd: string,
  timeoutSeconds?: number
): SpawnSyncReturns<string> {
  return spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: (timeoutSeconds ?? DEFAULT_GIT_TIMEOUT_SECONDS) * 1000,
  });
}

// ---------------------------------------------------------------------------
// 退化判定（与 env-snapshot.ts 同词汇表,退化即 undefined —— 本模块不再
// 透出 EnvDegradeReason 分型,分型细节由 env-snapshot.ts 自身负责）
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 纯计算（无 IO）
// ---------------------------------------------------------------------------

/** 取 `git status --porcelain=v1 -b` 第一行分支名（detached → "HEAD"）。 */
function parseBranchFromStatus(porcelain: string): string | null {
  for (const line of porcelain.split("\n")) {
    if (!line.startsWith("## ")) continue;
    const body = line.slice(3).trim();
    if (body === "") return null;
    if (body.startsWith("HEAD")) return "HEAD";
    const spaceIdx = body.indexOf(" ");
    return spaceIdx >= 0 ? body.slice(0, spaceIdx) : body;
  }
  return null;
}

/** 剥离 porcelain v1 文本的 `## ...` 注解行，得到干净的 dirty 列表。 */
function cleanStatusBlock(porcelain: string): string {
  return porcelain
    .split("\n")
    .filter((l) => !l.startsWith("## "))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

// ---------------------------------------------------------------------------
// Provider 工厂
// ---------------------------------------------------------------------------

/**
 * 工厂：返回闭包。闭包在工厂调用时**同步取一次** git 快照、冻结在闭包里；
 * 装配层每 turn 调同一闭包 → 相邻两轮 byte-identical
 * （D9 / spec §2 断言 ②）。
 *
 * 退化路径：
 *   - cwd 空串 → 立即退化，**不 spawn** git。
 *   - spawn 同步失败（ENOENT / EACCES）/ 超时 / 退码非 0 → 闭包返回
 *     undefined（退化即 undefined，分型不透出）。
 *
 * 一旦冻结（无论成功 / 退化），闭包永远返回同一值；不重试、不 IO。
 */
export function createGitSnapshotProvider(
  opts: CreateGitSnapshotProviderOpts
): () => GitSnapshot | undefined {
  const exec = opts.exec ?? defaultExec;
  const cwd = opts.cwd;
  const snapshot = captureSnapshot({
    cwd,
    exec,
    timeoutSeconds: opts.timeoutSeconds,
  });
  return (): GitSnapshot | undefined => snapshot;
}

/** 一次 IO 快照采集（同步）。失败 / 退化返回 undefined。 */
function captureSnapshot(args: {
  readonly cwd: string;
  readonly exec: GitExec;
  readonly timeoutSeconds?: number;
}): GitSnapshot | undefined {
  const { cwd, exec, timeoutSeconds } = args;
  if (cwd.trim() === "") return undefined;

  // 1) status（含 branch 注解行）—— 任一 spawn 失败 → 整体退化
  // （退化即 undefined,分型不透出）。
  const statusResult = exec(
    ["--no-pager", "status", "--porcelain=v1", "-b"],
    cwd,
    timeoutSeconds
  );
  if (statusResult.status !== 0) {
    return undefined;
  }
  const porcelain = statusResult.stdout ?? "";
  const branch = parseBranchFromStatus(porcelain);
  const statusBody = cleanStatusBlock(porcelain);

  // 2) mainBranch（origin/HEAD）—— 软失败，无 origin / 离线 → null，不整体退化。
  let mainBranch: string | null = null;
  const mainResult = exec(
    ["--no-pager", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    cwd,
    timeoutSeconds
  );
  if (mainResult.status === 0) {
    const trimmed = (mainResult.stdout ?? "").trim();
    mainBranch = trimmed === "" ? null : trimmed;
  }

  // 3) recent commits —— 软失败 → 空数组。
  let recentCommits: ReadonlyArray<string> = [];
  const logResult = exec(
    ["--no-pager", "log", "--oneline", "-5"],
    cwd,
    timeoutSeconds
  );
  if (logResult.status === 0) {
    recentCommits = (logResult.stdout ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => truncateByCodepoints(l, GIT_FIELD_MAX_CHARS));
  }

  return Object.freeze({
    branch,
    mainBranch,
    status:
      statusBody === ""
        ? null
        : truncateByCodepoints(statusBody, GIT_STATUS_MAX_CHARS),
    recentCommits,
  });
}

// ---------------------------------------------------------------------------
// 段渲染（纯函数，assemble.ts 调用；与 projectPathSegment 同形态）
// ---------------------------------------------------------------------------

/**
 * 渲染 `## Git` 段：四要素 + D1 免责句。
 *
 * - snapshot === undefined → undefined（装配层不追加段，字节级零变化；
 *   退化态在 provider 侧已收敛为 undefined,本函数不再二次判退化）。
 * - 否则：标题 + 四要素 + 免责句。
 *
 * 字段缺席（branch / mainBranch === null）渲染占位 "—"；clean status
 * 渲染占位 "(clean)"；recentCommits 空渲染占位 "(none)"。test 断言引用
 * SSOT 常量。
 */
export function gitSnapshotSegment(
  snapshot: GitSnapshot | undefined
): string | undefined {
  if (snapshot === undefined) return undefined;

  const branch = snapshot.branch ?? "—";
  const mainBranch = snapshot.mainBranch ?? "—";
  const status = snapshot.status ?? "(clean)";
  const commits =
    snapshot.recentCommits.length === 0
      ? "(none)"
      : snapshot.recentCommits.join("\n  ");

  const body = [
    `main-branch: ${branch}`,
    `pr-base: ${mainBranch}`,
    `status:\n${status}`,
    `recent-commits:\n  ${commits}`,
    GIT_SEGMENT_DISCLAIMER,
  ].join("\n");

  return `${GIT_SEGMENT_TITLE}\n${body}`;
}
