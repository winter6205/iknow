/**
 * MCP manager lifecycle / concurrency / registerExternal wiring unit tests.
 *
 * Covers the manager spec's acceptance points:
 *  - state machine pending → connected | failed | disabled
 *  - start() returns early, connections finish in the background
 *  - registration timeout (30s) → failed + warn
 *  - connected → registerExternal appends, discover sees the tools
 *  - list_changed re-registration: in-flight callTool not interrupted + no duplicate same-name
 *  - shutdown cancels in-flight calls + SIGTERMs stdio descendants
 *  - onclose → failed, no reconnect
 *
 * Stub clients test client semantics; SIGTERM child processes use real node
 * subprocesses to assert the signal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";

import type { Tool as McpTool } from "@modelcontextprotocol/client";
import type { AciToolDef } from "../../src/harness/aci/types.ts";
import { createAciRegistry } from "../../src/harness/aci/aci-registry.ts";

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createMcpManager,
  createRealClient,
  type McpCallResult,
  type McpClientHandle,
  type McpManager,
} from "../../src/harness/mcp/manager.ts";
import type { McpServerConfig } from "../../src/harness/mcp/config.ts";
import { McpLifecycleError } from "../../src/harness/errors.ts";

/** Absolute workspace root used by manager cwd contract tests. */
const TEST_WORKSPACE_ROOT = "/tmp/iknow-mcp-manager-test-workspace";

// ---------------------------------------------------------------------------
// Stub client
// ---------------------------------------------------------------------------

interface StubClientOptions {
  /** Milliseconds to wait before connect; -1 means never finishes; omitted = immediate. */
  connectDelayMs?: number;
  /** Reject at connect; triggers the failed path. */
  rejectConnect?: boolean;
  /** Delay of the first listTools after connect (for slow-connect tests). */
  firstListToolsDelayMs?: number;
  /** Initial tool list returned by listTools after connect. */
  initialTools?: McpTool[];
  /** callTool delay (convenient for constructing "in-flight"). */
  callToolDelayMs?: number;
  /** callTool rejects; contrast for shutdown-cancel against a real business error. */
  rejectCallTool?: boolean;
  /** mock handles — both defaulted to [] by makeStubClient, so optional here. */
  listChangedHandlers?: Array<(tools: McpTool[]) => void>;
  closeHandlers?: Array<() => void>;
}

/**
 * Fully in-memory fake client. Exposes:
 *  - `triggerListChanged(tools)` — tests can fire the list_changed callback synchronously;
 *  - `triggerClose()` — tests can simulate server close (onclose → failed).
 */
function makeStubClient(opts: StubClientOptions): McpClientHandle {
  const handlers: StubClientOptions = {
    ...opts,
    listChangedHandlers: [],
    closeHandlers: [],
  };

  let connected = false;

  const handle: McpClientHandle = {
    connect: async () => {
      const d = handlers.connectDelayMs ?? 0;
      if (d === -1) {
        // never resolves; external timeout marks failed
        await new Promise<never>(() => {});
        return;
      }
      if (d > 0) await new Promise((r) => setTimeout(r, d));
      if (handlers.rejectConnect) throw new Error("stub: connect rejected");
      connected = true;
    },
    listTools: async () => {
      const d = handlers.firstListToolsDelayMs ?? 0;
      if (d > 0) await new Promise((r) => setTimeout(r, d));
      if (!connected) throw new Error("stub: not connected");
      return handlers.initialTools ?? [];
    },
    callTool: async (
      _name: string,
      _args: unknown,
      options?: {
        readonly timeout?: number;
        readonly signal?: AbortSignal;
        readonly resetTimeoutOnProgress?: boolean;
      }
    ): Promise<McpCallResult> => {
      // check abort: shutdown/timeout passes a signal
      const signal = options?.signal;
      const d = handlers.callToolDelayMs ?? 0;
      if (d > 0) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, d);
          if (signal) {
            const onAbort = () => {
              clearTimeout(t);
              reject(
                Object.assign(new Error("aborted"), {
                  name: "AbortError" as const,
                })
              );
            };
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
          }
        });
      }
      if (signal?.aborted) {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
      if (handlers.rejectCallTool) throw new Error("stub: callTool rejected");
      // McpCallResult wraps the SDK result: the content array is one level down.
      return {
        result: { content: [{ type: "text", text: "ok" }] },
      } satisfies McpCallResult;
    },
    close: async () => {
      connected = false;
    },
    onListChanged: (cb) => {
      handlers.listChangedHandlers!.push(cb);
    },
    onClose: (cb) => {
      handlers.closeHandlers!.push(cb);
    },
    // The resource channel is part of the handle contract; the tool-channel
    // tests never read it, so empty results are the honest stub.
    listResources: async () => ({ resources: [] }),
    readResource: async () => ({ contents: [] }),
    // expose manual triggers
    ...({
      _triggerListChanged: (tools: McpTool[]) => {
        for (const cb of handlers.listChangedHandlers!) cb(tools);
      },
      _triggerClose: () => {
        for (const cb of handlers.closeHandlers!) cb();
      },
    } as unknown as Record<string, unknown>),
  };
  // attach directly to opts so the builder can reach it too
  (handle as unknown as { _opts: StubClientOptions })._opts = handlers;
  return handle;
}

const sampleTool = (name: string): McpTool => ({
  name,
  description: `${name} description`,
  inputSchema: { type: "object", properties: { value: { type: "string" } } },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStdio(
  name: string,
  status: "enabled" | "disabled" = "enabled"
): McpServerConfig {
  return {
    name,
    kind: "stdio",
    source: "user",
    status,
    entry: { command: "node", args: ["./fake-mcp.js"] },
  };
}

/** collect warn lines similar to config.test.ts */
let warnCalls: string[] = [];
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnCalls = [];
  warnSpy = vi
    .spyOn(console, "warn")
    .mockImplementation((...args: unknown[]) => {
      warnCalls.push(args.map((a) => String(a)).join(" "));
    });
});

