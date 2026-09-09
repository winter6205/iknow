/**
 * Real-LLM golden set: first-tool trajectory for discover vs read.
 *
 * Same three fixtures as tests/harness/aci/tools/web-discover-vs-read.test.ts.
 * Network handlers are intercepted so this file does not change search/fetch
 * success/failure semantics and does not hit Exa / live pages.
 *
 * HAS_KEY missing → describe.skip + Not run (do not fail CI without key).
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadIknowEnv } from "../../src/config/env.ts";
import { MaxTurnsExceeded } from "../../src/harness/errors.ts";
import { buildHarnessEngine } from "../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import { run } from "../../src/harness/loop-engine.ts";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.ts";
import type {
  Executor,
  ToolCall,
  ToolExecutionResult,
} from "../../src/harness/tools/types.ts";
import {
  fixtureById,
  fetchUrlFromInput,
  httpUrlsIn,
  isHttpUrl,
  type DiscoverVsReadFixtureId,
} from "../../tests/harness/aci/tools/web-discover-vs-read.fixtures.ts";

const env = loadIknowEnv(process.cwd());
const HAS_KEY =
  typeof env.llm.apiKey === "string" &&
  env.llm.apiKey.length > 0 &&
  env.llm.apiKey !== "your-api-key" &&
  !env.llm.apiKey.startsWith("YOUR_");
if (!HAS_KEY) console.log("[SKIP] LLM key not set; Not run");

const EMPTY_SEARCH_MESSAGE = "web_search failed: No search results found.";

const runOrSkip = HAS_KEY ? describe : describe.skip;

runOrSkip("web discover vs read golden set (real-LLM)", () => {
  const roots: string[] = [];
  const shutdowns: Array<() => Promise<void>> = [];
  afterAll(async () => {
    await Promise.all(shutdowns.splice(0).map((f) => f()));
    await Promise.all(
      roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))
    );
  });

  const sc1 = fixtureById("sc1-search-no-url");
  it(
    sc1.title,
    async () => {
      const uses = await runUntilTools("stub-ok", sc1.id, sc1.userPrompt, {
        roots,
        shutdowns,
        recoverToolsOnMaxTurns: true,
      });
      expect(uses.length).toBeGreaterThan(0);
      expect(uses[0]!.name).toBe("web_search");
    },
    360_000
  );

  const sc2 = fixtureById("sc2-read-given-url");
  it(
    sc2.title,
    async () => {
      const uses = await runUntilTools("stub-ok", sc2.id, sc2.userPrompt, {
        roots,
        shutdowns,
        recoverToolsOnMaxTurns: true,
      });
      expect(uses.length).toBeGreaterThan(0);
      expect(uses[0]!.name).toBe("web_fetch");
    },
    360_000
  );

  const sc3 = fixtureById("sc3-empty-search-not-guess-fetch");
  it(
    sc3.title,
    async () => {
      const { uses } = await runWithMessages(
        "empty-search",
        sc3.id,
        sc3.userPrompt,
        { roots, shutdowns }
      );
      expect(uses.length).toBeGreaterThan(0);
      expect(uses[0]!.name).toBe("web_search");
      const givenUrls = new Set(
        httpUrlsIn(sc3.userPrompt).map((u) => u.toLowerCase())
      );
      for (const call of uses.slice(1)) {
        if (call.name !== "web_fetch") continue;
        const url = fetchUrlFromInput(call.input);
        const guessed = isHttpUrl(url) && !givenUrls.has(url.toLowerCase());
        expect(
          guessed,
          `guessed-URL web_fetch after empty search: ${url}`
        ).toBe(false);
      }
    },
    360_000
  );
});

type InterceptMode = "stub-ok" | "empty-search";

async function runUntilTools(
  mode: InterceptMode,
  id: DiscoverVsReadFixtureId,
  userPrompt: string,
  io: {
    roots: string[];
    shutdowns: Array<() => Promise<void>>;
    recoverToolsOnMaxTurns?: boolean;
  }
): Promise<ReadonlyArray<{ name: string; input: unknown }>> {
  const { uses } = await runWithMessages(mode, id, userPrompt, io);
  return uses;
}

async function runWithMessages(
  mode: InterceptMode,
  id: DiscoverVsReadFixtureId,
  userPrompt: string,
  io: {
    roots: string[];
    shutdowns: Array<() => Promise<void>>;
    recoverToolsOnMaxTurns?: boolean;
  }
): Promise<{
  uses: ReadonlyArray<{ name: string; input: unknown }>;
  messages: ReadonlyArray<AnthropicNativeMessage>;
}> {
  const root = await mkdtemp(join(tmpdir(), `iknow-960-${id}-`));
  io.roots.push(root);
  await mkdir(join(root, ".iknow"), { recursive: true });
  const built = await buildHarnessEngine({
    env,
    askUser: createNoAskUser(),
    surface: "chat",
    userHome: join(root, "home"),
    cwd: root,
  });
  if (built.shutdown) io.shutdowns.push(built.shutdown);
  const executed: Array<{ name: string; input: unknown }> = [];
  const deps = {
    ...built.deps,
    executor: interceptNetworkExecutor(built.deps.executor, mode, executed),
    // Sibling real-llm files use 4–8; SC1 can spend thinking turns before
    // the first tool, so 4 is tight and MaxTurnsExceeded drops messages.
    maxTurns: 8,
  };
  try {
    const { result } = await run(userPrompt, deps);
    return {
      uses: collectToolUses(result.messages),
      messages: result.messages,
    };
  } catch (err) {
    if (!(err instanceof MaxTurnsExceeded)) throw err;
    // EXIT: first-tool callers only. SC3 needs a completed next step.
    if (io.recoverToolsOnMaxTurns !== true) throw err;
    // run() rethrows without attaching messages; executor already
    // recorded every dispatched tool_use from completed turns.
    expect(
      executed.length,
      `MaxTurnsExceeded after ${err.turnsRan} turns with no tool_use`
    ).toBeGreaterThan(0);
    return { uses: executed, messages: [] };
  }
}

function interceptNetworkExecutor(
  inner: Executor,
  mode: InterceptMode,
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
      const out: ToolExecutionResult[] = [];
      for (let i = 0; i < calls.length; i++) {
        const call = calls[i]!;
        executed.push({ name: call.name, input: call.input });
        const stubbed = stubNetworkCall(call, mode);
        const result =
          stubbed ??
          (
            await inner.executeAll(
              [call],
              signal,
              timeoutMs,
              conversationId,
              undefined,
              turnId,
              onStream
            )
          )[0]!;
        out.push(result);
        await onSettled?.(result, i);
      }
      return out;
    },
  };
}

function stubNetworkCall(
  call: ToolCall,
  mode: InterceptMode
): ToolExecutionResult | undefined {
  if (call.name === "web_search" && mode === "empty-search") {
    return {
      kind: "execution_failed",
      toolUseId: call.id,
      message: EMPTY_SEARCH_MESSAGE,
    };
  }
  if (call.name === "web_search" || call.name === "web_fetch") {
    return {
      kind: "ok",
      toolUseId: call.id,
      payload: [{ type: "text", text: "golden-set network stub" }],
    };
  }
  return undefined;
}

function collectToolUses(
  messages: ReadonlyArray<AnthropicNativeMessage>
): Array<{ name: string; input: unknown }> {
  const uses: Array<{ name: string; input: unknown }> = [];
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "tool_use") {
        uses.push({ name: b.name, input: b.input });
      }
    }
  }
  return uses;
}
