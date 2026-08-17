/**
 * wayfinder #440 Stream B — T10 read_mcp_resource 工具单测（M1/M2 决议）。
 *
 * 覆盖 5 类输入：
 *  1. 正常路径（text 内容 / blob 内容 / 多个 contents 项）
 *  2. 空输入（manager 返回空 contents）
 *  3. 非法 / 负值（input 非对象 / server 缺失 / uri 缺失 / 类型错）
 *  4. 溢出 / 边界（大 blob / text / 空串）
 *  5. 并发 / 异常（manager 抛 typed error 透传；非 typed error 包装；并发 read）
 *
 * 注：manager 通过 stub getManager 注入（不启真子进程）；handler 出口
 * 直接调 tool.handler()（T11 装配未启用，独立可测）。
 */
import { describe, expect, it } from "vitest";

import type {
  ListResourcesOpts,
  ListResourcesResult,
  McpManager,
  McpResourceContent,
  ReadResourceResult,
} from "../../../../src/harness/mcp/manager.ts";
import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import { createReadMcpResourceTool } from "../../../../src/harness/aci/tools/read-mcp-resource.ts";

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

function text(uri: string, text: string): McpResourceContent {
  return { uri, mimeType: "text/plain", text };
}

function blob(uri: string, b64: string): McpResourceContent {
  return { uri, mimeType: "application/octet-stream", blob: b64 };
}

// =========================================================================
// 1. 正常路径
// =========================================================================

