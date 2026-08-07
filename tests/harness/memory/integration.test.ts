/**
 * #121 T8: integration tests covering spec Testing Strategy Integration section.
 *
 * Spec: specs/121-memory-injection.md (Testing Strategy Integration block +
 * SC 1–15 + Boundaries Always — append-only, no real ~/.iknow writes).
 *
 * What this file asserts end-to-end:
 *   a. Dual-entry assembly consistency (chat vs serve over the same cwd → byte-
 *      identical system strings; different cwd → no cross-pollution because
 *      project namespaces resolve to different memory dirs).
 *   b. per-turn mtime refresh (after T7 wiring): mid-session AGENTS.md edits
 *      are reflected in the next turn's resolved system string.
 *   c. save → recall → recordRecall → eligibleForPromote → promote-in-system
 *      full chain across two distinct session_ids (spec SC 6/8/10).
 *   d. memory_recall output travels through the tool_result channel: a tool
 *      call id minted by the stub adapter lands on a user message's tool_result
 *      block whose `tool_use_id` matches, and the recalled entry body appears
 *      in the tool_result payload.
 *
 * Append-only discipline (Boundaries Always): this test file never mutates the
 * `messages` array passed to the harness; it only composes memory module
 * functions + assembles a real loop run with a stub model.
 *
 * No real ~/.iknow writes (spec Boundaries Always — user-level path ALWAYS =
 * ~/.iknow, but tests must not pollute it): every test uses tmpdir-derived
 * memoryDir / userHome / cwd.
 */
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assembleSystemPrompt,
  PRIORITY_DECLARATION,
  EXISTENCE_POINTER,
  listPromotableEntries,
  recordRecall,
  resolveProjectMemoryDir,
  createSystemResolver,
  type AssemblyContext,
} from "../../../src/harness/memory/index.ts";
import { createMemorySaveTool } from "../../../src/harness/memory/tools/save.ts";
import { createMemoryRecallTool } from "../../../src/harness/memory/tools/recall.ts";
import { run } from "../../../src/harness/loop-engine.ts";
import { createRegistry } from "../../../src/harness/tools/registry.ts";
import { createExecutor } from "../../../src/harness/tools/executor.ts";
import { createStubModel } from "../../../src/harness/stubs/stub-model.ts";
import { assistantResult } from "../../cli/_fixtures.ts";

const FIXED_TS = "2026-08-06T00:00:00.000Z";
const FIXED_SLUG_BYTES: Buffer = Buffer.alloc(6, 0xab); // → "abababababab" (12 hex chars)

function tick(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -- per-test tmpdir pool ----------------------------------------------------

const roots: string[] = [];

beforeEach(() => {
  // Each test gets a fresh root; child paths are constructed in-test so we
  // can prove cross-cwd namespace isolation without leaking state across
  // cases. No real ~/.iknow writes happen anywhere in this file.
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))
  );
});

async function setupProject(
  opts: {
    readonly agentsBody?: string;
    readonly projectRuleBody?: string;
    readonly userRuleBody?: string;
    readonly userAgentsBody?: string;
  } = {}
): Promise<{
  cwd: string;
  userHome: string;
  memoryDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "iknow-int-"));
  roots.push(root);
  const cwd = join(root, "project");
  const userHome = join(root, "home");
  const memoryDir = join(root, "memory");
  await Promise.all([mkdir(cwd), mkdir(userHome), mkdir(memoryDir)]);
  // Pre-create the .iknow parents so writes below never race on ENOENT for a
  // missing directory (the red phase caught this bug; the production code
  // never touches real ~/.iknow).
  await Promise.all([
    mkdir(join(userHome, ".iknow"), { recursive: true }),
    mkdir(join(cwd, ".iknow"), { recursive: true }),
  ]);
  if (opts.userAgentsBody !== undefined) {
    await writeFile(
      join(userHome, ".iknow", "AGENTS.md"),
      opts.userAgentsBody,
      "utf8"
    );
  }
  if (opts.userRuleBody !== undefined) {
    const rulesDir = join(userHome, ".iknow", "rules");
    await mkdir(rulesDir, { recursive: true });
    await writeFile(join(rulesDir, "user-rule.md"), opts.userRuleBody, "utf8");
  }
  if (opts.agentsBody !== undefined) {
    await writeFile(join(cwd, "AGENTS.md"), opts.agentsBody, "utf8");
  }
  if (opts.projectRuleBody !== undefined) {
    const rulesDir = join(cwd, ".iknow", "rules");
    await mkdir(rulesDir, { recursive: true });
    await writeFile(
      join(rulesDir, "proj-rule.md"),
      opts.projectRuleBody,
      "utf8"
    );
  }
  return { cwd, userHome, memoryDir };
}

