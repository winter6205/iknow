/**
 * Shape pins for the conditional `SSH_AUTH_SOCK` form (default **off**), per
 * specs/egress-ssh-bridge.md, ADR-0105 Decision 5 and ADR-0107 Decision 5 (ssh
 * auth sock probe).
 *
 * Pinned invariants:
 *   - off (default, caller passes no `sshAuthSockPath`): `SSH_AUTH_SOCK` exists
 *     in neither the fence env nor argv — the host agent's value never enters
 *     the fence (outside the env allowlist + the session injects nothing);
 *   - on = the host agent socket path gets a `--bind` in the same segment (the
 *     egress bind segment: after workspaceMounts, before cwdReadonly/proc/dev,
 *     last-mount-wins ordering) + `SSH_AUTH_SOCK` enters `spec.env` (single
 *     channel: `--setenv` after `--clearenv`);
 *   - same dispose channel as the egress bridge: `session.dispose()` closes the
 *     unix listener + deletes the session-owned egress socket; the agent socket
 *     path is **not session-owned**, so dispose must never delete the host agent socket;
 *   - fail-closed guidance: on but the agent socket is missing (no agent / path
 *     does not exist) → typed `SshAgentUnavailableError` (infra-classified), and
 *     the failure message carries the one-line guidance of host-side `ssh-add`
 *     or a passphrase-less key; the throw happens before server start / listen
 *     (never leaving a half-open "bind without seam" shape);
 *   - classification: an unreachable agent socket is infra, not a domain denial —
 *     the credential seam never passes through the filter, so the violation sink
 *     stays empty (no second violation surface is opened).
 *
 * Injection strategy same as `egress-session.test.ts`: relayResolver /
 * socketPathFactory fully mocked, no dependency on host node layout or asset placement.
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEgressSession,
  SshAgentUnavailableError,
  type EgressSession,
} from "../../../src/harness/sandbox/egress/session.js";
import type { EgressRelayPaths } from "../../../src/harness/sandbox/egress/relay-assets.js";
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

/** Fixed fake relay path set (shape copied from egress-session.test.ts). */
const STUB_RELAY: EgressRelayPaths = {
  nodePath: "/test-root/bin/node",
  relayDir: "/test-root/vendor/egress-relay",
  bridgeScriptPath: "/test-root/vendor/egress-relay/egress-tcp-relay.mjs",
  connectScriptPath: "/test-root/vendor/egress-relay/egress-http-connect.mjs",
};

/** Build an "existing" agent socket fixture (the seam shape only needs existsSync to pass). */
function fakeAgentSocket(dir: string): string {
  const p = join(dir, "host-ssh-agent.sock");
  writeFileSync(p, "", "utf8");
  return p;
}

async function makeSession(opts: {
  readonly sshAuthSockPath?: string;
}): Promise<{
  readonly session: EgressSession;
}> {
  const session = await createEgressSession({
    policy: {
      allowedDomains: ["github.com"],
      deniedDomains: [],
      commandLabel: "t6-test",
    },
    relayResolver: () => STUB_RELAY,
    socketPathFactory: (id) => join(scratchDir(), `egress-${id}.sock`),
    ...(opts.sshAuthSockPath !== undefined
      ? { sshAuthSockPath: opts.sshAuthSockPath }
      : {}),
  });
  return { session };
}

/**
 * Assemble a full fence argv in workspace mode + cwdReadonly from the session's
 * real spec: all three layers (workspaceMounts / egress bind / cwdReadonly) must
 * be present to pin the agent bind's in-segment placement (invariant 7 / argv
 * order discipline).
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
    const { session } = await makeSession({
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
      const relayRoIdx = tripleIdx(
        argv,
        "--ro-bind",
        session.spec.relayAssetsDir
      );
      const agentBindIdx = tripleIdx(argv, "--bind", agent);
      const procIdx = argv.indexOf("--proc");
      // in-segment placement: workspaceMounts(home) < egress socket bind < relay
      // assets ro-bind < agent bind < proc/dev (ADR-0107 segment order: seam body
      // → bundled pieces → conditional credential).
      expect(homeRoIdx).toBeGreaterThan(-1);
      expect(egressSocketIdx).toBeGreaterThan(homeRoIdx);
      expect(relayRoIdx).toBeGreaterThan(egressSocketIdx);
      expect(agentBindIdx).toBeGreaterThan(relayRoIdx);
      expect(agentBindIdx).toBeLessThan(procIdx);

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

  it("与 egress 缝同 dispose 通道：dispose 删自有 egress socket、不删宿主 agent socket，且幂等", async () => {
    const agent = fakeAgentSocket(scratchDir());
    const { session } = await makeSession({
      sshAuthSockPath: agent,
    });
    const egressSocketPath = session.spec.unixSocketPath;
    // the server itself listens on the unix socket — the file really exists while the session lives.
    expect(existsSync(egressSocketPath)).toBe(true);

    await session.dispose();
    expect(existsSync(egressSocketPath)).toBe(false);
    // the agent socket is not session-owned — dispose must never delete the host path
    expect(existsSync(agent)).toBe(true);
    // idempotent (ADR-0097 dispose contract)
    await session.dispose();
    expect(existsSync(agent)).toBe(true);
  });
});

describe("SSH_AUTH_SOCK 条件形态 — fail-closed 与归类", () => {
  it("开态但 agent socket 缺失 → SshAgentUnavailableError（infra），含「宿主侧 ssh-add 或无口令 key」指引，且不起缝", async () => {
    const missing = join(scratchDir(), "no-such-agent.sock");
    let socketPathUsed: string | undefined;
    let err: unknown;
    try {
      await createEgressSession({
        policy: {
          allowedDomains: ["github.com"],
          deniedDomains: [],
          commandLabel: "t6-missing-agent",
        },
        relayResolver: () => STUB_RELAY,
        socketPathFactory: (id) => {
          socketPathUsed = join(scratchDir(), `egress-${id}.sock`);
          return socketPathUsed;
        },
        sshAuthSockPath: missing,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SshAgentUnavailableError);
    expect((err as SshAgentUnavailableError).message).toContain(
      "宿主侧 `ssh-add` 或无口令 key"
    );
    // fail-fast: the throw happens before socket path allocation / server start
    // (never leaving a half-open "bind without seam" shape).
    expect(socketPathUsed).toBeUndefined();
  });

  it("F8 归类：agent socket 在场但为亡文件（连不上=infra）→ 缝形状照常装配，违例 sink 恒空（不冒充域拒绝）", async () => {
    const { session } = await makeSession({
      sshAuthSockPath: fakeAgentSocket(scratchDir()),
    });
    try {
      // the credential seam never passes through the filter: no domain decision happens during the session → drain is empty.
      expect(session.violationSink.drain()).toEqual([]);
    } finally {
      await session.dispose();
    }
    expect(session.violationSink.drain()).toEqual([]);
  });
});
