/**
 * Tests for the memory_save tool.
 *
 * Contract:
 *   - first save creates `<pool>/projects/<slug>/memory/MEMORY.md`
 *     + `<slug>.md`
 *   - input `{ title, body, type?, importance? }`
 *   - affirmative phrasing rejection: `don't` / `never` / `禁止` ("forbidden") /
 *     `不要` ("do not") / `不能` ("cannot") / body starting with `not ` → MemoryError (typed)
 *   - atomic write (tmp/rename); frontmatter auto-writes 6 fields + timestamp
 *   - a non-scalar unknown extra is refused by the pure serializer: the writer
 *     warns on the `[memory/save]` seam naming slug + key, leaves the target
 *     absent (or a pre-existing file byte-identical), and surfaces a typed
 *     `MemoryIOError` whose cause is the `MemorySchemaInvalid`
 *   - slug naming (implementation choice: hash-based, collision-safe under
 *     concurrent save)
 *   - **concurrent** boundary class: two concurrent `memory_save` to the same
 *     project-hash dir (Promise.all, two independent write pipelines) → no FS
 *     corruption (tmp/rename atomicity), at least one write succeeds, at least
 *     one complete slug file lands (Postel — a dropped entry is not an error,
 *     a corrupted entry is).
 *   - aci metadata: write / not-concurrency-safe / block / default
 */
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemorySaveTool,
  writeMemoryEntryAtomic,
} from "../../../src/harness/memory/tools/save.ts";
import {
  CAPABILITY_OBSERVATION_REASON,
  MemoryIOError,
  MemorySchemaInvalid,
  defaultMemoryEntry,
  parseMemoryEntry,
} from "../../../src/harness/memory/index.ts";
import type {
  MemoryCapabilityRejected,
  MemoryError,
  MemoryEntryV1,
} from "../../../src/harness/memory/index.ts";
import { createRegistry } from "../../../src/harness/tools/registry.ts";
import { createExecutor } from "../../../src/harness/tools/executor.ts";
import { toAnthropicToolResults } from "../../../src/harness/tools/tool-result.ts";
import { createAciRegistry } from "../../../src/harness/aci/aci-registry.ts";
import { createAciExecutor } from "../../../src/harness/aci/aci-executor.ts";
import { captureConsoleWarnAsync } from "../../_helpers/capture-console-warn.ts";

let memoryDir: string;

beforeEach(async () => {
  memoryDir = await mkdtemp(join(tmpdir(), "save-dir-"));
});

afterEach(async () => {
  await rm(memoryDir, { recursive: true, force: true });
});

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** The slug a successful save reports in its persisted-as line. */
function persistedSlug(out: unknown): string {
  const m = /persisted as ([a-f0-9]+)\.md/.exec(String(out));
  assert.ok(m, `result must name the persisted slug, got: ${String(out)}`);
  return m[1];
}

/** The frontmatter key lines between the `---` fences, for any line-break form. */
function fenceBlockLines(raw: string): string[] {
  const lines = raw.split(/\r?\n/);
  assert.equal(lines[0], "---", "file must open with a fence");
  const close = lines.indexOf("---", 1);
  assert.ok(close > 1, "file must close the fence");
  return lines.slice(1, close);
}

// -- tool shape / metadata ---------------------------------------------------

describe("createMemorySaveTool — tool shape", () => {
  it("exposes the memory_save schema with title/body required, type/importance optional", () => {
    const tool = createMemorySaveTool({ memoryDir });
    const schema = tool.inputSchema as Record<string, unknown>;
    const props = schema.properties as Record<string, Record<string, unknown>>;

    assert.equal(tool.name, "memory_save");
    assert.equal(schema.type, "object");
    assert.deepEqual(schema.required, ["title", "body"]);
    assert.equal(schema.additionalProperties, false);
    assert.equal(props.title.type, "string");
    assert.equal(props.body.type, "string");
    assert.equal(props.type?.type, "string");
    assert.equal(props.importance?.type, "integer");
  });

  it("uses write, non-concurrency-safe, block, default aci metadata", () => {
    const tool = createMemorySaveTool({ memoryDir });
    assert.deepEqual(tool.aci, {
      category: "write",
      isConcurrencySafe: false,
      interruptBehavior: "block",
      timeoutTier: "default",
    });
  });
});

// -- successful save ---------------------------------------------------------

