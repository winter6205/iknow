/**
 * ADR-0121, Gate-B harness side: `createWorkerDeps` threads the injected
 * `PreimageCapture` PORT (a pure harness type — no session-api import here)
 * into the worker's write tools, exactly like the parent chain's
 * build-engine → registry seam.
 *
 * Locked here (stub model, zero LLM calls, real temp-dir writes):
 *   - write_file fires the capture once BEFORE the bytes land, with
 *     preBytes/postBytes/relPath/rootIdentity/toolUseId forwarded;
 *   - the write still happens after a non-throwing capture;
 *   - a throwing capture aborts the write (file never created);
 *   - no port injected (legacy assembly) → write path byte-identical, no
 *     capture-side observable (the registry spread keeps the old shape).
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";

import {
  createWorkerDeps,
  type CreateWorkerDepsOptions,
} from "../../src/harness/subagent/worker.ts";
import type { PreimageCaptureInput } from "../../src/harness/aci/preimage-port.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createSkillCatalog } from "../../src/harness/skill/catalog.ts";
import { createNoopTraceService } from "../../src/harness/trace/noop.ts";
import type { IknowEnv } from "../../src/config/env.ts";

const TEST_ENV = {
  llm: {
    apiKey: "test-key",
    baseUrl: "https://example.test",
    model: "test-model",
    fallback: [],
    maxOutputTokens: 1024,
    temperature: 0,
    stream: "off" as const,
    thinking: { type: "disabled" as const },
    maxTurns: undefined,
    timeoutMs: undefined,
  },
  web: { proxy: undefined, searchUrl: undefined },
  compress: { contextWindow: 200000, thresholdTokens: undefined },
  chat: { showThinking: false, quiet: false },
} as unknown as IknowEnv;

let root: string;
let userHome: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "iknow-worker-preimg-"));
  userHome = await mkdtemp(join(tmpdir(), "iknow-worker-preimg-home-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(userHome, { recursive: true, force: true });
});

/** Hermetic assembly seam (mirrors worker.test.ts hermeticOpts): stub-model
 *  (zero model calls) + empty skill catalog + noop trace + isolated userHome. */
function hermeticOpts(
  extra?: Partial<CreateWorkerDepsOptions>
): CreateWorkerDepsOptions {
  return {
    env: TEST_ENV,
    sandboxRoot: root,
    userHome,
    model: createStubModel({ responses: [] }),
    skillCatalog: createSkillCatalog([]),
    system: () => undefined,
    trace: createNoopTraceService(),
    ...extra,
  };
}

const ctx = { toolUseId: "tu-w1", conversationId: "task-1" };

describe("worker registry ← preimageCapture port (Gate B, harness side)", () => {
  it("write_file create: port fires exactly once before bytes land, pre/post/ids/relPath/rootIdentity forwarded", async () => {
    const seen: PreimageCaptureInput[] = [];
    const deps = await createWorkerDeps(
      hermeticOpts({
        preimageCapture: (i) => {
          seen.push(i);
        },
      })
    );
    const tool = deps.registry.get("write_file");
    assert.ok(tool, "registry view must expose write_file");
    await tool!.handler(
      { path: "brand-new.ts", content: "worker wrote\n" },
      ctx
    );

    assert.equal(seen.length, 1, "port fires exactly once before the write");
    const inp = seen[0]!;
    assert.equal(inp.preBytes.length, 0, "a create has no preimage");
    assert.equal(inp.postBytes.toString("utf8"), "worker wrote\n");
    assert.equal(inp.relPath, "brand-new.ts");
    assert.equal(
      inp.rootIdentity,
      root,
      "worker has no projectIdentityRoot → falls back to sandboxRoot"
    );
    assert.equal(inp.toolUseId, "tu-w1");
    assert.equal(inp.conversationId, "task-1");
    assert.equal(
      await readFile(join(root, "brand-new.ts"), "utf8"),
      "worker wrote\n"
    );
  });

  it("throwing capture aborts the write, bytes never hit disk", async () => {
    const deps = await createWorkerDeps(
      hermeticOpts({
        preimageCapture: async () => {
          throw new Error("capture refused");
        },
      })
    );
    const tool = deps.registry.get("write_file");
    assert.ok(tool);
    await assert.rejects(
      () =>
        tool!.handler({ path: "protected.ts", content: "OVERWRITE\n" }, ctx),
      /capture refused/
    );
    await assert.rejects(
      () => stat(join(root, "protected.ts")),
      (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT"
    );
  });

  it("no port injected (legacy assembly): write happens, zero capture surface", async () => {
    const deps = await createWorkerDeps(hermeticOpts());
    const tool = deps.registry.get("write_file");
    assert.ok(tool);
    await tool!.handler({ path: "plain.ts", content: "x\n" }, ctx);
    assert.equal(await readFile(join(root, "plain.ts"), "utf8"), "x\n");
  });
});
