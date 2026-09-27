import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_DREAM_ENTRIES,
  parseMemoryEntry,
  runMemoryDream,
  runMemoryGc,
  serializeMemoryEntry,
} from "../../../src/harness/memory/index.ts";
import { MAX_SUPERSEDES_PER_CANDIDATE } from "../../../src/harness/memory/dream.ts";
import { captureConsoleWarnAsync } from "../../_helpers/capture-console-warn.ts";
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

// -- dream replaces → SUPERSEDE (specs/auto-memory-layering.md SC3/4/11/12) --

describe("runMemoryDream — replaces", () => {
  const seedPair = async (memoryDir: string): Promise<void> => {
    await writeFile(
      join(memoryDir, "old.md"),
      serializeMemoryEntry(entry("old")),
      "utf8"
    );
    await writeFile(
      join(memoryDir, "sib.md"),
      serializeMemoryEntry(
        entry("sib", {
          title: "Use queue for parallel work",
          body: "The scheduler queue handles concurrent tasks.",
        })
      ),
      "utf8"
    );
  };

  // SC3: a dream candidate naming `replaces` persists as SUPERSEDE and the
  // subsequent mechanical GC soft-disables the named target.
  it("persists a replaces candidate as SUPERSEDE and GC disables the target", async () => {
    const memoryDir = await mkdtemp(join(tmpdir(), "memory-dream-sc3-"));
    try {
      await seedPair(memoryDir);
      const llm: MemoryExtractLlm = {
        complete: async () =>
          JSON.stringify([
            {
              title: "Use queue for concurrency",
              body: "Concurrency routes through the scheduler queue as of v3.",
              type: "convention",
              importance: 4,
              replaces: ["old"],
            },
          ]),
      };

      const result = await runMemoryDream({ memoryDir, llm });
      assert.equal(result.ops[0]!.kind, "SUPERSEDE");

      await runMemoryGc(memoryDir, { nowMs: Date.parse(NOW_ISO) });

      const fresh = result.written.find(
        (written) => written.kind === "SUPERSEDE"
      );
      assert.ok(fresh, "the SUPERSEDE op must land on disk");
      const stored = parseMemoryEntry(
        await readFile(join(memoryDir, `${fresh!.slug}.md`), "utf8")
      );
      assert.ok(
        stored.supersedes?.includes("old"),
        "the new entry's supersedes must contain old"
      );
      assert.equal(
        parseMemoryEntry(await readFile(join(memoryDir, "old.md"), "utf8"))
          .disabled,
        true,
        "GC must soft-disable the superseded target"
      );
    } finally {
      await rm(memoryDir, { recursive: true, force: true });
    }
  });

  // SC4: without `replaces` the candidate goes through the (shrunken) decide
  // table — a low word-overlap body never supersedes its neighbor.
  it("never supersedes a neighbor when the candidate carries no replaces", async () => {
    const memoryDir = await mkdtemp(join(tmpdir(), "memory-dream-sc4-"));
    try {
      await seedPair(memoryDir);
      const llm: MemoryExtractLlm = {
        complete: async () =>
          JSON.stringify([
            {
              title: "Zebra herds migrate seasonally",
              body: "Plains zebras travel toward fresh grazing ground each dry season.",
              confidence: 0.95,
            },
          ]),
      };

      const result = await runMemoryDream({ memoryDir, llm });

      for (const op of result.ops) {
        assert.ok(
          op.kind === "ADD" || op.kind === "UPDATE",
          `expected ADD or UPDATE, got ${op.kind}`
        );
      }
      await runMemoryGc(memoryDir);
      assert.equal(
        parseMemoryEntry(await readFile(join(memoryDir, "old.md"), "utf8"))
          .disabled,
        false,
        "no replaces means no supersede — old stays live"
      );
    } finally {
      await rm(memoryDir, { recursive: true, force: true });
    }
  });

  // SC11: unknown slugs in `replaces` are reported (when an observer is
  // wired) and skipped without failing the turn.
  it("reports and skips unknown replaces ids, still superseding the known one", async () => {
    const memoryDir = await mkdtemp(join(tmpdir(), "memory-dream-sc11-"));
    try {
      await seedPair(memoryDir);
      const reported: unknown[] = [];
      const llm: MemoryExtractLlm = {
        complete: async () =>
          JSON.stringify([
            {
              title: "Use queue for concurrency",
              body: "Concurrency routes through the scheduler queue as of v3.",
              replaces: ["ghost", "old"],
            },
          ]),
      };

      const result = await runMemoryDream({
        memoryDir,
        llm,
        onError: (error) => reported.push(error),
      });

      const supercede = result.ops.find((op) => op.kind === "SUPERSEDE");
      assert.ok(supercede, "the known id must still produce a SUPERSEDE");
      assert.deepEqual(
        supercede!.kind === "SUPERSEDE" ? supercede!.supersedes : [],
        ["old"]
      );
      const fresh = result.written.find(
        (written) => written.kind === "SUPERSEDE"
      );
      assert.ok(fresh);
      const stored = parseMemoryEntry(
        await readFile(join(memoryDir, `${fresh!.slug}.md`), "utf8")
      );
      assert.deepEqual(stored.supersedes, ["old"]);
      assert.equal(reported.length, 1, "the skipped slug must be reported");
      assert.match(
        String(reported[0]),
        /dream: unknown replaces slug "ghost" skipped/
      );
    } finally {
      await rm(memoryDir, { recursive: true, force: true });
    }
  });

  // SC12: at most MAX_SUPERSEDES_PER_CANDIDATE ids reach one entry.
  it("caps replaces at 8 ids per candidate", async () => {
    const memoryDir = await mkdtemp(join(tmpdir(), "memory-dream-sc12-"));
    try {
      const slugs = Array.from({ length: 10 }, (_, i) => `s${i}`);
      for (const slug of slugs) {
        await writeFile(
          join(memoryDir, `${slug}.md`),
          serializeMemoryEntry(
            entry(slug, {
              title: `Fact ${slug}`,
              body: `Body of ${slug} with a stable fact.`,
            })
          ),
          "utf8"
        );
      }
      const llm: MemoryExtractLlm = {
        complete: async () =>
          JSON.stringify([
            {
              title: "Use queue for concurrency",
              body: "Concurrency routes through the scheduler queue as of v3.",
              replaces: slugs,
            },
          ]),
      };

      const result = await runMemoryDream({ memoryDir, llm });

      const fresh = result.written.find(
        (written) => written.kind === "SUPERSEDE"
      );
      assert.ok(fresh);
      const stored = parseMemoryEntry(
        await readFile(join(memoryDir, `${fresh!.slug}.md`), "utf8")
      );
      assert.ok(
        stored.supersedes !== null && stored.supersedes.length <= 8,
        `at most ${MAX_SUPERSEDES_PER_CANDIDATE} ids may be written`
      );
      assert.deepEqual(stored.supersedes, slugs.slice(0, 8));
    } finally {
      await rm(memoryDir, { recursive: true, force: true });
    }
  });

  // Duplicates collapse to their first occurrence before the cap: a repeated
  // id must not crowd a valid later slug out of the 8-id budget.
  it("collapses duplicate replaces ids before applying the cap", async () => {
    const memoryDir = await mkdtemp(join(tmpdir(), "memory-dream-dedup-"));
    try {
      const slugs = Array.from({ length: 10 }, (_, i) => `s${i}`);
      for (const slug of slugs) {
        await writeFile(
          join(memoryDir, `${slug}.md`),
          serializeMemoryEntry(
            entry(slug, {
              title: `Fact ${slug}`,
              body: `Body of ${slug} with a stable fact.`,
            })
          ),
          "utf8"
        );
      }
      const llm: MemoryExtractLlm = {
        complete: async () =>
          JSON.stringify([
            {
              title: "Use queue for concurrency",
              body: "Concurrency routes through the scheduler queue as of v3.",
              replaces: [
                "s0",
                "s0",
                "s1",
                "s2",
                "s3",
                "s4",
                "s5",
                "s6",
                "s7",
                "s8",
              ],
            },
          ]),
      };

      const result = await runMemoryDream({ memoryDir, llm });

      const fresh = result.written.find(
        (written) => written.kind === "SUPERSEDE"
      );
      assert.ok(fresh);
      const stored = parseMemoryEntry(
        await readFile(join(memoryDir, `${fresh!.slug}.md`), "utf8")
      );
      assert.deepEqual(stored.supersedes, [
        "s0",
        "s1",
        "s2",
        "s3",
        "s4",
        "s5",
        "s6",
        "s7",
      ]);
    } finally {
      await rm(memoryDir, { recursive: true, force: true });
    }
  });
});

