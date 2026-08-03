/**
 * grep 工具 (T8) 单元测试。
 *
 * 覆盖契约（ADR-0004 L15 + ADR-0005 L14 + T1-1/T1-7 裁定）：
 *   - 工厂签名 = createGrepTool(root, deps?): AciToolDef，name === "grep"
 *   - inputSchema: pattern 必填 + path? (默认 root) + ignoreCase? (默认 false) + limit? (默认 200, 上限 2000) + additionalProperties:false
 *   - 行为：resolve+containment (symlink 越界拒绝) → 优先 ripgrep 子进程 → 缺 rg 自动 Node fallback → 每行 `相对路径:行号:行内容`
 *   - 默认大小写敏感；ignoreCase=true 才不敏感
 *   - 正则表达式支持（交替、锚定）
 *   - 无匹配 → 空字符串
 *   - limit 截断 (>2000 截到 2000)
 *   - 非法正则 → ToolExecutionError（消息含 pattern）
 *   - 搜索根越界拒绝
 *   - ripgrep 不可用 → Node fallback
 *   - 取消信号 → 杀进程（SIGTERM→2s→SIGKILL 进程树）
 *   - aci 元数据: category=read-only, isReadOnly=true, isConcurrencySafe=true, interruptBehavior=cancel
 *   - 错误一律 throw ToolExecutionError
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import {
  createGrepTool,
  type GrepToolDeps,
} from "../../../../src/harness/aci/tools/grep.ts";

const scratchPaths: string[] = [];

async function makeScratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    scratchPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("createGrepTool — schema/aci shape", () => {
  it("name === 'grep'", async () => {
    const root = await makeScratch("grep-shape-");
    const tool = createGrepTool(root);
    assert.equal(tool.name, "grep");
  });

  it("inputSchema enforces pattern required and additionalProperties:false", async () => {
    const root = await makeScratch("grep-shape-");
    const tool = createGrepTool(root);
    const schema = tool.inputSchema as Record<string, unknown>;

    assert.equal(schema.type, "object");
    assert.deepEqual(schema.required, ["pattern"]);
    assert.equal(schema.additionalProperties, false);
  });

  it("inputSchema exposes the documented property shapes and defaults", async () => {
    const root = await makeScratch("grep-shape-");
    const tool = createGrepTool(root);
    const schema = tool.inputSchema as {
      properties: Record<
        string,
        {
          type: string;
          default?: unknown;
          minimum?: number;
          maximum?: number;
        }
      >;
    };

    assert.equal(schema.properties.pattern.type, "string");
    assert.equal(schema.properties.path.type, "string");
    assert.equal(schema.properties.ignoreCase.type, "boolean");
    assert.equal(schema.properties.ignoreCase.default, false);
    assert.equal(schema.properties.limit.type, "integer");
    assert.equal(schema.properties.limit.default, 200);
    assert.equal(schema.properties.limit.minimum, 0);
    assert.equal(schema.properties.limit.maximum, 2000);
  });

  it("aci metadata matches the read-only contract", async () => {
    const root = await makeScratch("grep-shape-");
    const tool = createGrepTool(root);

    assert.equal(tool.aci.category, "read-only");
    assert.equal(tool.aci.isReadOnly, true);
    assert.equal(tool.aci.isDestructive, false);
    assert.equal(tool.aci.isConcurrencySafe, true);
    assert.equal(tool.aci.interruptBehavior, "cancel");
  });
});

describe("grep — happy path", () => {
  it("returns relative path:line:content for matching lines (ripgrep present)", async () => {
    const root = await makeScratch("grep-happy-");
    await writeFile(
      join(root, "a.ts"),
      "alpha\nbeta hitOne\ngamma\nhitTwo delta\n",
      "utf8"
    );

    const tool = createGrepTool(root);
    const result = (await tool.handler({ pattern: "hit" })) as string;
    const lines = result.split("\n");

    assert.equal(lines.length, 2);
    assert.equal(lines[0], "a.ts:2:beta hitOne");
    assert.equal(lines[1], "a.ts:4:hitTwo delta");
  });

  it("produces file-relative paths across nested directories", async () => {
    const root = await makeScratch("grep-nested-");
    await mkdir(join(root, "src", "sub"), { recursive: true });
    await writeFile(join(root, "src", "top.ts"), "hit top\n", "utf8");
    await writeFile(
      join(root, "src", "sub", "deep.ts"),
      "hit deep\nskip\n",
      "utf8"
    );

    const tool = createGrepTool(root);
    const result = (await tool.handler({ pattern: "hit" })) as string;
    const lines = result.split("\n").sort();

    assert.deepEqual(lines, [
      "src/sub/deep.ts:1:hit deep",
      "src/top.ts:1:hit top",
    ]);
  });

  it("respects the optional path subdirectory", async () => {
    const root = await makeScratch("grep-subpath-");
    await writeFile(join(root, "keep.ts"), "matchMe\n", "utf8");
    await mkdir(join(root, "focus"));
    await writeFile(join(root, "focus", "hit.ts"), "matchMe\n", "utf8");

    const tool = createGrepTool(root);
    const result = (await tool.handler({
      pattern: "matchMe",
      path: "focus",
    })) as string;

    assert.equal(result, "focus/hit.ts:1:matchMe");
  });

  it("returns an empty string when no lines match", async () => {
    const root = await makeScratch("grep-empty-");
    await writeFile(join(root, "a.ts"), "alpha\nbeta\n", "utf8");

    const tool = createGrepTool(root);
    const result = (await tool.handler({ pattern: "zzz" })) as string;

    assert.equal(result, "");
  });

  it("returns a plain string (not an object or array)", async () => {
    const root = await makeScratch("grep-empty-");
    await writeFile(join(root, "a.ts"), "alpha\n", "utf8");

    const tool = createGrepTool(root);
    const result = await tool.handler({ pattern: "alpha" });

    assert.equal(typeof result, "string");
  });
});

describe("grep — case sensitivity", () => {
  it("is case-sensitive by default (lowercase pattern misses uppercase content)", async () => {
    const root = await makeScratch("grep-case-");
    await writeFile(join(root, "a.ts"), "Hello\nWORLD\n", "utf8");

    const tool = createGrepTool(root);
    const result = (await tool.handler({ pattern: "hello" })) as string;

    assert.equal(result, "");
  });

  it("matches uppercase content when ignoreCase=true", async () => {
    const root = await makeScratch("grep-case-");
    await writeFile(join(root, "a.ts"), "Hello\nWORLD\n", "utf8");

    const tool = createGrepTool(root);
    const result = (await tool.handler({
      pattern: "hello",
      ignoreCase: true,
    })) as string;

    assert.equal(result, "a.ts:1:Hello");
  });
});

describe("grep — regex semantics", () => {
  it("supports alternation (foo|bar)", async () => {
    const root = await makeScratch("grep-regex-");
    await writeFile(join(root, "a.ts"), "foo\nbar\nbaz\nqux\n", "utf8");

    const tool = createGrepTool(root);
    const result = (await tool.handler({ pattern: "foo|bar" })) as string;
    const lines = result.split("\n");

    assert.equal(lines.length, 2);
    assert.equal(lines[0], "a.ts:1:foo");
    assert.equal(lines[1], "a.ts:2:bar");
  });

  it("supports anchors (^start)", async () => {
    const root = await makeScratch("grep-regex-");
    await writeFile(
      join(root, "a.ts"),
      "start here\nend start\nstart\n",
      "utf8"
    );

    const tool = createGrepTool(root);
    const result = (await tool.handler({ pattern: "^start" })) as string;
    const lines = result.split("\n");

    assert.deepEqual(lines, ["a.ts:1:start here", "a.ts:3:start"]);
  });
});

describe("grep — limit truncation", () => {
  it("uses limit=200 by default", async () => {
    const root = await makeScratch("grep-limit-");
    const lines = Array.from({ length: 250 }, () => "match me").join("\n");
    await writeFile(join(root, "flood.txt"), lines + "\n", "utf8");

    const tool = createGrepTool(root);
    const result = (await tool.handler({ pattern: "match" })) as string;
    const resultLines = result.split("\n");

    assert.equal(resultLines.length, 200);
    assert.equal(resultLines[0], "flood.txt:1:match me");
    assert.equal(resultLines[199], "flood.txt:200:match me");
  });

  it("clamps limit values above 2000 down to 2000", async () => {
    const root = await makeScratch("grep-limit-");
    const lines = Array.from({ length: 2500 }, () => "match me").join("\n");
    await writeFile(join(root, "flood.txt"), lines + "\n", "utf8");

    const tool = createGrepTool(root);
    const result = (await tool.handler({
      pattern: "match",
      limit: 9999,
    })) as string;
    const resultLines = result.split("\n");

    assert.equal(resultLines.length, 2000);
    assert.equal(resultLines[0], "flood.txt:1:match me");
    assert.equal(resultLines[1999], "flood.txt:2000:match me");
  });

  it("respects a custom limit lower than the default", async () => {
    const root = await makeScratch("grep-limit-");
    const lines = Array.from({ length: 50 }, () => "hit").join("\n");
    await writeFile(join(root, "few.txt"), lines + "\n", "utf8");

    const tool = createGrepTool(root);
    const result = (await tool.handler({
      pattern: "hit",
      limit: 5,
    })) as string;
    const resultLines = result.split("\n");

    assert.equal(resultLines.length, 5);
    assert.equal(resultLines[0], "few.txt:1:hit");
    assert.equal(resultLines[4], "few.txt:5:hit");
  });
});

describe("grep — invalid regex", () => {
  it("rejects with ToolExecutionError containing the pattern (ripgrep exits 2)", async () => {
    const root = await makeScratch("grep-bad-");
    await writeFile(join(root, "a.ts"), "alpha\n", "utf8");

    const tool = createGrepTool(root);
    const badPattern = "(unclosed";

    await assert.rejects(
      () => tool.handler({ pattern: badPattern }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes(badPattern)
    );
  });
});

describe("grep — search root containment", () => {
  it("rejects a path that escapes the root via parent traversal", async () => {
    const root = await makeScratch("grep-root-");
    const tool = createGrepTool(root);

    await assert.rejects(
      () => tool.handler({ pattern: "foo", path: "../escape" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("outside workspace")
    );
  });

  it("rejects a symlink that resolves outside the workspace root", async () => {
    const root = await makeScratch("grep-symlink-");
    const outside = await makeScratch("grep-outside-");
    await writeFile(join(outside, "secret.ts"), "secret hit\n", "utf8");
    await symlink(outside, join(root, "escape"), "dir");

    const tool = createGrepTool(root);
    await assert.rejects(
      () => tool.handler({ pattern: "hit", path: "escape" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("outside workspace")
    );
  });
});

describe("grep — ripgrep unavailable → Node fallback", () => {
  it("falls back to a Node scan when the ripgrep binary is missing", async () => {
    const root = await makeScratch("grep-fallback-");
    await writeFile(
      join(root, "a.ts"),
      "alpha\nbeta hitOne\ngamma\nhitTwo delta\n",
      "utf8"
    );

    // Inject a stub that pretends `rg` is not present (ENOENT), forcing
    // the implementation to take its Node-fallback branch.
    const deps: GrepToolDeps = {
      spawn: (() => {
        const err = new Error("spawn missing ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        return () => {
          throw err;
        };
      })(),
    };

    const tool = createGrepTool(root, deps);
    const result = (await tool.handler({ pattern: "hit" })) as string;
    const lines = result.split("\n");

    assert.equal(lines.length, 2);
    assert.equal(lines[0], "a.ts:2:beta hitOne");
    assert.equal(lines[1], "a.ts:4:hitTwo delta");
  });

  it("Node fallback honors ignoreCase=true", async () => {
    const root = await makeScratch("grep-fallback-case-");
    await writeFile(join(root, "a.ts"), "Hello\nWORLD\n", "utf8");

    const deps: GrepToolDeps = {
      spawn: (() => {
        const err = new Error("spawn missing ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        return () => {
          throw err;
        };
      })(),
    };

    const tool = createGrepTool(root, deps);
    const result = (await tool.handler({
      pattern: "hello",
      ignoreCase: true,
    })) as string;

    assert.equal(result, "a.ts:1:Hello");
  });

  it("Node fallback rejects an invalid regex with the pattern in the message", async () => {
    const root = await makeScratch("grep-fallback-bad-");
    await writeFile(join(root, "a.ts"), "alpha\n", "utf8");

    const deps: GrepToolDeps = {
      spawn: (() => {
        const err = new Error("spawn missing ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        return () => {
          throw err;
        };
      })(),
    };

    const tool = createGrepTool(root, deps);
    const bad = "(unclosed";
    await assert.rejects(
      () => tool.handler({ pattern: bad }),
      (error: unknown) =>
        error instanceof ToolExecutionError && error.message.includes(bad)
    );
  });
});

describe("grep — abort kills the ripgrep child process tree", () => {
  it("an already-aborted signal rejects with a typed abort error", async () => {
    const root = await makeScratch("grep-abort-");
    const filler = "a".repeat(200_000);
    await writeFile(join(root, "huge.txt"), filler);

    const tool = createGrepTool(root);
    const controller = new AbortController();
    controller.abort(); // Pre-abort: signal arrives before spawn.

    // The aborted signal must propagate; spawnWithStopSignal kills the
    // child immediately. The handler must reject with a typed abort
    // error and must NOT hang.
    await assert.rejects(
      () => tool.handler({ pattern: "a" }, { signal: controller.signal }),
      (error: unknown) =>
        error instanceof ToolExecutionError && /aborted/i.test(error.message)
    );
  }, 5_000);

  it("does not hang when the signal is aborted mid-flight", async () => {
    const root = await makeScratch("grep-abort-mid-");
    const filler = "a".repeat(200_000);
    await writeFile(join(root, "big.txt"), filler);

    const tool = createGrepTool(root);
    const controller = new AbortController();

    const promise = tool.handler(
      { pattern: "a" },
      { signal: controller.signal }
    );

    // Abort almost immediately.
    setTimeout(() => controller.abort(), 5).unref();

    // Bound the wait — if abort did not propagate, this Promise will hang
    // until the inner race rejects. A successful reject before the
    // deadline confirms the kill path returned.
    await assert.rejects(
      () =>
        Promise.race([
          promise,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("grep did not abort in time")),
              4_000
            )
          ),
        ]),
      (error: unknown) =>
        error instanceof ToolExecutionError ||
        (error instanceof Error && /aborted/.test(error.message))
    );
  }, 5_000);
});
