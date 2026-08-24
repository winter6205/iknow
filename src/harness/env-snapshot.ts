/**
 * #653 G1 / 包1-感知 T4 — 环境现势快照计算（含上限与 EXIT）。
 *
 *   - 纯构造器 `parseEnvSnapshot`(无 IO / 无时间 / 无随机依赖):
 *     接收 git status / git diff 的 stdout 字符串,产出 EnvSnapshot(branch /
 *     status 文本 / dirty 计数 / diff 预览)。T5 人读面从此投影,不直接读
 *     git。
 *   - 截断工具 `truncateByCodepoints`:按 Unicode codepoint 计数
 *     (`Array.from(s).length`),不是 UTF-16 code unit,也不是字节;超过上限
 *     追加 `[truncated N chars]` 标记(spec 锁 2000 cp,plan 可调数字但
 *     不取消上限)。
 *   - IO 读取器 `readEnvSnapshot`:DI 注入 `exec`(默认走 node 子进程),
 *     跑 `git status --porcelain=v1 -b` 与 `git --no-pager diff --no-color`
 *     两次,各设 5s timeout,
 *     **永不 throw** —— cwd 不可解析 / git 二进制缺失 / 超时 / 非 git
 *     工作区 → git 字段全 null、cwd 仍保留(spec §"失败态":EXIT degraded,
 *     不进模型上下文,不 throw)。
 *
 * 与 `agent-status.ts` 同形:纯计算 + IO 读取器分列,失败态收敛为 null
 * 字段,绝不抛进模型回合。本模块不动 ADR-0028 状态栏 / `agent-status`
 * 追加路径(由 T5 在 chrome 独立槽位装配)。
 *
 * spec: `specs/653-horizon-pkg1-perception.md` §"环境现势" /
 * §"失败态"。plan: `plans/653-horizon-pkg1-perception.md` T4。
 */
import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// 公共类型 + 常量
// ---------------------------------------------------------------------------

/** 环境现势快照(人读 chrome 的单一真源;T5 UI 挂载不另建账本)。 */
export interface EnvSnapshot {
  /** 当前工作目录的字符串表示(cwd 不可解析时仍保留入参兜底字符串)。 */
  readonly cwd: string;
  /** git branch name;非 git 工作区 / git 失败 / branch 行缺失 → null。 */
  readonly gitBranch: string | null;
  /** `git status --porcelain=v1 -b` 全文(便于人读面诊断),失败 → null。 */
  readonly gitStatus: string | null;
  /** `git status --porcelain` 的非空行数;clean = 0;非 git / 失败 → null。 */
  readonly dirtyCount: number | null;
  /** `git diff` 输出,已按 codepoint 上限截断;失败 / 无 diff → null。 */
  readonly diffPreview: string | null;
}

/** 默认 diff codepoint 上限(spec 锁 2000;plan 可调,但不取消上限)。 */
export const MAX_ENV_DIFF_CHARS = 2000;

/** 默认 git 命令执行超时(秒);超时不 throw,读失败收敛为 null 字段。 */
const DEFAULT_GIT_TIMEOUT_SECONDS = 5;

// ---------------------------------------------------------------------------
// 纯计算:truncate + parse
// ---------------------------------------------------------------------------

/**
 * 按 Unicode codepoint 截断,超 max 加 `[truncated N chars]` marker(N =
 * 实际被丢掉的 codepoint 数,不是字节)。
 *
 * 边界:
 *   - `codepoints.length <= max` → 原样返回。
 *   - 非法上限(负数 / NaN / Infinity)一律按 0 处理:不保留主体,marker
 *     报告真实的丢弃数(max 为负时不得虚报)。
 *
 * 注意:`String.prototype.length` 是 UTF-16 code unit 计数,会高估 astral
 * plane 字符;本函数一律走 `Array.from(s)` 以 codepoint 为单位,符合
 * spec "≤2000 codepoints" 的字面要求。
 */