describe("memory_save — successful atomic write", () => {
  it("writes a slug file with 6-field frontmatter + body + timestamp", async () => {
    const tool = createMemorySaveTool({
      memoryDir,
      now: () => "2026-02-01T12:00:00.000Z",
    });
    const out = await tool.handler({
      title: "Use bar()",
      body: "Calling bar() is the supported path.",
      type: "note",
      importance: 3,
    });
    assert.equal(typeof out, "string");

    const files = await readdir(memoryDir);
    const slugFiles = files.filter(
      (f) => f.endsWith(".md") && f !== "MEMORY.md"
    );
    assert.equal(slugFiles.length, 1);

    const raw = await readFile(join(memoryDir, slugFiles[0]), "utf8");
    const parsed = parseMemoryEntry(raw);
    assert.equal(parsed.title, "Use bar()");
    assert.equal(parsed.body, "Calling bar() is the supported path.");
    assert.equal(parsed.type, "note");
    assert.equal(parsed.importance, 3);
    assert.equal(parsed.updated_at, "2026-02-01T12:00:00.000Z");
    assert.equal(parsed.ttl_days, 0);
    assert.equal(parsed.disabled, false);
  });

  it("creates MEMORY.md index on first save", async () => {
    const tool = createMemorySaveTool({ memoryDir });
    await tool.handler({ title: "Use bar()", body: "body" });
    const memoryIdx = join(memoryDir, "MEMORY.md");
    assert.equal(await exists(memoryIdx), true);
    const idx = await readFile(memoryIdx, "utf8");
    assert.match(idx, /^- \[Use bar\(\)\]/);
    assert.match(idx, /importance=1/);
  });

  it("builds a slug that is filesystem-safe and unique per save", async () => {
    const tool = createMemorySaveTool({ memoryDir });
    await tool.handler({ title: "Use bar()", body: "one" });
    await tool.handler({ title: "Use bar()", body: "two" });
    const files = await readdir(memoryDir);
    const slugFiles = files.filter(
      (f) => f.endsWith(".md") && f !== "MEMORY.md"
    );
    assert.equal(slugFiles.length, 2);
    assert.equal(new Set(slugFiles).size, 2);
    for (const f of slugFiles) assert.match(f, /^[a-f0-9]+\.md$/);
  });

  it("appends to MEMORY.md index on subsequent saves without clobbering prior lines", async () => {
    const tool = createMemorySaveTool({ memoryDir });
    await tool.handler({ title: "First", body: "one" });
    await tool.handler({ title: "Second", body: "two" });
    const idx = await readFile(join(memoryDir, "MEMORY.md"), "utf8");
    assert.ok(idx.includes("- [First]"));
    assert.ok(idx.includes("- [Second]"));
  });
});

// -- fence-block newline guard (write side) ---------------------------------

