/**
 * Unit tests for the LSP tool set — specs/251-lsp-tool.md testing strategy:
 * input validation of the 8 operation handlers + lsp_diagnostics handler.
 *
 * Coverage:
 *   1. ajv rejects wrong types (file=number etc.) → ToolExecutionError.
 *   2. ajv rejects missing params (position op lacking line/character) → ToolExecutionError.
 *   3. no client (getClient returns undefined) → `"(no LSP server available for file)"`.
 *   4. required fields of the 10 inputSchemas: position ops require file/line/character;
 *      file-only (document_symbol / workspace_symbol / diagnostics) require file only.
 *   5. object results are serialized: mock client.sendRequest returns an object →
 *      handler output is a JSON string, not an object.
 *   6. lsp_diagnostics has no position schema (file is the only required field).
 *   7. aci metadata: read-only / isConcurrencySafe=false / interruptBehavior=cancel /
 *      timeoutTier=default.
 *
 * Mocking: module-level `vi.mock` stubs `getClient` (same vi.hoisted
 * reference-capture approach as client.test.ts), so no real tsserver /
 * vscode-jsonrpc is touched.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToolExecutionError } from "../../../src/harness/errors.ts";

const { mockGetClient, mockGetClientDetailed } = vi.hoisted(() => ({
  mockGetClient: vi.fn<() => Promise<unknown>>(),
  mockGetClientDetailed: vi.fn<() => Promise<unknown>>(),
}));

// The dynamic imports must run after the mock is installed (as in client.test.ts).
// Only getClient is replaced; signalToCancellationToken keeps the real
// implementation (the token-wiring tests need it).
vi.mock("../../../src/harness/lsp/client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/harness/lsp/client.js")>();
  return {
    ...actual,
    getClient: (...args: unknown[]) => mockGetClient(...args),
    // The tool layer goes through getClientDetailed (sentinel tiering); this
    // default delegates to mockGetClient so existing toHaveBeenCalledWith
    // assertions keep working, and a missing client normalizes to a no-server failure.
    getClientDetailed: (...args: unknown[]) => mockGetClientDetailed(...args),
  };
});

import {
  createLspToolSet,
  DEFAULT_LSP_REQUEST_TIMEOUT_MS,
  DIAGNOSTICS_WAIT_MS,
  MAX_RESULT_BYTES,
  isLspFailureSentinel,
  isMethodNotFoundSentinel,
  renderMethodNotFound,
} from "../../../src/harness/aci/tools/lsp.ts";
import {
  createSymbolQueryToolSet,
  SYMBOL_QUERY_TOOL_NAMES,
} from "../../../src/harness/aci/tools/symbol.ts";
import {
  createSymbolMutateToolSet,
  SYMBOL_MUTATE_TOOL_NAMES,
} from "../../../src/harness/aci/tools/symbol-mutate.ts";
import { classifyProbeResult } from "../../../scripts/lsp-probe.ts";
import type { AciToolDef } from "../../../src/harness/aci/types.ts";
import { ToolExecutionError } from "../../../src/harness/errors.ts";

function makeFakeClient(
  responder: (method: string, params: unknown) => unknown,
  capabilities: Record<string, unknown> = {}
) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const opened: string[] = [];
  // Request-scoped lifecycle (spec 251): the fake records open/close events so
  // tests can assert the didOpen window covers the whole request; `opened` is
  // the entry side of that window.
  const closed: string[] = [];
  return {
    calls,
    opened,
    closed,
    client: {
      connection: {} as never,
      process: {} as never,
      // initialize capability advertisement + method-not-found sentinel: the
      // tool layer checks server capabilities for an **explicit** `provider:
      // false` before sending RPC. Default empty object = all absent → send
      // anyway (absent ≠ unsupported).
      getServerCapabilities: () => capabilities,
      // Each handler ensureOpens (sends didOpen) before the request so the
      // tsserver project exists; the fake records which files were opened.
      ensureOpen: async (file: string) => {
        opened.push(file);
      },
      // spec 251: request-scoped scope — the open window covers all of fn,
      // including the throwing path.
      withDocumentOpen: async <T>(
        file: string,
        fn: () => Promise<T>
      ): Promise<T> => {
        opened.push(file);
        try {
          return await fn();
        } finally {
          closed.push(file);
        }
      },
      sendRequest: async (method: string, params: unknown) => {
        calls.push({ method, params });
        return responder(method, params);
      },
      sendNotification: async () => undefined,
      // lsp_diagnostics reads the push cache (latest-wins); the fake defaults
      // to empty. Tests override with `client.getDiagnosticsEntry = () => ({ items })`.
      getDiagnostics: (_uri: string) => [] as ReadonlyArray<unknown>,
      // Diagnostics entry (with pushVersion) + didChange version. Default
      // "first push arrived, no edits" (openVersion=1) → the wait logic
      // returns empty items immediately.
      getDiagnosticsEntry: (_uri: string) =>
        ({ items: [] as ReadonlyArray<unknown> }) as
          | {
              readonly items: ReadonlyArray<unknown>;
              readonly pushVersion?: number;
            }
          | undefined,
      getOpenVersion: (_uri: string) => 1,
      // Cache key for symbol resolution: fingerprint of the synced doc text
      // (client.ts LspClient.getDocumentFingerprint). Constant by default →
      // two resolutions hit the same snapshot; tests override this to
      // simulate out-of-band disk edits.
      getDocumentFingerprint: (_uri: string): string | undefined => "fp-1",
      dispose: () => undefined,
    },
  };
}

const ctx = { directory: "/work" };

function byName(tools: ReadonlyArray<AciToolDef>, name: string): AciToolDef {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool not found: ${name}`);
  return tool;
}

const POSITION_OPS = [
  "lsp_definition",
  "lsp_references",
  "lsp_hover",
  "lsp_go_to_implementation",
  "lsp_prepare_call_hierarchy",
  "lsp_incoming_calls",
  "lsp_outgoing_calls",
] as const;

// lsp_workspace_symbol has file / query both optional, so it is no longer in
// the file-only group; its own schema assertions are in a dedicated describe below.
const FILE_ONLY_OPS = ["lsp_document_symbol", "lsp_diagnostics"] as const;

// lsp_workspace_symbol listed separately (its schema is standalone), but still
// part of the full 10-tool set.
const ALL_TOOL_NAMES = [
  ...POSITION_OPS,
  ...FILE_ONLY_OPS,
  "lsp_workspace_symbol",
] as const;

beforeEach(() => {
  mockGetClient.mockReset();
  mockGetClientDetailed.mockReset();
  // Default: detailed delegates to mockGetClient (same args passed through);
  // undefined → no-server failure.
  mockGetClientDetailed.mockImplementation(async (...args: unknown[]) => {
    const client = (await mockGetClient(...args)) as unknown;
    return client ? { client } : { failure: { reason: "no-server" as const } };
  });
});

describe("createLspToolSet shape", () => {
  it("exports 10 tools (9 operations + lsp_diagnostics)", () => {
    const tools = createLspToolSet(ctx);
    expect(tools).toHaveLength(10);
    expect(tools.map((t) => t.name).sort()).toEqual([...ALL_TOOL_NAMES].sort());
  });

  it("exposes all 10 frozen tool defs", () => {
    for (const tool of createLspToolSet(ctx)) {
      expect(Object.isFrozen(tool)).toBe(true);
    }
  });

  it("sets aci metadata (read-only / non-concurrent / cancel / default tier)", () => {
    for (const tool of createLspToolSet(ctx)) {
      expect(tool.aci.category).toBe("read-only");
      expect(tool.aci.isConcurrencySafe).toBe(false);
      expect(tool.aci.interruptBehavior).toBe("cancel");
      expect(tool.aci.timeoutTier).toBe("default");
    }
  });
});

describe("inputSchema required fields", () => {
  it("position ops require file, line, character", () => {
    const tools = createLspToolSet(ctx);
    for (const name of POSITION_OPS) {
      const schema = byName(tools, name).inputSchema;
      const required = schema.required as string[];
      expect(required).toContain("file");
      expect(required).toContain("line");
      expect(required).toContain("character");
    }
  });

  it("document_symbol requires only file (no position)", () => {
    const tools = createLspToolSet(ctx);
    const schema = byName(tools, "lsp_document_symbol").inputSchema;
    expect(schema.required).toEqual(["file"]);
  });

  it("lsp_diagnostics has no required fields (file / files exclusive, B2)", () => {
    const tools = createLspToolSet(ctx);
    const schema = byName(tools, "lsp_diagnostics").inputSchema;
    expect(schema.required).toBeUndefined();
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties as object).sort()).toEqual([
      "file",
      "files",
    ]);
  });
});

describe("ajv validation", () => {
  it("rejects invalid input types (file must be a string)", async () => {
    mockGetClient.mockResolvedValue(undefined);
    const tools = createLspToolSet(ctx);
    await expect(
      byName(tools, "lsp_definition").handler({ file: 123 })
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("rejects missing line/character for position ops", async () => {
    mockGetClient.mockResolvedValue(undefined);
    const tools = createLspToolSet(ctx);
    await expect(
      byName(tools, "lsp_definition").handler({ file: "x.ts" })
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("rejects non-integer line", async () => {
    mockGetClient.mockResolvedValue(undefined);
    const tools = createLspToolSet(ctx);
    await expect(
      byName(tools, "lsp_definition").handler({
        file: "x.ts",
        line: 1.5,
        character: 0,
      })
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("rejects line below minimum (1-based)", async () => {
    mockGetClient.mockResolvedValue(undefined);
    const tools = createLspToolSet(ctx);
    await expect(
      byName(tools, "lsp_definition").handler({
        file: "x.ts",
        line: 0,
        character: 0,
      })
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("rejects character below minimum (0-based)", async () => {
    mockGetClient.mockResolvedValue(undefined);
    const tools = createLspToolSet(ctx);
    await expect(
      byName(tools, "lsp_definition").handler({
        file: "x.ts",
        line: 1,
        character: -1,
      })
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("rejects extra properties (additionalProperties: false)", async () => {
    mockGetClient.mockResolvedValue(undefined);
    const tools = createLspToolSet(ctx);
    await expect(
      byName(tools, "lsp_definition").handler({
        file: "x.ts",
        line: 1,
        character: 0,
        extra: true,
      })
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });
});

describe("no client path", () => {
  it("returns the tiered no-server sentinel when no client is available (B3)", async () => {
    mockGetClient.mockResolvedValue(undefined);
    const tools = createLspToolSet(ctx);
    for (const name of ALL_TOOL_NAMES) {
      const input =
        name === "lsp_diagnostics" ||
        name === "lsp_document_symbol" ||
        name === "lsp_workspace_symbol"
          ? { file: "x.ts" }
          : { file: "x.ts", line: 1, character: 0 };
      const out = (await byName(tools, name).handler(input)) as string;
      expect(out).toMatch(
        /^\(no LSP server configured for x\.ts; supported extensions: /
      );
    }
  });
});

describe("contract Y1 — pure string output", () => {
  it("returns a JSON string for a structured sendRequest result", async () => {
    const { client } = makeFakeClient(() => ({ some: "object", n: 42 }));
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const out = await byName(tools, "lsp_definition").handler({
      file: "x.ts",
      line: 1,
      character: 0,
    });
    expect(typeof out).toBe("string");
    expect(JSON.parse(out as string)).toEqual({ some: "object", n: 42 });
  });
});

describe("operation params mapping", () => {
  it("lsp_definition sends textDocument/definition with 0-based position", async () => {
    const { client, calls } = makeFakeClient(() => []);
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await byName(tools, "lsp_definition").handler({
      file: "/work/src/a.ts",
      line: 3,
      character: 2,
    });
    expect(calls[0].method).toBe("textDocument/definition");
    expect(calls[0].params).toEqual({
      textDocument: { uri: "file:///work/src/a.ts" },
      position: { line: 2, character: 2 },
    });
  });

  it("lsp_references adds includeDeclaration context", async () => {
    const { client, calls } = makeFakeClient(() => []);
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await byName(tools, "lsp_references").handler({
      file: "/work/src/a.ts",
      line: 3,
      character: 2,
    });
    expect(calls[0].method).toBe("textDocument/references");
    expect(calls[0].params).toMatchObject({
      context: { includeDeclaration: true },
    });
  });

  it("lsp_hover sends textDocument/hover", async () => {
    const { client, calls } = makeFakeClient(() => ({}));
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await byName(tools, "lsp_hover").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    });
    expect(calls[0].method).toBe("textDocument/hover");
  });

  it("lsp_document_symbol sends textDocument/documentSymbol without position", async () => {
    const { client, calls } = makeFakeClient(() => []);
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await byName(tools, "lsp_document_symbol").handler({
      file: "/work/src/a.ts",
    });
    expect(calls[0].method).toBe("textDocument/documentSymbol");
    expect(calls[0].params).toEqual({
      textDocument: { uri: "file:///work/src/a.ts" },
    });
  });

  it("lsp_workspace_symbol sends workspace/symbol with empty query", async () => {
    const { client, calls } = makeFakeClient(() => []);
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await byName(tools, "lsp_workspace_symbol").handler({
      file: "/work/src/a.ts",
    });
    expect(calls[0].method).toBe("workspace/symbol");
    expect(calls[0].params).toEqual({ query: "" });
  });

  it("lsp_go_to_implementation sends textDocument/implementation", async () => {
    const { client, calls } = makeFakeClient(() => []);
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await byName(tools, "lsp_go_to_implementation").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    });
    expect(calls[0].method).toBe("textDocument/implementation");
  });

  it("lsp_prepare_call_hierarchy sends textDocument/prepareCallHierarchy", async () => {
    const { client, calls } = makeFakeClient(() => []);
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await byName(tools, "lsp_prepare_call_hierarchy").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    });
    expect(calls[0].method).toBe("textDocument/prepareCallHierarchy");
  });
});

describe("call hierarchy multi-step forwarding", () => {
  it("lsp_incoming_calls prepares items then forwards callHierarchy/incomingCalls", async () => {
    const item = { name: "foo", uri: "file:///work/src/a.ts", range: {} };
    const { client, calls } = makeFakeClient((method) =>
      method === "textDocument/prepareCallHierarchy" ? [item] : []
    );
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await byName(tools, "lsp_incoming_calls").handler({
      file: "/work/src/a.ts",
      line: 2,
      character: 1,
    });
    expect(calls[0].method).toBe("textDocument/prepareCallHierarchy");
    expect(calls[1].method).toBe("callHierarchy/incomingCalls");
    expect(calls[1].params).toEqual({ item });
  });

  it("lsp_outgoing_calls forwards callHierarchy/outgoingCalls", async () => {
    const item = { name: "bar", uri: "file:///work/src/a.ts", range: {} };
    const { client, calls } = makeFakeClient((method) =>
      method === "textDocument/prepareCallHierarchy" ? [item] : []
    );
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await byName(tools, "lsp_outgoing_calls").handler({
      file: "/work/src/a.ts",
      line: 2,
      character: 1,
    });
    expect(calls[1].method).toBe("callHierarchy/outgoingCalls");
    expect(calls[1].params).toEqual({ item });
  });

  it("returns empty string when prepareCallHierarchy yields no item", async () => {
    const { client } = makeFakeClient(() => []);
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const out = await byName(tools, "lsp_incoming_calls").handler({
      file: "/work/src/a.ts",
      line: 2,
      character: 1,
    });
    expect(out).toBe("[]");
  });
});

describe("lsp_diagnostics", () => {
  it("filters severity 0 (hint) and renders <diagnostics> XML summary", async () => {
    const items = [
      {
        severity: 1,
        range: { start: { line: 0, character: 0 } },
        message: "err msg",
      },
      {
        severity: 2,
        range: { start: { line: 1, character: 4 } },
        message: "warn msg",
      },
      {
        severity: 0,
        range: { start: { line: 2, character: 0 } },
        message: "hint msg",
      },
    ];
    const { client } = makeFakeClient(() => undefined);
    (
      client as unknown as {
        getDiagnosticsEntry: (uri: string) =>
          | {
              readonly items: ReadonlyArray<unknown>;
              readonly pushVersion?: number;
            }
          | undefined;
      }
    ).getDiagnosticsEntry = () => ({ items });
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const out = await byName(tools, "lsp_diagnostics").handler({
      file: "/work/src/a.ts",
    });
    expect(typeof out).toBe("string");
    expect(out).toContain('<diagnostics file="/work/src/a.ts">');
    expect(out).toContain("error 1:0 err msg");
    expect(out).toContain("warning 2:4 warn msg");
    expect(out).not.toContain("hint msg");
    expect(out).toContain("</diagnostics>");
  });

  it("caps entries at 20 per file and reports truncation", async () => {
    const items = Array.from({ length: 25 }, (_, i) => ({
      severity: 1,
      range: { start: { line: i, character: 0 } },
      message: `msg ${i}`,
    }));
    const { client } = makeFakeClient(() => undefined);
    (
      client as unknown as {
        getDiagnosticsEntry: (uri: string) =>
          | {
              readonly items: ReadonlyArray<unknown>;
              readonly pushVersion?: number;
            }
          | undefined;
      }
    ).getDiagnosticsEntry = () => ({ items });
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const out = await byName(tools, "lsp_diagnostics").handler({
      file: "/work/src/a.ts",
    });
    expect(out).toContain("...(");
    expect(out).toContain("total 25");
    const shownCount = (out.match(/^error/gm) ?? []).length;
    expect(shownCount).toBe(20);
  });

  it("rejects file and files together (exactly-one-of, B2)", async () => {
    const tools = createLspToolSet(ctx);
    await expect(
      byName(tools, "lsp_diagnostics").handler({
        file: "/work/src/a.ts",
        files: ["/work/src/b.ts"],
      })
    ).rejects.toThrow("exactly one of `file` or `files`");
    await expect(byName(tools, "lsp_diagnostics").handler({})).rejects.toThrow(
      "exactly one of `file` or `files`"
    );
  });

  it("diagnostics filter drops severity < 1 (negative and zero), keeps positive", async () => {
    const items = [
      {
        severity: -1,
        range: { start: { line: 0, character: 0 } },
        message: "neg msg",
      },
      {
        severity: 0,
        range: { start: { line: 1, character: 0 } },
        message: "zero msg",
      },
      {
        severity: 1,
        range: { start: { line: 2, character: 0 } },
        message: "err msg",
      },
    ];
    const { client } = makeFakeClient(() => undefined);
    (
      client as unknown as {
        getDiagnosticsEntry: (uri: string) =>
          | {
              readonly items: ReadonlyArray<unknown>;
              readonly pushVersion?: number;
            }
          | undefined;
      }
    ).getDiagnosticsEntry = () => ({ items });
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const out = await byName(tools, "lsp_diagnostics").handler({
      file: "/work/src/a.ts",
    });
    // the production filter keeps `severity >= 1`, so both -1 and 0 are
    // dropped and only severity=1 survives.
    expect(out).not.toContain("neg msg");
    expect(out).not.toContain("zero msg");
    expect(out).toContain("err msg");
  });
});

// ── stringifyResult(undefined) → "" ─────────────────────────────────────────
//
// Anchor in lsp.ts: `if (result === undefined) return "";` (pure-string output).

describe("undefined sendRequest result", () => {
  it("undefined sendRequest result renders empty string", async () => {
    const { client } = makeFakeClient(() => undefined);
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const out = await byName(tools, "lsp_definition").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    });
    expect(out).toBe("");
  });
});

// ── handler-layer cancel token wiring ───────────────────────────────────────
//
// Anchored on lsp.ts makeOperationTool and makeCallHierarchyCallTool: when
// `execCtx?.signal` exists it is bridged into a token passed as the 3rd
// argument to client.sendRequest, and `cancel?.dispose()` runs after the request.

describe("handler cancel token wiring", () => {
  it("position tool forwards cancellation token and disposes after request", async () => {
    const gotMethod: string[] = [];
    const sentArgs: unknown[] = [];
    const fakeClient = {
      connection: {} as never,
      process: {} as never,
      // capability absent → send anyway (absent ≠ unsupported).
      getServerCapabilities: () => ({}),
      ensureOpen: async () => undefined,
      withDocumentOpen: async <T>(
        _file: string,
        fn: () => Promise<T>
      ): Promise<T> => fn(),
      sendRequest: async (method: string, params: unknown, token?: unknown) => {
        gotMethod.push(method);
        sentArgs.push(token);
        return [];
      },
      sendNotification: async () => undefined,
      getDiagnostics: () => [] as ReadonlyArray<unknown>,
      dispose: () => undefined,
    };
    mockGetClient.mockResolvedValue(fakeClient);

    const tools = createLspToolSet(ctx);
    const signal = new AbortController().signal;
    // dispose() runs removeEventListener("abort", onAbort) → assert removal.
    const removeSpy = vi.spyOn(signal, "removeEventListener");
    // given execCtx.signal → bridged token → 3rd argument is defined.
    await byName(tools, "lsp_definition").handler(
      { file: "/work/src/a.ts", line: 1, character: 0 },
      { signal }
    );

    expect(gotMethod).toEqual(["textDocument/definition"]);
    expect(sentArgs).toHaveLength(1);
    // the 3rd argument is a vscode-jsonrpc CancellationToken.
    expect(sentArgs[0]).toBeDefined();
    expect(sentArgs[0]).toHaveProperty("isCancellationRequested", false);
    // cancel.dispose() was called → the "abort" listener is removed.
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("call-hierarchy tool forwards token on both requests and disposes after", async () => {
    const item = { name: "foo", uri: "file:///work/src/a.ts", range: {} };
    const sentTokens: unknown[] = [];
    const fakeClient = {
      connection: {} as never,
      process: {} as never,
      // capability absent → send anyway (absent ≠ unsupported).
      getServerCapabilities: () => ({}),
      ensureOpen: async () => undefined,
      withDocumentOpen: async <T>(
        _file: string,
        fn: () => Promise<T>
      ): Promise<T> => fn(),
      sendRequest: async (
        method: string,
        _params: unknown,
        token?: unknown
      ) => {
        sentTokens.push(token);
        return method === "textDocument/prepareCallHierarchy" ? [item] : [];
      },
      sendNotification: async () => undefined,
      getDiagnostics: () => [] as ReadonlyArray<unknown>,
      dispose: () => undefined,
    };
    mockGetClient.mockResolvedValue(fakeClient);

    const tools = createLspToolSet(ctx);
    const signal = new AbortController().signal;
    // the call-hierarchy handler bridges a token for each of its two
    // sendRequests and calls cancel.dispose() in finally after each →
    // removeEventListener("abort", fn). Spy on the signal's
    // removeEventListener: it must be called at least twice.
    const removeSpy = vi.spyOn(signal, "removeEventListener");
    await byName(tools, "lsp_incoming_calls").handler(
      { file: "/work/src/a.ts", line: 2, character: 1 },
      { signal }
    );

    // both sendRequests received a token (not undefined).
    expect(sentTokens).toHaveLength(2);
    for (const t of sentTokens) expect(t).toBeDefined();
    // cancel.dispose() ran after each sendRequest → "abort" listeners removed.
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

// ── boundary cases: aci/tools/lsp.ts (overflow / negative / empty / exception)
// Reuses the existing makeFakeClient / mockGetClient infrastructure. Covers:
//   - lsp_diagnostics cap/truncation detail (total 25 → show 20 + truncation note)
//   - MAX_SAFE_INTEGER line/character pass through
//   - empty-string file passes through
//   - sendRequest throwing → handler still returns a plain string, no throw

describe("lsp_diagnostics cap at exactly 20 (overflow)", () => {
  it("renders exactly 20 lines and reports total when over cap", async () => {
    const items = Array.from({ length: 30 }, (_, i) => ({
      severity: 1,
      range: { start: { line: i, character: 0 } },
      message: `msg ${i}`,
    }));
    const { client } = makeFakeClient(() => undefined);
    (
      client as unknown as {
        getDiagnosticsEntry: (uri: string) =>
          | {
              readonly items: ReadonlyArray<unknown>;
              readonly pushVersion?: number;
            }
          | undefined;
      }
    ).getDiagnosticsEntry = () => ({ items });
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const out = await byName(tools, "lsp_diagnostics").handler({
      file: "/work/src/a.ts",
    });
    const shown = (out.match(/^error/gm) ?? []).length;
    expect(shown).toBe(20); // capped at 20 entries
    expect(out).toContain("total 30");
    expect(out).toContain("(10 more issue(s) truncated");
  });

  it("exactly 20 items shows no truncation marker", async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      severity: 1,
      range: { start: { line: i, character: 0 } },
      message: `msg ${i}`,
    }));
    const { client } = makeFakeClient(() => undefined);
    (
      client as unknown as {
        getDiagnosticsEntry: (uri: string) =>
          | {
              readonly items: ReadonlyArray<unknown>;
              readonly pushVersion?: number;
            }
          | undefined;
      }
    ).getDiagnosticsEntry = () => ({ items });
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const out = await byName(tools, "lsp_diagnostics").handler({
      file: "/work/src/a.ts",
    });
    expect(out).not.toContain("truncated");
    expect(out).not.toContain("total 20");
  });
});

describe("overflow line/character MAX_SAFE_INTEGER (overflow)", () => {
  it("accepts line=MAX_SAFE_INTEGER (valid integer ≥ 1)", async () => {
    const { client, calls } = makeFakeClient(() => []);
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const MAX = Number.MAX_SAFE_INTEGER;
    await byName(tools, "lsp_definition").handler({
      file: "/work/src/a.ts",
      line: MAX,
      character: 0,
    });
    expect(calls[0].method).toBe("textDocument/definition");
    expect(calls[0].params).toEqual({
      textDocument: { uri: "file:///work/src/a.ts" },
      position: { line: MAX - 1, character: 0 },
    });
  });

  it("accepts character=MAX_SAFE_INTEGER", async () => {
    const { client, calls } = makeFakeClient(() => []);
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const MAX = Number.MAX_SAFE_INTEGER;
    await byName(tools, "lsp_hover").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: MAX,
    });
    expect(calls[0].method).toBe("textDocument/hover");
  });
});

describe("empty-string file passes ajv (empty)", () => {
  it("file:'' passes file-only schema and routes to getClient", async () => {
    const { client } = makeFakeClient(() => []);
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const out = await byName(tools, "lsp_document_symbol").handler({
      file: "",
    });
    expect(typeof out).toBe("string");
    expect(mockGetClient).toHaveBeenCalledWith(ctx, "");
  });
});

describe("initialize handshake failure propagates as tool error (exception)", () => {
  it("sendRequest throw (spawn-ok but initialize reject) rejects, not stringified", async () => {
    const { client } = makeFakeClient(() => {
      throw new Error("initialize handshake failed");
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await expect(
      byName(tools, "lsp_definition").handler({
        file: "/work/src/a.ts",
        line: 1,
        character: 0,
      })
    ).rejects.toThrow("initialize handshake failed");
  });

  it("diagnostics handler tolerates getDiagnostics returning non-array (empty)", async () => {
    const { client } = makeFakeClient(() => undefined);
    (
      client as unknown as {
        getDiagnosticsEntry: () =>
          | {
              readonly items: ReadonlyArray<unknown>;
              readonly pushVersion?: number;
            }
          | undefined;
      }
    ).getDiagnosticsEntry = () => undefined;
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    // With the read-ahead wait in place, getDiagnosticsEntry=undefined triggers
    // a bounded wait (DIAGNOSTICS_WAIT_MS) — drive fake timers to the deadline
    // instead of really waiting.
    vi.useFakeTimers();
    try {
      const p = byName(tools, "lsp_diagnostics").handler({
        file: "/work/src/a.ts",
      });
      await vi.advanceTimersByTimeAsync(DIAGNOSTICS_WAIT_MS);
      const out = await p;
      expect(typeof out).toBe("string");
      expect(out).toContain("<diagnostics");
      expect(out).toContain("</diagnostics>");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── handler-layer ensureOpen (textDocument/didOpen) wiring ──────────────────
//
// Anchored on client.ts LspClient.ensureOpen + each lsp.ts handler: tsserver
// builds no project for files it never opened, so symbol operations
// (definition/document_symbol/workspace_symbol/hover/implementation/
// call_hierarchy/diagnostics) all return empty. Handlers must ensureOpen(file)
// before every sendRequest / getDiagnostics; the fake client pushes into
// opened[] for the assertions.
//
// Coverage:
//   - each handler calls ensureOpen(file) once
//   - calling the same handler twice: the second didOpen dedupe lives in the real client
//   - same file across handlers
//   - ensureOpen happens before sendRequest (await ordering)

describe("handler ensureOpen before request (textDocument/didOpen)", () => {
  it("lsp_definition calls ensureOpen with the file", async () => {
    const { client, opened } = makeFakeClient(() => []);
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await byName(tools, "lsp_definition").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    });
    expect(opened).toEqual(["/work/src/a.ts"]);
  });

  it("lsp_hover calls ensureOpen with the file", async () => {
    const { client, opened } = makeFakeClient(() => ({}));
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await byName(tools, "lsp_hover").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    });
    expect(opened).toEqual(["/work/src/a.ts"]);
  });

  it("lsp_document_symbol calls ensureOpen with the file", async () => {
    const { client, opened } = makeFakeClient(() => []);
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await byName(tools, "lsp_document_symbol").handler({
      file: "/work/src/a.ts",
    });
    expect(opened).toEqual(["/work/src/a.ts"]);
  });

  it("lsp_workspace_symbol calls ensureOpen with the file", async () => {
    const { client, opened } = makeFakeClient(() => []);
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await byName(tools, "lsp_workspace_symbol").handler({
      file: "/work/src/a.ts",
    });
    expect(opened).toEqual(["/work/src/a.ts"]);
  });

  it("lsp_diagnostics calls ensureOpen with the file", async () => {
    const { client, opened } = makeFakeClient(() => undefined);
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await byName(tools, "lsp_diagnostics").handler({
      file: "/work/src/a.ts",
    });
    expect(opened).toEqual(["/work/src/a.ts"]);
  });

  it("call-hierarchy tools (incoming/outgoing) call ensureOpen with the file", async () => {
    const item = { name: "x", uri: "file:///work/src/a.ts", range: {} };
    const { client, opened } = makeFakeClient((method) =>
      method === "textDocument/prepareCallHierarchy" ? [item] : []
    );
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await byName(tools, "lsp_incoming_calls").handler({
      file: "/work/src/a.ts",
      line: 2,
      character: 1,
    });
    await byName(tools, "lsp_outgoing_calls").handler({
      file: "/work/src/a.ts",
      line: 2,
      character: 1,
    });
    // two calls → two ensureOpen entries (the fake just accumulates; dedupe
    // is the real client.ts job). This asserts the handler keeps ensureOpen in
    // its flow instead of letting the multi-step call-hierarchy path swallow it.
    expect(opened).toEqual(["/work/src/a.ts", "/work/src/a.ts"]);
  });

  it("didOpen window covers the request (open → request → close)", async () => {
    // spec 251 lifecycle contract: handlers no longer call ensureOpen bare but
    // use request-scoped opening — the didOpen window must wrap the whole
    // sendRequest and close on exit (the file is not left open between calls).
    const sequence: string[] = [];
    const fakeClient = {
      connection: {} as never,
      process: {} as never,
      // capability absent → send anyway (absent ≠ unsupported).
      getServerCapabilities: () => ({}),
      ensureOpen: async (_file: string) => {
        sequence.push("didOpen");
      },
      withDocumentOpen: async <T>(
        _file: string,
        fn: () => Promise<T>
      ): Promise<T> => {
        sequence.push("didOpen");
        try {
          return await fn();
        } finally {
          sequence.push("didClose");
        }
      },
      sendRequest: async (_method: string, _params: unknown) => {
        sequence.push("sendRequest");
        return [];
      },
      sendNotification: async () => undefined,
      getDiagnostics: () => [] as ReadonlyArray<unknown>,
      dispose: () => undefined,
    };
    mockGetClient.mockResolvedValue(fakeClient);
    const tools = createLspToolSet(ctx);
    await byName(tools, "lsp_definition").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    });
    expect(sequence).toEqual(["didOpen", "sendRequest", "didClose"]);
  });
});

// ── lsp_workspace_symbol relaxed schema ─────────────────────────────────────
//
// file is now optional (a workspace-level query needs no file anchor) and
// query is a new optional field (the old implementation always sent "").
// Covers: no required fields / additionalProperties:false / query passes
// through buildParams / missing file probes SERVERS in order (first probe is
// the TypeScript pseudo-path) / invalid query rejected.

describe("lsp_workspace_symbol schema (plan T3)", () => {
  it("schema has no required fields but keeps additionalProperties:false", () => {
    const tools = createLspToolSet(ctx);
    const schema = byName(tools, "lsp_workspace_symbol").inputSchema;
    expect(schema.required).toBeUndefined();
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties as object).sort()).toEqual([
      "file",
      "query",
    ]);
  });

  it("empty input (no file, no query) passes validation and sends empty query", async () => {
    const { client, calls, opened } = makeFakeClient(() => []);
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const out = await byName(tools, "lsp_workspace_symbol").handler({});
    expect(out).toBe("[]");
    expect(calls[0].method).toBe("workspace/symbol");
    expect(calls[0].params).toEqual({ query: "" });
    // no file → nothing to open, so ensureOpen must not be called.
    expect(opened).toEqual([]);
  });

  it("omitted file resolves a client by probing SERVERS in declaration order (first = Typescript)", async () => {
    const { client } = makeFakeClient(() => []);
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await byName(tools, "lsp_workspace_symbol").handler({ query: "foo" });
    // First probe: Typescript.extensions[0] = ".ts" joined under ctx.directory.
    expect(mockGetClient).toHaveBeenCalledWith(
      ctx,
      "/work/iknow-workspace.ts",
      expect.objectContaining({
        server: expect.objectContaining({ id: "typescript" }),
      })
    );
  });

  it("passes optional query through to buildParams (file present)", async () => {
    const { client, calls } = makeFakeClient(() => []);
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await byName(tools, "lsp_workspace_symbol").handler({
      file: "/work/src/a.ts",
      query: "parseConfig",
    });
    expect(calls[0].method).toBe("workspace/symbol");
    expect(calls[0].params).toEqual({ query: "parseConfig" });
  });

  it("rejects non-string query and extra properties", async () => {
    mockGetClient.mockResolvedValue(undefined);
    const tools = createLspToolSet(ctx);
    await expect(
      byName(tools, "lsp_workspace_symbol").handler({ query: 42 })
    ).rejects.toBeInstanceOf(ToolExecutionError);
    await expect(
      byName(tools, "lsp_workspace_symbol").handler({ extra: true })
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });
});

// ── output size cap ─────────────────────────────────────────────────────────
//
// stringifyResult caps output at MAX_RESULT_BYTES (48KB): larger input is
// truncated and gets a footer, N being the exact byte count. Only the
// stringified result is truncated.

describe("stringifyResult cap (plan T3)", () => {
  it("truncates oversized results with a byte-count footer", async () => {
    const big = "x".repeat(MAX_RESULT_BYTES + 10_000);
    const { client } = makeFakeClient(() => ({ blob: big }));
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const out = (await byName(tools, "lsp_definition").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    })) as string;
    const total = Buffer.byteLength(
      JSON.stringify({ blob: big }, null, 2),
      "utf8"
    );
    // Footer format: `...[truncated, N of M bytes shown]`, N = bytes actually shown.
    const match = /\.\.\.\[truncated, (\d+) of (\d+) bytes shown\]$/.exec(out);
    expect(match).not.toBeNull();
    expect(match?.[2]).toBe(String(total));
    // N = exact bytes of the shown body = out's total bytes - footer bytes (incl. newline).
    const footer = `\n...[truncated, ${match?.[1]} of ${match?.[2]} bytes shown]`;
    expect(match?.[1]).toBe(
      String(Buffer.byteLength(out, "utf8") - Buffer.byteLength(footer, "utf8"))
    );
    // shown body ≤ 48KB cap and the footer is bounded → total stays near the cap.
    expect(Number(match?.[1])).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThan(MAX_RESULT_BYTES + 200);
  });

  it("leaves results at or below the cap untouched (no footer)", async () => {
    const { client } = makeFakeClient(() => ({ blob: "y".repeat(1024) }));
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const out = (await byName(tools, "lsp_definition").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    })) as string;
    expect(out).not.toContain("truncated");
    expect(JSON.parse(out)).toEqual({ blob: "y".repeat(1024) });
  });
});

// ── lsp_diagnostics read-ahead wait ─────────────────────────────────────────
//
// After ensureOpen the pushed diagnostics may not have arrived yet, so reading
// immediately would wrongly report empty. Fake timers drive the poll:
//   - first poll already has data → return without any timer;
//   - data arrives during polling → wait for it;
//   - deadline reached → use whatever exists (undefined → empty render);
//   - signal aborted → end the wait at once.

describe("lsp_diagnostics wait for first push (plan T3)", () => {
  function diagItem(message: string) {
    return {
      severity: 1,
      range: { start: { line: 0, character: 0 } },
      message,
    };
  }

  it("returns immediately when diagnostics are already cached (first poll hits)", async () => {
    const { client } = makeFakeClient(() => undefined);
    (
      client as unknown as {
        getDiagnosticsEntry: () =>
          | {
              readonly items: ReadonlyArray<unknown>;
              readonly pushVersion?: number;
            }
          | undefined;
      }
    ).getDiagnosticsEntry = () => ({ items: [diagItem("cached err")] });
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const out = (await byName(tools, "lsp_diagnostics").handler({
      file: "/work/src/a.ts",
    })) as string;
    expect(out).toContain("cached err");
  });

  it("waits for the diagnostics push to arrive within the deadline", async () => {
    vi.useFakeTimers();
    try {
      const items = [diagItem("late err")];
      let polls = 0;
      const { client } = makeFakeClient(() => undefined);
      (
        client as unknown as {
          getDiagnosticsEntry: () =>
            | {
                readonly items: ReadonlyArray<unknown>;
                readonly pushVersion?: number;
              }
            | undefined;
        }
      ).getDiagnosticsEntry = () => {
        polls += 1;
        return polls >= 3 ? { items } : undefined;
      };
      mockGetClient.mockResolvedValue(client);
      const tools = createLspToolSet(ctx);
      const p = byName(tools, "lsp_diagnostics").handler({
        file: "/work/src/a.ts",
      }) as Promise<string>;
      await vi.advanceTimersByTimeAsync(250); // 3rd poll hits after two 100ms polls
      const out = await p;
      expect(out).toContain("late err");
      expect(polls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up at the deadline and renders empty diagnostics", async () => {
    vi.useFakeTimers();
    try {
      const { client } = makeFakeClient(() => undefined);
      (
        client as unknown as {
          getDiagnosticsEntry: () =>
            | {
                readonly items: ReadonlyArray<unknown>;
                readonly pushVersion?: number;
              }
            | undefined;
        }
      ).getDiagnosticsEntry = () => undefined;
      mockGetClient.mockResolvedValue(client);
      const tools = createLspToolSet(ctx);
      const p = byName(tools, "lsp_diagnostics").handler({
        file: "/work/src/a.ts",
      }) as Promise<string>;
      await vi.advanceTimersByTimeAsync(DIAGNOSTICS_WAIT_MS + 100);
      const out = await p;
      expect(out).toContain('<diagnostics file="/work/src/a.ts">');
      expect(out).toContain("</diagnostics>");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends the wait early when execCtx.signal aborts", async () => {
    vi.useFakeTimers();
    try {
      const { client } = makeFakeClient(() => undefined);
      (
        client as unknown as {
          getDiagnosticsEntry: () =>
            | {
                readonly items: ReadonlyArray<unknown>;
                readonly pushVersion?: number;
              }
            | undefined;
        }
      ).getDiagnosticsEntry = () => undefined;
      mockGetClient.mockResolvedValue(client);
      const tools = createLspToolSet(ctx);
      const ac = new AbortController();
      const p = byName(tools, "lsp_diagnostics").handler(
        { file: "/work/src/a.ts" },
        { signal: ac.signal }
      ) as Promise<string>;
      ac.abort(); // first poll missed → abort ends the wait before the deadline
      await vi.advanceTimersByTimeAsync(100);
      const out = await p;
      expect(out).toContain("<diagnostics");
      // only the single 100ms sleep pending at abort time was consumed.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── per-request timeout (implemented at the tool layer) ─────────────────────
//
// The timer fires at DEFAULT_LSP_REQUEST_TIMEOUT_MS → CancellationTokenSource.cancel()
// (real vscode-jsonrpc token semantics: cancelling sends $/cancelRequest to the
// server without killing the process) → the pending sendRequest rejects → the
// tool translates it into a ToolExecutionError.

describe("per-request timeout (plan T1)", () => {
  it("cancels via token at 20s and throws ToolExecutionError with timeout message", async () => {
    const { client } = makeFakeClient(() => undefined);
    // A hanging sendRequest: it only rejects once the token is cancelled
    // (mirroring vscode-jsonrpc's RequestCancelled for a cancelled pending request).
    (client as unknown as { sendRequest: unknown }).sendRequest = (
      _method: string,
      _params: unknown,
      token: { onCancellationRequested(cb: () => void): unknown }
    ) =>
      new Promise((_resolve, reject) => {
        token.onCancellationRequested(() =>
          reject(new Error("Request cancelled"))
        );
      });
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);

    vi.useFakeTimers();
    try {
      const p = byName(tools, "lsp_definition").handler({
        file: "/work/src/a.ts",
        line: 1,
        character: 0,
      });
      const expectation = expect(p).rejects.toThrow(
        "[lsp_definition] LSP request textDocument/definition timed out after 20s (cancelled)"
      );
      await vi.advanceTimersByTimeAsync(DEFAULT_LSP_REQUEST_TIMEOUT_MS + 1);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire the timeout timer for requests that settle in time", async () => {
    const { client, calls } = makeFakeClient(() => ({ ok: true }));
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const out = (await byName(tools, "lsp_definition").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    })) as string;
    expect(JSON.parse(out)).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
  });
});

// ── batch diagnostics (files) ───────────────────────────────────────────────
//
// Covers: mutual-exclusion error (in the schema describe above) / cap of 10 /
// grouped output (one `<diagnostics file=...>` segment per file, blank line
// between segments) / a no-server file degrading into a sentinel segment.

describe("lsp_diagnostics batch files (B2)", () => {
  function diagItem(message: string) {
    return {
      severity: 1,
      range: { start: { line: 0, character: 0 } },
      message,
    };
  }

  it("renders one <diagnostics> segment per file, blank-line separated", async () => {
    const { client } = makeFakeClient(() => undefined);
    (
      client as unknown as {
        getDiagnosticsEntry: () =>
          | {
              readonly items: ReadonlyArray<unknown>;
              readonly pushVersion?: number;
            }
          | undefined;
      }
    ).getDiagnosticsEntry = () => ({ items: [diagItem("batch err")] });
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const out = (await byName(tools, "lsp_diagnostics").handler({
      files: ["/work/src/a.ts", "/work/src/b.ts"],
    })) as string;
    expect(out).toContain('<diagnostics file="/work/src/a.ts">');
    expect(out).toContain('<diagnostics file="/work/src/b.ts">');
    expect(out).toContain("batch err");
    // segments separated by a blank line: `</diagnostics>\n\n<diagnostics`.
    expect(out).toContain("</diagnostics>\n\n<diagnostics");
  });

  it("rejects files with more than 10 entries", async () => {
    const tools = createLspToolSet(ctx);
    const files = Array.from({ length: 11 }, (_, i) => `/work/f${i}.ts`);
    await expect(
      byName(tools, "lsp_diagnostics").handler({ files })
    ).rejects.toThrow(/must NOT have more than 10 items|at most 10 entries/);
  });

  it("degrades a no-server file to a sentinel segment and keeps the rest", async () => {
    const fake = makeFakeClient(() => undefined);
    (
      fake.client as unknown as {
        getDiagnosticsEntry: () => unknown;
      }
    ).getDiagnosticsEntry = () => ({ items: [diagItem("ok err")] });
    mockGetClient
      .mockResolvedValueOnce(undefined) // no server for the first file
      .mockResolvedValueOnce(fake.client);
    const tools = createLspToolSet(ctx);
    const out = (await byName(tools, "lsp_diagnostics").handler({
      files: ["/work/none.ts", "/work/src/b.ts"],
    })) as string;
    expect(out).toContain("(no LSP server configured for /work/none.ts;");
    expect(out).toContain('<diagnostics file="/work/src/b.ts">');
    expect(out).toContain("ok err");
  });
});

// ── post-edit diagnostics convergence (pushVersion catches up to openVersion)

describe("lsp_diagnostics edit-aware wait (B1)", () => {
  function diagItem(message: string) {
    return {
      severity: 1,
      range: { start: { line: 0, character: 0 } },
      message,
    };
  }

  it("waits for pushVersion to catch up with openVersion after an edit", async () => {
    vi.useFakeTimers();
    try {
      const { client } = makeFakeClient(() => undefined);
      let openVersion = 2; // the doc was edited (didChange sent)
      let entry:
        | {
            readonly items: ReadonlyArray<unknown>;
            readonly pushVersion?: number;
          }
        | undefined = { items: [diagItem("stale")], pushVersion: 1 };
      (
        client as unknown as {
          getDiagnosticsEntry: () =>
            | {
                readonly items: ReadonlyArray<unknown>;
                readonly pushVersion?: number;
              }
            | undefined;
          getOpenVersion: () => number | undefined;
        }
      ).getDiagnosticsEntry = () => entry;
      (
        client as unknown as { getOpenVersion: () => number | undefined }
      ).getOpenVersion = () => openVersion;
      mockGetClient.mockResolvedValue(client);
      const tools = createLspToolSet(ctx);
      const p = byName(tools, "lsp_diagnostics").handler({
        file: "/work/src/a.ts",
      }) as Promise<string>;
      // Mid-poll: the server re-pushes based on the new content (pushVersion
      // catches up with openVersion).
      await vi.advanceTimersByTimeAsync(150);
      entry = { items: [diagItem("fresh")], pushVersion: 2 };
      // Advance timers once more so the next 100ms poll sees the fresh entry.
      await vi.advanceTimersByTimeAsync(100);
      const out = await p;
      expect(out).toContain("fresh");
      expect(out).not.toContain("stale");
      void openVersion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the stale content at the deadline when pushVersion never catches up", async () => {
    vi.useFakeTimers();
    try {
      const { client } = makeFakeClient(() => undefined);
      (
        client as unknown as {
          getDiagnosticsEntry: () =>
            | {
                readonly items: ReadonlyArray<unknown>;
                readonly pushVersion?: number;
              }
            | undefined;
          getOpenVersion: () => number | undefined;
        }
      ).getDiagnosticsEntry = () => ({
        items: [diagItem("stale")],
        pushVersion: 1,
      });
      (
        client as unknown as { getOpenVersion: () => number | undefined }
      ).getOpenVersion = () => 2;
      mockGetClient.mockResolvedValue(client);
      const tools = createLspToolSet(ctx);
      const p = byName(tools, "lsp_diagnostics").handler({
        file: "/work/src/a.ts",
      }) as Promise<string>;
      await vi.advanceTimersByTimeAsync(DIAGNOSTICS_WAIT_MS + 100);
      const out = await p;
      expect(out).toContain("stale"); // deadline reached → render what exists
    } finally {
      vi.useRealTimers();
    }
  });

  it("consumes diagnosticsWaitMs from ctx (B7)", async () => {
    vi.useFakeTimers();
    try {
      const { client } = makeFakeClient(() => undefined);
      (
        client as unknown as {
          getDiagnosticsEntry: () => undefined;
          getOpenVersion: () => number | undefined;
        }
      ).getDiagnosticsEntry = () => undefined;
      (
        client as unknown as { getOpenVersion: () => number | undefined }
      ).getOpenVersion = () => 2;
      mockGetClient.mockResolvedValue(client);
      const ctxCustom = { ...ctx, diagnosticsWaitMs: 500 };
      const tools = createLspToolSet(ctxCustom);
      const p = byName(tools, "lsp_diagnostics").handler({
        file: "/work/src/a.ts",
      }) as Promise<string>;
      await vi.advanceTimersByTimeAsync(600);
      const out = await p;
      expect(out).toContain('<diagnostics file="/work/src/a.ts">');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── sentinel tiering (no-server / no-root / spawn-failed) ───────────────────

describe("tiered no-server sentinel (B3)", () => {
  it("no-root failure renders the missing-root-marker message", async () => {
    mockGetClientDetailed.mockResolvedValue({
      failure: { reason: "no-root", serverId: "typescript" },
    });
    const tools = createLspToolSet(ctx);
    const out = (await byName(tools, "lsp_definition").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    })) as string;
    expect(out).toBe(
      "(no LSP project root found above /work/src/a.ts within /work; missing root marker for typescript)"
    );
  });

  it("spawn-failed failure renders the installHint from the server declaration", async () => {
    mockGetClientDetailed.mockResolvedValue({
      failure: { reason: "spawn-failed", serverId: "pyright" },
    });
    const tools = createLspToolSet(ctx);
    const out = (await byName(tools, "lsp_definition").handler({
      file: "/work/src/a.py",
      line: 1,
      character: 0,
    })) as string;
    expect(out).toBe(
      "(LSP server pyright unavailable; hint: npm i -g pyright)"
    );
  });

  it("spawn-failed without installHint omits the hint sentence", async () => {
    mockGetClientDetailed.mockResolvedValue({
      failure: { reason: "spawn-failed", serverId: "no-hint-server" },
    });
    const tools = createLspToolSet(ctx);
    const out = (await byName(tools, "lsp_definition").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    })) as string;
    expect(out).toBe("(LSP server no-hint-server unavailable)");
  });

  it("disabledServers hit renders no-server with serverId (B7)", async () => {
    mockGetClientDetailed.mockResolvedValue({
      failure: { reason: "no-server", serverId: "typescript" },
    });
    const tools = createLspToolSet(ctx);
    const out = (await byName(tools, "lsp_definition").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    })) as string;
    expect(out).toBe(
      "(no LSP server configured for /work/src/a.ts; supported extensions: .ts, .tsx, .js, .jsx, .mjs, .cjs, .mts, .cts, .py, .pyi, .yaml, .yml, .json, .dockerfile, Dockerfile)"
    );
  });
});

// ── requestTimeoutMs consumed from ctx ──────────────────────────────────────

describe("ctx.requestTimeoutMs consumption (B7)", () => {
  it("times out at the ctx-configured deadline instead of the 20s default", async () => {
    const { client } = makeFakeClient(() => undefined);
    (client as unknown as { sendRequest: unknown }).sendRequest = (
      _method: string,
      _params: unknown,
      token: { onCancellationRequested(cb: () => void): unknown }
    ) =>
      new Promise((_resolve, reject) => {
        token.onCancellationRequested(() =>
          reject(new Error("Request cancelled"))
        );
      });
    mockGetClient.mockResolvedValue(client);
    const ctxCustom = { ...ctx, requestTimeoutMs: 1_000 };
    const tools = createLspToolSet(ctxCustom);

    vi.useFakeTimers();
    try {
      const p = byName(tools, "lsp_definition").handler({
        file: "/work/src/a.ts",
        line: 1,
        character: 0,
      });
      const expectation = expect(p).rejects.toThrow(
        "[lsp_definition] LSP request textDocument/definition timed out after 1s (cancelled)"
      );
      await vi.advanceTimersByTimeAsync(1_001);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("isLspFailureSentinel (probe FAIL detection, B3 closeout)", () => {
  it("treats no-server / no-root / spawn-failed strings as failure sentinels", () => {
    expect(
      isLspFailureSentinel(
        "(no LSP server configured for /work/a.ts; supported extensions: .ts)"
      )
    ).toBe(true);
    expect(
      isLspFailureSentinel(
        "(no LSP project root found above /work/a.ts within /work; missing root marker for typescript)"
      )
    ).toBe(true);
    expect(
      isLspFailureSentinel(
        "(LSP server pyright unavailable; hint: npm i -g pyright)"
      )
    ).toBe(true);
    expect(
      isLspFailureSentinel("(LSP server no-hint-server unavailable)")
    ).toBe(true);
  });

  it("does not treat a successful hover or empty diagnostics payload as a sentinel", () => {
    expect(isLspFailureSentinel('{"contents":"ok"}')).toBe(false);
    expect(
      isLspFailureSentinel('<diagnostics file="a.ts">\n</diagnostics>')
    ).toBe(false);
    expect(isLspFailureSentinel("")).toBe(false);
    expect(isLspFailureSentinel(undefined)).toBe(false);
  });

  it("does not treat the method-not-found sentinel as a failure (capability gap ≠ call failure)", () => {
    // Per spec 251, -32601 is a server capability gap (method unimplemented),
    // not a call failure and certainly not a spawn failure — the probe skips on
    // this basis, so it must never count as FAIL.
    const sentinel = renderMethodNotFound("textDocument/references", "yaml");
    expect(isMethodNotFoundSentinel(sentinel)).toBe(true);
    expect(isLspFailureSentinel(sentinel)).toBe(false);
  });
});

describe("method-not-found sentinel (-32601 capability gap)", () => {
  it("renders method + serverId and stays a plain string (contract Y1)", () => {
    const out = renderMethodNotFound(
      "workspace/symbol",
      "json-language-server"
    );
    expect(typeof out).toBe("string");
    expect(out).toContain("json-language-server");
    expect(out).toContain("workspace/symbol");
    expect(isMethodNotFoundSentinel(out)).toBe(true);
  });

  it("omits the server id when unknown", () => {
    expect(
      isMethodNotFoundSentinel(renderMethodNotFound("workspace/symbol"))
    ).toBe(true);
  });

  it("does not match a successful payload or another sentinel family", () => {
    expect(isMethodNotFoundSentinel("[]")).toBe(false);
    expect(
      isMethodNotFoundSentinel("(LSP server pyright unavailable; hint: x)")
    ).toBe(false);
    expect(isMethodNotFoundSentinel(undefined)).toBe(false);
  });

  it("position tool returns the sentinel instead of throwing when the server lacks the method", async () => {
    // -32601 → sentinel (not counted as spawn failure); not a ToolExecutionError.
    const err = Object.assign(
      new Error("Unhandled method textDocument/definition"),
      {
        code: -32601,
      }
    );
    const { client, calls } = makeFakeClient(() => {
      throw err;
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const out = await byName(tools, "lsp_definition").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    });
    expect(typeof out).toBe("string");
    expect(isMethodNotFoundSentinel(out)).toBe(true);
    expect(isLspFailureSentinel(out)).toBe(false);
    expect(calls[0].method).toBe("textDocument/definition");
  });

  it("call-hierarchy tool does not forward after a prepareCallHierarchy capability gap", async () => {
    const err = Object.assign(
      new Error("Unhandled method textDocument/prepareCallHierarchy"),
      { code: -32601 }
    );
    const { client, calls } = makeFakeClient(() => {
      throw err;
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const out = await byName(tools, "lsp_outgoing_calls").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    });
    expect(isMethodNotFoundSentinel(out)).toBe(true);
    // prepare already lacks the capability → no second request (absence ≠
    // unsupported, but an explicit gap stops here).
    expect(calls.map((c) => c.method)).toEqual([
      "textDocument/prepareCallHierarchy",
    ]);
  });

  it("other RPC errors still propagate (capability gap detection is narrow)", async () => {
    // -32602 (invalid params) and similar **param-layer** errors are not
    // capability gaps: they must still throw, never be swallowed by the sentinel.
    const err = Object.assign(new Error("invalid params"), { code: -32602 });
    const { client } = makeFakeClient(() => {
      throw err;
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await expect(
      byName(tools, "lsp_definition").handler({
        file: "/work/src/a.ts",
        line: 1,
        character: 0,
      })
    ).rejects.toThrow("invalid params");
  });
});

// ── initialize capability gate (spec 251, initialize capability advertisement)
//
// Contract: a server that **explicitly** declares a provider `false` in its
// initialize result definitely lacks that capability → skip the RPC and return
// the method-not-found sentinel. When the key is **absent** (undefined) or
// `true` → send the RPC anyway — typescript-language-server measurably omits
// `callHierarchyProvider` yet implements call hierarchy, so treating absence
// as unsupported would break TS call hierarchy (the probe's 10/10 floor).
//
// "Was the RPC sent?" is asserted via calls length (the fake records each sendRequest).

describe("initialize capability gate (explicit false → no RPC)", () => {
  it("returns the sentinel without sending RPC when the provider is explicitly false", async () => {
    const { client, calls } = makeFakeClient(
      () => {
        throw new Error(
          "RPC must not be sent for an explicitly false provider"
        );
      },
      { referencesProvider: false }
    );
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const out = await byName(tools, "lsp_references").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    });
    expect(isMethodNotFoundSentinel(out)).toBe(true);
    // explicit false → not even an RPC is sent (not send-and-wait-for -32601).
    expect(calls).toHaveLength(0);
  });

  it("still sends RPC when the provider key is absent (absence ≠ unsupported)", async () => {
    // Regression guard for TS call hierarchy: typescript-language-server does
    // not declare callHierarchyProvider yet implements call hierarchy.
    const { client, calls } = makeFakeClient(
      () => [{ name: "foo" }],
      {} // all capabilities absent
    );
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const out = await byName(tools, "lsp_prepare_call_hierarchy").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    });
    expect(calls.map((c) => c.method)).toEqual([
      "textDocument/prepareCallHierarchy",
    ]);
    expect(out).toContain("foo");
  });

  it("still sends RPC when the provider is explicitly true", async () => {
    const { client, calls } = makeFakeClient(() => [], {
      referencesProvider: true,
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await byName(tools, "lsp_references").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    });
    expect(calls.map((c) => c.method)).toEqual(["textDocument/references"]);
  });

  it("call-hierarchy tool short-circuits prepare on an explicit false provider", async () => {
    const { client, calls } = makeFakeClient(
      () => {
        throw new Error(
          "RPC must not be sent for an explicitly false provider"
        );
      },
      { callHierarchyProvider: false }
    );
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const out = await byName(tools, "lsp_incoming_calls").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    });
    expect(isMethodNotFoundSentinel(out)).toBe(true);
    // the gate blocks prepare → the follow-up incomingCalls is even less likely to be sent.
    expect(calls).toHaveLength(0);
  });
});

// ── probe verdict (scripts/lsp-probe.ts): sentinel = skip ───────────────────
//
// Once the tool layer converts -32601 / explicit false into a returned
// sentinel, the probe's safeCall sees ok + sentinel (no longer an error
// detail). classifyProbeResult must merge that path with an escaped
// MethodNotFound RPC error into the same skip semantics — otherwise the
// sentinel is mistaken for a plain non-empty string and reported ✓ (a false
// positive), and the capability gap goes unacknowledged.

describe("probe verdict: method-not-found sentinel skips like a MethodNotFound error", () => {
  it("treats the tool-level sentinel result as a skip (not a pass, not a failure)", () => {
    const verdict = classifyProbeResult({
      kind: "ok",
      value: renderMethodNotFound("textDocument/references", "yaml"),
    });
    expect(verdict.kind).toBe("skip");
  });

  it("treats a MethodNotFound RPC error as a skip (both paths converge)", () => {
    const err = Object.assign(
      new Error("Unhandled method textDocument/references"),
      { code: -32601 }
    );
    expect(
      classifyProbeResult({ kind: "err", detail: err.message, error: err }).kind
    ).toBe("skip");
  });

  it("treats a non-Error 'Unhandled method' detail as a skip (code may be absent)", () => {
    expect(
      classifyProbeResult({
        kind: "err",
        detail: "Unhandled method workspace/symbol",
        error: "Unhandled method workspace/symbol",
      }).kind
    ).toBe("skip");
  });

  it("still fails other RPC errors (capability detection stays narrow)", () => {
    const err = Object.assign(new Error("invalid params"), { code: -32602 });
    const verdict = classifyProbeResult({
      kind: "err",
      detail: err.message,
      error: err,
    });
    expect(verdict.kind).toBe("fail");
    if (verdict.kind === "fail")
      expect(verdict.detail).toContain("invalid params");
  });

  it("passes a plain non-empty result and fails the empty / no-server ones", () => {
    expect(
      classifyProbeResult({ kind: "ok", value: '[{"uri":"a.ts"}]' }).kind
    ).toBe("pass");
    expect(classifyProbeResult({ kind: "ok", value: "" }).kind).toBe("fail");
    // Tiered failure sentinels: the no-server / no-root / spawn-failed texts
    // must all verdict FAIL, otherwise a no-server file looks like it had results.
    for (const value of [
      "(no LSP server configured for /work/a.yml; supported extensions: .ts, .yml)",
      "(no LSP project root found above /work/a.ts within /work; missing root marker for typescript)",
      "(LSP server pyright unavailable; hint: npm i -g pyright)",
    ]) {
      expect(classifyProbeResult({ kind: "ok", value }).kind).toBe("fail");
    }
  });

  it("fails non-string results (contract Y1 would be broken)", () => {
    expect(classifyProbeResult({ kind: "ok", value: 42 }).kind).toBe("fail");
    expect(classifyProbeResult({ kind: "ok", value: undefined }).kind).toBe(
      "fail"
    );
  });
});

// ── symbol tools go through the same gate (spec 251 initialize capability
//    advertisement + method-not-found sentinel) ──────────────────────────────
//
// Background: the symbol-resolution layer (symbol-resolver.ts)
// used to call `client.sendRequest("textDocument/documentSymbol")` directly,
// bypassing lsp.ts's capability gate and the -32601 sentinel — with
// `documentSymbolProvider: false` declared explicitly it still sent the RPC,
// and a -32601 reply threw an error that the executor recorded as
// `execution_failed`, while spec 251 requires both paths to converge on the
// same sentinel and **not** count as spawn failure. documentSymbol is the
// entry point of every symbol-* tool (including symbol-mutate), so the blast
// radius was the whole symbol family.
//
// Each case below asserts on the real output of the symbol tool handler (not
// resolver internals), pinning the contract: explicit false → zero RPC + sentinel string;
// -32601 → sentinel string, no throw; other RPC errors still propagate (the gate is narrow).

/** Common symbol-tool call surface: handler input `{ file, symbol_path }`. */
const SYMBOL_INPUT = { file: "/work/src/a.ts", symbol_path: "Foo/bar" };

