/**
 * bash sandbox: physical (bwrap fence) + logical (validator) dual-track regression.
 *
 * Covers:
 *   - bash.timeout.partialOutput   real spawn — partial stdout survives a
 *                                    cancellation.
 *   - bash.bwrap.argvHasUnshareNet  pure logic — build fence argv and assert key flags.
 *   - bash.missingBwrap.failLoud    fail loud when bwrap is absent from PATH.
 *   - bash.readonly dual gates      real spawn — validator throws a typed error and
 *                                    the fence turns cwd writes into EROFS.
 *
 * Guard: the hasBwrap() check skips real-spawn tests on CI without bwrap;
 * the pure-logic argv tests are unaffected.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, it } from "vitest";

import { createBashTool } from "../../../src/harness/aci/tools/bash.ts";
import { ReadonlyViolationError } from "../../../src/harness/aci/tools/bash-readonly.ts";
import { waitForPidFile } from "./tools/spawn-test-utils.ts";
import { createBwrapFence } from "../../../src/harness/sandbox/bwrap.ts";
import { createFsPolicy } from "../../../src/harness/sandbox/fs-policy.ts";

const scratchPaths: string[] = [];

async function makeScratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

// Closed-world fixture: contract roots (taskRoot/tmp) are validated on disk,
// so the pure-logic argv tests use real directories (created once at module
// level, cleaned in afterAll) instead of fake paths like "/workspace" + "/tmp/job".
const ARGV_FIXTURE_CWD = mkdtempSync(join(tmpdir(), "bash-sandbox-argv-"));

afterAll(() => {
  rmSync(ARGV_FIXTURE_CWD, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(
    scratchPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

function hasBwrap(): boolean {
  const probe = spawnSync("bwrap", ["--version"], { stdio: "ignore" });
  return probe.status === 0;
}

/** The bash handler returns an envelope `{ output, meta? }`; this suite
 *  asserts business semantics against the existing BashResult contract
 *  (partial stdout under cancellation, readonly dual gates, etc.). The
 *  helper translates between envelope and BashResult, keeping assertion strength. */
interface BashResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}
interface BashEnvelope {
  readonly output: string;
  readonly meta?: { readonly stdout?: string; readonly stderr?: string };
}
function parseBashEnvelope(envelope: BashEnvelope): BashResult {
  return JSON.parse(envelope.output) as BashResult;
}

describe("bash.bwrap.argvHasUnshareNet", () => {
  it("argv contains the canonical fence flags (no spawn)", () => {
    const cwd = ARGV_FIXTURE_CWD;
    const argv = createBwrapFence({
      command: "bash",
      args: ["-c", "echo hi"],
      fsPolicy: createFsPolicy({ tmpDir: tmpdir() }),
      env: { PATH: "/bin" },
      cwd,
    }).argv;

    assert.equal(argv[0], "bwrap");
    assert.ok(argv.includes("--unshare-net"));
    // ADR-0092 global mode: bind the host root `/` as the base, then re-bind
    // system prefixes read-only.
    const rootBindIdx = argv.findIndex(
      (arg, index) => arg === "--bind" && argv[index + 1] === "/"
    );
    assert.notEqual(rootBindIdx, -1, "expected --bind / / in argv");
    assert.equal(argv[rootBindIdx + 2], "/");
    // `--ro-bind /etc /etc` (three consecutive argv items), after the `/` bind.
    const etcIdx = argv.indexOf("/etc");
    assert.notEqual(etcIdx, -1);
    assert.deepEqual(argv.slice(etcIdx - 1, etcIdx + 2), [
      "--ro-bind",
      "/etc",
      "/etc",
    ]);
    assert.ok(
      etcIdx > rootBindIdx,
      "system ro-bind follows the host-root bind"
    );
    // Global mode: no guest /tmp mount, no tmpfs, no writable cwd bind.
    assert.equal(argv.includes("--tmpfs"), false);
    assert.equal(
      argv.findIndex(
        (arg, index) => arg === "--bind" && argv[index + 1] === cwd
      ),
      -1,
      "global mode has no per-root writable cwd bind"
    );
    // Global mode must not emit the sensitive-path tmpfs overlay; the
    // isSensitive / protected-state predicates retired along with the Round-2
    // placeholder (no consumers), so fs-policy only carries tmpRoot and does
    // not shape argv.
    assert.equal(
      argv.includes(`${homedir()}/.ssh`),
      false,
      "global mode must not emit the sensitive-path tmpfs overlay"
    );
    // --clearenv precedes every --setenv so the fence inherits only the
    // whitelisted entries, never the host env.
    const clearenvIdx = argv.indexOf("--clearenv");
    assert.notEqual(clearenvIdx, -1, "expected --clearenv in argv");
    const setenvIdxs = argv
      .map((a, i) => (a === "--setenv" ? i : -1))
      .filter((i) => i !== -1);
    for (const i of setenvIdxs) {
      assert.ok(
        clearenvIdx < i,
        `--clearenv (${clearenvIdx}) must precede --setenv (${i})`
      );
    }
  });
});

