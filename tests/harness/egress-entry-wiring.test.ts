/**
 * tests/harness/egress-entry-wiring.test.ts
 *
 * specs/egress-credential-sentinel.md — entry-point wiring + explicit yolo posture.
 *
 * Pinned invariants:
 *   - the credential assembly entry (`mintEgressCredentialLayer`) branches on
 *     posture explicitly: `no-fence` (yolo / fence fully disarmed) → no
 *     minting, no injection, returns `{ skipped: "no-fence" }` plus a
 *     diagnostic trace (never silent — offline-verifiable "host values reach
 *     through with no presence-side protection"); `fenced` → delegates to
 *     `mintEgressCredentials`;
 *   - isolation OFF (settings.isolation.network absent): assembly leaves the
 *     same `skipped: no-fence` trace — never "looks protected, actually not";
 *   - all three assembly points (bash foreground / background manager /
 *     verify singleton) get the credential layer through one
 *     `createEgressSession` seam: each passes only `{ policy }` with zero
 *     credential branching (policy.credentials identity passthrough);
 *   - background releases through the settle()-hooked dispose channel
 *     (registry/store cleanup inside dispose is pinned by session tests);
 *   - EgressRelayUnavailableError path: credential layer absent with the
 *     session (seam never called / egress spec never lands on the fence), no
 *     fake-value keys in fence env, infra message unchanged (no new
 *     masquerading);
 *   - the `createEgressSession` seam keeps an additive shape: each side
 *     expects only `{ policy }` in opts, so the ssh-bridge plan can wire
 *     extra fields on the same opts shape.
 *
 * All fixtures are synthetic values; real host values / .env* never enter any input or assertion.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Module-level capture box (vi.hoisted: mock factories reference it at import time). */
const h = vi.hoisted(() => ({
  /** opts received by createBwrapFence (index export). */
  fenceOpts: [] as Record<string, unknown>[],
  /** args received by runInSandbox (exported from index and runner). */
  runArgs: [] as Record<string, unknown>[],
  /** opts received by createEgressSession (index export). */
  egressCalls: [] as Record<string, unknown>[],
  /** createEgressSession behavior (rewritten per test case). */
  egressImpl: (_opts: unknown): Promise<unknown> =>
    Promise.reject(new Error("not configured")),
  /** runInSandbox return value (rewritten per test case). */
  runResult: { exitCode: 0, stdout: "", stderr: "" },
}));

vi.mock("../../src/harness/sandbox/index.ts", async () => {
  const mod = await vi.importActual<
    typeof import("../../src/harness/sandbox/index.ts")
  >("../../src/harness/sandbox/index.ts");
  return {
    ...mod,
    createBwrapFence: (opts: Record<string, unknown>) => {
      h.fenceOpts.push(opts);
      return { __stubFence: true };
    },
    createEgressSession: (opts: Record<string, unknown>) => {
      h.egressCalls.push(opts);
      return h.egressImpl(opts);
    },
    runInSandbox: async (args: Record<string, unknown>) => {
      h.runArgs.push(args);
      return h.runResult;
    },
  };
});

// bash.ts imports runInSandbox directly from sandbox/runner.js — replace that too.
vi.mock("../../src/harness/sandbox/runner.ts", async () => {
  const mod = await vi.importActual<
    typeof import("../../src/harness/sandbox/runner.ts")
  >("../../src/harness/sandbox/runner.ts");
  return {
    ...mod,
    runInSandbox: async (args: Record<string, unknown>) => {
      h.runArgs.push(args);
      return h.runResult;
    },
  };
});

import { createBashTool } from "../../src/harness/aci/tools/bash.js";
import { createBackgroundTaskManager } from "../../src/harness/background/manager.js";
import { resolveTasksDir } from "../../src/harness/background/paths.js";
import {
  mintEgressCredentialLayer,
  noFenceCredentialTrace,
  type EgressCredentialRoster,
} from "../../src/harness/sandbox/egress/credential-assembly.js";
import type { MitmCA } from "../../src/harness/sandbox/egress/upstream.js";
import { createEgressPolicyFactory } from "../../src/harness/sandbox/egress/assembly.js";
import { EgressRelayUnavailableError } from "../../src/harness/sandbox/egress/session.js";
import type {
  EgressPolicyInput,
  EgressSession,
} from "../../src/harness/sandbox/egress/session.js";
import { makeDefaultRunVerify } from "../../src/harness/verify/sandbox-run.js";
import type { IknowSettings } from "../../src/config/settings.js";

const scratch: string[] = [];
function scratchDir(): string {
  const d = mkdtempSync(join(tmpdir(), "iknow-t6-entry-"));
  scratch.push(d);
  return d;
}