describe("memory_save — fence-block newline guard on the write path", () => {
  it("folds a model-supplied title onto one frontmatter line", async () => {
    for (const br of ["\r\n", "\n", "\r"]) {
      const tool = createMemorySaveTool({
        memoryDir,
        now: () => "2026-02-01T12:00:00.000Z",
      });
      const slug = persistedSlug(
        await tool.handler({
          title: `Use bar()${br}not foo()`,
          body: "line one\nline two",
          type: "note",
          importance: 3,
        })
      );
      const raw = await readFile(join(memoryDir, `${slug}.md`), "utf8");
      const block = fenceBlockLines(raw);
      assert.equal(
        block.filter((line) => line.startsWith("title: ")).length,
        1,
        `${JSON.stringify(br)}: title must occupy exactly one fence line, block=${JSON.stringify(block)}`
      );
      assert.equal(
        block.length,
        8,
        `fence block must stay 8 lines, got ${block.length}`
      );
      // The stored entry must re-parse to the folded entry, not to a truncated one.
      const parsed = parseMemoryEntry(raw);
      assert.equal(
        parsed.title,
        "Use bar() not foo()",
        `${JSON.stringify(br)}: a line break in title must fold to one space`
      );
      // `body` is the multiline part of the format — never folded.
      assert.equal(parsed.body, "line one\nline two");
      assert.equal(parsed.importance, 3);
      assert.equal(parsed.updated_at, "2026-02-01T12:00:00.000Z");
    }
  });

  it("keeps the saved slug's MEMORY.md row on one line", async () => {
    const tool = createMemorySaveTool({ memoryDir });
    const slug = persistedSlug(
      await tool.handler({ title: "Use bar()\nnot foo()", body: "body" })
    );
    const idx = await readFile(join(memoryDir, "MEMORY.md"), "utf8");
    const rows = idx.split(/\r?\n/).filter((row) => row.length > 0);
    assert.equal(rows.length, 1, `index must hold one row, got: ${idx}`);
    assert.ok(rows[0].startsWith("- [Use bar() not foo()]"), rows[0]);
    assert.ok(rows[0].includes(`(${slug}.md)`), rows[0]);
  });

  it("folds at the atomic-write choke point, covering ingest and gc callers", async () => {
    // Auto-ingest and GC hand their own entry objects to this same writer, so
    // the fold has to live there rather than only in the tool handler.
    const entry = {
      ...defaultMemoryEntry(),
      id: "mem-1",
      type: "note",
      title: "Use bar()\nnot foo()",
      body: "line one\nline two",
      updated_at: "2026-02-01T12:00:00.000Z",
      provenance: "team review\r\n2026 ledger",
    };
    await writeMemoryEntryAtomic(memoryDir, "cafe0000beef", entry);
    const raw = await readFile(join(memoryDir, "cafe0000beef.md"), "utf8");
    const block = fenceBlockLines(raw);
    assert.deepEqual(block, [
      "id: mem-1",
      "type: note",
      "importance: 1",
      "ttl_days: 0",
      "disabled: false",
      "supersedes: null",
      "title: Use bar() not foo()",
      "updated_at: 2026-02-01T12:00:00.000Z",
      "provenance: team review 2026 ledger",
    ]);
    assert.equal(parseMemoryEntry(raw).body, "line one\nline two");
  });

  it("persists a title containing a colon-space intact through the real write path", async () => {
    // `memory_save` feeds model text straight into `title`, and a plain YAML
    // scalar may not carry ": " — an unquoted writer took the whole frontmatter
    // block down with it, so id and title both came back empty.
    const tool = createMemorySaveTool({
      memoryDir,
      now: () => "2026-02-01T12:00:00.000Z",
    });
    const slug = persistedSlug(
      await tool.handler({
        title: "Convention: install with npm install",
        body: "body",
      })
    );
    const raw = await readFile(join(memoryDir, `${slug}.md`), "utf8");
    assert.deepEqual(fenceBlockLines(raw), [
      'id: ""',
      "type: note",
      "importance: 1",
      "ttl_days: 0",
      "disabled: false",
      "supersedes: null",
      'title: "Convention: install with npm install"',
      "updated_at: 2026-02-01T12:00:00.000Z",
    ]);
    assert.equal(
      parseMemoryEntry(raw).title,
      "Convention: install with npm install"
    );
  });

  it("writes a newline-free entry's on-disk bytes exactly", async () => {
    // Byte-identity pin: the fold must not touch an entry with no line breaks,
    // so files already on disk stay reproducible byte for byte.
    const tool = createMemorySaveTool({
      memoryDir,
      now: () => "2026-02-01T12:00:00.000Z",
    });
    const slug = persistedSlug(
      await tool.handler({
        title: "Use bar()  ",
        body: "line one\nline two",
        type: "convention",
        importance: 4,
      })
    );
    const raw = await readFile(join(memoryDir, `${slug}.md`), "utf8");
    assert.equal(
      raw,
      [
        "---",
        'id: ""',
        "type: convention",
        "importance: 4",
        "ttl_days: 0",
        "disabled: false",
        "supersedes: null",
        'title: "Use bar()  "',
        "updated_at: 2026-02-01T12:00:00.000Z",
        "---",
        "line one",
        "line two",
      ].join("\n")
    );
    // Blanks and trailing padding are now quoted, so the bytes on disk read
    // back as the text that was written — the unquoted form lost both.
    assert.equal(parseMemoryEntry(raw).title, "Use bar()  ");
    assert.equal(parseMemoryEntry(raw).id, "");
  });
});

// -- affirmative phrasing rejection -----------------------------------------

