/**
 * Total memory OFF — the TUI `/memory` **Automatic memory** switch as the
 * complete memory-capability gate.
 *
 * Contract source: ADR-0031, ADR-0033 and ADR-0042, each carrying a
 * `> **Amendment 2026-10-07** (total memory OFF)` blockquote. Dual-off
 * (`autoExtract === false && dream === false`) is the state the TUI OFF
 * transition persists, so it is the total-OFF state: no memory tool schemas,
 * no catalog, no existence pointer, no prefetch, no background job, and an
 * execution-time refusal of a stale `memory_recall` / `memory_save` call.
 *
 * Assertions read the assembled request (`deps.promptTools`, `deps.system`,
 * `overlayMemoryPrefetch`) and the registered tool handler — never an internal
 * flag.
 */
import { afterAll, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildHarnessEngine,
  type BuiltEngine,
} from "../../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../../src/harness/permission/ask-user.ts";
import { createMemoryRecallTool } from "../../../src/harness/memory/tools/recall.ts";
import { createMemorySaveTool } from "../../../src/harness/memory/tools/save.ts";
import {
  DEFAULT_COMPLETED_TURN_GATE,
  EXISTENCE_POINTER,
  MEMORY_CATALOG_DISCIPLINE,
  resolveProjectMemoryDir,
  serializeMemoryEntry,
} from "../../../src/harness/memory/index.ts";
import type { MemoryEntryV1 } from "../../../src/harness/memory/index.ts";
import type { IknowEnv } from "../../../src/config/env.ts";

const built: BuiltEngine[] = [];
const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(built.map((b) => b.shutdown?.()));
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

function makeEnv(): IknowEnv {
  return {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      fallback: [],
      apiKey: "sk-test-memory-capability-off",
      maxOutputTokens: 1024,
      timeoutMs: 60_000,
      temperature: 0,
      thinking: "off",
      thinkingEffort: "",
      stream: "on",
    },
    chat: { showThinking: false },
    web: { searchUrl: undefined, proxy: undefined },
    compress: { contextWindow: 200_000, thresholdTokens: undefined },
    mcp: { connectTimeoutMs: 60_000 },
    subagent: { taskTimeoutMs: undefined },
    workspaceRoot: undefined,
    productRoot: undefined,
  };
}

async function isolate(): Promise<{
  cwd: string;
  userHome: string;
  memoryDir: string;
}> {
  const cwd = await mkdtemp(join(tmpdir(), "capability-off-cwd-"));
  const userHome = await mkdtemp(join(tmpdir(), "capability-off-home-"));
  dirs.push(cwd, userHome);
  return {
    cwd,
    userHome,
    memoryDir: resolveProjectMemoryDir({
      dataDir: join(userHome, ".iknow"),
      projectIdentityRoot: cwd,
    }),
  };
}

async function buildIn(
  cwd: string,
  userHome: string,
  opts: Record<string, unknown> = {}
): Promise<BuiltEngine> {
  const engine = await buildHarnessEngine({
    env: makeEnv(),
    askUser: createNoAskUser(),
    cwd,
    userHome,
    workspaceRoot: cwd,
    sandboxRoot: cwd,
    // Assembly-time tool-overflow demotion has its own suite; this file pins
    // the memory-capability surface only.
    skipCountTokens: true,
    ...opts,
  });
  built.push(engine);
  return engine;
}