function createSymbolQueryToolSetForTest(): ReadonlyArray<AciToolDef> {
  return createSymbolQueryToolSet(ctx);
}

function createSymbolMutateToolSetForTest(): ReadonlyArray<AciToolDef> {
  return createSymbolMutateToolSet({ ctx });
}

/** Mutate tools each have specialized required fields; this group only cares
 *  about "does it send RPC / does it return the sentinel". */
function mutateInput(name: string): Record<string, unknown> {
  switch (name) {
    case "rename_symbol":
      return { ...SYMBOL_INPUT, new_name: "baz" };
    case "replace_symbol_body":
      return { ...SYMBOL_INPUT, new_body: "function bar() {}" };
    case "insert_before_symbol":
    case "insert_after_symbol":
      return { ...SYMBOL_INPUT, code: "// note" };
    default:
      return SYMBOL_INPUT;
  }
}

/**
 * Symbol tools that go through `resolveSymbolPosition` (= resolving the symbol
 * tree via the resolver's documentSymbol) — the gap lived exactly on this chain.
 */
const SYMBOL_RESOLVER_TOOL_NAMES = [
  "find_declaration",
  "find_referencing_symbols",
  "find_implementations",
  "get_hover",
  "prepare_call_hierarchy",
  "list_incoming_calls",
  "list_outgoing_calls",
] as const;