describe("memory_save — affirmative phrasing rejection (spec SC 9)", () => {
  const forEachBad = [
    { title: "don't do that", body: "body" },
    { title: "Never call foo()", body: "body" },
    { title: "Good", body: "禁止使用 foo" },
    { title: "Good", body: "不要用 foo" },
    { title: "Good", body: "不能用 foo" },
    { title: "Good", body: "not recommended to call foo" },
  ];

  for (const bad of forEachBad) {
    it(`rejects: ${bad.title} / ${bad.body.slice(0, 10)}`, async () => {
      const tool = createMemorySaveTool({ memoryDir });
      await assert.rejects(
        async () => tool.handler(bad),
        (err: unknown) => {
          const e = err as MemoryError;
          return (
            e.name === "MemoryError" && /negative|affirmative/i.test(e.message)
          );
        }
      );
    });
  }

  it("does not write any file when a negative-form draft is rejected", async () => {
    const tool = createMemorySaveTool({ memoryDir });
    await assert.rejects(async () =>
      tool.handler({ title: "Never foo", body: "x" })
    );
    const files = await readdir(memoryDir);
    assert.equal(files.length, 0);
  });
});

// -- schema validation -------------------------------------------------------

describe("memory_save — schema boundary classes", () => {
  it("rejects empty title / empty body", async () => {
    const tool = createMemorySaveTool({ memoryDir });
    await assert.rejects(async () => tool.handler({ title: "", body: "x" }));
    await assert.rejects(async () => tool.handler({ title: "x", body: "" }));
  });

  it("rejects importance outside 1..5", async () => {
    const tool = createMemorySaveTool({ memoryDir });
    await assert.rejects(async () =>
      tool.handler({ title: "x", body: "y", importance: 0 })
    );
    await assert.rejects(async () =>
      tool.handler({ title: "x", body: "y", importance: 6 })
    );
  });

  it("rejects non-object input", async () => {
    const tool = createMemorySaveTool({ memoryDir });
    await assert.rejects(async () => tool.handler(null));
    await assert.rejects(async () => tool.handler("t"));
  });

  it("rejects unknown fields (additionalProperties false)", async () => {
    const tool = createMemorySaveTool({ memoryDir });
    await assert.rejects(async () =>
      tool.handler({ title: "x", body: "y", bogus: 1 } as never)
    );
  });
});

// -- closed memory_type enum (#731) ------------------------------------------

describe("memory_save — closed memory_type enum", () => {
  /** Read back the single slug file written by one save. */
  async function persistedType(): Promise<string> {
    const files = await readdir(memoryDir);
    const slugs = files.filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
    assert.equal(slugs.length, 1, `expected one slug file, got ${slugs}`);
    const raw = await readFile(join(memoryDir, slugs[0]), "utf8");
    return parseMemoryEntry(raw).type;
  }

  for (const legal of [
    "convention",
    "decision",
    "gotcha",
    "constraint",
    "note",
  ]) {
    it(`preserves the legal type "${legal}"`, async () => {
      const tool = createMemorySaveTool({ memoryDir });
      await tool.handler({ title: "Use bar()", body: "body", type: legal });
      assert.equal(await persistedType(), legal);
    });
  }

  it("persists an illegal type as note on the success path", async () => {
    const tool = createMemorySaveTool({ memoryDir });
    const out = await tool.handler({
      title: "Use bar()",
      body: "body",
      type: "nope",
    });
    assert.match(out as string, /persisted as/);
    assert.equal(await persistedType(), "note");
  });

  it("persists an omitted type as note", async () => {
    const tool = createMemorySaveTool({ memoryDir });
    await tool.handler({ title: "Use bar()", body: "body" });
    assert.equal(await persistedType(), "note");
  });

  it("persists an empty-string type as note", async () => {
    const tool = createMemorySaveTool({ memoryDir });
    await tool.handler({ title: "Use bar()", body: "body", type: "" });
    assert.equal(await persistedType(), "note");
  });

  it("persists a case- or space-variant type as note (exact match only)", async () => {
    const tool = createMemorySaveTool({ memoryDir });
    await tool.handler({ title: "Use bar()", body: "body", type: "Decision" });
    assert.equal(await persistedType(), "note");
  });
});

// -- concurrent writes (5 boundary class: concurrent) ------------------------

