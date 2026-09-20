/**
 * `<deferred_internal_tools>` segment rendering + wiring unit tests
 * (ADR-0043 tool-surface disclosure tiering).
 *
 * Pinned invariants:
 *   1. The segment function (deferredInternalToolsSegment) is pure rendering:
 *      empty array → segment absent; non-empty → tag + alphabetical order +
 *      name + description (per the spec's assumptions, retired built-ins enter
 *      the index tier as name + description; the description is not stripped)
 *      + the direct-call guidance line; description absent → bare name (same
 *      rule as the MCP catalog). That core pieces stay off the list is gated by
 *      build-engine; this function does not re-filter.
 *   2. Degrade contract of the assembleIdentityContext injection seam: seam
 *      absent / returns empty / resolver throws → segment absent (byte-level
 *      zero change, matching the MCP segment).
 */

import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assembleIdentityContext,
  deferredInternalToolsSegment,
  createIknowSystemResolver,
  DIRECT_CALL_GUIDANCE,
  MCP_TOOL_SHORT_DESCRIPTION_MAX,
} from "../../../src/harness/identity/assemble.ts";

const roots: string[] = [];
const warnings: string[] = [];
const originalWarn = console.warn;

beforeEach(() => {
  warnings.length = 0;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
});

afterEach(async () => {
  console.warn = originalWarn;
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))
  );
});

async function plantEmptyUserHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "iknow-b6-deferred-"));
  roots.push(root);
  return join(root, "home");
}

describe("deferredInternalToolsSegment — 纯渲染", () => {
  it("空数组 → undefined(段缺席)", () => {
    assert.equal(deferredInternalToolsSegment([]), undefined);
  });

  it("非空 → 字母序 + 标签 + 每行「- 名: 描述」+ 直呼引导句", () => {
    const out = deferredInternalToolsSegment([
      { name: "web_fetch", description: "Fetch a single web page." },
      { name: "query_trace", description: "Query local JSONL trace records." },
      { name: "list_sessions", description: "List the trace sessions." },
    ]);
    assert.ok(out !== undefined);
    assert.ok(out!.includes("<deferred_internal_tools>"));
    assert.ok(out!.includes("</deferred_internal_tools>"));
    const lines = out!.split("\n");
    // Contract: retired items carry their description (not stripped, no search
    // round-trip).
    assert.ok(lines.includes("- list_sessions: List the trace sessions."));
    assert.ok(
      lines.includes("- query_trace: Query local JSONL trace records.")
    );
    assert.ok(lines.includes("- web_fetch: Fetch a single web page."));
    // alphabetical-order assertion
    const idxLs = lines.findIndex((l) => l.startsWith("- list_sessions"));
    const idxQt = lines.findIndex((l) => l.startsWith("- query_trace"));
    const idxWf = lines.findIndex((l) => l.startsWith("- web_fetch"));
    assert.ok(idxLs < idxQt);
    assert.ok(idxQt < idxWf);
    // direct-call guidance (same SSOT as the MCP catalog): does not mention
    // tool_search.
    assert.ok(out!.includes(DIRECT_CALL_GUIDANCE));
    assert.ok(!out!.includes("tool_search"));
  });

  it("描述缺席 / 空串 / 纯空白 → 裸名行(与 MCP 目录同形规则)", () => {
    const out = deferredInternalToolsSegment([
      { name: "a_tool" },
      { name: "b_tool", description: "" },
      { name: "c_tool", description: "   \n  " },
    ]);
    assert.ok(out !== undefined);
    const lines = out!.split("\n");
    assert.ok(lines.includes("- a_tool"));
    assert.ok(lines.includes("- b_tool"));
    assert.ok(lines.includes("- c_tool"));
  });

  it("多行描述取首行 + 超限截断(复用 MCP 目录短描述 SSOT)", () => {
    const long = "x".repeat(MCP_TOOL_SHORT_DESCRIPTION_MAX + 30);
    const out = deferredInternalToolsSegment([
      { name: "multi", description: "first line\nsecond line" },
      { name: "long", description: long },
    ]);
    assert.ok(out !== undefined);
    const lines = out!.split("\n");
    assert.ok(lines.includes("- multi: first line"));
    assert.ok(!out!.includes("second line"));
    const longLine = lines.find((l) => l.startsWith("- long:"))!;
    assert.equal(
      longLine,
      `- long: ${"x".repeat(MCP_TOOL_SHORT_DESCRIPTION_MAX)}…`
    );
  });

  it("同名重复 → 段内重复出现(渲染层不去重,数据来源是 SSOT)", () => {
    const out = deferredInternalToolsSegment([{ name: "x" }, { name: "x" }]);
    assert.ok(out !== undefined);
    // duplicates are not an error (the data layer owns the SSOT; the render
    // layer does not re-filter)
    const count = (out!.match(/^- x$/gm) ?? []).length;
    assert.equal(count, 2);
  });
});