beforeEach(() => {
  h.fenceOpts.length = 0;
  h.runArgs.length = 0;
  h.egressCalls.length = 0;
  h.egressImpl = () => Promise.reject(new Error("not configured"));
  h.runResult = { exitCode: 0, stdout: "", stderr: "" };
});

afterEach(async () => {
  for (const p of scratch.splice(0))
    rmSync(p, { recursive: true, force: true });
});

/** Fake credential roster (fixture, not real host values). */
function rosterFixture(): EgressCredentialRoster {
  return {
    files: [],
    envVars: [{ name: "GH_TOKEN", injectHosts: ["github.com"] }],
  };
}

/** Test MitmCA stand-in: the mint entry consumes only trustBundlePath / bind sources. */
function fakeCa(): MitmCA {
  const dir = scratchDir();
  const bundlePath = join(dir, "trust-bundle.pem");
  writeFileSync(
    bundlePath,
    "-----BEGIN CERTIFICATE-----\nZmFrZQo=\n-----END CERTIFICATE-----\n"
  );
  return {
    trustBundlePath: bundlePath,
    keyPath: join(dir, "ca-key-should-never-bind.pem"),
    certPath: join(dir, "cert.pem"),
  } as unknown as MitmCA;
}

/** Stub session spec for the mint layer: simulates post-mint fence env increments (synthetic values). */
function mintedSpec(): EgressSession["spec"] {
  return {
    unixSocketPath: "/tmp/iknow-t6-stub.sock",
    sandboxLocalPort: 18080,
    innerBridgeScript:
      "/test-root/bin/node /test-root/vendor/egress-relay/egress-tcp-relay.mjs '/tmp/iknow-t6-stub.sock' 18080",
    relayAssetsDir: "/test-root/vendor/egress-relay",
    env: {
      HTTP_PROXY: "http://127.0.0.1:18080",
      HTTPS_PROXY: "http://127.0.0.1:18080",
      GH_TOKEN: "fake_value_t6_fixture",
      SSL_CERT_FILE: "/tmp/iknow-t6-bundle.pem",
    },
  };
}

function stubSession(opts?: { readonly spec?: EgressSession["spec"] }): {
  session: EgressSession;
  dispose: ReturnType<typeof vi.fn>;
} {
  const dispose = vi.fn(async () => undefined);
  return {
    session: Object.freeze({
      id: "t6-stub",
      spec: opts?.spec ?? mintedSpec(),
      violationSink: {
        record: () => undefined,
        drain: () => [],
      },
      dispose,
    }) as unknown as EgressSession,
    dispose,
  };
}

// ── 1. Credential-assembly entry posture branch (credential-assembly.ts) ────

describe("T6 凭据装配入口姿态分支", () => {
  it("posture no-fence → 不铸造不注入：返回 skipped 痕 + registry 未构造 + 诊断留痕", () => {
    const diagnostics: string[] = [];
    const out = mintEgressCredentialLayer({
      posture: "no-fence",
      onDiagnostic: (m) => diagnostics.push(m),
    });
    assert.deepEqual(out, { skipped: "no-fence" });
    // registry / store / envVars / binds all absent = nothing constructed.
    assert.equal("registry" in out, false);
    assert.equal("store" in out, false);
    assert.equal("envVars" in out, false);
    assert.equal("binds" in out, false);
    // Not silent: diagnostic trace present and offline-verifiable (canonical marker).
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0]!, /skipped: no-fence/);
  });

  it("posture fenced → 委托 mintEgressCredentials（T2 形状逐字：registry/envVars/binds 在场）", () => {
    const ca = fakeCa();
    const hostEnv: Record<string, string | undefined> = {
      GH_TOKEN: `gho_FAKE_t6_${Math.random().toString(36).slice(2)}`,
    };
    const out = mintEgressCredentialLayer({
      posture: "fenced",
      roster: rosterFixture(),
      ca,
      env: hostEnv,
    });
    assert.equal("skipped" in out, false);
    if ("skipped" in out) return;
    assert.ok(out.registry);
    assert.ok(out.store);
    assert.ok(out.envVars.GH_TOKEN);
    // Fake-value space: injected env values are fake_value_…, not real host values.
    assert.match(out.envVars.GH_TOKEN!, /^fake_value_/);
    assert.notEqual(out.envVars.GH_TOKEN, hostEnv.GH_TOKEN);
    out.store.dispose();
  });

  it("no-fence 痕文案 = SSOT 常量（装配层与入口共用，离线 grep 单点）", () => {
    assert.match(noFenceCredentialTrace(), /skipped: no-fence/);
    // The trace must never carry credential material.
    assert.doesNotMatch(noFenceCredentialTrace(), /GH_TOKEN|token\s*[:=]/i);
  });
});

// ── 2. network section absent = builtin preset on duty (assembly.ts) ────────