export function truncateByCodepoints(s: string, max: number): string {
  // NaN / 负数 → cap=0(全丢); Infinity → 无上限(原样返回);
  // 有限正数 → cap=max。SPEC SC 字面要求「输出长度 ≤ 上限」,marker 必须
  // 计入预算:总长 = 主体 + marker,任一超出都违反约定。先按真实丢弃数生成
  // marker,再按 marker 长度回填主体上限,保证总长严格 ≤ cap。
  const cap =
    !Number.isFinite(max) && max > 0
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Number.isFinite(max) ? max : 0);
  const codepoints = Array.from(s);
  if (codepoints.length <= cap) return s;
  // 上限过小(< marker 最小长度)→ 全部空间给 marker,主体空。
  const dropped = codepoints.length;
  const marker = `[truncated ${dropped} chars]`;
  const markerLen = Array.from(marker).length;
  const bodyCap =
    cap === Number.POSITIVE_INFINITY ? dropped : Math.max(0, cap - markerLen);
  const finalDropped = dropped - bodyCap;
  const finalMarker = `[truncated ${finalDropped} chars]`;
  return codepoints.slice(0, bodyCap).join("") + finalMarker;
}

/**
 * `git status --porcelain=v1 -b` 首行(`## <branch>...`)的 branch name。
 * branch 行为 `## HEAD (detached at abc123)` → 返回 `"HEAD"`;
 * branch 行缺席 → null。
 */
function parseBranchLine(porcelain: string): string | null {
  for (const line of porcelain.split("\n")) {
    if (!line.startsWith("## ")) continue;
    const body = line.slice(3).trim();
    // detached head: "HEAD (detached at <sha>)" → "HEAD";其他形态透传 body。
    if (body === "") return null;
    if (body.startsWith("HEAD")) return "HEAD";
    // 远程跟踪注解:"main [origin/main]" → "main"。
    const spaceIdx = body.indexOf(" ");
    return spaceIdx >= 0 ? body.slice(0, spaceIdx) : body;
  }
  return null;
}

/**
 * `git status` 输出里"非 git 工作区"标志。stderr 透传后的典型形态:`fatal:
 * not a git repository (or any of the parent directories): .git`。本函数
 * 视这条为退化态(EXIT degraded),字段全 null,让上层 UI 显示
 * `(not a git repo)`。
 */
function isNotAGitRepoMessage(s: string): boolean {
  return s.includes("fatal: not a git repository");
}

/**
 * 纯计算:git / diff 字符串 → EnvSnapshot。无 IO、无时间 / 随机依赖。
 *
 * 行为要点:
 *   - 输入按 **LF 分隔** porcelain v1 文本解析(readEnvSnapshot 不带 `-z`,
 *     保证人读摘要与解析器同语义;NUL 安全对机器消费才需要)。
 *   - 非 git 工作区的 git 报错(`fatal: not a git repository`)或空 stdout
 *     → git 字段退化(diff 预览若非空仍透出);调用方 IO 层已把"git 退出码
 *     非 0"短路成 degradedSnapshot,本函数保留这两条分支给直接拼接路径复用。
 *   - branch 行(`## ...`)缺失 → `gitBranch = null`,但 dirty 行仍正常计数。
 *   - 返回值冻结(Object.freeze),与 `parseAgentStatusText` 同一不可变契约;
 *     TUI 消费侧不得改写快照字段。
 */
export function parseEnvSnapshot(input: {
  readonly cwd: string;
  readonly gitStdout: string;
  readonly diffStdout: string;
}): EnvSnapshot {
  const { cwd, gitStdout } = input;
  const diffPreview = input.diffStdout === "" ? null : input.diffStdout;
  if (isNotAGitRepoMessage(gitStdout)) {
    return Object.freeze({
      cwd,
      gitBranch: null,
      gitStatus: null,
      dirtyCount: null,
      diffPreview,
    });
  }
  if (gitStdout === "") {
    // 空 stdout:clean 工作区等价(branch 头缺席、无脏行)。
    return Object.freeze({
      cwd,
      gitBranch: null,
      gitStatus: null,
      dirtyCount: 0,
      diffPreview,
    });
  }
  const branch = parseBranchLine(gitStdout);
  // dirty 行计数:branch 行("## ...")不计,纯空行不计。
  const dirtyCount = gitStdout
    .split("\n")
    .filter((l) => l.length > 0 && !l.startsWith("## ")).length;
  return Object.freeze({
    cwd,
    gitBranch: branch,
    gitStatus: gitStdout,
    dirtyCount,
    diffPreview,
  });
}

// ---------------------------------------------------------------------------
// IO 读取器
// ---------------------------------------------------------------------------