const note = (overrides?: Partial<MemoryEntryV1>): MemoryEntryV1 => ({
  id: "mem-capability-off",
  type: "note",
  importance: 1,
  ttl_days: 0,
  disabled: false,
  supersedes: null,
  title: "Rendering goes through bar()",
  body: "Calling bar() is the supported rendering path in this project.",
  updated_at: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

/** A capability observation row: the ADR-0086 sweep's target. */
const capabilityRow = (): MemoryEntryV1 =>
  note({
    id: "mem-capability-observation",
    title: "Runtime capability observation",
    body: "node is available at /usr/bin/node",
  });

async function writeStore(
  memoryDir: string,
  slug: string,
  entry: MemoryEntryV1
): Promise<void> {
  await mkdir(memoryDir, { recursive: true });
  await writeFile(
    join(memoryDir, `${slug}.md`),
    serializeMemoryEntry(entry),
    "utf8"
  );
}

function promptToolNames(engine: BuiltEngine): string[] {
  return (engine.deps.promptTools?.() ?? []).map((tool) => tool.name);
}

async function systemText(engine: BuiltEngine): Promise<string> {
  return (await engine.deps.system?.()) ?? "";
}

function handlerOf(
  engine: BuiltEngine,
  name: string
): (input: unknown) => Promise<unknown> {
  const tool = engine.deps.registry.list().find((t) => t.name === name);
  if (tool === undefined) throw new Error(`tool not registered: ${name}`);
  return tool.handler;
}

/** The one toggle transition a host performs on `/memory` Esc. */
function toggleOff(engine: BuiltEngine): void {
  engine.memoryFlags!.autoExtract = false;
  engine.memoryFlags!.dream = false;
  engine.invalidateMemorySystem?.();
}

function toggleOn(engine: BuiltEngine): void {
  engine.memoryFlags!.autoExtract = true;
  engine.memoryFlags!.dream = false;
  engine.invalidateMemorySystem?.();
}

describe("A — OFF removes every memory input from the assembled request", () => {
  it("drops memory tool schemas, existence pointer, catalog and prefetch on the next request", async () => {
    const { cwd, userHome, memoryDir } = await isolate();
    await writeStore(memoryDir, "rendering", note());

    const engine = await buildIn(cwd, userHome, {
      surface: "tui",
      settings: { memory: { autoExtract: true } },
    });

    // ON: the memory surface is present and observable.
    expect(promptToolNames(engine)).toContain("memory_recall");
    expect(promptToolNames(engine)).toContain("memory_save");
    const on = await systemText(engine);
    expect(on).toContain(EXISTENCE_POINTER);
    expect(on).toContain(MEMORY_CATALOG_DISCIPLINE);
    expect(await engine.overlayMemoryPrefetch!("bar() rendering")).not.toBe("");

    toggleOff(engine);

    expect(promptToolNames(engine)).not.toContain("memory_recall");
    expect(promptToolNames(engine)).not.toContain("memory_save");
    const off = await systemText(engine);
    expect(off).not.toContain(EXISTENCE_POINTER);
    expect(off).not.toContain(MEMORY_CATALOG_DISCIPLINE);
    expect(await engine.overlayMemoryPrefetch!("bar() rendering")).toBe("");
  });

  it("removes the memory index but keeps the project's instruction layer", async () => {
    const { cwd, userHome, memoryDir } = await isolate();
    await writeStore(memoryDir, "rendering", note());
    const rulesDir = join(cwd, ".iknow", "rules");
    await mkdir(rulesDir, { recursive: true });
    await writeFile(join(rulesDir, "alpha.md"), "ALPHA RULE BODY", "utf8");

    const engine = await buildIn(cwd, userHome, {
      surface: "tui",
      settings: { memory: { autoExtract: true } },
    });
    const on = await systemText(engine);
    expect(on).toContain(join(rulesDir, "alpha.md"));

    toggleOff(engine);

    // AGENTS.md / the rules index are project instruction, not memory state:
    // total OFF removes the memory index only.
    const off = await systemText(engine);
    expect(off).toContain(join(rulesDir, "alpha.md"));
    expect(off).toContain("iknow Identity");
    expect(off).not.toContain(EXISTENCE_POINTER);
    expect(off).not.toContain(MEMORY_CATALOG_DISCIPLINE);
  });

  it("is OFF at assembly time for a host surface reading dual-off settings", async () => {
    const { cwd, userHome, memoryDir } = await isolate();
    await writeStore(memoryDir, "rendering", note());

    const engine = await buildIn(cwd, userHome, {
      surface: "serve",
      settings: { memory: { autoExtract: false, dream: false } },
    });

    expect(promptToolNames(engine)).not.toContain("memory_recall");
    expect(promptToolNames(engine)).not.toContain("memory_save");
    const off = await systemText(engine);
    expect(off).not.toContain(EXISTENCE_POINTER);
    expect(off).not.toContain(MEMORY_CATALOG_DISCIPLINE);
    expect(engine.overlayMemoryPrefetch).toBeUndefined();
    expect(engine.autoMemory).toBeUndefined();
  });
});

describe("B — a stale memory tool call is refused before any read or write", () => {
  it("rejects a memory_recall produced while memory was ON, before the store is read", async () => {
    const { cwd, userHome, memoryDir } = await isolate();
    await writeStore(memoryDir, "rendering", note());

    const engine = await buildIn(cwd, userHome, {
      surface: "tui",
      settings: { memory: { autoExtract: true } },
    });
    // Produced while ON — the very same call object the executor would hold
    // for a stale tool_use block replayed from conversation history.
    const call = handlerOf(engine, "memory_recall");
    expect(String(await call({ query: "bar()" }))).toContain(
      "Rendering goes through"
    );

    toggleOff(engine);

    await expect(call({ query: "bar()" })).rejects.toThrow(
      /memory.*(disabled|off)/i
    );
  });

  it("rejects a memory_save produced while memory was ON, before the store is written", async () => {
    const { cwd, userHome, memoryDir } = await isolate();
    await mkdir(memoryDir, { recursive: true });

    const engine = await buildIn(cwd, userHome, {
      surface: "tui",
      settings: { memory: { autoExtract: true } },
    });
    const call = handlerOf(engine, "memory_save");
    toggleOff(engine);

    await expect(
      call({
        title: "Prefer pnpm",
        body: "Installs go through pnpm in this repo.",
      })
    ).rejects.toThrow(/memory.*(disabled|off)/i);

    expect(await readdir(memoryDir)).toEqual([]);
  });

  it("refuses before scoring even when entries are supplied out of band", () => {
    const tool = createMemoryRecallTool({
      memoryDir: "/nonexistent-memory-dir",
      entries: [note()],
      isEnabled: () => false,
    });
    return expect(tool.handler({ query: "bar()" })).rejects.toThrow(
      /memory.*(disabled|off)/i
    );
  });

  it("refuses a memory_save before the tmp+rename write happens", async () => {
    const memoryDir = await mkdtemp(join(tmpdir(), "capability-off-save-"));
    dirs.push(memoryDir);
    const tool = createMemorySaveTool({ memoryDir, isEnabled: () => false });
    await expect(
      tool.handler({
        title: "Prefer pnpm",
        body: "Installs go through pnpm in this repo.",
      })
    ).rejects.toThrow(/memory.*(disabled|off)/i);
    expect(await readdir(memoryDir)).toEqual([]);
  });
});

describe("C — no memory background work runs while OFF", () => {
  it("assembles no hook at all for a dual-off host surface", async () => {
    const { cwd, userHome } = await isolate();
    const engine = await buildIn(cwd, userHome, {
      surface: "serve",
      settings: { memory: { autoExtract: false, dream: false } },
    });
    expect(engine.autoMemory).toBeUndefined();
  });

  it("runs nothing on the completed-turn gate, on process exit, or the mechanical sweep", async () => {
    const { cwd, userHome, memoryDir } = await isolate();
    await writeStore(memoryDir, "cap", capabilityRow());

    const engine = await buildIn(cwd, userHome, {
      surface: "tui",
      settings: { memory: { autoExtract: true } },
    });
    const hook = engine.autoMemory!;
    toggleOff(engine);

    for (let n = 1; n <= DEFAULT_COMPLETED_TURN_GATE; n++) {
      hook.onTurnComplete({
        stopReason: "completed",
        transcript: `user: turn ${n}`,
      });
    }
    await hook.drain();
    await hook.onExit?.();

    // The capability row is exactly what the ADR-0086 sweep would disable.
    const raw = await readFile(join(memoryDir, "cap.md"), "utf8");
    expect(raw).toContain("disabled: false");
    expect(await readdir(memoryDir)).toEqual(["cap.md"]);
  });
});

describe("D — one toggle moves every channel together", () => {
  it("flips schemas, system assembly, executor enforcement and cache state in one step", async () => {
    const { cwd, userHome, memoryDir } = await isolate();
    await writeStore(memoryDir, "rendering", note());

    const engine = await buildIn(cwd, userHome, {
      surface: "tui",
      settings: { memory: { autoExtract: true } },
    });
    const call = handlerOf(engine, "memory_recall");
    expect(promptToolNames(engine)).toContain("memory_recall");
    expect(await systemText(engine)).toContain(EXISTENCE_POINTER);
    await expect(call({ query: "bar()" })).resolves.toBeTruthy();

    toggleOff(engine);

    expect(promptToolNames(engine)).not.toContain("memory_recall");
    expect(await systemText(engine)).not.toContain(EXISTENCE_POINTER);
    await expect(call({ query: "bar()" })).rejects.toThrow();

    // Re-enable: current behavior returns in full, from a re-assembled
    // snapshot rather than the pre-OFF one.
    toggleOn(engine);
    expect(promptToolNames(engine)).toContain("memory_recall");
    expect(await systemText(engine)).toContain(EXISTENCE_POINTER);
    await expect(call({ query: "bar()" })).resolves.toContain(
      "Rendering goes through"
    );
  });
});

describe("F — the on-disk store survives the OFF period", () => {
  it("keeps every stored file byte-identical across an OFF → ON round trip", async () => {
    const { cwd, userHome, memoryDir } = await isolate();
    await writeStore(memoryDir, "rendering", note());
    const before = await readFile(join(memoryDir, "rendering.md"), "utf8");

    const engine = await buildIn(cwd, userHome, {
      surface: "tui",
      settings: { memory: { autoExtract: true } },
    });
    toggleOff(engine);
    await readdir(memoryDir);
    toggleOn(engine);

    expect(await readFile(join(memoryDir, "rendering.md"), "utf8")).toBe(
      before
    );
    expect(await readdir(memoryDir)).toEqual(["rendering.md"]);
  });
});
describe("G — input boundary classes on the OFF path", () => {
  it("empty: an OFF session with no store resolves and reads nothing", async () => {
    const { cwd, userHome } = await isolate();
    const engine = await buildIn(cwd, userHome, {
      surface: "tui",
      settings: { memory: { autoExtract: true } },
    });
    toggleOff(engine);

    // Empty store: no existence pointer to remove, and the OFF tier still
    // resolves the instruction layer rather than failing.
    expect(await systemText(engine)).not.toContain(EXISTENCE_POINTER);
    await expect(
      handlerOf(engine, "memory_recall")({ query: "anything" })
    ).rejects.toThrow(/memory.*(disabled|off)/i);
  });

  it("invalid: the capability refusal precedes draft validation", async () => {
    // A negative-form draft is rejected by the save tool's own gate with a
    // different typed error; while OFF the capability refusal is what fires.
    const { cwd, userHome } = await isolate();
    const engine = await buildIn(cwd, userHome, {
      surface: "tui",
      settings: { memory: { autoExtract: true } },
    });
    const call = handlerOf(engine, "memory_save");
    toggleOff(engine);

    await expect(
      call({ title: "Builds", body: "Never commit directly to main." })
    ).rejects.toThrow(/memory.*(disabled|off)/i);
  });

  it("concurrent: parallel OFF resolves and parallel OFF calls agree", async () => {
    const { cwd, userHome, memoryDir } = await isolate();
    await writeStore(memoryDir, "rendering", note());
    const engine = await buildIn(cwd, userHome, {
      surface: "tui",
      settings: { memory: { autoExtract: true } },
    });
    toggleOff(engine);

    const [a, b, c] = await Promise.all([
      systemText(engine),
      systemText(engine),
      systemText(engine),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);

    const recall = handlerOf(engine, "memory_recall");
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => recall({ query: "bar()" }))
    );
    expect(
      results.every((r) => r.status === "rejected"),
      "every concurrent OFF call is refused"
    ).toBe(true);
  });
});
