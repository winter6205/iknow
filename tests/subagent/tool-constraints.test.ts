/**
 * Tool-constraints prompt segment injected into readonly workers
 * (mirrors the persona/addendum seam; part of the readonly two-layer
 *  enforcement: validator + fence EROFS are the inner layer, the prompt
 *  segment is the outer guidance).
 *
 * Acceptance:
 *   - readonly worker (role=explore, bashMode="readonly") → deps.system contains
 *     the "Tool constraints for this run" segment, positioned after the persona;
 *     the LOCKED 6 segments stay put (identity < soul < usage < user_profile <
 *     bootstrap < memory_layer);
 *   - non-readonly worker (role=general-purpose / role omitted / unknown role) →
 *     no such segment (V1 baseline / V1 fallback, byte-stable);
 *   - segment content = allowed command families (coreutils read family / git
 *     read-only subcommands / rg / jq) + explicit reject behavior + alternative
 *     tool guidance (read_file / grep / glob / lsp_*);
 *   - segment-position contract (since ADR-0112): within system,
 *     base < persona < constraints; envelope.systemPrompt (addendum) was
 *     demoted into the user/untrusted channel and no longer holds a system
 *     seat (tests/subagent/worker-addendum-untrusted.test.ts).
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  createWorkerDeps,
  type CreateWorkerDepsOptions,
} from "../../src/harness/subagent/worker.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createSkillCatalog } from "../../src/harness/skill/catalog.ts";
import { createNoopTraceService } from "../../src/harness/trace/noop.ts";
import { getAgentEntry } from "../../src/harness/subagent/catalog.ts";
import { toolConstraintsSegment } from "../../src/harness/identity/assemble.ts";
import type { IknowEnv } from "../../src/config/env.ts";

const TEST_ENV: IknowEnv = {
  llm: {
    apiKey: "test-key",
    baseUrl: "https://example.test",
    model: "test-model",
    fallback: [],
    maxOutputTokens: 1024,
    temperature: 0,
    stream: "off",
    thinking: "off",
    thinkingEffort: "",
    maxTurns: undefined,
    timeoutMs: 300_000,
  },
  web: { proxy: undefined, searchUrl: undefined },
  compress: { contextWindow: 200000, thresholdTokens: undefined },
  chat: { showThinking: false },
  mcp: { connectTimeoutMs: 60_000 },
  subagent: { taskTimeoutMs: undefined, maxConcurrentWorkers: 15 },
  workspaceRoot: undefined,
  productRoot: undefined,
};

/** Hermetic createWorkerDeps assembly: stub-model + empty skill + noop trace + placeholder system. */
function hermeticOpts(
  extra?: Partial<CreateWorkerDepsOptions>
): CreateWorkerDepsOptions {
  return {
    env: TEST_ENV,
    sandboxRoot: "/tmp/sb",
    model: createStubModel({ responses: [] }),
    skillCatalog: createSkillCatalog([]),
    system: async () => undefined,
    trace: createNoopTraceService(),
    ...extra,
  };
}

const CONSTRAINTS_HEADER = "Tool constraints for this run";

/** Slice out the "## Tool constraints for this run" segment from the assembled system
 *  text (through the next "## " heading or end of string). The persona segment
 *  (including explore's "lsp_*" hints) is unrelated to this segment; content-level
 *  assertions must target only the sliced segment, otherwise they false-positive.
 *  Returns "" when the segment was not assembled. */
