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
 *   - `rg`    —— 真实安装根二进制。
 *
 * **引擎在场是硬前置**：本文件是全仓唯一认证「rg 路径真的等价于 Node 路径」
 * 的地方，静默 skip 会让 SC9 的另一半无人认证（`--engine=auto`、`--crlf`、
 * 遍历语义这些也只在真引擎上才验得到）。缺席 = 整文件 fail，文案点名修复
 * 命令 `npm run install:search-engine`，不提供「跳过继续」的分支。
 *
 * CI 形状：本文件已在 test-fast / test-full 的 `--exclude` 名单里（两个 job
 * 都跑在无网 runner 上，装不了二进制），硬前置因此不会把 CI 变红；CI 守卫
 * `scripts/ci-check-test-excludes.ts` 仍是这条排除的 SSOT。
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
import { createAciRegistry } from "../../../../src/harness/aci/aci-registry.ts";
import { createExecutor } from "../../../../src/harness/tools/executor.ts";
import { MAX_EXPLICIT_FILE_BYTES } from "../../../../src/harness/aci/search/file-lines.ts";
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

/**
 * 本机安装根上钉死的引擎二进制。
 *
 * D6 的对照臂，**硬前置**：缺席即整文件 fail（不是 skip），文案给出修复命令。
 * 覆盖 `undefined`（该平台无资产）与「路径在、文件不在」两种缺席形态。
 */
const installedEngine: string | undefined = engineBinaryPath(
  resolveInstallRoot(),
  process.platform,
  process.arch
);

if (installedEngine === undefined || !existsSync(installedEngine)) {
  throw new Error(
    [
      "grep 测试需要自带搜索引擎：安装根上找不到 rg 二进制。",
      `  期望路径: ${installedEngine ?? "(该平台在 engine-manifest 中无资产)"}`,
      "  修复: npm run install:search-engine",
      "为什么是硬前置：本文件是 SC9 引擎等价的唯一认证面，skip 等于让 rg 那",
      "一半无人认证。CI 两个 job 已 --exclude 本文件（runner 无网），所以这条",
      "要求在本地 fail-loud、在 CI 不出现。",
    ].join("\n")
  );
}

/**
 * 两条引擎的构造器。
 *
 * `node` 用「安装根二进制不存在」驱动 D6 降级（不是注入假 spawn —— 那会绕过
 * 真实的 `runRgEngine → isUnavailable → nodeScan` 接线）。
 */
const ENGINES = [{ name: "node" }, { name: "rg" }] as const;

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

  it("inputSchema enforces pattern required，且退役字段的 typed 指引可达模型（D4）", async () => {
    // 反证式：原 schema 的 `additionalProperties:false` 会让 ajv 的
    // `must NOT have additional properties` 抢先于 handler 的
    // `rejectRetiredLimitField` 命中，SC10 承诺的指引进不了模型。
    // 这里钉「经 createExecutor → executeAll 的生产路径」拿到的是那条指引，
    // 而不是 ajv 的泛化消息。
    const root = await makeScratch("grep-shape-");
    const tool = createGrepTool(root);
    const schema = tool.inputSchema as Record<string, unknown>;

    assert.equal(schema.type, "object");
    assert.deepEqual(schema.required, ["pattern"]);

    const registry = createAciRegistry([tool]);
    const executor = createExecutor(registry.inner);
    const [failure] = await executor.executeAll([
      { name: "grep", input: { pattern: "needle", limit: 10 } },
    ]);
    assert.ok(failure !== undefined, "有回执");
    assert.equal(failure.kind, "execution_failed");
    const message = (failure as { message: string }).message;
    assert.match(message, /is not a grep parameter/);
    assert.match(message, /head_limit/);
    assert.doesNotMatch(message, /additional properties/);
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

  it("type 非法时先于 pattern 判定（类型检查在参数规范化期，与引擎无关）", async () => {
    // SC10 要求两类失败域各自可辨。`type` 的合法性检查放在
    // `parseQuerySpec`（两条引擎共同入口）而不是 argv 构造期 —— 后者只在
    // 自带引擎在场时才跑到，同一份输入会因为引擎起不起得来而换一种报错。
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

      // 两条输入都该报 type：pattern 的好坏不改变「类型未知」这个更早的拒绝。
      // 只坏 pattern 的那条（`alpha` 合法）在别处已单独覆盖 → 报 pattern。
      assert.ok(/type/.test(messages[0]!), `第一条应报 type: ${messages[0]}`);
      assert.ok(/type/.test(messages[1]!), `第二条应报 type: ${messages[1]}`);
      assert.equal(
        /pattern/.test(messages[0]!),
        false,
        `type 文案不得混入 pattern: ${messages[0]}`
      );
    });
  });
});

// ───────────── 引擎语义对齐（F1：无法对齐的构造在共享入口拒绝） ─────────────

