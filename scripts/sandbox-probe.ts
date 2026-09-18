/**
 * sandbox probe suite — 全局档 + 工作区档（ADR-0092），三档形态，各自跑
 * 与该档相关的清单。
 *
 * 消费生产 `createFsPolicy` / `createBwrapFence`，对 specs/fs-isolation-modes.md
 * 做物理验收：
 *   - global / worktree 档跑 Round 1 默认姿态（SC1–SC3）：宿主真路径可见可写、
 *     系统前缀只读覆盖、会话 tmp 保留宿主真路径（**没有**垫底 bind 到 guest
 *     `/tmp`）、env 轴不借本改动放开。
 *   - workspace 档跑 Round 2 的 SC11/SC12（ADR-0092 Amendment 2026-09-13）：
 *     home 可见但只读、写 = 活 taskRoot ∪ 会话 tmp、home 之外不收紧。
 * 三档先后各跑一遍、各自汇总：
 *
 *   global    — 全局档；cwd = 真实可写临时目录（主仓 taskRoot 语义）。
 *   worktree  — 全局档；cwd = 「主仓 + 其内 worktree」git fixture 里的 worktree；
 *               全局档下 gitdir 直接经宿主根可见，不再需要 identity ro-bind。
 *   workspace — 工作区档；home = fixture home（围栏内 `$HOME` 也指向它 ——
 *               **绝不碰真实 home**）、cwd = 另一个 tmp 目录（taskRoot 语义）、
 *               pad = fixture home 子树内的会话 tmp。
 *
 * 每档 = 该档的物理类清单（旧 11 类中的 fence 类保留语义；闭世界专有类退役，
 * 换成全局档类 + 工作区档类）。两个 violation counter 是 node-side、与 fence
 * 档位无关，只在共享节跑一次。exit code：全绿（skip 视为绿并注明）= 0，否则 1。
 *
 * 语义注记：
 *  - 全局档 argv = `--bind / /` 打底（宿主真路径可见可写）→ 系统前缀
 *    `/usr /bin /lib /lib64 /etc`（+ 存在性可选 `/opt /snap`）只读覆盖 →
 *    `--proc` / `--dev-bind`。没有 `--bind <pad> /tmp`、没有 `--tmpfs`、
 *    没有 per-root 可写白名单。
 *  - 工作区档 argv = 全局档之上再叠三层（bwrap last-mount-wins 序）：
 *    `--ro-bind <home> <home>`（可见但只读）→ `--bind <taskRoot> <taskRoot>`
 *    → `--bind <会话 tmp> <会话 tmp>`（两处写白名单覆盖回可写）。home 之外
 *    （如 `/tmp`）不受本档收紧 —— 本档只收紧 home 写。
 *  - 会话 tmp（identity pad）在 global 档不是 argv mount 目标，只作为
 *    `$TMPDIR` 的值注入；workspace 档它是两处写白名单 bind 之一（home 子树
 *    内唯一可写处）。两档共同点：围栏内写 `$TMPDIR/...` 落宿主 pad，写 guest
 *    `/tmp/...` 落宿主 `/tmp`（与 pad 是两处，绝不静默双写）。
 *  - `--size`/`--tmpfs` 退役后 tmp 配额不再是围栏形态的一部分，
 *    ResourceLimits 仅作未来 hook 的常量面，探针不再做超限物理验收。
 *  - **ADR-0097**：`--unshare-net` 是常量；网路轴探针由「opt-in 共享宿主
 *    netns」转为「egress 缝可达」。`spawnFenceSync` / `spawnFenceAsync`
 *    无 `network` 参数 —— 出网能力只经 egress 缝，无 per-call opt-in 面。
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  BASE_ENV_WHITELIST,
  createBwrapFence,
  createEnvIsolation,
  createFsPolicy,
  type FsIsolationMode,
  type FsPolicy,
} from "../src/harness/sandbox/index.js";
import { requireBwrap } from "../src/harness/sandbox/runner.js";
import { createViolationCounter } from "../src/harness/sandbox/violation-handling.js";

type ProbeResult = { ok: boolean; detail: string };
interface ProbeCheck {
  readonly name: string;
  readonly run: () => Promise<ProbeResult>;
}

const HOME = homedir();
const TMP = tmpdir();
const ENV_BASE = createEnvIsolation({ allowEnv: BASE_ENV_WHITELIST }).filter(
  process.env
);
/** host 侧唯一 token（探针进程级别；避免档间 / 并发跑互相看到标记）。 */
const TOKEN = `iknow-probe-${process.pid}`;

// ---------------------------------------------------------------------------
// fence 执行体（每档一份 policy / pad，同一 runner）
// ---------------------------------------------------------------------------

