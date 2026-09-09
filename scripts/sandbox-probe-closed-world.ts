/**
 * T1（plans/closed-world-bash-fence.md）：闭世界断链盘点探针。
 *
 * 围栏反转（T3）将把 bash 围栏从「writable home 打底 + 黑名单补罩」改为
 * 「闭世界」——home 下非白名单不可见，可写集 = taskRoot + /tmp。本探针
 * **不改围栏**，而是手拼一个「无 writable home bind」的假设围栏 argv
 * （模拟 T3 反转后读白名单为空的状态），逐条实测合法场景是否断链，
 * 产出供 T2 人工裁决进读白名单的证据（名字 / 命令 / 退出码 / stderr 摘要）。
 *
 * 假设围栏形态（对照 src/harness/sandbox/bwrap.ts baseArgs，外层参数与
 * 生产 fence 一致；本文件只 import、不修改 src/）：
 *   --unshare-user-try --unshare-net --die-with-parent
 *   系统 ro-bind（READ_ONLY_SYSTEM_PATHS 单源 = /usr /bin /lib /lib64 /etc
 *   + 可选主机前缀按存在性）
 *   --bind <cwd> <cwd>（taskRoot 可写）
 *   --size <resources.tmp> --tmpfs /tmp（可写）
 *   （cwd 在 /tmp 下时按生产 isTmpDescendant 语义后置重绑）
 *   --proc /proc --dev-bind /dev /dev
 *   --clearenv + --setenv（BASE_ENV_WHITELIST 过滤后的 process.env，与
 *   生产 bash tool 一致；HOME/PATH 原样传入，home 路径不可达正是要观测
 *   的病灶）
 *   完全没有：home bind、SENSITIVE_PATHS tmpfs 罩、identity overlay。
 *   （生产 bindArgs 的 `--bind tmp tmp` 在 `--tmpfs /tmp` 下被整层遮蔽，
 *   无可观测效果，闭世界形态按计划验收文本省略。）
 *
 * 输出逐行 `[BREAK|ok|skip|by-design] <名字> — <命令> — exit <code>` +
 * stderr 摘要；结尾汇总 BREAK 候选（附建议）供 T2 裁决。inventory 模式
 * 本身 exit 0（盘点不是 pass/fail）；bwrap 不可用 = blocker，如实报告
 * 非 0，不伪造证据。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASE_ENV_WHITELIST,
  createEnvIsolation,
  createResourceLimits,
  OPTIONAL_HOST_RO_PREFIXES,
  READ_ONLY_SYSTEM_PATHS,
  requireBwrap,
  type ResourceLimits,
} from "../src/harness/sandbox/index.js";

const __filename = fileURLToPath(import.meta.url);

/** 期望语义：
 *  - works：闭世界下也必须工作（断链 = 候选）；
 *  - break-candidate：预期断链候选（断链 = 候选；未断如实报 ok）；
 *  - hidden：不可见即设计意图（~/.ssh），不进候选。 */
export type InventoryExpectation = "works" | "break-candidate" | "hidden";
export type InventoryStatus = "BREAK" | "ok" | "skip" | "by-design";

export interface InventoryScenario {
  readonly name: string;
  readonly command: string;
  readonly expect: InventoryExpectation;
  /** 汇总分组：toolchain / git-identity / repo-access / cache / state / shell / security */
  readonly group: string;
  /** BREAK 时的读白名单建议（供 T2 裁决，不是裁决本身）。 */
  readonly suggestion: string;
}

export interface InventoryOutcome {
  readonly scenario: InventoryScenario;
  readonly status: InventoryStatus;
  /** 围栏内退出码；spawn 层失败为 null。 */
  readonly exitCode: number | null;
  readonly hostExitCode: number | null;
  readonly detail: string;
  /** 是否进读白名单候选汇总（BREAK 且非 hidden 意外可见）。 */
  readonly candidate: boolean;
}

/**
 * 判定核心（纯函数）。主机基线先跑同一命令：主机上就失败的（工具不存在、
 * 文件不在）= skip，不算围栏断链；主机 ok 而围栏失败 = BREAK 证据。
 */
