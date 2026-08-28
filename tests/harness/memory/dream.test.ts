import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_DREAM_ENTRIES,
  runMemoryDream,
  serializeMemoryEntry,
} from "../../../src/harness/memory/index.ts";
import type {
  MemoryEntryV1,
  MemoryExtractLlm,
} from "../../../src/harness/memory/index.ts";

const NOW_ISO = "2026-08-26T00:00:00.000Z";

const entry = (
  slug: string,
  overrides?: Partial<MemoryEntryV1>
): MemoryEntryV1 => ({
  id: slug,
  type: "note",
  importance: 2,
  ttl_days: 0,
  disabled: false,
  supersedes: null,
  title: "Use queue for concurrency",
  body: "The scheduler queue handles concurrent tasks.",
  updated_at: NOW_ISO,
  ...overrides,
});

describe("runMemoryDream", () => {
  it("does not call the model for an empty live store", async () => {
    const memoryDir = await mkdtemp(join(tmpdir(), "memory-dream-empty-"));
    try {
      let calls = 0;
      const llm: MemoryExtractLlm = {
        complete: async () => {
          calls++;
          return "[]";
        },
      };

      const result = await runMemoryDream({ memoryDir, llm });

      assert.deepEqual(result.ops, []);
      assert.equal(calls, 0);
    } finally {
      await rm(memoryDir, { recursive: true, force: true });
    }
  });

  it("does not call the model when fewer than two live entries exist", async () => {
    const memoryDir = await mkdtemp(join(tmpdir(), "memory-dream-one-"));
    try {
      await writeFile(
        join(memoryDir, "old.md"),
        serializeMemoryEntry(entry("old")),
        "utf8"
      );
      let calls = 0;
      const llm: MemoryExtractLlm = {
        complete: async () => {
          calls++;
          return "[]";
        },
      };

      const result = await runMemoryDream({ memoryDir, llm });

      assert.deepEqual(result.ops, []);
      assert.equal(calls, 0);
    } finally {
      await rm(memoryDir, { recursive: true, force: true });
    }
  });

  it("updates a near-duplicate entry with source: dream", async () => {
    const memoryDir = await mkdtemp(join(tmpdir(), "memory-dream-merge-"));
    try {
      await writeFile(
        join(memoryDir, "old.md"),
        serializeMemoryEntry(entry("old")),
        "utf8"
      );
      await writeFile(
        join(memoryDir, "sibling.md"),
        serializeMemoryEntry(
          entry("sibling", {
            title: "Use queue for parallel work",
            body: "The scheduler queue handles concurrent tasks.",
          })
        ),
        "utf8"
      );
      const llm: MemoryExtractLlm = {
        complete: async () =>
          JSON.stringify([
            {
              title: "Use queue for concurrency",
              body: "The scheduler queue safely handles concurrent tasks and preserves ordering.",
              type: "convention",
              importance: 4,
            },
          ]),
      };

      const result = await runMemoryDream({
        memoryDir,
        llm,
        now: () => NOW_ISO,
        randomBytes: () => Buffer.from("aabbccddeeff", "hex"),
      });

      assert.ok(
        result.written.some((written) => written.kind === "UPDATE"),
        "merge candidate should update an existing entry"
      );
      const stored = await readFile(join(memoryDir, "old.md"), "utf8");
      assert.match(stored, /^source: dream$/m);
      assert.match(
        stored,
        /safely handles concurrent tasks and preserves ordering/
      );
    } finally {
      await rm(memoryDir, { recursive: true, force: true });
    }
  });

  it("caps the number of live entries included in the merge prompt", async () => {
    const memoryDir = await mkdtemp(join(tmpdir(), "memory-dream-cap-"));
    try {
      for (let i = 0; i < MAX_DREAM_ENTRIES + 5; i++) {
        await writeFile(
          join(memoryDir, `entry-${i}.md`),
          serializeMemoryEntry(
            entry(`entry-${i}`, {
              title: `Merge candidate ${i}`,
              body: `Body ${i} has a stable fact.`,
            })
          ),
          "utf8"
        );
      }
      let prompt = "";
      const llm: MemoryExtractLlm = {
        complete: async (value) => {
          prompt = value;
          return "[]";
        },
      };

      await runMemoryDream({ memoryDir, llm });

      const included = Array.from(
        { length: MAX_DREAM_ENTRIES + 5 },
        (_, i) => `Merge candidate ${i}`
      ).filter((title) => prompt.includes(title));
      assert.equal(included.length, MAX_DREAM_ENTRIES);
    } finally {
      await rm(memoryDir, { recursive: true, force: true });
    }
  });

  it("wraps invalid model output in MemoryExtractError and keeps GC model-free", async () => {
    const memoryDir = await mkdtemp(join(tmpdir(), "memory-dream-error-"));
    try {
      await writeFile(
        join(memoryDir, "old.md"),
        serializeMemoryEntry(entry("old")),
        "utf8"
      );
      await writeFile(
        join(memoryDir, "sib.md"),
        serializeMemoryEntry(entry("sib", { title: "Use queue elsewhere" })),
        "utf8"
      );
      await assert.rejects(
        () =>
          runMemoryDream({
            memoryDir,
            llm: { complete: async () => "not json" },
          }),
        /MemoryExtractError|not JSON/
      );

      const gcSource = readFileSync(
        new URL("../../../src/harness/memory/gc.ts", import.meta.url),
        "utf8"
      );
      for (const line of gcSource.split("\n")) {
        if (line.startsWith("import ")) {
          assert.doesNotMatch(line, /\b(?:LLM|adapter|complete)\b/i);
        }
      }
    } finally {
      await rm(memoryDir, { recursive: true, force: true });
    }
  });
});
