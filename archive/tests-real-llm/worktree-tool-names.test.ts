/**
 * Real-LLM golden set: first-tool trajectory for the worktree ACI rename.
 *
 * Same fixtures as tests/harness/aci/tools/worktree-tool-names.test.ts
 * (specs/create-worktree-tools.md SC3 / SC4). The host worktree seams are
 * faked with mkdir-based stand-ins so this file never runs git and never
 * leaves real task worktrees behind; the assertion is the model's first
 * tool name, not the seam's side effects.
 *
 * HAS_KEY missing → describe.skip + Not run (do not fail CI without key).
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadIknowEnv } from "../../src/config/env.ts";
import { MaxTurnsExceeded } from "../../src/harness/errors.ts";
import { buildHarnessEngine } from "../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import { run } from "../../src/harness/loop-engine.ts";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.ts";
import type { Executor } from "../../src/harness/tools/types.ts";
import {
  decidingToolIndex,
  worktreeFixtureById,
  type WorktreeToolFixtureId,
} from "../../tests/harness/aci/tools/worktree-tool-names.fixtures.ts";

const env = loadIknowEnv(process.cwd());
const HAS_KEY =
  typeof env.llm.apiKey === "string" &&
  env.llm.apiKey.length > 0 &&
  env.llm.apiKey !== "your-api-key" &&
  !env.llm.apiKey.startsWith("YOUR_");
if (!HAS_KEY) console.log("[SKIP] LLM key not set; Not run");

const runOrSkip = HAS_KEY ? describe : describe.skip;

runOrSkip("worktree tool golden set (real-LLM)", () => {
  const roots: string[] = [];
  const shutdowns: Array<() => Promise<void>> = [];
  afterAll(async () => {
    await Promise.all(shutdowns.splice(0).map((f) => f()));
    await Promise.all(
      roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))
    );
  });

  const sc3 = worktreeFixtureById("sc3-create");
  it(
    sc3.title,
    async () => {
      const uses = await runUntilTools(sc3.id, sc3.userPrompt, {
        roots,
        shutdowns,
      });
      expectDecidingTool(
        uses,
        sc3.expectedFirstTool,
        sc3.toleratedPreludeTools
      );
    },
    360_000
  );

  const sc4 = worktreeFixtureById("sc4-list");
  it(
    sc4.title,
    async () => {
      const uses = await runUntilTools(sc4.id, sc4.userPrompt, {
        roots,
        shutdowns,
      });
      expectDecidingTool(
        uses,
        sc4.expectedFirstTool,
        sc4.toleratedPreludeTools
      );
    },
    360_000
  );
});

/**
 * Assert the trajectory's DECIDING tool: the first call that is not a
 * tolerated prelude (`grep` / `glob` repo reconnaissance) must be the
 * expected worktree tool. A `bash` call first fails here — that is the
 * degradation this fixture exists to catch.
 */
function expectDecidingTool(
  uses: ReadonlyArray<{ name: string }>,
  expected: string,
  tolerated: readonly string[]
): void {
  expect(uses.length).toBeGreaterThan(0);
  const idx = decidingToolIndex(uses, { toleratedPreludeTools: tolerated });
  expect(
    idx,
    `no deciding tool; trace was all prelude: ${uses.map((u) => u.name).join(", ")}`
  ).toBeGreaterThanOrEqual(0);
  expect(
    uses[idx]!.name,
    `deciding tool after prelude [${uses
      .slice(0, idx)
      .map((u) => u.name)
      .join(", ")}]`
  ).toBe(expected);
}

// The sibling real-llm files use 4–8; a model can spend several thinking
// turns before the first tool, and MaxTurnsExceeded drops the message list.
const MAX_TURNS = 8;

/**
 * A completed turn with ZERO tool calls is a sampling miss, not a verdict:
 * the fixture is about which tool the model picks, and #960's sibling
 * (`EMPTY_COMPLETED_ATTEMPTS`) retries the same way. One retry only —
 * a wrong deciding tool (e.g. `bash` first) fails honestly, no best-of-N.
 */
const EMPTY_COMPLETED_ATTEMPTS = 2;

async function runUntilTools(
  id: WorktreeToolFixtureId,
  userPrompt: string,
  io: { roots: string[]; shutdowns: Array<() => Promise<void>> }
): Promise<ReadonlyArray<{ name: string; input: unknown }>> {
  let last: ReadonlyArray<{ name: string; input: unknown }> = [];
  for (let attempt = 1; attempt <= EMPTY_COMPLETED_ATTEMPTS; attempt++) {
    last = await runOnce(id, userPrompt, io);
    if (last.length > 0) return last;
  }
  return last;
}

