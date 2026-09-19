/**
 * egress-ssh-bridge T6 —— `SSH_AUTH_SOCK` 条件形态（默认**关**）的形状钉子。
 *
 * 钉住的不变式（specs/egress-ssh-bridge.md §T6 + ADR-0105 §Decision 5 +
 * plans/egress-ssh-bridge.md 子弹 6 Acceptance）：
 *   - 关态（默认，调用方不传 `sshAuthSockPath`）：`SSH_AUTH_SOCK` 在围栏
 *     env 与 argv 中都不存在——宿主 agent 值恒不进围栏（env 白名单外 +
 *     session 不注入）；
 *   - 开态 = 宿主 agent socket 路径经同段 `--bind`（egress bind 段内：
 *     workspaceMounts 之后、cwdReadonly/proc/dev 之前，last-mount-wins 序）+
 *     `SSH_AUTH_SOCK` 入 `spec.env`（`--clearenv` 后 `--setenv` 单通道）；
 *   - 与 egress 桥同 dispose 通道：`session.dispose()` 收桥 + 删自有
 *     egress socket；agent socket 路径**非 session 所有**，dispose 不得
 *     删宿主 agent socket；
 *   - fail-closed + F5 指引：开态但 agent socket 缺失（无 agent / 路径
 *     不存在）→ typed `SshAgentUnavailableError`（infra 归类），失败信息
 *     含「宿主侧 `ssh-add` 或无口令 key」一行；抛错发生在起桥之前
 *     （不留「有 bind 无桥」半开形态）；
 *   - F8 归类：agent socket 连不上属 infra 非域拒绝——凭据缝不经 filter，
 *     违例 sink 恒空（不开第二违例面）。
 *
 * 注入策略同 `egress-session.test.ts`：probeSocat / spawn /
 * socketPathFactory 全 mock，不依赖宿主真装 socat。
 */

import { spawn as realSpawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEgressSession,
  SshAgentUnavailableError,
  type EgressSession,
} from "../../../src/harness/sandbox/egress/session.js";
import { createBwrapFence } from "../../../src/harness/sandbox/bwrap.js";
import { createFsPolicy } from "../../../src/harness/sandbox/fs-policy.js";

const scratchPaths: string[] = [];

function scratchDir(): string {
  const d = mkdtempSync(join(tmpdir(), "iknow-ssh-authsock-"));
  scratchPaths.push(d);
  return d;
}

afterEach(() => {
  for (const p of scratchPaths.splice(0)) {
    rmSync(p, { recursive: true, force: true });
  }
});

/** 假 socat 进程（形态抄 egress-session.test.ts）。 */
function fakeSocatProc(pid: number) {
  const proc = realSpawn("/bin/true", ["--version"], { stdio: "ignore" });
  try {
    proc.kill("SIGKILL");
  } catch {
    /* */
  }
  return Object.assign(proc, { pid });
}

/** 建一个「存在」的 agent socket fixture（缝形状只需 existsSync 通过）。 */
function fakeAgentSocket(dir: string): string {
  const p = join(dir, "host-ssh-agent.sock");
  writeFileSync(p, "", "utf8");
  return p;
}

async function makeSession(opts: {
  readonly sshAuthSockPath?: string;
}): Promise<{
  readonly session: EgressSession;
  readonly socatArgs: readonly string[];
}> {
  let capturedArgs: readonly string[] = [];
  const proc = fakeSocatProc(4242);
  const session = await createEgressSession({
    policy: {
      allowedDomains: ["github.com"],
      deniedDomains: [],
      commandLabel: "t6-test",
    },
    socatCommand: "fake-socat",
    probeSocat: () => true,
    spawn: ((_cmd: string, args: readonly string[]) => {
      capturedArgs = args;
      return proc;
    }) as typeof realSpawn,
    socketPathFactory: (id) => join(scratchDir(), `egress-${id}.sock`),
    ...(opts.sshAuthSockPath !== undefined
      ? { sshAuthSockPath: opts.sshAuthSockPath }
      : {}),
  });
  return { session, socatArgs: capturedArgs };
}

/**
 * 用 session 的真 spec 装一个**工作区档 + cwdReadonly** 的完整围栏 argv：
 * workspaceMounts / egress bind / cwdReadonly 三层齐备，才能钉 agent bind
 * 的段内落位（openspec invariant 7 / argv 顺序纪律）。
 */
function fenceArgvFor(session: EgressSession): {
  readonly argv: readonly string[];
  readonly homeRoot: string;
  readonly task: string;
} {
  const task = scratchDir();
  const tmp = scratchDir();
  const homeRoot = scratchDir();
  const argv = createBwrapFence({
    command: "bash",
    args: ["-c", "true"],
    fsPolicy: createFsPolicy({ tmpDir: tmp, mode: "workspace" }),
    env: { PATH: "/bin" },
    cwd: task,
    homeRoot,
    workspaceRoot: task,
    tmpRoot: tmp,
    cwdReadonly: true,
    egress: session.spec,
  }).argv;
  return { argv, homeRoot, task };
}

function tripleIdx(
  argv: readonly string[],
  verb: string,
  target: string
): number {
  return argv.findIndex(
    (arg, i) => arg === verb && argv[i + 1] === target && argv[i + 2] === target
  );
}

