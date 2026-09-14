/**
 * sandbox probe suite — 全局档 + 工作区档（ADR-0092），三档形态，各自跑
 * 与该档相关的清单。
 *
 * 消费生产 `createFsPolicy` / `createBwrapFence`，对 specs/fs-isolation-modes.md
 * 做物理验收：
 *   - global / worktree 档跑 Round 1 默认姿态（SC1–SC3）：宿主真路径可见可写、
 *     系统前缀只读覆盖、会话 tmp 保留宿主真路径（**没有**垫底 bind 到 guest
 *     `/tmp`）、网络 / env 轴不借本改动放开。
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
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  BASE_ENV_WHITELIST,
  createBwrapFence,
  createEnvIsolation,
  createFsPolicy,
  createNetworkPolicy,
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
const NETWORK_POLICY = createNetworkPolicy();
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
  command: string,
  network = false
): ReturnType<typeof spawnSync> {
  const env = fenceEnv(profile);
  const fence = createBwrapFence({
    command: "bash",
    args: ["-c", command],
    fsPolicy: profile.fsPolicy,
    networkPolicy: NETWORK_POLICY,
    env,
    cwd: profile.cwd,
    network,
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

// Async spawn (NOT spawnSync) for the two netns-sensitive checks. The loopback
// listener below lives in THIS process; while spawnSync blocks the event loop
// no callback can run, so curl inside the fence could never reach it.
function spawnFenceAsync(
  profile: ProbeProfile,
  command: string,
  network = false
): Promise<string> {
  const env = fenceEnv(profile);
  const fence = createBwrapFence({
    command: "bash",
    args: ["-c", command],
    fsPolicy: profile.fsPolicy,
    networkPolicy: NETWORK_POLICY,
    env,
    cwd: profile.cwd,
    network,
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

  // —— 网络轴（默认隔离；opt-in 需宿主回环实测）——
  push(
    "both",
    syncCheck(
      profile,
      "network denied",
      "curl -sS --max-time 5 https://example.com",
      true
    )
  );
  // T9b (#503): physical validation of `network: true` moves to a host loopback
  // listener. WSL2 drops outbound IPv4 for mount+user-ns combos and the fence's
  // /etc/resolv.conf symlink is dangling (no /mnt bind), so example.com can
  // never be reached even though the opt-in netns shape is correct. Loopback
  // inbound is not subject to the WSL2 egress penalty: the opt-in branch shares
  // the host netns and MUST reach the listener, while the default branch runs in
  // its own netns whose lo is not up and MUST NOT — a stronger netns-shape
  // signal than an external target.
  push("both", {
    name: "network opt-in reachable",
    run: async () => {
      const raw = await spawnFenceAsync(
        profile,
        `curl -sS --max-time 5 http://127.0.0.1:${listenerPort} | grep -q probe-listener-ok`,
        true
      );
      const [status, ...rest] = raw.split("|");
      return {
        ok: status.trim() === "0",
        detail: rest.join("|").trim(),
      };
    },
  });
  push("both", {
    name: "network default isolated from host loopback",
    run: async () => {
      // This probe PASSES when curl FAILS: the default branch's own netns
      // must not reach the host loopback listener.
      const raw = await spawnFenceAsync(
        profile,
        `curl -sS --max-time 5 http://127.0.0.1:${listenerPort}`,
        false
      );
      const [status, ...rest] = raw.split("|");
      const ok = status.trim() !== "0";
      return { ok, detail: rest.join("|").trim() };
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

async function startProbeListener(): Promise<{
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
    server.listen(0, "127.0.0.1", () => resolvePromise());
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
