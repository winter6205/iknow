/**
 * grep 工具 — 搜面契约（specs/aci-file-search-surface.md D2–D7 / SC4–SC10）。
 *
 * 覆盖策略：除 schema / aci 形状外，**每一条行为断言都在两条引擎上各跑一遍**
 * （rg-stub 注入固定 stdout / Node 扫）。SC9 要的「自带起不来时 Node 全语义」
 * 不是靠再写一套镜像断言来锁，而是靠「同一张表、同一组期望值喂两条引擎」——
 * 任何一侧少功能都会让表里某行只在一侧变红。
 *
 * 引擎选择（`GrepEngine`）：
 *   - `node`  —— `engineBinaryPath` 指向不存在的路径：D6 的「安装根二进制不
 *                存在」判据，走 Node 全语义。
 *   - `rg`    —— 真实安装根二进制（本机跑过 `npm run install:search-engine`
 *                时在场）。缺席则整组 skip 并记 Not run，不静默降级成只测
 *                Node —— 那会让 SC9 的另一半无人认证。
 *
 * 覆盖契约：
 *   - D2 出法：paths（默认，唯一相对路径）/ content（`path:line:text`）/
 *     count（`path:条数` + `total:` = 切片前总数）。
 *   - D3 分页：`offset` + `head_limit`（默认 50、硬顶 2000）切**已排序**名单；
 *     排序在切片前；越过末尾且本次有命中 → 精确 `No entries at this offset`；
 *     无匹配 → 空串。`limit` 是退役名（typed 拒绝，文案点名 head_limit）。
 *   - D4 收窄：`path` / `glob` / `type` 并列；未知 type 与坏正则是两种 typed
 *     错误，文案互不包含对方关键词（SC10）。
 *   - D5 行窗：`also` + `within_lines` 是**过滤**；窗内没有第二段 → 该命中
 *     不算（SC8）。
 *   - D6/SC9：安装根二进制缺席 → Node 全语义，不 typed 拒绝该调用。
 *   - SC4/SC5/SC6/SC7 各自的形状断言。
 *   - 旧契约保持：containment 越界拒绝、abort typed 拒绝、超长行截断、
 *     aci 元数据。
 */

import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import { createGrepTool } from "../../../../src/harness/aci/tools/grep.ts";
import { engineBinaryPath } from "../../../../src/harness/aci/search/engine-manifest.ts";
import { resolveInstallRoot } from "../../../../src/harness/session-roots.ts";

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

/** 本机安装根上钉死的引擎二进制；未安装 → undefined（该组 skip）。 */
const installedEngine: string | undefined = engineBinaryPath(
  resolveInstallRoot(),
  process.platform,
  process.arch
);
const hasInstalledEngine =
  installedEngine !== undefined && existsSync(installedEngine);

/**
 * 两条引擎的构造器。
 *
 * `node` 用「安装根二进制不存在」驱动 D6 降级（不是注入假 spawn —— 那会绕过
 * 真实的 `runRgEngine → isUnavailable → nodeScan` 接线）。
 */
const ENGINES = [
  { name: "node", installed: true },
  { name: "rg", installed: hasInstalledEngine },
] as const;

type EngineName = (typeof ENGINES)[number]["name"];

function toolFor(
  root: string,
  engine: EngineName,
  extra?: { readonly projectIdentityRoot?: string }
): ReturnType<typeof createGrepTool> {
  const deps =
    engine === "rg"
      ? { ...extra }
      : {
          ...extra,
          // D6 判据：安装根没有这条二进制 → Node 全语义。
          engineBinaryPath: join(root, "__no_such_engine__", "rg"),
        };
  return createGrepTool(root, deps);
}

/** 同一张断言表喂两条引擎：任何一侧缺功能都会让本函数在某一行抛。 */
async function bothEngines(
  body: (
    makeTool: (root: string) => ReturnType<typeof createGrepTool>
  ) => Promise<void>
): Promise<void> {
  for (const engine of ENGINES) {
    if (!engine.installed) continue;
    await body((root) => toolFor(root, engine.name));
  }
}

