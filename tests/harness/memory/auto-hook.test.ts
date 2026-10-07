/**
 * auto-memory T4: auto-hook.ts tests (host-side trigger gate).
 *
 * Spec: specs/auto-memory.md D1/D4; ADR-0031 Decision 1/5. The hook is the
 * seam a host calls after every turn. It must:
 *   - do nothing at all unless explicitly enabled (default OFF)
 *   - fire only after StopReason=completed, and only on the completed-turn gate
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
  DEFAULT_COMPLETED_TURN_GATE,
  DREAM_CURSOR_FILENAME,
  parseMemoryEntry,
  serializeMemoryEntry,
} from "../../../src/harness/memory/index.ts";
import {
  MemoryIOError,
  type MemoryExtractLlm,
} from "../../../src/harness/memory/index.ts";
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

  it("reads live flags on each turn so TUI can flip autoExtract after wiring", async () => {
    const llm = countingLlm(FACT);
    const flags = { autoExtract: false, dream: false };
    const hook = createAutoMemoryHook(hookOpts(llm, { enabled: false, flags }));
    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "user: which entry point is thread-safe?",
    });
    await hook.drain();
    assert.equal(llm.calls(), 0);
    flags.autoExtract = true;
    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "user: which entry point is thread-safe?",
    });
    await hook.drain();
    assert.equal(llm.calls(), 1);
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

// -- the completed-turn gate (N from DEFAULT_COMPLETED_TURN_GATE) ------------

describe("createAutoMemoryHook — static layer on extract", () => {
  it("forwards a loaded static layer into the extract prompt", async () => {
    const layer = "Always use bun for this project's package manager.";
    const prompts: string[] = [];
    const llm: MemoryExtractLlm = {
      complete: async (prompt) => {
        prompts.push(prompt);
        return FACT;
      },
    };
    const hook = createAutoMemoryHook(
      hookOpts(llm, { staticLayer: async () => layer })
    );
    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "user: which package manager?",
    });
    await hook.drain();
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0]?.includes(layer));
  });

  it("still extracts when the static-layer loader throws", async () => {
    const llm = countingLlm(FACT);
    const errors: unknown[] = [];
    const hook = createAutoMemoryHook(
      hookOpts(llm, {
        staticLayer: async () => {
          throw new Error("lstat failed");
        },
        onError: (error: unknown) => {
          errors.push(error);
        },
      })
    );
    assert.doesNotThrow(() => {
      hook.onTurnComplete({
        stopReason: "completed",
        transcript: "user: which package manager?",
      });
    });
    await hook.drain();
    assert.equal(
      llm.calls(),
      1,
      "extract still runs after static-layer IO failure"
    );
    assert.equal(errors.length, 1);
  });
});

describe("createAutoMemoryHook — completed-turn gate", () => {
  it("defaults to 3 completed turns (ADR-0031 D1 amendment 2026-09-11)", () => {
    // SSOT: the value is asserted against the exported constant, never a
    // re-hardcoded number — the gate must not drift silently again.
    assert.equal(DEFAULT_COMPLETED_TURN_GATE, 3);
  });

  it("extracts only on the third completed turn at the default gate", async () => {
    const llm = countingLlm(FACT);
    const hook = createAutoMemoryHook({
      memoryDir,
      llm,
      enabled: true,
      now: () => NOW_ISO,
      nowMs: Date.parse(NOW_ISO),
    });
    const turn = (n: number) => {
      hook.onTurnComplete({
        stopReason: "completed",
        transcript: `user: turn ${n}`,
      });
    };
    for (let n = 1; n < DEFAULT_COMPLETED_TURN_GATE; n++) {
      turn(n);
      await hook.drain();
      assert.equal(
        llm.calls(),
        0,
        `turn ${n} is below the default gate of ${DEFAULT_COMPLETED_TURN_GATE}`
      );
      assert.equal(await entryCount(), 0);
    }
    turn(DEFAULT_COMPLETED_TURN_GATE);
    await hook.drain();
    assert.equal(llm.calls(), 1, "the gated turn extracts");
    assert.equal(await entryCount(), 1);
  });

  it("skips extract when the gated turn already saved memory", async () => {
    const llm = countingLlm(FACT);
    const hook = createAutoMemoryHook({
      memoryDir,
      llm,
      enabled: true,
      now: () => NOW_ISO,
      nowMs: Date.parse(NOW_ISO),
    });
    for (let n = 1; n < DEFAULT_COMPLETED_TURN_GATE; n++) {
      hook.onTurnComplete({
        stopReason: "completed",
        transcript: `user: turn ${n}`,
      });
    }
    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "user: gated turn",
      memorySaveSucceeded: true,
    });
    await hook.drain();
    assert.equal(llm.calls(), 0, "successful memory_save skips extract");
  });

  it("still extracts on the gated turn when memory_save did not succeed", async () => {
    const llm = countingLlm(FACT);
    const hook = createAutoMemoryHook({
      memoryDir,
      llm,
      enabled: true,
      now: () => NOW_ISO,
      nowMs: Date.parse(NOW_ISO),
    });
    for (let n = 1; n < DEFAULT_COMPLETED_TURN_GATE; n++) {
      hook.onTurnComplete({
        stopReason: "completed",
        transcript: `user: turn ${n}`,
      });
    }
    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "user: gated turn",
      memorySaveSucceeded: false,
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
    // autoExtract implies dream: the dream-gate persist fault is reported
    // alongside the extract fault — two swallowed errors, still no throw.
    assert.equal(seen.length, 2, "the IO failures are reported, not thrown");
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

const DAY_MS = 24 * 60 * 60 * 1000;

const seedDreamGate = async (
  dir: string,
  nowMs: number,
  sessionIds: readonly string[] = ["s1", "s2", "s3", "s4"]
): Promise<void> => {
  await writeFile(
    join(dir, DREAM_CURSOR_FILENAME),
    JSON.stringify({
      lastSuccessAtMs: nowMs - DAY_MS,
      sessionIds,
    }),
    "utf8"
  );
};

const twoLiveEntries = async (): Promise<void> => {
  const a: MemoryEntryV1 = {
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
  const b: MemoryEntryV1 = {
    ...a,
    id: "sib",
    title: "Use bar() for parallel work",
  };
  await writeFile(join(memoryDir, "old.md"), serializeMemoryEntry(a), "utf8");
  await writeFile(join(memoryDir, "sib.md"), serializeMemoryEntry(b), "utf8");
};

describe("createAutoMemoryHook — dream pass", () => {
  it("does not run dream on the extract gate alone", async () => {
    await twoLiveEntries();
    const llm = countingLlm("[]");
    const hook = createAutoMemoryHook({
      memoryDir,
      llm,
      enabled: false,
      dream: true,
      now: () => NOW_ISO,
      nowMs: Date.parse(NOW_ISO),
    });

    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "user: one",
      sessionKey: "sess-a",
    });
    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "user: two",
      sessionKey: "sess-b",
    });
    await hook.drain();

    assert.equal(llm.calls(), 0, "two completed turns are not the dream gate");
  });

  it("does not run dream when 24h has not elapsed even with five sessions", async () => {
    await twoLiveEntries();
    const nowMs = Date.parse(NOW_ISO);
    await writeFile(
      join(memoryDir, DREAM_CURSOR_FILENAME),
      JSON.stringify({
        lastSuccessAtMs: nowMs - DAY_MS + 1,
        sessionIds: ["s1", "s2", "s3", "s4"],
      }),
      "utf8"
    );
    const llm = countingLlm("[]");
    const hook = createAutoMemoryHook({
      memoryDir,
      llm,
      enabled: false,
      dream: true,
      minCompletedTurns: 1,
      now: () => NOW_ISO,
      nowMs,
    });

    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "",
      sessionKey: "s5",
    });
    await hook.drain();

    assert.equal(llm.calls(), 0);
  });

  it("does not run dream when fewer than five distinct sessions have completed", async () => {
    await twoLiveEntries();
    const nowMs = Date.parse(NOW_ISO);
    await seedDreamGate(memoryDir, nowMs, ["s1", "s2", "s3"]);
    const llm = countingLlm("[]");
    const hook = createAutoMemoryHook({
      memoryDir,
      llm,
      enabled: false,
      dream: true,
      now: () => NOW_ISO,
      nowMs,
    });

    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "user: a",
      sessionKey: "s4",
    });
    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "user: b",
      sessionKey: "s4",
    });
    await hook.drain();

    assert.equal(
      llm.calls(),
      0,
      "the same sessionKey must not count as a second session"
    );
  });

  it("runs dream after 24h and five distinct sessions, including blank transcripts", async () => {
    await twoLiveEntries();
    const nowMs = Date.parse(NOW_ISO);
    await seedDreamGate(memoryDir, nowMs);
    const llm = countingLlm("[]");
    const hook = createAutoMemoryHook({
      memoryDir,
      llm,
      enabled: false,
      dream: true,
      now: () => NOW_ISO,
      nowMs,
    });

    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "   ",
      sessionKey: "s5",
    });
    await hook.drain();

    assert.equal(llm.calls(), 1, "dream does not require a transcript");
  });

  it("runs dream when autoExtract is on and dream is explicitly off, dual gate met", async () => {
    // Spec specs/auto-memory-layering.md Assumptions 2-3: autoExtract implies
    // dream — there is no "extract without dream" escape hatch.
    await twoLiveEntries();
    const nowMs = Date.parse(NOW_ISO);
    await seedDreamGate(memoryDir, nowMs);
    const responses = [
      FACT,
      JSON.stringify([
        {
          title: "Use bar() for concurrency",
          body: "Concurrency now routes through the scheduler queue.",
          confidence: 0.95,
          replaces: ["old"],
        },
      ]),
    ];
    let calls = 0;
    const hook = createAutoMemoryHook(
      hookOpts(
        {
          complete: async () => responses[calls++] ?? "[]",
        },
        { dream: false, minCompletedTurns: 1, nowMs }
      )
    );

    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "user: hi",
      sessionKey: "s5",
    });
    await hook.drain();

    assert.equal(
      calls,
      2,
      "autoExtract implies dream: extract call then dream call"
    );
    assert.equal(
      parseMemoryEntry(await readFile(join(memoryDir, "old.md"), "utf8"))
        .disabled,
      true,
      "the second call was the dream merge (superseded old.md)"
    );
    const cursor = JSON.parse(
      await readFile(join(memoryDir, DREAM_CURSOR_FILENAME), "utf8")
    );
    assert.equal(
      cursor.lastSuccessAtMs,
      nowMs,
      "dream ran and reset the gate clock"
    );
  });

  it("runs extract without a merge call when dream is on but the dual gate is unmet", async () => {
    await twoLiveEntries();
    const llm = countingLlm(FACT);
    const hook = createAutoMemoryHook(
      hookOpts(llm, { dream: true, minCompletedTurns: 1 })
    );

    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "user: hi",
      sessionKey: "only-one",
    });
    await hook.drain();

    assert.equal(llm.calls(), 1, "extract still fires; dream gate is unmet");
  });

  it("still runs dream when extract is skipped after a successful save", async () => {
    await twoLiveEntries();
    const nowMs = Date.parse(NOW_ISO);
    await seedDreamGate(memoryDir, nowMs);
    const llm = countingLlm("[]");
    const hook = createAutoMemoryHook(hookOpts(llm, { dream: true, nowMs }));

    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "user: hi",
      sessionKey: "s5",
      memorySaveSucceeded: true,
    });
    await hook.drain();

    assert.equal(llm.calls(), 1, "dream still runs when extract is skipped");
  });

  it("runs extract, dream, then one mechanical GC pass when both are on and the dual gate is met", async () => {
    await twoLiveEntries();
    const nowMs = Date.parse(NOW_ISO);
    await seedDreamGate(memoryDir, nowMs);
    const responses = [
      FACT,
      JSON.stringify([
        {
          title: "Use bar() for concurrency",
          body: "Concurrency now routes through the scheduler queue; direct calls were removed in v3.",
          confidence: 0.95,
          replaces: ["old"],
        },
      ]),
    ];
    let calls = 0;
    const hook = createAutoMemoryHook(
      hookOpts(
        {
          complete: async () => responses[calls++] ?? "[]",
        },
        { dream: true, nowMs }
      )
    );

    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "user: hi",
      sessionKey: "s5",
    });
    await hook.drain();

    assert.equal(calls, 2, "one extract call followed by one dream call");
    const files = await readdir(memoryDir);
    assert.ok(
      files.includes(DREAM_CURSOR_FILENAME),
      "gate state must persist to dream.json"
    );
    assert.ok(
      !files.includes("dream-cursor.json"),
      "legacy dream-cursor.json must never be created"
    );
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
    await writeFile(
      join(memoryDir, "live.md"),
      serializeMemoryEntry({
        ...stale,
        id: "live",
        ttl_days: 0,
        updated_at: NOW_ISO,
        title: "Live fact",
        body: "This fact is still current.",
      }),
      "utf8"
    );
    const nowMs = Date.parse(NOW_ISO);
    await seedDreamGate(memoryDir, nowMs);
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
      nowMs,
    });

    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "",
      sessionKey: "s5",
    });
    await hook.drain();

    assert.equal(
      parseMemoryEntry(await readFile(join(memoryDir, "stale.md"), "utf8"))
        .disabled,
      true,
      "TTL GC must still run after a dream failure"
    );
  });

  it("advances the time gate when a met dual gate skips because live entries < 2", async () => {
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
    const nowMs = Date.parse(NOW_ISO);
    await seedDreamGate(memoryDir, nowMs);
    const llm = countingLlm("[]");
    const hook = createAutoMemoryHook({
      memoryDir,
      llm,
      enabled: false,
      dream: true,
      now: () => NOW_ISO,
      nowMs,
    });

    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "",
      sessionKey: "s5",
    });
    await hook.drain();
    assert.equal(llm.calls(), 0, "skip must not spend a dream LLM call");

    await twoLiveEntries();
    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "",
      sessionKey: "s6",
    });
    await hook.drain();
    assert.equal(
      llm.calls(),
      0,
      "a skip advances lastSuccessAtMs so the next turn cannot immediately re-fire"
    );
  });

  it("keeps dream cursors isolated across memoryDir roots", async () => {
    const otherDir = await mkdtemp(join(tmpdir(), "memory-auto-hook-b-"));
    try {
      const nowMs = Date.parse(NOW_ISO);
      await seedDreamGate(memoryDir, nowMs);
      await writeFile(
        join(otherDir, DREAM_CURSOR_FILENAME),
        JSON.stringify({
          lastSuccessAtMs: nowMs,
          sessionIds: ["s1", "s2", "s3", "s4"],
        }),
        "utf8"
      );
      const writePair = async (dir: string): Promise<void> => {
        const a: MemoryEntryV1 = {
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
        await writeFile(join(dir, "old.md"), serializeMemoryEntry(a), "utf8");
        await writeFile(
          join(dir, "sib.md"),
          serializeMemoryEntry({
            ...a,
            id: "sib",
            title: "Use bar() elsewhere",
          }),
          "utf8"
        );
      };
      await writePair(memoryDir);
      await writePair(otherDir);

      const llmA = countingLlm("[]");
      const llmB = countingLlm("[]");
      const hookA = createAutoMemoryHook({
        memoryDir,
        llm: llmA,
        enabled: false,
        dream: true,
        now: () => NOW_ISO,
        nowMs,
      });
      const hookB = createAutoMemoryHook({
        memoryDir: otherDir,
        llm: llmB,
        enabled: false,
        dream: true,
        now: () => NOW_ISO,
        nowMs,
      });

      hookA.onTurnComplete({
        stopReason: "completed",
        transcript: "",
        sessionKey: "s5",
      });
      hookB.onTurnComplete({
        stopReason: "completed",
        transcript: "",
        sessionKey: "s5",
      });
      await hookA.drain();
      await hookB.drain();

      assert.equal(llmA.calls(), 1, "root A dual gate is met");
      assert.equal(llmB.calls(), 0, "root B still inside 24h");
    } finally {
      await rm(otherDir, { recursive: true, force: true });
    }
  });

  it("does not overwrite a corrupt dream cursor with an empty window", async () => {
    await twoLiveEntries();
    const corrupt = "{not-json";
    await writeFile(join(memoryDir, DREAM_CURSOR_FILENAME), corrupt, "utf8");
    const seen: unknown[] = [];
    const llm = countingLlm("[]");
    const hook = createAutoMemoryHook({
      memoryDir,
      llm,
      enabled: false,
      dream: true,
      minCompletedTurns: 1,
      now: () => NOW_ISO,
      nowMs: Date.parse(NOW_ISO),
      onError: (error) => seen.push(error),
    });

    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "",
      sessionKey: "s5",
    });
    await hook.drain();

    assert.equal(llm.calls(), 0);
    assert.equal(seen.length, 1);
    assert.equal(
      await readFile(join(memoryDir, DREAM_CURSOR_FILENAME), "utf8"),
      corrupt
    );
  });
});

// -- mechanical-only segment (ADR-0031 D5 amendment 2026-09-11) --------------
//
// autoExtract and dream both off still reach `memory_gc` + capability sweep
// on the same completed-turn gate, with zero LLM calls. This is what makes the
// on-disk soft-disable happen for a user who never opted into extraction —
// without the mechanical segment, old capability rows survive on disk forever
// because no LLM pass ever comes due.

const CAPABILITY_ENTRY: MemoryEntryV1 = {
  id: "cap",
  type: "note",
  importance: 5,
  ttl_days: 0,
  disabled: false,
  supersedes: null,
  title: "web_search is unavailable in this sandbox",
  body: "The sandbox DNS/SSRF benchmarking segment blocks outbound network access.",
  updated_at: NOW_ISO,
};

const policyEntry = (): MemoryEntryV1 => ({
  id: "policy",
  type: "constraint",
  importance: 1,
  ttl_days: 0,
  disabled: false,
  supersedes: null,
  title: "Worktree policy",
  body: "隔离 ON 时 mutate 须先建 worktree。",
  updated_at: NOW_ISO,
});

describe("createAutoMemoryHook — mechanical-only segment while ON", () => {
  it("sweeps capability rows on the gated turn with zero LLM calls", async () => {
    const llm = countingLlm(FACT);
    await writeFile(
      join(memoryDir, "cap.md"),
      serializeMemoryEntry(CAPABILITY_ENTRY),
      "utf8"
    );
    await writeFile(
      join(memoryDir, "policy.md"),
      serializeMemoryEntry(policyEntry()),
      "utf8"
    );
    const hook = createAutoMemoryHook({
      memoryDir,
      llm,
      enabled: false,
      dream: true,
      now: () => NOW_ISO,
      nowMs: Date.parse(NOW_ISO),
    });

    for (let n = 1; n < DEFAULT_COMPLETED_TURN_GATE; n++) {
      hook.onTurnComplete({
        stopReason: "completed",
        transcript: `user: turn ${n}`,
      });
    }
    await hook.drain();
    assert.equal(llm.calls(), 0, "below the gate: nothing runs at all");
    assert.equal(
      parseMemoryEntry(await readFile(join(memoryDir, "cap.md"), "utf8"))
        .disabled,
      false,
      "below the gate nothing is written"
    );

    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "user: gated turn",
    });
    await hook.drain();
    assert.equal(llm.calls(), 0, "mechanical segment is zero-LLM");
    assert.equal(
      parseMemoryEntry(await readFile(join(memoryDir, "cap.md"), "utf8"))
        .disabled,
      true,
      "the gated turn sweeps the capability row"
    );
    assert.equal(
      parseMemoryEntry(await readFile(join(memoryDir, "policy.md"), "utf8"))
        .disabled,
      false,
      "product-policy constraint stays live"
    );
  });

  it("reads live flags so a TUI flip to dual-off stops the mechanical segment", async () => {
    // ADR-0031 amendment 2026-10-07: dual-off is total memory OFF, so the
    // hook stays wired (hook presence is `autoExtract || dream`) but runs
    // nothing — no mechanical pass, no sweep, no LLM call.
    const llm = countingLlm(FACT);
    await writeFile(
      join(memoryDir, "cap.md"),
      serializeMemoryEntry(CAPABILITY_ENTRY),
      "utf8"
    );
    const flags = { autoExtract: true, dream: true };
    const hook = createAutoMemoryHook({
      memoryDir,
      llm,
      enabled: true,
      minCompletedTurns: 1,
      flags,
      now: () => NOW_ISO,
      nowMs: Date.parse(NOW_ISO),
    });
    // Flip to dual-off before the turn.
    flags.autoExtract = false;
    flags.dream = false;
    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "user: hi",
    });
    await hook.drain();
    assert.equal(llm.calls(), 0, "dual-off spends no LLM call");
    assert.equal(
      parseMemoryEntry(await readFile(join(memoryDir, "cap.md"), "utf8"))
        .disabled,
      false,
      "total memory OFF runs no mechanical pass either"
    );
  });

  // SC2 empty: a due mechanical pass on an empty store is a zero-LLM no-op
  // that creates no entry and is idempotent. `dream: true` keeps the memory
  // capability ON (dual-off is total OFF as of ADR-0031 amendment
  // 2026-10-07) with the extract arm off; the dream gate is not met, so the
  // turn runs exactly one mechanical pass and only the dream cursor — which
  // that gate is entitled to write — may appear.
  it("is an idempotent no-op on an empty store", async () => {
    const llm = countingLlm(FACT);
    const hook = createAutoMemoryHook({
      memoryDir,
      llm,
      enabled: false,
      dream: true,
      minCompletedTurns: 1,
      now: () => NOW_ISO,
      nowMs: Date.parse(NOW_ISO),
    });
    const entryFiles = async (): Promise<string[]> =>
      (await readdir(memoryDir)).filter((name) => name !== DREAM_CURSOR_FILENAME);
    hook.onTurnComplete({ stopReason: "completed", transcript: "user: hi" });
    await hook.drain();
    assert.equal(llm.calls(), 0);
    assert.deepEqual(await entryFiles(), [], "zero entry files");
    hook.onTurnComplete({ stopReason: "completed", transcript: "user: hi" });
    await hook.drain();
    assert.equal(llm.calls(), 0);
    assert.deepEqual(
      await entryFiles(),
      [],
      "still zero entry files"
    );
  });

  // SC5 exception: a write-path fault (archive target is a regular file)
  // surfaces as the typed MemoryIOError and is reported through onError; the
  // callback itself never throws and the turn still completes.
  it("reports a typed IO fault from the mechanical pass without throwing", async () => {
    await writeFile(
      join(memoryDir, "cap.md"),
      serializeMemoryEntry({
        ...CAPABILITY_ENTRY,
        updated_at: "2026-06-01T00:00:00.000Z",
      }),
      "utf8"
    );
    await writeFile(join(memoryDir, "archive"), "not a dir", "utf8");
    const seen: unknown[] = [];
    const hook = createAutoMemoryHook({
      memoryDir,
      llm: countingLlm(FACT),
      enabled: false,
      dream: true,
      minCompletedTurns: 1,
      now: () => NOW_ISO,
      nowMs: Date.parse(NOW_ISO),
      onError: (error) => seen.push(error),
    });
    assert.doesNotThrow(() => {
      hook.onTurnComplete({ stopReason: "completed", transcript: "user: hi" });
    });
    await hook.drain();
    assert.equal(seen.length, 1, "the typed fault is reported, not thrown");
    assert.ok(
      seen[0] instanceof MemoryIOError,
      "the report carries the typed error"
    );
  });

  // The existing GC posture is kept: a missing / unreadable directory reads as
  // an empty store, so an unusable memoryDir is a silent no-op rather than a
  // crash on every turn.
  it("treats an unusable memoryDir as an empty store", async () => {
    const blocker = join(memoryDir, "blocker");
    await writeFile(blocker, "not a directory", "utf8");
    const seen: unknown[] = [];
    const hook = createAutoMemoryHook({
      memoryDir: join(blocker, "memory"),
      llm: countingLlm(FACT),
      enabled: false,
      dream: true,
      minCompletedTurns: 1,
      nowMs: Date.parse(NOW_ISO),
      onError: (error) => seen.push(error),
    });
    // Driven through the exit seam: it runs the mechanical pass alone, so the
    // unreadable dir exercises GC's empty-store reading rather than the dream
    // cursor's own (separately typed) failure path.
    assert.doesNotThrow(() => {
      void hook.onExit?.();
    });
    await hook.onExit?.();
    assert.deepEqual(seen, []);
  });

  it("does not run the mechanical segment on a non-completed turn", async () => {
    await writeFile(
      join(memoryDir, "cap.md"),
      serializeMemoryEntry(CAPABILITY_ENTRY),
      "utf8"
    );
    const hook = createAutoMemoryHook({
      memoryDir,
      llm: countingLlm(FACT),
      enabled: false,
      dream: true,
      minCompletedTurns: 1,
      now: () => NOW_ISO,
      nowMs: Date.parse(NOW_ISO),
    });
    hook.onTurnComplete({ stopReason: "cancelled", transcript: "user: hi" });
    hook.onTurnComplete({ stopReason: "timeout", transcript: "user: hi" });
    await hook.drain();
    assert.equal(
      parseMemoryEntry(await readFile(join(memoryDir, "cap.md"), "utf8"))
        .disabled,
      false,
      "cancel / timeout do not count toward the gate"
    );
  });
});

// -- extract-enabled gated turn still sweeps (ADR-0086 / spec SC7) -----------
//
// Assumption 6: every gate-due completed turn runs exactly one mechanical
// GC+sweep, and an extract pass is no exception — its persist path writes
// nothing when the model yields no usable fact, so the sweep cannot be
// conditional on extract having written.
//
// Exactly one: on a turn whose dual dream gate is met, the dream pass's own
// GC is that turn's mechanical pass (asserted by the extract/dream call pair
// plus the surviving live entries) — a second mechanical GC would double it.

const llmReturning = (raw: string): MemoryExtractLlm => ({
  complete: async () => raw,
});

describe("createAutoMemoryHook — extract-enabled gated turn sweeps", () => {
  it("sweeps the pre-existing capability row when extract yields no candidate", async () => {
    await writeFile(
      join(memoryDir, "cap.md"),
      serializeMemoryEntry(CAPABILITY_ENTRY),
      "utf8"
    );
    const hook = createAutoMemoryHook(
      hookOpts(llmReturning("[]"), { minCompletedTurns: 1 })
    );
    hook.onTurnComplete({ stopReason: "completed", transcript: "user: hi" });
    await hook.drain();
    assert.equal(
      parseMemoryEntry(await readFile(join(memoryDir, "cap.md"), "utf8"))
        .disabled,
      true,
      "an extract that writes nothing must still leave the sweep running"
    );
  });

  it("sweeps the pre-existing capability row when extract yields only a capability candidate", async () => {
    const capabilityOnly = JSON.stringify([
      {
        title: "web_search is unavailable in this sandbox",
        body: "The sandbox DNS/SSRF segment blocks web_search.",
        confidence: 0.95,
      },
    ]);
    await writeFile(
      join(memoryDir, "cap.md"),
      serializeMemoryEntry(CAPABILITY_ENTRY),
      "utf8"
    );
    const hook = createAutoMemoryHook(
      hookOpts(llmReturning(capabilityOnly), { minCompletedTurns: 1 })
    );
    hook.onTurnComplete({ stopReason: "completed", transcript: "user: hi" });
    await hook.drain();
    assert.equal(
      parseMemoryEntry(await readFile(join(memoryDir, "cap.md"), "utf8"))
        .disabled,
      true,
      "a dropped candidate still counts as a gate-due extract turn"
    );
  });

  it("sweeps when extract writes a real entry and leaves no GC temp file", async () => {
    await writeFile(
      join(memoryDir, "cap.md"),
      serializeMemoryEntry(CAPABILITY_ENTRY),
      "utf8"
    );
    const hook = createAutoMemoryHook(
      hookOpts(countingLlm(FACT), { minCompletedTurns: 1 })
    );
    hook.onTurnComplete({ stopReason: "completed", transcript: "user: hi" });
    await hook.drain();
    assert.equal(
      parseMemoryEntry(await readFile(join(memoryDir, "cap.md"), "utf8"))
        .disabled,
      true,
      "a real extract write must not skip the sweep"
    );
    assert.deepEqual(
      (await readdir(memoryDir)).filter((n) => n.includes(".gc.tmp")),
      [],
      "no half-written GC temp file may remain"
    );
  });

  it("sweeps the capability row on a dream-due turn via dream's own GC", async () => {
    // The other gate-due shape: the dual dream gate is met, so the dream
    // pass's GC is this turn's mechanical pass — and it must carry the
    // capability sweep with it (the dream path is not an escape hatch).
    await twoLiveEntries();
    await writeFile(
      join(memoryDir, "cap.md"),
      serializeMemoryEntry(CAPABILITY_ENTRY),
      "utf8"
    );
    const nowMs = Date.parse(NOW_ISO);
    await seedDreamGate(memoryDir, nowMs);
    const responses = [FACT, "[]"];
    let calls = 0;
    const hook = createAutoMemoryHook(
      hookOpts(
        {
          complete: async () => responses[calls++] ?? "[]",
        },
        { dream: true, minCompletedTurns: 1, nowMs }
      )
    );
    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "user: hi",
      sessionKey: "s5",
    });
    await hook.drain();
    assert.equal(calls, 2, "one extract call followed by one dream call");
    assert.equal(
      parseMemoryEntry(await readFile(join(memoryDir, "cap.md"), "utf8"))
        .disabled,
      true,
      "dream's GC is the turn's sweep"
    );
    assert.equal(
      parseMemoryEntry(await readFile(join(memoryDir, "old.md"), "utf8"))
        .disabled,
      false,
      "an unrelated live entry survives the same pass"
    );
  });
});

// -- process-exit mechanical pass (ADR-0086 / spec Assumptions 8) ------------
//
// The exit path is best-effort and never the only gate. It must run one
// zero-LLM `memory_gc` + capability sweep, never throw, and never leave an
// unhandled rejection behind — a process exiting because of a fault in its
// exit hook would be the worst possible failure mode.

describe("createAutoMemoryHook — process-exit mechanical pass", () => {
  it("sweeps capability rows on exit with zero LLM calls", async () => {
    const llm = countingLlm(FACT);
    await writeFile(
      join(memoryDir, "cap.md"),
      serializeMemoryEntry(CAPABILITY_ENTRY),
      "utf8"
    );
    const hook = createAutoMemoryHook({
      memoryDir,
      llm,
      enabled: false,
      dream: true,
      minCompletedTurns: 1,
      now: () => NOW_ISO,
      nowMs: Date.parse(NOW_ISO),
    });
    assert.ok(hook.onExit, "the exit seam is present on every hook");
    await hook.onExit!();
    assert.equal(llm.calls(), 0, "exit pass is mechanical-only");
    assert.equal(
      parseMemoryEntry(await readFile(join(memoryDir, "cap.md"), "utf8"))
        .disabled,
      true,
      "exit sweeps even when the gate never came due"
    );
  });

  it("is idempotent across repeated exits and below-gate turns", async () => {
    await writeFile(
      join(memoryDir, "cap.md"),
      serializeMemoryEntry(CAPABILITY_ENTRY),
      "utf8"
    );
    const hook = createAutoMemoryHook({
      memoryDir,
      llm: countingLlm(FACT),
      enabled: false,
      dream: true,
      nowMs: Date.parse(NOW_ISO),
    });
    // A sub-gate turn and an exit sweep both run; the second exit is a no-op.
    hook.onTurnComplete({ stopReason: "completed", transcript: "user: hi" });
    await hook.onExit!();
    await hook.onExit!();
    assert.equal(
      parseMemoryEntry(await readFile(join(memoryDir, "cap.md"), "utf8"))
        .disabled,
      true
    );
    // No entry files appeared: only the swept row and the usage sidecar the
    // GC pass is entitled to touch (promote.ts owns its shape).
    assert.deepEqual(
      (await readdir(memoryDir)).filter((n) => n.endsWith(".md")),
      ["cap.md"]
    );
  });

  it("reports a typed IO fault without throwing out of the exit callback", async () => {
    await writeFile(
      join(memoryDir, "cap.md"),
      serializeMemoryEntry({
        ...CAPABILITY_ENTRY,
        updated_at: "2026-06-01T00:00:00.000Z",
      }),
      "utf8"
    );
    await writeFile(join(memoryDir, "archive"), "not a dir", "utf8");
    const seen: unknown[] = [];
    const hook = createAutoMemoryHook({
      memoryDir,
      llm: countingLlm(FACT),
      enabled: false,
      dream: true,
      nowMs: Date.parse(NOW_ISO),
      onError: (error) => seen.push(error),
    });
    // The contract is explicit: never throw from the exit callback.
    await assert.doesNotReject(() => hook.onExit!());
    assert.equal(seen.length, 1);
    assert.ok(seen[0] instanceof MemoryIOError);
  });

  it("resolves and reports when the exit's mechanical pass genuinely faults", async () => {
    // The exit pass faults for real: GC plans an archive move (a disabled row
    // old enough to leave the hot dir) and `archive` is a regular file, so
    // `runMemoryGc` throws MemoryIOError. The reachable contract is that
    // `onExit` never rejects, the typed fault reaches onError, and the
    // soft-disable the pass wrote before the failing step survives.
    await writeFile(
      join(memoryDir, "cap.md"),
      serializeMemoryEntry({
        ...CAPABILITY_ENTRY,
        updated_at: "2026-06-01T00:00:00.000Z",
      }),
      "utf8"
    );
    await writeFile(join(memoryDir, "archive"), "not a dir", "utf8");
    const seen: unknown[] = [];
    const hook = createAutoMemoryHook({
      memoryDir,
      llm: countingLlm(FACT),
      enabled: false,
      dream: true,
      nowMs: Date.parse(NOW_ISO),
      onError: (error) => seen.push(error),
    });
    await assert.doesNotReject(() => hook.onExit!());
    assert.equal(seen.length, 1, "the typed fault is reported, not thrown");
    assert.ok(
      seen[0] instanceof MemoryIOError,
      "the report carries the typed identity of the failure"
    );
    assert.equal(
      parseMemoryEntry(await readFile(join(memoryDir, "cap.md"), "utf8"))
        .disabled,
      true,
      "the soft-disable written before the archive fault stays applied"
    );
  });

  it("counts an exit pass as mechanical work, not as a completed turn", async () => {
    // SC9: the exit sweep must not reset or advance the completed counter —
    // the gate keeps its own authority and stays the primary trigger.
    const llm = countingLlm(FACT);
    const hook = createAutoMemoryHook({
      memoryDir,
      llm,
      enabled: true,
      now: () => NOW_ISO,
      nowMs: Date.parse(NOW_ISO),
    });
    for (let n = 1; n < DEFAULT_COMPLETED_TURN_GATE; n++) {
      hook.onTurnComplete({
        stopReason: "completed",
        transcript: `user: turn ${n}`,
      });
    }
    await hook.onExit!();
    assert.equal(llm.calls(), 0, "exit is zero-LLM");
    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "user: gated turn",
    });
    await hook.drain();
    assert.equal(
      llm.calls(),
      1,
      "the gate still comes due on the third completed turn"
    );
  });
});