async function runOnce(
  id: WorktreeToolFixtureId,
  userPrompt: string,
  io: { roots: string[]; shutdowns: Array<() => Promise<void>> }
): Promise<ReadonlyArray<{ name: string; input: unknown }>> {
  const root = await mkdtemp(join(tmpdir(), `iknow-worktree-names-${id}-`));
  io.roots.push(root);
  await mkdir(join(root, ".iknow"), { recursive: true });
  // The isolation switch is read from settings files at build time (NOT from
  // `opts.settings`), so write the project settings file the assembly loads.
  // Without it `isolationEnabled` is false and the worktree family is absent
  // from the registry — the fixture would degrade to a bash-only surface.
  await writeFile(
    join(root, ".iknow", "settings.json"),
    JSON.stringify({ isolation: { worktreeOnMutate: true } }),
    "utf8"
  );

  const treeRoot = join(root, ".iknow", "worktrees", "fix-648");
  const built = await buildHarnessEngine({
    env,
    askUser: createNoAskUser(),
    surface: "chat",
    userHome: join(root, "home"),
    cwd: root,
    settings: { isolation: { worktreeOnMutate: true } },
    // Host option names are `worktree*` (WorktreeIsolationHostOpts) — a
    // bare `list` / `enter` key would be silently ignored and the whole
    // family except create-worktree would never reach the model surface.
    worktreeIsolation: {
      provision: async () => {
        await mkdir(treeRoot, { recursive: true });
        return treeRoot;
      },
      worktreeEnter: async () => ({
        path: treeRoot,
        receipt: `entered ${treeRoot}`,
      }),
      worktreeExit: async () => root,
      worktreeList: async () => [],
      worktreeRemove: async () => ({
        label: undefined,
        conversationId: "fixture",
        path: treeRoot,
        branch: "iknow/task/fixture",
        head: "fixture-head",
        branchDeleted: false,
      }),
    },
  });
  if (built.shutdown) io.shutdowns.push(built.shutdown);
  // The fixture's verdict is only meaningful if the worktree family actually
  // reached the model surface; a missing host seam silently degrades the run
  // to a bash-only toolbox and would turn SC4 into a misleading failure.
  for (const required of [
    "create-worktree",
    "enter-worktree",
    "exit-worktree",
    "list-worktrees",
    "remove-worktree",
  ]) {
    expect(
      built.deps.registry.get(required),
      `${required} missing from the model surface (host seam not wired)`
    ).toBeDefined();
  }
  const executed: Array<{ name: string; input: unknown }> = [];
  const deps = {
    ...built.deps,
    executor: recordingExecutor(built.deps.executor, executed),
    maxTurns: MAX_TURNS,
  };
  try {
    const { result } = await run(userPrompt, deps);
    const fromMessages = collectToolUses(result.messages);
    return fromMessages.length > 0 ? fromMessages : executed;
  } catch (err) {
    if (!(err instanceof MaxTurnsExceeded)) throw err;
    // run() rethrows without attaching messages; executor already recorded
    // every dispatched tool_use from completed turns.
    expect(
      executed.length,
      `MaxTurnsExceeded after ${err.turnsRan} turns with no tool_use`
    ).toBeGreaterThan(0);
    return executed;
  }
}

function recordingExecutor(
  inner: Executor,
  executed: Array<{ name: string; input: unknown }>
): Executor {
  return {
    executeAll: async (
      calls,
      signal,
      timeoutMs,
      conversationId,
      onSettled,
      turnId,
      onStream
    ) => {
      for (const call of calls) {
        executed.push({ name: call.name, input: call.input });
      }
      return inner.executeAll(
        calls,
        signal,
        timeoutMs,
        conversationId,
        onSettled,
        turnId,
        onStream
      );
    },
  };
}

function collectToolUses(
  messages: ReadonlyArray<AnthropicNativeMessage>
): Array<{ name: string; input: unknown }> {
  const uses: Array<{ name: string; input: unknown }> = [];
  for (const m of messages) {
    const blocks = Array.isArray(m.content) ? m.content : [];
    for (const b of blocks) {
      if (
        b !== null &&
        typeof b === "object" &&
        "type" in b &&
        b.type === "tool_use" &&
        "name" in b &&
        typeof b.name === "string"
      ) {
        uses.push({ name: b.name, input: "input" in b ? b.input : undefined });
      }
    }
  }
  return uses;
}
