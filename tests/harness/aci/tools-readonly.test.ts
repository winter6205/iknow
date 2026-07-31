/**
 * ACI 原型 Layer 1 只读工具组单元测试。
 * 覆盖：fs_search 限 50 + 绝对路径 + 越界拒绝；
 *       fs_view 首页 100 行 + 续读 + eof + 文件不存在；
 *       context_manager 压缩 + lazy:true 标记。
 */

import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFsSearchTool } from "../../../src/harness/aci/tools/fs-search.ts";
import { createFsViewTool } from "../../../src/harness/aci/tools/fs-view.ts";
import { createContextManagerTool } from "../../../src/harness/aci/tools/context-manager.ts";

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "iknow-aci-readonly-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("fs_search — 限 50 降噪（ch04 组件①）", () => {
  it(">50 个匹配文件 → truncated:true + matches.length===50 + total=60", async () => {
    for (let i = 0; i < 60; i++) {
      writeFileSync(
        join(scratch, `hit-${String(i).padStart(3, "0")}.txt`),
        "needle",
      );
    }
    const tool = createFsSearchTool(scratch);
    const result = (await tool.handler({ pattern: "needle" })) as {
      matches: string[];
      truncated: boolean;
      total: number;
    };
    assert.equal(result.matches.length, 50);
    assert.equal(result.truncated, true);
    assert.equal(result.total, 60);
  });

  it("匹配 ≤ 50 → truncated:false + total===matches.length", async () => {
    writeFileSync(join(scratch, "a.txt"), "needle");
    writeFileSync(join(scratch, "b.txt"), "needle");
    const tool = createFsSearchTool(scratch);
    const result = (await tool.handler({ pattern: "needle" })) as {
      matches: string[];
      truncated: boolean;
      total: number;
    };
    assert.equal(result.matches.length, 2);
    assert.equal(result.truncated, false);
    assert.equal(result.total, 2);
  });

  it("显式 limit 仍硬截 50（上限不可越）", async () => {
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(scratch, `x-${i}.txt`), "needle");
    }
    const tool = createFsSearchTool(scratch);
    const result = (await tool.handler({
      pattern: "needle",
      limit: 1000,
    })) as {
      matches: string[];
      total: number;
    };
    assert.equal(result.matches.length, 10); // 本来就 < 50
    assert.equal(result.total, 10);
  });

  it("返回绝对路径（每条 matches 元素都在 scratch 下）", async () => {
    writeFileSync(join(scratch, "hello.txt"), "world");
    const tool = createFsSearchTool(scratch);
    const result = (await tool.handler({ pattern: "hello" })) as {
      matches: string[];
    };
    assert.ok(result.matches.length > 0);
    for (const m of result.matches) {
      assert.ok(
        m.startsWith(scratch),
        `expected absolute path under scratch: ${m}`,
      );
    }
  });

  it("越界 path → ToolExecutionError（escapes root）", async () => {
    const tool = createFsSearchTool(scratch);
    await assert.rejects(
      () => tool.handler({ pattern: "x", path: "../../etc" }),
      (err: unknown) =>
        err instanceof Error && err.message.includes("escapes root"),
    );
  });

  it("忽略 node_modules / .git 目录", async () => {
    // 在 node_modules 下放一个匹配文件，搜索不应命中
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(scratch, "node_modules"));
    writeFileSync(join(scratch, "node_modules", "needle.js"), "needle");
    writeFileSync(join(scratch, "visible.txt"), "needle");
    const tool = createFsSearchTool(scratch);
    const result = (await tool.handler({ pattern: "needle" })) as {
      matches: string[];
      total: number;
    };
    assert.equal(result.total, 1);
    assert.equal(result.matches.length, 1);
    assert.ok(result.matches[0].endsWith("visible.txt"));
  });
});