describe("assembleIdentityContext — deferredInternalTools 注入缝", () => {
  it("缝缺席 → 段缺席(字节级零变化)", async () => {
    const userHome = await plantEmptyUserHome();
    const out = await assembleIdentityContext({
      projectIdentityRoot: "/repo",
      userHome,
      workspaceRoot: userHome,
      bootstrapActive: false,
      memoryEnabled: false,
    });
    assert.ok(out !== undefined);
    assert.ok(!out!.includes("<deferred_internal_tools>"));
  });

  it("返回非空 → 段在场,字母序,带描述", async () => {
    const userHome = await plantEmptyUserHome();
    const out = await assembleIdentityContext({
      projectIdentityRoot: "/repo",
      userHome,
      workspaceRoot: userHome,
      bootstrapActive: false,
      memoryEnabled: false,
      deferredInternalTools: () => [
        { name: "web_fetch", description: "Fetch a single web page." },
        { name: "query_trace", description: "Query trace records." },
      ],
    });
    assert.ok(out !== undefined);
    assert.ok(out!.includes("<deferred_internal_tools>"));
    assert.ok(out!.includes("- query_trace: Query trace records."));
    assert.ok(out!.includes("- web_fetch: Fetch a single web page."));
  });

  it("返回空数组 → 段缺席", async () => {
    const userHome = await plantEmptyUserHome();
    const out = await assembleIdentityContext({
      projectIdentityRoot: "/repo",
      userHome,
      workspaceRoot: userHome,
      bootstrapActive: false,
      memoryEnabled: false,
      deferredInternalTools: () => [],
    });
    assert.ok(out !== undefined);
    assert.ok(!out!.includes("<deferred_internal_tools>"));
  });

  it("解析抛错 → console.warn + 段缺席(降级契约)", async () => {
    const userHome = await plantEmptyUserHome();
    const out = await assembleIdentityContext({
      projectIdentityRoot: "/repo",
      userHome,
      workspaceRoot: userHome,
      bootstrapActive: false,
      memoryEnabled: false,
      deferredInternalTools: () => {
        throw new Error("snapshot broken");
      },
    });
    assert.ok(out !== undefined);
    assert.ok(!out!.includes("<deferred_internal_tools>"));
    assert.ok(
      warnings.some((w) =>
        w.includes("deferred internal tools resolver failed")
      ),
      `expected warn, got: ${warnings.join(" | ")}`
    );
  });
});

describe("createIknowSystemResolver — deferredInternalTools 透传", () => {
  it("opts 透传到 ctx;系统文本包含段与描述", async () => {
    const userHome = await plantEmptyUserHome();
    const resolver = createIknowSystemResolver({
      projectIdentityRoot: "/repo",
      userHome,
      workspaceRoot: userHome,
      surface: "chat",
      memoryEnabled: false,
      deferredInternalTools: () => [
        { name: "query_trace", description: "Query trace records." },
      ],
    });
    const out = await resolver();
    assert.ok(out !== undefined);
    assert.ok(out!.includes("<deferred_internal_tools>"));
    assert.ok(out!.includes("- query_trace: Query trace records."));
  });
});
