/**
 * Foreground egress ownership during fence preparation.
 *
 * A typed protected-target refusal can happen after a per-call egress session
 * starts but before runInSandbox takes over cleanup. Keep that refusal intact,
 * dispose the session once, and do not spawn a child.
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  EgressSession,
  EgressSessionOptions,
} from "../../../src/harness/sandbox/egress/session.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
  };
});

const childProcessMock = await import("node:child_process");
const spawnMock = childProcessMock.spawn as unknown as ReturnType<typeof vi.fn>;

const { createBashTool } =
  await import("../../../src/harness/aci/tools/bash.js");
const { ToolExecutionError } = await import("../../../src/harness/errors.js");
const { createEgressViolationSink } =
  await import("../../../src/harness/sandbox/egress/violations.js");

const FIX_ROOT = mkdtempSync(join(tmpdir(), "bash-egress-prepare-cleanup-"));
const FIX_CWD = join(FIX_ROOT, "cwd");
const FIX_HOME = join(FIX_ROOT, "synthetic-home");
const NON_DIRECTORY_WORKSPACE = join(FIX_ROOT, "workspace-file");
const CYCLE_WORKSPACE = join(FIX_ROOT, "cycle-workspace");

mkdirSync(FIX_CWD);
mkdirSync(FIX_HOME);
mkdirSync(CYCLE_WORKSPACE);
writeFileSync(NON_DIRECTORY_WORKSPACE, "synthetic workspace marker\n");
symlinkSync("cycle-b.pem", join(CYCLE_WORKSPACE, "cycle-a.pem"));
symlinkSync("cycle-a.pem", join(CYCLE_WORKSPACE, "cycle-b.pem"));

afterAll(() => {
  rmSync(FIX_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  spawnMock.mockReset();
});

function makeTool(
  dispose: () => Promise<void>,
  workspaceRoot = NON_DIRECTORY_WORKSPACE
): {
  readonly tool: ReturnType<typeof createBashTool>;
  readonly factoryCalls: () => number;
  readonly disposeCalls: () => number;
} {
  let factoryCallCount = 0;
  let disposeCallCount = 0;
  const createSession = async (
    _options: EgressSessionOptions
  ): Promise<EgressSession> => {
    factoryCallCount += 1;
    return {
      id: "synthetic-egress-session",
      spec: {
        unixSocketPath: join(FIX_ROOT, "synthetic-egress.sock"),
        sandboxLocalPort: 0,
        env: {},
        innerBridgeScript: "",
        relayAssetsDir: join(FIX_ROOT, "relay-assets"),
      },
      violationSink: createEgressViolationSink(),
      dispose: async () => {
        disposeCallCount += 1;
        await dispose();
      },
    };
  };

  return {
    tool: createBashTool(FIX_CWD, {
      homeRoot: FIX_HOME,
      workspaceRoot,
      egressPolicyFactory: () => ({
        allowedDomains: [],
        deniedDomains: [],
        commandLabel: "synthetic preparation refusal",
      }),
      createEgressSessionFactory: createSession,
    }),
    factoryCalls: () => factoryCallCount,
    disposeCalls: () => disposeCallCount,
  };
}

describe("foreground egress cleanup during protected-fence preparation", () => {
  it("disposes a started session once when inventory validation refuses before spawn", async () => {
    const { tool, factoryCalls, disposeCalls } = makeTool(
      async () => undefined
    );
    const invocation = tool.handler({ command: "true" });

    await expect(invocation).rejects.toBeInstanceOf(ToolExecutionError);
    await expect(invocation).rejects.toThrow("is not a directory");
    expect(factoryCalls()).toBe(1);
    expect(disposeCalls()).toBe(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("preserves typed refusal and release evidence when session disposal fails", async () => {
    const { tool, factoryCalls, disposeCalls } = makeTool(async () => {
      throw new Error("synthetic disposal failure");
    });
    const invocation = tool.handler({ command: "true" });

    await expect(invocation).rejects.toBeInstanceOf(ToolExecutionError);
    await expect(invocation).rejects.toThrow("is not a directory");
    await expect(invocation).rejects.toThrow(
      "[egress_release] egress session release failed: synthetic disposal failure"
    );
    expect(factoryCalls()).toBe(1);
    expect(disposeCalls()).toBe(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("disposes once when fence materialization refuses a protected symlink cycle", async () => {
    const { tool, factoryCalls, disposeCalls } = makeTool(
      async () => undefined,
      CYCLE_WORKSPACE
    );
    const invocation = tool.handler({ command: "true" });

    await expect(invocation).rejects.toBeInstanceOf(ToolExecutionError);
    await expect(invocation).rejects.toThrow(
      /could not resolve match .* \(ELOOP\); refusing/
    );
    expect(factoryCalls()).toBe(1);
    expect(disposeCalls()).toBe(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