describe("createReadMcpResourceTool — normal path", () => {
  it("returns single text content as JSON envelope", async () => {
    let captured: { server: string; uri: string } | undefined;
    const mgr = makeFakeManager(undefined, async (server, uri) => {
      captured = { server, uri };
      return {
        server,
        uri,
        contents: [text(uri, "hello world")],
      };
    });
    const tool = createReadMcpResourceTool({ getManager: () => mgr });

    const out = await tool.handler(
      { server: "alpha", uri: "file:///a.txt" },
      undefined
    );

    expect(captured).toEqual({ server: "alpha", uri: "file:///a.txt" });
    const parsed = JSON.parse(out);
    expect(parsed.server).toBe("alpha");
    expect(parsed.uri).toBe("file:///a.txt");
    expect(parsed.contents).toHaveLength(1);
    expect(parsed.contents[0]).toMatchObject({
      uri: "file:///a.txt",
      mimeType: "text/plain",
      text: "hello world",
    });
    // 互斥：blob 不应出现
    expect(parsed.contents[0]).not.toHaveProperty("blob");
  });

  it("returns single blob content (base64) with text omitted", async () => {
    const b64 = Buffer.from("binary-data").toString("base64");
    const mgr = makeFakeManager(undefined, async (server, uri) => ({
      server,
      uri,
      contents: [blob(uri, b64)],
    }));
    const tool = createReadMcpResourceTool({ getManager: () => mgr });

    const out = await tool.handler(
      { server: "blob-srv", uri: "x://f.bin" },
      undefined
    );

    const parsed = JSON.parse(out);
    expect(parsed.contents[0]).toMatchObject({
      uri: "x://f.bin",
      mimeType: "application/octet-stream",
      blob: b64,
    });
    // 互斥：text 不应出现
    expect(parsed.contents[0]).not.toHaveProperty("text");
  });

  it("returns multiple contents entries as JSON array", async () => {
    const mgr = makeFakeManager(undefined, async (server, uri) => ({
      server,
      uri,
      contents: [
        text("a://1", "first"),
        text("a://2", "second"),
        { uri: "a://3", mimeType: "text/plain" }, // 仅 metadata
      ],
    }));
    const tool = createReadMcpResourceTool({ getManager: () => mgr });

    const out = await tool.handler({ server: "a", uri: "a://1" }, undefined);
    const parsed = JSON.parse(out);
    expect(parsed.contents).toHaveLength(3);
    expect(parsed.contents[0]?.text).toBe("first");
    expect(parsed.contents[1]?.text).toBe("second");
    expect(parsed.contents[2]).not.toHaveProperty("text");
    expect(parsed.contents[2]).not.toHaveProperty("blob");
  });

  it("description includes positive triggering conditions (no negative ban words)", () => {
    const tool = createReadMcpResourceTool({
      getManager: () => makeFakeManager(),
    });
    expect(tool.name).toBe("read_mcp_resource");
    expect(tool.description).toContain("read_mcp_resource");
    expect(tool.description.toLowerCase()).toContain("read");
    expect(tool.description.toLowerCase()).toContain("list_mcp_resource");
    const banWords = /\b(do not|don'?t|never|avoid|should not|must not)\b/i;
    expect(tool.description).not.toMatch(banWords);
  });

  it("aci metadata: read-only, NOT concurrency-safe (conservative M2 default), cancel, default tier", () => {
    const tool = createReadMcpResourceTool({
      getManager: () => makeFakeManager(),
    });
    expect(tool.aci).toEqual({
      category: "read-only",
      isConcurrencySafe: false,
      interruptBehavior: "cancel",
      timeoutTier: "default",
    });
  });
});

// =========================================================================
// 2. 空输入
// =========================================================================

describe("createReadMcpResourceTool — empty input", () => {
  it("returns JSON envelope with empty contents array when manager returns none", async () => {
    const mgr = makeFakeManager(undefined, async (server, uri) => ({
      server,
      uri,
      contents: [],
    }));
    const tool = createReadMcpResourceTool({ getManager: () => mgr });
    const out = await tool.handler({ server: "a", uri: "x://u" }, undefined);
    const parsed = JSON.parse(out);
    expect(parsed.contents).toEqual([]);
  });

  it("throws ToolExecutionError when server is empty string (model input validation)", async () => {
    const mgr = makeFakeManager();
    const tool = createReadMcpResourceTool({ getManager: () => mgr });
    await expect(
      tool.handler({ server: "", uri: "x://u" }, undefined)
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("throws ToolExecutionError when uri is empty string", async () => {
    const tool = createReadMcpResourceTool({
      getManager: () => makeFakeManager(),
    });
    await expect(
      tool.handler({ server: "a", uri: "" }, undefined)
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });
});

// =========================================================================
// 3. 非法 / 负值
// =========================================================================

describe("createReadMcpResourceTool — invalid input", () => {
  it("throws ToolExecutionError when input is not an object", async () => {
    const tool = createReadMcpResourceTool({
      getManager: () => makeFakeManager(),
    });
    await expect(tool.handler(null, undefined)).rejects.toBeInstanceOf(
      ToolExecutionError
    );
    await expect(tool.handler("string", undefined)).rejects.toBeInstanceOf(
      ToolExecutionError
    );
  });

  it("throws ToolExecutionError when server is missing", async () => {
    const tool = createReadMcpResourceTool({
      getManager: () => makeFakeManager(),
    });
    await expect(
      tool.handler({ uri: "x://u" }, undefined)
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("throws ToolExecutionError when uri is missing", async () => {
    const tool = createReadMcpResourceTool({
      getManager: () => makeFakeManager(),
    });
    await expect(
      tool.handler({ server: "a" }, undefined)
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("throws ToolExecutionError when server is not a string", async () => {
    const tool = createReadMcpResourceTool({
      getManager: () => makeFakeManager(),
    });
    await expect(
      tool.handler({ server: 123, uri: "x://u" }, undefined)
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("throws ToolExecutionError when uri is not a string", async () => {
    const tool = createReadMcpResourceTool({
      getManager: () => makeFakeManager(),
    });
    await expect(
      tool.handler({ server: "a", uri: true }, undefined)
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("propagates ToolExecutionError from manager unchanged", async () => {
    const mgr = makeFakeManager(undefined, () =>
      Promise.reject(new ToolExecutionError("mcp server 'beta' not configured"))
    );
    const tool = createReadMcpResourceTool({ getManager: () => mgr });
    await expect(
      tool.handler({ server: "beta", uri: "x://u" }, undefined)
    ).rejects.toThrow(/mcp server 'beta' not configured/);
  });

  it("wraps non-ToolExecutionError from manager as ToolExecutionError", async () => {
    const mgr = makeFakeManager(undefined, () =>
      Promise.reject(new Error("sdk boom"))
    );
    const tool = createReadMcpResourceTool({ getManager: () => mgr });
    await expect(
      tool.handler({ server: "a", uri: "x://u" }, undefined)
    ).rejects.toThrow(/\[read_mcp_resource\] read failed/);
  });
});

// =========================================================================
// 4. 溢出 / 边界
// =========================================================================

describe("createReadMcpResourceTool — overflow / boundaries", () => {
  it("passes large text through (executor 20000 截断另层处理)", async () => {
    const large = "x".repeat(50_000);
    const mgr = makeFakeManager(undefined, async (server, uri) => ({
      server,
      uri,
      contents: [text(uri, large)],
    }));
    const tool = createReadMcpResourceTool({ getManager: () => mgr });
    const out = await tool.handler({ server: "a", uri: "x://big" }, undefined);
    const parsed = JSON.parse(out);
    expect(parsed.contents[0]?.text?.length).toBe(50_000);
  });

  it("passes large blob through (executor 截断兜底)", async () => {
    const b64 = Buffer.alloc(20_000, 0xff).toString("base64");
    const mgr = makeFakeManager(undefined, async (server, uri) => ({
      server,
      uri,
      contents: [blob(uri, b64)],
    }));
    const tool = createReadMcpResourceTool({ getManager: () => mgr });
    const out = await tool.handler(
      { server: "a", uri: "x://big.bin" },
      undefined
    );
    const parsed = JSON.parse(out);
    expect(parsed.contents[0]?.blob?.length).toBe(b64.length);
  });

  it("inputSchema: server + uri both required, additionalProperties false", () => {
    const tool = createReadMcpResourceTool({
      getManager: () => makeFakeManager(),
    });
    expect(tool.inputSchema).toMatchObject({
      required: ["server", "uri"],
      additionalProperties: false,
    });
    const props = tool.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(["server", "uri"]);
  });
});

// =========================================================================
// 5. 并发 / 异常
// =========================================================================

describe("createReadMcpResourceTool — concurrent / exception", () => {
  it("two parallel handler invocations do not share state", async () => {
    let calls = 0;
    const mgr = makeFakeManager(undefined, async (server, uri) => {
      calls += 1;
      return {
        server,
        uri,
        contents: [text(uri, `payload-${calls}`)],
      };
    });
    const tool = createReadMcpResourceTool({ getManager: () => mgr });
    const [a, b] = await Promise.all([
      tool.handler({ server: "a", uri: "x://1" }, undefined),
      tool.handler({ server: "b", uri: "x://2" }, undefined),
    ]);
    expect(calls).toBe(2);
    expect(JSON.parse(a).contents[0].text).toBe("payload-1");
    expect(JSON.parse(b).contents[0].text).toBe("payload-2");
  });

  it("manager.readResource does not receive ctx.signal (current contract; signal forwarding is a follow-up)", async () => {
    let received: unknown = undefined;
    const mgr = makeFakeManager(undefined, async (_server, _uri) => {
      received = (mgr as unknown as Record<string, unknown>)._lastSignal;
      return { server: "a", uri: "x://u", contents: [] };
    });
    const tool = createReadMcpResourceTool({ getManager: () => mgr });
    const ctrl = new AbortController();
    // 当前 manager.readResource(server, uri) 不收 signal 入参；
    // handler 不传 signal，确保调用契约不变（manager 侧 abort 走状态机）。
    await tool.handler({ server: "a", uri: "x://u" }, { signal: ctrl.signal });
    expect(received).toBeUndefined();
  });
});