export function classifyOutcome(
  expect: InventoryExpectation,
  hostExit: number | null,
  fenceExit: number | null
): { status: InventoryStatus; candidate: boolean } {
  if (hostExit === null || hostExit !== 0) {
    return { status: "skip", candidate: false };
  }
  const fenceFailed = fenceExit === null || fenceExit !== 0;
  switch (expect) {
    case "hidden":
      // 设计意图 = 不可见：fence 失败 → by-design；fence 成功 = 本应
      // 不可见却可见（围栏形态异常）；null = spawn 层失败无法判定。
      // 两条异常路径都不进候选（不是读白名单证据），但如实标 BREAK。
      if (fenceExit === null || !fenceFailed) {
        return { status: "BREAK", candidate: false };
      }
      return { status: "by-design", candidate: false };
    case "works":
    case "break-candidate":
      return { status: fenceFailed ? "BREAK" : "ok", candidate: fenceFailed };
  }
}

/** stderr/stdout 摘要：折叠空白、截断，防止多行错误刷屏。 */
export function summarizeText(text: string | undefined, max = 200): string {
  const collapsed = (text ?? "").trim().replace(/\s+/g, " ");
  if (collapsed.length === 0) return "";
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}…`;
}

export function formatOutcomeLine(outcome: InventoryOutcome): string {
  const exit = outcome.exitCode === null ? "null" : String(outcome.exitCode);
  const base = `[${outcome.status}] ${outcome.scenario.name} — ${outcome.scenario.command} — exit ${exit}`;
  return outcome.detail ? `${base} — ${outcome.detail}` : base;
}

/** BREAK 候选汇总（按 group 分组 + 建议），供 T2 逐条裁决。 */
export function summarizeBreakCandidates(
  outcomes: readonly InventoryOutcome[]
): string {
  const breaks = outcomes.filter((o) => o.status === "BREAK" && o.candidate);
  if (breaks.length === 0) {
    return "(无 BREAK 候选 —— 闭世界未观察到合法场景断链)";
  }
  const lines: string[] = [];
  let lastGroup = "";
  for (const b of breaks) {
    if (b.scenario.group !== lastGroup) {
      lines.push(`# ${b.scenario.group}`);
      lastGroup = b.scenario.group;
    }
    const exit = b.exitCode === null ? "null" : String(b.exitCode);
    lines.push(
      `  [BREAK] ${b.scenario.name} — ${b.scenario.command} — exit ${exit}`
    );
    lines.push(`    建议: ${b.scenario.suggestion}`);
  }
  lines.push(`(共 ${breaks.length} 条 BREAK 候选;by-design / skip 不在内)`);
  return lines.join("\n");
}

/** 与 bwrap.ts isTmpDescendant 同语义（私有函数，未导出，此处镜像）。 */
function isTmpDescendant(path: string, tmp: string): boolean {
  const rel = relative(tmp, path);
  return rel !== "" && rel !== ".." && !rel.startsWith("../");
}

/**
 * 闭世界假设围栏的 mount 段（不含 --clearenv/--setenv/--chdir/-- 命令段）。
 * 刻意没有 home 参数——「无 writable home bind」由签名本身钉住。
 */
export function buildClosedWorldBaseArgs(opts: {
  readonly cwd: string;
  readonly tmpDir: string;
  readonly tmpSize: number;
  readonly existingOptionalPrefixes: readonly string[];
}): string[] {
  const { cwd, tmpDir, existingOptionalPrefixes } = opts;
  void opts.tmpSize;
  const guestTmp = "/tmp";
  const cwdRebind = isTmpDescendant(cwd, guestTmp) ? ["--bind", cwd, cwd] : [];
  return [
    "--unshare-user-try",
    "--unshare-net",
    "--die-with-parent",
    // 系统 ro-bind 单源:直接消费生产的 READ_ONLY_SYSTEM_PATHS
    // (/usr /bin /lib /lib64 /etc),不再手抄——消除与生产集合的静默漂移面
    // (code-review L2)。顺序与生产 bwrap baseArgs 一致。
    ...READ_ONLY_SYSTEM_PATHS.flatMap((p) => ["--ro-bind", p, p]),
    ...existingOptionalPrefixes.flatMap((p) => ["--ro-bind", p, p]),
    "--bind",
    tmpDir,
    tmpDir,
    "--bind",
    cwd,
    cwd,
    "--bind",
    tmpDir,
    guestTmp,
    ...cwdRebind,
    "--proc",
    "/proc",
    "--dev-bind",
    "/dev",
    "/dev",
  ];
}