describe("bash.missingBwrap.failLoud", () => {
  it("createBashTool throws with 'bwrap' in the message when bwrap is not on PATH", () => {
    // Override PATH so bwrap cannot be found (requireBwrap inside
    // createBashTool probes with spawnSync("bwrap", ["--version"]), which
    // inherits process.env.PATH).
    const savedPath = process.env.PATH;
    const fakeEmptyDir = "/tmp/iknow-no-bwrap-" + String(Date.now());
    process.env.PATH = fakeEmptyDir;
    try {
      // sanity: bwrap should be unfindable under the fake PATH
      const probe = spawnSync("bwrap", ["--version"], {
        stdio: "ignore",
        env: { ...process.env, PATH: fakeEmptyDir },
      });
      if (probe.status === 0) {
        // bwrap was still found under the fake PATH — skip
        return;
      }
      assert.throws(
        () => createBashTool("/tmp"),
        (error: unknown) =>
          error instanceof Error && error.message.includes("bwrap")
      );
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

describe("bash.timeout.partialOutput", () => {
  it.skipIf(!hasBwrap())(
    "abort mid-run preserves partial stdout (SC13)",
    async () => {
      const cwd = await makeScratch("bash-partial-");
      const tool = createBashTool(cwd);
      // Write the script into cwd then `node <file>` — "node" is on the
      // allowlist; the script body never goes through bash parsing, fully
      // sidestepping shell metachars (`;` / `(` / `|`). The fixture writes
      // fd 1 directly via fs.writeSync (bypassing the libuv userspace buffer
      // on Node's piped stdout) plus a marker barrier: wait for the fixture
      // to emit its lines and drop the marker before aborting, removing the
      // timing flake where a buffered console.log line would be lost to SIGTERM.
      await writeFile(
        join(cwd, "echo-loop.cjs"),
        [
          'const fs = require("node:fs");',
          "for (let i = 1; i <= 20; i++) {",
          "  fs.writeSync(1, 'line ' + i + '\\n');",
          "}",
          `fs.writeFileSync(${JSON.stringify(join(cwd, "started"))}, String(process.pid));`,
          "setInterval(() => {}, 1000);",
        ].join("\n")
      );
      const controller = new AbortController();
      const execution = tool.handler(
        { command: "node echo-loop.cjs" },
        { signal: controller.signal }
      );
      await waitForPidFile(join(cwd, "started"));
      controller.abort();
      const result = parseBashEnvelope((await execution) as BashEnvelope);
      assert.ok(
        typeof result.stdout === "string",
        `expected stdout string, got: ${String(result.stdout)}`
      );
      assert.ok(
        result.stdout.length > 0,
        `expected non-empty partial stdout, got: ${JSON.stringify(result.stdout)}`
      );
      assert.match(result.stdout, /line \d+/);
    },
    5_000
  );

  it.skipIf(!hasBwrap())(
    "abort before any output yields empty stdout (no phantom content)",
    async () => {
      const cwd = await makeScratch("bash-empty-");
      const pidFile = join(cwd, "child.pid");
      await writeFile(
        join(cwd, "sleep-script.cjs"),
        [
          'const { spawn } = require("node:child_process");',
          'const { writeFileSync } = require("node:fs");',
          'const child = spawn("sleep", ["30"], { stdio: "ignore" });',
          'writeFileSync("child.pid", String(child.pid));',
          'child.once("exit", () => process.exit(0));',
          "setInterval(() => {}, 1000);",
        ].join("\n")
      );
      const controller = new AbortController();
      const tool = createBashTool(cwd);
      const execution = tool.handler(
        { command: "node sleep-script.cjs" },
        { signal: controller.signal }
      );
      await waitForPidFile(pidFile);
      controller.abort();
      const result = parseBashEnvelope((await execution) as BashEnvelope);
      assert.equal(result.stdout, "");
    },
    5_000
  );
});

describe("bash.bwrap.hostPrefixes (real spawn)", () => {
  it.skipIf(!hasBwrap())(
    "optional host prefix /opt is visible inside the default fence when it exists",
    async () => {
      const cwd = await makeScratch("bash-host-prefix-");
      const tool = createBashTool(cwd);
      const result = parseBashEnvelope(
        (await tool.handler({
          command:
            "if [ -d /opt ]; then test -r /opt && echo visible; else echo absent; fi",
        })) as BashEnvelope
      );
      assert.equal(result.code, 0, result.stderr);
      if (existsSync("/opt")) {
        assert.match(result.stdout, /visible/);
      } else {
        assert.match(result.stdout, /absent/);
      }
    },
    15_000
  );
});

describe("bash.readonly 双闸 (real spawn)", () => {
  // Acceptance intent: "an explore-role bash write is blocked by the validator,
  // with the fence's EROFS as backstop." Only a real bwrap run shows how the two
  // gates divide labour — the validator is the policy gate (command layer), the
  // fence the physical gate (kernel layer). bash-readonly.test.ts already covers
  // the policy gate's command taxonomy; this adds proof the fence gate really lands EROFS.
  it.skipIf(!hasBwrap())(
    "validator 闸:readonly 模式的写命令抛 ReadonlyViolationError,文件不落地",
    async () => {
      const cwd = await makeScratch("bash-ro-validator-");
      const tool = createBashTool(cwd, {
        bashMode: "readonly",
        cwdReadonly: true,
      });
      await assert.rejects(
        async () => tool.handler({ command: "echo hi > out.txt" }),
        (error: unknown) => error instanceof ReadonlyViolationError
      );
      assert.equal(existsSync(join(cwd, "out.txt")), false);
    },
    15_000
  );

  it.skipIf(!hasBwrap())(
    "PoC 回归:HOME 下的 cwd 中 find -fprint 不得写入目标文件",
    async () => {
      const homeDir = await makeScratch("bash-ro-poc-home-");
      const cwd = join(homeDir, "workspace");
      await mkdir(cwd);
      await writeFile(join(cwd, "visible.txt"), "visible\n");
      const target = join(cwd, "package.json");
      const tool = createBashTool(cwd, {
        bashMode: "readonly",
      });

      let result: unknown;
      let error: unknown;
      try {
        result = await tool.handler({
          command: "find . -fprint package.json",
        });
      } catch (caught) {
        error = caught;
      }

      const targetExists = existsSync(target);
      const targetContent = targetExists
        ? await readFile(target, "utf8")
        : undefined;
      assert.ok(
        error instanceof ReadonlyViolationError,
        `find -fprint PoC must be rejected; result=${JSON.stringify(result)}, targetExists=${targetExists}, targetContent=${JSON.stringify(targetContent)}`
      );
      assert.equal(targetExists, false);
    },
    15_000
  );

  it.skipIf(!hasBwrap())(
    "PoC 物理兜底:绕过 readonly validator 后 find -fprint 仍不得写入 cwd",
    async () => {
      const homeDir = await makeScratch("bash-ro-fence-poc-home-");
      const cwd = join(homeDir, "workspace");
      await mkdir(cwd);
      await writeFile(join(cwd, "visible.txt"), "visible\n");
      const target = join(cwd, "package.json");
      const tool = createBashTool(cwd, {
        cwdReadonly: true,
      });

      const result = parseBashEnvelope(
        (await tool.handler({
          command: "find . -fprint package.json",
        })) as BashEnvelope
      );

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /Read-only file system|Permission denied/);
      assert.equal(existsSync(target), false);
    },
    15_000
  );

  it.skipIf(!hasBwrap())(
    "fence 闸:validator 关掉后写 cwd 仍被 EROFS 硬拒(兜底不依赖 validator)",
    async () => {
      const cwd = await makeScratch("bash-ro-fence-");
      // bashMode absent = the validator does not intervene; only the
      // cwdReadonly layer remains — simulating a "validator missed it" shape
      // to prove the physical gate stands on its own.
      const tool = createBashTool(cwd, { cwdReadonly: true });
      for (const command of ["echo hi > out2.txt", "touch out3.txt"]) {
        const result = parseBashEnvelope(
          (await tool.handler({ command })) as BashEnvelope
        );
        assert.notEqual(result.code, 0, `expected non-zero for: ${command}`);
        assert.match(result.stderr, /Read-only file system/);
      }
      assert.equal(existsSync(join(cwd, "out2.txt")), false);
      assert.equal(existsSync(join(cwd, "out3.txt")), false);
    },
    15_000
  );

  it.skipIf(!hasBwrap())(
    "基线:cwdReadonly 缺省时同样的写命令成功(EROFS 不是环境自带的)",
    async () => {
      const cwd = await makeScratch("bash-ro-baseline-");
      const tool = createBashTool(cwd);
      const result = parseBashEnvelope(
        (await tool.handler({
          command: "touch baseline.txt",
        })) as BashEnvelope
      );
      assert.equal(result.code, 0);
      assert.equal(existsSync(join(cwd, "baseline.txt")), true);
    },
    15_000
  );
});

describe("bash.fence.networkIsolation (argv shape, no spawn)", () => {
  // ADR-0097: there is no per-call network switch at the fence layer —
  // `--unshare-net` is a constant, netns isolation is the only network control
  // axis (egress is proxied through a unix socket by the egress seam).
  function fenceArgv(): readonly string[] {
    const cwd = ARGV_FIXTURE_CWD;
    return createBwrapFence({
      command: "bash",
      args: ["-c", "echo hi"],
      fsPolicy: createFsPolicy({ tmpDir: tmpdir() }),
      env: { PATH: "/bin" },
      cwd,
    }).argv;
  }

  it("--unshare-net is always present in argv (constant netns isolation)", () => {
    const argv = fenceArgv();
    assert.ok(
      argv.includes("--unshare-net"),
      "--unshare-net is constant (spec SC1)"
    );
    // canonical fence flags spot-check
    assert.equal(argv[0], "bwrap");
    assert.equal(argv[1], "--unshare-user-try");
    assert.ok(argv.includes("--die-with-parent"));
    const etcIdx = argv.indexOf("/etc");
    assert.deepEqual(argv.slice(etcIdx - 1, etcIdx + 2), [
      "--ro-bind",
      "/etc",
      "/etc",
    ]);
    const rootBindIdx = argv.findIndex(
      (arg, index) => arg === "--bind" && argv[index + 1] === "/"
    );
    assert.notEqual(rootBindIdx, -1, "expected --bind / / in argv");
    assert.ok(argv.includes("--clearenv"));
    assert.ok(argv.includes("--chdir"));
    assert.deepEqual(argv.slice(argv.indexOf("--"), argv.indexOf("--") + 3), [
      "--",
      "bash",
      "-c",
    ]);
  });
});