/** The three symbol-query tools that skip the resolver; each exclusion reason
 *  must stay individually auditable (no blanket omissions). */
const SYMBOL_NON_RESOLVER_TOOL_NAMES = [
  { name: "find_symbol", why: "workspace/symbol 直接提问，不解析符号身份" },
  {
    name: "get_symbols_overview",
    why: "自己经门控入口发 documentSymbol（下方单列其闸门断言）",
  },
  {
    name: "get_diagnostics_for_file",
    why: "按文件读诊断，与符号身份无关",
  },
] as const;

const SAMPLE_SYMBOL_TREE = [
  {
    name: "Foo",
    kind: 5,
    range: { start: { line: 0, character: 0 } },
    selectionRange: { start: { line: 0, character: 6 } },
    children: [
      {
        name: "bar",
        kind: 6,
        range: { start: { line: 2, character: 2 } },
        selectionRange: { start: { line: 2, character: 8 } },
      },
    ],
  },
];

/** The resolver and get_symbols_overview both accept only this method as the symbol-tree source. */
const DOCUMENT_SYMBOL = "textDocument/documentSymbol";

function methodNotFoundError(method: string): Error {
  return Object.assign(new Error(`Unhandled method ${method}`), {
    code: -32601,
  });
}

/**
 * Composite responder: symbol tree + business-request replies. Business
 * methods always answer an empty array (the tool just has to get through; the
 * assertions live on the sentinel/RPC surface).
 */