/** 完整 bwrap argv：mount 段 + env 注入 + chdir + 命令（与 createBwrapFence 外层合同一致）。 */
export function buildClosedWorldArgv(opts: {
  readonly cwd: string;
  readonly tmpDir: string;
  readonly tmpSize: number;
  readonly existingOptionalPrefixes: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly command: string;
  readonly args: readonly string[];
}): string[] {
  const envArgs = Object.entries(opts.env).flatMap(([name, value]) =>
    value === undefined ? [] : ["--setenv", name, value]
  );
  return [
    "bwrap",
    ...buildClosedWorldBaseArgs({
      cwd: opts.cwd,
      tmpDir: opts.tmpDir,
      tmpSize: opts.tmpSize,
      existingOptionalPrefixes: opts.existingOptionalPrefixes,
    }),
    // --clearenv 必须先于全部 --setenv（#225，与生产 fence 同序）。
    "--clearenv",
    ...envArgs,
    "--chdir",
    opts.cwd,
    "--",
    opts.command,
    ...opts.args,
  ];
}

/** login shell rc 可见性命令：只断言主机上存在的 rc 文件（`-r` 可读）。 */
export function buildRcProbeCommand(rcFiles: readonly string[]): string {
  return rcFiles.map((f) => `[ -r ${f} ]`).join(" && ");
}

/** PATH 可达性命令：主机上存在的 PATH 条目逐个 test -d，任一不可见即非 0。 */
export function buildPathProbeCommand(pathDirs: readonly string[]): string {
  const list = pathDirs.map((d) => `"${d}"`).join(" ");
  return `missing=0; for d in ${list}; do [ -d "$d" ] || { echo "missing:$d"; missing=1; }; done; exit $missing`;
}

/**
 * 场景清单。每条都先跑主机基线：主机不存在的工具/文件由统一 skip 规则
 * 处理（判定理由 = 主机基线 stderr），不伪装成 ok/BREAK。
 */
