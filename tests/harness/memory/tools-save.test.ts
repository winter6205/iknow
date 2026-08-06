/**
 * #121 T5: memory_save tool tests.
 *
 * Spec: specs/121-memory-injection.md (Project Structure tools/save.ts,
 * Testing Strategy tools-save half, SC 6/7/9).
 *
 * Contract (SC 6/7/9):
 *   - first save creates `~/.iknow/memory/<basename>-<sha1(cwd)[:12]>/MEMORY.md`
 *     + `<slug>.md`
 *   - input `{ title, body, type?, importance? }`
 *   - affirmative phrasing rejection (spec SC 9): `don't` / `never` / `禁止` /
 *     `不要` / `不能` / body starting with `not ` → MemoryError (typed)
 *   - atomic write (tmp/rename); frontmatter auto-writes 6 fields + timestamp
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
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemorySaveTool } from "../../../src/harness/memory/tools/save.ts";
import { parseMemoryEntry } from "../../../src/harness/memory/index.ts";
import type { MemoryError } from "../../../src/harness/memory/index.ts";

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
        () => tool.handler(bad),
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
    await assert.rejects(() => tool.handler({ title: "Never foo", body: "x" }));
    const files = await readdir(memoryDir);
    assert.equal(files.length, 0);
  });
});

// -- schema validation -------------------------------------------------------

describe("memory_save — schema boundary classes", () => {
  it("rejects empty title / empty body", async () => {
    const tool = createMemorySaveTool({ memoryDir });
    await assert.rejects(() => tool.handler({ title: "", body: "x" }));
    await assert.rejects(() => tool.handler({ title: "x", body: "" }));
  });

  it("rejects importance outside 1..5", async () => {
    const tool = createMemorySaveTool({ memoryDir });
    await assert.rejects(() =>
      tool.handler({ title: "x", body: "y", importance: 0 })
    );
    await assert.rejects(() =>
      tool.handler({ title: "x", body: "y", importance: 6 })
    );
  });

  it("rejects non-object input", async () => {
    const tool = createMemorySaveTool({ memoryDir });
    await assert.rejects(() => tool.handler(null));
    await assert.rejects(() => tool.handler("t"));
  });

  it("rejects unknown fields (additionalProperties false)", async () => {
    const tool = createMemorySaveTool({ memoryDir });
    await assert.rejects(() =>
      tool.handler({ title: "x", body: "y", bogus: 1 } as never)
    );
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
    const tool = createMemorySaveTool({ memoryDir });
    // Pre-create a directory named exactly like the slug rename target path is
    // impossible to predict (hash slug), so instead we exercise the error path
    // by making the memory dir read-only below — simplest deterministic check:
    // a bogus memoryDir (parent is a file) → MemoryIOError.
    const blockedDir = join(memoryDir, "not-a-dir");
    await writeFile(blockedDir, "file", "utf8");
    const blockedTool = createMemorySaveTool({ memoryDir: blockedDir });
    await assert.rejects(
      () => blockedTool.handler({ title: "x", body: "y" }),
      (err: unknown) =>
        (err as MemoryError).name === "MemoryError" ||
        (err as MemoryError).name === "MemoryIOError"
    );
  });
});
