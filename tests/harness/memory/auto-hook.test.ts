/**
 * auto-memory T4: auto-hook.ts tests (host-side trigger gate).
 *
 * Spec: specs/auto-memory.md D1/D4; ADR-0031 Decision 1/5. The hook is the
 * seam a host calls after every turn. It must:
 *   - do nothing at all unless explicitly enabled (default OFF)
 *   - fire only after StopReason=completed, and only on the N>=2 turn gate
 *   - run ingest off the caller's critical path (fire-and-forget)
 *   - never throw and never reject, whatever ingest does
 *
 * `drain()` exists so fire-and-forget stays testable: without it the only way
 * to assert on an async side effect is a sleep, which is the flake this suite
 * is not going to introduce.
 */
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAutoMemoryHook,
  parseMemoryEntry,
  serializeMemoryEntry,
} from "../../../src/harness/memory/index.ts";
import type { MemoryExtractLlm } from "../../../src/harness/memory/index.ts";
import type { MemoryEntryV1 } from "../../../src/harness/memory/index.ts";

let memoryDir: string;

beforeEach(async () => {
  memoryDir = await mkdtemp(join(tmpdir(), "memory-auto-hook-"));
});

afterEach(async () => {
  await rm(memoryDir, { recursive: true, force: true });
});

const NOW_ISO = "2026-08-26T00:00:00.000Z";

const FACT = JSON.stringify([
  {
    title: "Use bar() for concurrency",
    body: "bar() is the thread-safe entry point in this repo.",
    confidence: 0.95,
  },
]);

/** LLM fake that also records how many times it was asked. */
const countingLlm = (
  raw: string
): MemoryExtractLlm & { readonly calls: () => number } => {
  let calls = 0;
  return {
    complete: async () => {
      calls++;
      return raw;
    },
    calls: () => calls,
  };
};

const entryCount = async (): Promise<number> =>
  (await readdir(memoryDir)).filter(
    (n) => n.endsWith(".md") && n !== "MEMORY.md"
  ).length;

const hookOpts = (llm: MemoryExtractLlm, over?: Record<string, unknown>) => ({
  memoryDir,
  llm,
  enabled: true,
  minCompletedTurns: 1,
  now: () => NOW_ISO,
  nowMs: Date.parse(NOW_ISO),
  ...over,
});

// -- the OFF default ---------------------------------------------------------

describe("createAutoMemoryHook — default OFF", () => {
  it("spends no LLM call and writes nothing when disabled", async () => {
    const llm = countingLlm(FACT);
    const hook = createAutoMemoryHook(hookOpts(llm, { enabled: false }));
    hook.onTurnComplete({ stopReason: "completed", transcript: "user: hi" });
    await hook.drain();
    assert.equal(llm.calls(), 0);
    assert.equal(await entryCount(), 0);
  });

  it("treats a missing enabled flag as off", async () => {
    const llm = countingLlm(FACT);
    const hook = createAutoMemoryHook({
      memoryDir,
      llm,
      minCompletedTurns: 1,
      now: () => NOW_ISO,
    });
    hook.onTurnComplete({ stopReason: "completed", transcript: "user: hi" });
    await hook.drain();
    assert.equal(llm.calls(), 0);
  });
});

// -- the completed gate ------------------------------------------------------

describe("createAutoMemoryHook — completed gate", () => {
  it("ingests after a completed turn", async () => {
    const llm = countingLlm(FACT);
    const hook = createAutoMemoryHook(hookOpts(llm));
    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "user: which entry point is thread-safe?",
    });
    await hook.drain();
    assert.equal(llm.calls(), 1);
    assert.equal(await entryCount(), 1);
  });

  for (const stopReason of [
    "maxTurns",
    "cancelled",
    "protocolError",
    "nonSuccessStop",
    "emptyFinalResponse",
    "timeout",
    "fused",
  ]) {
    it(`ignores a turn that stopped with ${stopReason}`, async () => {
      const llm = countingLlm(FACT);
      const hook = createAutoMemoryHook(hookOpts(llm));
      hook.onTurnComplete({ stopReason, transcript: "user: hi" });
      await hook.drain();
      assert.equal(llm.calls(), 0);
      assert.equal(await entryCount(), 0);
    });
  }

  // empty boundary
  it("ignores a turn with a blank transcript", async () => {
    const llm = countingLlm(FACT);
    const hook = createAutoMemoryHook(hookOpts(llm));
    hook.onTurnComplete({ stopReason: "completed", transcript: "   " });
    await hook.drain();
    assert.equal(llm.calls(), 0);
  });
});

