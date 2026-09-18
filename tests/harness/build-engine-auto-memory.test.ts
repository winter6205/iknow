/**
 * auto-memory T4: `BuiltEngine.autoMemory` wiring.
 *
 * Spec: specs/auto-memory.md D1/SC1; ADR-0031 Decision 1/5; ADR-0031 D5
 * amendment 2026-09-11 + specs/runtime-capability-memory-gate.md (SC2 / SC5 /
 * SC8 / SC11). The assembly point is where the opt-in becomes a live hook, so
 * this is where the default-OFF promise, the mechanical-only dual-off hook and
 * the `ask` opt-out (ADR-0010 D3) are pinned.
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
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildHarnessEngine,
  type BuiltEngine,
} from "../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import {
  DEFAULT_COMPLETED_TURN_GATE,
  parseMemoryEntry,
  resolveProjectMemoryDir,
  serializeMemoryEntry,
} from "../../src/harness/memory/index.ts";
import type { MemoryEntryV1 } from "../../src/harness/memory/index.ts";
import type { IknowEnv } from "../../src/config/env.ts";

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
      apiKey: "sk-test-auto-memory",
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
  };
}

/** Isolated cwd/home so the assembly never reads the developer's own settings. */
async function isolate(): Promise<{ cwd: string; userHome: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "auto-memory-cwd-"));
  const userHome = await mkdtemp(join(tmpdir(), "auto-memory-home-"));
  dirs.push(cwd, userHome);
  return { cwd, userHome };
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
    // 本文件验的是 autoMemory 的 opt-in 接线,不验溢出退场 / 索引降档 ——
    // 那两条路径的专测在 build-engine-tool-overflow.test.ts 与
    // disclosure-index-align/sc7-index-demotion.test.ts。故旁路装配期
    // countTokens(缝语义见 BuildEngineOpts.skipCountTokens 注释)。
    skipCountTokens: true,
    ...opts,
  });
  built.push(engine);
  return engine;
}

async function build(opts: Record<string, unknown> = {}): Promise<BuiltEngine> {
  const { cwd, userHome } = await isolate();
  return buildIn(cwd, userHome, opts);
}

/**
 * Classifier fixtures (specs/runtime-capability-memory-gate.md): the sweep
 * disables the runtime capability observation and leaves the product-policy
 * `constraint` live. Written straight to disk because these rows predate the
 * persist gate — that is exactly the population the sweep exists for.
 */
const capabilityRow = (): MemoryEntryV1 => ({
  id: "cap",
  type: "note",
  importance: 5,
  ttl_days: 0,
  disabled: false,
  supersedes: null,
  title: "web_search is unavailable in this sandbox",
  body: "The sandbox DNS/SSRF benchmarking segment blocks outbound network access.",
  updated_at: "2026-08-26T00:00:00.000Z",
});

const readDisabled = async (path: string): Promise<boolean> =>
  parseMemoryEntry(await readFile(path, "utf8")).disabled;