afterEach(() => {
  warnSpy.mockRestore();
});

/** Wait for the manager to finish background connect + tool registration. */
async function waitForStatus(
  manager: McpManager,
  name: string,
  state: "connected" | "failed" | "pending",
  timeoutMs = 5000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = manager.status().find((x) => x.name === name);
    if (s && s.state === state) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  const s = manager.status().find((x) => x.name === name);
  throw new Error(
    `waitForStatus: name=${name} wanted=${state} got=${s?.state} after ${timeoutMs}ms`
  );
}

// =========================================================================
// State machine (start() early return)
// =========================================================================

describe("MCP manager — state machine", () => {
  it("skips connecting to disabled servers", async () => {
    const handles: McpClientHandle[] = [];
    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
      config: [makeStdio("d1", "disabled")],
      registerExternal: () => {},
      createClient: () => {
        const h = makeStubClient({
          listChangedHandlers: [],
          closeHandlers: [],
        });
        handles.push(h);
        return h;
      },
    });

    await mgr.start();
    expect(mgr.status()).toHaveLength(1);
    expect(mgr.status()[0]?.state).toBe("disabled");
    expect(handles).toHaveLength(0); // never constructed
    await mgr.shutdown();
  });

  it("start() returns before a slow connect finishes (SC8)", async () => {
    let connectResolve!: () => void;
    const handles: McpClientHandle[] = [];
    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
      config: [makeStdio("slow")],
      registerExternal: () => {},
      createClient: () => {
        const handle = makeStubClient({
          listChangedHandlers: [],
          closeHandlers: [],
        });
        // override connect: use a controllable promise
        const slowConnect = new Promise<void>((res) => {
          connectResolve = res;
        });
        (handle as unknown as { connect: () => Promise<void> }).connect =
          async () => {
            await slowConnect;
          };
        // listTools: returns only after connect
        (
          handle as unknown as { listTools: () => Promise<McpTool[]> }
        ).listTools = async () => {
          await slowConnect;
          return [];
        };
        handles.push(handle);
        return handle;
      },
    });

    const t0 = Date.now();
    await mgr.start();
    const elapsed = Date.now() - t0;

    // early return: start() resolves immediately
    expect(elapsed).toBeLessThan(200);
    expect(mgr.status()[0]?.state).toBe("pending");

    connectResolve(); // release the background connect
    await waitForStatus(mgr, "slow", "connected", 2000);
    await mgr.shutdown();
  });

  it("transitions pending → connected and registers tools via registerExternal", async () => {
    const initial: McpTool[] = [sampleTool("echo"), sampleTool("ping")];
    let registered: AciToolDef[] = [];
    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
      config: [makeStdio("good")],
      registerExternal: (defs) => {
        registered = [...defs];
      },
      createClient: () =>
        makeStubClient({
          initialTools: initial,
          listChangedHandlers: [],
          closeHandlers: [],
        }),
    });

    await mgr.start();
    await waitForStatus(mgr, "good", "connected", 2000);

    // must feed mcp__-prefixed tools into registerExternal
    expect(registered.map((d) => d.name).sort()).toEqual([
      "mcp__good__echo",
      "mcp__good__ping",
    ]);
    // registered tools are visible in the catalog — install once through the real AciRegistry
    const reg = createAciRegistry([]);
    for (const d of registered) reg.registerExternal([d]);
    expect(reg.catalog.get("mcp__good__echo")).toBeDefined();

    await mgr.shutdown();
  });
});

// =========================================================================
// 30s connect timeout
// =========================================================================

describe("MCP manager — 30s connect timeout (SC9)", () => {
  it("marks timed-out server as failed + warn without blocking others", async () => {
    let slowConnectResolve!: () => void;
    const createCalls: string[] = [];

    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
      config: [makeStdio("slow"), makeStdio("fast")],
      registerExternal: () => {},
      timeoutMsOverride: 80, // shrink for testability
      createClient: (server) => {
        createCalls.push(server.name);
        if (server.name === "slow") {
          const handle = makeStubClient({
            listChangedHandlers: [],
            closeHandlers: [],
          });
          (handle as unknown as { connect: () => Promise<void> }).connect =
            () =>
              new Promise<void>((res) => {
                slowConnectResolve = res;
              });
          (
            handle as unknown as { listTools: () => Promise<McpTool[]> }
          ).listTools = async () => {
            await new Promise((r) => setTimeout(r, 5));
            // After release this is "timeout + late listTools that truly throws" — stays failed.
            // flip-back only applies to "timeout + late success";
            // a late failure never flips back. This case is the anchor for the failure path.
            throw new Error("stub: listTools rejected after timeout");
          };
          return handle;
        }
        return makeStubClient({
          initialTools: [sampleTool("t")],
          listChangedHandlers: [],
          closeHandlers: [],
        });
      },
    });

    await mgr.start();
    await waitForStatus(mgr, "slow", "failed", 2000);
    await waitForStatus(mgr, "fast", "connected", 2000);

    expect(mgr.status().find((s) => s.name === "slow")?.state).toBe("failed");
    expect(mgr.status().find((s) => s.name === "fast")?.state).toBe(
      "connected"
    );
    expect(
      warnCalls.some((w) => w.includes("slow") && w.includes("timeout"))
    ).toBe(true);

    // Release slow: the late listTools truly throws → stays failed (timeout + late failure never flips).
    // Contrast: only "timeout + late success" flips back to connected.
    slowConnectResolve?.();
    await new Promise((r) => setTimeout(r, 50));
    expect(mgr.status().find((s) => s.name === "slow")?.state).toBe("failed");

    await mgr.shutdown();
    expect(createCalls).toContain("slow");
    expect(createCalls).toContain("fast");
  });
});