describe("fs_view — 有状态翻页（ch04 组件②）", () => {
  it("首页返回 100 行（from=0, to=100, eof=false）", async () => {
    const lines = Array.from({ length: 250 }, (_, i) => `line-${i}`);
    writeFileSync(join(scratch, "big.txt"), lines.join("\n"));
    const tool = createFsViewTool(scratch);
    const result = (await tool.handler({ path: "big.txt" })) as {
      lines: string[];
      from: number;
      to: number;
      eof: boolean;
      nextOffset: number;
    };
    assert.equal(result.lines.length, 100);
    assert.equal(result.from, 0);
    assert.equal(result.to, 100);
    assert.equal(result.nextOffset, 100);
    assert.equal(result.eof, false);
    assert.equal(result.lines[0], "line-0");
    assert.equal(result.lines[99], "line-99");
  });

  it("续读：第二次不传 offset 接上次（from=100）", async () => {
    const lines = Array.from({ length: 250 }, (_, i) => `line-${i}`);
    writeFileSync(join(scratch, "big.txt"), lines.join("\n"));
    const tool = createFsViewTool(scratch);
    await tool.handler({ path: "big.txt" }); // 首页
    const result = (await tool.handler({ path: "big.txt" })) as {
      lines: string[];
      from: number;
      to: number;
    };
    assert.equal(result.from, 100);
    assert.equal(result.to, 200);
    assert.equal(result.lines[0], "line-100");
    assert.equal(result.lines[99], "line-199");
  });

  it("切换 path 后 offset 重置为 0", async () => {
    writeFileSync(join(scratch, "a.txt"), "a-0\na-1\na-2");
    writeFileSync(join(scratch, "b.txt"), "b-0\nb-1\nb-2");
    const tool = createFsViewTool(scratch);
    await tool.handler({ path: "a.txt" }); // a.txt first page (only 3 lines)
    const result = (await tool.handler({ path: "b.txt" })) as {
      lines: string[];
      from: number;
    };
    assert.equal(result.from, 0);
    assert.equal(result.lines[0], "b-0");
  });

  it("eof：最后一页 eof=true + lines 不足 100", async () => {
    const lines = Array.from({ length: 150 }, (_, i) => `line-${i}`);
    writeFileSync(join(scratch, "mid.txt"), lines.join("\n"));
    const tool = createFsViewTool(scratch);
    await tool.handler({ path: "mid.txt" }); // 0-99, eof=false
    const result = (await tool.handler({ path: "mid.txt" })) as {
      lines: string[];
      from: number;
      eof: boolean;
    };
    assert.equal(result.from, 100);
    assert.equal(result.lines.length, 50);
    assert.equal(result.eof, true);
    assert.equal(result.lines[0], "line-100");
    assert.equal(result.lines[49], "line-149");
  });

  it("文件不存在 → ToolExecutionError（not found）", async () => {
    const tool = createFsViewTool(scratch);
    await assert.rejects(
      () => tool.handler({ path: "nope.txt" }),
      (err: unknown) => err instanceof Error && err.message.includes("not found"),
    );
  });

  it("越界 path → ToolExecutionError（escapes root）", async () => {
    const tool = createFsViewTool(scratch);
    await assert.rejects(
      () => tool.handler({ path: "../outside.txt" }),
      (err: unknown) =>
        err instanceof Error && err.message.includes("escapes root"),
    );
  });

  it("返回绝对路径", async () => {
    writeFileSync(join(scratch, "x.txt"), "hello");
    const tool = createFsViewTool(scratch);
    const result = (await tool.handler({ path: "x.txt" })) as { path: string };
    assert.ok(result.path.startsWith(scratch));
    assert.ok(result.path.endsWith("x.txt"));
  });
});

describe("context_manager — 压缩旧观测（ch04 组件④）", () => {
  it("保留最近 3 条原文，更早的截断到 200 + …", async () => {
    const tool = createContextManagerTool();
    const observations = [
      "a".repeat(300), // 旧，超长 → 截断
      "short old", // 旧，短 → 原文
      "recent-1", // 保留
      "recent-2", // 保留
      "recent-3", // 保留
    ];
    const result = (await tool.handler({ observations })) as {
      kept: string[];
      compressed: string[];
      droppedChars: number;
    };
    assert.deepEqual(result.kept, ["recent-1", "recent-2", "recent-3"]);
    assert.equal(result.compressed.length, 2);
    // 第一条：截断到 200 + "…" → 长度 201
    assert.equal(result.compressed[0].length, 201);
    assert.ok(result.compressed[0].endsWith("…"));
    // 第二条：长度 ≤ 200，原文保留
    assert.equal(result.compressed[1], "short old");
    // droppedChars = (300 - 201) + (9 - 9) = 99
    assert.equal(result.droppedChars, 99);
  });

  it("keepRecent 与 maxChars 自定义", async () => {
    const tool = createContextManagerTool();
    const observations = ["old-1", "old-2", "old-3", "keep"];
    const result = (await tool.handler({
      observations,
      keepRecent: 1,
      maxChars: 3,
    })) as {
      kept: string[];
      compressed: string[];
      droppedChars: number;
    };
    assert.deepEqual(result.kept, ["keep"]);
    assert.equal(result.compressed.length, 3);
    // 全部截断到 3 + "…" = 4 字符
    for (const c of result.compressed) {
      assert.equal(c.length, 4);
      assert.ok(c.endsWith("…"));
    }
    // droppedChars = (5-4) + (5-4) + (5-4) = 3
    assert.equal(result.droppedChars, 3);
  });

  it("droppedChars 不小于 0（无压缩时为 0）", async () => {
    const tool = createContextManagerTool();
    const observations = ["a", "b", "c"];
    const result = (await tool.handler({
      observations,
      keepRecent: 0,
      maxChars: 100,
    })) as {
      kept: string[];
      compressed: string[];
      droppedChars: number;
    };
    assert.deepEqual(result.kept, []);
    assert.equal(result.compressed.length, 3);
    assert.equal(result.droppedChars, 0);
  });

  it("lazy:true 标记（演示延迟加载）", () => {
    const tool = createContextManagerTool();
    assert.equal(tool.aci.lazy, true);
    assert.equal(tool.aci.category, "read-only");
    assert.equal(tool.aci.isReadOnly, true);
  });

  it("observations 含非 string → ToolExecutionError", async () => {
    const tool = createContextManagerTool();
    await assert.rejects(
      () =>
        tool.handler({
          // @ts-expect-error: 故意构造非法输入
          observations: ["ok", 42, "ok"],
        }),
      (err: unknown) =>
        err instanceof Error && err.message.includes("observations must be string[]"),
    );
  });
});