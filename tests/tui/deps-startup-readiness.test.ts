/**
 * tests/tui/deps-startup-readiness.test.ts
 *
 * Plan T2 (remote-sync-plan1): TUI readiness must not depend on optional
 * startup work. `buildTuiDeps` assembles the harness engine, which used to
 * await two optional integration paths before returning:
 *   - `mcpManager.start({ firstTurnReadyTimeoutMs })` (ADR-0043 window), and
 *   - the two assembly-time `adapter.countTokens` judgments (overflow
 *     governance + index demotion) over HTTP.
 * An unreachable / auth-refusing / hanging gateway or MCP server therefore
 * delayed the first render, and a never-settling optional call blocked it
 * indefinitely.
 *
 * These cases pin the seam contract:
 *   1. unresolved MCP first-ready + unresolved countTokens → `buildTuiDeps`
 *      still resolves and hands over the extension surface (so the renderer
 *      and input can come up, and quit works);
 *   2. the ADR-0043 name-directory judgment resolves at ONE point (the first
 *      turn's system assembly) — a server that connects afterwards never
 *      mutates the emitted surface (first-turn constancy);
 *   3. a late token-count result after that point never retires tools;
 *   4. a late result after shutdown is dropped (no resource re-creation, no
 *      unhandled rejection);
 *   5. required local configuration errors still throw before any rendering.
 *
 * Deterministic latches only: every pending promise is released in the test
 * (success or failure) through a deferred; the watchdog is a test failure
 * bound, not a product latency threshold.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTuiDeps,
  type BuildTuiDepsOptions,
  type TuiExtensions,
} from "../../src/tui/deps.js";
import { createNoAskUser } from "../../src/harness/permission/ask-user.js";
import type { RuntimeBundle } from "../../src/cli/runtime.js";
import type { IknowEnv } from "../../src/config/env.js";
import { LLM_API_KEY_MISSING_MESSAGE } from "../../src/config/messages.js";
import type {
  McpClientHandle,
  McpManager,
} from "../../src/harness/mcp/manager.js";
import type { Tool as McpTool } from "@modelcontextprotocol/client";

/** Minimal valid RuntimeBundle — buildTuiDeps reads only the env field. */
function makeBundle(apiKey = "sk-test-sentinel-tui-readiness"): RuntimeBundle {
  const env: IknowEnv = {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      fallback: [],
      apiKey,
      maxOutputTokens: 1024,
      timeoutMs: 60_000,
      temperature: 0,
      thinking: "off",
      thinkingEffort: "",
      stream: "on",
    },
    chat: { showThinking: false },
    web: { searchUrl: undefined, proxy: undefined },
    compress: { contextWindow: 200_000, thresholdTokens: undefined },
    mcp: { connectTimeoutMs: 60_000 },
    subagent: { taskTimeoutMs: undefined },
    workspaceRoot: undefined,
    productRoot: undefined,
  };
  return { env } as unknown as RuntimeBundle;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (err: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Test failure bound for "must not block" assertions. It is NOT a product
 * threshold: the assertion is "the promise settled at all while the optional
 * latch is still closed", and this only converts a regression into a failure
 * instead of a hang.
 */
async function withWatchdog<T>(
  promise: Promise<T>,
  label: string,
  ms = 10_000
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`watchdog: ${label} did not settle in ${ms}ms`)),
      ms
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface StubManagerControl {
  /** How many times `start()` was called with a first-turn window. */
  windowStarts(): number;
  /** Release the pending first-turn window (late release = post-shutdown). */
  releaseWindow(): void;
  /** How many times `shutdown()` was called. */
  shutdowns(): number;
}

/** A manager whose first-turn window never resolves until released. */
function makeNeverReadyManager(): {
  manager: McpManager;
  control: StubManagerControl;
} {
  const window = deferred<void>();
  let windowStarts = 0;
  let shutdowns = 0;
  const manager = {
    start: async (startOpts?: { firstTurnReadyTimeoutMs?: number }) => {
      if (startOpts?.firstTurnReadyTimeoutMs !== undefined) {
        windowStarts += 1;
        await window.promise;
      }
    },
    onManualReconnect: () => undefined,
    reload: async () => undefined,
    shutdown: async () => {
      shutdowns += 1;
    },
    status: () => [],
    listResources: async () => ({ resources: [], perServer: [] }),
    readResource: async () => {
      throw new Error("readResource unused in this stub");
    },
  } as unknown as McpManager;
  return {
    manager,
    control: {
      windowStarts: () => windowStarts,
      releaseWindow: () => window.resolve(undefined),
      shutdowns: () => shutdowns,
    },
  };
}

function makeInstantClient(tools: readonly McpTool[]): McpClientHandle {
  return {
    connect: async () => {},
    listTools: async () => tools,
    callTool: async () => ({ result: { content: [] } }),
    close: async () => {},
    onListChanged: () => {},
    onClose: () => {},
    listResources: async () => ({ resources: [] }),
    readResource: async () => ({ contents: [] }),
  };
}

