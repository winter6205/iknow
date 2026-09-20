/**
 * list_mcp_resources unit tests.
 *
 * Covers 5 input classes:
 *  1. happy path (aggregate without server / given server / with perServer state)
 *  2. empty input (no resources at all → `(no resources)` placeholder; empty perServer)
 *  3. invalid input (non-object input / non-string server / non-string cursor)
 *  4. overflow / boundaries (aggregation across several servers / cursor pass-through)
 *  5. concurrency / exceptions (typed error from manager passes through)
 *
 * Note: the handler is exercised through the AciRegistry exit
 * (catalog.get("list_mcp_resources").handler). The manager is injected via a
 * stubbed getManager (no real subprocess is started).
 */
import { describe, expect, it } from "vitest";

import type {
  ListResourcesOpts,
  ListResourcesResult,
  McpManager,
  McpPerServerState,
  McpResource,
  ReadResourceResult,
} from "../../../../src/harness/mcp/manager.ts";
import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import { createListMcpResourcesTool } from "../../../../src/harness/aci/tools/list-mcp-resources.ts";

/**
 * Fake McpManager — exposes only listResources / readResource; tests inject
 * the expected return value or trigger a typed error. The remaining interface
 * methods (start/reload/shutdown/status) are irrelevant here; the stubs reject
 * with "not used".
 */
function makeFakeManager(
  listImpl?: (opts?: ListResourcesOpts) => Promise<ListResourcesResult>,
  readImpl?: (server: string, uri: string) => Promise<ReadResourceResult>
): McpManager {
  return {
    start: () => Promise.reject(new Error("not used")),
    reload: () => Promise.reject(new Error("not used")),
    shutdown: () => Promise.resolve(),
    status: () => [],
    listResources:
      listImpl ??
      (() => Promise.reject(new Error("listResources not stubbed"))),
    readResource:
      readImpl ?? (() => Promise.reject(new Error("readResource not stubbed"))),
  } as unknown as McpManager;
}

function sampleResource(
  server: string,
  name: string,
  uri: string,
  extra?: { description?: string; mimeType?: string }
): McpResource {
  return { server, uri, name, ...extra };
}

function samplePerServer(
  server: string,
  state: McpPerServerState["state"],
  nextCursor?: string
): McpPerServerState {
  return nextCursor === undefined
    ? { server, state }
    : { server, state, nextCursor };
}

// =========================================================================
// 1. Happy path
// =========================================================================