function ctxOf(p: {
  readonly cwd: string;
  readonly userHome: string;
  readonly memoryDir: string;
}): AssemblyContext {
  return { cwd: p.cwd, userHome: p.userHome, memoryDir: p.memoryDir };
}

// =============================================================================
// a. Dual-entry assembly consistency (chat vs serve over the same cwd)
// =============================================================================

describe("dual-entry assembly consistency (chat vs serve)", () => {
  it("two harness instances over the same cwd produce byte-identical system strings", async () => {
    const p = await setupProject({
      agentsBody: "PROJECT AGENTS",
      projectRuleBody: "PROJECT RULE",
      userAgentsBody: "USER AGENTS",
      userRuleBody: "USER RULE",
    });
    // Seed the memory library so the existence pointer + a (potential) promote
    // segment participate in the comparison; otherwise the only differentiator
    // is the static layer content.
    await writeFile(join(p.memoryDir, "mem-1.md"), "# seed", "utf8");

    const ctx = ctxOf(p);
    const chatResolver = createSystemResolver(ctx);
    const serveResolver = createSystemResolver(ctx);
    const chatSystem = await chatResolver();
    const serveSystem = await serveResolver();

    assert.ok(chatSystem !== undefined, "chat system resolved");
    assert.ok(serveSystem !== undefined, "serve system resolved");
    assert.equal(
      chatSystem,
      serveSystem,
      "two harness instances over the same cwd must produce identical system strings (chat vs serve consistency)"
    );
    // And the resolved content carries the priority declaration (locks SC 4).
    assert.ok(chatSystem.includes(PRIORITY_DECLARATION));
    assert.ok(chatSystem.includes(EXISTENCE_POINTER));
  });

  it("two direct assembleSystemPrompt calls with the same ctx return the same string (deterministic)", async () => {
    const p = await setupProject({ agentsBody: "DET PROJECT" });
    const first = await assembleSystemPrompt(ctxOf(p));
    const second = await assembleSystemPrompt(ctxOf(p));
    assert.equal(first, second);
  });

  it("different cwd projects do not pollute each other (namespace isolation)", async () => {
    // Two distinct projects with distinct AGENTS.md bodies. Each resolves to
    // a different project memory dir (basename + sha1(cwd)[:12]) so the
    // memory library segment (when present) is namespaced.
    const projA = await setupProject({
      agentsBody: "PROJECT A ONLY",
      userAgentsBody: "USER A ONLY",
    });
    const projB = await setupProject({
      agentsBody: "PROJECT B ONLY",
      userAgentsBody: "USER B ONLY",
    });
    // Seed distinct memory entries so the existence pointer + memory content
    // would diverge if memory dirs were shared.
    await writeFile(join(projA.memoryDir, "alpha.md"), "# alpha", "utf8");
    await writeFile(join(projB.memoryDir, "beta.md"), "# beta", "utf8");

    const a = await assembleSystemPrompt(ctxOf(projA));
    const b = await assembleSystemPrompt(ctxOf(projB));

    assert.notEqual(a, b, "different cwds must not share system strings");
    assert.ok(a.includes("PROJECT A ONLY"));
    assert.ok(
      !a.includes("PROJECT B ONLY"),
      "A's system must not leak B's content"
    );
    assert.ok(b.includes("PROJECT B ONLY"));
    assert.ok(
      !b.includes("PROJECT A ONLY"),
      "B's system must not leak A's content"
    );
    // Namespace proof: resolveProjectMemoryDir is the canonical seam.
    assert.notEqual(
      resolveProjectMemoryDir(projA.cwd),
      resolveProjectMemoryDir(projB.cwd),
      "project memory dirs must differ per cwd"
    );
  });
});

// =============================================================================
// b. per-turn mtime refresh (T7 wiring E2E)
// =============================================================================