// =========================================================================
// connect-timeout "late success" flip-back semantics
// =========================================================================

describe("MCP manager — connect timeout late-success flip-back (#378)", () => {
  it("flips a timed-out slot back to connected when connect+listTools late-succeed (root cause A)", async () => {
    // Slow connect: the timeout fires first (failed + timedOut) → then connect
    // succeeds → listTools late-succeeds → flip-back to connected within the same bootSlot task.
    let slowConnectResolve!: () => void;
    let registered: AciToolDef[] = [];

    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
      config: [makeStdio("slow")],
      timeoutMsOverride: 60,
      registerExternal: (defs) => {
        registered = [...registered, ...defs];
      },
      createClient: () => {
        const handle = makeStubClient({
          listChangedHandlers: [],
          closeHandlers: [],
        });
        (handle as unknown as { connect: () => Promise<void> }).connect = () =>
          new Promise<void>((res) => {
            slowConnectResolve = res;
          });
        (
          handle as unknown as { listTools: () => Promise<McpTool[]> }
        ).listTools = async () => {
          await new Promise((r) => setTimeout(r, 5));
          return [sampleTool("echo")];
        };
        return handle;
      },
    });

    await mgr.start();

    // 1) timeout fires first → marked failed + warn
    await waitForStatus(mgr, "slow", "failed", 2000);
    expect(
      warnCalls.some((w) => w.includes("slow") && w.includes("timeout"))
    ).toBe(true);

    // 2) late success → flip-back to connected within the same boot task + tools registered
    slowConnectResolve();
    await waitForStatus(mgr, "slow", "connected", 2000);
    expect(registered.map((d) => d.name)).toEqual(["mcp__slow__echo"]);

    await mgr.shutdown();
  });

  it("does NOT flip back when connect fails before any timeout (true failure, error wins)", async () => {
    // Failure path: connect truly rejects before any timeout → timedOut is never
    // set → failed is final, and it stays failed even past the timeout window
    // (the catch clearTimeout'd the timer).
    let rejectConnect!: (err: Error) => void;
    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
      config: [makeStdio("slow")],
      timeoutMsOverride: 200,
      registerExternal: () => {},
      createClient: () => {
        const handle = makeStubClient({
          listChangedHandlers: [],
          closeHandlers: [],
        });
        (handle as unknown as { connect: () => Promise<void> }).connect = () =>
          new Promise<void>((_res, rej) => {
            rejectConnect = rej;
          });
        return handle;
      },
    });

    await mgr.start();
    rejectConnect(new Error("stub: hard connect failure"));
    await waitForStatus(mgr, "slow", "failed", 2000);

    // Wait past the timeout window: had the timer not been cleared it would fire markFailed —
    // assert that did not happen (no spurious flip, error not overwritten).
    await new Promise((r) => setTimeout(r, 300));
    const s = mgr.status().find((x) => x.name === "slow")!;
    expect(s.state).toBe("failed");
    expect(s.error).toContain("hard connect failure");
    expect(s.error).not.toContain("timeout");

    await mgr.shutdown();
  });

  it("keeps failed when listTools itself throws after a timeout (exception path)", async () => {
    // Timeout already fired (failed + timedOut) → listTools throws late → the catch's
    // markFailed is blocked by the "no repeat marking on failed" guard: stays failed, no flip.
    // error remains the timeout reason (markFailed does not re-mark, does not overwrite).
    let slowConnectResolve!: () => void;
    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
      config: [makeStdio("slow")],
      timeoutMsOverride: 60,
      registerExternal: () => {},
      createClient: () => {
        const handle = makeStubClient({
          listChangedHandlers: [],
          closeHandlers: [],
        });
        (handle as unknown as { connect: () => Promise<void> }).connect = () =>
          new Promise<void>((res) => {
            slowConnectResolve = res;
          });
        (
          handle as unknown as { listTools: () => Promise<McpTool[]> }
        ).listTools = async () => {
          await new Promise((r) => setTimeout(r, 5));
          throw new Error("stub: listTools exploded");
        };
        return handle;
      },
    });

    await mgr.start();
    await waitForStatus(mgr, "slow", "failed", 2000);

    slowConnectResolve();
    await new Promise((r) => setTimeout(r, 80));
    const s = mgr.status().find((x) => x.name === "slow")!;
    expect(s.state).toBe("failed");
    expect(s.error).toContain("connect timeout");
    expect(s.error).not.toContain("listTools exploded");

    await mgr.shutdown();
  });

  it("flips back even when the timeout fires while listTools is still in flight (boundary: timeout ~ listTools completion)", async () => {
    // Boundary: connect succeeds immediately, listTools is very slow (100ms); the timeout
    // (60ms) fires while listTools is in flight → failed + timedOut → listTools late-succeeds →
    // second guard flips back to connected + tools registered.
    let registered: AciToolDef[] = [];
    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
      config: [makeStdio("slow")],
      timeoutMsOverride: 60,
      registerExternal: (defs) => {
        registered = [...registered, ...defs];
      },
      createClient: () => {
        const handle = makeStubClient({
          listChangedHandlers: [],
          closeHandlers: [],
        });
        (
          handle as unknown as { listTools: () => Promise<McpTool[]> }
        ).listTools = async () => {
          await new Promise((r) => setTimeout(r, 100));
          return [sampleTool("echo")];
        };
        return handle;
      },
    });

    await mgr.start();
    await waitForStatus(mgr, "slow", "failed", 2000);
    expect(
      warnCalls.some((w) => w.includes("slow") && w.includes("timeout"))
    ).toBe(true);

    await waitForStatus(mgr, "slow", "connected", 2000);
    expect(registered.map((d) => d.name)).toEqual(["mcp__slow__echo"]);

    await mgr.shutdown();
  });

  it("does not wrongly flip back when a timeout lands after a genuine failure (concurrent markFailed)", async () => {
    // Concurrent: a true failure settles first (timedOut never set) → the markFailed fired
    // by the later timeout is blocked by the "no repeat marking on failed" guard — state stays
    // failed, error stays the true one, no spurious flip (timedOut was never set, so there is
    // no flip-back channel).
    let rejectConnect!: (err: Error) => void;
    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
      config: [makeStdio("slow")],
      timeoutMsOverride: 200,
      registerExternal: () => {},
      createClient: () => {
        const handle = makeStubClient({
          listChangedHandlers: [],
          closeHandlers: [],
        });
        (handle as unknown as { connect: () => Promise<void> }).connect = () =>
          new Promise<void>((_res, rej) => {
            rejectConnect = rej;
          });
        return handle;
      },
    });

    await mgr.start();
    rejectConnect(new Error("stub: hard connect failure"));
    await waitForStatus(mgr, "slow", "failed", 2000);

    // Wait across the timeout window — the markFailed fired by the timeout must be blocked by the guard
    await new Promise((r) => setTimeout(r, 300));
    const s = mgr.status().find((x) => x.name === "slow")!;
    expect(s.state).toBe("failed");
    expect(s.error).toContain("hard connect failure");
    expect(s.error).not.toContain("timeout");

    await mgr.shutdown();
  });

  it("still moves to failed when the connection closes after flip-back (connected → failed)", async () => {
    let slowConnectResolve!: () => void;
    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
      config: [makeStdio("slow")],
      timeoutMsOverride: 60,
      registerExternal: () => {},
      createClient: () => {
        const handle = makeStubClient({
          listChangedHandlers: [],
          closeHandlers: [],
        });
        (handle as unknown as { connect: () => Promise<void> }).connect = () =>
          new Promise<void>((res) => {
            slowConnectResolve = res;
          });
        (
          handle as unknown as { listTools: () => Promise<McpTool[]> }
        ).listTools = async () => {
          await new Promise((r) => setTimeout(r, 5));
          return [sampleTool("echo")];
        };
        return handle;
      },
    });

    await mgr.start();
    await waitForStatus(mgr, "slow", "failed", 2000);
    slowConnectResolve();
    await waitForStatus(mgr, "slow", "connected", 2000);

    // after flip-back, onclose → failed (no reconnect; onclose does not set timedOut → no flip)
    const handle = (mgr as unknown as { _handles: McpClientHandle[] })
      ._handles[0]!;
    const triggers = handle as unknown as { _triggerClose: () => void };
    triggers._triggerClose();
    await waitForStatus(mgr, "slow", "failed", 2000);
    expect(mgr.status().find((s) => s.name === "slow")?.error).toContain(
      "connection closed by server"
    );

    await mgr.shutdown();
  });

  it("empty: 空 config → 无 slot、status 空、start/shutdown 幂等", async () => {
    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
      config: [],
      registerExternal: () => {},
      createClient: () => makeStubClient({}),
    });
    await mgr.start();
    expect(mgr.status()).toEqual([]);
    await mgr.shutdown();
    // second shutdown is idempotent (no throw, no hang).
    await mgr.shutdown();
  });

  it("negative: timeoutMsOverride 负数 → 立即超时标 failed（envPositiveInt 上游已过滤，此处验证 manager 兜底）", async () => {
    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
      config: [makeStdio("neg")],
      registerExternal: () => {},
      timeoutMsOverride: -1,
      createClient: () =>
        makeStubClient({
          connectDelayMs: 100,
          listChangedHandlers: [],
          closeHandlers: [],
        }),
    });
    await mgr.start();
    // negative timeout → setTimeout(0) semantics → immediate failed; a late connect can still flip back.
    await waitForStatus(mgr, "neg", "failed", 2000);
    await mgr.shutdown();
  });

  it("overflow: 极大 timeoutMsOverride（Number.MAX_SAFE_INTEGER）→ 慢 connect 在窗口内正常 connected", async () => {
    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
      config: [makeStdio("big")],
      registerExternal: () => {},
      timeoutMsOverride: Number.MAX_SAFE_INTEGER,
      createClient: () =>
        makeStubClient({
          connectDelayMs: 30,
          listChangedHandlers: [],
          closeHandlers: [],
        }),
    });
    await mgr.start();
    await waitForStatus(mgr, "big", "connected", 2000);
    await mgr.shutdown();
  });
});