describe("grep — 两引擎正则语义对齐（D6/SC9/SC10）", () => {
  /**
   * 无法让 rg 与 JS `RegExp` 给出同一答案的构造，必须在**两条引擎上给出
   * 同一条 typed 拒绝** —— 而不是「rg 能搜、Node 静默回空」。文案还要点名
   * 构造与理由，并与坏正则 / 未知 type 互不混同（SC10）。
   */
  it("`\\p{...}` / `\\P{...}` / `\\u{...}` / `[[:name:]]` → 两条引擎同一条拒绝", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-alignable-");
      await writeFile(join(root, "a.ts"), "alpha 123\n", "utf8");
      const cases: ReadonlyArray<readonly [string, RegExp]> = [
        ["\\p{L}+", /property escape/],
        ["\\P{L}", /property escape/],
        ["\\u{6f22}", /code point escape/],
        ["[[:alpha:]]", /POSIX bracket class/],
      ];
      for (const [pattern, expected] of cases) {
        await assert.rejects(
          () => makeTool(root).handler({ pattern }),
          (error: unknown) =>
            error instanceof ToolExecutionError &&
            expected.test(error.message) &&
            /pattern/.test(error.message) &&
            !/unknown type/.test(error.message)
        );
      }
    });
  });

  it("行终止符原子（`\\n` / `\\n+` / `[\\n]` / `\\n\\n`）→ 两条引擎同一条拒绝（D1）", async () => {
    // 复现（修复前，真实二进制）：`{pattern:"\\n",output:"paths"}` 在 rg 侧回
    // 全部文件、Node 侧回 `""` —— `--crlf` 与 `--engine=auto` 叠加后 PCRE2 把
    // 行边界当成可匹配面。本用例钉住「同一个查询的答案不取决于哪条引擎在跑」。
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-lineterm-");
      await writeFile(join(root, "a.txt"), "alpha\n", "utf8");
      await writeFile(join(root, "b.txt"), "beta\n", "utf8");

      const rejected: ReadonlyArray<RegExp> = [/line terminator/];
      for (const pattern of ["\\n", "\\n+", "[\\n]", "\\n\\n"]) {
        // 三种出法都必须拒（不能只在某一种出法下才校验收口）。
        for (const output of ["paths", "content", "count"] as const) {
          await assert.rejects(
            () => makeTool(root).handler({ pattern, output }),
            (error: unknown) =>
              error instanceof ToolExecutionError &&
              rejected.some((expected) => expected.test(error.message)) &&
              /pattern/.test(error.message) &&
              !/unknown type/.test(error.message),
            `${pattern} / ${output}`
          );
        }
        // 有 / 无 `path`、有 / 无 `also` 都同判。
        await assert.rejects(
          () => makeTool(root).handler({ pattern, path: "a.txt" }),
          ToolExecutionError,
          `${pattern} / path`
        );
        await assert.rejects(
          () => makeTool(root).handler({ pattern, also: "alpha" }),
          ToolExecutionError,
          `${pattern} / also`
        );
      }
    });
  });

  it("可匹配行内内容的构造继续放行（`[^\\n]` / `[abc\\n]` / `\\d` / `.`）", async () => {
    // 反证：判据只砍「只可能匹配行终止符」的原子，不能误伤普通查询。
    // `\\d` 单独出现时 `keepsUnicodeMode=false`（无敏感触发），落在字节模式
    // → 两边类都按 ASCII 走，`\\d` 在 `alpha 1` 上两引擎同判（D5）。
    // `\\s` / `\\W` 已被 D5 收口（typed 拒绝），不在本正控列里。
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-lineterm-pos-");
      await writeFile(join(root, "a.txt"), "alpha 1\n", "utf8");

      for (const pattern of ["[^\\n]", "[abc\\n]", "\\d", "."]) {
        assert.equal(
          await makeTool(root).handler({ pattern }),
          "a.txt",
          pattern
        );
      }
    });
  });

  it("`\\s` / `\\S` 两条引擎的 Unicode 空白表天生不同 → typed 拒绝（D5）", async () => {
    // 反证：实测 `nel-bom-detail.mts` —— rg 收 NEL（U+0085）不收 BOM（U+FEFF），
    // JS 收 BOM 不收 NEL。同一份语料（如 `x\n<U+FEFF>\n`）上两条引擎的
    // `\s` / `\S` 命中集**反向分叉** —— 没法让两条引擎都按用户的口径走，
    // 只能入口拒绝。同一条 typed 拒绝在两条引擎上都命中，不能让 Node 静默
    // 「全命中」或「全空」、也不能让 rg 命中而 Node 空。
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-d5-ws-");
      await writeFile(join(root, "in.txt"), "alpha 1\n", "utf8");

      for (const pattern of ["\\s", "\\S"]) {
        await assert.rejects(
          () => makeTool(root).handler({ pattern }),
          (error: unknown) =>
            error instanceof ToolExecutionError &&
            /whitespace class/.test(error.message) &&
            /two engines would answer differently/.test(error.message)
        );
      }
    });
  });

  it("`\\d` / `\\D` / `\\w` / `\\W` / `\\b` / `\\B` × Unicode 触发 → typed 拒绝（D5）", async () => {
    // 反证：判据为真时 rg 留在 Unicode 模式，它的 `\d` 吃 `٣` / `\w` 吃 `漢` /
    // `\b` 把 `é` 当词字符；JS 即使加 `u` 这些类仍是 ASCII 的。同一个
    // pattern 在两条引擎上的命中集反向分叉（实测 `family-complete.mts` 的
    // `\d. ٣` / `\w. 漢x` / `\b漢 a漢b` 行）。
    //
    // 字节模式（`keepsUnicodeMode=false`，即 pattern 里没有 Unicode 触发构造）
    // 下两边的类都按 ASCII 走 —— `\d` 不吃 `٣`、`\w` 不吃 `漢`、`\b` 把 `é`
    // 当非词字符 —— 完全 SAME（实测 H1 系列）。所以本判据不拒「`\d` 单独
    // 出现」这类 ASCII 查询。
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-d5-class-uni-");
      await writeFile(join(root, "in.txt"), "alpha 123\n", "utf8");

      const triggerPatterns: ReadonlyArray<readonly [string, string]> = [
        // [pattern, 类名（用于消息断言）]
        ["\\d.漢", "\\d"],
        ["\\D.漢", "\\D"],
        ["\\w.漢", "\\w"],
        ["\\W.漢", "\\W"],
        ["\\b漢", "\\b"],
        ["\\B漢", "\\B"],
      ];
      for (const [pattern, family] of triggerPatterns) {
        // 文案里出现的「\\d」是字面量「反斜杠 + d」（4 个 TS 字符 → 2 个
        // 实际字符），与 pattern 里的「\\d」同形。
        await assert.rejects(
          () => makeTool(root).handler({ pattern }),
          (error: unknown) =>
            error instanceof ToolExecutionError &&
            error.message.includes(family) &&
            /Unicode-mode trigger/.test(error.message) &&
            /two engines would answer differently/.test(error.message)
        );
      }
    });
  });

  it("`\\d` / `\\w` / `\\b` 在 ASCII-only pattern 下（字节模式）继续放行（D5 不误伤）", async () => {
    // 反证：判据只拒「在 Unicode 模式下的类原子」；ASCII-only pattern 下
    // 两边都按 ASCII 走，两引擎命中集同形 —— 这条是 D5 的正控，必须继续
    // 走通。同一条期望值喂两条引擎。
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-d5-class-ascii-");
      await writeFile(join(root, "digits.txt"), "abc 123\n", "utf8");
      await writeFile(join(root, "word.txt"), "foo bar\n", "utf8");
      await writeFile(join(root, "efe.txt"), "éfoo\n", "utf8");

      assert.equal(
        await makeTool(root).handler({ pattern: "\\d" }),
        "digits.txt"
      );
      // `\b` 把 `é` 当非词字符（与 JS 同）：`éfoo` 里命中；ASCII 的
      // `foo bar` 当然也命中（paths 出法按 path 排序，两条都要在）。
      assert.deepEqual(
        String(await makeTool(root).handler({ pattern: "\\bfoo\\b" })).split(
          "\n"
        ),
        ["efe.txt", "word.txt"]
      );
      // `\d+` / `\w+` / `\\d{3}` 这些是普通查询，量词不触发 Unicode mode，
      // 仍应继续可用。
      assert.equal(
        await makeTool(root).handler({ pattern: "\\d+" }),
        "digits.txt"
      );
    });
  });

  it("`ignoreCase` + 有大小写的非 ASCII → 拒绝；CJK 不受影响", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-ignore-case-");
      await writeFile(join(root, "a.txt"), "café\n漢字\n", "utf8");

      await assert.rejects(
        () => makeTool(root).handler({ pattern: "CAFÉ", ignoreCase: true }),
        (error: unknown) =>
          error instanceof ToolExecutionError &&
          /ignoreCase/.test(error.message) &&
          /É/.test(error.message)
      );
      // CJK 没有大小写：拒绝它会砍掉一条两条引擎本来就一致的查询。
      assert.equal(
        await makeTool(root).handler({ pattern: "漢", ignoreCase: true }),
        "a.txt"
      );
    });
  });

  it("`type` + `glob` 并列时与 rg 同判（D3：肯定 glob 覆盖 type，否定 glob 与 type 交集）", async () => {
    // 复现：原 Node 侧是 AND（两者都要满足），rg 的实测规则是「肯定 glob 在场
    // → type 完全被忽略；只有否定 glob → type 仍生效」（逐条实测，不是文档）。
    // 这与 D2 的顺序契约同源 —— glob 是显式收窄，type 是隐式词表，两者并列时
    // 用户写的 glob 优先；要表达交集请写成一条 `sub/*.ts`。
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-type-glob-");
      await mkdir(join(root, "sub"), { recursive: true });
      await writeFile(join(root, "sub/a.ts"), "needle\n", "utf8");
      await writeFile(join(root, "sub/b.js"), "needle\n", "utf8");
      await writeFile(join(root, "top.ts"), "needle\n", "utf8");
      await writeFile(join(root, "top.js"), "needle\n", "utf8");

      // 肯定 glob 在场 → type 让位：glob 决定纳入集。
      assert.equal(
        await makeTool(root).handler({
          pattern: "needle",
          type: "ts",
          glob: "sub/*",
        }),
        "sub/a.ts\nsub/b.js"
      );
      assert.equal(
        await makeTool(root).handler({
          pattern: "needle",
          type: "ts",
          glob: "sub/*.js",
        }),
        "sub/b.js"
      );
      // 否定 glob 在场 → type 仍生效。
      assert.equal(
        await makeTool(root).handler({
          pattern: "needle",
          type: "ts",
          glob: "!sub/*",
        }),
        "top.ts"
      );
      // 只给 type：按词表判。
      assert.equal(
        await makeTool(root).handler({ pattern: "needle", type: "ts" }),
        "sub/a.ts\ntop.ts"
      );
      // 只给 glob：按 glob 判。
      assert.equal(
        await makeTool(root).handler({ pattern: "needle", glob: "sub/*" }),
        "sub/a.ts\nsub/b.js"
      );
    });
  });

  it("用户 glob 不能撤销工具自带的遍历排除（D2）", async () => {
    // 复现：原顺序把用户 glob 排在工具的 `!**/node_modules` / `!**/.git` 之
    // 后，rg 的 last-glob-wins 让宽放 glob（`*` / `**` / `{*,.*}`）撤销了这两
    // 条排除 → rg 命中 5 条（含 node_modules / .git），Node 仍按 walkFiles
    // 的 3 条。两条引擎给不同答案。
    // 修复后：用户 glob 先投递、工具排除后投递，两条引擎都仍排除。
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-glob-override-");
      await mkdir(join(root, "src"), { recursive: true });
      await mkdir(join(root, "node_modules/pkg"), { recursive: true });
      await mkdir(join(root, ".git"), { recursive: true });
      await writeFile(join(root, "src/needle.txt"), "needle\n", "utf8");
      await writeFile(join(root, "src/other.txt"), "needle\n", "utf8");
      await writeFile(
        join(root, "node_modules/pkg/index.js"),
        "needle\n",
        "utf8"
      );
      await writeFile(join(root, ".git/config"), "needle\n", "utf8");
      await writeFile(join(root, "README.md"), "needle\n", "utf8");

      // 基线（无 glob）：两条引擎同判，都是 3 条（src 两 + README）。
      const baseline = await makeTool(root).handler({ pattern: "needle" });
      assert.ok(typeof baseline === "string", "baseline");

      // 宽放 glob 在两种引擎下都仍要排除 node_modules / .git。
      for (const glob of ["*", "**", "**/*", "{*,.*}"]) {
        for (const output of ["paths", "content", "count"] as const) {
          const result = await makeTool(root).handler({
            pattern: "needle",
            output,
            glob,
          });
          const text =
            typeof result === "string" ? result : JSON.stringify(result);
          assert.ok(!text.includes("node_modules"), `${glob}/${output}`);
          assert.ok(!text.includes(".git/"), `${glob}/${output}`);
        }
      }

      // 收窄 glob（`*.txt` / `src/*`）仍按用户意图收窄。
      const narrowed = ["src/needle.txt", "src/other.txt"];
      for (const glob of ["*.txt", "src/*"]) {
        const result = await makeTool(root).handler({
          pattern: "needle",
          glob,
        });
        assert.ok(typeof result === "string", glob);
        assert.deepEqual(result.split("\n").sort(), narrowed, glob);
      }
    });
  });

  it("被拒绝的构造在两条引擎上都不产生「半边能搜」的结果", async () => {
    // 反证：Node 路径（JS RegExp 把 `\p{L}` 读成字面 `p{L}`）若不被前置拒绝，
    // 含 `p{L}` 字面文本的文件会命中而 rg 不命中 —— 同一个查询的答案取决于
    // 哪条引擎在跑。这里钉住两条路径都拒绝，而非一边有一边空。
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-alignable-neg-");
      await writeFile(join(root, "literal.txt"), "p{L} literal\n", "utf8");

      await assert.rejects(
        () => makeTool(root).handler({ pattern: "\\p{L}", output: "content" }),
        ToolExecutionError
      );
    });
  });

  it("`\\d` / `\\w` / `\\b` 对齐到 JS 的 ASCII 口径（不吃非 ASCII 类）", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-alignable-pos-");
      // 非 ASCII 数字 / 词：JS 的 `\d` / `\w` 只认 ASCII，rg 的 Unicode 类会
      // 把它们一起收下 —— 这正是 `--no-unicode` 要抹平的分歧。
      await writeFile(join(root, "arabic.txt"), "٣٤ digits\n", "utf8");
      await writeFile(join(root, "ascii.txt"), "42 digits\n", "utf8");
      await writeFile(join(root, "efe.txt"), "éfoo\n", "utf8");

      // `\d` 只认 [0-9]：阿拉伯-印度数字不算。
      assert.equal(
        await makeTool(root).handler({ pattern: "\\d" }),
        "ascii.txt"
      );
      // `\b` 把 `é` 当非词字符（与 JS 同）：`\bfoo\b` 在 `éfoo` 里命中。
      assert.equal(
        await makeTool(root).handler({ pattern: "\\bfoo\\b" }),
        "efe.txt"
      );
    });
  });

  it("`.` / 非 ASCII 字面量没被字节语义切坏（留 Unicode 模式）", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-unicode-mode-");
      // `.` 必须能吃下一个多字节字符（字节语义下 `a.c` 不匹配 `aéc`）。
      await writeFile(join(root, "aec.txt"), "aéc\n", "utf8");
      // 注：原用例还断言「`\s` 认 NBSP」。D5 逐族实测后该断言被证伪 —— 见
      // 下面 `\s` / `\S` 的 typed 拒绝用例：`\s` 在 BOM / NEL 上与 rg 反向
      // 分叉，NBSP 上的一致只是那条语料恰好没踩到 BOM / NEL 的巧合。

      assert.equal(await makeTool(root).handler({ pattern: "a.c" }), "aec.txt");
      // 非 ASCII 字面量同理：字节语义下 `漢` 是三个字节，`漢` 自己该命中。
      await writeFile(join(root, "kanji.txt"), "漢字\n", "utf8");
      assert.equal(
        await makeTool(root).handler({ pattern: "漢" }),
        "kanji.txt"
      );
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
        "a.ts:2-l2",
        "a.ts:3:hit three",
        "a.ts:4-l4",
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

  it("上下文内容带 `:N:` 也不长出假命中（真假只由行号后那一个字符决定）", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-ctx-tricky-");
      // 上下文行的**内容**本身长得像一条记录：SC6 要求它不被读成命中。
      // 这是 `path-line-text` 形态挡不住的形状 —— 那段前缀里允许任意字符，
      // `a.ts:1-see x:9:fake` 会被 `^[^:]*:\d+:` 读成一条真命中。
      await writeFile(join(root, "a.ts"), "see x:9:fake\nhit\n", "utf8");

      const result = (await makeTool(root).handler({
        pattern: "hit",
        output: "content",
        context: 1,
      })) as string;
      const out = result.split("\n");

      // 匹配行之外没有第二种 `path:整数:` 形状：前缀由路径+行号构成，
      // 冒充 `path:整数:` 需要内容里的冒号去补第三个字段 —— 而那一位
      // 被 `-` 占据。
      const matchLines = out.filter((line) => /^[^:]*:\d+:/.test(line));
      assert.deepEqual(matchLines, ["a.ts:2:hit"]);
      assert.ok(out.includes("a.ts:1-see x:9:fake"));
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

      assert.equal(first, "a.ts:1:hit one\na.ts:2-x");
      assert.equal(second, "a.ts:8-x\na.ts:9:hit two");
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
      "a.ts:1-l1\na.ts:2:hit\na.ts:3-l3\na.ts:4:hit\na.ts:5-l5"
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
    const root = await makeScratch("grep-parity-");
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "a.ts"), "hit a\nsecond\n", "utf8");
    await writeFile(join(root, "sub", "b.ts"), "hit b\n", "utf8");
    await writeFile(join(root, "c.md"), "hit c\n", "utf8");
    // 相邻命中：两窗相接（[1,3] / [2,4]）→ 一组，两条命中都必须是 `:`。
    await writeFile(join(root, "adj.ts"), "hit1\nhit2\n", "utf8");
    // 重叠窗：l1 的窗吞掉 l4，l4 的窗又吞掉 l5 → 一组，三条命中都是 `:`。
    await writeFile(join(root, "ov.ts"), "l1\nhitA\nhitB\nl4\nhitC\n", "utf8");
    // 花括号交替（D4 的 glob 语法）：rg 支持、Node 若只做 `*`/`?` 交集就漏。
    await writeFile(join(root, "brace.ts"), "hit brace\n", "utf8");
    await writeFile(join(root, "brace.md"), "hit brace md\n", "utf8");
    await writeFile(join(root, "brace.txt"), "hit brace txt\n", "utf8");
    // 空组 → 空串（`brace{}` 命中名为 `brace` 的文件）；`{1..3}` **不是**
    // 范围展开，剥括号后是字面 `1..3` —— 两条引擎都得给出同名文件。
    await writeFile(join(root, "brace"), "hit brace bare\n", "utf8");
    await writeFile(join(root, "1..3.ts"), "hit literal dots\n", "utf8");
    // 点文件 / 点目录：Node walkFiles 只看目录名（不跳隐藏项），rg 默认相反。
    await writeFile(join(root, ".dot.ts"), "hit dot\n", "utf8");
    await mkdir(join(root, ".dotdir"), { recursive: true });
    await writeFile(join(root, ".dotdir", "nested.ts"), "hit nested\n", "utf8");
    // 被 node_modules / .git 目录名挡掉的文件：两条引擎都不该看见。
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(
      join(root, "node_modules", "pkg", "dep.ts"),
      "hit dep\n",
      "utf8"
    );
    // `.gitignore` 不改变接受集（rg 侧 --no-ignore，Node 侧本来就不读）。
    await writeFile(join(root, ".gitignore"), "hidden-by-ignore.ts\n", "utf8");
    await writeFile(join(root, "hidden-by-ignore.ts"), "hit ignored\n", "utf8");
    // 超过 1 MiB 的文件：遍历期两条引擎都跳过；显式点名时都搜（见下）。
    const oversizeLine = "x".repeat(1_100_000);
    await writeFile(join(root, "big.ts"), `${oversizeLine}\nhit big\n`, "utf8");
    // 超宽**上下文**行（>2000 列）：展示侧两类行同闸，两条引擎都得截断。
    await writeFile(
      join(root, "longctx.ts"),
      `${"y".repeat(3_000)}\nhit\n`,
      "utf8"
    );
    // CRLF 行：`$` 按行边界解释、尾随 `\r` 不混进回显（两条引擎同口径）。
    await writeFile(join(root, "crlf.ts"), "hit crlf\r\nplain\r\n", "utf8");
    // 非 ASCII 宽行：ASCII 用例里 byte == code point，看不出两个单位不同。
    // CJK / emoji 的 byte:cp 比是 3:1 / 4:1，取 1000 个只有 3–4 KB、code
    // point 数远在 2000 以下 —— 只要传输预算被压回「等于 code point 上限」，
    // rg 就会在自己的省略标记里切一刀，而 Node 侧原样保留：同一行的字节数、
    // 标记文本、可复制的正文全都不同（D6/SC9）。这组用例钉住预算必须是 4 倍。
    await writeFile(
      join(root, "longcjk.ts"),
      `hit${"漢".repeat(1_000)}\n`,
      "utf8"
    );
    await writeFile(
      join(root, "longemoji.ts"),
      `hit${"😀".repeat(1_000)}\n`,
      "utf8"
    );
    // 非 ASCII 内容的类语义夹具：`\d` / `\w` / `\b` 的分歧只在含非 ASCII
    // 词的目录里显形（ASCII-only 树里两条引擎恰好一致，钉不住修复）。
    // `٣٤`（阿拉伯-印度数字）验 `\d`、`漢字` 验 `\w`、`éfoo` 验 `\b`，
    // `café` 与全角空格验 `.` / `\s` 没被 `--no-unicode` 切坏。
    await writeFile(
      join(root, "unicode.txt"),
      "٣٤ alpha\n漢字 test\néfoo café\n　nbsp\n",
      "utf8"
    );
    // code point vs code unit 的夹具（D6/SC9）。`.` 与计数 quantifier 在 rg
    // 里一次吃一个 **code point**、在 JS 无 `u` 时只吃一个 **code unit**：
    // 实测 `a.c` 不命中 `a😀c`（emoji 是 2 个 code unit）、`^.{3}$` 不命中
    // `éx`（`é` 用 combining 拼是 2 个 code point / 3 个 code unit）。
    // 内容刻意不含 `hit` / 数字，避免改变既有行的期望集。
    await writeFile(join(root, "emoji.txt"), "a\u{1F600}c\n", "utf8");
    await writeFile(join(root, "combining.txt"), "éx\n", "utf8");
    await writeFile(
      join(root, "doubleemoji.txt"),
      "\u{1F600}\u{1F600}\n",
      "utf8"
    );
    // simple case folding 的两个特殊等价类：U+212A KELVIN 与 U+017F LONG S。
    // rg 留在 Unicode 模式时 `-i k` / `-i s` 折它们；切了 `--no-unicode` 就不折
    // —— Node 侧的 `u` 必须跟着同一个判据走（两向都由本组测试钉住）。
    await writeFile(join(root, "kelvin.txt"), "\u{212A}x\n", "utf8");
    await writeFile(join(root, "longs.txt"), "\u{017F}x\n", "utf8");
    // 上下文行走的是另一条截断路径（`context-groups.ts`），单独一条。
    await writeFile(
      join(root, "longctxcjk.ts"),
      `${"漢".repeat(1_000)}\nhit\n`,
      "utf8"
    );
    // CRLF 上的**边界行**：正文 7999 字节 / 2000 code point（未超权威闸），
    // 但加上尾随 `\r` 恰好 8000 字节 → rg 会追加自己的省略标记。剥标记时要
    // 把 `\r` 那一个字节补回触发基数，否则同一行在 rg 路径被当成「超宽」再截
    // 一次、Node 路径原样保留（D6/SC9）。LF 版本作对照（不触发）。
    const crlfEdge = `€${"😀".repeat(1_999)}`;
    await writeFile(join(root, "crlf-edge.ts"), `${crlfEdge}\r\n`, "utf8");
    await writeFile(join(root, "lf-edge.ts"), `${crlfEdge}\n`, "utf8");
    // 二进制准入：NUL 在早期 / 窗口之外两个方向各来一个，且命中行都在 NUL
    // 之后 —— 「二进制文件不搜」这条口径下两条引擎都必须看不见它们。
    await writeFile(
      join(root, "nul-early.ts"),
      Buffer.concat([
        Buffer.from("hit early\n"),
        Buffer.from([0]),
        Buffer.from("hit after\n"),
      ])
    );
    await writeFile(
      join(root, "nul-late.ts"),
      Buffer.concat([
        Buffer.from("hit early\n"),
        Buffer.alloc(70_000, 0x61),
        Buffer.from([0]),
        Buffer.from("\nhit after\n"),
      ])
    );
    // 反方向：命中行在 NUL **之前**（rg 的 `-l` 命中即返回，会把这个文件列
    // 出来；`--count` 读到尾才发现 NUL 而略过 —— 同一文件两种答案。本工具的
    // 口径是「二进制文件不搜」，两条引擎都必须看不见它）。
    await writeFile(
      join(root, "nul-hitfirst.ts"),
      Buffer.concat([Buffer.from("hit before\n"), Buffer.from([0])])
    );
    // 语境对照：文件里有 NUL 但没有命中 —— 不能因为「过滤掉一条告警记录」
    // 就把该文件的正常命中一起丢掉，也不能反过来凭空造出命中。
    await writeFile(
      join(root, "nul-nohit.ts"),
      Buffer.concat([
        Buffer.from("plain\n"),
        Buffer.from([0]),
        Buffer.from("plain again\n"),
      ])
    );
    // 同一目录里的干净邻居：二进制文件不得让它一起消失（也不能把整次查询
    // 变成失败 —— 见下面 `path: "."` 的用例）。
    await writeFile(join(root, "clean-neighbor.ts"), "hit neighbor\n", "utf8");

    const viaRg = toolFor(root, "rg");
    const viaNode = toolFor(root, "node");

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
      // 花括号交替：多元素 / 单元素 / 空组 / 嵌套 / 笛卡尔积 / 无范围展开。
      { pattern: "hit", glob: "brace.{ts,md}" },
      { pattern: "hit", glob: "brace.{ts}" },
      { pattern: "hit", glob: "brace{}" },
      { pattern: "hit", glob: "{brace.ts,sub/*.ts}" },
      { pattern: "hit", glob: "{adj,ov}.{ts,md}" },
      { pattern: "hit", glob: "{1..3}.ts" },
      { pattern: "hit", glob: "brace.{ts,{md,txt}}" },
      // 整模式锚定：`/` 出现在花括号**内**时整个模式锚定搜索根，
      // `{sub/nope,zz}.ts` 不得退化成「裸基名 zz.ts 也收」。
      { pattern: "hit", glob: "{brace.ts,sub/b.ts}" },
      { pattern: "hit", glob: "{sub/nope,brace}.ts" },
      // 上下文行也过行宽闸：rg 与 Node 都要截断到同一列数 + 同一标记。
      { pattern: "hit", output: "content", context: 1, path: "longctx.ts" },
      // 非 ASCII 超宽行（byte:cp = 3:1 / 4:1）：唯一权威是 code point 闸，
      // rg 按字节判超宽后塞进来的省略标记不得进入正文。
      { pattern: "hit", output: "content", path: "longcjk.ts" },
      { pattern: "hit", output: "content", path: "longemoji.ts" },
      { pattern: "hit", output: "content", context: 1, path: "longctxcjk.ts" },
      // CRLF 边界行：`\r` 计入 rg 的触发基数 —— 剥标记不漏、正文与 Node 等长。
      // 上下文行走的是另一个分列入口（`context-groups.parseRgContextStdout`），
      // 同一行在那里也要过同一道洗痕 —— 单独一条覆盖。
      { pattern: "€", output: "content", path: "crlf-edge.ts" },
      { pattern: "€", output: "content", context: 1, path: "crlf-edge.ts" },
      { pattern: "€", output: "content", path: "lf-edge.ts" },
      // 二进制准入：含 NUL 的文件三条出法都不该被搜到（两个 NUL 位置方向
      // 都验，且 `nul-nohit.ts` 证明过滤不误伤）。
      { pattern: "hit", output: "paths", path: "nul-early.ts" },
      { pattern: "hit", output: "content", path: "nul-early.ts" },
      { pattern: "hit", output: "count", path: "nul-early.ts" },
      { pattern: "hit", output: "paths", path: "nul-late.ts" },
      { pattern: "hit", output: "content", path: "nul-late.ts" },
      { pattern: "hit", output: "count", path: "nul-late.ts" },
      // 命中在 NUL 之前：rg 的 `-l` 会列出、`--count` 会略过，两条出法先
      // 自相矛盾 —— 统一口径后三条出法都必须看不见它。
      { pattern: "hit", output: "paths", path: "nul-hitfirst.ts" },
      { pattern: "hit", output: "content", path: "nul-hitfirst.ts" },
      { pattern: "hit", output: "count", path: "nul-hitfirst.ts" },
      { pattern: "hit", output: "paths", path: "nul-nohit.ts" },
      { pattern: "hit", output: "content", path: "nul-nohit.ts" },
      { pattern: "hit", output: "count", path: "nul-nohit.ts" },
      // 二进制文件不得把整次查询变成失败，也不得污染同目录的干净文件。
      { pattern: "hit", output: "paths", path: "." },
      { pattern: "hit", output: "count" },
      // glob 边界：裸 `!` 在 rg 是「不选中任何文件」（不是「全收」），
      // 尾随 `/` 的模式（`*/` / `**/` / `brace.ts/`）也不得命中。
      { pattern: "hit", glob: "!" },
      { pattern: "hit", glob: "*/" },
      { pattern: "hit", glob: "**/" },
      { pattern: "hit", glob: "a.ts/" },
      { pattern: "hit", glob: "sub/" },
      // 遍历语义：点文件 / 点目录可见，node_modules 不可见，.gitignore 不生效。
      { pattern: "hit", glob: ".dot.ts" },
      { pattern: "hit", glob: ".dotdir/*.ts" },
      { pattern: "hit", glob: "node_modules/**" },
      { pattern: "hit", glob: "hidden-by-ignore.ts" },
      { pattern: "hit", output: "paths", path: "node_modules" },
      // 体积闸：遍历跳过 / 显式点名照搜（两个方向都要一致）。
      { pattern: "hit", glob: "big.ts" },
      { pattern: "hit", output: "content", path: "big.ts" },
      { pattern: "hit", output: "count", path: "big.ts" },
      // CRLF：`$` 锚定与行尾 `\r` 的剥离（`plain$` 只该命中 LF 行）。
      { pattern: "hit", output: "content", path: "crlf.ts" },
      { pattern: "crlf$", output: "content", path: "crlf.ts" },
      { pattern: "plain$", output: "content", path: "crlf.ts" },
      { pattern: "hit", also: "second" },
      { pattern: "hit", head_limit: 1 },
      { pattern: "hit", offset: 99 },
      // 非 ASCII 内容的类语义：`\d` / `\w` / `\b` 在 JS RegExp（无 `u`，
      // code unit）里只认 ASCII，rg 默认是 Unicode 类 —— 实测 `\d` 在 rg
      // 吃 ٣٤、`\w` 吃 CJK、`\b` 把 `é` 当词字符。argv 的 `--no-unicode`
      // 按 pattern 是否含多字节敏感构造决定要不要加（见 pattern.ts）。
      { pattern: "\\d" },
      { pattern: "\\d+" },
      { pattern: "\\w+" },
      { pattern: "\\bfoo\\b" },
      { pattern: "\\w+", output: "content" },
      // `.` / 非 ASCII 字面量留在 Unicode 模式：字节语义会打坏它们
      // （`.` 退化成「一个字节」）。注：`\s` 已由 D5 收口为 typed 拒绝，
      // 不在本对照表里 —— 它的两条引擎空白表天生不同，没有两边都能跑的
      // 语料（见 D5 的 `\s` / `\S` 拒绝用例）。
      { pattern: ".", output: "content", path: "unicode.txt" },
      { pattern: "café", output: "content", path: "unicode.txt" },
      { pattern: "漢", output: "content", path: "unicode.txt" },
      // code point vs code unit（D6/SC9）：`.` 与计数 quantifier 在 rg 按
      // code point、JS 无 `u` 时按 code unit。判据为 true 的 pattern 两条
      // 引擎都留在 Unicode 口径（rg 不加 `--no-unicode`，Node 加 `u`）。
      // 少了 Node 侧的 `u`，`a😀c` 与 combining `éx` 这两行就会只在一侧命中。
      { pattern: "a.c", output: "content", path: "emoji.txt" },
      { pattern: "^.{3}$", output: "content", path: "emoji.txt" },
      { pattern: "^.{3}$", output: "content", path: "combining.txt" },
      // 同文件的负面边界：`é` 用 combining 拼是 **2** 个 code point，
      // `^.{2}$` 必须两边都不中（若哪侧按 code unit 数就会误中）。
      { pattern: "^.{2}$", output: "content", path: "combining.txt" },
      // 非 BMP 字面量的计数 quantifier：无 `u` 时量化的是单个 surrogate，
      // 两个 emoji 反而匹配不上。
      { pattern: "\u{1F600}{2}", output: "content", path: "doubleemoji.txt" },
      // `.` 在类 / 交替 / 分组里同样按 code point（判据只看 pattern 里有没有
      // 敏感构造，与它在语法树里的位置无关）。
      { pattern: "[a-z.]", output: "content", path: "unicode.txt" },
      { pattern: "a.c|zzz", output: "content", path: "emoji.txt" },
      { pattern: "^(a|b).c$", output: "content", path: "emoji.txt" },
      // 对照：转义后的 `\.` 不是敏感构造（判据为 false），但两边同样不该命中。
      { pattern: "\\.", output: "content", path: "emoji.txt" },
      // 类里的非 BMP 成员：无 `u` 时字符类退化成两个 surrogate 的并集，
      // 能匹配到**半个** emoji —— 加 `u` 后与 rg 同为整个字符。
      { pattern: "[\u{1F600}]", output: "content", path: "emoji.txt" },
      // simple case folding 的**负面控制**：判据为 false 的 ASCII 类不拿 `u`
      // （rg 切了 `--no-unicode`，`-i` 只折 ASCII）——`k`/`s` 必须不命中
      // KELVIN / LONG S。这两条在判据被写反时会立刻变红。
      { pattern: "k", output: "content", ignoreCase: true, path: "kelvin.txt" },
      { pattern: "s", output: "content", ignoreCase: true, path: "longs.txt" },
      // 正面对照：判据为 true 时 `iu` 的折叠与 rg 的 Unicode `-i` 同向
      // （`\w` 两类都折；`.` 让 pattern 留下 `u` 后同样折）。
      {
        pattern: "\\w",
        output: "content",
        ignoreCase: true,
        path: "kelvin.txt",
      },
      {
        pattern: "\\w",
        output: "content",
        ignoreCase: true,
        path: "longs.txt",
      },
      {
        pattern: "k.",
        output: "content",
        ignoreCase: true,
        path: "kelvin.txt",
      },
      { pattern: "s.", output: "content", ignoreCase: true, path: "longs.txt" },
      // 反面边界：`[a-z]x` 的判据为 false（无敏感构造）⇒ 不拿 `u`，
      // `-i` 不折 KELVIN —— 与 rg 切了 `--no-unicode` 后的 ASCII 折叠同向。
      {
        pattern: "[a-z]x",
        output: "content",
        ignoreCase: true,
        path: "kelvin.txt",
      },
      // ignoreCase × 非 ASCII：CJK 无大小写 → 必须继续命中（两条引擎都放行）。
      {
        pattern: "漢",
        ignoreCase: true,
        output: "content",
        path: "unicode.txt",
      },
      { pattern: "hit", ignoreCase: true },
      { pattern: "HIT", ignoreCase: true },
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

