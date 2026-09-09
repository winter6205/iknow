/**
 * Real-LLM golden set: first-tool trajectory for discover vs read.
 *
 * Same three fixtures as tests/harness/aci/tools/web-discover-vs-read.test.ts.
 * Network handlers are intercepted so this file does not change search/fetch
 * success/failure semantics and does not hit Exa / live pages.
 *
 * HAS_KEY missing → describe.skip + Not run (do not fail CI without key).
 * Until tool descriptions align (T2), assertions may be RED.
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadIknowEnv } from "../../src/config/env.ts";
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

  it("SC1: no URL, search/news request → first tool web_search", async () => {
    const fixture = fixtureById("sc1-search-no-url");
    const uses = await runUntilTools("record", fixture.id, fixture.userPrompt, {
      roots,
      shutdowns,
    });
    expect(uses.length).toBeGreaterThan(0);
    expect(uses[0]!.name).toBe("web_search");
  }, 360_000);

  it("SC2: user already gave http(s) URL and asked to read page → first tool MAY be web_fetch", async () => {
    const fixture = fixtureById("sc2-read-given-url");
    const uses = await runUntilTools("record", fixture.id, fixture.userPrompt, {
      roots,
      shutdowns,
    });
    expect(uses.length).toBeGreaterThan(0);
    expect(uses[0]!.name).toBe("web_fetch");
  }, 360_000);

  it("SC3: after search returns zero results, next step is NOT a guessed-URL web_fetch", async () => {
    const fixture = fixtureById("sc3-empty-search-not-guess-fetch");
    const { uses } = await runWithMessages(
      "empty-search",
      fixture.id,
      fixture.userPrompt,
      { roots, shutdowns }
    );
    expect(uses.length).toBeGreaterThan(0);
    expect(uses[0]!.name).toBe("web_search");
    const givenUrls = new Set(
      httpUrlsIn(fixture.userPrompt).map((u) => u.toLowerCase())
    );
    for (const call of uses.slice(1)) {
      if (call.name !== "web_fetch") continue;
      const url = fetchUrlFromInput(call.input);
      const guessed = isHttpUrl(url) && !givenUrls.has(url.toLowerCase());
      expect(guessed, `guessed-URL web_fetch after empty search: ${url}`).toBe(
        false
      );
    }
  }, 360_000);
});

type InterceptMode = "record" | "empty-search";

async function runUntilTools(
  mode: InterceptMode,
  id: DiscoverVsReadFixtureId,
  userPrompt: string,
  io: {
    roots: string[];
    shutdowns: Array<() => Promise<void>>;
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
  const deps = {
    ...built.deps,
    executor: interceptNetworkExecutor(built.deps.executor, mode),
    maxTurns: 4,
  };
  const { result } = await run(userPrompt, deps);
  const uses = collectToolUses(result.messages);
  return { uses, messages: result.messages };
}

function interceptNetworkExecutor(
  inner: Executor,
  mode: InterceptMode
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