function symbolResponder(
  tree: unknown = SAMPLE_SYMBOL_TREE
): (method: string, params: unknown) => unknown {
  return (method: string) => (method === DOCUMENT_SYMBOL ? tree : []);
}

describe("symbol tools share the initialize capability gate (explicit false → no RPC)", () => {
  it("classifies every symbol query tool as resolver or non-resolver (no silent gaps)", () => {
    // SSOT: a new symbol tool that lands in neither the resolver group nor the
    // exclusion group turns this assertion red first — otherwise it silently
    // escapes capability-gate coverage, exactly the original failure shape.
    const classified = [
      ...SYMBOL_RESOLVER_TOOL_NAMES,
      ...SYMBOL_NON_RESOLVER_TOOL_NAMES.map((e) => e.name),
    ];
    expect([...classified].sort()).toEqual([...SYMBOL_QUERY_TOOL_NAMES].sort());
  });

  it("every symbol query tool returns the sentinel without sending documentSymbol RPC", async () => {
    for (const name of SYMBOL_RESOLVER_TOOL_NAMES) {
      const { client, calls } = makeFakeClient(
        () => {
          throw new Error(
            "RPC must not be sent for an explicitly false documentSymbolProvider"
          );
        },
        { documentSymbolProvider: false }
      );
      mockGetClient.mockResolvedValue(client);
      const tools = createSymbolQueryToolSetForTest();
      const out = (await byName(tools, name).handler(SYMBOL_INPUT)) as string;
      expect(isMethodNotFoundSentinel(out), `${name} sentinel`).toBe(true);
      expect(calls, `${name} RPC count`).toHaveLength(0);
    }
  });

  it("every symbol mutate tool returns the sentinel without sending documentSymbol RPC", async () => {
    for (const name of SYMBOL_MUTATE_TOOL_NAMES) {
      const { client, calls } = makeFakeClient(
        () => {
          throw new Error(
            "RPC must not be sent for an explicitly false documentSymbolProvider"
          );
        },
        { documentSymbolProvider: false }
      );
      mockGetClient.mockResolvedValue(client);
      const tools = createSymbolMutateToolSetForTest();
      const out = (await byName(tools, name).handler(
        mutateInput(name)
      )) as string;
      expect(isMethodNotFoundSentinel(out), `${name} sentinel`).toBe(true);
      expect(calls, `${name} RPC count`).toHaveLength(0);
    }
  });

  it("get_symbols_overview returns the sentinel without sending documentSymbol RPC", async () => {
    const { client, calls } = makeFakeClient(
      () => {
        throw new Error(
          "RPC must not be sent for an explicitly false documentSymbolProvider"
        );
      },
      { documentSymbolProvider: false }
    );
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSetForTest();
    const out = (await byName(tools, "get_symbols_overview").handler({
      file: "/work/src/a.ts",
    })) as string;
    expect(isMethodNotFoundSentinel(out)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("still sends the RPC when documentSymbolProvider is absent (absence ≠ unsupported)", async () => {
    // TS measurably omits some provider declarations yet implements the
    // capability: absence must still send.
    const { client, calls } = makeFakeClient(symbolResponder(), {});
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSetForTest();
    const out = (await byName(tools, "find_declaration").handler(
      SYMBOL_INPUT
    )) as string;
    expect(calls.map((c) => c.method)).toEqual([
      DOCUMENT_SYMBOL,
      "textDocument/definition",
    ]);
    expect(isMethodNotFoundSentinel(out)).toBe(false);
  });
});

describe("symbol tools convert -32601 into the sentinel (no ToolExecutionError)", () => {
  it("find_declaration returns the sentinel when documentSymbol is unimplemented", async () => {
    const { client, calls } = makeFakeClient(() => {
      throw methodNotFoundError(DOCUMENT_SYMBOL);
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSetForTest();
    const out = (await byName(tools, "find_declaration").handler(
      SYMBOL_INPUT
    )) as string;
    expect(typeof out).toBe("string");
    expect(isMethodNotFoundSentinel(out)).toBe(true);
    expect(isLspFailureSentinel(out)).toBe(false);
    expect(out).toContain(DOCUMENT_SYMBOL);
    // resolution itself lacks the capability → no business request (fail fast,
    // don't hit a second gap).
    expect(calls.map((c) => c.method)).toEqual([DOCUMENT_SYMBOL]);
  });

  it("get_symbols_overview returns the sentinel when documentSymbol is unimplemented", async () => {
    const { client } = makeFakeClient(() => {
      throw methodNotFoundError(DOCUMENT_SYMBOL);
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSetForTest();
    const out = (await byName(tools, "get_symbols_overview").handler({
      file: "/work/src/a.ts",
    })) as string;
    expect(isMethodNotFoundSentinel(out)).toBe(true);
  });

  it("rename_symbol returns the sentinel instead of throwing", async () => {
    const { client, calls } = makeFakeClient(() => {
      throw methodNotFoundError(DOCUMENT_SYMBOL);
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolMutateToolSetForTest();
    const out = (await byName(tools, "rename_symbol").handler({
      ...SYMBOL_INPUT,
      new_name: "baz",
    })) as string;
    expect(isMethodNotFoundSentinel(out)).toBe(true);
    expect(calls.map((c) => c.method)).toEqual([DOCUMENT_SYMBOL]);
  });

  it("safe_delete_symbol does not enter the delete path on a capability gap", async () => {
    const { client, calls } = makeFakeClient(() => {
      throw methodNotFoundError(DOCUMENT_SYMBOL);
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolMutateToolSetForTest();
    const out = (await byName(tools, "safe_delete_symbol").handler(
      SYMBOL_INPUT
    )) as string;
    expect(isMethodNotFoundSentinel(out)).toBe(true);
    expect(calls.map((c) => c.method)).toEqual([DOCUMENT_SYMBOL]);
  });

  it("keeps other RPC errors propagating (gate is narrow)", async () => {
    // -32602 (invalid params) is not a capability gap: the sentinel must not
    // swallow it into a fake "success".
    const err = Object.assign(new Error("invalid params"), { code: -32602 });
    const { client } = makeFakeClient(() => {
      throw err;
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSetForTest();
    await expect(
      byName(tools, "find_declaration").handler(SYMBOL_INPUT)
    ).rejects.toThrow("invalid params");
  });

  it("keeps transport errors propagating on the uncached path", async () => {
    const { client } = makeFakeClient(() => {
      throw new Error("initialize handshake failed");
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSetForTest();
    await expect(
      byName(tools, "find_declaration").handler({
        file: "/work/src/transport.ts",
        symbol_path: "Foo/bar",
      })
    ).rejects.toThrow("initialize handshake failed");
  });
});

// ── symbol-tree snapshot cache keyed by content fingerprint ─────────────────
//
// fetchDocumentSymbols switched its cache key from getOpenVersion to
// getDocumentFingerprint: with request-scoped opening the version restarts at
// 1 every time, so it cannot distinguish two opens of the same file. The two
// cases below pin the semantics: content changed → re-fetch; unchanged →
// documentSymbol sent exactly once on the same client.

describe("symbol snapshot cache keyed by document fingerprint", () => {
  it("re-fetches documentSymbol when the content fingerprint changes", async () => {
    const { client, calls } = makeFakeClient(symbolResponder());
    let fingerprint = "fp-1";
    (
      client as unknown as {
        getDocumentFingerprint: (uri: string) => string | undefined;
      }
    ).getDocumentFingerprint = () => fingerprint;
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSetForTest();

    await byName(tools, "find_declaration").handler(SYMBOL_INPUT);
    expect(calls.filter((c) => c.method === DOCUMENT_SYMBOL)).toHaveLength(1);

    // Out-of-band edit: the file's content changed outside the resolution
    // window → different fingerprint → the symbol tree must be re-fetched.
    fingerprint = "fp-2";
    await byName(tools, "find_declaration").handler(SYMBOL_INPUT);
    expect(calls.filter((c) => c.method === DOCUMENT_SYMBOL)).toHaveLength(2);
  });

  it("serves the cached snapshot without a second RPC when the fingerprint is unchanged", async () => {
    const { client, calls } = makeFakeClient(symbolResponder());
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSetForTest();

    await byName(tools, "find_declaration").handler(SYMBOL_INPUT);
    await byName(tools, "get_hover").handler(SYMBOL_INPUT);

    // two resolutions, same text → documentSymbol sent once; each business
    // request still goes out.
    expect(calls.filter((c) => c.method === DOCUMENT_SYMBOL)).toHaveLength(1);
    expect(calls.map((c) => c.method)).toEqual([
      DOCUMENT_SYMBOL,
      "textDocument/definition",
      "textDocument/hover",
    ]);
  });
});

// ── find_symbol without `file`: no project anchor → layered sentinel ─────────
//
// Root cause (measured, docs/guides/lsp-client-analysis.md): the search set of
// `workspace/symbol` is decided by the server's current project graph, and the
// graph by the file it last touched — an anchor outside tsconfig `include`
// leaves tsserver with only an inferred project (that file + import closure).
// A caller without `file` has no anchor (production shape measured 40s of
// all-`[]`, while the same query with a `file` anchor returned 4 hits in ~7s),
// so `[]` would mean both "the symbol truly doesn't exist" and "the query path
// had no project context" — precisely the silent degradation to eliminate.
//
// Contract: `[]` now means only "searched-and-absent"; the no-anchor observable
// shapes (tsserver's `No Project.` throw / empty result without project context)
// converge into one sentinel. It deliberately does NOT join the
// `isLspFailureSentinel` three-prefix family: those mean "the call never
// happened", but this call did get an RPC response, so recording it as a probe
// FAIL would misclassify it — and the probe never reaches this branch anyway.
// The consumer is the model, which needs "this conclusion is not trustworthy,
// take another route", not "LSP is broken".

/** Agreed final wording for no project anchor (`ctx.directory` interpolated per family convention). */
const NO_ANCHOR_SENTINEL =
  "(LSP workspace/symbol has no project anchor under /work; an empty result from this path is not trustworthy — pass file=<a file inside the project to search> or use get_symbols_overview on a known file)";

/** tsserver's `No Project.` throw shape (typescript.js ThrowNoProject, measured). */
function noProjectError(): Error {
  return Object.assign(
    new Error(
      "<syntax> TypeScript Server Error (5.9.3)\nNo Project.\nError: No Project.\n    at Object.ThrowNoProject (typescript.js:186170:11)"
    ),
    { code: 1 }
  );
}

describe("find_symbol without `file`: no project anchor returns the layered sentinel (T3)", () => {
  it("converts the tsserver `No Project.` throw into the sentinel instead of propagating", async () => {
    const { client, calls } = makeFakeClient(() => {
      throw noProjectError();
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSetForTest();
    const out = (await byName(tools, "find_symbol").handler({
      query: "createAciRegistry",
    })) as string;

    expect(out).toBe(NO_ANCHOR_SENTINEL);
    expect(calls.map((c) => c.method)).toEqual(["workspace/symbol"]);
  });

  it("converts an empty no-anchor result into the sentinel (`[]` no longer means two things)", async () => {
    const { client } = makeFakeClient(() => []);
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSetForTest();
    const out = await byName(tools, "find_symbol").handler({
      query: "createAciRegistry",
    });
    expect(out).toBe(NO_ANCHOR_SENTINEL);
  });

  it("classifies the sentinel as neither failure nor method-not-found (probe verdict = pass)", async () => {
    // Decided: no fourth prefix branch joins the family. The three failure
    // prefixes mean "the call never happened"; this call did get a response —
    // recording FAIL would misclassify it, and the probe never enters this branch.
    const { client } = makeFakeClient(() => {
      throw noProjectError();
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSetForTest();
    const out = (await byName(tools, "find_symbol").handler({
      query: "createAciRegistry",
    })) as string;

    expect(isLspFailureSentinel(out)).toBe(false);
    expect(isMethodNotFoundSentinel(out)).toBe(false);
    expect(classifyProbeResult({ kind: "ok", value: out }).kind).toBe("pass");
  });

  it("keeps a non-empty no-anchor result as data (coverage caveat lives in the description, not the result)", async () => {
    const hits = [{ name: "createAciRegistry", kind: 12 }];
    const { client } = makeFakeClient(() => hits);
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSetForTest();
    const out = await byName(tools, "find_symbol").handler({
      query: "createAciRegistry",
    });
    expect(out).toBe(JSON.stringify(hits, null, 2));
    expect(isLspFailureSentinel(out)).toBe(false);
  });

  it("names the coverage caveat in the tool description (the always-on model-visible surface)", () => {
    const tools = createSymbolQueryToolSetForTest();
    const desc = byName(tools, "find_symbol").description;
    // description is the always model-visible surface (the tool description
    // line in the golden roster): a search without `file` only covers the
    // already-loaded project — `file` is the anchor. The warning must live in
    // description (delivered before tool selection), otherwise the model treats
    // partial results as complete.
    expect(desc).toContain("without `file`");
    expect(desc).toContain(
      "only covers the project the server has already loaded"
    );
    expect(desc).toContain("pass `file` to anchor the search");
  });
});

// ── find_symbol without `file`: with a valid anchor, `[]` still means absent ─
//
// Control group for the one above: the sentinel must not swallow the healthy
// path. The new contract for `[]` is searched-and-absent, and `file`-anchored
// results (including `[]` with `file` present) stay byte-identical.

describe("find_symbol: `[]` means searched-and-absent once an anchor is in play (T3)", () => {
  it("keeps the empty array when `file` is present and the symbol is genuinely absent", async () => {
    const { client, calls, opened } = makeFakeClient(() => []);
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSetForTest();
    const out = await byName(tools, "find_symbol").handler({
      query: "zzzNoSuchSymbolZzz",
      file: "/work/src/a.ts",
    });
    expect(out).toBe("[]");
    expect(calls[0].method).toBe("workspace/symbol");
    // with `file` present the request-scoped open window covers the whole
    // request (behavior unchanged).
    expect(opened).toEqual(["/work/src/a.ts"]);
  });

  it("keeps non-empty `file`-anchored results byte-identical", async () => {
    const hits = [{ name: "Foo", kind: 5, location: { uri: "file:///a.ts" } }];
    const { client } = makeFakeClient(() => hits);
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSetForTest();
    const out = await byName(tools, "find_symbol").handler({
      query: "Foo",
      file: "/work/src/a.ts",
    });
    expect(out).toBe(JSON.stringify(hits, null, 2));
  });

  it("still surfaces method-not-found when the workspace dispatch lands on a server without workspace/symbol", async () => {
    // A missing method is not a missing anchor: when the server explicitly
    // says "I don't implement this", pass through the method-not-found sentinel
    // (a capability gap is inherent to the server; the model switches tools on it).
    const { client } = makeFakeClient(() => {
      throw methodNotFoundError("workspace/symbol");
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSetForTest();
    const out = (await byName(tools, "find_symbol").handler({
      query: "anything",
    })) as string;
    expect(isMethodNotFoundSentinel(out)).toBe(true);
  });

  it("keeps the no-server sentinel when the workspace dispatch finds no client", async () => {
    // no-server ≠ no-anchor: when no client is probed at all it stays a failure
    // sentinel (probe records FAIL); it must not be downgraded to the soft
    // "conclusion not trustworthy" hint.
    mockGetClient.mockResolvedValue(undefined);
    const tools = createSymbolQueryToolSetForTest();
    const out = (await byName(tools, "find_symbol").handler({
      query: "Foo",
    })) as string;
    expect(out.startsWith("(no LSP server configured")).toBe(true);
    expect(isLspFailureSentinel(out)).toBe(true);
  });

  it("still propagates unrelated RPC errors (the no-anchor rescue is narrow)", async () => {
    const { client } = makeFakeClient(() => {
      throw Object.assign(new Error("invalid params"), { code: -32602 });
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSetForTest();
    await expect(
      byName(tools, "find_symbol").handler({ query: "Foo" })
    ).rejects.toThrow("invalid params");
  });

  it("escalates a deadline hit to the timeout error instead of rescuing it", async () => {
    const { client } = makeFakeClient(() => undefined);
    (client as unknown as { sendRequest: unknown }).sendRequest = (
      _method: string,
      _params: unknown,
      token: { onCancellationRequested(cb: () => void): unknown }
    ) =>
      new Promise((_resolve, reject) => {
        token.onCancellationRequested(() =>
          reject(new Error("Request cancelled"))
        );
      });
    mockGetClient.mockResolvedValue(client);
    const ctxCustom = { ...ctx, requestTimeoutMs: 1_000 };
    const tools = createSymbolQueryToolSet(ctxCustom);

    vi.useFakeTimers();
    try {
      const p = byName(tools, "find_symbol").handler({ query: "Foo" });
      const expectation = expect(p).rejects.toThrow(
        "[find_symbol] LSP request workspace/symbol timed out after 1s (cancelled)"
      );
      await vi.advanceTimersByTimeAsync(1_001);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not swallow a cancellation-flavoured error when no deadline fired", async () => {
    // With no deadline fired, a RequestCancelled (executor abort etc.) still
    // propagates; it must not be rescued into the sentinel.
    const { client } = makeFakeClient(() => {
      throw new Error("Request cancelled");
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSetForTest();
    await expect(
      byName(tools, "find_symbol").handler({ query: "Foo" })
    ).rejects.toThrow("Request cancelled");
  });
});
