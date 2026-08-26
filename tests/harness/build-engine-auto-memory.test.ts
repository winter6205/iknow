/**
 * auto-memory T4: `BuiltEngine.autoMemory` wiring.
 *
 * Spec: specs/auto-memory.md D1/SC1; ADR-0030 Decision 1/5. The assembly
 * point is where the opt-in becomes a live hook, so this is where the
 * default-OFF promise and the `ask` opt-out (ADR-0010 D3) are pinned.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildHarnessEngine,
  type BuiltEngine,
} from "../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
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

async function build(
  opts: Record<string, unknown> = {}
): Promise<BuiltEngine> {
  const { cwd, userHome } = await isolate();
  const engine = await buildHarnessEngine({
    env: makeEnv(),
    askUser: createNoAskUser(),
    cwd,
    userHome,
    workspaceRoot: cwd,
    sandboxRoot: cwd,
    ...opts,
  });
  built.push(engine);
  return engine;
}

describe("buildHarnessEngine — auto-memory opt-in", () => {
  it("leaves autoMemory absent with no settings at all (default OFF)", async () => {
    expect((await build()).autoMemory).toBeUndefined();
  });

  it("leaves autoMemory absent on an explicit false", async () => {
    const engine = await build({ settings: { memory: { autoExtract: false } } });
    expect(engine.autoMemory).toBeUndefined();
  });

  it("wires autoMemory on an explicit true", async () => {
    const engine = await build({ settings: { memory: { autoExtract: true } } });
    expect(engine.autoMemory).toBeDefined();
    expect(typeof engine.autoMemory!.onTurnComplete).toBe("function");
  });

  it("leaves autoMemory absent on the ask surface even when opted in", async () => {
    const engine = await build({
      surface: "ask",
      settings: { memory: { autoExtract: true } },
    });
    expect(engine.autoMemory).toBeUndefined();
  });

  it("leaves autoMemory absent when the memory layer itself is off", async () => {
    const engine = await build({
      memory: { enabled: false },
      settings: { memory: { autoExtract: true } },
    });
    expect(engine.autoMemory).toBeUndefined();
  });
});
