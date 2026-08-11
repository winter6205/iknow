/**
 * T7 (#344) — MCP manager 生命周期 / 并发 / registerExternal 接线 单测。
 *
 * 覆盖 SC8 / SC9 / SC11 / SC15 / SC16 + Manager spec 验收 1-4：
 *  - 状态机 pending → connected | failed | disabled
 *  - start() 早返回，连接在后台完成（SC8）
 *  - 注册 30s 超时 → failed + warn（SC9）
 *  - connected → registerExternal 追加，discover 可见
 *  - list_changed 重注册：在途 callTool 不打断 + 同名不重复（SC15）
 *  - shutdown 取消在途调用 + stdio 子孙 SIGTERM（SC11 / SC16）
 *  - onclose → failed，不重连
 *
 * Stub client 测客户端语义；SIGTERM 子进程用真 node 子进程断言信号。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";

import type {
  CallToolResult,
  Tool as McpTool,
} from "@modelcontextprotocol/client";
import type { AciToolDef } from "../../src/harness/aci/types.ts";
import { createAciRegistry } from "../../src/harness/aci/aci-registry.ts";

import {
  createMcpManager,
  type McpClientHandle,
  type McpManager,
} from "../../src/harness/mcp/manager.ts";
import type { McpServerConfig } from "../../src/harness/mcp/config.ts";

// ---------------------------------------------------------------------------
// Stub client
// ---------------------------------------------------------------------------

interface StubClientOptions {
  /** connect 之前等待的毫秒数；-1 表示永不完成；省略表示立即完成。 */
  connectDelayMs?: number;
  /** connect 时拒绝；触发 failed 路径。 */
  rejectConnect?: boolean;
  /** connect 完成后首次 listTools 的延迟 ms（用于 SC8 慢 connect 测）。 */
  firstListToolsDelayMs?: number;
  /** connect 后 listTools 的初始工具列表。 */
  initialTools?: McpTool[];
  /** callTool 的延迟（便于构造"在途"）。 */
  callToolDelayMs?: number;
  /** callTool 拒绝；用于 shutdown 取消语义对真实业务错误的对照。 */
  rejectCallTool?: boolean;
  /** mock 控制柄。 */
  listChangedHandlers: Array<(tools: McpTool[]) => void>;
  closeHandlers: Array<() => void>;
}

/**
 * 完全内存假 client。暴露：
 *  - `triggerListChanged(tools)` —— 测试可同步触发 list_changed 回调；
 *  - `triggerClose()` —— 测试可模拟服务器关闭（onclose → failed）。
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
        // 永不 resolve；外部用 timeout 标 failed
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
      options?: { signal?: AbortSignal }
    ): Promise<CallToolResult> => {
      // 检查 abort：shutdown/timeout 会传 signal
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
      return {
        content: [{ type: "text", text: "ok" }],
      } satisfies CallToolResult;
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
    // 暴露手动触发器
    ...({
      _triggerListChanged: (tools: McpTool[]) => {
        for (const cb of handlers.listChangedHandlers!) cb(tools);
      },
      _triggerClose: () => {
        for (const cb of handlers.closeHandlers!) cb();
      },
    } as unknown as Record<string, unknown>),
  };
  // 直接挂到 opts 上让 builder 也能拿到
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

function makeRemote(name: string): McpServerConfig {
  return {
    name,
    kind: "remote",
    source: "user",
    status: "enabled",
    entry: { url: "https://example.com/mcp" },
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

/** 等待 manager 完成后台 connect + 工具注册。 */
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
// State machine + SC8 (early return)
// =========================================================================

