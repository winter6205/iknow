/**
 * wayfinder #440 Stream B — T8 manager resource 通道单测（M1/M3/M4 决议）。
 *
 * 覆盖 5 类输入（沿用 p04 stub client 形态 + 按需简化）：
 *  1. 正常路径（单 server 聚合 / 多 server 聚合 / blob 内容）
 *  2. 空输入（未 start；server="" / uri=""）
 *  3. 非法 / 负值（server 未配置；disabled server；SDK 抛错）
 *  4. 溢出 / 边界（聚合 1000 个 resources；cursor 透传）
 *  5. 并发 / 异常（两 server 并发 read；abort → typed error；state 切换失败）
 *
 * 与 manager.test.ts 互补：manager.test.ts 锁状态机 / registerExternal，
 * 本文件锁资源通道的 listResources / readResource 协议路径。
 * 不复制 SC8/SC9/SC11/SC15/SC16 既有断言（不重复成本）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  Resource as SdkResource,
  ResourceContents as SdkResourceContents,
} from "@modelcontextprotocol/client";

import {
  createMcpManager,
  type McpClientHandle,
} from "../../src/harness/mcp/manager.ts";
import { ToolExecutionError } from "../../src/harness/errors.ts";
import type { McpServerConfig } from "../../src/harness/mcp/config.ts";

// ---------------------------------------------------------------------------
// Resource stub client —— 在 manager.test.ts makeStubClient 基础上加 resource
// 通道（listResources / readResource）；既有 callTool/listTools 不变。
// ---------------------------------------------------------------------------

interface ResourceStubBehavior {
  /** listResources 自定义。省略 → 用 configured `resources` + `nextCursor`。 */
  listResources?: (cursor?: string) => Promise<{
    resources: readonly SdkResource[];
    nextCursor?: string;
  }>;
  /** readResource 自定义。省略 → 命中 readMap；否则 fallbackRead。 */
  readResource?: (
    uri: string
  ) => Promise<{ contents: readonly SdkResourceContents[] }>;
  /** listResources 强制抛错。 */
  failListResources?: Error;
  /** readResource 强制抛错。 */
  failReadResource?: Error;
}

interface ResourceStubState {
  resources: readonly SdkResource[];
  readMap: ReadonlyMap<string, readonly SdkResourceContents[]>;
  nextCursor?: string;
  fallbackRead?: (uri: string) => readonly SdkResourceContents[];
}

function makeStdio(name: string): McpServerConfig {
  return {
    name,
    kind: "stdio",
    source: "user",
    status: "enabled",
    entry: { command: "node", args: ["./fake-mcp.js"] },
  };
}

function makeStdioDisabled(name: string): McpServerConfig {
  return {
    name,
    kind: "stdio",
    source: "user",
    status: "disabled",
    entry: { command: "node", args: ["./fake-mcp.js"] },
  };
}

