/**
 * grep tool — search-surface contract.
 *
 * Coverage strategy (post ADR-0089): shape / rendering / paging / glob / type /
 * `also` / context behaviour is pinned once on the **rg** path (the production
 * default); the Node fallback path gets its own describe block driven by pointing
 * `engineBinaryPath` at a nonexistent path (`unavailable → nodeScan`) to pin
 * "searching still works on ENOENT, calls are not rejected, paging / context /
 * count keep the same shape". The two engines are not forced through identical
 * assertions (their hit sets may differ) — see the comments in the
 * `grep — SC9 自带引擎缺席 → Node 遍历 + JS RegExp` ("engine absent → Node
 * traversal + JS RegExp") block.
 *
 * Engine selection (`GrepEngine`):
 *   - `node` —— `engineBinaryPath` points at a nonexistent path: drives the
 *                fallback (never invokes real rg, so those tests verify the Node
 *                path shape only).
 *   - `rg`   —— the real binary `@vscode/ripgrep` provides.
 *
 * **Engine presence is a hard precondition**: this file covers rg's production
 * path, and rg's hits / argv / `--crlf` / traversal semantics can only be
 * verified against the real binary. Absent engine = whole file fails, with the
 * fix named in the message; there is no "skip and continue" branch. The engine
 * arrives with the dependencies (`@vscode/ripgrep`), so this holds on CI too and
 * the file is not in the CI exclude set.
 *
 * Coverage contract:
 *   - Output faces: paths (default, relative paths only) / content
 *     (`path:line:text`) / count (`path:count` + `total:` = pre-slice total);
 *     the input alias `files_with_matches` normalizes to paths (not a fourth
 *     output face).
 *   - Paging: `offset` + `head_limit` (default 50, hard cap 2000) slice the
 *     **sorted** list; sorting happens before slicing; past the end with hits
 *     present → exact `No entries at this offset`; no matches → empty string.
 *     `limit` is a retired name (typed rejection naming head_limit).
 *   - Narrowing: `path` / `glob` / `type` in parallel; unknown type and bad
 *     regex are two typed errors whose messages never contain each other's
 *     keywords.
 *   - Line window: `also` + `within_lines` is a **filter**; a hit with no second
 *     segment inside the window is dropped.
 *   - Fallback / ADR-0089:
 *       - rg present: matches come from rg only (no second JS filter); rg's own
 *         rc=2 → handler emits `search engine rejected the query`, not a
 *         synthesized "both engines agree" error.
 *       - rg absent: Node traversal + JS `RegExp`, calls still succeed, and the
 *         output carries one appended English disclosure line (sel-4). The
 *         `toolFor(root, "node")` seam strips that line so the shared roster
 *         assertions keep pinning mode shape; its exact bytes are pinned in the
 *         降级披露 describe.
 *   - Legacy contract retained: containment rejection, abort typed rejection,
 *     over-long line truncation, aci metadata.
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
import {
  DEGRADED_ENGINE_NOTICE,
  createGrepTool,
} from "../../../../src/harness/aci/tools/grep.ts";
import { GREP_OUTPUT_VALUES } from "../../../../src/harness/aci/search/options.ts";
import { createAciRegistry } from "../../../../src/harness/aci/aci-registry.ts";
import { createExecutor } from "../../../../src/harness/tools/executor.ts";
import { MAX_EXPLICIT_FILE_BYTES } from "../../../../src/harness/aci/search/file-lines.ts";
import { GREP_SCOPE_FILE_LIMIT } from "../../../../src/harness/aci/search/scope-guard.ts";
import { engineBinaryPath } from "../../../../src/harness/aci/search/engine-manifest.ts";

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
 * The engine binary the `@vscode/ripgrep` dependency provides.
 *
 * The control arm for the fallback, **hard precondition**: absent = whole file
 * fails (not skip). Covers both absence shapes: `undefined` (the per-platform
 * package is not installed) and "path present, file missing".
 */
const installedEngine: string | undefined = await engineBinaryPath();

if (installedEngine === undefined || !existsSync(installedEngine)) {
  throw new Error(
    [
      "grep 测试需要自带搜索引擎：@vscode/ripgrep 没有解析出 rg 二进制。",
      `  期望路径: ${installedEngine ?? "(本平台的 @vscode/ripgrep-* 可选依赖未安装)"}`,
      "  修复: npm install（该依赖按平台以 optionalDependencies 分发）",
      "为什么是硬前置：本文件直接驱动生产 handler，两条路径（rg 在场 / rg 缺席）",
      "都要在这里落字。rg 路径的命中 / argv / 遍历语义只可能在真二进制上验 —",
      "Node 降级路径专属描述块只验 ENOENT 分支，rg 那条路径缺了真二进制就无人",
      "认证。CI 已不再排除本文件（npm ci 会带上引擎），所以这条要求在 CI 上也成立。",
    ].join("\n")
  );
}

/**
 * Constructors for both engines.
 *
 * `node` drives the fallback by "the engine path cannot start" (no fake
 * spawn injection — that would bypass the real
 * `runRgEngine → isUnavailable → nodeScan` wiring).
 *
 * Post ADR-0089 the two engines are no longer compared against one shared
 * assertion table: each case picks `rg` / `node` / both according to the path it
 * wants to verify (the first two call `toolFor(root, "rg")` directly; cases
 * needing both run inside `bothEngines`). `bothEngines` still exists — shape /
 * rendering / size / glob / type and other shared downstream dispatch is
 * engine-agnostic and must be verified on both paths; handler-level accepted-set
 * divergences (`\s` / `\n` / look-around / class-escape Unicode handling) go
 * through single-engine cases.
 */
const ENGINES = [{ name: "node" }, { name: "rg" }] as const;

type EngineName = (typeof ENGINES)[number]["name"];

function toolFor(
  root: string,
  engine: EngineName,
  extra?: {
    readonly projectIdentityRoot?: string;
    readonly scopeFileLimit?: number;
  }
): ReturnType<typeof createGrepTool> {
  if (engine === "rg") return createGrepTool(root, { ...extra });
  const node = createGrepTool(root, {
    ...extra,
    // Engine path present but the binary is not there → Node fallback.
    engineBinaryPath: join(root, "__no_such_engine__", "rg"),
  });
  return withoutDegradationNotice(node);
}

/**
 * Factor the degradation notice out of the Node arm output, so the ~40
 * unrelated roster assertions pin their own mode shape instead of reading as
 * "roster + boilerplate". Whether a notice is *due* is not decided here; the
 * 降级披露 describe pins that, with the exact notice bytes.
 */
function withoutDegradationNotice(
  tool: ReturnType<typeof createGrepTool>
): ReturnType<typeof createGrepTool> {
  const suffix = "\n" + DEGRADED_ENGINE_NOTICE;
  return {
    ...tool,
    handler: async (input, ctx) => {
      const output = await tool.handler(input, ctx);
      if (output === DEGRADED_ENGINE_NOTICE) return "";
      if (typeof output !== "string") return output;
      return output.endsWith(suffix) ? output.slice(0, -suffix.length) : output;
    },
  };
}