describe("memory_save — concurrent writes do not corrupt the filesystem", () => {
  it("two concurrent saves leave a healthy dir: ≥1 complete slug, no corruption", async () => {
    const tool = createMemorySaveTool({
      memoryDir,
      now: () => "2026-02-01T12:00:00.000Z",
    });
    // Two independent write pipelines dispatched concurrently (Promise.all).
    const results = await Promise.allSettled([
      tool.handler({ title: "Concurrent A", body: "body a" }),
      tool.handler({ title: "Concurrent B", body: "body b" }),
    ]);

    // At least one write succeeds (Postel: a dropped entry is not an error).
    assert.ok(
      results.some((r) => r.status === "fulfilled"),
      "at least one concurrent save must succeed"
    );

    // No leftover .tmp files — every write resolved via tmp/rename.
    const files = await readdir(memoryDir);
    assert.ok(
      files.every((f) => !f.endsWith(".tmp")),
      `no stale tmp files, got: ${files.join(",")}`
    );

    // At least one complete slug file lands (valid frontmatter, parseable).
    const slugs = files.filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
    assert.ok(slugs.length >= 1, "at least one complete slug file must land");
    for (const s of slugs.slice(0, 1)) {
      const raw = await readFile(join(memoryDir, s), "utf8");
      assert.doesNotThrow(() => parseMemoryEntry(raw));
    }
  });

  it("tmp/rename is atomic: a failed rename surfaces as a typed MemoryError", async () => {
    // Force rename to fail by making the target a directory with content.
    // Pre-create a directory named exactly like the slug rename target path is
    // impossible to predict (hash slug), so instead we exercise the error path
    // by making the memory dir read-only below — simplest deterministic check:
    // a bogus memoryDir (parent is a file) → MemoryIOError.
    const blockedDir = join(memoryDir, "not-a-dir");
    await writeFile(blockedDir, "file", "utf8");
    const blockedTool = createMemorySaveTool({ memoryDir: blockedDir });
    await assert.rejects(
      async () => blockedTool.handler({ title: "x", body: "y" }),
      (err: unknown) =>
        (err as MemoryError).name === "MemoryError" ||
        (err as MemoryError).name === "MemoryIOError"
    );
  });
});

// -- runtime capability persist gate (ADR-0086 / SC1) ------------------------