// =========================================================================
// list_changed re-registration: no interrupt of in-flight callTool, no duplicate same-name
// =========================================================================

describe("MCP manager — list_changed re-registration (SC15)", () => {
  it("re-registers on list_changed without duplicating known names and without interrupting in-flight callTool", async () => {
    const initial: McpTool[] = [sampleTool("alpha"), sampleTool("beta")];

    const external: AciToolDef[] = [];
    let registerCount = 0;
    const registerCalls: AciToolDef[][] = [];

    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
      config: [makeStdio("svc")],
      registerExternal: (defs) => {
        registerCount += 1;
        registerCalls.push([...defs]);
        for (const d of defs) external.push(d);
      },
      createClient: () =>
        makeStubClient({
          initialTools: initial,
          callToolDelayMs: 100,
          listChangedHandlers: [],
          closeHandlers: [],
        }),
    });

    await mgr.start();
    await waitForStatus(mgr, "svc", "connected", 2000);
    expect(registerCount).toBe(1); // initial registration

    // trigger an in-flight callTool
    const callHandle = (mgr as unknown as { _handles: McpClientHandle[] })
      ._handles?.[0];
    expect(callHandle).toBeDefined();
    const inflight = callHandle!.callTool("alpha", {}, {});

    // brief wait so callTool enters flight
    await new Promise((r) => setTimeout(r, 20));

    // fire list_changed: adds gamma + re-emits alpha under the same name
    const triggers = callHandle as unknown as {
      _triggerListChanged: (ts: McpTool[]) => void;
    };
    triggers._triggerListChanged([
      sampleTool("alpha"),
      sampleTool("beta"),
      sampleTool("gamma"),
    ]);

    await new Promise((r) => setTimeout(r, 30));
    // the in-flight callTool is not interrupted and resolves normally
    const result = await inflight;
    expect(result.result.content[0]).toMatchObject({
      type: "text",
      text: "ok",
    });

    // registration count: 1 initial + one list_changed re-registering alpha/gamma
    await waitForRegister(() => registerCount, 2, 1000);

    // incremental registration — same-name alpha/beta already registered, only gamma appended
    const last = registerCalls.at(-1)!;
    const newNames = last.map((d) => d.name).sort();
    expect(newNames).toEqual(["mcp__svc__gamma"]);

    // the full external registration set should contain alpha/beta/gamma, no duplicates
    expect(external.map((d) => d.name).sort()).toEqual([
      "mcp__svc__alpha",
      "mcp__svc__beta",
      "mcp__svc__gamma",
    ]);

    await mgr.shutdown();
  });
});