/** Run the same assertions once per engine: covers the shared downstream dispatch (engine-agnostic parts). */
async function bothEngines(
  body: (
    makeTool: (root: string) => ReturnType<typeof createGrepTool>
  ) => Promise<void>
): Promise<void> {
  for (const engine of ENGINES) {
    await body((root) => toolFor(root, engine.name));
  }
}

// ───────────────────────── schema / aci shape ─────────────────────────

describe("createGrepTool — schema/aci shape", () => {
  it("name === 'grep'", async () => {
    const root = await makeScratch("grep-shape-");
    const tool = createGrepTool(root);
    assert.equal(tool.name, "grep");
  });

  it("inputSchema enforces pattern required，且退役字段的 typed 指引可达模型（D4）", async () => {
    // Counter-proof: with `additionalProperties:false` in the schema, ajv's
    // `must NOT have additional properties` would fire before the handler's
    // `rejectRetiredLimitField`, so the retired-field guidance promised to the
    // model would never reach it. Pin that the production path
    // (createExecutor → executeAll) yields that guidance, not ajv's generic message.
    const root = await makeScratch("grep-shape-");
    const tool = createGrepTool(root);
    const schema = tool.inputSchema as Record<string, unknown>;

    assert.equal(schema.type, "object");
    assert.deepEqual(schema.required, ["pattern"]);

    const registry = createAciRegistry([tool]);
    const executor = createExecutor(registry.inner);
    const [failure] = await executor.executeAll([
      {
        id: "call-retired-limit",
        name: "grep",
        input: { pattern: "needle", limit: 10 },
      },
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
      "files_with_matches",
    ]);
    // SSOT drift guard: the enum must derive from `GREP_OUTPUT_VALUES`. If an
    // alias is added to the normalization table but not the enum, ajv rejects it
    // before `readOutput` — this makes that drift fail loud.
    assert.deepEqual(schema.properties.output.enum, [...GREP_OUTPUT_VALUES]);
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
    // grep output on large files still goes through the 20000 fallback cap +
    // guidance (re-calling with a tighter pattern / narrower path is a viable
    // recovery path).
    const root = await makeScratch("grep-shape-");
    const tool = createGrepTool(root);

    assert.equal(tool.exemptFromOutputCap, undefined);
  });
});

// ───────────────────────── output faces ─────────────────────────

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

  it("output=files_with_matches 是 paths 的别名：同一夹具路径名单逐行相同（SC1）", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-alias-");
      await mkdir(join(root, "sub"), { recursive: true });
      await writeFile(join(root, "a.ts"), "hit one\nhit two\n", "utf8");
      await writeFile(join(root, "sub", "b.ts"), "hit three\n", "utf8");

      const tool = makeTool(root);
      const viaPaths = (await tool.handler({
        pattern: "hit",
        output: "paths",
      })) as string;
      const viaAlias = (await tool.handler({
        pattern: "hit",
        output: "files_with_matches",
      })) as string;

      assert.equal(viaAlias, viaPaths);
      assert.deepEqual(viaAlias.split("\n"), ["a.ts", "sub/b.ts"]);
      for (const line of viaAlias.split("\n")) {
        assert.equal(line.includes(":"), false, `别名出法不得含冒号: ${line}`);
        assert.equal(line.startsWith("/"), false, `不得是绝对路径: ${line}`);
      }
    });
  });

  it("别名 + head_limit / offset 与 paths 的分页语义一致（D3 / SC1）", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-alias-page-");
      for (const name of ["a.ts", "b.ts", "c.ts", "d.ts"]) {
        await writeFile(join(root, name), "hit\n", "utf8");
      }

      const tool = makeTool(root);
      const aliasFirst = (await tool.handler({
        pattern: "hit",
        output: "files_with_matches",
        head_limit: 2,
      })) as string;
      const aliasSecond = (await tool.handler({
        pattern: "hit",
        output: "files_with_matches",
        offset: 2,
        head_limit: 2,
      })) as string;
      const pathsSecond = (await tool.handler({
        pattern: "hit",
        output: "paths",
        offset: 2,
        head_limit: 2,
      })) as string;

      assert.deepEqual(aliasFirst.split("\n"), ["a.ts", "b.ts"]);
      assert.equal(aliasSecond, pathsSecond);
      assert.deepEqual(aliasSecond.split("\n"), ["c.ts", "d.ts"]);
    });
  });

  it("别名通过生产校验闸（ajv → executor）后才到 handler 归一（SC1）", async () => {
    // Counter-proof: if the schema enum lacked the alias, the executor would
    // return `validation_failed` before the handler, so the alias never reaches
    // `readOutput`'s normalization. This case runs the production path
    // (createAciRegistry + createExecutor) to pin that the alias really passes.
    const root = await makeScratch("grep-alias-schema-");
    await writeFile(join(root, "a.ts"), "hit\n", "utf8");

    const tool = toolFor(root, "node");
    const registry = createAciRegistry([tool]);
    const executor = createExecutor(registry.inner);
    const [result] = await executor.executeAll([
      {
        name: "grep",
        id: "call-1",
        input: { pattern: "hit", output: "files_with_matches" },
      },
    ]);

    assert.equal(result?.kind, "ok", JSON.stringify(result));
    assert.equal(result?.toolUseId, "call-1");
    assert.deepEqual(
      (result as { payload: ReadonlyArray<{ text: string }> }).payload,
      [{ type: "text", text: "a.ts" }]
    );
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

// ───────────────────────── paging / sorting ─────────────────────────

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
      // Filenames deliberately make readdir / rg thread order differ from lexicographic order.
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
      async () => tool.handler({ pattern: "hit", limit: 200 }),
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
        async () => tool.handler({ pattern: "hit", head_limit }),
        (error: unknown) =>
          error instanceof ToolExecutionError &&
          /head_limit/.test(error.message)
      );
    }
  });
});

