/**
 * B6 / ADR-0043 §3 — `<deferred_internal_tools>` 段渲染与 wiring 单测。
 *
 * 测：
 *   1. 段函数本身（deferredInternalToolsSegment）：空数组 → undefined;
 *      非空 → 字母序 + 标签 + 行引导;核心件不在列(由 build-engine
 *      守门,本函数纯渲染)。
 *   2. assembleIdentityContext 注入缝：缝缺席 → 段缺席;返回非空 → 段在;
 *      解析抛错 → console.warn + 段缺席(降级契约对齐 mcp 段)。
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

  it("非空 → 字母序 + 标签 + 每行一名 + 引导句", () => {
    const out = deferredInternalToolsSegment([
      "web_fetch",
      "query_trace",
      "list_sessions",
    ]);
    assert.ok(out !== undefined);
    assert.ok(out!.includes("<deferred_internal_tools>"));
    assert.ok(out!.includes("</deferred_internal_tools>"));
    // 字母序 = list_sessions < query_trace < web_fetch
    const lines = out!.split("\n");
    assert.ok(lines.includes("list_sessions"));
    assert.ok(lines.includes("query_trace"));
    assert.ok(lines.includes("web_fetch"));
    // 字母序断言
    const idxLs = lines.indexOf("list_sessions");
    const idxQt = lines.indexOf("query_trace");
    const idxWf = lines.indexOf("web_fetch");
    assert.ok(idxLs < idxQt);
    assert.ok(idxQt < idxWf);
  });

  it("同名重复 → 段内重复出现(渲染层不去重,数据来源是 SSOT)", () => {
    const out = deferredInternalToolsSegment(["x", "x"]);
    assert.ok(out !== undefined);
    // 重复不报错(数据层会负责 SSOT,渲染层不二次过滤)
    const count = (out!.match(/^x$/gm) ?? []).length;
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

  it("返回非空 → 段在场,字母序", async () => {
    const userHome = await plantEmptyUserHome();
    const out = await assembleIdentityContext({
      projectIdentityRoot: "/repo",
      userHome,
      workspaceRoot: userHome,
      bootstrapActive: false,
      memoryEnabled: false,
      deferredInternalTools: () => ["web_fetch", "query_trace"],
    });
    assert.ok(out !== undefined);
    assert.ok(out!.includes("<deferred_internal_tools>"));
    assert.ok(out!.includes("query_trace"));
    assert.ok(out!.includes("web_fetch"));
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
  it("opts 透传到 ctx;系统文本包含段", async () => {
    const userHome = await plantEmptyUserHome();
    const resolver = createIknowSystemResolver({
      projectIdentityRoot: "/repo",
      userHome,
      workspaceRoot: userHome,
      surface: "chat",
      memoryEnabled: false,
      deferredInternalTools: () => ["query_trace"],
    });
    const out = await resolver();
    assert.ok(out !== undefined);
    assert.ok(out!.includes("<deferred_internal_tools>"));
    assert.ok(out!.includes("query_trace"));
  });
});
