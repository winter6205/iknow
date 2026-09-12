/**
 * grep 工具 — 搜面契约（specs/aci-file-search-surface.md D2–D7 / SC4–SC10）。
 *
 * 覆盖策略（ADR-0089 后）：单引擎的形状 / 渲染 / 分页 / glob / type / `also`
 * / context 等行为在 **rg** 这条生产默认路径上钉一遍；Node 降级路径在专属
 * describe 块里用 `engineBinaryPath` 指向不存在路径驱动 `unavailable → nodeScan`，
 * 钉「ENOENT 时仍能搜、调用不拒绝、分页 / context / count 同形」。两条引擎
 * 不被强行同判（命中集允许不同），见「grep — SC9 自带引擎缺席 → Node 遍历
 * + JS RegExp」块的注释。
 *
 * 引擎选择（`GrepEngine`）：
 *   - `node`  —— `engineBinaryPath` 指向不存在的路径：驱动 D6 降级（不走真
 *                rg，所以测试只验 Node 路径的形状）。
 *   - `rg`    —— 真实安装根二进制。
 *
 * **引擎在场是硬前置**：本文件覆盖 rg 的生产路径，而 rg 的命中 / argv /
 * `--crlf` / 遍历语义必须在真二进制上验。缺席 = 整文件 fail，文案点名修复
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
 *   - D6 / SC9 / ADR-0089：
 *       - rg 在场：匹配只出 rg（不再 JS 再滤）；rg 自己 rc=2 → handler 转
 *         `search engine rejected the query`，不是合成的「两边对齐」错误。
 *       - rg 缺席：Node 遍历 + JS `RegExp`，调用仍成功。
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
      "为什么是硬前置：本文件直接驱动生产 handler，两条路径（rg 在场 / rg 缺席）",
      "都要在这里落字。rg 路径的命中 / argv / 遍历语义只可能在真二进制上验 —",
      "Node 降级路径专属描述块只验 ENOENT 分支，rg 那条路径缺了真二进制就无人",
      "认证。CI 两个 job 已 --exclude 本文件（runner 无网），所以这条要求在本地",
      "fail-loud、在 CI 不出现。",
    ].join("\n")
  );
}

/**
 * 两条引擎的构造器。
 *
 * `node` 用「安装根二进制不存在」驱动 D6 降级（不是注入假 spawn —— 那会绕过
 * 真实的 `runRgEngine → isUnavailable → nodeScan` 接线）。
 *
 * ADR-0089 之后两引擎不再被同一条断言表比对：每条用例按它想验的路径选
 * `rg` / `node` / 两者都需要（前者直接 `toolFor(root, "rg")`，后者在
 * `bothEngines` 里各跑一遍）。`bothEngines` 现在仍存在 —— 形状 / 渲染 /
 * 体积 / glob / type 等下游共用分派不挑引擎，两条路径都得验；handler 级
 * 接受集差异（`\s` / `\n` / look-around / 类转义的 Unicode 口径）则走单引擎
 * 用例。
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
          // D6 判据：安装根没有这条二进制 → Node 降级。
          engineBinaryPath: join(root, "__no_such_engine__", "rg"),
        };
  return createGrepTool(root, deps);
}

/** 同一组断言在两条引擎上各跑一遍：覆盖下游共用分派（与引擎路径无关的部分）。 */
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

  it("坏正则（Node 路径）→ typed 拒绝点名 pattern，不含关键词 type（SC10）", async () => {
    // Node 降级路径自己的坏正则失败域：`compilePattern` typed 拒绝，文案点名
    // pattern 原文；与未知 type 的失败域互不混同（SC10）。
    const root = await makeScratch("grep-bad-regex-node-");
    await writeFile(join(root, "a.ts"), "hit\n", "utf8");

    await assert.rejects(
      () => toolFor(root, "node").handler({ pattern: "(unclosed" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        /pattern/.test(error.message) &&
        !/type/.test(error.message)
    );
  });

  it("坏正则（rg 路径）→ rg 子进程自己的 rc=2（typed），不含关键词 type（SC10）", async () => {
    // rg 路径的坏正则失败域来自 rg 子进程 rc=2（ADR-0089：rg 自己的 pattern
    // 错误由 rg 自己报，共享入口不预判）。handler 转成 typed
    // `search engine rejected the query`；与未知 type 的失败域仍互不混同。
    const root = await makeScratch("grep-bad-regex-rg-");
    await writeFile(join(root, "a.ts"), "hit\n", "utf8");

    await assert.rejects(
      () => toolFor(root, "rg").handler({ pattern: "(unclosed" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        /search engine rejected the query/.test(error.message) &&
        !/type/.test(error.message)
    );
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

// ───────────── ADR-0089 接受集差异（handler 级，rg / Node 各自实测） ─────────────
//
// 旧的「grep — 两引擎正则语义对齐（D6/SC9/SC10）」块整体退役：那些用例断言
// 的是「同一个 pattern 在两条引擎上必须给出同一条 typed 拒绝」，是 D6 旧合同。
// ADR-0089 收窄合同：rg 在场时匹配只出 rg，rg 自己的 rc=2 按 rg 自己的错误
// （`search engine rejected the query`）处理；Node 降级路径不再模仿 rg 默认
// 引擎拒绝集（lookaround / `\p{...}` / `\s` 等在无 rg 机器上可能更宽，文档与
// 测试视为特性）。下面用单引擎用例钉住每条路径**实测**到的行为；跨引擎相等
// 断言（`assert.equal(fromNode, fromRg)`）已按要求删除 —— 那条不变式已作废。
//
// 保留的共用不变量（与 engine 选择无关，仍在两条路径上验）：
//   - glob / type 收窄与否定 glob 的语义（D4）；
//   - 用户 glob 不能撤销工具自带的 `!**/node_modules` / `!**/.git`（D2）；
//   - `.` / 非 ASCII 字面量在两条引擎上都走 code point 语义（rg 默认就是，
//     Node 走 `u` flag）；
//   - rg 侧不再被任何 argv 开关掰成 ASCII 口径（`--no-unicode` 已退役 ——
//     见 `tests/harness/aci/search/argv.test.ts` 的回归钉子）。
//
// rg 路径下的 `\d` / `\w` / `\b` 在默认 Unicode 语义下会认非 ASCII 类成员
// （`\w` 命中 `漢字`、`\d` 命中 `٣٤`）—— 这与 Node 路径（JS 无 `u` 已停在
// ASCII）的行为**有意不同**。ADR-0089 接受这种命中集差异。下面那块「
// `\d` / `\w` / `\b`」用例钉的就是这条新合同。
describe("grep — ADR-0089 接受集差异（handler 级）", () => {
  it("rg 路径：`\\d` / `\\w` / `\\b` 走默认 Unicode 口径（命中非 ASCII 类）", async () => {
    // rg 一律按自己的默认 Unicode 语义跑（ADR-0089）：`\\w` 认 `漢字`、
    // `\\d` 认 `٣٤`、`\\b` 把 `é` 当词字符。这是新合同 —— 本工具不再用
    // `--no-unicode` 把 rg 掰向 ASCII。Node 路径走 JS 的 ASCII 口径（无
    // `u` 时停在 [0-9] / [A-Za-z0-9_]），命中集因此**有意不同**，那是
    // 同一判据在两侧投影的差异，不是跨引擎对齐。
    const root = await makeScratch("grep-rg-unicode-classes-");
    await writeFile(join(root, "arabic.txt"), "٣٤ digits\n", "utf8");
    await writeFile(join(root, "ascii.txt"), "42 digits\n", "utf8");
    await writeFile(join(root, "efe.txt"), "éfoo\n", "utf8");
    await writeFile(join(root, "kanji.txt"), "漢字\n", "utf8");

    // `\\d` 命中 `٣٤` 与 `42`：两条都在结果里（rg 默认 Unicode 类）。
    assert.equal(
      await toolFor(root, "rg").handler({ pattern: "\\d" }),
      "arabic.txt\nascii.txt"
    );
    // `\\w` 命中 `漢字`：CJK 是 rg 的词字符。
    assert.equal(
      await toolFor(root, "rg").handler({ pattern: "\\w" }),
      "arabic.txt\nascii.txt\nefe.txt\nkanji.txt"
    );
    // `\\bfoo\\b` 在 `éfoo` 上不命中：`é` 是词字符，前缀无边界。
    assert.equal(
      await toolFor(root, "rg").handler({ pattern: "\\bfoo\\b" }),
      ""
    );
  });

  it("Node 路径：`\\d` / `\\w` / `\\b` 停在 ASCII 类口径（与 rg 有意不同）", async () => {
    // JS 无 `u` 时 `\\d` / `\\w` 按 ASCII 走 —— 与 rg 默认 Unicode 口径有意
    // 不同。本工具**不**用 argv 把 rg 掰过来凑这个一致。
    const root = await makeScratch("grep-node-ascii-classes-");
    await writeFile(join(root, "arabic.txt"), "٣٤ digits\n", "utf8");
    await writeFile(join(root, "ascii.txt"), "42 digits\n", "utf8");
    await writeFile(join(root, "efe.txt"), "éfoo\n", "utf8");

    // `\\d` 不吃 `٣٤`：只命中 ASCII 数字。
    assert.equal(
      await toolFor(root, "node").handler({ pattern: "\\d" }),
      "ascii.txt"
    );
    // `\\bfoo\\b` 在 `éfoo` 上命中（`é` 是非词字符，前缀有边界）。
    assert.equal(
      await toolFor(root, "node").handler({ pattern: "\\bfoo\\b" }),
      "efe.txt"
    );
  });

  it("rg 在场 + `\\w` 命中 CJK：钉 ADR-0089 的新合同（rg 默认 Unicode 口径）", async () => {
    // 回归钉子：本工具**不再**用 `--no-unicode` 把 rg 掰成 ASCII。`\\w` 在
    // rg 默认语义下认 CJK 词字符。验证：用真二进制跑这条用例，命中应包含
    // 那个仅含 CJK 内容的文件。若本工具重新加了 `--no-unicode`，该文件
    // 会从结果里消失 —— 这条钉子就是拦那一类回归。
    const root = await makeScratch("grep-rg-cjk-word-");
    await writeFile(join(root, "kanji-only.txt"), "漢字\n", "utf8");

    const fromRg = (await toolFor(root, "rg").handler({
      pattern: "\\w",
    })) as string;
    assert.match(fromRg, /kanji-only\.txt/);
  });

  it("rg 在场：rg 接受而 JS 拒绝的 pattern 走通 rg 路径（ADR-0089）", async () => {
    // 回归钉子：rg 路径**不预判**主 pattern 的 JS 合法性。`(?P<n>abc)` 是
    // PCRE2 命名组 —— rg 接受、JS `RegExp` 拒绝（"Invalid group"）。
    // 旧 handler 在共享入口 `compilePattern` 处抛 ToolExecutionError，把这条
    // 合法 rg 查询也拒掉，与「有 rg 只信 rg」的合同相反。修复后 rg 子进程
    // 自己跑这条 pattern 并给出命中，handler 把命中回给模型、不抛错。
    // `(?i)abc` 是 inline flag —— 同性质：rg 接受、JS 拒绝。
    const root = await makeScratch("grep-adr-rg-only-pattern-");
    await writeFile(join(root, "a.txt"), "abc ABC\n", "utf8");

    const namedFromRg = (await toolFor(root, "rg").handler({
      pattern: "(?P<n>abc)",
    })) as string;
    assert.equal(namedFromRg, "a.txt");

    const inlineFromRg = (await toolFor(root, "rg").handler({
      pattern: "(?i)abc",
    })) as string;
    assert.equal(inlineFromRg, "a.txt");
  });

  it("rg 缺席：JS 拒绝的 pattern 在 Node 路径上仍 typed 拒绝（SC10）", async () => {
    // 反向钉子：rg 路径放宽**不**意味着 Node 路径也放宽。Node 路径在
    // `compilePattern` 处 typed 拒绝 `(?P<n>abc)`，文案点名 pattern 原文、
    // 不含 type 关键词（与未知 type 的失败域互不混同，SC10）。这是 Node
    // 路径**自己的**合同，不依赖 rg 子进程。
    const root = await makeScratch("grep-adr-node-only-pattern-");
    await writeFile(join(root, "a.txt"), "abc ABC\n", "utf8");

    await assert.rejects(
      () => toolFor(root, "node").handler({ pattern: "(?P<n>abc)" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        /invalid pattern/.test(error.message) &&
        /\(\?P<n>abc\)/.test(error.message) &&
        !/type/.test(error.message)
    );
  });

  it("rg 在场 + pattern `\\n` → rg 自己的 rc=2（不是合成的行终止符门）", async () => {
    const root = await makeScratch("grep-adr-rg-lineterm-");
    await writeFile(join(root, "a.txt"), "alpha\nbeta\n", "utf8");

    await assert.rejects(
      () => toolFor(root, "rg").handler({ pattern: "\\n" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        /search engine rejected the query/.test(error.message) &&
        !/line terminator/.test(error.message) &&
        !/unsupported pattern construct/.test(error.message)
    );
  });

  it("rg 缺席 + pattern `\\n` → 空结果、无错误（Node 静默回空的边界）", async () => {
    // 本工具按行搜索：Node 侧把文件按 `\n` 切行、行内容里不含 LF，所以
    // 「只能匹配行终止符」的 pattern **永远匹配不到**。ADR-0089 接受这个
    // 静默空结果（旧合同要在共享入口 typed 拒绝它，理由是「rg 可能报每个
    // 文件」—— 那条对齐理由已废）。这里钉住：调用**成功**且回空，不抛。
    const root = await makeScratch("grep-adr-node-lineterm-");
    await writeFile(join(root, "a.txt"), "alpha\nbeta\n", "utf8");

    const result = await toolFor(root, "node").handler({
      pattern: "\\n",
      output: "content",
    });
    assert.equal(result, "");
  });

  it("rg 缺席 + `\\s` → 成功出命中（Node 允许比 rg 宽）", async () => {
    // 实测：`\s` 在 BOM（U+FEFF）上 rg 空、Node 命中 —— 两条路径的空白表
    // 天生不同。旧合同要入口拒绝 `\s` / `\S`；ADR-0089 之后 Node 路径直接
    // 跑 JS 的 Unicode 空白表，宽出来的部分算特性。
    const root = await makeScratch("grep-adr-node-ws-");
    await writeFile(join(root, "bom.txt"), "﻿alpha\n", "utf8");

    const result = (await toolFor(root, "node").handler({
      pattern: "\\s",
      output: "content",
    })) as string;
    assert.match(result, /bom\.txt:1:/);

    // 对照：同一语料 rg 路径回空（它不把 BOM 当 `\s`）。两条路径的答案不同
    // 是允许的，不是回归。
    const fromRg = await toolFor(root, "rg").handler({
      pattern: "\\s",
      output: "content",
    });
    assert.equal(fromRg, "");
  });

  it("look-around：rg 在场 rc=2 / rg 缺席 Node 出命中", async () => {
    // 去掉 `--engine=auto` 之后 rg 的 Rust 默认引擎**拒绝** look-around
    // （这是 ADR-0089 的直接后果：不再为了凑对齐去换 PCRE2）。两条路径的
    // 行为各自钉一条。
    const root = await makeScratch("grep-adr-lookaround-");
    await writeFile(join(root, "a.txt"), "hit x\nhit y\n", "utf8");

    await assert.rejects(
      () =>
        toolFor(root, "rg").handler({
          pattern: "hit(?= y)",
          output: "content",
        }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        /search engine rejected the query/.test(error.message)
    );

    const fromNode = await toolFor(root, "node").handler({
      pattern: "hit(?= y)",
      output: "content",
    });
    assert.equal(fromNode, "a.txt:2:hit y");
  });

  it("`type` + `glob` 并列：肯定 glob 覆盖 type、否定 glob 与 type 交集（D3）", async () => {
    // 复现：原 Node 侧是 AND（两者都要满足），rg 的实测规则是「肯定 glob 在场
    // → type 完全被忽略；只有否定 glob → type 仍生效」（逐条实测，不是文档）。
    // 这条规则与引擎无关（`parseQuerySpec` + `glob-match` 共用），两侧都要
    // 保持同形 —— 单引擎已足够钉住规则本身，rg 那条是生产默认路径。
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
    // 的 3 条。修复后：用户 glob 先投递、工具排除后投递，两条引擎都仍排除。
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

      // 基线（无 glob）：两条引擎都不带 node_modules / .git。
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

  it("`.` / 非 ASCII 字面量没被字节语义切坏（留 Unicode 模式）", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-unicode-mode-");
      // `.` 必须能吃下一个多字节字符（字节语义下 `a.c` 不匹配 `aéc`）。
      await writeFile(join(root, "aec.txt"), "aéc\n", "utf8");

      assert.equal(await makeTool(root).handler({ pattern: "a.c" }), "aec.txt");
      // 非 ASCII 字面量同理：字节语义下 `漢` 是三个字节，`漢` 自己该命中。
      await writeFile(join(root, "kanji.txt"), "漢字\n", "utf8");
      assert.equal(
        await makeTool(root).handler({ pattern: "漢" }),
        "kanji.txt"
      );
    });
  });

  it("`ignoreCase` × 非 ASCII 两条路径都放行（不再入口拒绝）", async () => {
    // ADR-0089 之后不再预筛：rg 用 `-i` 自己的折叠表、Node 用 JS `iu` / `i`，
    // 实测这条查询两条路径都能命中 `café`。CJK 无大小写同理。
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-ignore-case-");
      await writeFile(join(root, "a.txt"), "café\n漢字\n", "utf8");

      assert.equal(
        await makeTool(root).handler({
          pattern: "CAFÉ",
          output: "content",
          ignoreCase: true,
        }),
        "a.txt:1:café"
      );
      // CJK 无大小写，折叠与否不影响。
      assert.equal(
        await makeTool(root).handler({
          pattern: "漢",
          output: "content",
          ignoreCase: true,
        }),
        "a.txt:2:漢字"
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

// ───────────────────────── 自带引擎缺席 → Node 降级（D6 / SC9） ─────────────────────────

describe("grep — 自带引擎缺席 → Node 遍历 + JS RegExp", () => {
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

  it("look-around 在 rg 上以 rc=2 报错（rg 自己的拒绝，不是合成的对齐门）", async () => {
    // ADR-0089 之后 rg 的 Rust 默认引擎**拒绝** look-around（不再为了凑
    // 对齐去换 PCRE2）。这条错误**来自 rg 子进程**，handler 转成
    // `search engine rejected the query`。验收对象是 handler 错误文案，
    // 不是 rg 的内部报错原文。
    const root = await makeScratch("grep-lookaround-rg-");
    await writeFile(join(root, "a.ts"), "hit x\nhit y\n", "utf8");

    await assert.rejects(
      () =>
        toolFor(root, "rg").handler({
          pattern: "hit(?= y)",
          output: "content",
        }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        /search engine rejected the query/.test(error.message)
    );
  });

  it("look-around 在 rg 缺席（Node 路径）上正常出命中", async () => {
    // ADR-0089 的核心特性：Node 路径用 JS `RegExp` 跑 look-around 合法
    // pattern，调用**成功**。这条用例与上一条配对，钉住「同一个 pattern 的
    // rg-rc=2 / Node-OK 不再是回归 —— 是 ADR-0089 接受的特性」。
    const root = await makeScratch("grep-lookaround-node-");
    await writeFile(join(root, "a.ts"), "hit x\nhit y\n", "utf8");

    const result = (await toolFor(root, "node").handler({
      pattern: "hit(?= y)",
      output: "content",
    })) as string;

    // 前瞻只留 `hit y`；`hit x` 被排除。
    assert.equal(result, "a.ts:2:hit y");
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
 * （遍历期才管体积），但豁免若无上界，`{path: "<巨型文件>"}` 就是无界读。
 * 上界取 `MAX_EXPLICIT_FILE_BYTES`，由 `file-lines.ts` 单点定义 —— 两条引
 * 擎都从这里取值，所以这条口径与引擎选择无关，单引擎用例已足够钉住。
 */
describe("grep — 显式文件的体积上界", () => {
  it("界内显式点名照搜（rg），界外被上界挡掉", async () => {
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

    const tool = toolFor(root, "rg");

    const inside = (await tool.handler({
      pattern: "hit",
      path: "inside.ts",
      output: "content",
    })) as string;
    assert.match(inside, /inside\.ts:2:hit inside/);

    // 界外：超过显式上界 → 命中行读不到 → 命中集空（与 rg 一致）。
    const beyond = (await tool.handler({
      pattern: "hit",
      path: "beyond.ts",
      output: "content",
    })) as string;
    assert.equal(beyond, "");

    // 遍历期走 `--max-filesize` 闸也看不见它。
    const glob = await tool.handler({ pattern: "hit", glob: "beyond.ts" });
    assert.equal(glob, "");
  });

  it("Node 降级路径同样在显式上界内可见、上界外不可见", async () => {
    const root = await makeScratch("grep-explicit-cap-node-");
    await writeFile(
      join(root, "inside.ts"),
      `${"x".repeat(1_100_000)}\nhit inside\n`,
      "utf8"
    );
    await writeFile(
      join(root, "beyond.ts"),
      `${"x".repeat(MAX_EXPLICIT_FILE_BYTES)}\nhit beyond\n`,
      "utf8"
    );

    const tool = toolFor(root, "node");

    const inside = (await tool.handler({
      pattern: "hit",
      path: "inside.ts",
      output: "content",
    })) as string;
    assert.match(inside, /inside\.ts:2:hit inside/);

    const beyond = (await tool.handler({
      pattern: "hit",
      path: "beyond.ts",
      output: "content",
    })) as string;
    assert.equal(beyond, "");
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