describe("MCP manager — state machine", () => {
  it("skips connecting to disabled servers", async () => {
    const handles: McpClientHandle[] = [];
    const mgr = createMcpManager({
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
      config: [makeStdio("slow")],
      registerExternal: () => {},
      createClient: () => {
        const handle = makeStubClient({
          // connect 等外部 signal 才完成（模拟慢 server）
          connectDelayMs: null,
          listChangedHandlers: [],
          closeHandlers: [],
        });
        // 覆写 connect：用可控 promise
        const slowConnect = new Promise<void>((res) => {
          connectResolve = res;
        });
        (handle as unknown as { connect: () => Promise<void> }).connect =
          async () => {
            await slowConnect;
          };
        // listTools：connect 后才返回
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

    // 早返回：start() 立即 resolve
    expect(elapsed).toBeLessThan(200);
    expect(mgr.status()[0]?.state).toBe("pending");

    connectResolve(); // 放行 background connect
    await waitForStatus(mgr, "slow", "connected", 2000);
    await mgr.shutdown();
  });

  it("transitions pending → connected and registers tools via registerExternal", async () => {
    const initial: McpTool[] = [sampleTool("echo"), sampleTool("ping")];
    let registered: AciToolDef[] = [];
    const mgr = createMcpManager({
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

    // 必须把 mcp__ 前缀工具塞进 registerExternal
    expect(registered.map((d) => d.name).sort()).toEqual([
      "mcp__good__echo",
      "mcp__good__ping",
    ]);
    // 注册后的工具在 catalog 可见 —— 用真实的 AciRegistry 装一遍
    const reg = createAciRegistry([]);
    for (const d of registered) reg.registerExternal([d]);
    expect(reg.catalog.get("mcp__good__echo")).toBeDefined();

    await mgr.shutdown();
  });
});

// =========================================================================
// SC9 — 30s connect timeout
// =========================================================================

describe("MCP manager — 30s connect timeout (SC9)", () => {
  it("marks timed-out server as failed + warn without blocking others", async () => {
    let slowConnectResolve!: () => void;
    const createCalls: string[] = [];

    const mgr = createMcpManager({
      config: [makeStdio("slow"), makeStdio("fast")],
      registerExternal: () => {},
      timeoutMsOverride: 80, // 缩到测试可用
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
            return [];
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

    // 释放 slow 后不能让它再转 connected（已经失败 = 不重连）
    slowConnectResolve?.();
    await new Promise((r) => setTimeout(r, 50));
    expect(mgr.status().find((s) => s.name === "slow")?.state).toBe("failed");

    await mgr.shutdown();
    expect(createCalls).toContain("slow");
    expect(createCalls).toContain("fast");
  });
});

// =========================================================================
// SC15 — list_changed 重注册，不打断在途 callTool，不重复注册同名
// =========================================================================

describe("MCP manager — list_changed re-registration (SC15)", () => {
  it("re-registers on list_changed without duplicating known names and without interrupting in-flight callTool", async () => {
    const initial: McpTool[] = [sampleTool("alpha"), sampleTool("beta")];

    const external: AciToolDef[] = [];
    let registerCount = 0;
    const registerCalls: AciToolDef[][] = [];

    const mgr = createMcpManager({
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
    expect(registerCount).toBe(1); // 初次注册

    // 触发在途 callTool
    const callHandle = (mgr as unknown as { _handles: McpClientHandle[] })
      ._handles?.[0];
    expect(callHandle).toBeDefined();
    const inflight = callHandle!.callTool("alpha", {}, {});

    // 短暂等待让 callTool 进入在途
    await new Promise((r) => setTimeout(r, 20));

    // 触发 list_changed：新增 gamma + 重出 alpha 同名
    const triggers = callHandle as unknown as {
      _triggerListChanged: (ts: McpTool[]) => void;
    };
    triggers._triggerListChanged([
      sampleTool("alpha"),
      sampleTool("beta"),
      sampleTool("gamma"),
    ]);

    await new Promise((r) => setTimeout(r, 30));
    // 在途 callTool 不被打断，正常 resolve
    const result = await inflight;
    expect(result.content[0]).toMatchObject({ type: "text", text: "ok" });

    // 注册次数：初次 1 + 一次 list_changed 触发 alpha/gamma 重注册
    await waitForRegister(() => registerCount, 2, 1000);

    // 增量注册 —— 同名 alpha/beta 已 registered,只追加 gamma
    const last = registerCalls.at(-1)!;
    const newNames = last.map((d) => d.name).sort();
    expect(newNames).toEqual(["mcp__svc__gamma"]);

    // 完整外部注册集应当包含 alpha/beta/gamma,无重复
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
// SC16 / SC11 — shutdown cancel semantics + stdio SIGTERM
// =========================================================================

describe("MCP manager — shutdown (SC11 / SC16)", () => {
  it("shutdown cancels in-flight callTool with a clear rejection (not success, not hanging)", async () => {
    // 走 manager 注册的 ACI tool handler —— 这样 mergeAbort 把 slot.callAbort
    // 串到了 stub.callTool 的 signal,shutdown 时能被传播。
    let registered: AciToolDef[] = [];
    const mgr = createMcpManager({
      config: [makeStdio("svc")],
      registerExternal: (defs) => {
        registered = [...defs, ...registered];
      },
      createClient: () =>
        makeStubClient({
          initialTools: [sampleTool("slowOp")],
          callToolDelayMs: 5000, // 5s 长任务
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

    // 关键：shutdown 后 call 必须 reject 且类型明确
    const shutdownP = mgr.shutdown();

    let rejected = false;
    let resolved: unknown = undefined;
    try {
      resolved = await callP;
    } catch (err) {
      rejected = true;
      // 必须明确——不悬挂,不冒充成功
      expect(err).toBeDefined();
    }
    await shutdownP;
    expect(rejected).toBe(true);
    expect(resolved).toBeUndefined();
  });

  it("client.close is invoked on shutdown", async () => {
    const mgr = createMcpManager({
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
    // close 已被调：再次 close 应立即 resolve（connected=false）
    await expect(handle.close()).resolves.toBeUndefined();
  });

  it("forwards SIGTERM to stdio child subprocess on shutdown (SC11)", async () => {
    /**
     * 真子进程：node 启动一个 sleep 子进程并打印其 pid。
     * 我们手动构造 McpClientHandle 让它 spawn 这个真子进程（覆盖 stub）。
     */
    // 用 echo 进程：sleep + 等待 SIGTERM 退出的 node 子进程
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

    // 等子进程报告 pid
    const t0 = Date.now();
    while (pidReported < 0 && Date.now() - t0 < 3000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(pidReported).toBeGreaterThan(0);

    // 手动构造 McpClientHandle，模拟 manager 的 stdio handle：close 时 SIGTERM 子进程
    const handle: McpClientHandle = {
      connect: async () => {},
      listTools: async () => [],
      callTool: async () => ({ content: [{ type: "text", text: "x" }] }),
      close: async () => {
        // 关键 —— SIGTERM 孙子
        child.kill("SIGTERM");
      },
      onListChanged: () => {},
      onClose: () => {},
    };

    // 借用 manager 但替换 createClient 工厂
    const mgr = createMcpManager({
      config: [makeStdio("svc")],
      registerExternal: () => {},
      createClient: () => handle,
    });

    await mgr.start();
    await new Promise((r) => setTimeout(r, 20));
    await mgr.shutdown();

    // 等孙子实际收到信号
    const t1 = Date.now();
    while (!gotSignal && Date.now() - t1 < 3000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(gotSignal).toBe(true);

    // 兜底清理：万一断言前断言失败，避免子进程泄漏
    if (!child.killed) child.kill("SIGTERM");
  });
});

// =========================================================================
// onclose → failed 不重连
// =========================================================================

describe("MCP manager — onclose semantics", () => {
  it("moves server to failed state when SDK fires onclose and does not reconnect", async () => {
    const mgr = createMcpManager({
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

    // 再触发一次也不重连（仍 failed）
    triggers._triggerClose();
    await new Promise((r) => setTimeout(r, 50));
    expect(mgr.status().find((s) => s.name === "svc")?.state).toBe("failed");

    await mgr.shutdown();
  });
});

// =========================================================================
// reload — Phase A harness seam（TUI 看板 refresh）
// =========================================================================

describe("MCP manager — reload", () => {
  it("reload replaces server set: renamed / added / removed servers reflected in status()", async () => {
    const mgr = createMcpManager({
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

    // 重载：改名 alpha → gamma，新增 beta，删除原 alpha 对应 server
    await mgr.reload([makeStdio("beta"), makeStdio("gamma")]);

    // reload 不阻塞在连接上（SC8）——状态立即反映新 server 集
    expect(mgr.status().map((s) => s.name)).toEqual(["beta", "gamma"]);
    // 后台 connect 完成后转 connected
    await waitForStatus(mgr, "beta", "connected", 2000);
    await waitForStatus(mgr, "gamma", "connected", 2000);
    expect(mgr.status().every((s) => s.state === "connected")).toBe(true);

    await mgr.shutdown();
  });

  it("reload aborts an in-flight callTool (reject, never resolve)", async () => {
    let registered: AciToolDef[] = [];
    const mgr = createMcpManager({
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

    // reload 内部先 shutdown → 取消 in-flight（复用 SC16 语义）
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

    // 重载为 disabled —— 不建 client，状态直接 disabled
    await mgr.reload([makeStdio("svc", "disabled")]);

    expect(handles).toHaveLength(1); // 未新增 client
    expect(mgr.status()).toHaveLength(1);
    expect(mgr.status()[0]).toMatchObject({ name: "svc", state: "disabled" });

    await mgr.shutdown();
  });
});