// -- runtime capability persist gate (ADR-0086) ------------------------------

describe("runMemoryDream — runtime capability gate", () => {
  const seed = async (memoryDir: string): Promise<void> => {
    await writeFile(
      join(memoryDir, "old.md"),
      serializeMemoryEntry(entry("old")),
      "utf8"
    );
    await writeFile(
      join(memoryDir, "sib.md"),
      serializeMemoryEntry(
        entry("sib", {
          title: "Use queue for parallel work",
          body: "The scheduler queue handles concurrent tasks.",
        })
      ),
      "utf8"
    );
  };

  // The dream path shares persistMemoryOps with extract: a capability
  // candidate must be dropped there too, without breaking the merge pass.
  it("drops a capability candidate while a sibling SUPERSEDE still lands", async () => {
    const memoryDir = await mkdtemp(join(tmpdir(), "memory-dream-cap-"));
    try {
      await seed(memoryDir);
      const llm: MemoryExtractLlm = {
        complete: async () =>
          JSON.stringify([
            {
              title: "本环境没有真实出网",
              body: "本环境没有真实出网，web 工具与搜索工具均不可用。",
              type: "constraint",
            },
            {
              title: "Use queue for concurrency",
              body: "Concurrency routes through the scheduler queue as of v3.",
              type: "convention",
              importance: 4,
              replaces: ["old"],
            },
          ]),
      };

      const result = await runMemoryDream({ memoryDir, llm });

      assert.ok(
        result.ops.some((op) => op.kind === "SUPERSEDE"),
        "the non-capability candidate must still be decided"
      );
      assert.equal(result.written.length, 1);
      assert.equal(result.written[0]!.kind, "SUPERSEDE");
      const fresh = await readFile(
        join(memoryDir, `${result.written[0]!.slug}.md`),
        "utf8"
      );
      assert.ok(
        !/capability|出网/.test(fresh),
        "capability text must not reach disk"
      );
    } finally {
      await rm(memoryDir, { recursive: true, force: true });
    }
  });

  it("keeps SUPERSEDE working when no capability candidate is present", async () => {
    const memoryDir = await mkdtemp(join(tmpdir(), "memory-dream-nocap-"));
    try {
      await seed(memoryDir);
      const llm: MemoryExtractLlm = {
        complete: async () =>
          JSON.stringify([
            {
              title: "Use queue for concurrency",
              body: "Concurrency routes through the scheduler queue as of v3.",
              type: "convention",
              importance: 4,
              replaces: ["old"],
            },
          ]),
      };

      const result = await runMemoryDream({ memoryDir, llm });

      assert.equal(result.written.length, 1);
      assert.equal(result.written[0]!.kind, "SUPERSEDE");
      const stored = parseMemoryEntry(
        await readFile(join(memoryDir, `${result.written[0]!.slug}.md`), "utf8")
      );
      assert.deepEqual(stored.supersedes, ["old"]);
    } finally {
      await rm(memoryDir, { recursive: true, force: true });
    }
  });
});