interface ProbeProfile {
  /** 档位名（输出汇总用）。 */
  readonly name: string;
  /**
   * fs 隔离档（ADR-0092 Amendment / SC11/SC12）—— 决定 argv 是否叠
   * home ro-bind + 两处写白名单 bind，也决定 buildChecks 选哪批检查。
   * global / worktree 两个 profile 是本文件的 V1 回归钉，恒 `"global"`。
   */
  readonly fsMode: FsIsolationMode;
  /** taskRoot——fence cwd。 */
  readonly cwd: string;
  /** 本身份的会话 tmp 宿主路径（`$TMPDIR` 的值；不是 argv mount 目标）。 */
  readonly pad: string;
  /** host 侧 sibling 可写靶（证明宿主真路径 / 非 cwd 也可写）。 */
  readonly extra: string;
  /**
   * workspace 档的 home ro-bind 源端 + 围栏内 `$HOME` 的值。global 档不发射
   * 该 bind，也不改 `$HOME`（沿用宿主真值）——故这里放 `HOME` 常量即可。
   */
  readonly home: string;
  readonly fsPolicy: FsPolicy;
  /** host 侧 fixture 清理。 */
  readonly cleanup: () => void;
}

/**
 * 每档 fence env：BASE_ENV_WHITELIST + 该档 `$TMPDIR`（镜像 bash.ts）。
 *
 * workspace 档额外把 `HOME` 指到 fixture home —— 生产装配里 home ro-bind 的
 * 源端就是缺省 `homedir()`,与围栏内 `$HOME` 同值;探针要测「围栏拒绝写
 * home」就绝不能把 `$HOME` 留在真实 home(命令里的 `$HOME` 会写到操作员
 * 家目录)。global 档 `$HOME` 保持宿主真值 —— 那是「home 不藏且可写」的
 * 被测语义本体,换成 fixture 反而测不到真路径可见。
 */
function fenceEnv(profile: ProbeProfile): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...ENV_BASE, TMPDIR: profile.pad };
  if (profile.fsMode === "workspace") env.HOME = profile.home;
  return env;
}

function spawnFenceSync(
  profile: ProbeProfile,
  command: string
): ReturnType<typeof spawnSync> {
  const env = fenceEnv(profile);
  const fence = createBwrapFence({
    command: "bash",
    args: ["-c", command],
    fsPolicy: profile.fsPolicy,
    env,
    cwd: profile.cwd,
    // workspace 档三层 mount 的源端绝对路径（ADR-0092 Amendment / SC11/SC12）；
    // global 档传了也不发射 —— 与生产 bash.ts 装配同款（只判 fsMode）,
    // 顺带把 bwrap 的 global 档 byte-identical 回归钉带进物理验收。
    ...(profile.fsMode === "workspace"
      ? {
          homeRoot: profile.home,
          workspaceRoot: profile.cwd,
          tmpRoot: profile.pad,
        }
      : {}),
  });
  return spawnSync(fence.argv[0], fence.argv.slice(1), {
    cwd: profile.cwd,
    encoding: "utf8",
    env,
  });
}

// Async spawn (NOT spawnSync) for the netns-sensitive checks. The loopback
// listener below lives in THIS process; while spawnSync blocks the event loop
// no callback can run, so curl inside the fence could never reach it.
function spawnFenceAsync(
  profile: ProbeProfile,
  command: string
): Promise<string> {
  const env = fenceEnv(profile);
  const fence = createBwrapFence({
    command: "bash",
    args: ["-c", command],
    fsPolicy: profile.fsPolicy,
    env,
    cwd: profile.cwd,
    ...(profile.fsMode === "workspace"
      ? {
          homeRoot: profile.home,
          workspaceRoot: profile.cwd,
          tmpRoot: profile.pad,
        }
      : {}),
  });
  return new Promise((resolvePromise) => {
    const child = spawn(fence.argv[0], fence.argv.slice(1), {
      cwd: profile.cwd,
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      resolvePromise(`1 | spawn error: ${err.message}`);
    });
    child.on("close", (code) => {
      resolvePromise(`${code ?? "null"} | ${stderr.trim()}`);
    });
  });
}

/** 期望语义归一：expectFail=true 时非 0 退出才算绿。 */
function verdict(status: number | null, expectFail: boolean): boolean {
  return expectFail ? status !== 0 : status === 0;
}

/**
 * 检查的适用档。`"both"` = 与档位无关的通用类；`"global"` / `"workspace"`
 * 只在对应档进清单。两档不是「同一命题的两种期望」而是**两份清单**
 * （global：宿主真路径可写；workspace：home 只读）——在同一 check 上翻
 * expectFail 会让「n/a」与「失败」无法分辨，故按档整体分桶，
 * `passed/total` 反映该档真实检查数。
 */
type CheckScope = "both" | FsIsolationMode;

function applies(scope: CheckScope, profile: ProbeProfile): boolean {
  return scope === "both" || scope === profile.fsMode;
}

function syncCheck(
  profile: ProbeProfile,
  name: string,
  command: string,
  expectFail = false
): ProbeCheck {
  return {
    name,
    run: async () => {
      const r = spawnFenceSync(profile, command);
      const detail = `${r.stdout?.trim() ?? ""} | ${r.stderr?.trim() ?? ""}`;
      return { ok: verdict(r.status, expectFail), detail };
    },
  };
}

function skippedCheck(name: string, reason: string): ProbeCheck {
  return {
    name,
    run: async () => ({ ok: true, detail: `skipped: ${reason}` }),
  };
}