function sliceConstraintsSegment(out: string): string {
  const start = out.indexOf(CONSTRAINTS_HEADER);
  if (start < 0) return "";
  const afterStart = start + CONSTRAINTS_HEADER.length;
  const rest = out.slice(afterStart);
  const nextHeader = rest.search(/\n## /);
  return nextHeader < 0
    ? out.slice(start)
    : out.slice(start, afterStart + nextHeader);
}

// ─── A. trigger conditions (bashMode decides injection) ─────────────────────

describe("tool constraints segment (#562 T7): 触发条件", () => {
  it("role=explore (bashMode='readonly') → deps.system 含 Tool constraints 段", async () => {
    const deps = await createWorkerDeps(hermeticOpts({ role: "explore" }));
    const out = (await deps.system?.()) ?? "";
    assert.ok(out.includes(CONSTRAINTS_HEADER));
  });

  it("role=general-purpose (bashMode 缺省 = any) → deps.system 不含 Tool constraints 段", async () => {
    const deps = await createWorkerDeps(
      hermeticOpts({ role: "general-purpose" })
    );
    const out = (await deps.system?.()) ?? "";
    assert.ok(!out.includes(CONSTRAINTS_HEADER));
  });

  it("role 缺省 → deps.system 不含 Tool constraints 段 (V1 baseline byte-stable)", async () => {
    const deps = await createWorkerDeps(hermeticOpts());
    const out = (await deps.system?.()) ?? "";
    assert.ok(!out.includes(CONSTRAINTS_HEADER));
  });

  it("role 未知 → deps.system 不含 Tool constraints 段 (V1 fallback defense-in-depth)", async () => {
    const deps = await createWorkerDeps(
      hermeticOpts({ role: "not_a_real_agent" })
    );
    const out = (await deps.system?.()) ?? "";
    assert.ok(!out.includes(CONSTRAINTS_HEADER));
  });
});

// ─── B. segment position (LOCKED 6 segments stay put; after persona; addendum relation optional) ─

describe("tool constraints segment: 段位置 (LOCKED 6 段不动)", () => {
  it("readonly worker → Tool constraints 段位置在 persona (catalog body) 之后", async () => {
    const deps = await createWorkerDeps(hermeticOpts({ role: "explore" }));
    const out = (await deps.system?.()) ?? "";
    const personaIdx = out.indexOf(getAgentEntry("explore").body);
    const constraintsIdx = out.indexOf(CONSTRAINTS_HEADER);
    assert.ok(personaIdx >= 0, "persona 段存在");
    assert.ok(constraintsIdx > personaIdx, "constraints 在 persona 之后");
  });

  it("readonly worker + ghost addendum (cast) → persona < constraints 顺序不变, addendum 不进 system", async () => {
    // ADR-0112: the old contract persona < constraints < addendum shrinks to
    // persona < constraints — the addendum is demoted to the user/untrusted channel.
    const poison = {
      ...hermeticOpts({ role: "explore" }),
      addendum: "MY ADDENDUM",
    } as CreateWorkerDepsOptions;
    const deps = await createWorkerDeps(poison);
    const out = (await deps.system?.()) ?? "";
    const personaIdx = out.indexOf(getAgentEntry("explore").body);
    const constraintsIdx = out.indexOf(CONSTRAINTS_HEADER);
    assert.ok(personaIdx >= 0);
    assert.ok(constraintsIdx > personaIdx, "constraints 在 persona 之后");
    assert.ok(!out.includes("MY ADDENDUM"), "addendum 不再进 system");
  });

  it("readonly worker + base → base (LOCKED 5) < persona < constraints 顺序不变", async () => {
    const baseText = "BASE_SYSTEM_TEXT";
    const deps = await createWorkerDeps(
      hermeticOpts({
        role: "explore",
        system: async () => baseText,
      })
    );
    const out = (await deps.system?.()) ?? "";
    const baseIdx = out.indexOf(baseText);
    const personaIdx = out.indexOf(getAgentEntry("explore").body);
    const constraintsIdx = out.indexOf(CONSTRAINTS_HEADER);
    assert.ok(baseIdx >= 0);
    assert.ok(personaIdx > baseIdx, "persona 在 base 之后");
    assert.ok(constraintsIdx > personaIdx, "constraints 在 persona 之后");
  });
});

// ─── C. segment content (allowed families / reject / alternative-tool guidance) ─

describe("tool constraints segment: 段内容契约", () => {
  it("段内容含 coreutils 读族关键字 (cat / grep / ls / head / tail / wc)", async () => {
    const deps = await createWorkerDeps(hermeticOpts({ role: "explore" }));
    const out = (await deps.system?.()) ?? "";
    assert.ok(out.includes(CONSTRAINTS_HEADER));
    const hasCoreutils = [
      "cat",
      "grep",
      "ls",
      "head",
      "tail",
      "wc",
      "stat",
    ].some((kw) => out.includes(kw));
    assert.ok(hasCoreutils, "段含 coreutils read 族关键字");
  });

  it("段内容含 git read-only 子命令族关键字 (status / log / diff / show)", async () => {
    const deps = await createWorkerDeps(hermeticOpts({ role: "explore" }));
    const out = (await deps.system?.()) ?? "";
    assert.ok(out.includes(CONSTRAINTS_HEADER));
    const hasGitReadOnly = ["status", "log", "diff", "show"].some((kw) =>
      out.includes(kw)
    );
    assert.ok(hasGitReadOnly, "段含 git read-only 子命令族关键字");
  });

  it("段内容含 rg (ripgrep) 与 jq", async () => {
    const deps = await createWorkerDeps(hermeticOpts({ role: "explore" }));
    const out = (await deps.system?.()) ?? "";
    assert.ok(out.includes("rg"), "段含 rg");
    assert.ok(out.includes("jq"), "段含 jq");
  });

  it("段内容含显式 reject 行为说明 (reject / not allowed / forbidden / denied)", async () => {
    const deps = await createWorkerDeps(hermeticOpts({ role: "explore" }));
    const out = (await deps.system?.()) ?? "";
    const hasReject = /reject|not allowed|forbidden|denied/i.test(out);
    assert.ok(hasReject, "段含 reject 行为说明");
  });

  it("段内容反映符号工具优先 + grep 三类回退（不列 lsp_* 作为同等首选）", async () => {
    const deps = await createWorkerDeps(hermeticOpts({ role: "explore" }));
    const out = (await deps.system?.()) ?? "";
    const seg = sliceConstraintsSegment(out);
    assert.ok(seg.length > 0, "constraints 段已切出");
    // symbol-tool preference: of the 10 new symbol-query tools at least find_symbol and
    // find_declaration must be listed (the other 8 are name-locked via SYMBOL_QUERY_TOOL_NAMES,
    // same source in the assembly entry and symbol.ts)
    assert.ok(seg.includes("find_symbol"), "段含 find_symbol");
    assert.ok(seg.includes("find_declaration"), "段含 find_declaration");
    // grep three-class fallback: grep is explicitly limited to three scenarios (non-code / no symbol name yet / language server unavailable)
    assert.ok(seg.includes("grep"), "段含 grep");
    assert.ok(/fallback/i.test(seg), "段含 fallback 措辞");
    assert.ok(
      /non-code|comments|string literals|configuration/i.test(seg),
      "段含非代码回退场景措辞"
    );
    assert.ok(
      /unknown symbol|still prefer/i.test(seg),
      "段含还没找到符号名回退场景措辞"
    );
    assert.ok(
      /language server (is )?unavailable|retry/i.test(seg),
      "段含语言服务器不可用回退场景措辞"
    );
    // The legacy lsp_* family is no longer listed as a co-equal first choice next to
    // grep. Note: the slice covers only the constraints segment itself — the upstream
    // persona segment (explore prompt) still contains lsp_*, unrelated to this constraint.
    assert.ok(!seg.includes("lsp_"), "段不再列旧 lsp_* 工具引导");
    // Non-grep/read_file paths may still be listed: read_file / glob remain as helpers
    assert.ok(seg.includes("read_file"), "段含 read_file helper");
    assert.ok(seg.includes("glob"), "段含 glob helper");
  });
});

// ─── D. Direct coverage of pure toolConstraintsSegment (renderer form) ─────────

describe("toolConstraintsSegment (#562 T7) 纯函数", () => {
  it("mode='readonly' → 返回含 Tool constraints for this run 标题的非空文本", () => {
    const out = toolConstraintsSegment("readonly");
    assert.ok(out.includes("## Tool constraints for this run"));
    assert.ok(out.length > 100, "段非空");
  });

  it("mode='readonly' → 文本含允许族 + reject + 符号工具优先三类关键字", () => {
    const out = toolConstraintsSegment("readonly");
    // allowed families
    assert.ok(
      out.includes("cat") || out.includes("grep") || out.includes("ls")
    );
    assert.ok(out.includes("git"));
    // reject
    assert.match(out, /reject|not allowed|forbidden|denied/i);
    // symbol-tool preference + grep fallback for the three discoverable classes
    assert.ok(out.includes("find_symbol"), "段含 find_symbol");
    assert.ok(out.includes("find_declaration"), "段含 find_declaration");
    assert.ok(!out.includes("lsp_"), "段不再列旧 lsp_* 工具引导");
  });
});