describe("createListMcpResourcesTool — normal path", () => {
  it("aggregates resources from all servers when no server specified, wire format has perServer tail", async () => {
    let capturedOpts: ListResourcesOpts | undefined;
    const mgr = makeFakeManager(async (opts) => {
      capturedOpts = opts;
      return {
        resources: [
          sampleResource("alpha", "a1", "x://a/1"),
          sampleResource("beta", "b1", "x://b/1"),
          sampleResource("beta", "b2", "x://b/2"),
        ],
        perServer: [
          samplePerServer("alpha", "connected"),
          samplePerServer("beta", "connected"),
        ],
      };
    });
    const tool = createListMcpResourcesTool({ getManager: () => mgr });

    const out = await tool.handler({}, undefined);

    expect(capturedOpts).toEqual({ signal: undefined });
    const lines = out.split("\n");
    // 3 resources → 3 lines + empty line + `--- perServer ---` + 2 perServer lines
    expect(lines).toHaveLength(3 + 1 + 1 + 2);
    // the first 3 lines: one JSON resource each
    expect(JSON.parse(lines[0]!)).toMatchObject({
      server: "alpha",
      uri: "x://a/1",
      name: "a1",
    });
    expect(JSON.parse(lines[1]!)).toMatchObject({
      server: "beta",
      uri: "x://b/1",
      name: "b1",
    });
    expect(JSON.parse(lines[2]!)).toMatchObject({
      server: "beta",
      uri: "x://b/2",
      name: "b2",
    });
    expect(lines[3]).toBe("");
    expect(lines[4]).toBe("--- perServer ---");
    expect(JSON.parse(lines[5]!)).toEqual({
      server: "alpha",
      state: "connected",
    });
    expect(JSON.parse(lines[6]!)).toEqual({
      server: "beta",
      state: "connected",
    });
  });

  it("scopes to a single server when server specified; cursor passes through", async () => {
    let capturedOpts: ListResourcesOpts | undefined;
    const mgr = makeFakeManager(async (opts) => {
      capturedOpts = opts;
      return {
        resources: [sampleResource("beta", "b1", "x://b/1")],
        perServer: [samplePerServer("beta", "connected", "CURSOR_BETA_2")],
      };
    });
    const tool = createListMcpResourcesTool({ getManager: () => mgr });

    const out = await tool.handler(
      { server: "beta", cursor: "CURSOR_BETA_2" },
      undefined
    );

    expect(capturedOpts).toEqual({
      server: "beta",
      cursor: "CURSOR_BETA_2",
      signal: undefined,
    });
    expect(out).toContain("x://b/1");
    expect(out).toContain("CURSOR_BETA_2");
    // the perServer tail is still kept
    expect(out).toContain("--- perServer ---");
  });

  it("description includes positive triggering conditions (no negative ban words)", () => {
    const mgr = makeFakeManager();
    const tool = createListMcpResourcesTool({ getManager: () => mgr });
    expect(tool.name).toBe("list_mcp_resources");
    expect(tool.description).toContain("list_mcp_resources");
    // positive prompting keywords: list / aggregate / pass server / read_mcp_resource
    expect(tool.description.toLowerCase()).toContain("list");
    expect(tool.description.toLowerCase()).toContain("read");
    // no negative prohibition words
    const banWords = /\b(do not|don'?t|never|avoid|should not|must not)\b/i;
    expect(tool.description).not.toMatch(banWords);
  });

  it("aci metadata: read-only, concurrency-safe, cancel, default tier", () => {
    const tool = createListMcpResourcesTool({
      getManager: () => makeFakeManager(),
    });
    expect(tool.aci).toEqual({
      category: "read-only",
      isConcurrencySafe: true,
      interruptBehavior: "cancel",
      timeoutTier: "default",
    });
  });
});

// =========================================================================
// 2. Empty input
// =========================================================================

describe("createListMcpResourcesTool — empty input", () => {
  it("returns `(no resources)` neutral placeholder when manager returns empty aggregates", async () => {
    const mgr = makeFakeManager(async () => ({
      resources: [],
      perServer: [],
    }));
    const tool = createListMcpResourcesTool({ getManager: () => mgr });

    const out = await tool.handler({}, undefined);
    expect(out).toBe("(no resources)");
  });

  it("returns `(no resources)` even when perServer has entries (diagnostic info preserved separately)", async () => {
    const mgr = makeFakeManager(async () => ({
      resources: [],
      perServer: [
        samplePerServer("alpha", "connected"),
        samplePerServer("beta", "failed"),
      ],
    }));
    const tool = createListMcpResourcesTool({ getManager: () => mgr });

    const out = await tool.handler({}, undefined);
    // perServer info survives: with zero resources the perServer status is still shown
    expect(out).toContain("--- perServer ---");
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
    expect(out).toContain("failed");
  });

  it("omits empty optional server/cursor fields in the JSON wire (no null leak)", async () => {
    const mgr = makeFakeManager(async () => ({
      resources: [
        {
          server: "alpha",
          uri: "x://a/1",
          name: "a1",
          // description / mimeType absent → must not appear in the JSON
        },
      ],
      perServer: [samplePerServer("alpha", "connected")],
    }));
    const tool = createListMcpResourcesTool({ getManager: () => mgr });

    const out = await tool.handler({}, undefined);
    const firstLine = out.split("\n")[0]!;
    const parsed = JSON.parse(firstLine);
    expect(parsed).not.toHaveProperty("description");
    expect(parsed).not.toHaveProperty("mimeType");
    // perServer nextCursor absent → does not appear
    const perServerLine = JSON.parse(out.split("\n").at(-1)!);
    expect(perServerLine).not.toHaveProperty("nextCursor");
  });
});

// =========================================================================
// 3. Invalid input
// =========================================================================

describe("createListMcpResourcesTool — invalid input", () => {
  it("throws ToolExecutionError when input is not an object", async () => {
    const tool = createListMcpResourcesTool({
      getManager: () => makeFakeManager(),
    });
    await expect(tool.handler(null, undefined)).rejects.toBeInstanceOf(
      ToolExecutionError
    );
    await expect(tool.handler("string", undefined)).rejects.toBeInstanceOf(
      ToolExecutionError
    );
    await expect(tool.handler([1, 2], undefined)).rejects.toBeInstanceOf(
      ToolExecutionError
    );
  });

  it("throws ToolExecutionError when server is present but not a string", async () => {
    const tool = createListMcpResourcesTool({
      getManager: () => makeFakeManager(),
    });
    await expect(
      tool.handler({ server: 123 }, undefined)
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("throws ToolExecutionError when cursor is present but not a string", async () => {
    const tool = createListMcpResourcesTool({
      getManager: () => makeFakeManager(),
    });
    await expect(
      tool.handler({ cursor: true }, undefined)
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("treats empty string server as absent (does not pass through)", async () => {
    let capturedOpts: ListResourcesOpts | undefined;
    const mgr = makeFakeManager(async (opts) => {
      capturedOpts = opts;
      return { resources: [], perServer: [] };
    });
    const tool = createListMcpResourcesTool({ getManager: () => mgr });
    await tool.handler({ server: "" }, undefined);
    // an empty-string server counts as absent → the server field is not passed
    expect(capturedOpts).toBeDefined();
    expect(capturedOpts).not.toHaveProperty("server");
  });

  it("propagates ToolExecutionError from manager unchanged (fail-fast passthrough)", async () => {
    const mgr = makeFakeManager(() =>
      Promise.reject(
        new ToolExecutionError(
          "mcp server 'beta' listResources failed: sdk boom"
        )
      )
    );
    const tool = createListMcpResourcesTool({ getManager: () => mgr });
    await expect(tool.handler({}, undefined)).rejects.toThrow(
      /mcp server 'beta' listResources failed/
    );
  });

  it("wraps non-ToolExecutionError from manager as ToolExecutionError", async () => {
    const mgr = makeFakeManager(() => Promise.reject(new Error("sdk down")));
    const tool = createListMcpResourcesTool({ getManager: () => mgr });
    await expect(tool.handler({}, undefined)).rejects.toThrow(
      /\[list_mcp_resources\] list failed/
    );
  });
});

// =========================================================================
// 4. Overflow / boundaries
// =========================================================================

describe("createListMcpResourcesTool — overflow / boundaries", () => {
  it("aggregates 500 resources across multiple servers in stable order", async () => {
    const alphaResources: McpResource[] = [];
    for (let i = 0; i < 300; i += 1) {
      alphaResources.push(sampleResource("alpha", `a${i}`, `x://a/${i}`));
    }
    const betaResources: McpResource[] = [];
    for (let i = 0; i < 200; i += 1) {
      betaResources.push(sampleResource("beta", `b${i}`, `x://b/${i}`));
    }
    const mgr = makeFakeManager(async () => ({
      resources: [...alphaResources, ...betaResources],
      perServer: [
        samplePerServer("alpha", "connected"),
        samplePerServer("beta", "connected"),
      ],
    }));
    const tool = createListMcpResourcesTool({ getManager: () => mgr });
    const out = await tool.handler({}, undefined);
    const all = out.split("\n");
    const idx = all.indexOf("--- perServer ---");
    expect(idx).toBe(501); // 500 resource lines + empty-line separator at idx 500
    const resourceLines = all.slice(0, idx).filter((l) => l.length > 0);
    expect(resourceLines).toHaveLength(500);
    const tail = all.slice(idx + 1).filter((l) => l.length > 0);
    expect(tail).toHaveLength(2); // alpha + beta perServer
  });

  it("inputSchema: additionalProperties false (only server + cursor accepted)", () => {
    const tool = createListMcpResourcesTool({
      getManager: () => makeFakeManager(),
    });
    expect(tool.inputSchema).toMatchObject({ additionalProperties: false });
    const props = tool.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(["cursor", "server"]);
  });
});

// =========================================================================
// 5. Concurrency / exceptions
// =========================================================================

describe("createListMcpResourcesTool — concurrent / exception", () => {
  it("two parallel handler invocations do not share state (each gets fresh manager call)", async () => {
    let calls = 0;
    const mgr = makeFakeManager(async () => {
      calls += 1;
      return {
        resources: [sampleResource("alpha", `r${calls}`, `x://a/${calls}`)],
        perServer: [samplePerServer("alpha", "connected")],
      };
    });
    const tool = createListMcpResourcesTool({ getManager: () => mgr });
    const [a, b] = await Promise.all([
      tool.handler({}, undefined),
      tool.handler({}, undefined),
    ]);
    expect(calls).toBe(2);
    expect(a).not.toBe(b);
  });

  it("manager.listResources receives ctx.signal when handler called with ctx", async () => {
    let capturedOpts: ListResourcesOpts | undefined;
    const mgr = makeFakeManager(async (opts) => {
      capturedOpts = opts;
      return { resources: [], perServer: [] };
    });
    const tool = createListMcpResourcesTool({ getManager: () => mgr });
    const ctrl = new AbortController();
    await tool.handler({}, { signal: ctrl.signal });
    expect(capturedOpts).toBeDefined();
    expect(capturedOpts?.signal).toBe(ctrl.signal);
  });
});