/** DI 覆盖点:`exec` 替换为 stub,默认走 `node:child_process.spawn`。 */
export type EnvExec = (
  cmd: string,
  args: readonly string[],
  cwd: string
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

export interface ReadEnvSnapshotOpts {
  readonly cwd: string;
  /** 测试可注入;默认走 spawn 子进程跑 git。 */
  readonly exec?: EnvExec;
  /** diff 截断 codepoint 上限;默认 `MAX_ENV_DIFF_CHARS`。 */
  readonly maxDiffChars?: number;
}

/**
 * 默认 exec:`spawn` 跑 git,捕获 stdout / stderr,5s 后未结束就 kill -9。
 *
 * 退出码非 0 或 spawn 失败(ENOENT / EACCES / spawn reject 等)时 reject,
 * 由 `readEnvSnapshot` 顶层 try/catch 收敛 —— **本函数本身只承诺 reject
 * 描述真实的失败原因,不替上层做"永 throw"封装**。
 */
function defaultExec(
  cmd: string,
  args: readonly string[],
  cwd: string
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, [...args], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        // detached:false 让父进程退出时子进程被一同清理,避免挂死。
        detached: false,
      });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      reject(
        new Error(`${cmd} timed out after ${DEFAULT_GIT_TIMEOUT_SECONDS}s`)
      );
    }, DEFAULT_GIT_TIMEOUT_SECONDS * 1000);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      if (!timedOut) reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return; // reject 已在 timer 内发出
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        // 退码非 0(典型:非 git 工作区 → "fatal: not a git repository");
        // 把 stderr 透出,上层 parseEnvSnapshot 看到 "fatal: ..." 时返回
        // 全 null(由 defaultExec 调用方 try/catch 处理)。
        reject(
          new Error(`${cmd} ${args.join(" ")} exited ${code}: ${stderr.trim()}`)
        );
      }
    });
  });
}

/**
 * IO 读取器:跑两次 git 命令 → 投影为 EnvSnapshot。**永不 throw** —— 任何
 * 一次 git 失败(ENOENT / 退码非 0 / 超时 / spawn reject)都收敛为 git
 * 字段全 null,cwd 保留。
 *
 * 命令:
 *   - `git status --porcelain=v1 -b`(LF 分隔 + branch 头;**不带 `-z`**,
 *     人读摘要按行解析,NUL 安全只有机器消费才需要)
 *   - `git --no-pager diff --no-color`(no pager 防 terminal hang)
 *
 * spec EXIT 表:非 git 工作区 / git 失败 → git 摘要 fallback(本模块
 * 返回 null 字段,由 T5 chrome 显示 `(not a git repo)` / `(git unavailable)`)。
 */
export async function readEnvSnapshot(
  opts: ReadEnvSnapshotOpts
): Promise<EnvSnapshot> {
  const { cwd } = opts;
  const exec = opts.exec ?? defaultExec;
  const maxDiffChars = opts.maxDiffChars ?? MAX_ENV_DIFF_CHARS;

  let gitStdout = "";
  let diffStdout = "";

  try {
    const status = await exec("git", ["status", "--porcelain=v1", "-b"], cwd);
    gitStdout = status.stdout;
  } catch {
    return degradedSnapshot(cwd);
  }

  try {
    const diff = await exec("git", ["--no-pager", "diff", "--no-color"], cwd);
    diffStdout = diff.stdout;
  } catch {
    // git status 已成功 → diff 失败:保留 git 字段(branch / dirty),只丢 diffPreview。
    return truncateDiff(
      parseEnvSnapshot({ cwd, gitStdout, diffStdout: "" }),
      maxDiffChars
    );
  }

  return truncateDiff(
    parseEnvSnapshot({ cwd, gitStdout, diffStdout }),
    maxDiffChars
  );
}

function degradedSnapshot(cwd: string): EnvSnapshot {
  return {
    cwd,
    gitBranch: null,
    gitStatus: null,
    dirtyCount: null,
    diffPreview: null,
  };
}

function truncateDiff(snap: EnvSnapshot, max: number): EnvSnapshot {
  if (snap.diffPreview === null) return snap;
  return { ...snap, diffPreview: truncateByCodepoints(snap.diffPreview, max) };
}