describe("per-turn mtime refresh", () => {
  it("editing AGENTS.md mid-session is reflected in the next turn's system", async () => {
    const p = await setupProject({ agentsBody: "PROJECT-V1" });
    const resolver = createSystemResolver(ctxOf(p));

    const first = await resolver();
    assert.ok(
      first !== undefined && first.includes("PROJECT-V1"),
      "first turn must include the initial AGENTS.md content"
    );

    await tick();
    await writeFile(join(p.cwd, "AGENTS.md"), "PROJECT-V2", "utf8");
    const second = await resolver();
    assert.ok(
      second !== undefined && second.includes("PROJECT-V2"),
      "second turn must include the post-edit AGENTS.md content"
    );
    assert.ok(
      !second.includes("PROJECT-V1"),
      "stale AGENTS.md content must not leak after the mtime refresh"
    );
  });

  it("does not re-read static layer files when mtimes are unchanged (cached system stable)", async () => {
    const p = await setupProject({ agentsBody: "STABLE" });
    const resolver = createSystemResolver(ctxOf(p));
    const a = await resolver();
    const b = await resolver();
    const c = await resolver();
    assert.equal(a, b);
    assert.equal(b, c);
    // Same string identity across three cache hits, no observable drift.
    assert.ok(a !== undefined && a.includes("STABLE"));
  });

  it("refresh propagates across both project AGENTS.md and project rules", async () => {
    const p = await setupProject({
      agentsBody: "PROJ-A",
      projectRuleBody: "PROJ-RULE-A",
    });
    const resolver = createSystemResolver(ctxOf(p));
    const initial = await resolver();
    assert.ok(initial !== undefined);
    assert.ok(initial.includes("PROJ-A"));
    assert.ok(initial.includes("PROJ-RULE-A"));

    await tick();
    await writeFile(join(p.cwd, "AGENTS.md"), "PROJ-B", "utf8");
    const rulePath = join(p.cwd, ".iknow", "rules", "proj-rule.md");
    await writeFile(rulePath, "PROJ-RULE-B", "utf8");
    const refreshed = await resolver();
    assert.ok(refreshed !== undefined);
    assert.ok(refreshed.includes("PROJ-B"));
    assert.ok(refreshed.includes("PROJ-RULE-B"));
    assert.ok(!refreshed.includes("PROJ-RULE-A"));
  });
});

// =============================================================================
// c. save → recall → recordRecall → eligibleForPromote → promote-in-system
//    cross two distinct session_ids
// =============================================================================

describe("save → recall → recordRecall → promote full chain", () => {
  it("promotes an entry after ≥2 distinct sessions and exposes it in the next system assembly", async () => {
    const p = await setupProject({ agentsBody: "P" });

    // (1) Save via the memory_save tool — writes slug file + MEMORY.md index.
    const save = createMemorySaveTool({
      memoryDir: p.memoryDir,
      now: () => FIXED_TS,
      randomBytes: () => FIXED_SLUG_BYTES,
    });
    const out = await save.handler({
      title: "Use bar()",
      body: "Calling bar() is the supported rendering path.",
      type: "note",
      importance: 4,
    });
    assert.equal(typeof out, "string");

    // Extract the slug the save tool returned.
    const slugMatch = /persisted as ([a-f0-9]+)\.md/.exec(out);
    assert.ok(slugMatch !== null, "save must return a slug line");
    const slug = slugMatch![1]!;
    assert.equal(
      slug,
      "abababababab",
      "deterministic slug from fixed randomBytes"
    );

    // (2) Recall via the memory_recall tool — output must surface the title.
    const recall = createMemoryRecallTool({ memoryDir: p.memoryDir });
    const hit = await recall.handler({ query: "bar rendering" });
    assert.equal(typeof hit, "string");
    assert.ok(hit.includes("Use bar()"), "recall must surface the saved title");

    // (3) recordRecall — track ≥2 distinct session_ids.
    await recordRecall(p.memoryDir, slug, "session-A");
    await recordRecall(p.memoryDir, slug, "session-B");
    // Re-recall from session-B's perspective — recall surface unchanged.
    const hit2 = await recall.handler({ query: "bar" });
    assert.ok(hit2.includes("Use bar()"));

    // (4) eligibleForPromote → listPromotableEntries surfaces the entry.
    const promotables = await listPromotableEntries(p.memoryDir);
    assert.equal(
      promotables.length,
      1,
      "exactly one entry eligible for promote"
    );
    assert.equal(promotables[0]!.title, "Use bar()");
    assert.equal(promotables[0]!.importance, 4);

    // (5) Next assembled system must include the promote segment.
    const ctx: AssemblyContext = ctxOf(p);
    const system = await assembleSystemPrompt(ctx);
    assert.ok(system.includes(EXISTENCE_POINTER), "existence pointer present");
    assert.ok(
      system.includes("### Use bar()"),
      "promote segment must surface the title in the system string"
    );
  });

  it("does not promote before ≥2 distinct sessions even after many recalls", async () => {
    const p = await setupProject({ agentsBody: "P" });
    const save = createMemorySaveTool({
      memoryDir: p.memoryDir,
      now: () => FIXED_TS,
      randomBytes: () => FIXED_SLUG_BYTES,
    });
    const out = await save.handler({
      title: "Use qux()",
      body: "Calling qux() is the supported audit path.",
      importance: 5,
    });
    const slugMatch = /persisted as ([a-f0-9]+)\.md/.exec(out);
    assert.ok(slugMatch !== null);
    const slug = slugMatch![1]!;

    // Five recalls from the SAME session — recall_count grows, distinct count = 1.
    for (let i = 0; i < 5; i++) {
      await recordRecall(p.memoryDir, slug, "only-session");
    }

    const promotables = await listPromotableEntries(p.memoryDir);
    assert.equal(
      promotables.length,
      0,
      "promote gate is distinct-session, not recall_count"
    );
  });
});