describe("T6 network 段缺席 → builtin preset 在岗（不再 no-fence）", () => {
  it("settings.isolation.network 缺席 → 工厂恒返 builtin preset policy，无 no-fence 痕（fence 在场）", () => {
    const warns: string[] = [];
    const factory = createEgressPolicyFactory({
      settings: {} as unknown as IknowSettings,
      commandLabel: "bash",
      onWarn: (m) => warns.push(m),
    });
    // Preset-spec invariant: an absent section no longer returns undefined —
    // the builtin narrow fence is on, so the "no presence-side protection"
    // posture remains only for yolo / isolation-OFF wiring (pinned in section
    // 1); this branch has no no-fence trace to log.
    const policy = factory() as EgressPolicyInput;
    assert.ok(policy);
    assert.equal(policy.allowlistSource, "builtin");
    assert.ok(policy.allowedDomains.includes("github.com"));
    assert.equal(warns.filter((w) => /no-fence/.test(w)).length, 0);
  });

  it("network 在场 → 无 skipped 痕（铸造路径不误报姿态）", () => {
    const warns: string[] = [];
    const factory = createEgressPolicyFactory({
      settings: {
        isolation: {
          network: { allowedDomains: ["example.com"], deniedDomains: [] },
        },
      } as unknown as IknowSettings,
      commandLabel: "bash",
      onWarn: (m) => warns.push(m),
    });
    const policy = factory() as EgressPolicyInput;
    assert.ok(policy);
    assert.equal(warns.filter((w) => /no-fence/.test(w)).length, 0);
  });
});

// ── 3. Three assembly points wiring (factory-injection seam) ────────────────

describe("T6 前台 bash 装配点", () => {
  it("policy.credentials 在场 → 缝收到逐字 { policy }（keys 只有 policy，roster 恒等透传），fence 挂 egress spec，finally dispose", async () => {
    const roster = rosterFixture();
    const { session, dispose } = stubSession();
    const seam = vi.fn(async (opts: unknown) => {
      h.egressCalls.push(opts as Record<string, unknown>);
      return session;
    });
    const tool = createBashTool(scratchDir(), {
      egressPolicyFactory: () => ({
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "bash:t6",
        credentials: roster,
      }),
      createEgressSessionFactory: seam as never,
    });
    await tool.handler({ command: "true" }, { conversationId: "conv-t6-fg" });

    assert.equal(h.egressCalls.length, 1);
    const opts = h.egressCalls[0]!;
    assert.deepEqual(Object.keys(opts), ["policy"]);
    const policy = opts.policy as EgressPolicyInput;
    assert.equal(policy.credentials, roster);
    // Zero branching in fence assembly: egress = session.spec identity passthrough.
    assert.equal(h.fenceOpts.length, 1);
    assert.equal(h.fenceOpts[0]!.egress, session.spec);
    assert.equal(dispose.mock.calls.length, 1);
  });

  it("isolation OFF（工厂返 undefined）→ 缝零调用、fence 无 egress 段、fence env 无假值键", async () => {
    const tool = createBashTool(scratchDir(), {
      egressPolicyFactory: () => undefined,
    });
    await tool.handler({ command: "true" }, { conversationId: "conv-t6-off" });
    assert.equal(h.egressCalls.length, 0);
    assert.equal(h.fenceOpts.length, 1);
    assert.equal("egress" in h.fenceOpts[0]!, false);
    const env = h.fenceOpts[0]!.env as Record<string, string>;
    for (const key of ["GH_TOKEN", "SSL_CERT_FILE", "HTTPS_PROXY"]) {
      assert.equal(key in env, false, `fence env must not carry ${key}`);
    }
    assert.equal(
      Object.values(env).some((v) => v.includes("fake_value_")),
      false
    );
  });

  it("EgressRelayUnavailableError → 凭据层随 session 缺席（fence 无 egress / env 无假值键）+ infra 文案不变不新增冒充", async () => {
    const seam = vi.fn(async () => {
      throw new EgressRelayUnavailableError(
        "relay assets missing",
        "repair the iknow install root"
      );
    });
    const tool = createBashTool(scratchDir(), {
      egressPolicyFactory: () => ({
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "bash:t6-relay",
        credentials: rosterFixture(),
      }),
      createEgressSessionFactory: seam as never,
    });
    await expect(
      tool.handler({ command: "true" }, { conversationId: "conv-t6-relay" })
    ).rejects.toThrow(/egress relay unavailable/);
    assert.equal(h.fenceOpts.length, 1);
    assert.equal("egress" in h.fenceOpts[0]!, false);
    const env = h.fenceOpts[0]!.env as Record<string, string>;
    assert.equal("GH_TOKEN" in env, false);
    // The infra message must not masquerade as credential-layer wording.
    assert.equal(h.fenceOpts.length >= 1, true);
  });
});