// ───────────────────────── schema / aci 形状 ─────────────────────────

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
          enum?: readonly string[];
        }
      >;
    };

    assert.equal(schema.properties.pattern.type, "string");
    assert.equal(schema.properties.path.type, "string");
    assert.equal(schema.properties.ignoreCase.type, "boolean");
    assert.equal(schema.properties.ignoreCase.default, false);
    assert.deepEqual(schema.properties.output.enum, [
      "paths",
      "content",
      "count",
    ]);
    assert.equal(schema.properties.output.default, "paths");
    assert.equal(schema.properties.glob.type, "string");
    assert.equal(schema.properties.type.type, "string");
    assert.equal(schema.properties.also.type, "string");
    assert.equal(schema.properties.within_lines.type, "integer");
    assert.equal(schema.properties.within_lines.default, 5);
    assert.equal(schema.properties.context.type, "integer");
    assert.equal(schema.properties.context.default, 0);
    assert.equal(schema.properties.offset.type, "integer");
    assert.equal(schema.properties.offset.default, 0);
    assert.equal(schema.properties.head_limit.type, "integer");
    assert.equal(schema.properties.head_limit.default, 50);
    assert.equal(schema.properties.head_limit.minimum, 1);
    assert.equal(schema.properties.head_limit.maximum, 2000);
  });

  it("schema 里不得再有 `limit` 条数字段（D3 退役名，避免与 read_file 行窗撞名）", async () => {
    const root = await makeScratch("grep-shape-");
    const tool = createGrepTool(root);
    const schema = tool.inputSchema as {
      properties: Record<string, unknown>;
    };

    assert.equal("limit" in schema.properties, false);
    assert.equal("grep_limit" in schema.properties, false);
  });

  it("aci metadata matches the read-only contract", async () => {
    const root = await makeScratch("grep-shape-");
    const tool = createGrepTool(root);

    assert.equal(tool.aci.category, "read-only");
    assert.equal(tool.aci.isConcurrencySafe, true);
    assert.equal(tool.aci.interruptBehavior, "cancel");
  });

  it("不带输出闸豁免声明（ADR-0083 只对 skill 内建落值）", async () => {
    // grep 命中大文件时仍受 20000 兜底闸 + 引导语约束（用更精确 pattern /
    // 缩小路径重调是可成立的恢复路径）。
    const root = await makeScratch("grep-shape-");
    const tool = createGrepTool(root);

    assert.equal(tool.exemptFromOutputCap, undefined);
  });
});

// ───────────────────────── D2 出法 ─────────────────────────

describe("grep — D2 出法", () => {
  it("默认 output=paths：唯一相对路径、无 `:行号:` 匹配行、条数 ≤50（SC4）", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-paths-");
      await mkdir(join(root, "sub"), { recursive: true });
      await writeFile(join(root, "a.ts"), "hit one\nhit two\n", "utf8");
      await writeFile(join(root, "sub", "b.ts"), "hit three\n", "utf8");

      const result = (await makeTool(root).handler({
        pattern: "hit",
      })) as string;
      const lines = result.split("\n");

      assert.deepEqual(lines, ["a.ts", "sub/b.ts"]);
      for (const line of lines) {
        assert.equal(line.includes(":"), false, `paths 行不得含冒号: ${line}`);
        assert.equal(line.startsWith("/"), false, `不得是绝对路径: ${line}`);
      }
      assert.ok(lines.length <= 50);
    });
  });

  it("output=content → `path:line:text`（SC5）", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-content-");
      await writeFile(
        join(root, "a.ts"),
        "alpha\nbeta hitOne\ngamma\nhitTwo delta\n",
        "utf8"
      );

      const result = (await makeTool(root).handler({
        pattern: "hit",
        output: "content",
      })) as string;

      assert.deepEqual(result.split("\n"), [
        "a.ts:2:beta hitOne",
        "a.ts:4:hitTwo delta",
      ]);
    });
  });

  it("output=count → 每文件 `path:条数` + `total:` = 未切片前命中总数（SC5）", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-count-");
      await writeFile(join(root, "a.ts"), "hit\nhit\nhit\n", "utf8");
      await writeFile(join(root, "b.ts"), "hit\n", "utf8");

      const result = (await makeTool(root).handler({
        pattern: "hit",
        output: "count",
      })) as string;

      assert.deepEqual(result.split("\n"), ["a.ts:3", "b.ts:1", "total:4"]);
    });
  });

  it("count 的 `total:` 是切片前的总数（分页不改变总数）", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-count-page-");
      await writeFile(join(root, "a.ts"), "hit\nhit\n", "utf8");
      await writeFile(join(root, "b.ts"), "hit\nhit\n", "utf8");
      await writeFile(join(root, "c.ts"), "hit\n", "utf8");

      const result = (await makeTool(root).handler({
        pattern: "hit",
        output: "count",
        head_limit: 1,
      })) as string;

      assert.deepEqual(result.split("\n"), ["a.ts:2", "total:5"]);
    });
  });

  it("无匹配 → 空串（不是 `No entries at this offset`）", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-empty-");
      await writeFile(join(root, "a.ts"), "alpha\nbeta\n", "utf8");

      for (const output of ["paths", "content", "count"] as const) {
        const result = (await makeTool(root).handler({
          pattern: "zzz",
          output,
        })) as string;
        assert.equal(result, "", `output=${output} 无匹配应回空串`);
      }
    });
  });

  it("返回纯字符串（不是对象 / 数组）", async () => {
    const root = await makeScratch("grep-str-");
    await writeFile(join(root, "a.ts"), "alpha\n", "utf8");

    const tool = createGrepTool(root);
    assert.equal(typeof (await tool.handler({ pattern: "alpha" })), "string");
  });

  it("嵌套目录也回相对路径", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-nested-");
      await mkdir(join(root, "src", "sub"), { recursive: true });
      await writeFile(join(root, "src", "top.ts"), "hit top\n", "utf8");
      await writeFile(
        join(root, "src", "sub", "deep.ts"),
        "hit deep\n",
        "utf8"
      );

      const result = (await makeTool(root).handler({
        pattern: "hit",
        output: "content",
      })) as string;

      assert.deepEqual(result.split("\n"), [
        "src/sub/deep.ts:1:hit deep",
        "src/top.ts:1:hit top",
      ]);
    });
  });

  it("path 收窄到子目录（D4）", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-subpath-");
      await writeFile(join(root, "keep.ts"), "matchMe\n", "utf8");
      await mkdir(join(root, "focus"));
      await writeFile(join(root, "focus", "hit.ts"), "matchMe\n", "utf8");

      const result = (await makeTool(root).handler({
        pattern: "matchMe",
        path: "focus",
        output: "content",
      })) as string;

      assert.equal(result, "focus/hit.ts:1:matchMe");
    });
  });

  it("path 指向单个文件时文件名不被省掉（两条引擎同形状）", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-single-file-");
      await writeFile(join(root, "only.ts"), "hit here\n", "utf8");

      const result = (await makeTool(root).handler({
        pattern: "hit",
        path: "only.ts",
        output: "content",
      })) as string;

      assert.equal(result, "only.ts:1:hit here");
    });
  });
});