async function waitForRegister(
  fn: () => number,
  wanted: number,
  timeoutMs: number
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn() >= wanted) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitForRegister: wanted>=${wanted} after ${timeoutMs}ms`);
}

// =========================================================================
// shutdown cancel semantics + stdio SIGTERM
// =========================================================================

describe("MCP manager — shutdown (SC11 / SC16)", () => {
  it("shutdown cancels in-flight callTool with a clear rejection (not success, not hanging)", async () => {
    // Go through the ACI tool handler the manager registered — that way mergeAbort
    // chains slot.callAbort into stub.callTool's signal, so shutdown propagates.
    let registered: AciToolDef[] = [];
    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
      config: [makeStdio("svc")],
      registerExternal: (defs) => {
        registered = [...defs, ...registered];
      },
      createClient: () =>
        makeStubClient({
          initialTools: [sampleTool("slowOp")],
          callToolDelayMs: 5000, // 5s long task
          listChangedHandlers: [],
          closeHandlers: [],
        }),
    });

    await mgr.start();
    await waitForStatus(mgr, "svc", "connected", 2000);

    const handler = registered.find((d) => d.name === "mcp__svc__slowOp");
    expect(handler).toBeDefined();
    expect(handler!.handler).toBeDefined();

    const callP = handler!.handler!({}, {});
    await new Promise((r) => setTimeout(r, 30));

    // key: after shutdown the call must reject, with a definite type
    const shutdownP = mgr.shutdown();

    let rejected = false;
    let resolved: unknown = undefined;
    try {
      resolved = await callP;
    } catch (err) {
      rejected = true;
      // must be definite — no hanging, no false success
      expect(err).toBeDefined();
    }
    await shutdownP;
    expect(rejected).toBe(true);
    expect(resolved).toBeUndefined();
  });

  it("client.close is invoked on shutdown", async () => {
    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
      config: [makeStdio("svc")],
      registerExternal: () => {},
      createClient: () =>
        makeStubClient({
          initialTools: [],
          listChangedHandlers: [],
          closeHandlers: [],
        }),
    });

    await mgr.start();
    await waitForStatus(mgr, "svc", "connected", 2000);

    const handle = (mgr as unknown as { _handles: McpClientHandle[] })
      ._handles[0]!;
    await mgr.shutdown();
    // close was invoked: calling close again should resolve immediately (connected=false)
    await expect(handle.close()).resolves.toBeUndefined();
  });

  it("forwards SIGTERM to stdio child subprocess on shutdown (SC11)", async () => {
    /**
     * Real child process: node starts a sleeping subprocess and prints its pid.
     * We hand-construct a McpClientHandle so it spawns this real subprocess
     * (overriding the stub).
     */
    // a sleep + SIGTERM-exit node subprocess that reports its pid
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
          process.on('SIGTERM', () => { console.log('SIGNAL:SIGTERM'); process.exit(143); });
          // 大半秒后输出 pid
          setTimeout(() => {}, 10);
          process.stdout.write('pid:'+process.pid+'\\n');
          setInterval(() => {}, 1000);
        `,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    let pidReported = -1;
    let gotSignal = false;
    child.stdout!.on("data", (b: Buffer) => {
      const s = b.toString();
      const m = s.match(/pid:(\d+)/);
      if (m) pidReported = Number(m[1]);
      if (s.includes("SIGNAL:SIGTERM")) gotSignal = true;
    });

    // wait for the child to report its pid
    const t0 = Date.now();
    while (pidReported < 0 && Date.now() - t0 < 3000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(pidReported).toBeGreaterThan(0);

    // hand-construct a McpClientHandle simulating the manager's stdio handle: close SIGTERMs the child
    const handle: McpClientHandle = {
      connect: async () => {},
      listTools: async () => [],
      callTool: async () => ({
        result: { content: [{ type: "text", text: "x" }] },
      }),
      close: async () => {
        // key — SIGTERM the grandchild
        child.kill("SIGTERM");
      },
      onListChanged: () => {},
      onClose: () => {},
      listResources: async () => ({ resources: [] }),
      readResource: async () => ({ contents: [] }),
    };

    // borrow the manager but replace the createClient factory
    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
      config: [makeStdio("svc")],
      registerExternal: () => {},
      createClient: () => handle,
    });

    await mgr.start();
    await new Promise((r) => setTimeout(r, 20));
    await mgr.shutdown();

    // wait for the grandchild to actually receive the signal
    const t1 = Date.now();
    while (!gotSignal && Date.now() - t1 < 3000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(gotSignal).toBe(true);

    // safety cleanup: if an assertion fails beforehand, avoid leaking the child process
    if (!child.killed) child.kill("SIGTERM");
  });
});

// =========================================================================
// onclose → failed, no reconnect
// =========================================================================