/** A client whose connect only completes when the test releases the latch. */
function makeLatchedClient(
  tools: readonly McpTool[],
  gate: Deferred<void>
): McpClientHandle {
  return {
    ...makeInstantClient(tools),
    connect: async () => {
      await gate.promise;
    },
  };
}

const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

function tmpRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writeMcpConfig(root: string, servers: readonly string[]): void {
  const entries = servers
    .map((name) => `"${name}": { "type": "stdio", "command": "node" }`)
    .join(", ");
  mkdirSync(join(root, ".iknow"), { recursive: true });
  writeFileSync(
    join(root, ".iknow", "mcp.json"),
    `{ "mcpServers": { ${entries} } }`,
    "utf8"
  );
}

/** Poll until `pred` holds (bounded; the latch itself is the real ordering). */
async function waitFor(
  pred: () => boolean,
  label: string,
  ms = 5_000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timeout: ${label}`);
}

/** Let queued microtasks / short I/O continuations run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((fn) => fn()));
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("T2 — 可选启动工作不阻塞 TUI 就绪", () => {
  test("MCP first-turn 窗口未决 + countTokens 未决 → buildTuiDeps 仍返回（可渲染 / 可退出）", async () => {
    const root = tmpRoot("iknow-tui-readiness-hang-");
    const { manager, control } = makeNeverReadyManager();
    const countTokensCalled = deferred<void>();
    let captured: TuiExtensions | undefined;
    let released = false;

    const opts: BuildTuiDepsOptions = {
      askUser: createNoAskUser(),
      userHome: join(root, "home"),
      cwd: root,
      createMcpManager: () => manager,
      // Never settles until the test releases it: an unreachable / hanging
      // gateway for the assembly-time token measurements.
      countTokens: () => {
        countTokensCalled.resolve(undefined);
        return new Promise<{ inputTokens: number }>(() => undefined);
      },
      onExtensions: (ext) => {
        captured = ext;
      },
    };

    try {
      const built = await withWatchdog(
        buildTuiDeps(makeBundle(), opts),
        "buildTuiDeps"
      );

      // Readiness: deps are usable and the TUI extension surface is exposed
      // (the renderer mounts on this, then the app binds quit).
      expect(built.registry.list().length).toBeGreaterThan(0);
      expect(captured).toBeDefined();
      expect(typeof captured!.mcp.status).toBe("function");

      // The optional window start was requested (background), and the latch is
      // still closed — assembly did not wait for it.
      expect(control.windowStarts()).toBeGreaterThan(0);
      expect(released).toBe(false);

      // Quit path: shutdown resolves while the optional work is still pending.
      await withWatchdog(captured!.shutdown(), "extensions.shutdown");
      expect(control.shutdowns()).toBeGreaterThan(0);

      // Late release after shutdown must not throw or apply anything.
      released = true;
      control.releaseWindow();
      countTokensCalled.resolve(undefined);
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      released = true;
      control.releaseWindow();
      countTokensCalled.resolve(undefined);
    }
  }, 30_000);

  test("countTokens 未决（网关挂起）→ 装配不等待、返回后可 shutdown", async () => {
    const root = tmpRoot("iknow-tui-readiness-hang-tokens-");
    const firstCall = deferred<void>();
    const tokenGate = deferred<{ inputTokens: number }>();
    const built = await withWatchdog(
      buildTuiDeps(makeBundle(), {
        askUser: createNoAskUser(),
        userHome: join(root, "home"),
        cwd: root,
        // No mcp.json → the MCP window resolves immediately; the only
        // unresolved optional work is the gateway measurement.
        countTokens: () => {
          firstCall.resolve(undefined);
          return tokenGate.promise;
        },
      }),
      "buildTuiDeps"
    );
    try {
      // The measurement really started (background) and is still parked.
      await withWatchdog(firstCall.promise, "first countTokens call");
      expect(built.registry.list().length).toBeGreaterThan(0);
      // Quit works while the gateway never answers.
      await withWatchdog(built.shutdown!(), "built.shutdown");
    } finally {
      tokenGate.resolve({ inputTokens: 1 });
      await settle();
    }
  }, 30_000);

  test("晚到的 MCP 连接不进入已冻结的名字目录（first-turn 常量性）", async () => {
    const root = tmpRoot("iknow-tui-readiness-late-mcp-");
    writeMcpConfig(root, ["stubsvc"]);
    const connectGate = deferred<void>();
    const tools: readonly McpTool[] = [
      {
        name: "alpha",
        description: "alpha tool",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    let captured: TuiExtensions | undefined;
    const built = await buildTuiDeps(makeBundle(), {
      askUser: createNoAskUser(),
      userHome: join(root, "home"),
      cwd: root,
      createMcpClient: () => makeLatchedClient(tools, connectGate),
      // The overflow / demotion gates must not touch the network here.
      countTokens: async () => ({ inputTokens: 1 }),
      onExtensions: (ext) => {
        captured = ext;
      },
    });
    cleanups.push(async () => {
      await built.shutdown?.();
    });

    // First turn: the server is still connecting, so the freeze-time fallback
    // is the emitted surface. This call IS the first-turn judgment point.
    const first = await built.system?.();
    expect(first).toBeDefined();
    expect(first!).not.toContain("<mcp_name_directory>");

    // The server connects late and its tools register live in the catalog.
    connectGate.resolve(undefined);
    await waitFor(
      () => captured!.mcp.status().some((s) => s.state === "connected"),
      "mcp server connected"
    );

    // Constancy: the emitted system surface never learns about it.
    const second = await built.system?.();
    expect(second).toBe(first);
  }, 30_000);

  test("首次 turn 之后到达的 token 测量结果不退役内建件（不突变注册表）", async () => {
    const root = tmpRoot("iknow-tui-readiness-late-tokens-");
    const tokenGate = deferred<{ inputTokens: number }>();
    const firstCall = deferred<void>();
    let tokenCalls = 0;
    const built = await buildTuiDeps(makeBundle(), {
      askUser: createNoAskUser(),
      userHome: join(root, "home"),
      cwd: root,
      countTokens: () => {
        tokenCalls += 1;
        if (tokenCalls === 1) {
          firstCall.resolve(undefined);
          return tokenGate.promise;
        }
        // Every re-measurement after the release reports a huge surface.
        return Promise.resolve({ inputTokens: 1_000_000 });
      },
    });
    cleanups.push(async () => {
      await built.shutdown?.();
    });

    // The background judgment is parked on the gateway call when the first
    // turn starts (deterministic: no timer ordering involved).
    await withWatchdog(firstCall.promise, "first countTokens call");
    const before = await built.system?.();
    const promptTools = built.promptTools;
    expect(promptTools).toBeDefined();
    const namesBefore = promptTools!().map((t) => t.name);
    expect(namesBefore).toContain("query_trace");

    // Late result: over threshold on every measurement → the ladder would
    // retire all five if it were applied. It must be dropped (frozen).
    tokenGate.resolve({ inputTokens: 1_000_000 });
    await settle();

    const after = await built.system?.();
    expect(after).toBe(before);
    expect(promptTools!().map((t) => t.name)).toEqual(namesBefore);
    expect(namesBefore).toContain("query_trace");
    expect(built.registry.list().map((d) => d.name)).toContain("query_trace");
  }, 30_000);

  test("shutdown 后到达的延迟结果不应用、不产生未处理 rejection", async () => {
    const root = tmpRoot("iknow-tui-readiness-post-shutdown-");
    const tokenGate = deferred<{ inputTokens: number }>();
    const firstCall = deferred<void>();
    let tokenCalls = 0;
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };
    process.on("unhandledRejection", onRejection);
    try {
      const built = await buildTuiDeps(makeBundle(), {
        askUser: createNoAskUser(),
        userHome: join(root, "home"),
        cwd: root,
        countTokens: () => {
          tokenCalls += 1;
          if (tokenCalls === 1) {
            firstCall.resolve(undefined);
            return tokenGate.promise;
          }
          return Promise.resolve({ inputTokens: 1_000_000 });
        },
      });

      await withWatchdog(firstCall.promise, "first countTokens call");
      // No turn ran: shutdown closes the barrier while the task is still parked.
      await withWatchdog(built.shutdown!(), "built.shutdown");
      expect(built.promptTools!().map((t) => t.name)).toContain("query_trace");

      // Late result after teardown: dropped, and no new resource is created.
      tokenGate.resolve({ inputTokens: 1_000_000 });
      await settle();
      expect(built.promptTools!().map((t) => t.name)).toContain("query_trace");
      const systemText = await built.system?.();
      expect(systemText ?? "").not.toContain("<deferred_internal_tools>");
      expect(rejections).toHaveLength(0);
      // Sealed path: the parked call was the last gateway call and the seal is
      // silent (no skip warn after teardown).
      expect(tokenCalls).toBe(1);
      expect(
        warnings.filter(
          (w) => w.includes("overflow judge") || w.includes("index demotion")
        )
      ).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
      console.warn = originalWarn;
    }
  }, 30_000);

  test("必需本地配置缺失仍在渲染前抛错（就绪优化不放宽启动错误）", async () => {
    const root = tmpRoot("iknow-tui-readiness-required-");
    await expect(
      buildTuiDeps(makeBundle(""), {
        askUser: createNoAskUser(),
        userHome: join(root, "home"),
        cwd: root,
      })
    ).rejects.toThrow(LLM_API_KEY_MISSING_MESSAGE);
  }, 30_000);
});