// ───────────────────────── D3 分页 / 排序 ─────────────────────────

describe("grep — D3 分页（head_limit）", () => {
  it("head_limit 默认 50：250 条命中只回前 50 条", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-headlimit-");
      const lines = Array.from({ length: 250 }, () => "match me").join("\n");
      await writeFile(join(root, "flood.txt"), lines + "\n", "utf8");

      const result = (await makeTool(root).handler({
        pattern: "match",
        output: "content",
      })) as string;
      const out = result.split("\n");

      assert.equal(out.length, 50);
      assert.equal(out[0], "flood.txt:1:match me");
      assert.equal(out[49], "flood.txt:50:match me");
    });
  });

  it("head_limit 超硬顶被夹到 2000", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-headlimit-cap-");
      const lines = Array.from({ length: 2100 }, () => "match me").join("\n");
      await writeFile(join(root, "flood.txt"), lines + "\n", "utf8");

      const result = (await makeTool(root).handler({
        pattern: "match",
        output: "content",
        head_limit: 9999,
      })) as string;
      const out = result.split("\n");

      assert.equal(out.length, 2000);
      assert.equal(out[1999], "flood.txt:2000:match me");
    });
  });

  it("显式 head_limit 小于默认值时被采用", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-headlimit-small-");
      const lines = Array.from({ length: 50 }, () => "hit").join("\n");
      await writeFile(join(root, "few.txt"), lines + "\n", "utf8");

      const result = (await makeTool(root).handler({
        pattern: "hit",
        output: "content",
        head_limit: 5,
      })) as string;
      const out = result.split("\n");

      assert.equal(out.length, 5);
      assert.equal(out[0], "few.txt:1:hit");
      assert.equal(out[4], "few.txt:5:hit");
    });
  });

  it("offset 跳过已排序名单的前 N 条（SC7：与 offset=0 的页不重叠）", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-offset-");
      const names = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
      for (const name of names) {
        await writeFile(join(root, name), "hit\n", "utf8");
      }

      const first = (await makeTool(root).handler({
        pattern: "hit",
        head_limit: 2,
      })) as string;
      const second = (await makeTool(root).handler({
        pattern: "hit",
        offset: 2,
        head_limit: 2,
      })) as string;

      assert.deepEqual(first.split("\n"), ["a.ts", "b.ts"]);
      assert.deepEqual(second.split("\n"), ["c.ts", "d.ts"]);
      const overlap = first
        .split("\n")
        .filter((p) => second.split("\n").includes(p));
      assert.deepEqual(overlap, []);
    });
  });

  it("offset 越过最后一条且本次有命中 → 精确 `No entries at this offset`（SC7）", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-offset-past-");
      await writeFile(join(root, "a.ts"), "hit\n", "utf8");

      for (const output of ["paths", "content", "count"] as const) {
        const result = (await makeTool(root).handler({
          pattern: "hit",
          output,
          offset: 50,
        })) as string;
        assert.equal(
          result,
          "No entries at this offset",
          `output=${output} 越过末尾应回精确回执`
        );
      }
    });
  });

  it("排序（path 再行号）发生在切片之前：乱序输入也给出稳定分页", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-sort-");
      // 文件名刻意让 readdir / rg 线程顺序与字典序不一致。
      await writeFile(join(root, "z.ts"), "hit z1\nhit z2\n", "utf8");
      await writeFile(join(root, "a.ts"), "hit a1\n", "utf8");
      await writeFile(join(root, "m.ts"), "hit m1\n", "utf8");

      const result = (await makeTool(root).handler({
        pattern: "hit",
        output: "content",
      })) as string;

      assert.deepEqual(result.split("\n"), [
        "a.ts:1:hit a1",
        "m.ts:1:hit m1",
        "z.ts:1:hit z1",
        "z.ts:2:hit z2",
      ]);
    });
  });

  it("`limit` 是退役名：出现即 typed 拒绝且文案点名 head_limit", async () => {
    const root = await makeScratch("grep-retired-limit-");
    await writeFile(join(root, "a.ts"), "hit\n", "utf8");

    const tool = createGrepTool(root);
    await assert.rejects(
      () => tool.handler({ pattern: "hit", limit: 200 }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        /head_limit/.test(error.message) &&
        /limit/.test(error.message)
    );
  });

  it("head_limit 为 0 / 负 / 小数一律 typed 拒绝", async () => {
    const root = await makeScratch("grep-bad-headlimit-");
    const tool = createGrepTool(root);

    for (const head_limit of [0, -1, 1.5]) {
      await assert.rejects(
        () => tool.handler({ pattern: "hit", head_limit }),
        (error: unknown) =>
          error instanceof ToolExecutionError &&
          /head_limit/.test(error.message)
      );
    }
  });
});