describe("MCP manager — onclose semantics", () => {
  it("moves server to failed state when SDK fires onclose and does not reconnect", async () => {
    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
      config: [makeStdio("svc")],
      registerExternal: () => {},
      createClient: () =>
        makeStubClient({
          initialTools: [],
          listChangedHandlers: [],
          closeHandlers: [],
        }),
    });

    await mgr.start();
    await waitForStatus(mgr, "svc", "connected", 2000);

    const handle = (mgr as unknown as { _handles: McpClientHandle[] })
      ._handles[0]!;
    const triggers = handle as unknown as { _triggerClose: () => void };
    triggers._triggerClose();
    await waitForStatus(mgr, "svc", "failed", 2000);

    // firing again still does not reconnect (remains failed)
    triggers._triggerClose();
    await new Promise((r) => setTimeout(r, 50));
    expect(mgr.status().find((s) => s.name === "svc")?.state).toBe("failed");

    await mgr.shutdown();
  });
});

// =========================================================================
// reload — harness seam for the TUI dashboard refresh
// =========================================================================

describe("MCP manager — reload", () => {
  it("reload replaces server set: renamed / added / removed servers reflected in status()", async () => {
    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
      config: [makeStdio("alpha")],
      registerExternal: () => {},
      createClient: () =>
        makeStubClient({
          initialTools: [],
          listChangedHandlers: [],
          closeHandlers: [],
        }),
    });

    await mgr.start();
    await waitForStatus(mgr, "alpha", "connected", 2000);
    expect(mgr.status().map((s) => s.name)).toEqual(["alpha"]);

    // reload: rename alpha → gamma, add beta, drop the original alpha server
    await mgr.reload([makeStdio("beta"), makeStdio("gamma")]);

    // reload does not block on connections — status immediately reflects the new server set
    expect(mgr.status().map((s) => s.name)).toEqual(["beta", "gamma"]);
    // transitions to connected once background connect finishes
    await waitForStatus(mgr, "beta", "connected", 2000);
    await waitForStatus(mgr, "gamma", "connected", 2000);
    expect(mgr.status().every((s) => s.state === "connected")).toBe(true);

    await mgr.shutdown();
  });

  it("reload aborts an in-flight callTool (reject, never resolve)", async () => {
    let registered: AciToolDef[] = [];
    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
      config: [makeStdio("svc")],
      registerExternal: (defs) => {
        registered = [...defs, ...registered];
      },
      createClient: () =>
        makeStubClient({
          initialTools: [sampleTool("slowOp")],
          callToolDelayMs: 5000,
          listChangedHandlers: [],
          closeHandlers: [],
        }),
    });

    await mgr.start();
    await waitForStatus(mgr, "svc", "connected", 2000);

    const handler = registered.find((d) => d.name === "mcp__svc__slowOp");
    expect(handler).toBeDefined();
    const callP = handler!.handler!({}, {});
    await new Promise((r) => setTimeout(r, 30));

    // reload internally shuts down first → cancels in-flight (reuses shutdown-cancel semantics)
    const reloadP = mgr.reload([makeStdio("svc")]);

    let rejected = false;
    let resolved: unknown = undefined;
    try {
      resolved = await callP;
    } catch (err) {
      rejected = true;
      expect(err).toBeDefined();
    }
    await reloadP;

    expect(rejected).toBe(true);
    expect(resolved).toBeUndefined();
  });

  it("reload with a disabled server does not construct a client and status reflects disabled", async () => {
    const handles: McpClientHandle[] = [];
    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
      config: [makeStdio("svc")],
      registerExternal: () => {},
      createClient: () => {
        const h = makeStubClient({
          initialTools: [],
          listChangedHandlers: [],
          closeHandlers: [],
        });
        handles.push(h);
        return h;
      },
    });

    await mgr.start();
    await waitForStatus(mgr, "svc", "connected", 2000);
    expect(handles).toHaveLength(1);

    // reload to disabled — no client constructed, status goes straight to disabled
    await mgr.reload([makeStdio("svc", "disabled")]);

    expect(handles).toHaveLength(1); // no new client
    expect(mgr.status()).toHaveLength(1);
    expect(mgr.status()[0]).toMatchObject({ name: "svc", state: "disabled" });

    await mgr.shutdown();
  });

  it("reload unregisters stale tool names of a removed server (case A)", async () => {
    const unregistered: string[][] = [];
    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
      config: [makeStdio("alpha")],
      registerExternal: () => {},
      unregisterExternal: (names) => {
        unregistered.push([...names]);
      },
      createClient: () =>
        makeStubClient({
          initialTools: [sampleTool("echo"), sampleTool("ping")],
          listChangedHandlers: [],
          closeHandlers: [],
        }),
    });

    await mgr.start();
    await waitForStatus(mgr, "alpha", "connected", 2000);

    // reload leaving only beta — alpha's registered tool names must be revoked
    await mgr.reload([makeStdio("beta")]);

    expect(unregistered).toHaveLength(1);
    expect(unregistered[0]!.sort()).toEqual([
      "mcp__alpha__echo",
      "mcp__alpha__ping",
    ]);

    await mgr.shutdown();
  });

  it("reload purges stale names and allows same-name re-register without Gate2 duplicate (case B)", async () => {
    // Real AciRegistry assembly: registerExternal / unregisterExternal closures wired directly.
    // Both servers expose a tool named lookup — without revoking the old name, re-registration hits duplicate.
    const reg = createAciRegistry([]);
    let mgr: McpManager | undefined;
    const createClientFor = (): McpClientHandle =>
      makeStubClient({
        initialTools: [sampleTool("lookup")],
        listChangedHandlers: [],
        closeHandlers: [],
      });
    mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
      config: [makeStdio("old")],
      registerExternal: (defs) => reg.registerExternal(defs),
      unregisterExternal: (names) => reg.unregisterExternal(names),
      createClient: createClientFor,
    });

    await mgr.start();
    await waitForStatus(mgr, "old", "connected", 2000);
    expect(reg.catalog.get("mcp__old__lookup")).toBeDefined();

    // reload: old → new (same tool name lookup). A non-revoked old name would throw duplicate.
    await mgr.reload([makeStdio("new")]);
    await waitForStatus(mgr, "new", "connected", 2000);

    // stale name gone from catalog, new name registered (no RegistryConstructionError)
    expect(reg.catalog.get("mcp__old__lookup")).toBeUndefined();
    expect(reg.catalog.get("mcp__new__lookup")).toBeDefined();

    await mgr.shutdown();
  });

  it("reload without unregisterExternal still works (idempotent, case C)", async () => {
    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
      config: [makeStdio("alpha")],
      registerExternal: () => {},
      // deliberately no unregisterExternal injected
      createClient: () =>
        makeStubClient({
          initialTools: [sampleTool("echo")],
          listChangedHandlers: [],
          closeHandlers: [],
        }),
    });

    await mgr.start();
    await waitForStatus(mgr, "alpha", "connected", 2000);

    await expect(mgr.reload([makeStdio("beta")])).resolves.toBeUndefined();
    await waitForStatus(mgr, "beta", "connected", 2000);
    expect(mgr.status().map((s) => s.name)).toEqual(["beta"]);

    await mgr.shutdown();
  });

  it("reload → 新 server 慢 connect 超时 → failed 且 error 含 connect timeout（T4 #378 reload 冷启动场景）", async () => {
    // createClient dispatches by server name: cold hangs, fast succeeds immediately.
    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
      config: [makeStdio("alpha")],
      registerExternal: () => {},
      timeoutMsOverride: 60,
      createClient: (server) => {
        if (server.name === "cold") {
          const handle = makeStubClient({
            listChangedHandlers: [],
            closeHandlers: [],
          });
          (handle as unknown as { connect: () => Promise<void> }).connect =
            () => new Promise<void>(() => {});
          return handle;
        }
        return makeStubClient({ listChangedHandlers: [], closeHandlers: [] });
      },
    });

    await mgr.start();
    await waitForStatus(mgr, "alpha", "connected", 2000);

    // reload swaps in cold: reload shuts down old + rebuilds + background start (does not block).
    await mgr.reload([makeStdio("cold")]);
    // cold connect never resolves → timeout → failed + error contains connect timeout
    await waitForStatus(mgr, "cold", "failed", 2000);
    expect(mgr.status().find((s) => s.name === "cold")?.error).toContain(
      "connect timeout"
    );

    await mgr.shutdown();
  });
});