// ───────────── 行协议可表示性（含 `\n` 的路径在两条引擎上都不出现） ─────────────

describe("grep — 含换行的路径（行协议不可表示）", () => {
  /**
   * 三种出法都是行协议（每行一条记录），路径里的 `\n` 会把一条记录拆成两条。
   * 实测 rg 15.1.0 的坏法与 Node 不同但同样坏：rg 侧前半段长成一条**假命中**
   * （`name.txt:1:<正文>`，磁盘上并没有这个文件），Node 侧原样吐出带换行的
   * 路径。口径是「两条引擎都跳过它」，且干净邻居照常报告。
   */
  async function makeTree(prefix: string): Promise<string> {
    const root = await makeScratch(prefix);
    await mkdir(join(root, "a\nb"), { recursive: true });
    await writeFile(join(root, "nl\nname.txt"), "needle here\n", "utf8");
    await writeFile(join(root, "a\nb", "inner.txt"), "needle inner\n", "utf8");
    await writeFile(join(root, "plain.txt"), "needle plain\n", "utf8");
    return root;
  }

  it("paths / content / count 三种出法都看不见它，干净邻居照常", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeTree("grep-nl-path-");
      const tool = makeTool(root);

      const paths = (await tool.handler({ pattern: "needle" })) as string;
      const content = (await tool.handler({
        pattern: "needle",
        output: "content",
      })) as string;
      const count = (await tool.handler({
        pattern: "needle",
        output: "count",
      })) as string;

      for (const [label, out] of [
        ["paths", paths],
        ["content", content],
        ["count", count],
      ] as const) {
        assert.equal(
          out.includes("nl\nname.txt"),
          false,
          `${label} 漏出含换行路径: ${JSON.stringify(out)}`
        );
        // 假命中：rg 会把 `nl\nname.txt` 的记录拆成 `name.txt:1:needle`。
        // 磁盘上没有 `name.txt`，这条绝不能出现。
        assert.equal(
          /(^|\n)name\.txt:/.test(out),
          false,
          `${label} 出现假命中 name.txt: ${JSON.stringify(out)}`
        );
        assert.equal(
          out.includes("a\nb/"),
          false,
          `${label} 漏出含换行目录下的路径: ${JSON.stringify(out)}`
        );
      }
      // 干净邻居照常报告（跳过不等于整次查询空）。
      assert.equal(paths, "plain.txt");
      assert.equal(content, "plain.txt:1:needle plain");
    });
  });

  it("head_limit 与 total: 计数自洽（跳过项不进分母）", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeTree("grep-nl-count-");

      const count = (await makeTool(root).handler({
        pattern: "needle",
        output: "count",
      })) as string;

      assert.deepEqual(count.split("\n"), ["plain.txt:1", "total:1"]);
    });
  });

  it("显式点名含换行的文件 / 目录 → 空结果（不是假命中）", async () => {
    // rg 的 `--glob` 排除**不作用于显式点名的路径参数**（实测 15.1.0），
    // 所以这条靠 `rg-engine` 在 exec 前的可表示性短路 —— 少了它，点名
    // `nl\nname.txt` 会吐出 `name.txt:1:needle here` 这条假命中。
    await bothEngines(async (makeTool) => {
      const root = await makeTree("grep-nl-explicit-");
      const tool = makeTool(root);

      for (const path of ["nl\nname.txt", "a\nb"]) {
        for (const output of ["paths", "content", "count"] as const) {
          const out = (await tool.handler({
            pattern: "needle",
            path,
            output,
          })) as string;
          assert.equal(out, "", `${path} / ${output} 应为空: ${out}`);
        }
      }
      // 对照：干净文件照常搜得到。
      assert.equal(
        await tool.handler({ pattern: "needle", path: "plain.txt" }),
        "plain.txt"
      );
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

/**
 * 显式文件豁免的体积上界（Finding 4）。
 *
 * 「显式点名的文件不受 `--max-filesize` 约束」这条豁免是为对齐 rg 语义而设
 * （遍历期才管体积），但豁免若无上界，`{path: "<巨型文件>"}` 就是无界读。上界
 * 取 `MAX_EXPLICIT_FILE_BYTES`，且**两条引擎必须同界**：只有一边砍，同一个
 * `path` 参数的答案就随引擎变 —— 那正是豁免当初要修掉的分歧。
 */
describe("grep — 显式文件的体积上界（两条引擎同界）", () => {
  it("界内显式点名照搜、界外两条引擎都看不见（同一答案）", async () => {
    const root = await makeScratch("grep-explicit-cap-");
    // 界内：1 MiB + 1（超过遍历闸，但远在显式上界之内）。
    await writeFile(
      join(root, "inside.ts"),
      `${"x".repeat(1_100_000)}\nhit inside\n`,
      "utf8"
    );
    // 界外：上界 + 1 字节。
    await writeFile(
      join(root, "beyond.ts"),
      `${"x".repeat(MAX_EXPLICIT_FILE_BYTES)}\nhit beyond\n`,
      "utf8"
    );

    const viaRg = toolFor(root, "rg");
    const viaNode = toolFor(root, "node");

    // 界内：两条引擎都搜得到（豁免本身没有被上界取消）。
    for (const [name, tool] of [
      ["rg", viaRg],
      ["node", viaNode],
    ] as const) {
      const inside = (await tool.handler({
        pattern: "hit",
        path: "inside.ts",
        output: "content",
      })) as string;
      assert.match(inside, /inside\.ts:2:hit inside/, `${name} 界内应可搜`);
    }

    // 界外：两条引擎给出**同一个**答案（无论那个答案是空还是截断 —— 关键是
    // 不因为谁在跑而不同）。
    const beyondRg = (await viaRg.handler({
      pattern: "hit",
      path: "beyond.ts",
      output: "content",
    })) as string;
    const beyondNode = (await viaNode.handler({
      pattern: "hit",
      path: "beyond.ts",
      output: "content",
    })) as string;
    assert.equal(beyondNode, beyondRg, "界外两条引擎必须同答案");

    // 遍历期两条引擎也都不看它（超遍历闸）。
    const globRg = (await viaRg.handler({
      pattern: "hit",
      glob: "beyond.ts",
    })) as string;
    const globNode = (await viaNode.handler({
      pattern: "hit",
      glob: "beyond.ts",
    })) as string;
    assert.equal(globRg, "");
    assert.equal(globNode, "");
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

    // abort 语义与引擎无关，但**必须**在真引擎上验：这条路径走的是
    // spawnWithStopSignal 的中断接线，Node 扫不经过它。
    const tool = toolFor(root, "rg");
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

    const tool = toolFor(root, "rg");
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