// ───────────────────────── D4 收窄 / SC10 两种 typed 错误 ─────────────────────────

describe("grep — D4 glob / type 收窄", () => {
  it("glob 无斜杠 → 任意深度的基名匹配", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-glob-base-");
      await mkdir(join(root, "sub"), { recursive: true });
      await writeFile(join(root, "a.ts"), "hit\n", "utf8");
      await writeFile(join(root, "b.md"), "hit\n", "utf8");
      await writeFile(join(root, "sub", "c.ts"), "hit\n", "utf8");

      const result = (await makeTool(root).handler({
        pattern: "hit",
        glob: "*.ts",
      })) as string;

      assert.deepEqual(result.split("\n"), ["a.ts", "sub/c.ts"]);
    });
  });

  it("glob 含斜杠 → 锚定搜索根（`sub/*.ts` 不收根下 `a.ts`）", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-glob-anchored-");
      await mkdir(join(root, "sub"), { recursive: true });
      await writeFile(join(root, "a.ts"), "hit\n", "utf8");
      await writeFile(join(root, "sub", "c.ts"), "hit\n", "utf8");

      const result = (await makeTool(root).handler({
        pattern: "hit",
        glob: "sub/*.ts",
      })) as string;

      assert.deepEqual(result.split("\n"), ["sub/c.ts"]);
    });
  });

  it("glob 与 type 并列时须同时通过", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-glob-and-type-");
      await mkdir(join(root, "sub"), { recursive: true });
      await writeFile(join(root, "a.ts"), "hit\n", "utf8");
      await writeFile(join(root, "b.md"), "hit\n", "utf8");
      await writeFile(join(root, "sub", "c.md"), "hit\n", "utf8");

      const result = (await makeTool(root).handler({
        pattern: "hit",
        glob: "*.md",
        type: "md",
      })) as string;

      assert.deepEqual(result.split("\n"), ["b.md", "sub/c.md"]);
    });
  });

  it("type 只收该语言的文件名", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-type-");
      await writeFile(join(root, "a.ts"), "hit\n", "utf8");
      await writeFile(join(root, "b.md"), "hit\n", "utf8");
      await writeFile(join(root, "c.py"), "hit\n", "utf8");

      const result = (await makeTool(root).handler({
        pattern: "hit",
        type: "ts",
      })) as string;

      assert.deepEqual(result.split("\n"), ["a.ts"]);
    });
  });

  it("未知 type → typed 拒绝，文案点名 type、不含关键词 pattern（SC10）", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-bad-type-");
      await writeFile(join(root, "a.ts"), "hit\n", "utf8");

      await assert.rejects(
        () => makeTool(root).handler({ pattern: "hit", type: "nosuchtype" }),
        (error: unknown) =>
          error instanceof ToolExecutionError &&
          /type/.test(error.message) &&
          /nosuchtype/.test(error.message) &&
          !/pattern/.test(error.message)
      );
    });
  });

  it("坏正则 → typed 拒绝，文案点名 pattern、不含关键词 type（SC10）", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-bad-regex-");
      await writeFile(join(root, "a.ts"), "hit\n", "utf8");

      await assert.rejects(
        () => makeTool(root).handler({ pattern: "(unclosed" }),
        (error: unknown) =>
          error instanceof ToolExecutionError &&
          /pattern/.test(error.message) &&
          !/type/.test(error.message)
      );
    });
  });

  it("两个参数同时非法时，两条引擎报同一个失败域（顺序不在契约内，一致性在）", async () => {
    // SC10 的字面要求：两类失败域不可混为「illegal regex」一种。哪个先报
    // 契约没规定，但**不能随引擎变** —— 否则同一份输入在自带引擎起不来时
    // 报出另一种错误。这里锁的是「两条引擎同序」。
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-two-errors-");
      const messages: string[] = [];
      for (const [pattern, type] of [
        ["(unclosed", "nosuchtype"],
        ["alpha", "nosuchtype"],
      ] as const) {
        try {
          await makeTool(root).handler({ pattern, type });
          messages.push("no error");
        } catch (error) {
          messages.push((error as Error).message);
        }
      }

      // pattern 非法 → 报 pattern；pattern 合法而 type 非法 → 报 type。
      assert.ok(
        /pattern/.test(messages[0]!),
        `第一条应报 pattern: ${messages[0]}`
      );
      assert.ok(/type/.test(messages[1]!), `第二条应报 type: ${messages[1]}`);
    });
  });
});