// =========================================================================
// workspaceRoot as stdio transport cwd + late-connect lifecycle guard
// =========================================================================

describe("MCP manager — workspaceRoot transport cwd (T4)", () => {
  it("rejects a missing workspaceRoot with McpLifecycleError missing_cwd", () => {
    const badOpts = {
      config: [],
      registerExternal: () => {},
    } as unknown as Parameters<typeof createMcpManager>[0];
    expect(() => createMcpManager(badOpts)).toThrow(McpLifecycleError);
    try {
      createMcpManager(badOpts);
    } catch (err) {
      expect(err).toBeInstanceOf(McpLifecycleError);
      expect((err as McpLifecycleError).kind).toBe("missing_cwd");
    }
  });

  it("rejects a relative workspaceRoot with McpLifecycleError invalid_cwd", () => {
    expect(() =>
      createMcpManager({
        workspaceRoot: "relative/task",
        config: [],
        registerExternal: () => {},
      })
    ).toThrow(McpLifecycleError);
    try {
      createMcpManager({
        workspaceRoot: "relative/task",
        config: [],
        registerExternal: () => {},
      });
    } catch (err) {
      expect(err).toBeInstanceOf(McpLifecycleError);
      expect((err as McpLifecycleError).kind).toBe("invalid_cwd");
    }
  });

  it("passes workspaceRoot as cwd to createClient factory on each spawn", async () => {
    const capturedCwds: string[] = [];
    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
      config: [makeStdio("a"), makeStdio("b")],
      registerExternal: () => {},
      createClient: (_server, transport) => {
        capturedCwds.push(transport.cwd);
        return makeStubClient({
          listChangedHandlers: [],
          closeHandlers: [],
        });
      },
    });

    await mgr.start();
    await waitForStatus(mgr, "a", "connected", 2000);
    await waitForStatus(mgr, "b", "connected", 2000);

    expect(capturedCwds.sort()).toEqual([
      TEST_WORKSPACE_ROOT,
      TEST_WORKSPACE_ROOT,
    ]);
    await mgr.shutdown();
  });

  it("createRealClient forwards cwd to StdioClientTransport (child process.cwd)", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-mcp-cwd-"));
    const marker = join(root, "child-cwd.txt");
    try {
      // Relative command: `./print-cwd.mjs` resolves only when child cwd = root.
      await writeFile(
        join(root, "print-cwd.mjs"),
        [
          "import { writeFileSync } from 'node:fs';",
          `writeFileSync(${JSON.stringify(marker)}, process.cwd());`,
          "setInterval(() => {}, 1000);",
        ].join("\n"),
        "utf8"
      );

      const handle = createRealClient(
        {
          name: "cwd-probe",
          kind: "stdio",
          source: "user",
          status: "enabled",
          entry: { command: process.execPath, args: ["./print-cwd.mjs"] },
        },
        { cwd: root }
      );

      // Script is not an MCP server — connect hangs on handshake. Race a short
      // wait so spawn can write the cwd marker, then tear down.
      await Promise.race([
        handle.connect().catch(() => undefined),
        new Promise<void>((r) => setTimeout(r, 800)),
      ]);

      const deadline = Date.now() + 3000;
      let cwdWritten = "";
      while (Date.now() < deadline) {
        try {
          cwdWritten = (await readFile(marker, "utf8")).trim();
          if (cwdWritten.length > 0) break;
        } catch {
          /* not written yet */
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(cwdWritten).toBe(root);
      await handle.close().catch(() => undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("late connect after shutdown does not register tools (lifecycle ended)", async () => {
    let connectResolve!: () => void;
    const registered: string[] = [];
    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
      config: [makeStdio("late")],
      registerExternal: (defs) => {
        for (const d of defs) registered.push(d.name);
      },
      createClient: () => {
        const handle = makeStubClient({
          connectDelayMs: null as unknown as number,
          initialTools: [sampleTool("echo")],
          listChangedHandlers: [],
          closeHandlers: [],
        });
        (handle as unknown as { connect: () => Promise<void> }).connect = () =>
          new Promise<void>((res) => {
            connectResolve = res;
          }).then(() => undefined);
        return handle;
      },
    });

    await mgr.start();
    // Still pending — shutdown before connect completes.
    expect(mgr.status().find((s) => s.name === "late")?.state).toBe("pending");
    await mgr.shutdown();
    expect(mgr.status().find((s) => s.name === "late")?.state).toBe("failed");

    // Late connect + listTools must not flip to connected or register.
    connectResolve();
    await new Promise((r) => setTimeout(r, 80));
    expect(mgr.status().find((s) => s.name === "late")?.state).toBe("failed");
    expect(registered).toEqual([]);
  });

  it("list_changed after shutdown does not register tools", async () => {
    const registered: string[] = [];
    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
      config: [makeStdio("svc")],
      registerExternal: (defs) => {
        for (const d of defs) registered.push(d.name);
      },
      createClient: () =>
        makeStubClient({
          initialTools: [sampleTool("alpha")],
          listChangedHandlers: [],
          closeHandlers: [],
        }),
    });

    await mgr.start();
    await waitForStatus(mgr, "svc", "connected", 2000);
    registered.length = 0;

    const handle = (mgr as unknown as { _handles: McpClientHandle[] })
      ._handles[0]!;
    await mgr.shutdown();

    const triggers = handle as unknown as {
      _triggerListChanged: (ts: McpTool[]) => void;
    };
    triggers._triggerListChanged([sampleTool("alpha"), sampleTool("beta")]);
    await new Promise((r) => setTimeout(r, 30));
    expect(registered).toEqual([]);
  });
});

