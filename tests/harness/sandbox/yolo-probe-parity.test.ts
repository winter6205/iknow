/**
 * ADR-0119 / specs/yolo-mode.md — regression face for the archived sandbox
 * probe's **yolo category** plus the four-route bare-argv parity pins.
 *
 * History: the yolo probe category lived in `scripts/sandbox-probe.ts`
 * (`pushYoloChecks`, six checks). That script was archived to
 * `iknow-archive/scripts-probes/` and its `npm run probe:sandbox` face left
 * master; this vitest file is where those assertions live now. Mapping
 * (old probe check → test below):
 *   1. "fence argv is bare"            → "yolo profile produces bare argv…"
 *      (+ the proxy-env face and the route captures)
 *   2. "fence runs in the host netns"  → "yolo spawn shares the host netns…"
 *   3. "host loopback reachable"       → "yolo spawn reaches host loopback…"
 *   4. "home write lands on host"      → "yolo spawn writes $HOME on host…"
 *      (the old workspace-EROFS contrast stays certified by
 *      bash-workspace-mode-fence.test.ts / verify/workspace-mode-fence.test.ts)
 *   5. "verify route bare"             → route-3 wiring capture below +
 *      "verify-shape bare spawn…" (the wiring half pins that
 *      `makeDefaultRunVerify` hands a bare fence to the runner; the physical
 *      half runs that bare argv shape and observes the no-fence effects)
 *   6. "contrast — non-yolo verify goes through bwrap" →
 *      tests/harness/sandbox/yolo-fence-contrast.test.ts (needs a working
 *      bwrap + user namespaces, so it lives in its own CI-excluded file)
 *
 * Invariants pinned here:
 *   - the yolo profile and the other profiles are **two disjoint check
 *     lists**: yolo checks only enter the yolo face; non-yolo assertions are
 *     conditioned by extension, never by inverting or dropping the old ones;
 *   - the yolo fence opts shape (`yolo: true` into `createBwrapFence`)
 *     yields bare argv with no "fence present" token (`bwrap` /
 *     `--unshare-net` / `--clearenv` / `--setenv` / `--bind`);
 *   - the four routes (foreground bash / background spawn / verify
 *     sandbox-run / subagent worker env wire) all collapse to the bare
 *     branch of the same SSOT factory under yolo: the first three are
 *     asserted on fence argv directly, the fourth via the parent-side
 *     `IKNOW_YOLO` env write (worker read side is end-to-end in
 *     tests/subagent/yolo-env-wire.test.ts).
 *
 * Technique: this file avoids calling the `BWRAP_PATTERNS` anchor factories
 * (so no `vitest.ci-excludes.ts` entry is needed for the argv/wiring part);
 * it consumes:
 *   - `createBwrapFence` (pure factory, no host bwrap probe at build time);
 *   - `defaultBackgroundSpawn` (argv captured through a node:child_process mock);
 *   - `makeDefaultRunVerify` (argv captured through a runner mock);
 *   - `createDefaultSubAgentSpawn` (env captured through a child_process mock).
 * None of the four triggers assembly-time `requireBwrap`, so both CI jobs run
 * this file directly; the physical bare-path group needs only bash + /proc —
 * no fence at all, which is exactly what "the fence retires" means.
 */
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

vi.mock("../../../src/harness/sandbox/runner.ts", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/harness/sandbox/runner.ts")
    >();
  return { ...actual, runInSandbox: vi.fn() };
});

vi.mock(
  "../../../src/harness/sandbox/egress/session.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../src/harness/sandbox/egress/session.ts")
      >();
    return {
      ...actual,
      // Under yolo this must never be called; the non-yolo control arm needs
      // a fake session to return, so the call count is asserted per case.
      createEgressSession: vi.fn(async () => ({
        id: "probe-parity-egress",
        spec: {
          unixSocketPath: "/tmp/iknow-probe-parity.sock",
          sandboxLocalPort: 18080,
          env: { HTTP_PROXY: "http://127.0.0.1:18080" },
        },
        violationSink: { drain: () => [] },
        dispose: async () => undefined,
      })),
    };
  }
);

import * as net from "node:net";
import * as childProcessModule from "node:child_process";
import * as sandboxRunner from "../../../src/harness/sandbox/runner.ts";
import * as egressSessionModule from "../../../src/harness/sandbox/egress/session.ts";
import { createBwrapFence } from "../../../src/harness/sandbox/bwrap.ts";
import { createFsPolicy } from "../../../src/harness/sandbox/fs-policy.ts";
import { YOLO_ENV_KEY } from "../../../src/harness/sandbox/yolo.ts";
import { defaultBackgroundSpawn } from "../../../src/harness/background/manager.ts";
import { makeDefaultRunVerify } from "../../../src/harness/verify/sandbox-run.ts";
import { createDefaultSubAgentSpawn } from "../../../src/harness/subagent/spawn.ts";