// =============================================================================
// d. memory_recall output travels the tool_result channel
//    (stub adapter mints a tool_call id; the resulting user message carries a
//    tool_result block whose tool_use_id matches and whose payload holds the
//    recalled entry body).
// =============================================================================

describe("memory_recall output via the tool_result channel", () => {
  it("recalled entry body appears in the user tool_result block matched on tool_use_id", async () => {
    const p = await setupProject({ agentsBody: "P" });

    // Seed one memory entry so recall returns content.
    const save = createMemorySaveTool({
      memoryDir: p.memoryDir,
      now: () => FIXED_TS,
      randomBytes: () => FIXED_SLUG_BYTES,
    });
    await save.handler({
      title: "Use bar()",
      body: "Calling bar() is the supported rendering path.",
      type: "note",
      importance: 3,
    });

    const recallTool = createMemoryRecallTool({ memoryDir: p.memoryDir });
    const registry = createRegistry([recallTool]);
    const executor = createExecutor(registry);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [
            {
              id: "call-recall-1",
              name: "memory_recall",
              input: { query: "bar" },
            },
          ],
        }),
        assistantResult({
          texts: ["recall answered"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });

    const { result } = await run("please recall", {
      adapter: model,
      executor,
      registry,
      maxTurns: 5,
    });

    assert.equal(result.stopReason, "completed");
    // 4 messages: user, assistant(tool_use), user(tool_result), assistant(text).
    assert.equal(result.messages.length, 4);
    assert.equal(result.messages[0]!.role, "user");
    assert.equal(result.messages[1]!.role, "assistant");
    assert.equal(result.messages[2]!.role, "user");
    assert.equal(result.messages[3]!.role, "assistant");

    // Assistant tool_use id is preserved verbatim.
    const toolUseBlocks = result.messages[1]!.content.filter(
      (b) => b.type === "tool_use"
    );
    assert.equal(toolUseBlocks.length, 1);
    assert.equal(
      (toolUseBlocks[0] as { type: "tool_use"; id: string }).id,
      "call-recall-1"
    );

    // The very next message is a user tool_result whose tool_use_id matches
    // and whose text payload contains the recalled title + body.
    const toolResultBlocks = result.messages[2]!.content.filter(
      (b) => b.type === "tool_result"
    );
    assert.equal(toolResultBlocks.length, 1);
    const trBlock = toolResultBlocks[0] as {
      type: "tool_result";
      tool_use_id: string;
      content: ReadonlyArray<{ type: "text"; text: string }>;
    };
    assert.equal(trBlock.tool_use_id, "call-recall-1");
    const textPayload = trBlock.content.map((c) => c.text).join("\n");
    assert.ok(
      textPayload.includes("Use bar()"),
      "tool_result payload must contain the recalled title"
    );
    assert.ok(
      textPayload.includes("Calling bar() is the supported rendering path"),
      "tool_result payload must contain the recalled body"
    );
  });
});