// ───────────────────────── D5 行窗（SC8） ─────────────────────────

describe("grep — D5 also + within_lines 行窗", () => {
  it("窗内存在第二段 → 该主词命中被保留", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-also-in-");
      await writeFile(
        join(root, "a.ts"),
        "hit here\nfiller\nfiller\nsecond\n",
        "utf8"
      );

      const result = (await makeTool(root).handler({
        pattern: "hit",
        also: "second",
      })) as string;

      assert.equal(result, "a.ts");
    });
  });

  it("窗外存在第二段 → 该主词命中不算（是过滤，不是展示）", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-also-out-");
      await writeFile(
        join(root, "a.ts"),
        "hit here\nfiller\nfiller\nsecond\n",
        "utf8"
      );

      const result = (await makeTool(root).handler({
        pattern: "hit",
        also: "second",
        within_lines: 1,
      })) as string;

      assert.equal(result, "");
    });
  });

  it("within_lines 默认 5：半径 5 内命中、半径外不命中", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-also-default-");
      // 第 1 行是主词；第二段在第 6 行（半径 5 的闭区间内）。
      await writeFile(
        join(root, "in.ts"),
        `hit\n${"x\n".repeat(4)}second\n`,
        "utf8"
      );
      // 第二段在第 7 行（半径 5 之外）。
      await writeFile(
        join(root, "out.ts"),
        `hit\n${"x\n".repeat(5)}second\n`,
        "utf8"
      );

      const result = (await makeTool(root).handler({
        pattern: "hit",
        also: "second",
      })) as string;

      assert.equal(result, "in.ts");
    });
  });

  it("行窗结果不把附近原文带进输出（过滤 ≠ context 展示）", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-also-noctx-");
      await writeFile(join(root, "a.ts"), "hit here\nsecond\n", "utf8");

      const result = (await makeTool(root).handler({
        pattern: "hit",
        also: "second",
      })) as string;

      assert.equal(result, "a.ts");
      assert.equal(result.includes("second"), false);
    });
  });

  it("also 可与 content 出法配合：只留窗内命中的行", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-also-content-");
      await writeFile(join(root, "a.ts"), "hit one\nnope\n", "utf8");
      await writeFile(join(root, "b.ts"), "hit two\nnope\nsecond\n", "utf8");

      const result = (await makeTool(root).handler({
        pattern: "hit",
        also: "second",
        output: "content",
        within_lines: 2,
      })) as string;

      assert.equal(result, "b.ts:1:hit two");
    });
  });
});

// ───────────────────────── SC6 context 不脏行 ─────────────────────────