const FIX_CWD = mkdtempSync(join(tmpdir(), "yolo-probe-parity-cwd-"));
const FIX_TMP = mkdtempSync(join(tmpdir(), "yolo-probe-parity-tmp-"));
const FIX_HOME = mkdtempSync(join(tmpdir(), "yolo-probe-parity-home-"));

afterAll(() => {
  rmSync(FIX_CWD, { recursive: true, force: true });
  rmSync(FIX_TMP, { recursive: true, force: true });
  rmSync(FIX_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  vi.mocked(sandboxRunner.runInSandbox)
    .mockReset()
    .mockImplementation(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
});

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * Probe-category argv criterion — same semantics as the archived
 * `YOLO_FORBIDDEN_ARGV_TOKENS` in the old probe script.
 *
 * The probe module is not imported (it ran `main()` at top level); the list
 * is restated here and asserted case by case — drift between the two turns
 * this file red immediately, which is the desired coupling signal (a probe
 * revival with looser criteria would still be held to the strict shape here).
 */
const FORBIDDEN_FENCE_TOKENS: readonly string[] = Object.freeze([
  "bwrap",
  "--unshare-net",
  "--unshare-user-try",
  "--clearenv",
  "--setenv",
  "--bind",
  "--ro-bind",
  "--dev-bind",
  "--proc",
  "--chdir",
  "--die-with-parent",
  "--",
]);

const PROXY_ENV_KEYS: readonly string[] = Object.freeze([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
]);

function fenceOpts(yolo: boolean): Parameters<typeof createBwrapFence>[0] {
  return {
    command: "bash",
    args: ["-c", "echo hi"],
    fsPolicy: createFsPolicy({ tmpDir: FIX_TMP, mode: "global" }),
    env: { PATH: "/usr/bin:/bin" },
    cwd: FIX_CWD,
    ...(yolo ? { yolo: true } : {}),
  };
}

/** Assert a set of argv is the yolo bare shape — the no-fence criterion. */
function expectBareArgv(argv: readonly string[]): void {
  expect(argv[0]).toBe("bash");
  expect(argv).toEqual(["bash", "-c", "echo hi"]);
  for (const token of FORBIDDEN_FENCE_TOKENS) {
    expect(argv).not.toContain(token);
  }
}

// The physical bare-path group (archived checks 2-5) needs only bash and a
// readable /proc — no fence, hence no bwrap. An unreadable /proc is
// "cannot decide", not "pass", so the group is skipped rather than faked.
const CAN_EXEC_BARE =
  process.platform === "linux" && existsSync("/proc/self/ns/net");

/** Spawn the real yolo fence argv (bare) with the given command + env. */
function spawnBare(cmd: string, env: NodeJS.ProcessEnv) {
  const argv = createBwrapFence({
    command: "bash",
    args: ["-c", cmd],
    fsPolicy: createFsPolicy({ tmpDir: FIX_TMP, mode: "global" }),
    env,
    cwd: FIX_CWD,
    yolo: true,
  }).argv;
  return spawnSync(argv[0], argv.slice(1), {
    env,
    cwd: FIX_CWD,
    encoding: "utf8",
  });
}

function hostNetns(): string {
  return readlinkSync("/proc/self/ns/net");
}

describe("probe parity — fence opts shape and bare argv (ADR-0119)", () => {
  it("yolo profile (yolo=true) produces bare argv with no 'fence present' token", () => {
    expectBareArgv(createBwrapFence(fenceOpts(true)).argv);
  });

  it("non-yolo profile keeps argv[0]=bwrap with --unshare-net always present", () => {
    const argv = createBwrapFence(fenceOpts(false)).argv;
    expect(argv[0]).toBe("bwrap");
    expect(argv).toContain("--unshare-net");
    // Physical precondition of the old probe's other categories: the fence
    // is up. This is a different proposition from the one above, not its
    // inverse on the same list.
    expect(argv).not.toEqual(["bash", "-c", "echo hi"]);
  });

  it("yolo profile carries no proxy env (the egress seam is skipped wholesale, ADR-0119 ruling 3)", () => {
    const argv = createBwrapFence(fenceOpts(true)).argv;
    for (const key of PROXY_ENV_KEYS) {
      expect(argv.join("\u0000")).not.toContain(key);
    }
  });
});

describe("four-route bare-argv parity — all collapse onto the same SSOT factory under yolo", () => {
  it("route 1 foreground fence: yolo -> bare argv", () => {
    expectBareArgv(createBwrapFence(fenceOpts(true)).argv);
  });

  it("route 2 background spawn: yolo=true -> background spawn argv bare", async () => {
    const spawnMock = vi.mocked(childProcessModule.spawn);
    spawnMock.mockImplementation(
      () =>
        Object.assign(new EventEmitter(), {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          pid: 97001,
          kill: vi.fn(() => true),
          exitCode: null,
          signalCode: null,
        }) as unknown as ChildProcess
    );
    await defaultBackgroundSpawn({
      command: "echo hi",
      cwd: FIX_CWD,
      env: { PATH: "/usr/bin:/bin" },
      tmpDir: FIX_TMP,
      yolo: true,
    });
    const call = spawnMock.mock.calls[0];
    expect(call).toBeDefined();
    expectBareArgv([
      call?.[0] as string,
      ...((call?.[1] as readonly string[]) ?? []),
    ]);
  });

  it("route 3 verify sandbox-run: yolo holder -> the fence argv runInSandbox receives is bare", async () => {
    const runVerify = makeDefaultRunVerify({
      cwd: FIX_CWD,
      tmpDir: FIX_TMP,
      yolo: { get: () => true, set: () => undefined },
    });
    await runVerify("echo hi", {});
    expect(vi.mocked(sandboxRunner.runInSandbox)).toHaveBeenCalledTimes(1);
    const captured = vi.mocked(sandboxRunner.runInSandbox).mock.calls[0]?.[0];
    expect(captured).toBeDefined();
    expectBareArgv(captured!.fence.argv);
    // No egress session should start under yolo (the second consequence of
    // reading the same holder).
    expect(
      vi.mocked(egressSessionModule.createEgressSession)
    ).not.toHaveBeenCalled();
  });

  it("route 3 control: non-yolo verify -> bwrap argv + egress session started (same input, only the holder differs)", async () => {
    const runVerify = makeDefaultRunVerify({
      cwd: FIX_CWD,
      tmpDir: FIX_TMP,
      egressPolicy: {
        allowedDomains: ["example.com"],
        deniedDomains: [],
        commandLabel: "probe-parity:non-yolo",
      },
    });
    await runVerify("echo hi", {});
    const captured = vi.mocked(sandboxRunner.runInSandbox).mock.calls[0]?.[0];
    expect(captured).toBeDefined();
    expect(captured!.fence.argv[0]).toBe("bwrap");
    expect(captured!.fence.argv).toContain("--unshare-net");
    expect(
      vi.mocked(egressSessionModule.createEgressSession)
    ).toHaveBeenCalledTimes(1);
  });

  it("route 4 subagent worker env wire: parent-side yolo holder -> child env carries IKNOW_YOLO (single-token value domain)", () => {
    const spawnMock = vi.mocked(childProcessModule.spawn);
    spawnMock.mockImplementation(
      () =>
        Object.assign(new EventEmitter(), {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          pid: 96001,
          kill: vi.fn(() => true),
          exitCode: null,
          signalCode: null,
        }) as unknown as ChildProcess
    );
    const spawnFn = createDefaultSubAgentSpawn({
      sessionRoot: FIX_TMP,
      installRoot: FIX_CWD,
      traceDir: join(FIX_TMP, "trace"),
      yolo: { get: () => true, set: () => undefined },
    });
    spawnFn(
      { id: "probe-parity-task" } as never,
      "probe-parity-task",
      "{}" as never
    );
    const call = spawnMock.mock.calls[0];
    expect(call).toBeDefined();
    const opts = call?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
    expect(opts?.env?.[YOLO_ENV_KEY]).toBe("1");

    // Control: holder absent / false → the key is not written (legacy child
    // env bytes unchanged; the child side reads key-absent as false =
    // fail-closed keeps the fence).
    spawnMock.mockClear();
    const plainSpawnFn = createDefaultSubAgentSpawn({
      sessionRoot: FIX_TMP,
      installRoot: FIX_CWD,
      traceDir: join(FIX_TMP, "trace"),
    });
    plainSpawnFn(
      { id: "probe-parity-task" } as never,
      "probe-parity-task",
      "{}" as never
    );
    const plainCall = spawnMock.mock.calls[0];
    const plainOpts = plainCall?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
    expect(plainOpts?.env?.[YOLO_ENV_KEY]).toBeUndefined();
  });
});

describe("bare-path physical checks (archived probe yolo category 2-5: no bwrap needed)", () => {
  it.skipIf(!CAN_EXEC_BARE)(
    "yolo spawn shares the host netns (no --unshare-net isolation)",
    () => {
      // The yolo-side dual of the non-yolo `--unshare-net` fact (pinned
      // physically in yolo-fence-contrast.test.ts): no fence → no new
      // netns, the spawned reading equals the host reading.
      const r = spawnBare("readlink /proc/self/ns/net", {
        PATH: "/usr/bin:/bin",
      });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(hostNetns());
    }
  );

  it.skipIf(!CAN_EXEC_BARE)(
    "yolo spawn reaches a host-loopback listener (network layer not netns-denied)",
    async () => {
      // The provable form of "network not denied by netns" without public
      // egress: a listener in this process is reachable from the spawned
      // command because there is no second netns. /dev/tcp keeps the check
      // independent of curl being installed.
      //
      // This check MUST spawn asynchronously: the listener runs on this
      // worker's event loop, and spawnSync would freeze that loop so the
      // pending 'connection' event never fires — the child's `cat <&3`
      // would then block forever and vitest's own timeout could not
      // interrupt it. execFile passes straight through the module mock
      // (only `spawn` is replaced here), so the loop keeps turning.
      const server = net.createServer((socket) => {
        socket.end("probe-listener-ok");
      });
      let connectionSeen = false;
      server.on("connection", () => {
        connectionSeen = true;
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve)
      );
      try {
        const port = (server.address() as net.AddressInfo).port;
        const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
        const argv = createBwrapFence({
          command: "bash",
          args: [
            "-c",
            `exec 3<>/dev/tcp/127.0.0.1/${port}; printf q >&3; cat <&3`,
          ],
          fsPolicy: createFsPolicy({ tmpDir: FIX_TMP, mode: "global" }),
          env,
          cwd: FIX_CWD,
          yolo: true,
        }).argv;
        const stdout = await new Promise<string>((resolve, reject) => {
          childProcessModule.execFile(
            argv[0],
            argv.slice(1),
            { env, cwd: FIX_CWD, encoding: "utf8", timeout: 10000 },
            (err, out) => (err ? reject(err) : resolve(out))
          );
        });
        expect(stdout).toContain("probe-listener-ok");
        expect(connectionSeen).toBe(true);
      } finally {
        server.close();
      }
    }
  );

  it.skipIf(!CAN_EXEC_BARE)(
    "yolo spawn writes $HOME straight on the host (no ro-bind carrier)",
    () => {
      // $HOME is a fixture home — never the operator's real home. Assert
      // host-side content, not just the exit code (exit-code-only would
      // judge a silently-dropped write green). The old workspace-tier
      // EROFS contrast stays certified by
      // bash-workspace-mode-fence.test.ts / verify/workspace-mode-fence.test.ts.
      const marker = join(FIX_HOME, "yolo-probe-home");
      rmSync(marker, { force: true });
      const r = spawnBare(
        `printf yolo-home > "$HOME/yolo-probe-home" && test -s "$HOME/yolo-probe-home"`,
        { PATH: "/usr/bin:/bin", HOME: FIX_HOME }
      );
      expect(r.status).toBe(0);
      const persisted = existsSync(marker);
      const content = persisted ? readFileSync(marker, "utf8") : "";
      rmSync(marker, { force: true });
      expect(persisted).toBe(true);
      expect(content).toBe("yolo-home");
    }
  );

  it.skipIf(!CAN_EXEC_BARE)(
    "verify-shape bare spawn: TMPDIR write lands, host netns, parent is not bwrap (physical half of archived check 5)",
    () => {
      // The wiring half of the verify route (route-3 case above:
      // makeDefaultRunVerify hands a bare fence to the runner) plus this
      // physical half compose the archived check's claim: the same three
      // observable consequences the probe asserted — `$TMPDIR` write
      // lands on the fixture dir (the command really ran, host direct
      // write), netns equals the host's (no `--unshare-net`), and
      // /proc/$PPID/comm is not `bwrap` (no fence prefix; the
      // fence-present side of that contrast is certified physically in
      // yolo-fence-contrast.test.ts).
      const marker = join(FIX_TMP, "yolo-probe-verify");
      rmSync(marker, { force: true });
      const r = spawnBare(
        `printf yolo-verify > "$TMPDIR/yolo-probe-verify"; ` +
          "readlink /proc/self/ns/net; " +
          "cat /proc/$PPID/comm",
        { PATH: "/usr/bin:/bin", TMPDIR: FIX_TMP }
      );
      expect(r.status).toBe(0);
      const content = existsSync(marker) ? readFileSync(marker, "utf8") : "";
      rmSync(marker, { force: true });
      expect(content).toBe("yolo-verify");
      const [netnsLine = "", ppidComm = ""] = r.stdout.split("\n");
      expect(netnsLine.trim()).toBe(hostNetns());
      expect(ppidComm.trim().length).toBeGreaterThan(0);
      expect(ppidComm.trim()).not.toBe("bwrap");
    }
  );
});
