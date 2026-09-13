/**
 * sandbox probe suite — 默认全局档（ADR-0092），两档形态，各自跑同一清单。
 *
 * 消费生产 `createFsPolicy` / `createBwrapFence`，对 specs/fs-isolation-modes.md
 * 的 Round 1 默认姿态做物理验收：宿主真路径可见可写、系统前缀只读覆盖、
 * 会话 tmp 保留宿主真路径（**没有**垫底 bind 到 guest `/tmp`）、网络 / env
 * 轴不借本改动放开。两档先后各跑一遍、各自汇总：
 *
 *   global    — cwd = 真实可写临时目录（主仓 taskRoot 语义）。
 *   worktree  — cwd = 「主仓 + 其内 worktree」git fixture 里的 worktree；
 *               全局档下 gitdir 直接经宿主根可见，不再需要 identity ro-bind。
 *
 * 每档 = 全量物理类（旧 11 类中的 fence 类保留语义；闭世界专有类退役，
 * 换成全局档类）。两个 violation counter 是 node-side、与 fence 档位无关，
 * 只在共享节跑一次。exit code：全绿（skip 视为绿并注明）= 0，否则 1。
 *
 * 语义注记：
 *  - 全局档 argv = `--bind / /` 打底（宿主真路径可见可写）→ 系统前缀
 *    `/usr /bin /lib /lib64 /etc`（+ 存在性可选 `/opt /snap`）只读覆盖 →
 *    `--proc` / `--dev-bind`。没有 `--bind <pad> /tmp`、没有 `--tmpfs`、
 *    没有 per-root 可写白名单。
 *  - 会话 tmp（identity pad）不是 argv mount 目标；它只作为 `$TMPDIR` 的
 *    值注入。围栏内写 `$TMPDIR/...` 落宿主 pad；写 guest `/tmp/...` 落
 *    宿主 `/tmp`（与 pad 是两处，绝不静默双写）。
 *  - `--size`/`--tmpfs` 退役后 tmp 配额不再是围栏形态的一部分，
 *    ResourceLimits 仅作未来 hook 的常量面，探针不再做超限物理验收。
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
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
  /** taskRoot——fence cwd。 */
  readonly cwd: string;
  /** 本身份的会话 tmp 宿主路径（`$TMPDIR` 的值；不是 argv mount 目标）。 */
  readonly pad: string;
  /** host 侧 sibling 可写靶（证明宿主真路径 / 非 cwd 也可写）。 */
  readonly extra: string;
  readonly fsPolicy: FsPolicy;
  /** host 侧 fixture 清理。 */
  readonly cleanup: () => void;
}

/** 每档 fence env：BASE_ENV_WHITELIST + 该档 `$TMPDIR`（镜像 bash.ts）。 */
function fenceEnv(profile: ProbeProfile): NodeJS.ProcessEnv {
  return { ...ENV_BASE, TMPDIR: profile.pad };
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

  // —— env 隔离（轴未借本改动放开）——
  checks.push(
    syncCheck(profile, "env isolation", 'test -z "$ANTHROPIC_AUTH_TOKEN"')
  );

  // —— SC1：home 可见（宿主真路径，非不可见）——
  checks.push(
    syncCheck(
      profile,
      "home visible",
      'test -d "$HOME" && ls "$HOME" >/dev/null'
    )
  );
  checks.push({
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

  // —— 系统前缀只读覆盖 + 工具链可见 ——
  checks.push(
    syncCheck(profile, "/etc readonly", "touch /etc/iknow-probe-write", true)
  );
  checks.push(
    syncCheck(
      profile,
      "system prefix readable (/usr)",
      "test -r /usr/bin/env && test -x /usr/bin/env"
    )
  );
  checks.push(syncCheck(profile, "node runs", "node -v"));
  checks.push(
    syncCheck(profile, "host prefix /opt", "test ! -d /opt -o -r /opt")
  );

  // —— 全局档：宿主真路径可写（cwd 与非 cwd 两处）——
  checks.push(
    syncCheck(
      profile,
      "cwd writable (taskRoot)",
      "touch probe-write && rm probe-write && echo ok"
    )
  );
  checks.push({
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
  checks.push(
    syncCheck(
      profile,
      "guest /tmp writable (host /tmp via / bind)",
      `touch "/tmp/${TOKEN}.tmp" && rm "/tmp/${TOKEN}.tmp" && echo ok`
    )
  );

  // —— SC3：无 guest /tmp 别名；$TMPDIR = 会话 tmp 宿主路径 ——
  checks.push({
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
  checks.push(
    syncCheck(
      profile,
      "$TMPDIR equals the session tmp host path",
      `test "$TMPDIR" = "${profile.pad}" && printf %s "$TMPDIR"`,
      false
    )
  );

  // —— SC2：写会话 tmp 宿主路径落 pad，且不出现在宿主 /tmp ——
  checks.push({
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
  checks.push(
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
  checks.push({
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
  checks.push({
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
// 两档装配 + 主流程
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
    cwd,
    pad,
    extra,
    fsPolicy: createFsPolicy({ tmpDir: pad }),
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
    cwd: wt,
    pad,
    extra,
    fsPolicy: createFsPolicy({ tmpDir: pad }),
    cleanup: () => {
      rmSync(base, { recursive: true, force: true });
      rmSync(pad, { recursive: true, force: true });
      rmSync(extra, { recursive: true, force: true });
    },
  };
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
  const profiles: ProbeProfile[] = [buildGlobalProfile()];
  try {
    profiles.push(buildWorktreeProfile());
  } catch (err) {
    console.error(`BLOCKER: worktree fixture setup failed: ${String(err)}`);
    profiles[0].cleanup();
    process.exitCode = 1;
    return;
  }
  const listener = await startProbeListener();
  const stats: ProfileStats[] = [];
  try {
    console.log("sandbox-probe (ADR-0092 global-mode suite, two profiles)");
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
    rmSync(join(HOME, `${TOKEN}.home`), { force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