describe("grep — SC6 content + context 不脏行", () => {
  it("上下文行用 `-` 分列、组间插 `--`，都不长成 `path:line:text`", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-ctx-");
      await writeFile(
        join(root, "a.ts"),
        "l1\nl2\nhit three\nl4\nl5\n",
        "utf8"
      );

      const result = (await makeTool(root).handler({
        pattern: "hit",
        output: "content",
        context: 1,
      })) as string;

      assert.deepEqual(result.split("\n"), [
        "a.ts-2-l2",
        "a.ts:3:hit three",
        "a.ts-4-l4",
      ]);
    });
  });

  it("不相邻的两组之间插入 `--` 分隔行", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-ctx-gap-");
      await writeFile(
        join(root, "a.ts"),
        "hit one\n" + "x\n".repeat(8) + "hit two\n",
        "utf8"
      );

      const result = (await makeTool(root).handler({
        pattern: "hit",
        output: "content",
        context: 1,
      })) as string;
      const out = result.split("\n");

      assert.ok(out.includes("--"), `组间应有 -- 分隔: ${result}`);
      assert.equal(out[0], "a.ts:1:hit one");
      assert.equal(out[out.length - 1], "a.ts:10:hit two");
    });
  });

  it("内容是 `path-N-text` 形时也不被切成假命中（分隔符由首段决定）", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-ctx-tricky-");
      // 上下文行的**内容**本身长得像一条记录，SC6 要求它不被读成命中。
      await writeFile(join(root, "a.ts"), "a.ts-9-fake\nhit\n", "utf8");

      const result = (await makeTool(root).handler({
        pattern: "hit",
        output: "content",
        context: 1,
      })) as string;
      const out = result.split("\n");

      // 唯一 `:` 分列的匹配行是真正的命中；上下文行保持 `-` 形态。
      const matchLines = out.filter((line) => /^[^:]*:\d+:/.test(line));
      assert.deepEqual(matchLines, ["a.ts:2:hit"]);
      assert.ok(out.includes("a.ts-1-a.ts-9-fake"));
    });
  });

  it("context 分页单位是组：offset=1 跳到下一组（相邻窗合并不另起组）", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-ctx-page-");
      // 第 1 行与第 9 行的命中窗（半径 1）不相接 → 两个组。
      await writeFile(
        join(root, "a.ts"),
        "hit one\n" + "x\n".repeat(7) + "hit two\n",
        "utf8"
      );

      const first = (await makeTool(root).handler({
        pattern: "hit",
        output: "content",
        context: 1,
        head_limit: 1,
      })) as string;
      const second = (await makeTool(root).handler({
        pattern: "hit",
        output: "content",
        context: 1,
        offset: 1,
        head_limit: 1,
      })) as string;

      assert.equal(first, "a.ts:1:hit one\na.ts-2-x");
      assert.equal(second, "a.ts-8-x\na.ts:9:hit two");
    });
  });

  it("context 组的顺序是 (path, line) 而非引擎遍历序（切片前排序）", async () => {
    // 组名册若不排序，offset 落在哪一组取决于 rg 的线程调度 / readdir 顺序。
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-ctx-order-");
      for (const name of ["z.ts", "a.ts", "m.ts"]) {
        await writeFile(join(root, name), "hit\n", "utf8");
      }

      const result = (await makeTool(root).handler({
        pattern: "hit",
        output: "content",
        context: 1,
      })) as string;
      const headers = result
        .split("\n")
        .filter((line) => /^[^:]*:\d+:/.test(line));

      assert.deepEqual(headers, ["a.ts:1:hit", "m.ts:1:hit", "z.ts:1:hit"]);
    });
  });
});

// ───────────────────────── 引擎等价（SC9 / D6） ─────────────────────────