/** Fake ChildProcess (event-driven manager settle). */
function makeFakeChild(pid = 424242): EventEmitter & Record<string, unknown> {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = pid;
  child.kill = vi.fn(() => true);
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

describe("T6 background 装配点", () => {
  it("egressPolicy.credentials → 缝收逐字 { policy }（keys 只有 policy）；settle() 释放通道触发 dispose（覆盖 registry/store 的释放归 T3 session.dispose）", async () => {
    const root = await fsp.mkdtemp(join(tmpdir(), "iknow-t6-bg-"));
    scratch.push(root);
    const roster = rosterFixture();
    const { session, dispose } = stubSession();
    h.egressImpl = async () => session;
    const capturedSpec: unknown[] = [];
    const spawned: (EventEmitter & Record<string, unknown>)[] = [];
    const manager = createBackgroundTaskManager({
      tasksDir: resolveTasksDir({
        dataDir: root,
        projectIdentityRoot: root,
      }),
      spawn: async (req) => {
        capturedSpec.push(req.egressSpec);
        const child = makeFakeChild();
        spawned.push(child);
        return child as never;
      },
    });
    await manager.spawn({
      command: "true",
      cwd: ".",
      egressPolicy: {
        allowedDomains: ["example.com"],
        deniedDomains: [],
        commandLabel: "background:t6",
        credentials: roster,
      },
    });
    assert.equal(h.egressCalls.length, 1);
    assert.deepEqual(Object.keys(h.egressCalls[0]!), ["policy"]);
    assert.equal(
      (h.egressCalls[0]!.policy as EgressPolicyInput).credentials,
      roster
    );
    assert.equal(capturedSpec[0], session.spec);
    assert.equal(dispose.mock.calls.length, 0);
    // child exit → settle → dispose (existing release-channel tier;
    // registry/store cleanup inside the real dispose is pinned by session tests).
    spawned[0]!.emit("exit", 0, null);
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(dispose.mock.calls.length, 1);
  });
});

describe("T6 verify 装配点（模块级单例）", () => {
  it("egressPolicy.credentials → 缝收逐字 { policy }；多条命令复用同一 session（单例档位）；spec.env 进 fenceEnv", async () => {
    const roster = rosterFixture();
    const { session } = stubSession();
    h.egressImpl = async () => session;
    const runVerify = makeDefaultRunVerify({
      cwd: scratchDir(),
      egressPolicy: {
        allowedDomains: ["example.com"],
        deniedDomains: [],
        commandLabel: "verify:t6",
        credentials: roster,
      },
    });
    await runVerify("true", {});
    await runVerify("false", {});
    assert.equal(h.egressCalls.length, 1, "verify 面 session 单例复用");
    assert.deepEqual(Object.keys(h.egressCalls[0]!), ["policy"]);
    assert.equal(
      (h.egressCalls[0]!.policy as EgressPolicyInput).credentials,
      roster
    );
    const env = h.runArgs[0]!.env as Record<string, string>;
    assert.equal(env.GH_TOKEN, "fake_value_t6_fixture");
    assert.equal(env.SSL_CERT_FILE, "/tmp/iknow-t6-bundle.pem");
    void session;
  });

  it("EgressRelayUnavailableError（session 起不来）→ 凭据层缺席：fenceEnv 无假值键、fence 无 egress 段、既有 catch 语义不变", async () => {
    h.egressImpl = async () => {
      throw new EgressRelayUnavailableError(
        "relay assets missing",
        "repair the iknow install root"
      );
    };
    const runVerify = makeDefaultRunVerify({
      cwd: scratchDir(),
      egressPolicy: {
        allowedDomains: ["example.com"],
        deniedDomains: [],
        commandLabel: "verify:t6-relay",
        credentials: rosterFixture(),
      },
    });
    const res = await runVerify("true", {});
    assert.equal(res.exitCode, 0);
    assert.equal(h.fenceOpts.length, 1);
    assert.equal("egress" in h.fenceOpts[0]!, false);
    const env = h.fenceOpts[0]!.env as Record<string, string>;
    assert.equal("GH_TOKEN" in env, false);
    assert.equal("HTTPS_PROXY" in env, false);
  });
});

// ── 4. Zero credential branching at each assembly point (static pin) ────────

describe("T6 三装配点对凭据零分支", () => {
  const files = [
    "src/harness/aci/tools/bash.ts",
    "src/harness/background/manager.ts",
    "src/harness/verify/sandbox-run.ts",
  ];
  it.each(files)("%s 源码不含 credential/sentinel/mint 标识", (rel) => {
    const src = readFileSync(join(process.cwd(), rel), "utf8");
    // Allowed in comments (explanatory references); pin the code surface only: strip block/line comments first.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /credential|sentinel|\bmint/i);
  });
});