// -- the N>=2 turn gate ------------------------------------------------------

describe("createAutoMemoryHook — completed-turn gate", () => {
  it("waits for the second completed turn at the default gate", async () => {
    const llm = countingLlm(FACT);
    const hook = createAutoMemoryHook({
      memoryDir,
      llm,
      enabled: true,
      now: () => NOW_ISO,
      nowMs: Date.parse(NOW_ISO),
    });
    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "user: turn one",
    });
    await hook.drain();
    assert.equal(llm.calls(), 0, "one completed turn is below the gate");

    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "user: turn two",
    });
    await hook.drain();
    assert.equal(llm.calls(), 1);
  });

  it("does not count non-completed turns toward the gate", async () => {
    const llm = countingLlm(FACT);
    const hook = createAutoMemoryHook({
      memoryDir,
      llm,
      enabled: true,
      now: () => NOW_ISO,
    });
    hook.onTurnComplete({ stopReason: "completed", transcript: "user: one" });
    hook.onTurnComplete({ stopReason: "cancelled", transcript: "user: two" });
    hook.onTurnComplete({ stopReason: "maxTurns", transcript: "user: three" });
    await hook.drain();
    assert.equal(llm.calls(), 0);
  });

  it("rejects a non-positive gate with a typed MemoryError", () => {
    assert.throws(() =>
      createAutoMemoryHook({
        memoryDir,
        llm: countingLlm(FACT),
        enabled: true,
        minCompletedTurns: 0,
      })
    );
  });
});

// -- failure never fails the turn --------------------------------------------

describe("createAutoMemoryHook — failure containment", () => {
  it("swallows an LLM failure and reports it to onError", async () => {
    const seen: unknown[] = [];
    const hook = createAutoMemoryHook(
      hookOpts(
        {
          complete: async () => {
            throw new Error("model unavailable");
          },
        },
        { onError: (e: unknown) => seen.push(e) }
      )
    );
    // The call itself must be synchronous and total — a throwing hook would
    // take the user's turn down with it.
    hook.onTurnComplete({ stopReason: "completed", transcript: "user: hi" });
    await hook.drain();
    assert.equal(seen.length, 1);
    assert.match(String(seen[0]), /model unavailable|extraction call failed/);
  });

  it("swallows an unusable memory dir without rejecting", async () => {
    // A regular file where a directory has to be: mkdir fails with ENOTDIR.
    const blocker = join(memoryDir, "blocker");
    await writeFile(blocker, "not a directory", "utf8");
    const seen: unknown[] = [];
    const hook = createAutoMemoryHook({
      memoryDir: join(blocker, "memory"),
      llm: countingLlm(FACT),
      enabled: true,
      minCompletedTurns: 1,
      now: () => NOW_ISO,
      onError: (e) => seen.push(e),
    });
    hook.onTurnComplete({ stopReason: "completed", transcript: "user: hi" });
    await hook.drain();
    assert.equal(seen.length, 1, "the IO failure is reported, not thrown");
  });

  it("keeps working after a failed pass", async () => {
    let fail = true;
    const hook = createAutoMemoryHook(
      hookOpts({
        complete: async () => {
          if (fail) {
            fail = false;
            throw new Error("transient");
          }
          return FACT;
        },
      })
    );
    hook.onTurnComplete({ stopReason: "completed", transcript: "user: one" });
    await hook.drain();
    assert.equal(await entryCount(), 0);
    hook.onTurnComplete({ stopReason: "completed", transcript: "user: two" });
    await hook.drain();
    assert.equal(
      await entryCount(),
      1,
      "a failed pass must not poison the hook"
    );
  });

  // concurrent boundary
  it("serializes overlapping turns so two passes cannot interleave a write", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const hook = createAutoMemoryHook(
      hookOpts({
        complete: async () => {
          maxInFlight = Math.max(maxInFlight, ++inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
          return FACT;
        },
      })
    );
    hook.onTurnComplete({ stopReason: "completed", transcript: "user: one" });
    hook.onTurnComplete({ stopReason: "completed", transcript: "user: two" });
    await hook.drain();
    assert.equal(maxInFlight, 1, "ingest passes must not overlap on one store");
  });
});

