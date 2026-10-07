/**
 * Manager resource-channel unit tests.
 *
 * Covers 5 input classes (reusing the p04 stub-client shape, simplified as needed):
 *  1. normal path (single-server aggregation / multi-server aggregation / blob content)
 *  2. empty input (not started; server="" / uri="")
 *  3. invalid / negative (server not configured; disabled server; SDK throws)
 *  4. overflow / boundary (aggregate 1000 resources; cursor pass-through)
 *  5. concurrency / exception (two servers read concurrently; abort → typed error; state-transition failure)
 *
 * Complements manager.test.ts: that file locks the state machine /
 * registerExternal; this file locks the resource channel's listResources /
 * readResource protocol paths. Existing assertions there are not duplicated
 * (no repeated cost).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  BlobResourceContents as SdkBlobResourceContents,
  Resource as SdkResource,
  ResourceContents as SdkResourceContents,
  TextResourceContents as SdkTextResourceContents,
} from "@modelcontextprotocol/client";

import {
  createMcpManager,
  type McpClientHandle,
} from "../../src/harness/mcp/manager.ts";
import { ToolExecutionError } from "../../src/harness/errors.ts";
import type { McpServerConfig } from "../../src/harness/mcp/config.ts";

/** Absolute workspace root for the manager cwd contract. */
const TEST_WORKSPACE_ROOT = "/tmp/iknow-mcp-manager-resources-workspace";

// ---------------------------------------------------------------------------
// Resource stub client — makeStubClient from manager.test.ts plus the resource
// channel (listResources / readResource); existing callTool/listTools unchanged.
// ---------------------------------------------------------------------------

interface ResourceStubBehavior {
  /** Custom listResources. Omitted → uses configured `resources` + `nextCursor`. */
  listResources?: (cursor?: string) => Promise<{
    resources: readonly SdkResource[];
    nextCursor?: string;
  }>;
  /** Custom readResource. Omitted → hits readMap; otherwise fallbackRead. */
  readResource?: (
    uri: string
  ) => Promise<{ contents: readonly SdkResourceContents[] }>;
  /** Force listResources to throw. */
  failListResources?: Error;
  /** Force readResource to throw. */
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

/** Wait for the background bootSlot to finish (stub connect/listTools are synchronous; 30ms is plenty). */
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

function sampleText(uri: string, text: string): SdkTextResourceContents {
  return { uri, mimeType: "text/plain", text };
}

function sampleBlob(uri: string, b64: string): SdkBlobResourceContents {
  return { uri, mimeType: "application/octet-stream", blob: b64 };
}

// =========================================================================
// 1. normal path
// =========================================================================

describe("manager.listResources / readResource — normal path", () => {
  it("aggregates from a single connected server with text content", async () => {
    const r = sampleResource("a", "file:///a.txt");
    const b = sampleResource("b", "file:///b.txt");
    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
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
      workspaceRoot: TEST_WORKSPACE_ROOT,
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
      workspaceRoot: TEST_WORKSPACE_ROOT,
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
// 2. empty input
// =========================================================================

describe("listResources / readResource — empty input", () => {
  it("returns empty aggregates when manager was constructed but not started", async () => {
    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
      config: [makeStdio("never")],
      registerExternal: () => {},
      createClient: () =>
        makeResourceStub({ resources: [], readMap: new Map() }),
    });
    // deliberately no start() call — all slots remain pending
    const out = await mgr.listResources();
    expect(out.resources).toHaveLength(0);
    expect(out.perServer).toHaveLength(1);
    expect(out.perServer[0]?.state).toBe("pending");
    // readResource without a handle → throws typed error
    await expect(mgr.readResource("never", "x://u")).rejects.toBeInstanceOf(
      ToolExecutionError
    );
  });

  it("throws ToolExecutionError for empty server name", async () => {
    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
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
      workspaceRoot: TEST_WORKSPACE_ROOT,
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
// 3. invalid / negative
// =========================================================================

describe("listResources / readResource — invalid input", () => {
  it("throws ToolExecutionError when server name is not configured", async () => {
    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
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
      workspaceRoot: TEST_WORKSPACE_ROOT,
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
      workspaceRoot: TEST_WORKSPACE_ROOT,
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
      workspaceRoot: TEST_WORKSPACE_ROOT,
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
// 4. overflow / boundary
// =========================================================================

describe("listResources / readResource — overflow / boundaries", () => {
  it("aggregates 1000 resources without dropping any", async () => {
    const all: SdkResource[] = [];
    for (let i = 0; i < 1000; i += 1) {
      all.push(sampleResource(`r${i}`, `x://srv/${i}`));
    }
    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
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
      workspaceRoot: TEST_WORKSPACE_ROOT,
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
// 5. concurrency / exception
// =========================================================================

describe("listResources / readResource — concurrent / exception", () => {
  it("issues two concurrent readResource calls across two servers, both resolve independently", async () => {
    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
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
      workspaceRoot: TEST_WORKSPACE_ROOT,
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
      workspaceRoot: TEST_WORKSPACE_ROOT,
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

    // first readResource succeeds
    const first = await mgr.readResource("tw", "x://u");
    expect(first.contents[0]?.text).toBe("first");

    // simulate server-side close → manager onClose → markFailed → state="failed"
    const closeTrigger = handles[0] as unknown as { _triggerClose: () => void };
    closeTrigger._triggerClose();

    // wait for the state transition
    await new Promise((r) => setTimeout(r, 30));
    const status = mgr.status().find((s) => s.name === "tw");
    expect(status?.state).toBe("failed");

    // the second readResource must throw a typed error
    await expect(mgr.readResource("tw", "x://u")).rejects.toBeInstanceOf(
      ToolExecutionError
    );
    await mgr.shutdown();
  });
});