// =========================================================================
// manual reconnect — ADR-0043 §4
// =========================================================================

describe("MCP manager — manual reconnect notification", () => {
  it("reload 后重连成功的 server → listener 收到 serverName + toolNames(首次 start 不派发)", async () => {
    const events: Array<{ server: string; tools: string[] }> = [];
    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
      config: [makeStdio("svc")],
      registerExternal: () => {},
      createClient: () =>
        makeStubClient({
          initialTools: [sampleTool("echo"), sampleTool("ping")],
          listChangedHandlers: [],
          closeHandlers: [],
        }),
    });

    mgr.onManualReconnect((serverName, toolNames) => {
      events.push({ server: serverName, tools: [...toolNames] });
    });

    // first start connecting successfully = initial connection, not a reconnect → zero dispatch.
    await mgr.start();
    await waitForStatus(mgr, "svc", "connected", 2000);
    await new Promise((r) => setTimeout(r, 30));
    expect(events).toEqual([]);

    // Manual reconnect path: reload (same config, simulating a UI reconnect) then
    // connecting again → dispatch once, tool names = mcp__<server>__<tool> (matching registerExternal).
    await mgr.reload([makeStdio("svc")]);
    await waitForStatus(mgr, "svc", "connected", 2000);
    await new Promise((r) => setTimeout(r, 30));
    expect(events).toEqual([
      {
        server: "svc",
        tools: ["mcp__svc__echo", "mcp__svc__ping"],
      },
    ]);

    // fire-once: list_changed incremental re-registration does not re-announce.
    const handle = (mgr as unknown as { _handles: McpClientHandle[] })
      ._handles[0]!;
    const triggers = handle as unknown as {
      _triggerListChanged: (ts: McpTool[]) => void;
    };
    triggers._triggerListChanged([
      sampleTool("echo"),
      sampleTool("ping"),
      sampleTool("extra"),
    ]);
    await new Promise((r) => setTimeout(r, 30));
    expect(events).toHaveLength(1);

    await mgr.shutdown();
  });

  it("reload 后连接失败的 server 不派发;成功者单独派发(缺席者第二次机会命中也播报)", async () => {
    const events: Array<{ server: string; tools: string[] }> = [];
    let rejectBad = true;
    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
      config: [makeStdio("good"), makeStdio("bad")],
      registerExternal: () => {},
      createClient: (server) =>
        makeStubClient({
          ...(rejectBad && server.name === "bad"
            ? { rejectConnect: true }
            : {}),
          initialTools: [sampleTool("t")],
          listChangedHandlers: [],
          closeHandlers: [],
        }),
    });

    mgr.onManualReconnect((serverName, toolNames) => {
      events.push({ server: serverName, tools: [...toolNames] });
    });

    await mgr.start();
    await waitForStatus(mgr, "good", "connected", 2000);
    await waitForStatus(mgr, "bad", "failed", 2000);

    rejectBad = false;
    await mgr.reload([makeStdio("good"), makeStdio("bad")]);
    await waitForStatus(mgr, "good", "connected", 2000);
    await waitForStatus(mgr, "bad", "connected", 2000);
    await new Promise((r) => setTimeout(r, 30));

    // After reload, both "newly connected" servers dispatch once each (the already-connected
    // good also goes through shutdown → pending → connected inside reload, so it counts as a successful reconnect).
    expect(events.map((e) => e.server).sort()).toEqual(["bad", "good"]);
    for (const e of events) {
      expect(e.tools).toEqual([`mcp__${e.server}__t`]);
    }

    await mgr.shutdown();
  });
});