export function buildScenarios(opts: {
  readonly cwd: string;
  readonly rcFiles: readonly string[];
  readonly pathDirs: readonly string[];
}): readonly InventoryScenario[] {
  const { cwd, rcFiles, pathDirs } = opts;
  const toolchainSuggestion =
    "读白名单 ro-bind node 安装根（本机为 ~/node；nvm 形态则 ~/.nvm / volta / fnm 根），或围栏外重建 PATH；不逐二进制放行";
  const gitIdentitySuggestion =
    "读白名单 ro-bind ~/.gitconfig（只读）；或围栏内 env 注入 GIT_AUTHOR_*/GIT_COMMITTER_*；不放写（持久配置面）";
  const iknowSuggestion =
    "读白名单 ro-bind ~/.iknow（只读）；写保持禁绝（#896：init.sh 是被执行的持久文件，读放行 = 可执行，交 T2 裁决）";
  const cacheSuggestion =
    "倾向不放行（缓存可重建，围栏内写应落 /tmp）；确需离线装包再最小 ro-bind（只读）";
  const scenarios: InventoryScenario[] = [
    {
      name: "node 查找",
      command: "which node",
      expect: "break-candidate",
      group: "toolchain",
      suggestion: toolchainSuggestion,
    },
    {
      name: "node 运行",
      command: "node -v",
      expect: "break-candidate",
      group: "toolchain",
      suggestion: toolchainSuggestion,
    },
    {
      name: "npm 运行",
      command: "npm -v",
      expect: "break-candidate",
      group: "toolchain",
      suggestion: toolchainSuggestion,
    },
    {
      name: "npx 运行",
      command: "npx --version",
      expect: "break-candidate",
      group: "toolchain",
      suggestion: toolchainSuggestion,
    },
    {
      name: "bun 运行",
      command: "bun -v",
      expect: "break-candidate",
      group: "toolchain",
      suggestion:
        "读白名单 ro-bind ~/.bun 或裁决不放行（TUI/测试工作流是否需要在围栏内跑 bun）",
    },
    {
      name: "git 全局 config 读取",
      command: "git config --global --list",
      expect: "break-candidate",
      group: "git-identity",
      suggestion: gitIdentitySuggestion,
    },
    {
      name: "git 全局 user.name",
      command: "git config --global user.name",
      expect: "break-candidate",
      group: "git-identity",
      suggestion: gitIdentitySuggestion,
    },
    {
      name: "git 身份解析（隔离观测 @/tmp）",
      command: "cd /tmp && git var GIT_COMMITTER_IDENT",
      expect: "break-candidate",
      group: "git-identity",
      suggestion: gitIdentitySuggestion,
    },
    {
      name: "git worktree 元数据（var @taskRoot）",
      command: `git -C ${cwd} var GIT_COMMITTER_IDENT`,
      expect: "break-candidate",
      group: "repo-access",
      suggestion:
        "读白名单 ro-bind 主仓 .git（至少 .git/worktrees/<name> gitdir）；本条与身份解析叠加观测，归因需与 @/tmp 隔离条对比",
    },
    {
      name: "git worktree status",
      command: `git -C ${cwd} status --porcelain`,
      expect: "break-candidate",
      group: "repo-access",
      suggestion:
        "读白名单 ro-bind 主仓 .git（worktree .git file 指向主仓 gitdir，闭世界下不可达）；否则围栏内 git 全链路不可用",
    },
    {
      name: "npm 缓存目录可达",
      command: 'test -d "$(npm config get cache)"',
      expect: "break-candidate",
      group: "cache",
      suggestion: cacheSuggestion,
    },
    {
      name: "pip 缓存目录可达",
      command: 'test -d "$(pip3 cache dir)"',
      expect: "break-candidate",
      group: "cache",
      suggestion: cacheSuggestion,
    },
    {
      name: "~/.iknow 目录可见",
      command: "ls ~/.iknow",
      expect: "break-candidate",
      group: "state",
      suggestion: iknowSuggestion,
    },
    {
      name: "~/.iknow/init.sh 读取",
      command: "cat ~/.iknow/init.sh",
      expect: "break-candidate",
      group: "state",
      suggestion: iknowSuggestion,
    },
    {
      name: "~/.claude 目录可见",
      command: "ls ~/.claude",
      expect: "break-candidate",
      group: "state",
      suggestion:
        "默认倾向不放行（含凭证 / 会话数据）；确需再最小 ro-bind（只读）",
    },
    {
      name: "login shell 基线",
      command: "bash -lc 'echo ok'",
      expect: "works",
      group: "shell",
      suggestion: "若 BREAK：读白名单 ro-bind rc 文件或接受 login shell 降级",
    },
    {
      name: "~/.ssh 不可见（设计意图）",
      command: "ls ~/.ssh",
      expect: "hidden",
      group: "security",
      suggestion: "",
    },
  ];
  if (rcFiles.length > 0) {
    scenarios.push({
      name: "login shell rc 可见",
      command: buildRcProbeCommand(rcFiles),
      expect: "break-candidate",
      group: "shell",
      suggestion:
        "读白名单 ro-bind rc 文件（只读）或接受降级（不可见 = rc 无持久副作用，也可能是有利面）",
    });
  }
  if (pathDirs.length > 0) {
    scenarios.push({
      name: "PATH 条目可达",
      command: buildPathProbeCommand(pathDirs),
      expect: "break-candidate",
      group: "toolchain",
      suggestion:
        "优先 PATH 重建（剔除不可达条目，闭世界下 PATH 需要显式装配）；确需保留的目录走读白名单 ro-bind",
    });
  }
  return scenarios;
}

interface ProbeContext {
  readonly cwd: string;
  readonly tmpDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly resources: ResourceLimits;
  readonly existingOptionalPrefixes: readonly string[];
}

