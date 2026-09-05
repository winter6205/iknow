/**
 * T6（plans/closed-world-bash-fence.md）— sandbox probe suite，两档模式。
 *
 * 消费生产 `createFsPolicy` / `createBwrapFence`（T3 闭世界双轴），对 ADR-0037
 * §9.2 白名单做物理验收。两段模式先后各跑一遍、各自汇总：
 *
 *   OFF 档     — cwd = 真实可写目录（主仓 taskRoot 语义），policy 不传
 *                projectIdentityRoot（与 build-engine OFF 分支一致），
 *                installRoot = resolveInstallRoot()。
 *   改绑档     — host 侧造「主仓 + 其内 worktree」git fixture；
 *                policy cwd = worktree（taskRoot），projectIdentityRoot = 主仓
 *                （identity 根恒进读白名单，§9.2 #6 闭世界语义）。
 *
 * 每档 = 11 旧类 + T6 新类（旧类中 violation counter 两类是 node-side、与
 * fence 档位无关，只在共享节跑一次）。exit code：全绿（skip 视为绿并注明）
 * = 0，否则 1。
 *
 * 语义注记（实测裁决，T6）：
 *  - bwrap 为 bind 目标在容器根 tmpfs 上创建父目录，故围栏内 `$HOME` 本身
 *    存在且可写——但写入落在随 fence 消亡的容器 tmpfs 上，永不落地 host。
 *    「home 拒写」因此拆成三条更强断言：白名单子树 EROFS、非白名单不可见、
 *    写入非持久（host 侧验证 + 第二次 fence 不可见）。
 *  - `~/.iknow` 同理：不可见（test ! -e）+ 写尝试（mkdir + init.sh）不落地
 *    host（#896 闭合探针，host 侧验证）。
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { AddressInfo } from "node:net";
import {
  BASE_ENV_WHITELIST,
  createBwrapFence,
  createEnvIsolation,
  createFsPolicy,
  createNetworkPolicy,
  createResourceLimits,
  defaultOptionalReadRoots,
  type FsPolicy,
} from "../src/harness/sandbox/index.js";
import { requireBwrap } from "../src/harness/sandbox/runner.js";
import { createViolationCounter } from "../src/harness/sandbox/violation-handling.js";
import { resolveInstallRoot } from "../src/harness/session-roots.js";

type ProbeResult = { ok: boolean; detail: string };
interface ProbeCheck {
  readonly name: string;
  readonly run: () => Promise<ProbeResult>;
}

const HOME = homedir();
const TMP = tmpdir();
const INSTALL_ROOT = resolveInstallRoot();
const ENV = createEnvIsolation({ allowEnv: BASE_ENV_WHITELIST }).filter(
  process.env
);
const NETWORK_POLICY = createNetworkPolicy();
const RESOURCE_LIMITS = createResourceLimits();

/** 与 fs-policy 内部同语义（私有函数，此处镜像）。 */
function isWithin(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep))
  );
}

// ---------------------------------------------------------------------------
// fence 执行体（每档一份 policy，同一 runner）
// ---------------------------------------------------------------------------

interface ProbeProfile {
  /** 档位名（输出汇总用）。 */
  readonly name: string;
  /** taskRoot——fence cwd 与唯一可写工作区根。 */
  readonly cwd: string;
  readonly fsPolicy: FsPolicy;
  /** host 侧 fixture 清理。 */
  readonly cleanup: () => void;
}

