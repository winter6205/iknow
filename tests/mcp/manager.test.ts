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
            // 释放后是"超时 + 迟到 listTools **真抛错**"——保持 failed。
            // flip-back 只对"超时 + 迟到成功"生效（#378 根因 A），
            // 迟到失败不翻。这个用例即"失败路径"的固定锚点。
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

    // 释放 slow：迟到 listTools 会真抛错 → 保持 failed（超时 + 迟到失败不翻）。
    // 对照 #378 根因 A：只有"超时 + 迟到成功"才会 flip-back 到 connected。
    slowConnectResolve?.();
    await new Promise((r) => setTimeout(r, 50));
    expect(mgr.status().find((s) => s.name === "slow")?.state).toBe("failed");

    await mgr.shutdown();
    expect(createCalls).toContain("slow");
    expect(createCalls).toContain("fast");
  });
});

// =========================================================================
// #378 根因 A — 连接超时后"迟到成功"的 flip-back 语义
// =========================================================================

describe("MCP manager — connect timeout late-success flip-back (#378)", () => {
  it("flips a timed-out slot back to connected when connect+listTools late-succeed (root cause A)", async () => {
    // 慢 connect：超时先 fire（failed + timedOut）→ 释放后 connect 成功 →
    // listTools 迟到成功 → 同一 bootSlot 任务内 flip-back 到 connected。
    let slowConnectResolve!: () => void;
    let registered: AciToolDef[] = [];

    const mgr = createMcpManager({
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

    // 1) 超时先 fire → 标 failed + warn
    await waitForStatus(mgr, "slow", "failed", 2000);
    expect(
      warnCalls.some((w) => w.includes("slow") && w.includes("timeout"))
    ).toBe(true);

    // 2) 迟到成功 → 同一 boot 任务 flip-back 到 connected + 工具注册
    slowConnectResolve();
    await waitForStatus(mgr, "slow", "connected", 2000);
    expect(registered.map((d) => d.name)).toEqual(["mcp__slow__echo"]);

    await mgr.shutdown();
  });

  it("does NOT flip back when connect fails before any timeout (true failure, error wins)", async () => {
    // 失败路径：connect 真抛错先于超时 → timedOut 从未设置 → failed 定型，
    // 即便超时窗口过后也不翻（catch 里 clearTimeout 取消了超时器）。
    let rejectConnect!: (err: Error) => void;
    const mgr = createMcpManager({
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

    // 等待超过超时窗口：若超时器未清除会 fire markFailed —— 断言未发生（不误翻、不覆盖 error）
    await new Promise((r) => setTimeout(r, 300));
    const s = mgr.status().find((x) => x.name === "slow")!;
    expect(s.state).toBe("failed");
    expect(s.error).toContain("hard connect failure");
    expect(s.error).not.toContain("timeout");

    await mgr.shutdown();
  });

  it("keeps failed when listTools itself throws after a timeout (exception path)", async () => {
    // 超时已 fire（failed + timedOut）→ listTools 迟到抛错 → catch 的
    // markFailed 被"failed 不重复标记"守卫挡住：保持 failed，不翻。
    // error 停在超时原因（markFailed 不重复标记，不覆盖）。
    let slowConnectResolve!: () => void;
    const mgr = createMcpManager({
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
    // 边界：connect 立即成功，listTools 很慢（100ms）；超时（60ms）在
    // listTools 在途时 fire → failed + timedOut → listTools 迟到成功 →
    // 第二守卫 flip-back 到 connected + 工具注册。
    let registered: AciToolDef[] = [];
    const mgr = createMcpManager({
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
    // 并发：真失败先定型（timedOut 从未设置）→ 超时随后 fire 的 markFailed
    // 被"failed 不重复标记"守卫挡住 —— 状态保持 failed、error 保持真错误、
    // 不误翻（timedOut 未被置位，因此不存在 flip-back 通道）。
    let rejectConnect!: (err: Error) => void;
    const mgr = createMcpManager({
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

    // 等待跨过超时窗口 —— 超时 fire 的 markFailed 必须被守卫挡住
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

    // flip-back 后 onclose → failed（不重连；onclose 不设 timedOut → 不翻）
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
      config: [],
      registerExternal: () => {},
      createClient: () => makeStubClient({}),
    });
    await mgr.start();
    expect(mgr.status()).toEqual([]);
    await mgr.shutdown();
    // 二次 shutdown 幂等（不抛、不悬挂）。
    await mgr.shutdown();
  });

  it("negative: timeoutMsOverride 负数 → 立即超时标 failed（envPositiveInt 上游已过滤，此处验证 manager 兜底）", async () => {
    const mgr = createMcpManager({
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
    // 负数超时 → setTimeout(0) 语义 → 立即 failed；迟到 connect 仍可 flip-back。
    await waitForStatus(mgr, "neg", "failed", 2000);
    await mgr.shutdown();
  });

  it("overflow: 极大 timeoutMsOverride（Number.MAX_SAFE_INTEGER）→ 慢 connect 在窗口内正常 connected", async () => {
    const mgr = createMcpManager({
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

  it("reload unregisters stale tool names of a removed server (case A)", async () => {
    const unregistered: string[][] = [];
    const mgr = createMcpManager({
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

    // reload 到只剩 beta —— alpha 已注册的工具名必须被撤回
    await mgr.reload([makeStdio("beta")]);

    expect(unregistered).toHaveLength(1);
    expect(unregistered[0]!.sort()).toEqual([
      "mcp__alpha__echo",
      "mcp__alpha__ping",
    ]);

    await mgr.shutdown();
  });

  it("reload purges stale names and allows same-name re-register without Gate2 duplicate (case B)", async () => {
    // 真 AciRegistry 装配：registerExternal / unregisterExternal 双闭包直连。
    // 两个 server 都暴露同名工具 lookup —— 旧名不撤回则重注册触发 duplicate。
    const reg = createAciRegistry([]);
    let mgr: McpManager | undefined;
    const createClientFor = (): McpClientHandle =>
      makeStubClient({
        initialTools: [sampleTool("lookup")],
        listChangedHandlers: [],
        closeHandlers: [],
      });
    mgr = createMcpManager({
      config: [makeStdio("old")],
      registerExternal: (defs) => reg.registerExternal(defs),
      unregisterExternal: (names) => reg.unregisterExternal(names),
      createClient: createClientFor,
    });

    await mgr.start();
    await waitForStatus(mgr, "old", "connected", 2000);
    expect(reg.catalog.get("mcp__old__lookup")).toBeDefined();

    // 重载：old → new（同名工具 lookup）。旧名未撤回会触发 duplicate。
    await mgr.reload([makeStdio("new")]);
    await waitForStatus(mgr, "new", "connected", 2000);

    // stale 名从 catalog 消失，新名成功注册（未抛 RegistryConstructionError）
    expect(reg.catalog.get("mcp__old__lookup")).toBeUndefined();
    expect(reg.catalog.get("mcp__new__lookup")).toBeDefined();

    await mgr.shutdown();
  });

  it("reload without unregisterExternal still works (idempotent, case C)", async () => {
    const mgr = createMcpManager({
      config: [makeStdio("alpha")],
      registerExternal: () => {},
      // 故意不注入 unregisterExternal
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
    // createClient 按 server 名分派：cold 慢（悬挂），fast 快（立即成功）。
    const mgr = createMcpManager({
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

    // reload 换 cold：reload 内部 shutdown 旧 + 重建 + 后台 start（SC8 不阻塞）。
    await mgr.reload([makeStdio("cold")]);
    // 慢 connect 永不 resolve → 超时 → failed + error 含 connect timeout
    await waitForStatus(mgr, "cold", "failed", 2000);
    expect(mgr.status().find((s) => s.name === "cold")?.error).toContain(
      "connect timeout"
    );

    await mgr.shutdown();
  });
});