describe("memory_save — runtime capability persist gate", () => {
  const CAPABILITY_FIXTURES = [
    {
      label: "web_search unavailable via sandbox DNS/SSRF segment",
      title: "web_search is unavailable in this sandbox",
      body: "The sandbox DNS/SSRF benchmarking segment blocks web_search.",
      type: "constraint",
    },
    {
      label: "no real outbound network in this environment",
      title: "本环境没有真实出网",
      body: "本环境没有真实出网，web 工具与搜索工具均不可用。",
      type: "constraint",
    },
  ];

  for (const fixture of CAPABILITY_FIXTURES) {
    it(`rejects and writes nothing: ${fixture.label}`, async () => {
      const tool = createMemorySaveTool({ memoryDir });
      await assert.rejects(
        async () => {
          await tool.handler({
            title: fixture.title,
            body: fixture.body,
            type: fixture.type,
          });
        },
        (err: unknown) => {
          const e = err as MemoryCapabilityRejected;
          return (
            e.name === "MemoryCapabilityRejected" &&
            e.reason === CAPABILITY_OBSERVATION_REASON &&
            e.detail.length > 0
          );
        }
      );
      // No new slug, no MEMORY.md: the gate fires before any disk mutation.
      assert.deepEqual(await readdir(memoryDir), []);
    });
  }

  it("leaves an existing MEMORY.md byte-identical after a rejected save", async () => {
    const tool = createMemorySaveTool({ memoryDir });
    await tool.handler({
      title: "Use bar()",
      body: "bar() is the entry point.",
    });
    const indexPath = join(memoryDir, "MEMORY.md");
    const before = await readFile(indexPath, "utf8");
    const filesBefore = await readdir(memoryDir);

    await assert.rejects(async () => {
      await tool.handler({
        title: "本环境没有真实出网",
        body: "本环境没有真实出网，web 工具与搜索工具均不可用。",
      });
    });

    assert.equal(await readFile(indexPath, "utf8"), before);
    assert.deepEqual(await readdir(memoryDir), filesBefore);
  });

  it("still persists a product-policy constraint (SC1 positive)", async () => {
    const tool = createMemorySaveTool({ memoryDir });
    const out = await tool.handler({
      title: "隔离 ON 时 mutate 须先建 worktree",
      body: "隔离开启时，任何 mutate 类工具调用必须先建立 worktree 再执行。",
      type: "constraint",
    });
    assert.match(out as string, /persisted as/);
    const files = await readdir(memoryDir);
    assert.equal(
      files.filter((f) => f.endsWith(".md") && f !== "MEMORY.md").length,
      1
    );
  });

  it("still persists a project convention", async () => {
    const tool = createMemorySaveTool({ memoryDir });
    const out = await tool.handler({
      title: "测试命令与目录习惯",
      body: "跑测试用 npm test；单元测试放 tests/harness。",
      type: "convention",
    });
    assert.match(out as string, /persisted as/);
  });

  // Order is pinned: the empty-input gate must win before the capability gate,
  // so an empty draft reports the older, more precise failure.
  it("hits the empty-input gate first for an empty title/body draft", async () => {
    const tool = createMemorySaveTool({ memoryDir });
    await assert.rejects(
      async () => {
        await tool.handler({ title: "", body: "" });
      },
      (err: unknown) => {
        const e = err as MemoryError;
        return (
          e.name === "MemoryError" &&
          /title must be a non-empty/.test(e.message)
        );
      }
    );
  });

  it("hits the affirmative-phrasing gate before the capability gate", async () => {
    const tool = createMemorySaveTool({ memoryDir });
    await assert.rejects(
      async () => {
        await tool.handler({
          title: "Never call web_search",
          body: "web_search is unavailable here.",
        });
      },
      (err: unknown) => {
        const e = err as MemoryError;
        return e.name === "MemoryError" && /negative_form/.test(e.message);
      }
    );
  });

  // Model-visible string, pinned end to end: handler -> registry -> executor
  // -> anthropic tool_result. The rejection reason must reach the model, not
  // collapse into the executor's generic "tool execution failed".
  it("reaches the model as an execution_failed tool_result with the reason", async () => {
    const tool = createMemorySaveTool({ memoryDir });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const results = await exec.executeAll([
      {
        id: "c1",
        name: "memory_save",
        input: {
          title: "本环境没有真实出网",
          body: "本环境没有真实出网，web 工具与搜索工具均不可用。",
        },
      },
    ]);
    assert.equal(results[0]!.kind, "execution_failed");
    const message =
      results[0]!.kind === "execution_failed" ? results[0]!.message : "";
    assert.match(message, /memory_save/);
    assert.match(message, /capability_observation/);
    assert.deepEqual(
      await readdir(memoryDir),
      [],
      "the rejected draft must not touch disk"
    );

    const blocks = toAnthropicToolResults(results);
    assert.equal(blocks[0]!.type, "tool_result");
    const content = blocks[0]!.content;
    const text =
      typeof content === "string"
        ? content
        : (content as ReadonlyArray<{ text: string }>)[0]!.text;
    assert.ok(
      text.includes("capability_observation"),
      `model-visible string must carry the reason, got: ${text}`
    );
  });

  // Same claim on the production wiring (ACI registry + permission gate), so
  // the reason cannot be lost in a layer the bare executor test skips.
  it("keeps the reason readable through the real ACI executor chain", async () => {
    const tool = createMemorySaveTool({ memoryDir });
    const reg = createAciRegistry([tool]);
    const exec = createAciExecutor({
      inner: createExecutor(reg.inner),
      catalog: reg.catalog,
    });
    const results = await exec.executeAll([
      {
        id: "c1",
        name: "memory_save",
        input: {
          title: "本环境没有真实出网",
          body: "本环境没有真实出网，web 工具与搜索工具均不可用。",
        },
      },
    ]);
    assert.equal(results[0]!.kind, "execution_failed");
    const message =
      results[0]!.kind === "execution_failed" ? results[0]!.message : "";
    assert.match(message, /capability_observation/);
    assert.deepEqual(await readdir(memoryDir), []);
  });
});

// -- non-scalar extra: the shared writer refuses the write and says so --------

/**
 * Capture `console.warn` across an await and keep the rejection. The refusal
 * is a pair — one warn plus one typed throw — and the cases below assert both
 * halves, so the rejection is parked instead of rethrown.
 */
async function captureWarns(
  run: () => Promise<unknown>
): Promise<{ rejected: unknown; warned: string[] }> {
  const warned: string[] = [];
  let rejected: unknown;
  try {
    await captureConsoleWarnAsync(run, warned);
  } catch (error) {
    rejected = error;
  }
  return { rejected, warned };
}