// ───────────────────────── narrowing / the two typed errors ─────────────────────────

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
        async () =>
          makeTool(root).handler({ pattern: "hit", type: "nosuchtype" }),
        (error: unknown) =>
          error instanceof ToolExecutionError &&
          /type/.test(error.message) &&
          /nosuchtype/.test(error.message) &&
          !/pattern/.test(error.message)
      );
    });
  });

  it("坏正则（Node 路径）→ typed 拒绝点名 pattern，不含关键词 type（SC10）", async () => {
    // The Node fallback's own bad-regex failure domain: `compilePattern`
    // rejects with a typed error naming the pattern text; disjoint from the
    // unknown-type failure domain.
    const root = await makeScratch("grep-bad-regex-node-");
    await writeFile(join(root, "a.ts"), "hit\n", "utf8");

    await assert.rejects(
      async () => toolFor(root, "node").handler({ pattern: "(unclosed" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        /pattern/.test(error.message) &&
        !/type/.test(error.message)
    );
  });

  it("坏正则（rg 路径）→ rg 子进程自己的 rc=2（typed），不含关键词 type（SC10）", async () => {
    // The rg path's bad-regex failure domain is rg's own rc=2 (ADR-0089: rg
    // reports its own pattern errors, the shared entry does not pre-judge).
    // The handler maps it to typed `search engine rejected the query`; still
    // disjoint from the unknown-type failure domain.
    const root = await makeScratch("grep-bad-regex-rg-");
    await writeFile(join(root, "a.ts"), "hit\n", "utf8");

    await assert.rejects(
      async () => toolFor(root, "rg").handler({ pattern: "(unclosed" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        /search engine rejected the query/.test(error.message) &&
        !/type/.test(error.message)
    );
  });

  it("type 非法时先于 pattern 判定（类型检查在参数规范化期，与引擎无关）", async () => {
    // The two failure domains must stay distinguishable. `type` validity is
    // checked in `parseQuerySpec` (the shared entry for both engines) rather
    // than during argv construction — the latter only runs when the bundled
    // engine is present, so the same input would error differently depending on
    // whether the engine starts.
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

      // Both inputs must report the type error: pattern validity never changes
      // the earlier "unknown type" rejection. The bad-pattern-only case
      // (`alpha` is valid) is covered elsewhere → reports pattern.
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

// ───────────── ADR-0089 acceptance-set divergence (handler level, rg / Node each measured) ─────────────
//
// The old cross-engine regex-semantics alignment block is retired: those cases
// asserted "the same pattern must give the same typed rejection on both
// engines", which was the old contract. ADR-0089 narrows it: when rg is
// present, matches come from rg only and rg's rc=2 is handled as rg's own error
// (`search engine rejected the query`); the Node fallback no longer imitates
// rg's default rejection set (lookaround / `\p{...}` / `\s` etc. may be wider
// on machines without rg — docs and tests treat that as a feature). Single-
// engine cases below pin each path's **measured** behavior; cross-engine
// equality assertions (`assert.equal(fromNode, fromRg)`) were removed because
// that invariant is void.
//
// Retained shared invariants (independent of engine choice, verified on both paths):
//   - glob / type narrowing and negative-glob semantics;
//   - a user glob cannot undo the tool's own `!**/node_modules` / `!**/.git`;
//   - `.` / non-ASCII literals use code-point semantics on both engines (rg by
//     default, Node via the `u` flag);
//   - no argv flag bends rg back to ASCII (`--no-unicode` is retired — see the
//     regression pins in `tests/harness/aci/search/argv.test.ts`).
//
// On the rg path, `\d` / `\w` / `\b` accept non-ASCII class members under
// default Unicode semantics (`\w` hits CJK text, `\d` hits Arabic-Indic
// digits) — **deliberately different** from the Node path (JS without `u`
// stays ASCII). ADR-0089 accepts
// this hit-set divergence. The `\d` / `\w` / `\b` cases below pin that new
// contract.
describe("grep — ADR-0089 接受集差异（handler 级）", () => {
  it("rg 路径：`\\d` / `\\w` / `\\b` 走默认 Unicode 口径（命中非 ASCII 类）", async () => {
    // rg always runs with its default Unicode semantics (ADR-0089): `\\w`
    // matches CJK, `\\d` matches Arabic-Indic digits, `\\b` treats `é` as a
    // word character. That is the new contract — this tool no longer bends rg
    // toward ASCII with `--no-unicode`. The Node path uses JS's ASCII
    // semantics (without `u` it stays in [0-9] / [A-Za-z0-9_]), so the hit sets
    // are **deliberately different** — a projection difference, not
    // cross-engine alignment.
    const root = await makeScratch("grep-rg-unicode-classes-");
    await writeFile(join(root, "arabic.txt"), "٣٤ digits\n", "utf8");
    await writeFile(join(root, "ascii.txt"), "42 digits\n", "utf8");
    await writeFile(join(root, "efe.txt"), "éfoo\n", "utf8");
    await writeFile(join(root, "kanji.txt"), "漢字\n", "utf8");

    // `\\d` matches both the Arabic-Indic and ASCII digits (rg default Unicode classes).
    assert.equal(
      await toolFor(root, "rg").handler({ pattern: "\\d" }),
      "arabic.txt\nascii.txt"
    );
    // `\\w` matches the CJK file: CJK are rg's word characters.
    assert.equal(
      await toolFor(root, "rg").handler({ pattern: "\\w" }),
      "arabic.txt\nascii.txt\nefe.txt\nkanji.txt"
    );
    // `\\bfoo\\b` does not match in `éfoo`: `é` is a word character, no leading boundary.
    assert.equal(
      await toolFor(root, "rg").handler({ pattern: "\\bfoo\\b" }),
      ""
    );
  });

  it("Node 路径：`\\d` / `\\w` / `\\b` 停在 ASCII 类口径（与 rg 有意不同）", async () => {
    // JS without `u` treats `\\d` / `\\w` as ASCII — deliberately different from
    // rg's default Unicode semantics. This tool does **not** bend rg via argv to force agreement.
    const root = await makeScratch("grep-node-ascii-classes-");
    await writeFile(join(root, "arabic.txt"), "٣٤ digits\n", "utf8");
    await writeFile(join(root, "ascii.txt"), "42 digits\n", "utf8");
    await writeFile(join(root, "efe.txt"), "éfoo\n", "utf8");

    // `\\d` does not eat the Arabic-Indic digits: ASCII digits only.
    assert.equal(
      await toolFor(root, "node").handler({ pattern: "\\d" }),
      "ascii.txt"
    );
    // `\\bfoo\\b` matches in `éfoo` (`é` is a non-word character, leading boundary exists).
    assert.equal(
      await toolFor(root, "node").handler({ pattern: "\\bfoo\\b" }),
      "efe.txt"
    );
  });

  it("rg 在场 + `\\w` 命中 CJK：钉 ADR-0089 的新合同（rg 默认 Unicode 口径）", async () => {
    // Regression pin: this tool **no longer** uses `--no-unicode` to force rg
    // into ASCII. `\\w` accepts CJK word characters under rg's default
    // semantics. Run against the real binary: the hit set must include the
    // CJK-only file. If `--no-unicode` ever returns, that file disappears from
    // the results — this pin catches exactly that regression class.
    const root = await makeScratch("grep-rg-cjk-word-");
    await writeFile(join(root, "kanji-only.txt"), "漢字\n", "utf8");

    const fromRg = (await toolFor(root, "rg").handler({
      pattern: "\\w",
    })) as string;
    assert.match(fromRg, /kanji-only\.txt/);
  });

  it("rg 在场：rg 接受而 JS 拒绝的 pattern 走通 rg 路径（ADR-0089）", async () => {
    // Regression pin: the rg path does **not** pre-judge the main pattern's JS
    // validity. `(?P<n>abc)` is a PCRE2 named group — rg accepts it, JS
    // `RegExp` rejects ("Invalid group"). The old handler threw
    // ToolExecutionError in the shared `compilePattern`, rejecting even this
    // valid rg query — contrary to the "when rg is present, trust only rg"
    // contract. Now the rg child runs the pattern itself and returns hits; the
    // handler passes them back without throwing. `(?i)abc` (inline flag) is the same shape.
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
    // Reverse pin: relaxing the rg path does **not** relax the Node path. Node
    // still rejects `(?P<n>abc)` typed at `compilePattern`, the message names
    // the pattern text and contains no `type` keyword (failure domains stay
    // disjoint). This is the Node path's **own** contract, independent of the rg child.
    const root = await makeScratch("grep-adr-node-only-pattern-");
    await writeFile(join(root, "a.txt"), "abc ABC\n", "utf8");

    await assert.rejects(
      async () => toolFor(root, "node").handler({ pattern: "(?P<n>abc)" }),
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
      async () => toolFor(root, "rg").handler({ pattern: "\\n" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        /search engine rejected the query/.test(error.message) &&
        !/line terminator/.test(error.message) &&
        !/unsupported pattern construct/.test(error.message)
    );
  });

  it("rg 缺席 + pattern `\\n` → 空结果、无错误（Node 静默回空的边界）", async () => {
    // This tool searches line by line: Node splits files on `\n` and line
    // content never contains LF, so a pattern that "can only match the line
    // terminator" **never matches**. ADR-0089 accepts this silent empty result
    // (the old contract typed-rejected it at the shared entry reasoning "rg
    // might report every file" — that alignment rationale is void). Pin: the
    // call **succeeds** and returns empty, no throw.
    const root = await makeScratch("grep-adr-node-lineterm-");
    await writeFile(join(root, "a.txt"), "alpha\nbeta\n", "utf8");

    const result = await toolFor(root, "node").handler({
      pattern: "\\n",
      output: "content",
    });
    assert.equal(result, "");
  });

  it("rg 缺席 + `\\s` → 成功出命中（Node 允许比 rg 宽）", async () => {
    // Measured: on a BOM (U+FEFF) `\s` gives rg empty but Node a hit — the two
    // paths' whitespace tables differ by nature. The old contract rejected
    // `\s` / `\S` at the entry; post ADR-0089 the Node path just uses JS's
    // Unicode whitespace table, and the extra width is a feature.
    const root = await makeScratch("grep-adr-node-ws-");
    await writeFile(join(root, "bom.txt"), "﻿alpha\n", "utf8");

    const result = (await toolFor(root, "node").handler({
      pattern: "\\s",
      output: "content",
    })) as string;
    assert.match(result, /bom\.txt:1:/);

    // Control: on the same corpus the rg path returns empty (BOM is not `\s`
    // there). Different answers between paths are allowed, not a regression.
    const fromRg = await toolFor(root, "rg").handler({
      pattern: "\\s",
      output: "content",
    });
    assert.equal(fromRg, "");
  });

  it("look-around：rg 在场 rc=2 / rg 缺席 Node 出命中", async () => {
    // After dropping `--engine=auto`, rg's Rust default engine **rejects**
    // look-around (a direct consequence of ADR-0089: no PCRE2 swap to force
    // alignment). Each path's behavior gets its own pin.
    const root = await makeScratch("grep-adr-lookaround-");
    await writeFile(join(root, "a.txt"), "hit x\nhit y\n", "utf8");

    await assert.rejects(
      async () =>
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
    // Measured rule: the old Node side was a plain AND; rg's actual rule is
    // "positive glob present → type is ignored entirely; negative glob only →
    // type still applies" (verified case by case, not from docs). The rule is
    // engine-independent (`parseQuerySpec` + `glob-match` are shared), so both
    // paths keep the same shape — rg here is the production default path.
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-type-glob-");
      await mkdir(join(root, "sub"), { recursive: true });
      await writeFile(join(root, "sub/a.ts"), "needle\n", "utf8");
      await writeFile(join(root, "sub/b.js"), "needle\n", "utf8");
      await writeFile(join(root, "top.ts"), "needle\n", "utf8");
      await writeFile(join(root, "top.js"), "needle\n", "utf8");

      // Positive glob present → type yields: the glob decides the inclusion set.
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
      // Negative glob present → type still applies.
      assert.equal(
        await makeTool(root).handler({
          pattern: "needle",
          type: "ts",
          glob: "!sub/*",
        }),
        "top.ts"
      );
      // type only: decided by the extension table.
      assert.equal(
        await makeTool(root).handler({ pattern: "needle", type: "ts" }),
        "sub/a.ts\ntop.ts"
      );
      // glob only: decided by the glob.
      assert.equal(
        await makeTool(root).handler({ pattern: "needle", glob: "sub/*" }),
        "sub/a.ts\nsub/b.js"
      );
    });
  });

  it("用户 glob 不能撤销工具自带的遍历排除（D2）", async () => {
    // Regression: the old order placed user globs after the tool's
    // `!**/node_modules` / `!**/.git`, and rg's last-glob-wins let broad globs
    // (`*` / `**` / `{*,.*}`) undo those exclusions → rg returned 5 hits
    // (including node_modules / .git) while Node kept walkFiles' 3. Fixed:
    // user globs go first, tool exclusions last, so both engines still exclude.
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

      // Baseline (no glob): neither engine surfaces node_modules / .git.
      const baseline = await makeTool(root).handler({ pattern: "needle" });
      assert.ok(typeof baseline === "string", "baseline");

      // Broad globs must still exclude node_modules / .git on both engines.
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

      // Narrowing globs (`*.txt` / `src/*`) still narrow as the user intends.
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
      // `.` must consume one whole multibyte char (byte semantics would fail `a.c` vs `aéc`).
      await writeFile(join(root, "aec.txt"), "aéc\n", "utf8");

      assert.equal(await makeTool(root).handler({ pattern: "a.c" }), "aec.txt");
      // Same for non-ASCII literals: byte semantics would split the CJK char into three bytes.
      await writeFile(join(root, "kanji.txt"), "漢字\n", "utf8");
      assert.equal(
        await makeTool(root).handler({ pattern: "漢" }),
        "kanji.txt"
      );
    });
  });

  it("`ignoreCase` × 非 ASCII 两条路径都放行（不再入口拒绝）", async () => {
    // Post ADR-0089 there is no pre-filter: rg folds with `-i`'s own table,
    // Node with JS `iu` / `i`; this query hits `café` on both paths. CJK has no
    // case, same reasoning.
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
      // CJK has no case folding, so it is unaffected either way.
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

// ───────────────────────── line window (also + within_lines) ─────────────────────────

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
      // Line 1 is the primary hit; the second segment is on line 6 (inside the radius-5 closed window).
      await writeFile(
        join(root, "in.ts"),
        `hit\n${"x\n".repeat(4)}second\n`,
        "utf8"
      );
      // The second segment is on line 7 (outside the radius-5 window).
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

// ───────────────────────── context lines stay clean ─────────────────────────

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
      // A context line's **content** itself looks like a record: it must not be
      // read back as a hit. `path-line-text` shape alone cannot block this —
      // that segment allows arbitrary characters, so `a.ts:1-see x:9:fake`
      // would be parsed as a real hit by `^[^:]*:\d+:`.
      await writeFile(join(root, "a.ts"), "see x:9:fake\nhit\n", "utf8");

      const result = (await makeTool(root).handler({
        pattern: "hit",
        output: "content",
        context: 1,
      })) as string;
      const out = result.split("\n");

      // Outside match lines there is no second `path:int:` shape: the prefix is
      // path+line-number, and faking `path:int:` would need a content colon to
      // fill the third field — a slot occupied by `-`.
      const matchLines = out.filter((line) => /^[^:]*:\d+:/.test(line));
      assert.deepEqual(matchLines, ["a.ts:2:hit"]);
      assert.ok(out.includes("a.ts:1-see x:9:fake"));
    });
  });

  it("context 分页单位是组：offset=1 跳到下一组（相邻窗合并不另起组）", async () => {
    await bothEngines(async (makeTool) => {
      const root = await makeScratch("grep-ctx-page-");
      // Hit windows at lines 1 and 9 (radius 1) do not touch → two groups.
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
    // An unsorted group roster would make "which group offset lands in" depend on rg's thread scheduling / readdir order.
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

// ───────────────────────── engine absent → Node fallback ─────────────────────────

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

    assert.equal(result, "a.ts:2:beta hitOne\n" + DEGRADED_ENGINE_NOTICE);
  });

  it("Node 路径不因为自带引擎缺席就少功能：分页 + context + count 同时在场", async () => {
    const root = await makeScratch("grep-node-full-");
    await writeFile(join(root, "a.ts"), "l1\nhit\nl3\nhit\nl5\n", "utf8");
    await writeFile(join(root, "b.ts"), "hit\n", "utf8");

    const node = createGrepTool(root, {
      engineBinaryPath: join(root, "__no_such_engine__", "rg"),
    });

    // Context paging works on **groups**: `head_limit: 1` takes the first group
    // (the two touching hit windows merge into one) and yields all its entries.
    assert.equal(
      (await node.handler({
        pattern: "hit",
        output: "content",
        context: 1,
        head_limit: 1,
      })) as string,
      "a.ts:1-l1\na.ts:2:hit\na.ts:3-l3\na.ts:4:hit\na.ts:5-l5\n" +
        DEGRADED_ENGINE_NOTICE
    );
    assert.equal(
      (await node.handler({ pattern: "hit", output: "count" })) as string,
      "a.ts:2\nb.ts:1\ntotal:3\n" + DEGRADED_ENGINE_NOTICE
    );
    assert.equal(
      (await node.handler({
        pattern: "hit",
        output: "paths",
        offset: 1,
      })) as string,
      "b.ts\n" + DEGRADED_ENGINE_NOTICE
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

// ───────────────────────── engine degradation disclosure ─────────────────────────

describe("grep — Node 降级披露 (sel-4 / ADR-0005 notice-over-failure)", () => {
  it("三条出法末尾各附一行披露，且引擎在场时 output 逐字节不变", async () => {
    const root = await makeScratch("grep-degrade-notice-");
    await writeFile(join(root, "a.ts"), "l1\nhit\nl3\nhit\nl5\n", "utf8");
    await writeFile(join(root, "b.ts"), "hit\n", "utf8");
    const node = createGrepTool(root, {
      engineBinaryPath: join(root, "__no_such_engine__", "rg"),
    });
    const rg = createGrepTool(root);

    for (const [output, roster] of [
      ["paths", "a.ts\nb.ts"],
      ["content", "a.ts:2:hit\na.ts:4:hit\nb.ts:1:hit"],
      ["count", "a.ts:2\nb.ts:1\ntotal:3"],
    ] as const) {
      const degraded = (await node.handler({
        pattern: "hit",
        output,
      })) as string;
      const live = (await rg.handler({ pattern: "hit", output })) as string;

      assert.equal(degraded, roster + "\n" + DEGRADED_ENGINE_NOTICE, output);
      assert.equal(live, roster, output + ": rg 路径不得有披露行");
    }
  });

  it("无命中时 output 就是那一行披露本身（不产生空行或前导换行）", async () => {
    const root = await makeScratch("grep-degrade-empty-");
    await writeFile(join(root, "a.ts"), "alpha\n", "utf8");
    const node = createGrepTool(root, {
      engineBinaryPath: join(root, "__no_such_engine__", "rg"),
    });

    for (const output of ["paths", "content", "count"] as const) {
      assert.equal(
        (await node.handler({ pattern: "zzz", output })) as string,
        DEGRADED_ENGINE_NOTICE,
        output
      );
    }
  });

  it("披露行点明原因、事实与后果，且不带路径或版本号", async () => {
    // sel-4 contract: the wording names the cause (engine unavailable), the
    // fact (a built-in Node scan answered), and the consequence (results may
    // differ from ripgrep). A varying path or version would make the string
    // unstable to assert, so neither may appear.
    assert.doesNotMatch(DEGRADED_ENGINE_NOTICE, /[\\/]/);
    assert.doesNotMatch(DEGRADED_ENGINE_NOTICE, /\d+\.\d+/);
    assert.equal(DEGRADED_ENGINE_NOTICE.split("\n").length, 1);
  });

  it("披露行只随降级出现：可表示性闸短路时引擎并未被问起，不带披露", async () => {
    // The engine-absent case is the only thing that degrades. rg-engine
    // short-circuits on an unrepresentable search target *before* asking the
    // engine, and that path returns an empty result rather than `unavailable`,
    // so no notice may appear. Needs a real binary: with none, the
    // `binaryPath === undefined` check fires first and the call really does
    // degrade.
    const root = await makeScratch("grep-unrepresentable-");
    await writeFile(join(root, "nl\nname.txt"), "needle here\n", "utf8");
    const tool = createGrepTool(root);

    const out = (await tool.handler({
      pattern: "needle",
      path: "nl\nname.txt",
    })) as string;

    assert.equal(
      out.includes(DEGRADED_ENGINE_NOTICE),
      false,
      `可表示性闸短路不等于降级，不应带披露：${JSON.stringify(out)}`
    );
  });
});

// ───────────── line-protocol representability (paths containing `\n` never surface on either engine) ─────────────

describe("grep — 含换行的路径（行协议不可表示）", () => {
  /**
   * All three output faces are line protocols (one record per line), so a `\n`
   * in a path splits one record into two. Measured on rg 15.0.0: it breaks
   * differently from Node but equally badly — rg's first half renders as a
   * **fake hit** (`name.txt:1:<text>` for a file that does not exist on disk),
   * Node emits the newline-carrying path verbatim. The stance: both engines
   * skip such paths, and clean neighbors are still reported.
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
        // Fake hit: rg splits the `nl\nname.txt` record into `name.txt:1:needle`.
        // No `name.txt` exists on disk — this must never appear.
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
      // Clean neighbors are still reported (skipping ≠ emptying the whole query).
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
    // rg's `--glob` exclusions do **not** apply to explicitly named path
    // arguments (measured on 15.0.0), so this relies on the representability
    // short-circuit in `rg-engine` before exec — without it, naming
    // `nl\nname.txt` would emit the fake hit `name.txt:1:needle here`.
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
      // Control: clean files remain searchable.
      assert.equal(
        await tool.handler({ pattern: "needle", path: "plain.txt" }),
        "plain.txt"
      );
    });
  });
});

// ───────────────────────── case / regex ─────────────────────────
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
    // Post ADR-0089 rg's Rust default engine **rejects** look-around (no PCRE2
    // swap to force alignment). This error **comes from the rg child**; the
    // handler maps it to `search engine rejected the query`. The acceptance
    // target is the handler's message, not rg's internal text.
    const root = await makeScratch("grep-lookaround-rg-");
    await writeFile(join(root, "a.ts"), "hit x\nhit y\n", "utf8");

    await assert.rejects(
      async () =>
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
    // Core ADR-0089 feature: the Node path runs look-around patterns via JS
    // `RegExp` and the call **succeeds**. Paired with the previous case, this
    // pins that the same pattern's rg-rc=2 / Node-OK is no longer a regression
    // — it is an ADR-0089-accepted feature.
    const root = await makeScratch("grep-lookaround-node-");
    await writeFile(join(root, "a.ts"), "hit x\nhit y\n", "utf8");

    const result = (await toolFor(root, "node").handler({
      pattern: "hit(?= y)",
      output: "content",
    })) as string;

    // The lookahead keeps only `hit y`; `hit x` is excluded.
    assert.equal(result, "a.ts:2:hit y");
  });
});

// ───────────────────────── over-long lines ─────────────────────────

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
 * Size ceiling for the explicit-file exemption.
 *
 * "Explicitly named files bypass `--max-filesize`" exists to match rg semantics
 * (size is only gated during traversal), but an unbounded exemption would make
 * `{path: "<huge file>"}` an unbounded read. The ceiling is
 * `MAX_EXPLICIT_FILE_BYTES`, defined once in `file-lines.ts` — both engines read
 * it from there, so the limit is engine-independent and a single-engine case suffices.
 */
describe("grep — 显式文件的体积上界", () => {
  it("界内显式点名照搜（rg），界外被上界挡掉", async () => {
    const root = await makeScratch("grep-explicit-cap-");
    // Inside: 1 MiB + 1 (over the traversal gate, well within the explicit ceiling).
    await writeFile(
      join(root, "inside.ts"),
      `${"x".repeat(1_100_000)}\nhit inside\n`,
      "utf8"
    );
    // Outside: ceiling + 1 byte.
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

    // Outside: over the explicit ceiling → the hit line is unreadable → empty hit set (matches rg).
    const beyond = (await tool.handler({
      pattern: "hit",
      path: "beyond.ts",
      output: "content",
    })) as string;
    assert.equal(beyond, "");

    // During traversal the `--max-filesize` gate hides it too.
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

// ───────────────────────── entry validation / containment / abort ─────────────────────────

describe("grep — 空 / 非法输入", () => {
  it("pattern 缺失 / 空串 / 非串一律 typed 拒绝", async () => {
    const root = await makeScratch("grep-bad-input-");
    const tool = createGrepTool(root);

    for (const input of [{}, { pattern: "" }, { pattern: 42 }, null, "nope"]) {
      await assert.rejects(
        async () => tool.handler(input),
        (error: unknown) =>
          error instanceof ToolExecutionError &&
          /pattern|object/.test(error.message)
      );
    }
  });

  it("生产校验闸（ajv → executor）先于 handler 拒掉未知 output（SC1）", async () => {
    // Division of the two defenses: the schema `enum` is the model-visible list
    // of legal values (the executor blocks against it before the handler), and
    // `readOutput` in the handler is the second, fail-closed line for direct
    // tool calls / missing schema. This pins that the production failure domain
    // is `validation_failed` located at `/output`, never silently reaching the handler.
    const root = await makeScratch("grep-executor-bad-output-");
    const tool = createGrepTool(root, {
      engineBinaryPath: join(root, "__no_such_engine__", "rg"),
    });
    const registry = createAciRegistry([tool]);
    const executor = createExecutor(registry.inner);
    const [result] = await executor.executeAll([
      {
        name: "grep",
        id: "call-bad",
        input: { pattern: "a", output: "lines" },
      },
    ]);

    assert.equal(result?.kind, "validation_failed");
    assert.match(
      (result as { message: string }).message,
      /\/output/,
      "失败文案应定位到 output"
    );
  });

  it("output 未知值被 typed 拒绝，文案含全部合法值（别名也在其中）", async () => {
    const root = await makeScratch("grep-bad-output-");
    const tool = createGrepTool(root);

    await assert.rejects(
      async () => tool.handler({ pattern: "a", output: "lines" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        /output/.test(error.message) &&
        ["paths", "content", "count", "files_with_matches"].every((legal) =>
          error.message.includes(legal)
        )
    );
  });

  it("also / glob / type 空串被 typed 拒绝（不做『匹配全部』退化）", async () => {
    const root = await makeScratch("grep-empty-filters-");
    const tool = createGrepTool(root);

    for (const field of ["also", "glob", "type"]) {
      await assert.rejects(
        async () => tool.handler({ pattern: "a", [field]: "" }),
        (error: unknown) =>
          error instanceof ToolExecutionError &&
          new RegExp(field).test(error.message)
      );
    }
  });
});

describe("grep — search root reach (ADR-0128 host reach)", () => {
  it("parent traversal to an ordinary outside directory is searched", async () => {
    const parent = await makeScratch("grep-parent-");
    const root = join(parent, "root");
    await mkdir(root);
    const sibling = join(parent, "sibling");
    await mkdir(sibling);
    await writeFile(join(sibling, "hit.txt"), "outside-needle\n", "utf8");

    const tool = createGrepTool(root);
    const out = String(
      await tool.handler({
        pattern: "outside-needle",
        path: "../sibling",
        output: "content",
      })
    );
    assert.ok(
      out.includes("outside-needle"),
      `widened parent traversal: ${out}`
    );
  });

  it("parent traversal to a protected path is refused by the roster, not by containment", async () => {
    const parent = await makeScratch("grep-parent-prot-");
    const root = join(parent, "root");
    await mkdir(root);
    const sibling = join(parent, "sibling");
    await mkdir(join(sibling, ".ssh"), { recursive: true });
    await writeFile(join(sibling, ".ssh", "id_rsa"), "SSHNEEDLE\n", "utf8");

    const tool = createGrepTool(root);
    await assert.rejects(
      async () =>
        tool.handler({ pattern: "SSHNEEDLE", path: "../sibling/.ssh" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        /protected-path roster/.test(error.message) &&
        !/outside workspace/.test(error.message)
    );
  });

  it("a symlink pointing outside the workspace is searched through its ordinary target", async () => {
    const root = await makeScratch("grep-symlink-");
    const outside = await makeScratch("grep-outside-");
    await writeFile(join(outside, "secret.ts"), "secret hit\n", "utf8");
    await symlink(outside, join(root, "escape"), "dir");

    const tool = createGrepTool(root);
    const out = String(
      await tool.handler({ pattern: "hit", path: "escape", output: "content" })
    );
    assert.ok(out.includes("secret hit"), `widened symlink root: ${out}`);
  });
});

describe("grep — abort", () => {
  it("已 abort 的信号 → typed abort 错误，不挂起", async () => {
    const root = await makeScratch("grep-abort-");
    await writeFile(join(root, "huge.txt"), "a".repeat(2_000_000));

    // Abort semantics are engine-independent, but **must** be verified on the
    // real engine: this path uses spawnWithStopSignal's interruption wiring,
    // which the Node scan never goes through.
    const tool = toolFor(root, "rg");
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      async () => tool.handler({ pattern: "a" }, { signal: controller.signal }),
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

// ───────────── large-repo scope gate (both engines share the verdict; deterministic, no wall clock) ─────────────

/**
 * When `path` points at an overly large tree with no narrowing `glob`, grep
 * returns a short typed error (scope too large / narrow it) before any timeout
 * budget applies; the failure is an ordinary `execution_failed` tool_result,
 * **not** a turn timeout.
 *
 * The gate verdict is "file count", not wall clock, so it stays deterministic —
 * see the measured rationale in `scope-guard.ts` (rg spent 17.8s on the same
 * 54k-file tree; a wall-clock threshold would misfire in both directions
 * depending on host speed).
 *
 * The fixture is deliberately far below the production limit
 * `GREP_SCOPE_FILE_LIMIT` (10,000): creating ten thousand real files only slows
 * the suite without adding proof. Both engines read the same `scopeFileLimit`
 * seam, so the **shared verdict** on the same `path` stays pinned.
 */
describe("grep — SC5 大仓范围闸", () => {
  /** Sub-gate fixture: far below the production limit, above the injected small gate. */
  const FIXTURE_FILES = 8;
  const SMALL_LIMIT = 4;

  /** Build a tree containing `count` files; return its root. */
  async function hugeTree(prefix: string, count: number): Promise<string> {
    const root = await makeScratch(prefix);
    await Promise.all(
      Array.from({ length: count }, (_unused, i) =>
        writeFile(join(root, `f${String(i)}.txt`), "needle\n", "utf8")
      )
    );
    return root;
  }

  it("过大 path 且无 glob → 短 typed 错误：文案点名收窄 glob 与上限常数", async () => {
    const root = await hugeTree("grep-scope-large-", FIXTURE_FILES);
    for (const engine of ENGINES) {
      const tool = toolFor(root, engine.name, { scopeFileLimit: SMALL_LIMIT });
      await assert.rejects(
        async () => tool.handler({ pattern: "needle" }),
        (error: unknown) =>
          error instanceof ToolExecutionError &&
          /too large/.test(error.message) &&
          /glob/.test(error.message) &&
          error.message.includes(String(SMALL_LIMIT))
      );
    }
  });

  it("闸先于引擎：拒绝时 rg 根本不被 spawn（确定性「早于档位钟」）", async () => {
    // The deterministic evidence for "before the timeout budget" is not wall
    // clock — the fixture has only 8 files, so any clock comparison measures
    // nothing and jitters with host speed. The real criterion is **order**: the
    // scope gate runs before resolveEngineResult, so on rejection the engine
    // must never start. The spawn spy pins that order (only the rg path has
    // children; the Node fallback never spawns anyway).
    const root = await hugeTree("grep-scope-order-", FIXTURE_FILES);
    let spawnCalls = 0;
    const tool = createGrepTool(root, {
      scopeFileLimit: SMALL_LIMIT,
      spawn: () => {
        spawnCalls += 1;
        throw new Error(
          "engine must not be spawned when the scope gate rejects"
        );
      },
    });
    await assert.rejects(
      async () => tool.handler({ pattern: "needle" }),
      (error: unknown) => error instanceof ToolExecutionError
    );
    assert.equal(spawnCalls, 0, "范围闸必须在引擎之前拒绝");
  });

  it("同树 + 收窄 glob → 放行（豁免），能正常搜出命中", async () => {
    const root = await hugeTree("grep-scope-glob-", FIXTURE_FILES);
    for (const engine of ENGINES) {
      const tool = toolFor(root, engine.name, { scopeFileLimit: SMALL_LIMIT });
      const out = await tool.handler({ pattern: "needle", glob: "f1.txt" });
      assert.equal(out, "f1.txt", `${engine.name}: 肯定 glob 应豁免范围闸`);
    }
  });

  it("显式单文件 path（过大树内）→ 不受闸影响", async () => {
    const root = await hugeTree("grep-scope-file-", FIXTURE_FILES);
    for (const engine of ENGINES) {
      const tool = toolFor(root, engine.name, { scopeFileLimit: SMALL_LIMIT });
      const out = await tool.handler({ pattern: "needle", path: "f2.txt" });
      assert.equal(out, "f2.txt", `${engine.name}: 显式文件应豁免`);
    }
  });

  it("否定 glob 不豁免（它不缩小遍历范围），仍按范围闸拒绝", async () => {
    // The gate only accepts **narrowing** globs; a negative glob (`!f1.txt`)
    // does not shrink the inclusion set, it drops individual files — traversal
    // cost is paid anyway, consistent with `glob-match.ts` set semantics.
    const root = await hugeTree("grep-scope-neg-", FIXTURE_FILES);
    for (const engine of ENGINES) {
      const tool = toolFor(root, engine.name, { scopeFileLimit: SMALL_LIMIT });
      await assert.rejects(
        async () => tool.handler({ pattern: "needle", glob: "!f1.txt" }),
        (error: unknown) =>
          error instanceof ToolExecutionError && /too large/.test(error.message)
      );
    }
  });

  it("head_limit 小不豁免（只切输出，不减搜索成本；测试名即决策）", async () => {
    const root = await hugeTree("grep-scope-head-", FIXTURE_FILES);
    for (const engine of ENGINES) {
      const tool = toolFor(root, engine.name, { scopeFileLimit: SMALL_LIMIT });
      await assert.rejects(
        async () =>
          tool.handler({ pattern: "needle", head_limit: 1, offset: 0 }),
        (error: unknown) =>
          error instanceof ToolExecutionError && /too large/.test(error.message)
      );
    }
  });

  it("上限之内的树（两条引擎）→ 行为与今天一致（SC5 小夹具不变）", async () => {
    // SSOT: tests reference the exported constant, not a hardcoded number; pin
    // that it really is a finite ceiling and far above the regression fixtures
    // (otherwise small fixtures would trip the gate).
    assert.ok(
      Number.isInteger(GREP_SCOPE_FILE_LIMIT) &&
        GREP_SCOPE_FILE_LIMIT > FIXTURE_FILES,
      "生产上限应是有限整数且远大于回归夹具"
    );
    const smallFixture = await makeScratch("grep-scope-small-");
    for (const name of ["a.ts", "b.ts", "c.ts"]) {
      await writeFile(join(smallFixture, name), "needle\n", "utf8");
    }
    for (const engine of ENGINES) {
      const tool = toolFor(smallFixture, engine.name);
      assert.equal(
        await tool.handler({ pattern: "needle" }),
        "a.ts\nb.ts\nc.ts",
        `${engine.name}: 小夹具应正常出全量`
      );
    }
  });

  it("闸判定与墙钟无关：同一输入重复跑给出同样的错（确定性）", async () => {
    // Counter-proof: if the gate were timer-based (fast hosts pass, slow hosts
    // reject), the same fixture could not throw deterministically twice. The
    // injected small ceiling makes this case deterministic on any host.
    const root = await hugeTree("grep-scope-det-", FIXTURE_FILES);
    const tool = toolFor(root, "node", { scopeFileLimit: SMALL_LIMIT });
    for (let i = 0; i < 2; i += 1) {
      await assert.rejects(
        async () => tool.handler({ pattern: "needle" }),
        (error: unknown) =>
          error instanceof ToolExecutionError && /too large/.test(error.message)
      );
    }
  });

  it("闸命中经生产 executor → `execution_failed`（普通 tool_result），不是回合 timeout", async () => {
    const root = await hugeTree("grep-scope-exec-", FIXTURE_FILES);
    const tool = toolFor(root, "rg", { scopeFileLimit: SMALL_LIMIT });
    const registry = createAciRegistry([tool]);
    const executor = createExecutor(registry.inner);
    const [result] = await executor.executeAll([
      { name: "grep", id: "call-1", input: { pattern: "needle" } },
    ]);
    assert.equal(result?.kind, "execution_failed");
    assert.notEqual(
      (result as { message?: string }).message,
      "timeout",
      "范围闸失败不能是超时标签"
    );
    assert.match((result as { message: string }).message, /too large/);
  });
});

// ───────────────────────── protected-path policy (host-read-policy SC2/SC3) ─────────────────────────

describe("grep — protected-path policy enforcement (both engines)", () => {
  /**
   * Protected fixtures live under the allowed root (mkdtemp stand-in HOME),
   * so a refusal can only come from the read policy — never from the
   * containment allowlist or the pinned rg's hidden-file defaults.
   */
  async function makePolicyTree(prefix: string): Promise<string> {
    const root = await makeScratch(prefix);
    await mkdir(join(root, ".ssh"), { recursive: true });
    await mkdir(join(root, ".aws"), { recursive: true });
    await writeFile(join(root, ".ssh", "id_rsa"), "SSHSECRET\n");
    await writeFile(join(root, ".aws", "credentials"), "AWSSECRET\n");
    await writeFile(join(root, ".env"), "ENVSECRET\n");
    await writeFile(join(root, "notes.txt"), "benign-needle\n");
    await symlink(join(root, ".ssh", "id_rsa"), join(root, "alias.txt"));
    return root;
  }

  for (const engine of ENGINES) {
    it(`protected search root → typed refusal naming the roster (engine=${engine.name})`, async () => {
      const root = await makePolicyTree(`grep-policy-root-${engine.name}-`);
      const tool = toolFor(root, engine.name);
      for (const path of [
        ".env",
        ".ssh",
        join(root, ".aws", "credentials"),
        "alias.txt",
      ]) {
        await assert.rejects(
          async () => tool.handler({ pattern: "needle", path }),
          (error: unknown) =>
            error instanceof ToolExecutionError &&
            /protected-path roster/.test(error.message) &&
            !/file not found|outside workspace|is a directory/.test(
              error.message
            )
        );
      }
    });

    it(`protected hits under an allowed root never appear in any output mode (engine=${engine.name})`, async () => {
      const root = await makePolicyTree(`grep-policy-leak-${engine.name}-`);
      const tool = toolFor(root, engine.name);
      for (const output of ["paths", "content", "count"]) {
        const secret = String(
          await tool.handler({
            pattern: "SECRET|needle",
            output,
            head_limit: 2000,
          })
        );
        for (const leak of ["SECRET", "id_rsa", "credentials", ".env"]) {
          assert.ok(
            !secret.includes(leak),
            `${output} leaked ${leak}: ${secret}`
          );
        }
        assert.ok(
          secret.includes("notes.txt"),
          `${output} lost the benign hit: ${secret}`
        );
      }
    });

    /**
     * Post-widening half (ADR-0128 T4): the same no-leak invariant on a
     * search root **outside** every containment root — the widened rg walk /
     * Node traversal must still drop protected entries per emitted path, and
     * naming one directly is refused by the roster (never by reach).
     */
    it(`a widened root outside containment leaks no protected entries (engine=${engine.name})`, async () => {
      const taskRoot = await makeScratch(
        `grep-policy-widened-task-${engine.name}-`
      );
      const outside = await makePolicyTree(
        `grep-policy-widened-tree-${engine.name}-`
      );
      const tool = toolFor(taskRoot, engine.name);
      for (const output of ["paths", "content", "count"]) {
        const secret = String(
          await tool.handler({
            pattern: "SECRET|needle",
            output,
            path: outside,
            head_limit: 2000,
          })
        );
        for (const leak of ["SECRET", "id_rsa", "credentials", ".env"]) {
          assert.ok(
            !secret.includes(leak),
            `${output} leaked ${leak}: ${secret}`
          );
        }
        assert.ok(
          secret.includes("notes.txt"),
          `${output} lost the benign widened-root hit: ${secret}`
        );
      }
      await assert.rejects(
        async () =>
          tool.handler({
            pattern: "SSHSECRET",
            path: join(outside, ".ssh", "id_rsa"),
          }),
        (error: unknown) =>
          error instanceof ToolExecutionError &&
          /protected-path roster/.test(error.message) &&
          !/outside workspace/.test(error.message)
      );
    });
  }
});