function spawnFenceSync(
  profile: ProbeProfile,
  command: string,
  network = false
): ReturnType<typeof spawnSync> {
  const fence = createBwrapFence({
    command: "bash",
    args: ["-c", command],
    fsPolicy: profile.fsPolicy,
    networkPolicy: NETWORK_POLICY,
    resourceLimits: RESOURCE_LIMITS,
    env: ENV,
    cwd: profile.cwd,
    network,
  });
  return spawnSync(fence.argv[0], fence.argv.slice(1), {
    cwd: profile.cwd,
    encoding: "utf8",
    env: ENV,
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
  const fence = createBwrapFence({
    command: "bash",
    args: ["-c", command],
    fsPolicy: profile.fsPolicy,
    networkPolicy: NETWORK_POLICY,
    resourceLimits: RESOURCE_LIMITS,
    env: ENV,
    cwd: profile.cwd,
    network,
  });
  return new Promise((resolvePromise) => {
    const child = spawn(fence.argv[0], fence.argv.slice(1), {
      cwd: profile.cwd,
      env: ENV,
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
  /** 其它 project fixture（$HOME 下，围栏内不可见不可写）。 */
  readonly otherProjectDir: string;
  /** home 下非白名单且非 bind 目标祖先的真实条目（不可见探针靶子）。 */
  readonly hiddenHomeEntry?: string;
  /** node 工具链根（home 之下才可做 EROFS 探针）。 */
  readonly nodeRootUnderHome?: string;
  /** installRoot 内可执行靶（存在才跑真实 exec；否则 test -x + 说明）。 */
  readonly installBin?: string;
  /** host 有 git 全局身份才跑读探针。 */
  readonly hasGitGlobalIdentity: boolean;
}

function pickHiddenHomeEntry(
  bindTargets: readonly string[]
): string | undefined {
  const candidates = [
    ".cache",
    ".local",
    "Documents",
    "Downloads",
    ".vscode",
    ".cargo",
    "go",
    ".bashrc",
    ".profile",
  ];
  for (const entry of candidates) {
    const abs = join(HOME, entry);
    if (!existsSync(abs)) continue;
    // bind 目标本身或其祖先（会被 bwrap 建为挂载点父目录）不能当「不可见」靶。
    const isBindSurface = bindTargets.some(
      (t) => isWithin(t, abs) || isWithin(abs, t)
    );
    if (!isBindSurface) return abs;
  }
  return undefined;
}

function pickInstallBin(): string | undefined {
  const binDir = join(INSTALL_ROOT, "node_modules", ".bin");
  for (const name of ["tsc", "vitest", "eslint"]) {
    const abs = join(binDir, name);
    if (existsSync(abs)) return abs;
  }
  return undefined;
}

/**
 * dev worktree 形态的退路：node_modules 为空（依赖解析落在 installRoot 之外、
 * 围栏外），node_modules/.bin 无真实 binary。此时用 package.json bin 产物
 * `scripts/iknow-trace-mcp.cjs` 做真实 exec——它只 require node 内建模块、
 * 再 spawn installRoot 内的 `dist/trace-mcp/main.js`（全部在 installRoot
 * 读白名单内），`--help` 打印 usage 后 exit 0，无副作用。
 */
function pickStandaloneInstallExec(): string | undefined {
  const abs = join(INSTALL_ROOT, "scripts", "iknow-trace-mcp.cjs");
  return existsSync(abs) ? abs : undefined;
}

function setupHostFixtures(): HostFixtures {
  const otherProjectDir = mkdtempSync(join(HOME, "iknow-probe-other-project-"));
  const nodeRoot = dirname(process.execPath);
  const bindTargets = [
    ...(isWithin(HOME, nodeRoot) ? [nodeRoot] : []),
    join(HOME, ".gitconfig"),
    join(HOME, ".config", "git", "config"),
  ].filter((t) => existsSync(t));
  const gitIdentity = spawnSync("git", ["config", "--global", "user.name"], {
    encoding: "utf8",
  });
  return {
    otherProjectDir,
    hiddenHomeEntry: pickHiddenHomeEntry(bindTargets),
    nodeRootUnderHome: isWithin(HOME, nodeRoot) ? nodeRoot : undefined,
    installBin: pickInstallBin(),
    hasGitGlobalIdentity:
      gitIdentity.status === 0 && (gitIdentity.stdout ?? "").trim().length > 0,
  };
}

/** 改绑档 git fixture：「主仓 + 其内 worktree」。任一步失败 = fail-loud。 */
function setupRebindFixture(): { main: string; wt: string } {
  const base = mkdtempSync(join(TMP, "iknow-probe-rebind-"));
  const main = join(base, "main-repo");
  const wt = join(main, ".iknow", "worktrees", "t6-probe");
  const git = (args: readonly string[]): void => {
    const r = spawnSync("git", args, { encoding: "utf8" });
    if (r.status !== 0) {
      rmSync(base, { recursive: true, force: true });
      throw new Error(
        `rebind fixture: git ${args.join(" ")} failed: ${(r.stderr ?? "").trim()}`
      );
    }
  };
  try {
    git(["init", "-q", "-b", "main", main]);
    git(["-C", main, "config", "user.email", "t6-probe@iknow"]);
    git(["-C", main, "config", "user.name", "t6-probe"]);
    writeFileSync(join(main, "marker.txt"), "t6-identity-marker\n");
    git(["-C", main, "add", "."]);
    git(["-C", main, "commit", "-qm", "t6 probe fixture"]);
    git(["-C", main, "worktree", "add", "-q", "-b", "t6-probe", wt]);
    return { main, wt };
  } catch (err) {
    rmSync(base, { recursive: true, force: true });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 每档探针清单：11 旧类（9 个 fence 类）+ T6 新类
// ---------------------------------------------------------------------------

function buildChecks(
  profile: ProbeProfile,
  fixtures: HostFixtures,
  listenerPort: number
): ProbeCheck[] {
  const other = fixtures.otherProjectDir;
  const checks: ProbeCheck[] = [];

  // —— 11 旧类中的 9 个 fence 类（原 sandbox-probe 全量保留，语义不变）——
  checks.push(
    syncCheck(profile, "env isolation", 'test -z "$ANTHROPIC_AUTH_TOKEN"')
  );
  checks.push(
    syncCheck(profile, "fs sensitivity (ssh hidden)", "test ! -e ~/.ssh/id_rsa")
  );
  checks.push(
    syncCheck(profile, "/etc readonly", "touch /etc/sandbox-probe-write", true)
  );
  checks.push(
    syncCheck(
      profile,
      "cwd writable (taskRoot)",
      "touch probe-write && rm probe-write && echo ok"
    )
  );
  checks.push(
    syncCheck(profile, "host prefix /opt", "test ! -d /opt -o -r /opt")
  );
  checks.push(
    syncCheck(
      profile,
      "network denied",
      "curl -sS --max-time 5 https://example.com",
      true
    )
  );
  checks.push(syncCheck(profile, "node runs", "node -v"));
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

  // —— T6 新类：写白名单第三轴 /tmp ——
  checks.push(
    syncCheck(
      profile,
      "tmp writable (/tmp write axis)",
      "touch /tmp/t6-probe-write && rm /tmp/t6-probe-write && echo ok"
    )
  );

  // —— T6 新类：home 拒写（三态，见文件头语义注记）——
  checks.push(
    fixtures.nodeRootUnderHome !== undefined
      ? syncCheck(
          profile,
          "home whitelisted subtree write denied (EROFS)",
          `touch "${fixtures.nodeRootUnderHome}/t6-ro-probe"`,
          true
        )
      : skippedCheck(
          "home whitelisted subtree write denied (EROFS)",
          "node toolchain root not under home (system prefixes covered by /etc readonly)"
        )
  );
  checks.push(
    fixtures.hiddenHomeEntry !== undefined
      ? syncCheck(
          profile,
          "home non-whitelist invisible",
          `test ! -e "${fixtures.hiddenHomeEntry}"`
        )
      : skippedCheck(
          "home non-whitelist invisible",
          "no non-whitelisted home entry found on host"
        )
  );
  checks.push({
    name: "home writes ephemeral — never persist to host home",
    run: async () => {
      const hostMarker = join(HOME, "t6-ephemeral-probe");
      if (existsSync(hostMarker)) rmSync(hostMarker);
      const touch = spawnFenceSync(
        profile,
        'touch "$HOME/t6-ephemeral-probe" && test -e "$HOME/t6-ephemeral-probe"'
      );
      const persisted = existsSync(hostMarker);
      const secondFence = spawnFenceSync(
        profile,
        'test ! -e "$HOME/t6-ephemeral-probe"'
      );
      if (existsSync(hostMarker)) rmSync(hostMarker);
      const ok = touch.status === 0 && !persisted && secondFence.status === 0;
      return {
        ok,
        detail: `fence-touch=${touch.status} host-persisted=${persisted} second-fence-invisible=${secondFence.status === 0}`,
      };
    },
  });

  // —— T6 新类：其它 project 不可写（host 侧 $HOME fixture）——
  checks.push(
    syncCheck(
      profile,
      "other project not writable",
      `touch "${other}/t6-denied"`,
      true
    )
  );

  // —— T6 新类：~/.iknow 不可见 + init.sh 写尝试不落地（#896 闭合探针）——
  checks.push(iknowClosureCheck(profile));

  // —— T6 新类：installRoot 可读可执行（§9.2 #4）——
  checks.push(
    syncCheck(
      profile,
      "installRoot readable (package.json)",
      `test -r "${INSTALL_ROOT}/package.json"`
    )
  );
  checks.push(...installExecutableChecks(profile, fixtures));

  // —— T6 新类：git 全局配置读（§9.2 #7 可选成员；host 缺身份 = skip）——
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
  checks.push(
    syncCheck(
      profile,
      "git global config write denied (read-only member)",
      "git config --global t6.probe.key value",
      true
    )
  );

  // —— 改绑档专属：identity 根读通道（§9.2 #6，OFF 档不传该根）——
  if (profile.name === "rebind") {
    const rebind = rebindFixturePaths;
    checks.push(
      syncCheck(
        profile,
        "identity root (main repo) readable",
        `grep -q t6-identity-marker "${rebind.main}/marker.txt"`
      )
    );
    checks.push(
      syncCheck(
        profile,
        "main repo non-taskRoot write denied (EROFS)",
        `touch "${rebind.main}/t6-denied"`,
        true
      )
    );
    // §7.2 改绑流程探针化：gitdir 经 identity ro-bind 可达。
    checks.push(
      syncCheck(
        profile,
        "git status in worktree (gitdir via identity ro-bind)",
        `git -C "${rebind.wt}" status --porcelain`
      )
    );
    checks.push(
      syncCheck(
        profile,
        "git committer ident in worktree",
        `git -C "${rebind.wt}" var GIT_COMMITTER_IDENT`
      )
    );
  }
  return checks;
}

/** #896 闭合探针：不可见 + 写尝试不落地 host（host 侧验证）。 */
function iknowClosureCheck(profile: ProbeProfile): ProbeCheck {
  const hostInit = join(HOME, ".iknow", "init.sh");
  const hostHadInit = existsSync(hostInit);
  return {
    name: "~/.iknow invisible + init.sh never persists (#896 closure)",
    run: async () => {
      const invisible = spawnFenceSync(profile, 'test ! -e "$HOME/.iknow"');
      if (hostHadInit) {
        return {
          ok: invisible.status === 0,
          detail:
            "skipped persistence sub-assert: host already has init.sh; invisibility asserted",
        };
      }
      const wrote = spawnFenceSync(
        profile,
        'mkdir -p "$HOME/.iknow" && printf "#!/bin/sh\\necho iknow-init\\n" > "$HOME/.iknow/init.sh" && test -e "$HOME/.iknow/init.sh"'
      );
      const persisted = existsSync(hostInit);
      const secondFence = spawnFenceSync(
        profile,
        'test ! -e "$HOME/.iknow/init.sh"'
      );
      const ok =
        invisible.status === 0 &&
        wrote.status === 0 &&
        !persisted &&
        secondFence.status === 0;
      return {
        ok,
        detail: `fence-invisible=${invisible.status === 0} init.sh-host-persisted=${persisted} second-fence-invisible=${secondFence.status === 0}`,
      };
    },
  };
}

/** installRoot 可执行（§9.2 #4）：.bin binary 真实 exec 优先；dev worktree
 *  形态退化为 exec 链表面断言 + 闭世界负向（dep 解析不得泄漏到白名单外）。 */
function installExecutableChecks(
  profile: ProbeProfile,
  fixtures: HostFixtures
): ProbeCheck[] {
  if (fixtures.installBin !== undefined) {
    return [
      syncCheck(
        profile,
        "installRoot toolchain executable",
        `"${fixtures.installBin}" --version`
      ),
    ];
  }
  const standalone = pickStandaloneInstallExec();
  if (standalone === undefined) {
    return [
      skippedCheck(
        "installRoot toolchain executable",
        "no .bin binary and no bin artifact in installRoot"
      ),
    ];
  }
  // dev worktree：node_modules 为空，wrapper → dist/trace-mcp/main.js 的依赖
  // 解析落在 installRoot 之外（围栏外父仓）。真实 exec 因此不可达——且**必须**
  // 不可达（白名单只有 installRoot，父仓依赖不得泄漏）。正向断言 exec 位与
  // spawn 目标可达；负向断言 dep-import exec 被拒（闭世界边界，非回归）。
  const spawnTarget = join(INSTALL_ROOT, "dist", "trace-mcp", "main.js");
  return [
    syncCheck(
      profile,
      "installRoot toolchain exec surface (exec-bit + spawn target)",
      `test -x "${standalone}" && test -r "${spawnTarget}"`
    ),
    syncCheck(
      profile,
      "installRoot dep-import exec denied (parent node_modules not leaked)",
      `node "${standalone}" --help`,
      true
    ),
  ];
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

/** 改绑档 fixture 路径（setupRebindFixture 赋值，checks 构建时读取）。 */
let rebindFixturePaths: { main: string; wt: string } = { main: "", wt: "" };

function buildOffProfile(): ProbeProfile {
  // OFF 档（build-engine OFF 分支对齐）：cwd = 真实可写目录（主仓 taskRoot
  // 语义），不传 projectIdentityRoot；installRoot = resolveInstallRoot()。
  const cwd = mkdtempSync(join(TMP, "iknow-probe-off-"));
  return {
    name: "OFF",
    cwd,
    fsPolicy: createFsPolicy({
      cwd,
      home: HOME,
      tmpDir: TMP,
      workspaceRoot: cwd,
      installRoot: INSTALL_ROOT,
      optionalReadRoots: defaultOptionalReadRoots({ home: HOME }),
    }),
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

function buildRebindProfile(): ProbeProfile {
  // 改绑档（§7.2 探针化）：cwd = 主仓内 worktree（taskRoot），主仓 =
  // projectIdentityRoot（恒进读白名单，§9.2 #6）。
  const { main, wt } = setupRebindFixture();
  rebindFixturePaths = { main, wt };
  return {
    name: "rebind",
    cwd: wt,
    fsPolicy: createFsPolicy({
      cwd: wt,
      home: HOME,
      tmpDir: TMP,
      workspaceRoot: wt,
      installRoot: INSTALL_ROOT,
      projectIdentityRoot: main,
      optionalReadRoots: defaultOptionalReadRoots({ home: HOME }),
    }),
    cleanup: () =>
      rmSync(resolve(main, ".."), { recursive: true, force: true }),
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
  const profiles: ProbeProfile[] = [buildOffProfile()];
  let rebind: ProbeProfile | undefined;
  try {
    rebind = buildRebindProfile();
    profiles.push(rebind);
  } catch (err) {
    console.error(`BLOCKER: rebind fixture setup failed: ${String(err)}`);
    profiles[0].cleanup();
    process.exitCode = 1;
    return;
  }
  const listener = await startProbeListener();
  const stats: ProfileStats[] = [];
  try {
    console.log("sandbox-probe (T6 two-profile closed-world suite)");
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
    rmSync(fixtures.otherProjectDir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