function makeResourceStub(
  state: ResourceStubState,
  behavior: ResourceStubBehavior = {}
): McpClientHandle {
  let connected = false;
  let listCalls = 0;
  let readCalls = 0;
  const lastCursor: { value: string | undefined } = { value: undefined };
  const readUris: string[] = [];
  const closeHandlers: Array<() => void> = [];

  const handle: McpClientHandle = {
    connect: async () => {
      connected = true;
    },
    listTools: async () => [],
    callTool: async () => {
      throw new Error("resource stub: callTool not used");
    },
    close: async () => {
      connected = false;
    },
    onListChanged: () => {},
    onClose: (cb) => {
      closeHandlers.push(cb);
    },
    listResources: async (opts) => {
      listCalls += 1;
      lastCursor.value = opts?.cursor;
      if (behavior.failListResources) throw behavior.failListResources;
      if (behavior.listResources) return behavior.listResources(opts?.cursor);
      return {
        resources: state.resources,
        nextCursor: state.nextCursor,
      };
    },
    readResource: async (uri) => {
      readCalls += 1;
      readUris.push(uri);
      if (!connected) throw new Error("resource stub: not connected");
      if (behavior.failReadResource) throw behavior.failReadResource;
      if (behavior.readResource) return behavior.readResource(uri);
      const hit = state.readMap.get(uri);
      if (hit) return { contents: hit };
      if (state.fallbackRead) return { contents: state.fallbackRead(uri) };
      return { contents: [] };
    },
    ...({
      _markConnected: () => {
        connected = true;
      },
      _markDisconnected: () => {
        connected = false;
      },
      _triggerClose: () => {
        for (const cb of closeHandlers) cb();
      },
      _listCalls: () => listCalls,
      _readCalls: () => readCalls,
      _lastCursor: () => lastCursor.value,
      _readUris: () => [...readUris],
    } as unknown as Record<string, unknown>),
  };
  return handle;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

/** 等后台 bootSlot 走完（stub connect/listTools 都是同步的，30ms 足够）。 */
async function startAndConnect(
  mgr: ReturnType<typeof createMcpManager>
): Promise<void> {
  await mgr.start();
  await new Promise((r) => setTimeout(r, 30));
}

function sampleResource(name: string, uri: string): SdkResource {
  return {
    name,
    uri,
    description: `${name} description`,
    mimeType: "text/plain",
  };
}

function sampleText(uri: string, text: string): SdkResourceContents {
  return { uri, mimeType: "text/plain", text };
}

function sampleBlob(uri: string, b64: string): SdkResourceContents {
  return { uri, mimeType: "application/octet-stream", blob: b64 };
}

// =========================================================================
// 1. 正常路径
// =========================================================================

describe("manager.listResources / readResource — normal path", () => {
  it("aggregates from a single connected server with text content", async () => {
    const r = sampleResource("a", "file:///a.txt");
    const b = sampleResource("b", "file:///b.txt");
    const mgr = createMcpManager({
      config: [makeStdio("only")],
      registerExternal: () => {},
      createClient: () =>
        makeResourceStub({
          resources: [r, b],
          readMap: new Map([
            ["file:///a.txt", [sampleText("file:///a.txt", "hello")]],
          ]),
        }),
    });
    await startAndConnect(mgr);

    const out = await mgr.listResources();
    expect(out.resources).toHaveLength(2);
    expect(out.resources.map((x) => x.name).sort()).toEqual(["a", "b"]);
    expect(out.perServer).toHaveLength(1);
    expect(out.perServer[0]?.state).toBe("connected");

    const read = await mgr.readResource("only", "file:///a.txt");
    expect(read.contents).toHaveLength(1);
    expect(read.contents[0]?.text).toBe("hello");
    expect(read.contents[0]?.mimeType).toBe("text/plain");

    await mgr.shutdown();
  });

  it("aggregates across two connected servers (alphabetical), preserving perServer.nextCursor", async () => {
    const aResources = [sampleResource("a1", "x://a/1")];
    const bResources = [
      sampleResource("b1", "x://b/1"),
      sampleResource("b2", "x://b/2"),
    ];
    const mgr = createMcpManager({
      config: [makeStdio("alpha"), makeStdio("beta")],
      registerExternal: () => {},
      createClient: (cfg) => {
        if (cfg.name === "alpha") {
          return makeResourceStub({
            resources: aResources,
            readMap: new Map(),
          });
        }
        return makeResourceStub({
          resources: bResources,
          readMap: new Map(),
          nextCursor: "cursor-beta-page2",
        });
      },
    });
    await startAndConnect(mgr);

    const out = await mgr.listResources();
    expect(out.resources.map((r) => r.server)).toEqual([
      "alpha",
      "beta",
      "beta",
    ]);
    expect(out.perServer).toHaveLength(2);
    expect(out.perServer[0]?.server).toBe("alpha");
    expect(out.perServer[0]?.state).toBe("connected");
    expect(out.perServer[0]?.nextCursor).toBeUndefined();
    expect(out.perServer[1]?.server).toBe("beta");
    expect(out.perServer[1]?.nextCursor).toBe("cursor-beta-page2");

    await mgr.shutdown();
  });

  it("returns blob content (base64) from readResource", async () => {
    const b64 = Buffer.from("binary-data").toString("base64");
    const mgr = createMcpManager({
      config: [makeStdio("blob-srv")],
      registerExternal: () => {},
      createClient: () =>
        makeResourceStub({
          resources: [sampleResource("f", "x://f.bin")],
          readMap: new Map([["x://f.bin", [sampleBlob("x://f.bin", b64)]]]),
        }),
    });
    await startAndConnect(mgr);

    const read = await mgr.readResource("blob-srv", "x://f.bin");
    expect(read.contents[0]?.blob).toBe(b64);
    expect(read.contents[0]?.text).toBeUndefined();

    await mgr.shutdown();
  });
});

// =========================================================================
// 2. 空输入
// =========================================================================

describe("listResources / readResource — empty input", () => {
  it("returns empty aggregates when manager was constructed but not started", async () => {
    const mgr = createMcpManager({
      config: [makeStdio("never")],
      registerExternal: () => {},
      createClient: () =>
        makeResourceStub({ resources: [], readMap: new Map() }),
    });
    // 故意不调用 start() —— slots 全在 pending
    const out = await mgr.listResources();
    expect(out.resources).toHaveLength(0);
    expect(out.perServer).toHaveLength(1);
    expect(out.perServer[0]?.state).toBe("pending");
    // readResource 无 handle → 抛 typed error
    await expect(mgr.readResource("never", "x://u")).rejects.toBeInstanceOf(
      ToolExecutionError
    );
  });

  it("throws ToolExecutionError for empty server name", async () => {
    const mgr = createMcpManager({
      config: [makeStdio("only")],
      registerExternal: () => {},
      createClient: () =>
        makeResourceStub({ resources: [], readMap: new Map() }),
    });
    await startAndConnect(mgr);
    await expect(mgr.readResource("", "x://u")).rejects.toBeInstanceOf(
      ToolExecutionError
    );
    await mgr.shutdown();
  });

  it("throws ToolExecutionError for empty uri", async () => {
    const mgr = createMcpManager({
      config: [makeStdio("only")],
      registerExternal: () => {},
      createClient: () =>
        makeResourceStub({ resources: [], readMap: new Map() }),
    });
    await startAndConnect(mgr);
    await expect(mgr.readResource("only", "")).rejects.toBeInstanceOf(
      ToolExecutionError
    );
    await mgr.shutdown();
  });
});

// =========================================================================
// 3. 非法 / 负值
// =========================================================================

describe("listResources / readResource — invalid input", () => {
  it("throws ToolExecutionError when server name is not configured", async () => {
    const mgr = createMcpManager({
      config: [makeStdio("real")],
      registerExternal: () => {},
      createClient: () =>
        makeResourceStub({ resources: [], readMap: new Map() }),
    });
    await startAndConnect(mgr);
    await expect(mgr.readResource("ghost", "x://u")).rejects.toThrow(
      /mcp server 'ghost' not configured/
    );
    await mgr.shutdown();
  });

  it("readResource on a disabled server throws ToolExecutionError (failed state)", async () => {
    const mgr = createMcpManager({
      config: [makeStdioDisabled("off")],
      registerExternal: () => {},
      createClient: () =>
        makeResourceStub({ resources: [], readMap: new Map() }),
    });
    await mgr.start();
    await expect(mgr.readResource("off", "x://u")).rejects.toBeInstanceOf(
      ToolExecutionError
    );
    await mgr.shutdown();
  });

  it("listResources reports disabled server in perServer.state (without throwing)", async () => {
    const mgr = createMcpManager({
      config: [makeStdioDisabled("off")],
      registerExternal: () => {},
      createClient: () =>
        makeResourceStub({ resources: [], readMap: new Map() }),
    });
    await mgr.start();
    const out = await mgr.listResources();
    expect(out.perServer).toHaveLength(1);
    expect(out.perServer[0]?.state).toBe("disabled");
    expect(out.resources).toHaveLength(0);
    await mgr.shutdown();
  });

  it("propagates SDK reject from listResources as ToolExecutionError", async () => {
    const mgr = createMcpManager({
      config: [makeStdio("flaky")],
      registerExternal: () => {},
      createClient: () =>
        makeResourceStub(
          { resources: [], readMap: new Map() },
          { failListResources: new Error("sdk boom") }
        ),
    });
    await startAndConnect(mgr);
    await expect(mgr.listResources({ server: "flaky" })).rejects.toBeInstanceOf(
      ToolExecutionError
    );
    await mgr.shutdown();
  });
});

// =========================================================================
// 4. 溢出 / 边界
// =========================================================================

describe("listResources / readResource — overflow / boundaries", () => {
  it("aggregates 1000 resources without dropping any", async () => {
    const all: SdkResource[] = [];
    for (let i = 0; i < 1000; i += 1) {
      all.push(sampleResource(`r${i}`, `x://srv/${i}`));
    }
    const mgr = createMcpManager({
      config: [makeStdio("big")],
      registerExternal: () => {},
      createClient: () =>
        makeResourceStub({ resources: all, readMap: new Map() }),
    });
    await startAndConnect(mgr);

    const out = await mgr.listResources();
    expect(out.resources).toHaveLength(1000);
    expect(out.resources[0]?.uri).toBe("x://srv/0");
    expect(out.resources[999]?.uri).toBe("x://srv/999");

    await mgr.shutdown();
  });

  it("passes cursor through to the underlying SDK call", async () => {
    const mgr = createMcpManager({
      config: [makeStdio("page")],
      registerExternal: () => {},
      createClient: () =>
        makeResourceStub({
          resources: [sampleResource("p0", "x://p/0")],
          readMap: new Map(),
        }),
    });
    await startAndConnect(mgr);

    await mgr.listResources({ cursor: "CURSOR42" });
    const handle = (mgr as unknown as { _handles: McpClientHandle[] })
      ._handles[0]!;
    const lastCursor = (
      handle as unknown as { _lastCursor: () => string | undefined }
    )._lastCursor;
    expect(lastCursor()).toBe("CURSOR42");

    await mgr.shutdown();
  });
});

// =========================================================================
// 5. 并发 / 异常
// =========================================================================

describe("listResources / readResource — concurrent / exception", () => {
  it("issues two concurrent readResource calls across two servers, both resolve independently", async () => {
    const mgr = createMcpManager({
      config: [makeStdio("a"), makeStdio("b")],
      registerExternal: () => {},
      createClient: (cfg) => {
        if (cfg.name === "a") {
          return makeResourceStub({
            resources: [sampleResource("ra", "x://a")],
            readMap: new Map([["x://a", [sampleText("x://a", "AAA")]]]),
          });
        }
        return makeResourceStub({
          resources: [sampleResource("rb", "x://b")],
          readMap: new Map([["x://b", [sampleText("x://b", "BBB")]]]),
        });
      },
    });
    await startAndConnect(mgr);

    const [ra, rb] = await Promise.all([
      mgr.readResource("a", "x://a"),
      mgr.readResource("b", "x://b"),
    ]);
    expect(ra.contents[0]?.text).toBe("AAA");
    expect(rb.contents[0]?.text).toBe("BBB");

    await mgr.shutdown();
  });

  it("AbortError from SDK surfaces as ToolExecutionError (does not hang)", async () => {
    const mgr = createMcpManager({
      config: [makeStdio("abort-srv")],
      registerExternal: () => {},
      createClient: () =>
        makeResourceStub(
          { resources: [], readMap: new Map() },
          {
            failListResources: Object.assign(new Error("aborted"), {
              name: "AbortError" as const,
            }),
          }
        ),
    });
    await startAndConnect(mgr);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      mgr.listResources({ server: "abort-srv", signal: ctrl.signal })
    ).rejects.toBeInstanceOf(ToolExecutionError);
    await mgr.shutdown();
  });

  it("readResource when server transitioned from connected to failed throws ToolExecutionError with state info", async () => {
    const handles: McpClientHandle[] = [];
    const mgr = createMcpManager({
      config: [makeStdio("tw")],
      registerExternal: () => {},
      createClient: () => {
        const h = makeResourceStub({
          resources: [sampleResource("u", "x://u")],
          readMap: new Map([["x://u", [sampleText("x://u", "first")]]]),
        });
        handles.push(h);
        return h;
      },
    });
    await startAndConnect(mgr);

    // 第一次 readResource 成功
    const first = await mgr.readResource("tw", "x://u");
    expect(first.contents[0]?.text).toBe("first");

    // 模拟 server 端关闭 → manager onClose → markFailed → state="failed"
    (handles[0]!._triggerClose as () => void)();

    // 等待状态切换
    await new Promise((r) => setTimeout(r, 30));
    const status = mgr.status().find((s) => s.name === "tw");
    expect(status?.state).toBe("failed");

    // 第二次 readResource 必须抛 typed error
    await expect(mgr.readResource("tw", "x://u")).rejects.toBeInstanceOf(
      ToolExecutionError
    );
    await mgr.shutdown();
  });
});