describe("createAutoMemoryHook — dream pass", () => {
  it("runs dream after the completed-turn gate even for blank transcripts", async () => {
    const stored: MemoryEntryV1 = {
      id: "old",
      type: "note",
      importance: 1,
      ttl_days: 0,
      disabled: false,
      supersedes: null,
      title: "Existing fact",
      body: "The existing fact remains useful.",
      updated_at: NOW_ISO,
    };
    await writeFile(
      join(memoryDir, "old.md"),
      serializeMemoryEntry(stored),
      "utf8"
    );
    const llm = countingLlm("[]");
    const hook = createAutoMemoryHook({
      memoryDir,
      llm,
      enabled: false,
      dream: true,
      now: () => NOW_ISO,
      nowMs: Date.parse(NOW_ISO),
    });

    hook.onTurnComplete({ stopReason: "completed", transcript: "   " });
    hook.onTurnComplete({ stopReason: "completed", transcript: "" });
    await hook.drain();

    assert.equal(llm.calls(), 1, "dream does not require a transcript");
  });

  it("does not add a merge call when dream is explicitly off", async () => {
    const llm = countingLlm(FACT);
    const hook = createAutoMemoryHook(
      hookOpts(llm, { dream: false, minCompletedTurns: 2 })
    );

    hook.onTurnComplete({ stopReason: "completed", transcript: "user: one" });
    hook.onTurnComplete({ stopReason: "completed", transcript: "user: two" });
    await hook.drain();

    assert.equal(llm.calls(), 1, "extract-only remains one LLM call");
  });

  it("runs extract, dream, then one mechanical GC pass when both are on", async () => {
    const old: MemoryEntryV1 = {
      id: "old",
      type: "note",
      importance: 1,
      ttl_days: 0,
      disabled: false,
      supersedes: null,
      title: "Use bar() for concurrency",
      body: "bar() is the thread-safe entry point in this repo.",
      updated_at: NOW_ISO,
    };
    await writeFile(
      join(memoryDir, "old.md"),
      serializeMemoryEntry(old),
      "utf8"
    );
    const responses = [
      FACT,
      JSON.stringify([
        {
          title: "Use bar() for concurrency",
          body: "Concurrency now routes through the scheduler queue; direct calls were removed in v3.",
          confidence: 0.95,
        },
      ]),
    ];
    let calls = 0;
    const hook = createAutoMemoryHook(
      hookOpts(
        {
          complete: async () => responses[calls++] ?? "[]",
        },
        { dream: true }
      )
    );

    hook.onTurnComplete({ stopReason: "completed", transcript: "user: hi" });
    await hook.drain();

    assert.equal(calls, 2, "one extract call followed by one dream call");
    const files = await readdir(memoryDir);
    const stored = await Promise.all(
      files
        .filter((name) => name.endsWith(".md") && name !== "MEMORY.md")
        .map(async (name) =>
          parseMemoryEntry(await readFile(join(memoryDir, name), "utf8"))
        )
    );
    assert.ok(
      stored.some(
        (entry) =>
          (entry as unknown as Record<string, unknown>).source === "dream"
      )
    );
    assert.equal(
      parseMemoryEntry(await readFile(join(memoryDir, "old.md"), "utf8"))
        .disabled,
      true
    );
  });

  it("still runs mechanical GC when the dream merge throws", async () => {
    const stale: MemoryEntryV1 = {
      id: "stale",
      type: "note",
      importance: 1,
      ttl_days: 1,
      disabled: false,
      supersedes: null,
      title: "Stale fact",
      body: "This fact expired yesterday.",
      updated_at: "2026-08-20T00:00:00.000Z",
    };
    await writeFile(
      join(memoryDir, "stale.md"),
      serializeMemoryEntry(stale),
      "utf8"
    );
    const hook = createAutoMemoryHook({
      memoryDir,
      llm: {
        complete: async () => {
          throw new Error("merge exploded");
        },
      },
      enabled: false,
      dream: true,
      now: () => NOW_ISO,
      nowMs: Date.parse(NOW_ISO),
    });

    hook.onTurnComplete({ stopReason: "completed", transcript: "" });
    hook.onTurnComplete({ stopReason: "completed", transcript: "" });
    await hook.drain();

    assert.equal(
      parseMemoryEntry(await readFile(join(memoryDir, "stale.md"), "utf8"))
        .disabled,
      true,
      "TTL GC must still run after a dream failure"
    );
  });
});