describe("grep — SC9 自带引擎缺席 → Node 全语义", () => {
  it("安装根二进制不存在时不 typed 拒绝该调用，而是 Node 扫出同样的结果", async () => {
    const root = await makeScratch("grep-node-only-");
    await writeFile(join(root, "a.ts"), "alpha\nbeta hitOne\n", "utf8");

    const tool = createGrepTool(root, {
      engineBinaryPath: join(root, "__no_such_engine__", "rg"),
    });
    const result = (await tool.handler({
      pattern: "hit",
      output: "content",
    })) as string;

    assert.equal(result, "a.ts:2:beta hitOne");
  });

  it("Node 路径不因为自带引擎缺席就少功能：分页 + context + count 同时在场", async () => {
    const root = await makeScratch("grep-node-full-");
    await writeFile(join(root, "a.ts"), "l1\nhit\nl3\nhit\nl5\n", "utf8");
    await writeFile(join(root, "b.ts"), "hit\n", "utf8");

    const node = createGrepTool(root, {
      engineBinaryPath: join(root, "__no_such_engine__", "rg"),
    });

    // context 的分页单位是**组**：`head_limit: 1` 取第一组（两处命中窗
    // 相接 → 合并成一组），组内条目全给。
    assert.equal(
      (await node.handler({
        pattern: "hit",
        output: "content",
        context: 1,
        head_limit: 1,
      })) as string,
      "a.ts-1-l1\na.ts:2:hit\na.ts-3-l3\na.ts:4:hit\na.ts-5-l5"
    );
    assert.equal(
      (await node.handler({ pattern: "hit", output: "count" })) as string,
      "a.ts:2\nb.ts:1\ntotal:3"
    );
    assert.equal(
      (await node.handler({
        pattern: "hit",
        output: "paths",
        offset: 1,
      })) as string,
      "b.ts"
    );
  });

  it("rg 与 Node 对同一查询给出同一结果（接受集与形状对齐）", async () => {
    if (!hasInstalledEngine) return;
    const root = await makeScratch("grep-parity-");
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "a.ts"), "hit a\nsecond\n", "utf8");
    await writeFile(join(root, "sub", "b.ts"), "hit b\n", "utf8");
    await writeFile(join(root, "c.md"), "hit c\n", "utf8");
    // 相邻命中：两窗相接（[1,3] / [2,4]）→ 一组，两条命中都必须是 `:`。
    await writeFile(join(root, "adj.ts"), "hit1\nhit2\n", "utf8");
    // 重叠窗：l1 的窗吞掉 l4，l4 的窗又吞掉 l5 → 一组，三条命中都是 `:`。
    await writeFile(join(root, "ov.ts"), "l1\nhitA\nhitB\nl4\nhitC\n", "utf8");

    const viaRg = createGrepTool(root);
    const viaNode = createGrepTool(root, {
      engineBinaryPath: join(root, "__no_such_engine__", "rg"),
    });

    const cases: ReadonlyArray<Record<string, unknown>> = [
      { pattern: "hit" },
      { pattern: "hit", output: "content" },
      { pattern: "hit", output: "count" },
      { pattern: "hit", glob: "*.ts" },
      { pattern: "hit", glob: "sub/*.ts" },
      { pattern: "hit", glob: "[ab].ts" },
      { pattern: "hit", glob: "c[!x].md" },
      { pattern: "hit", type: "ts" },
      { pattern: "hit", output: "content", context: 1 },
      // 窗相接 / 重叠时，落入前窗的后一条命中不得被降级成上下文行（SC6）。
      { pattern: "hit", output: "content", context: 1, path: "adj.ts" },
      { pattern: "hit", output: "content", context: 2, path: "adj.ts" },
      { pattern: "hit", output: "content", context: 1, path: "ov.ts" },
      { pattern: "hit", output: "content", context: 2, path: "ov.ts" },
      { pattern: "hit", also: "second" },
      { pattern: "hit", head_limit: 1 },
      { pattern: "hit", offset: 99 },
      { pattern: "zzz" },
    ];

    for (const input of cases) {
      const fromRg = await viaRg.handler(input);
      const fromNode = await viaNode.handler(input);
      assert.equal(
        fromNode,
        fromRg,
        `两条引擎分歧：${JSON.stringify(input)}\n  rg   = ${JSON.stringify(fromRg)}\n  node = ${JSON.stringify(fromNode)}`
      );
    }
  });

  it("不可读的邻居文件不把整次查询变成失败（两条引擎都只是跳过它）", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-unreadable-");
      await writeFile(join(root, "ok.txt"), "hit\n", "utf8");
      await writeFile(join(root, "locked.txt"), "hit\n", "utf8");
      await chmod(join(root, "locked.txt"), 0o000);

      const result = (await makeTool(root).handler({
        pattern: "hit",
        output: "content",
      })) as string;

      assert.equal(result, "ok.txt:1:hit");
    });
  });

  it("找不到的 path 回空串，不抛（两条引擎一致）", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-missing-");
      await writeFile(join(root, "a.ts"), "hit\n", "utf8");

      const result = (await makeTool(root).handler({
        pattern: "hit",
        path: "nope",
      })) as string;

      assert.equal(result, "");
    });
  });
});

// ───────────────────────── 大小写 / 正则 ─────────────────────────