describe("SSH_AUTH_SOCK 条件形态 — 关态（默认）", () => {
  it("默认关：spec.env 无 SSH_AUTH_SOCK，围栏 argv 无该 setenv / bind", async () => {
    const { session } = await makeSession({});
    try {
      expect(session.spec.sshAuthSockPath).toBeUndefined();
      expect("SSH_AUTH_SOCK" in session.spec.env).toBe(false);
      const { argv } = fenceArgvFor(session);
      expect(argv).not.toContain("SSH_AUTH_SOCK");
    } finally {
      await session.dispose();
    }
  });
});

describe("SSH_AUTH_SOCK 条件形态 — 开态", () => {
  it("开态：--bind 落 egress 段（workspaceMounts 后、proc/dev 前）+ env 注入走 --clearenv 后 --setenv", async () => {
    const agent = fakeAgentSocket(scratchDir());
    const { session, socatArgs } = await makeSession({
      sshAuthSockPath: agent,
    });
    try {
      expect(session.spec.sshAuthSockPath).toBe(agent);
      expect(session.spec.env.SSH_AUTH_SOCK).toBe(agent);

      const { argv, homeRoot } = fenceArgvFor(session);
      const homeRoIdx = tripleIdx(argv, "--ro-bind", homeRoot);
      const egressSocketIdx = tripleIdx(
        argv,
        "--bind",
        session.spec.unixSocketPath
      );
      const agentBindIdx = tripleIdx(argv, "--bind", agent);
      const procIdx = argv.indexOf("--proc");
      // 段内落位：workspaceMounts(home) < egress socket bind < agent bind < proc/dev
      expect(homeRoIdx).toBeGreaterThan(-1);
      expect(egressSocketIdx).toBeGreaterThan(homeRoIdx);
      expect(agentBindIdx).toBeGreaterThan(egressSocketIdx);
      expect(agentBindIdx).toBeLessThan(procIdx);
      // 与 egress 桥同一 session 装配（桥恒在场，凭据缝不单独开路）
      expect(socatArgs[0]).toContain(
        `UNIX-LISTEN:${session.spec.unixSocketPath}`
      );

      const clearenvIdx = argv.indexOf("--clearenv");
      const setenvIdx = argv.findIndex(
        (arg, i) => arg === "--setenv" && argv[i + 1] === "SSH_AUTH_SOCK"
      );
      expect(setenvIdx).toBeGreaterThan(clearenvIdx);
      expect(argv[setenvIdx + 2]).toBe(agent);
    } finally {
      await session.dispose();
    }
  });

  it("与 egress 桥同 dispose 通道：dispose 删自有 egress socket、不删宿主 agent socket，且幂等", async () => {
    const agent = fakeAgentSocket(scratchDir());
    const { session, socatArgs } = await makeSession({
      sshAuthSockPath: agent,
    });
    const egressSocketPath = session.spec.unixSocketPath;
    // 模拟桥真落过 socket 文件（假 spawn 不创建）
    writeFileSync(egressSocketPath, "", "utf8");
    expect(existsSync(egressSocketPath)).toBe(true);
    expect(socatArgs.length).toBeGreaterThan(0);

    await session.dispose();
    expect(existsSync(egressSocketPath)).toBe(false);
    // agent socket 非 session 所有 —— dispose 不得删宿主路径
    expect(existsSync(agent)).toBe(true);
    // 幂等（ADR-0097 dispose 契约）
    await session.dispose();
    expect(existsSync(agent)).toBe(true);
  });
});

describe("SSH_AUTH_SOCK 条件形态 — fail-closed 与归类", () => {
  it("开态但 agent socket 缺失 → SshAgentUnavailableError（infra），含「宿主侧 ssh-add 或无口令 key」指引，且不起桥", async () => {
    const missing = join(scratchDir(), "no-such-agent.sock");
    let spawned = false;
    let err: unknown;
    try {
      await createEgressSession({
        policy: {
          allowedDomains: ["github.com"],
          deniedDomains: [],
          commandLabel: "t6-missing-agent",
        },
        socatCommand: "fake-socat",
        probeSocat: () => true,
        spawn: ((..._args: never[]) => {
          spawned = true;
          return fakeSocatProc(1);
        }) as unknown as typeof realSpawn,
        socketPathFactory: (id) => join(scratchDir(), `egress-${id}.sock`),
        sshAuthSockPath: missing,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SshAgentUnavailableError);
    expect((err as SshAgentUnavailableError).message).toContain(
      "宿主侧 `ssh-add` 或无口令 key"
    );
    // fail-fast：抛错在起 socat 桥之前（不留「有 bind 无桥」半开形态）
    expect(spawned).toBe(false);
  });

  it("F8 归类：agent socket 在场但为亡文件（连不上=infra）→ 缝形状照常装配，违例 sink 恒空（不冒充域拒绝）", async () => {
    const { session } = await makeSession({
      sshAuthSockPath: fakeAgentSocket(scratchDir()),
    });
    try {
      // 凭据缝不经 filter：session 存续期无任何域判定发生 → drain 为空。
      expect(session.violationSink.drain()).toEqual([]);
    } finally {
      await session.dispose();
    }
    expect(session.violationSink.drain()).toEqual([]);
  });
});