// ---------------------------------------------------------------------------
// host 侧 fixture / 预检
// ---------------------------------------------------------------------------

interface HostFixtures {
  /** host 有 git 全局身份才跑读探针。 */
  readonly hasGitGlobalIdentity: boolean;
}

function setupHostFixtures(): HostFixtures {
  const gitIdentity = spawnSync("git", ["config", "--global", "user.name"], {
    encoding: "utf8",
  });
  return {
    hasGitGlobalIdentity:
      gitIdentity.status === 0 && (gitIdentity.stdout ?? "").trim().length > 0,
  };
}

/** worktree 档 git fixture：「主仓 + 其内 worktree」。任一步失败 = fail-loud。 */
function setupWorktreeFixture(): {
  base: string;
  main: string;
  wt: string;
} {
  const base = mkdtempSync(join(TMP, "iknow-probe-wt-"));
  const main = join(base, "main-repo");
  const wt = join(main, ".iknow", "worktrees", "probe");
  const git = (args: readonly string[]): void => {
    const r = spawnSync("git", args, { encoding: "utf8" });
    if (r.status !== 0) {
      rmSync(base, { recursive: true, force: true });
      throw new Error(
        `worktree fixture: git ${args.join(" ")} failed: ${(r.stderr ?? "").trim()}`
      );
    }
  };
  try {
    git(["init", "-q", "-b", "main", main]);
    git(["-C", main, "config", "user.email", "probe@iknow"]);
    git(["-C", main, "config", "user.name", "probe"]);
    writeFileSync(join(main, "marker.txt"), "identity-marker\n");
    git(["-C", main, "add", "."]);
    git(["-C", main, "commit", "-qm", "probe fixture"]);
    git(["-C", main, "worktree", "add", "-q", "-b", "probe", wt]);
    return { base, main, wt };
  } catch (err) {
    rmSync(base, { recursive: true, force: true });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Egress seam 检查分支（socat 缺失 / 在场 两路）。
// 抽成命名 helper 是为了让 buildChecks 的箭头函数本身落在 complexity ≤ 10
// (S5 硬门)。两路都钉 SC2 + SC13:egress seam 是出网唯一通路。
// ---------------------------------------------------------------------------

/**
 * socat 缺失分支:验证 `createEgressSession` 抛 `SocatUnavailableError`
 * (fail-closed typed error,非静默降级)。这是「边界语义正确」的硬证 —
 * 即使宿主没有 socat,探针仍能验证 fence 的网络闭合不依赖 socat 在场。
 */
async function runEgressSocatAbsentCheck(): Promise<ProbeResult> {
  const { createEgressSession, SocatUnavailableError } =
    await import("../src/harness/sandbox/egress/session.js");
  try {
    await createEgressSession({
      policy: {
        allowedDomains: [],
        deniedDomains: [],
        commandLabel: "probe-socat-absent",
      },
      socatCommand: "socat",
    });
    return {
      ok: false,
      detail:
        "socat missing branch FAILED: createEgressSession returned without throwing",
    };
  } catch (err) {
    if (err instanceof SocatUnavailableError) {
      return {
        ok: true,
        detail: `socat absent branch: fail-closed typed error raised (${err.socatCommand})`,
      };
    }
    return {
      ok: false,
      detail: `socat missing branch: wrong error type: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

/**
 * socat 在场分支:经**真内层桥**的端到端正探针（egress-ssh-bridge T1 重写,
 * 清偿 O2/O3——旧形态 `curl http://127.0.0.1:<port>` 在 NO_PROXY 含
 * `127.0.0.1` 时绕代理直连、netns 内必败,从未真正走通过这条缝;且旧代码
 * 只把 HTTP_PROXY 交给沙箱,而代理配了 proxyAuthToken、注入 URL 无
 * userinfo → 必 407,即 O1）。
 *
 * 现形态:
 *   1. 正探针 target = 宿主**非 loopback** NIC IPv4 上的真 listener
 *      （O2:loopback 字面会命中 NO_PROXY;地址守卫对「allowlist 上的 IP
 *      字面」不再复核——upstream resolved-address-guard.js:14-18 "An IP
 *      literal on the allowlist is an explicit choice and is never
 *      re-judged here"——所以私网 NIC 地址字面进 allowedDomains 即可达）;
 *   2. fence 命令链前导 = `session.spec.innerBridgeScript`（沙箱内 socat
 *      TCP-LISTEN:3128 → unix socket + trap 收尾）——与 bash.ts 前台装配
 *      同款拼接;
 *   3. curl 读注入的 `HTTP_PROXY=http://iknow:<token>@127.0.0.1:3128`
 *      （auth userinfo,O1 闭环）→ 内层桥 → 宿主代理 → filter 放行 →
 *      dial NIC listener → 200 body 匹配才算绿;
 *   4. 附加 assert:sink drain 为空（放行路径不得留违例）。
 *
 * 实测状态注记:本探针 present 分支要求宿主装有 socat。起草/实现环境
 * （WSL,`which socat` = 无）走的是 absent 分支——present 分支的形态以
 * 依赖包 linux-sandbox-utils.js `buildSandboxCommand` 实证为据,首次
 * 真机全绿由带 socat 的操作机承担（specs/egress-ssh-bridge.md O3:
 * 「本机无 socat → absent 分支报绿掩盖缺口」正是本次重写要消除的假绿面;
 * 无 NIC 地址时本分支 fail-loud 不报绿）。
 */
async function runEgressSocatPresentCheck(
  profile: ProbeProfile
): Promise<ProbeResult> {
  const { createEgressSession } =
    await import("../src/harness/sandbox/egress/session.js");
  const targetIp = pickNonLoopbackNicIPv4();
  if (targetIp === null) {
    return {
      ok: false,
      detail:
        "socat present branch: no non-loopback NIC IPv4 for the positive fixture (O2: loopback literal bypasses proxy via NO_PROXY)",
    };
  }
  const listener = await startProbeListener(targetIp);
  const port = listener.port;
  let session: Awaited<ReturnType<typeof createEgressSession>> | undefined;
  try {
    session = await createEgressSession({
      policy: {
        allowedDomains: [`${targetIp}:${port}`],
        deniedDomains: [],
        commandLabel: "probe-socat-present",
      },
      socatCommand: "socat",
    });
    // 与 bash.ts 前台装配同款:前导内层桥 + 用户命令同一 `bash -c` payload。
    // --retry-connrefused 消化前导 socat 与 curl 之间的启动竞态。
    const userCommand = `curl -sS --max-time 8 --retry 3 --retry-connrefused http://${targetIp}:${port} | grep -q probe-listener-ok`;
    const fence = createBwrapFence({
      command: "bash",
      args: ["-c", `${session.spec.innerBridgeScript}\n${userCommand}`],
      fsPolicy: profile.fsPolicy,
      env: fenceEnv(profile),
      cwd: profile.cwd,
      egress: session.spec,
      ...(profile.fsMode === "workspace"
        ? {
            homeRoot: profile.home,
            workspaceRoot: profile.cwd,
            tmpRoot: profile.pad,
          }
        : {}),
    });
    const child = spawn(fence.argv[0], fence.argv.slice(1), {
      cwd: profile.cwd,
      env: fenceEnv(profile),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    const exitCode: number | null = await new Promise((resolve) => {
      child.on("close", (code) => resolve(code));
      child.on("error", () => resolve(null));
    });
    const violations = session.violationSink.drain();
    return {
      ok: exitCode === 0 && violations.length === 0,
      detail: `exit=${exitCode} violations=${violations.length} stderr="${stderr.trim()}"`,
    };
  } catch (err) {
    return {
      ok: false,
      detail: `socat present branch threw: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  } finally {
    if (session !== undefined) {
      await session.dispose().catch(() => undefined);
    }
    listener.stop();
  }
}

/** 取宿主第一个非 internal 的 IPv4 NIC 地址;无 → null（fail-loud 交给调用方）。 */
function pickNonLoopbackNicIPv4(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 每档探针清单
// ---------------------------------------------------------------------------

function buildChecks(
  profile: ProbeProfile,
  fixtures: HostFixtures,
  listenerPort: number
): ProbeCheck[] {
  const checks: ProbeCheck[] = [];
  // 分档谓词：不适用当前档的检查**不 push** —— 汇总 total 反映该档真实
  // 检查数（不是「三档跑同一清单、部分恒绿」）。见 CheckScope 注释。
  const push = (scope: CheckScope, check: ProbeCheck): void => {
    if (applies(scope, profile)) checks.push(check);
  };

  // —— env 隔离（轴未借本改动放开；两档都跑）——
  push(
    "both",
    syncCheck(profile, "env isolation", 'test -z "$ANTHROPIC_AUTH_TOKEN"')
  );

  // —— SC1：home 可见（宿主真路径，非不可见）——
  //    仅 global 档：workspace 档另有更强的 "home visible (workspace)"
  //    （读 fixture home 里具体文件内容），重复 push 只是加一条同义证据。
  push(
    "global",
    syncCheck(
      profile,
      "home visible",
      'test -d "$HOME" && ls "$HOME" >/dev/null'
    )
  );
  // 断言相反的两面按档分桶：global 写 home 落宿主真值；workspace 写 home
  // 失败且宿主侧不落盘。
  push("global", {
    name: "home write lands on host (global writable)",
    run: async () => {
      const hostMarker = join(HOME, `${TOKEN}.home`);
      if (existsSync(hostMarker)) rmSync(hostMarker, { force: true });
      const r = spawnFenceSync(
        profile,
        `printf global-home > "$HOME/${TOKEN}.home" && test -s "$HOME/${TOKEN}.home"`
      );
      const persisted = existsSync(hostMarker);
      const content = persisted ? readFileSync(hostMarker, "utf8") : "";
      if (persisted) rmSync(hostMarker, { force: true });
      return {
        ok: r.status === 0 && content === "global-home",
        detail: `fence-exit=${r.status} host-persisted=${persisted} content="${content}"`,
      };
    },
  });
  push("workspace", {
    // SC11：home 可见（读得到 fixture home 里的普通文件）——
    // 与 global 的 "home visible" 分开是因为工作区档下 `$HOME` 已被探针
    // 指到 fixture home：这条检查证明 ro-bind 的读面成立，不是「路径不存在」。
    name: "home visible (workspace)",
    run: async () => {
      const r = spawnFenceSync(
        profile,
        `test -r "$HOME/${TOKEN}.seed" && cat "$HOME/${TOKEN}.seed"`
      );
      const detail = `${r.stdout?.trim() ?? ""} | ${r.stderr?.trim() ?? ""}`;
      return { ok: r.status === 0, detail };
    },
  });
  push("workspace", {
    // SC11：写 home 非白名单路径 = 内核层 EROFS（非零退出）**且**宿主侧
    // 不落盘 —— 只看退出码会把「静默丢写」也判绿。
    name: "home write denied (workspace)",
    run: async () => {
      const hostTarget = join(profile.home, "probe-write");
      if (existsSync(hostTarget)) rmSync(hostTarget, { force: true });
      const r = spawnFenceSync(profile, `touch "$HOME/probe-write"`);
      const persisted = existsSync(hostTarget);
      const stderr = r.stderr?.trim() ?? "";
      const rofs = /Read-only file system/.test(stderr);
      return {
        ok: r.status !== 0 && !persisted && rofs,
        detail: `fence-exit=${r.status} host-persisted=${persisted} rofs=${rofs} stderr="${stderr}"`,
      };
    },
  });

  // —— 系统前缀只读覆盖 + 工具链可见（与档位无关，两档同一姿态）——
  push(
    "both",
    syncCheck(profile, "/etc readonly", "touch /etc/iknow-probe-write", true)
  );
  push(
    "both",
    syncCheck(
      profile,
      "system prefix readable (/usr)",
      "test -r /usr/bin/env && test -x /usr/bin/env"
    )
  );
  push("both", syncCheck(profile, "node runs", "node -v"));
  push(
    "both",
    syncCheck(profile, "host prefix /opt", "test ! -d /opt -o -r /opt")
  );

  // —— cwd 可写（两档共有：taskRoot 就是 workspace 档的写白名单之一）——
  push(
    "both",
    syncCheck(
      profile,
      "cwd writable (taskRoot)",
      "touch probe-write && rm probe-write && echo ok"
    )
  );
  push("global", {
    name: "host path outside cwd writable (global writable)",
    run: async () => {
      const target = join(profile.extra, `${TOKEN}.extra`);
      if (existsSync(target)) rmSync(target, { force: true });
      const r = spawnFenceSync(
        profile,
        `printf global-extra > "${target}" && test -s "${target}"`
      );
      const persisted = existsSync(target);
      const content = persisted ? readFileSync(target, "utf8") : "";
      return {
        ok: r.status === 0 && content === "global-extra",
        detail: `fence-exit=${r.status} host-persisted=${persisted} content="${content}"`,
      };
    },
  });
  push(
    "both",
    // 两档同形：工作区档只收紧 home 写，home 之外的 `/tmp` 不受影响。
    syncCheck(
      profile,
      "guest /tmp writable (host /tmp via / bind)",
      `touch "/tmp/${TOKEN}.tmp" && rm "/tmp/${TOKEN}.tmp" && echo ok`
    )
  );

  // —— SC3：无 guest /tmp 别名；$TMPDIR = 会话 tmp 宿主路径 ——
  push("both", {
    name: "guest /tmp is host /tmp, not the session pad",
    run: async () => {
      const hostTmp = join(TMP, `${TOKEN}.alias`);
      const padTmp = join(profile.pad, `${TOKEN}.alias`);
      if (existsSync(hostTmp)) rmSync(hostTmp, { force: true });
      const r = spawnFenceSync(
        profile,
        `printf guest-tmp > "/tmp/${TOKEN}.alias" && test -s "/tmp/${TOKEN}.alias"`
      );
      const onHostTmp = existsSync(hostTmp);
      const inPad = existsSync(padTmp);
      if (onHostTmp) rmSync(hostTmp, { force: true });
      return {
        ok: r.status === 0 && onHostTmp && !inPad,
        detail: `fence-exit=${r.status} host-/tmp=${onHostTmp} pad=${inPad}`,
      };
    },
  });
  push(
    "both",
    syncCheck(
      profile,
      "$TMPDIR equals the session tmp host path",
      `test "$TMPDIR" = "${profile.pad}" && printf %s "$TMPDIR"`,
      false
    )
  );

  // —— SC2 / SC12：写会话 tmp 宿主路径落 pad，且不出现在宿主 /tmp ——
  push("both", {
    name: "session tmp write lands in the pad, not host /tmp",
    run: async () => {
      const padFile = join(profile.pad, `${TOKEN}.pad`);
      const hostTmpFile = join(TMP, `${TOKEN}.pad`);
      if (existsSync(padFile)) rmSync(padFile, { force: true });
      const r = spawnFenceSync(
        profile,
        `printf session-tmp > "$TMPDIR/${TOKEN}.pad" && test -s "$TMPDIR/${TOKEN}.pad"`
      );
      const inPad = existsSync(padFile);
      const content = inPad ? readFileSync(padFile, "utf8") : "";
      const onHostTmp = existsSync(hostTmpFile);
      return {
        ok: r.status === 0 && content === "session-tmp" && !onHostTmp,
        detail: `fence-exit=${r.status} pad="${content}" host-/tmp=${onHostTmp}`,
      };
    },
  });

  // —— 网络轴（ADR-0097：`--unshare-net` 恒在,egress 缝是唯一出网通路）——

  // SC1:默认隔离的硬底 —— example.com 永远拿不到响应(默认断网 + 无 egress)。
  push(
    "both",
    syncCheck(
      profile,
      "network denied",
      "curl -sS --max-time 5 https://example.com",
      true
    )
  );
  // SC1 (`--unshare-net` 恒在, ADR-0097):默认 netns 与宿主 loopback 隔断。
  // probe PASSES when curl FAILS:沙箱内 netns 不能直达宿主 loopback。
  // 不再需要 listener —— 既然 fence 恒断网,curl 必然连不上任何宿主端口。
  push("both", {
    name: "network default isolated from host loopback",
    run: async () => {
      // 用 netns 隔离后不可达的事实作硬证 —— curl 任意 host:port 都该断。
      const raw = await spawnFenceAsync(
        profile,
        `curl -sS --max-time 5 http://127.0.0.1:${listenerPort}`
      );
      const [status, ...rest] = raw.split("|");
      const ok = status.trim() !== "0";
      return { ok, detail: rest.join("|").trim() };
    },
  });
  // SC2 + SC13 (ADR-0097 §T4 egress 缝):socat 在场 → 起 egress session,
  // 沙箱内 curl 经代理打宿主 NIC listener;允许集含 IP 字面量 → 命中并回包。
  // socat 缺失 → `createEgressSession` 抛 `SocatUnavailableError`(fail-closed)
  // —— 这条路径同样报绿,证明「边界语义正确」(非静默降级)。两类分支都钉住
  // SC1 + SC13 的不变式。
  push("both", {
    name: "egress seam reachable (socat present = full integration; absent = fail-closed)",
    run: async () => {
      // 动态 import 避免探针启动期就加载 egress 模块,且能拿到 typed 错误
      // 的实际类(socat 缺失分支必依赖此处的 import)。
      const { defaultProbeSocat } =
        await import("../src/harness/sandbox/egress/session.js");
      const socatCommand = "socat";
      if (!defaultProbeSocat(socatCommand)) {
        return runEgressSocatAbsentCheck();
      }
      return runEgressSocatPresentCheck(profile);
    },
  });

  // —— git 全局配置读（宿主 home 可见，§9.2 #7 语义在全局档仍成立；
  //    host 缺身份 = skip。写全局配置在全局档可写，但探针不碰操作员
  //    ~/.gitconfig —— 不把持久身份面当 scratch。）——
  //    仅 global 档：workspace 档 `$HOME` 是 fixture home，里面没有操作员
  //    的 ~/.gitconfig，「读全局配置」在该档没有被测对象（生产形态下
  //    `$HOME` = homeRoot 才成立，fixture 造这份身份面已属另一命题）。
  if (applies("global", profile)) {
    checks.push(
      fixtures.hasGitGlobalIdentity
        ? syncCheck(
            profile,
            "git global config readable",
            "git config --global user.name"
          )
        : skippedCheck(
            "git global config readable",
            "host has no git global identity"
          )
    );
  }

  // —— worktree 档专属：全局档下 gitdir 直接经宿主根可见（无 identity ro-bind）——
  if (profile.name === "worktree") {
    const wt = worktreeFixturePaths.wt;
    const main = worktreeFixturePaths.main;
    checks.push(
      syncCheck(
        profile,
        "git status in worktree (gitdir via host root bind)",
        `git -C "${wt}" status --porcelain`
      )
    );
    checks.push(
      syncCheck(
        profile,
        "git committer ident in worktree",
        `git -C "${wt}" var GIT_COMMITTER_IDENT`
      )
    );
    checks.push({
      name: "main repo write allowed (global mode)",
      run: async () => {
        const target = join(main, `${TOKEN}.main`);
        if (existsSync(target)) rmSync(target, { force: true });
        const r = spawnFenceSync(
          profile,
          `printf global-main > "${target}" && test -s "${target}"`
        );
        const persisted = existsSync(target);
        const content = persisted ? readFileSync(target, "utf8") : "";
        return {
          ok: r.status === 0 && content === "global-main",
          detail: `fence-exit=${r.status} host-persisted=${persisted} content="${content}"`,
        };
      },
    });
  }
  return checks;
}

// ---------------------------------------------------------------------------
// node-side violation checks（与 fence 档位无关，只跑一次）
// ---------------------------------------------------------------------------

const violationChecks: ReadonlyArray<readonly [string, () => ProbeResult]> = [
  [
    "violation mid-escalation",
    (): ProbeResult => {
      // Record 3 mid events → shouldKill on the 3rd.
      const c = createViolationCounter();
      const r1 = c.record({
        tier: "mid",
        tool: "bash",
        input: {},
        message: "[hard_wall] dangerous command",
      });
      const r2 = c.record({
        tier: "mid",
        tool: "bash",
        input: {},
        message: "[hard_wall] dangerous command",
      });
      const r3 = c.record({
        tier: "mid",
        tool: "bash",
        input: {},
        message: "[hard_wall] dangerous command",
      });
      const ok =
        r1.shouldKill === false &&
        r2.shouldKill === false &&
        r3.shouldKill === true &&
        r3.count === 3;
      // Reset and confirm 2 records don't kill (regression check).
      c.reset();
      const r4 = c.record({
        tier: "mid",
        tool: "bash",
        input: {},
        message: "[hard_wall] dangerous command",
      });
      const r5 = c.record({
        tier: "mid",
        tool: "bash",
        input: {},
        message: "[hard_wall] dangerous command",
      });
      const resetOk =
        r4.shouldKill === false &&
        r5.shouldKill === false &&
        c.snapshot() === 2;
      return {
        ok: ok && resetOk,
        detail: `3rd-kill=${r3.shouldKill} reset-2-records=${r5.shouldKill} count=${r5.count}`,
      };
    },
  ],
  [
    "violation high-immediate",
    (): ProbeResult => {
      const c = createViolationCounter();
      const r = c.record({
        tier: "high",
        tool: "bash",
        input: {},
        message: "[escape_attempt]",
      });
      const ok = r.shouldKill === true;
      return {
        ok,
        detail: `high-kill=${r.shouldKill}`,
      };
    },
  ],
];

// ---------------------------------------------------------------------------
// 三档装配 + 主流程
// ---------------------------------------------------------------------------

/** worktree 档 fixture 路径（setupWorktreeFixture 赋值，checks 构建时读取）。 */
let worktreeFixturePaths: { main: string; wt: string } = { main: "", wt: "" };

function makePad(): string {
  return mkdtempSync(join(TMP, "iknow-probe-pad-"));
}

function makeExtra(): string {
  return mkdtempSync(join(TMP, "iknow-probe-extra-"));
}

function buildGlobalProfile(): ProbeProfile {
  const cwd = mkdtempSync(join(TMP, "iknow-probe-global-"));
  const pad = makePad();
  const extra = makeExtra();
  return {
    name: "global",
    fsMode: "global",
    cwd,
    pad,
    extra,
    // global 档 `$HOME` 保持宿主真值（home 不藏、可写的被测语义本体）。
    home: HOME,
    fsPolicy: createFsPolicy({ tmpDir: pad, mode: "global" }),
    cleanup: () => {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(pad, { recursive: true, force: true });
      rmSync(extra, { recursive: true, force: true });
    },
  };
}

function buildWorktreeProfile(): ProbeProfile {
  const { base, main, wt } = setupWorktreeFixture();
  worktreeFixturePaths = { main, wt };
  const pad = makePad();
  const extra = makeExtra();
  return {
    name: "worktree",
    fsMode: "global",
    cwd: wt,
    pad,
    extra,
    home: HOME,
    fsPolicy: createFsPolicy({ tmpDir: pad, mode: "global" }),
    cleanup: () => {
      rmSync(base, { recursive: true, force: true });
      rmSync(pad, { recursive: true, force: true });
      rmSync(extra, { recursive: true, force: true });
    },
  };
}

/**
 * 工作区档 profile（ADR-0092 Amendment / SC11/SC12）。
 *
 * fixture 形态（全部 mkdtemp，"绝不写真实 home"）：
 *   - home   = 独立 tmp 目录，内含 `$TOKEN.seed`（读可见的靶）—— 这就是
 *              home ro-bind 的源端，围栏内 `$HOME` 也指它（见 fenceEnv）;
 *   - cwd    = home **之外**的另一个 tmp 目录（taskRoot 语义）—— 必须是
 *              home 兄弟而不是子目录:home ro-bind 在 mount 序上晚于
 *              `--bind / /`,若 cwd 落在 home 内,last-mount-wins 会让
 *              home ro-bind 盖过 taskRoot bind,cwd 反而不可写;
 *   - pad    = home 子树内的会话 tmp（生产形态:会话文件夹在 home 项目树;
 *              本档需要 `--bind <tmpRoot>` 把它从 home 的只读面里重新撬开,
 *              这正是 SC12 的被测点）;
 *   - extra  = 宿主 sibling 写靶（global 档检查专属;本档保留字段但不用）。
 */
function buildWorkspaceProfile(): ProbeProfile {
  const home = mkdtempSync(join(TMP, "iknow-probe-home-"));
  const cwd = mkdtempSync(join(TMP, "iknow-probe-ws-task-"));
  const pad = join(home, "session-tmp");
  mkdirSync(pad, { recursive: true });
  writeFileSync(join(home, `${TOKEN}.seed`), "home-seed", "utf8");
  const extra = makeExtra();
  return {
    name: "workspace",
    fsMode: "workspace",
    cwd,
    pad,
    extra,
    home,
    fsPolicy: createFsPolicy({ tmpDir: pad, mode: "workspace" }),
    cleanup: () => {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(extra, { recursive: true, force: true });
      // home 连同其内的 pad 一起删。
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** profile 装配表：顺序 = 报告顺序（global → worktree → workspace）。 */
const PROFILE_BUILDERS: ReadonlyArray<readonly [string, () => ProbeProfile]> = [
  ["global", buildGlobalProfile],
  ["worktree", buildWorktreeProfile],
  ["workspace", buildWorkspaceProfile],
];

/**
 * 装配全部档位 profile；任一档装载失败 → 清掉已装配档的 fixture、打一行
 * blocker，返回 `null` 交调用方非 0 收尾。缺 bwrap / 缺内核特性时仍能出
 * 报告，不把「未装配」当「零检查」静默放行。
 */
function loadProfiles(): ProbeProfile[] | null {
  const profiles: ProbeProfile[] = [];
  for (const [label, build] of PROFILE_BUILDERS) {
    try {
      profiles.push(build());
    } catch (err) {
      console.error(`BLOCKER: ${label} fixture setup failed: ${String(err)}`);
      for (const profile of profiles) profile.cleanup();
      return null;
    }
  }
  return profiles;
}

async function startProbeListener(
  host = "127.0.0.1"
): Promise<{
  port: number;
  stop: () => void;
}> {
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("probe-listener-ok");
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolvePromise());
  });
  const { port } = server.address() as AddressInfo;
  return {
    port,
    stop: () => {
      // Close the listener AND destroy any keep-alive sockets curl left open,
      // otherwise the port/event-loop handle survives past this process.
      server.closeAllConnections();
      server.close();
    },
  };
}

interface ProfileStats {
  readonly name: string;
  readonly passed: number;
  readonly total: number;
}

async function runProfile(
  profile: ProbeProfile,
  fixtures: HostFixtures,
  listenerPort: number
): Promise<ProfileStats> {
  const checks = buildChecks(profile, fixtures, listenerPort);
  console.log(`\n== profile: ${profile.name} (cwd=${profile.cwd}) ==`);
  let passed = 0;
  for (const check of checks) {
    let ok = false;
    let detail = "";
    try {
      const result = await check.run();
      ok = result.ok;
      detail = result.detail;
    } catch (err) {
      detail = `probe errored: ${String(err)}`;
    }
    if (ok) passed++;
    // detail 截断:expected-fail 的 stderr(如 ERR_MODULE_NOT_FOUND 全文)会
    // 刷屏,保留首行有限长度足够归因。
    const shown = detail.split("\n")[0] ?? "";
    console.log(
      `${ok ? "✓" : "✗"} ${check.name}${shown ? ` (${shown.slice(0, 160)})` : ""}`
    );
  }
  console.log(
    `-- ${profile.name}: ${passed === checks.length ? "all green" : "failures"} (${passed}/${checks.length})`
  );
  return { name: profile.name, passed, total: checks.length };
}

async function main(): Promise<void> {
  // blocker 预检：bwrap 不可用 = 无围栏证据，如实非 0，不伪造。
  try {
    requireBwrap();
  } catch (err) {
    console.error(
      `BLOCKER: ${String(err instanceof Error ? err.message : err)}`
    );
    process.exitCode = 1;
    return;
  }
  const fixtures = setupHostFixtures();
  const profiles = loadProfiles();
  if (profiles === null) {
    process.exitCode = 1;
    return;
  }
  const listener = await startProbeListener();
  const stats: ProfileStats[] = [];
  try {
    console.log(
      "sandbox-probe (ADR-0092 suite: global / worktree / workspace profiles)"
    );
    for (const profile of profiles) {
      stats.push(await runProfile(profile, fixtures, listener.port));
    }
    // node-side violation checks：无 fence、与档位无关，共享节只跑一次。
    console.log("\n== node-side (profile-independent) ==");
    let nodePassed = 0;
    for (const [name, check] of violationChecks) {
      const result = check();
      if (result.ok) nodePassed++;
      console.log(
        `${result.ok ? "✓" : "✗"} ${name}${result.detail ? ` (${result.detail})` : ""}`
      );
    }
    stats.push({
      name: "node-side",
      passed: nodePassed,
      total: violationChecks.length,
    });
    const allGreen = stats.every((s) => s.passed === s.total);
    console.log(
      `\n${allGreen ? "all green" : "failures"} — ${stats
        .map((s) => `${s.name} ${s.passed}/${s.total}`)
        .join(", ")}`
    );
    process.exitCode = allGreen ? 0 : 1;
  } finally {
    listener.stop();
    for (const profile of profiles) profile.cleanup();
    // global 档的 `home write lands on host` 把 marker 写进真实 home —— 探针
    // 自身清掉它，不留残骸。workspace 档写不进去（EROFS），无需清理。
    rmSync(join(HOME, `${TOKEN}.home`), { force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