function runScenario(
  scenario: InventoryScenario,
  ctx: ProbeContext
): InventoryOutcome {
  // 主机基线：全量 process.env（非过滤），同 cwd。主机即失败 → skip。
  const host = spawnSync("bash", ["-c", scenario.command], {
    cwd: ctx.cwd,
    encoding: "utf8",
  });
  const hostExit = host.status;
  if (hostExit === null || hostExit !== 0) {
    const why =
      summarizeText(host.stderr) || summarizeText(host.stdout) || "无输出";
    return {
      scenario,
      status: "skip",
      exitCode: null,
      hostExitCode: hostExit,
      detail: `主机上即失败(exit ${hostExit ?? "null"}),与围栏无关: ${why}`,
      candidate: false,
    };
  }
  const argv = buildClosedWorldArgv({
    cwd: ctx.cwd,
    tmpDir: ctx.tmpDir,
    tmpSize: ctx.resources.tmp,
    existingOptionalPrefixes: ctx.existingOptionalPrefixes,
    env: ctx.env,
    command: "bash",
    args: ["-c", scenario.command],
  });
  const fence = spawnSync(argv[0] as string, argv.slice(1), {
    cwd: ctx.cwd,
    encoding: "utf8",
    env: ctx.env,
  });
  const { status, candidate } = classifyOutcome(
    scenario.expect,
    hostExit,
    fence.status
  );
  const fenceStderr = summarizeText(fence.stderr);
  const fenceStdout = summarizeText(fence.stdout);
  let detail = "";
  if (status === "BREAK") {
    detail = fenceStderr || fenceStdout || "无输出";
  } else if (status === "by-design") {
    detail = fenceStderr || fenceStdout || "不可见";
  } else if (status === "ok") {
    // 退出码相同但输出静默降级（如 config 列表变空）也要暴露给裁决。
    const hostOut = (host.stdout ?? "").trim();
    const fenceOut = (fence.stdout ?? "").trim();
    if (hostOut !== fenceOut) {
      detail = `输出与主机基线不同(host="${summarizeText(hostOut, 80)}" fence="${summarizeText(fenceOut, 80)}")`;
    }
  }
  return {
    scenario,
    status,
    exitCode: fence.status,
    hostExitCode: hostExit,
    detail,
    candidate,
  };
}

async function main(): Promise<void> {
  // blocker 预检：bwrap 不可用 = 无法产出任何证据，如实非 0，不伪造。
  try {
    requireBwrap();
  } catch (err) {
    console.error(
      `BLOCKER: ${String(err instanceof Error ? err.message : err)}`
    );
    console.error(
      "闭世界盘点无法执行（无 bwrap 即无围栏证据），未产出任何结论。"
    );
    process.exitCode = 1;
    return;
  }
  const version = spawnSync("bwrap", ["--version"], { encoding: "utf8" });
  const cwd = process.cwd();
  const home = homedir();
  const env = createEnvIsolation({ allowEnv: BASE_ENV_WHITELIST }).filter(
    process.env
  );
  const resources = createResourceLimits();
  const existingOptionalPrefixes = OPTIONAL_HOST_RO_PREFIXES.filter((p) =>
    existsSync(p)
  );
  const rcFiles = [".bashrc", ".profile"]
    .filter((f) => existsSync(resolve(home, f)))
    .map((f) => `~/${f}`);
  const pathDirs = [
    ...new Set(
      (process.env.PATH ?? "")
        .split(":")
        .filter((p) => p.length > 0 && existsSync(p))
    ),
  ];
  const ctx: ProbeContext = {
    cwd,
    tmpDir: tmpdir(),
    env,
    resources,
    existingOptionalPrefixes,
  };
  const scenarios = buildScenarios({ cwd, rcFiles, pathDirs });
  console.log(
    `sandbox-probe closed-world inventory (bwrap ${version.stdout?.trim() ?? "unknown"})`
  );
  console.log(
    `围栏形态: 系统 ro-bind(${READ_ONLY_SYSTEM_PATHS.join(" ")} + 可选前缀[${
      existingOptionalPrefixes.join(",") || "无"
    }]) + cwd 可写 bind + --tmpfs /tmp + --proc + --dev-bind`
  );
  console.log(
    "  无 home bind / 无 SENSITIVE_PATHS tmpfs 罩 / 无 identity overlay;--unshare-net 默认;env = BASE_ENV_WHITELIST 过滤(HOME/PATH 原样传入)"
  );
  console.log(`taskRoot(cwd): ${cwd}`);
  console.log("");
  const outcomes: InventoryOutcome[] = [];
  for (const scenario of scenarios) {
    const outcome = runScenario(scenario, ctx);
    outcomes.push(outcome);
    console.log(formatOutcomeLine(outcome));
  }
  console.log("");
  console.log("## 读白名单候选汇总（BREAK，供 T2 人工裁决）");
  console.log("");
  console.log(summarizeBreakCandidates(outcomes));
  // 盘点不是 pass/fail：有 BREAK 也 exit 0（证据供裁决，不算失败）。
  process.exitCode = 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === __filename) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