describe("buildHarnessEngine — auto-memory opt-in", () => {
  it("wires a mechanical-only autoMemory with no settings at all (dual-off)", async () => {
    // Dual-off still wires the hook (ADR-0031 D5 amendment): the mechanical
    // segment is what an opted-out user needs, so capability rows written
    // ahead of the persist gate stop surviving on disk. Default OFF means
    // zero LLM / zero extract, never absent wiring.
    const { cwd, userHome } = await isolate();
    const engine = await buildIn(cwd, userHome);
    expect(engine.autoMemory).toBeDefined();
    expect(typeof engine.autoMemory!.onTurnComplete).toBe("function");
    expect(typeof engine.autoMemory!.onExit).toBe("function");
    // Read-side prefetch still follows autoExtract alone.
    expect(engine.overlayMemoryPrefetch).toBeUndefined();
    expect(engine.memoryFlags).toBeUndefined();
    // SC2/SC8: below the gate and on an empty store nothing is written at all.
    const memoryDir = resolveProjectMemoryDir({
      dataDir: join(userHome, ".iknow"),
      projectIdentityRoot: cwd,
    });
    for (let n = 1; n < DEFAULT_COMPLETED_TURN_GATE; n++) {
      engine.autoMemory!.onTurnComplete({
        stopReason: "completed",
        transcript: `user: turn ${n}`,
      });
    }
    await engine.autoMemory!.drain();
    await expect(readdir(memoryDir)).rejects.toThrow();
  });

  it("does not scan the whole memory store on the startup path (SC11)", async () => {
    // Startup must not await a full-store GC: the first packet cannot wait on
    // a maintenance pass. The scan is only reachable from the gated turn and
    // from the exit seam — so building the engine must leave the pre-existing
    // capability row untouched, however many times it is built.
    const { cwd, userHome } = await isolate();
    const memoryDir = resolveProjectMemoryDir({
      dataDir: join(userHome, ".iknow"),
      projectIdentityRoot: cwd,
    });
    await mkdir(memoryDir, { recursive: true });
    await writeFile(
      join(memoryDir, "cap.md"),
      serializeMemoryEntry(capabilityRow()),
      "utf8"
    );
    const first = await buildIn(cwd, userHome);
    expect(await readDisabled(join(memoryDir, "cap.md"))).toBe(false);
    // A second assembly on the same root is the TUI/chat rebind shape.
    const second = await buildIn(cwd, userHome, { surface: "tui" });
    expect(second.autoMemory).toBeDefined();
    expect(await readDisabled(join(memoryDir, "cap.md"))).toBe(false);
    // The handle exists but is lazy: only the gate (or exit) moves the row.
    await first.autoMemory!.onExit!();
    expect(await readDisabled(join(memoryDir, "cap.md"))).toBe(true);
  });

  it("wires autoMemory on TUI even when both flags are off, with live flags", async () => {
    const engine = await build({ surface: "tui" });
    expect(engine.autoMemory).toBeDefined();
    expect(engine.memoryFlags).toEqual({ autoExtract: false, dream: false });
    expect(engine.overlayMemoryPrefetch).toBeDefined();
  });

  it("exposes invalidateMemorySystem on TUI only (memory-toggle-live)", async () => {
    // TUI: the only surface whose host can flip /memory mid-session — the
    // snapshot-dropping handle must be present even with autoExtract off.
    const tui = await build({ surface: "tui" });
    expect(typeof tui.invalidateMemorySystem).toBe("function");
    // chat: settings toggle is read only at assembly; no live toggle exists.
    const chat = await build();
    expect(chat.invalidateMemorySystem).toBeUndefined();
  });

  it("keeps a mechanical-only autoMemory on an explicit false, with zero LLM", async () => {
    // An explicit false still wires the hook: mechanical-only presence with
    // the same gate and the same on-disk sweep. The extract arm stays off
    // because `runExtractPass` is guarded on the live `enabled` flag.
    const { cwd, userHome } = await isolate();
    const engine = await buildIn(cwd, userHome, {
      settings: { memory: { autoExtract: false } },
    });
    expect(engine.autoMemory).toBeDefined();
    expect(typeof engine.autoMemory!.onTurnComplete).toBe("function");

    // A capability row written straight to disk, bypassing the persist gate,
    // is swept on the gated turn — the whole point of keeping the hook around.
    const memoryDir = resolveProjectMemoryDir({
      dataDir: join(userHome, ".iknow"),
      projectIdentityRoot: cwd,
    });
    await mkdir(memoryDir, { recursive: true });
    await writeFile(
      join(memoryDir, "cap.md"),
      serializeMemoryEntry(capabilityRow()),
      "utf8"
    );
    for (let n = 1; n < DEFAULT_COMPLETED_TURN_GATE; n++) {
      engine.autoMemory!.onTurnComplete({
        stopReason: "completed",
        transcript: `user: turn ${n}`,
      });
    }
    await engine.autoMemory!.drain();
    expect(await readDisabled(join(memoryDir, "cap.md"))).toBe(false);
    engine.autoMemory!.onTurnComplete({
      stopReason: "completed",
      transcript: "user: gated turn",
    });
    await engine.autoMemory!.drain();
    expect(await readDisabled(join(memoryDir, "cap.md"))).toBe(true);
  });

  it("wires overlayMemoryPrefetch on an explicit true", async () => {
    const engine = await build({ settings: { memory: { autoExtract: true } } });
    expect(engine.overlayMemoryPrefetch).toBeDefined();
    expect(typeof engine.overlayMemoryPrefetch).toBe("function");
  });

  it("wires autoMemory on an explicit true", async () => {
    const engine = await build({ settings: { memory: { autoExtract: true } } });
    expect(engine.autoMemory).toBeDefined();
    expect(typeof engine.autoMemory!.onTurnComplete).toBe("function");
  });

  it("leaves overlayMemoryPrefetch absent on the ask surface even when opted in", async () => {
    const engine = await build({
      surface: "ask",
      settings: { memory: { autoExtract: true } },
    });
    expect(engine.overlayMemoryPrefetch).toBeUndefined();
  });

  it("leaves overlayMemoryPrefetch absent when the memory layer itself is off", async () => {
    const engine = await build({
      memory: { enabled: false },
      settings: { memory: { autoExtract: true } },
    });
    expect(engine.overlayMemoryPrefetch).toBeUndefined();
  });

  it("wires autoMemory when dream is true without autoExtract", async () => {
    const engine = await build({ settings: { memory: { dream: true } } });
    expect(engine.autoMemory).toBeDefined();
    expect(engine.overlayMemoryPrefetch).toBeUndefined();
  });

  it("leaves autoMemory absent on the ask surface even when opted in", async () => {
    const engine = await build({
      surface: "ask",
      settings: { memory: { autoExtract: true } },
    });
    expect(engine.autoMemory).toBeUndefined();
  });

  it("keeps ask free of memory tools even when dream is enabled", async () => {
    const engine = await build({
      surface: "ask",
      settings: { memory: { dream: true } },
    });
    const names = engine.deps.registry.list().map((tool) => tool.name);
    expect(names).not.toContain("memory_recall");
    expect(names).not.toContain("memory_save");
  });

  it("leaves autoMemory absent when the memory layer itself is off", async () => {
    const engine = await build({
      memory: { enabled: false },
      settings: { memory: { autoExtract: true } },
    });
    expect(engine.autoMemory).toBeUndefined();
  });

  it("wires autoMemory from user settings.json without an injected settings object", async () => {
    // ADR-0084：memory 是用户层键 → 承载文件是 <userHome>/.iknow/settings.json；
    // 项目文件里的 memory 段会被允许名单丢弃。
    const { cwd, userHome } = await isolate();
    await mkdir(join(userHome, ".iknow"), { recursive: true });
    await writeFile(
      join(userHome, ".iknow", "settings.json"),
      JSON.stringify({ memory: { autoExtract: true } })
    );
    const engine = await buildHarnessEngine({
      env: makeEnv(),
      askUser: createNoAskUser(),
      cwd,
      userHome,
      workspaceRoot: cwd,
      sandboxRoot: cwd,
      // 同上:验 settings.json 驱动 autoMemory,不验溢出 / 索引降档。
      skipCountTokens: true,
    });
    built.push(engine);
    expect(engine.autoMemory).toBeDefined();
  });

  it("wires assembleStaticSystemPrompt into the extract hook", () => {
    const source = readFileSync(
      join(process.cwd(), "src/harness/build-engine.ts"),
      "utf8"
    );
    expect(source).toMatch(/assembleStaticSystemPrompt/);
    expect(source).toMatch(/staticLayer:\s*\(\)\s*=>/);
  });
});