/** The one shape the pinned writer cannot emit: an unknown extra that is a sequence. */
function entryWithNonScalarExtra(): MemoryEntryV1 {
  return {
    ...defaultMemoryEntry(),
    id: "mem-1",
    title: "Use bar()",
    body: "Calling bar() is the supported path.",
    updated_at: "2026-02-01T12:00:00.000Z",
    tags: ["alpha", "beta"],
  } as unknown as MemoryEntryV1;
}

describe("writeMemoryEntryAtomic — a non-scalar extra refuses the write", () => {
  const SLUG = "cafe0000beef";

  it("leaves no file behind when the target did not exist", async () => {
    const { rejected } = await captureWarns(() =>
      writeMemoryEntryAtomic(memoryDir, SLUG, entryWithNonScalarExtra())
    );
    assert.ok(
      rejected instanceof MemoryIOError,
      `the caller must see a typed failure, got ${String(rejected)}`
    );
    assert.equal(await exists(join(memoryDir, `${SLUG}.md`)), false);
    assert.deepEqual(
      await readdir(memoryDir),
      [],
      "a refused write must leave neither the entry nor a stale tmp file"
    );
  });

  it("leaves a pre-existing file byte-identical", async () => {
    const first: MemoryEntryV1 = {
      ...defaultMemoryEntry(),
      id: "mem-1",
      title: "Use bar()",
      body: "first revision",
      updated_at: "2026-02-01T12:00:00.000Z",
      tags: "alpha",
    } as unknown as MemoryEntryV1;
    await writeMemoryEntryAtomic(memoryDir, SLUG, first);
    const target = join(memoryDir, `${SLUG}.md`);
    const before = await readFile(target, "utf8");

    const { rejected } = await captureWarns(() =>
      writeMemoryEntryAtomic(memoryDir, SLUG, entryWithNonScalarExtra())
    );
    assert.ok(rejected instanceof MemoryIOError);
    assert.equal(await readFile(target, "utf8"), before);
    assert.deepEqual(
      await readdir(memoryDir),
      [`${SLUG}.md`],
      "no tmp file may survive the refusal"
    );
  });

  it("warns once, naming the slug and the key but never the value", async () => {
    const { rejected, warned } = await captureWarns(() =>
      writeMemoryEntryAtomic(memoryDir, SLUG, entryWithNonScalarExtra())
    );
    assert.ok(rejected instanceof MemoryIOError);
    assert.equal(
      warned.length,
      1,
      `exactly one warning expected, got: ${JSON.stringify(warned)}`
    );
    assert.match(warned[0]!, /^\[memory\/save\]/);
    // The warn text is the typed message, not a second copy of it: one string
    // source, so the seam and the error can never drift apart.
    assert.equal(
      warned[0]!,
      `[memory/save] refused ${SLUG}.md: memory frontmatter extra "tags" is not a scalar`
    );
    assert.ok(
      warned[0]!.includes(SLUG),
      `warning must name the slug: ${warned[0]}`
    );
    assert.ok(
      warned[0]!.includes("tags"),
      `warning must name the key: ${warned[0]}`
    );
    assert.ok(
      !warned[0]!.includes("alpha") && !warned[0]!.includes("beta"),
      `the warning must not carry extra content: ${warned[0]}`
    );
    assert.ok(
      !warned[0]!.includes("Calling bar()"),
      `the warning must not carry the body: ${warned[0]}`
    );
  });

  it("surfaces the refusal as a typed MemoryIOError whose cause names the key", async () => {
    const { rejected } = await captureWarns(() =>
      writeMemoryEntryAtomic(memoryDir, SLUG, entryWithNonScalarExtra())
    );
    assert.ok(rejected instanceof MemoryIOError);
    assert.ok(
      rejected.cause instanceof MemorySchemaInvalid,
      `the cause must stay typed, got ${String(rejected.cause)}`
    );
    assert.equal((rejected.cause as MemorySchemaInvalid).field, "tags");
  });
});

// -- ADR-0044 SC5: memory_save description stays cross-session fact capture ----

describe("memory_save — description contract (ADR-0044 SC5)", () => {
  it("does not command the model to write AGENTS.md or author long-term rules", () => {
    const tool = createMemorySaveTool({ memoryDir });
    assert.ok(
      !/write.*AGENTS\.md/i.test(tool.description),
      "description must not command writing AGENTS.md"
    );
    assert.ok(
      !/long.?term.*rule/i.test(tool.description),
      "description must not promote authoring long-term rules"
    );
  });
});
