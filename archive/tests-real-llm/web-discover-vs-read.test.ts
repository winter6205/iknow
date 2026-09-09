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

const EMPTY_COMPLETED_ATTEMPTS = 2;

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
  let last: ReadonlyArray<{ name: string; input: unknown }> = [];
  for (let attempt = 1; attempt <= EMPTY_COMPLETED_ATTEMPTS; attempt++) {
    const { uses } = await runWithMessages(mode, id, userPrompt, io);
    last = uses;
    if (uses.length > 0) return uses;
  }
  return last;
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
    const fromMessages = collectToolUses(result.messages);
    return {
      uses: fromMessages.length > 0 ? fromMessages : executed,
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
      const out: Array<ToolExecutionResult | undefined> = Array.from(
        { length: calls.length },
        () => undefined
      );
      const pending: ToolCall[] = [];
      const pendingIndex: number[] = [];
      for (let i = 0; i < calls.length; i++) {
        const call = calls[i]!;
        executed.push({ name: call.name, input: call.input });
        const stubbed = stubNetworkCall(call, mode);
        if (stubbed !== undefined) {
          out[i] = stubbed;
        } else {
          pending.push(call);
          pendingIndex.push(i);
        }
      }
      if (pending.length > 0) {
        const innerResults = await inner.executeAll(
          pending,
          signal,
          timeoutMs,
          conversationId,
          undefined,
          turnId,
          onStream
        );
        for (let j = 0; j < pending.length; j++) {
          out[pendingIndex[j]!] = innerResults[j]!;
        }
      }
      const settled = out.map((r, i) => {
        if (r === undefined) {
          throw new Error(`intercept missing result at index ${i}`);
        }
        return r;
      });
      for (let i = 0; i < settled.length; i++) {
        await onSettled?.(settled[i]!, i);
      }
      return settled;
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