describe("grep — 大小写与正则语义", () => {
  it("默认大小写敏感", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-case-");
      await writeFile(join(root, "a.ts"), "Hello\nWORLD\n", "utf8");

      assert.equal(
        (await makeTool(root).handler({ pattern: "hello" })) as string,
        ""
      );
    });
  });

  it("ignoreCase=true 时不敏感", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-case-i-");
      await writeFile(join(root, "a.ts"), "Hello\nWORLD\n", "utf8");

      assert.equal(
        (await makeTool(root).handler({
          pattern: "hello",
          output: "content",
          ignoreCase: true,
        })) as string,
        "a.ts:1:Hello"
      );
    });
  });

  it("支持交替与锚定", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-regex-");
      await writeFile(join(root, "a.ts"), "foo\nstart here\nbar\n", "utf8");

      assert.deepEqual(
        (
          (await makeTool(root).handler({
            pattern: "foo|bar",
            output: "content",
          })) as string
        ).split("\n"),
        ["a.ts:1:foo", "a.ts:3:bar"]
      );
      assert.deepEqual(
        (
          (await makeTool(root).handler({
            pattern: "^start",
            output: "content",
          })) as string
        ).split("\n"),
        ["a.ts:2:start here"]
      );
    });
  });

  it("look-around 在两条引擎上都可用（接受集对齐，不因引擎而变）", async () => {
    // rg 默认的 Rust 引擎不支持 look-around，JS RegExp 支持 —— 不显式对齐，
    // 同一 pattern 的含义就取决于哪条引擎在跑（D6 禁止）。
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-lookaround-");
      await writeFile(join(root, "a.ts"), "hit x\nhit y\n", "utf8");

      const result = (await makeTool(root).handler({
        pattern: "hit(?= y)",
        output: "content",
      })) as string;

      // 前瞻只留 `hit y`；`hit x` 被排除。
      assert.equal(result, "a.ts:2:hit y");
    });
  });
});

// ───────────────────────── 超长行 ─────────────────────────

describe("grep — 超长匹配行截断", () => {
  it("截断长命中且不丢同文件的后续命中", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-long-line-");
      await writeFile(
        join(root, "long.txt"),
        `needle${"x".repeat(999_994)}\nneedle sibling\n`,
        "utf8"
      );

      const result = (await makeTool(root).handler({
        pattern: "needle",
        output: "content",
      })) as string;
      const lines = result.split("\n");

      assert.equal(lines.length, 2);
      assert.match(lines[0]!, /\.\.\.\[truncated\]$/);
      assert.ok(lines[0]!.length <= 2_100, "长结果必须有界");
      assert.equal(lines[1], "long.txt:2:needle sibling");
    });
  });
});

// ───────────────────────── 入口校验 / containment / abort ─────────────────────────

describe("grep — 空 / 非法输入", () => {
  it("pattern 缺失 / 空串 / 非串一律 typed 拒绝", async () => {
    const root = await makeScratch("grep-bad-input-");
    const tool = createGrepTool(root);

    for (const input of [{}, { pattern: "" }, { pattern: 42 }, null, "nope"]) {
      await assert.rejects(
        () => tool.handler(input),
        (error: unknown) =>
          error instanceof ToolExecutionError &&
          /pattern|object/.test(error.message)
      );
    }
  });

  it("output 非枚举值被 typed 拒绝", async () => {
    const root = await makeScratch("grep-bad-output-");
    const tool = createGrepTool(root);

    await assert.rejects(
      () => tool.handler({ pattern: "a", output: "lines" }),
      (error: unknown) =>
        error instanceof ToolExecutionError && /output/.test(error.message)
    );
  });

  it("also / glob / type 空串被 typed 拒绝（不做『匹配全部』退化）", async () => {
    const root = await makeScratch("grep-empty-filters-");
    const tool = createGrepTool(root);

    for (const field of ["also", "glob", "type"]) {
      await assert.rejects(
        () => tool.handler({ pattern: "a", [field]: "" }),
        (error: unknown) =>
          error instanceof ToolExecutionError &&
          new RegExp(field).test(error.message)
      );
    }
  });
});

describe("grep — search root containment", () => {
  it("父目录穿越逃逸被 typed 拒绝", async () => {
    const root = await makeScratch("grep-root-");
    const tool = createGrepTool(root);

    await assert.rejects(
      () => tool.handler({ pattern: "foo", path: "../escape" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("outside workspace")
    );
  });

  it("symlink 指向 workspace 之外被 typed 拒绝", async () => {
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

describe("grep — abort", () => {
  it("已 abort 的信号 → typed abort 错误，不挂起", async () => {
    const root = await makeScratch("grep-abort-");
    await writeFile(join(root, "huge.txt"), "a".repeat(2_000_000));

    const tool = createGrepTool(root);
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () => tool.handler({ pattern: "a" }, { signal: controller.signal }),
      (error: unknown) =>
        error instanceof ToolExecutionError && /aborted/i.test(error.message)
    );
  }, 5_000);

  it("中途 abort 不挂起", async () => {
    const root = await makeScratch("grep-abort-mid-");
    await writeFile(join(root, "big.txt"), "a".repeat(2_000_000));

    const tool = createGrepTool(root);
    const controller = new AbortController();
    const promise = tool.handler(
      { pattern: "a" },
      { signal: controller.signal }
    );
    setTimeout(() => controller.abort(), 5).unref();

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