// -- skipped quarantine warning ----------------------------------------------
//
// SC-B3 (specs/memory-frontmatter-write-signals.md): the merge pass reads the
// store through the same reader as GC, ingest and the catalog, so an unreadable
// file must be filed as a quarantine and said out loud exactly once on the
// `[memory/dream]` warn seam — naming the slug and the reason category, never
// the file's own text — while the healthy entries still reach the model.

describe("runMemoryDream — skipped quarantine warning", () => {
  it("warns once naming the skipped slug and still feeds the healthy entries to the model", async () => {
    const memoryDir = await mkdtemp(join(tmpdir(), "memory-dream-skip-"));
    try {
      // The unreadable row's own text. `title: Rule: …` is not a legal YAML
      // scalar, which is what makes the reader reject the block.
      const secretTitle = "lockfile edits go through npm";
      const secretBody = "SECRET-DREAM-BODY-MUST-NEVER-LEAK";
      await writeFile(
        join(memoryDir, "queue.md"),
        serializeMemoryEntry(entry("queue")),
        "utf8"
      );
      await writeFile(
        join(memoryDir, "deploy.md"),
        serializeMemoryEntry(entry("deploy", { title: "Ship on Fridays" })),
        "utf8"
      );
      await writeFile(
        join(memoryDir, "broken.md"),
        [
          "---",
          "id: ab12cd34ef56",
          `title: Rule: ${secretTitle}`,
          "---",
          secretBody,
          "",
        ].join("\n"),
        "utf8"
      );
      let prompt = "";
      let calls = 0;
      const llm: MemoryExtractLlm = {
        complete: async (text: string) => {
          calls++;
          prompt = text;
          return "[]";
        },
      };

      const dream = await captureConsoleWarnAsync(() =>
        runMemoryDream({ memoryDir, llm })
      );
      // Scoped to the quarantine seam: the shared reader has its own
      // degraded-key warn (`[memory/frontmatter]`) that echoes the offending
      // line, and that text belongs to a different contract than the skip
      // record under test.
      const skipWarns = dream.messages.filter((w) =>
        w.includes("[memory/dream] skipped")
      );
      assert.equal(
        skipWarns.length,
        1,
        `exactly one quarantine line expected, got: ${JSON.stringify(skipWarns)}`
      );
      assert.match(skipWarns[0]!, /broken\.md=frontmatter_unreadable/);
      for (const line of skipWarns) {
        assert.ok(!line.includes(secretTitle), `title leaked: ${line}`);
        assert.ok(!line.includes(secretBody), `body leaked: ${line}`);
      }
      assert.equal(
        calls,
        1,
        "one unreadable sibling must not stall the merge pass"
      );
      assert.ok(
        prompt.includes("Ship on Fridays"),
        "the healthy sibling still reaches the model"
      );
      assert.ok(
        !prompt.includes(secretTitle) && !prompt.includes(secretBody),
        "the quarantined file's content never reaches the model"
      );
      assert.deepEqual(dream.result, { ops: [], written: [] });
    } finally {
      await rm(memoryDir, { recursive: true, force: true });
    }
  });
});
