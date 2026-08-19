/**
 * #562 T7 — Tool constraints prompt 段注入 readonly worker
 * (mirror #556 persona/addendum seam, #562 readonly validator 双层强制之
 *  一:validator + fence EROFS 是内层, prompt 段是外层引导)。
 *
 * Acceptance (plan T7):
 *   - readonly worker (role=explore, bashMode="readonly") → deps.system
 *     含 "Tool constraints for this run" 段, 位置在 persona 之后, LOCKED
 *     5 段不动 (identity < soul < user_profile < bootstrap < memory_layer);
 *   - 非 readonly worker (role=general-purpose / role 缺省 / role 未知) →
 *     无该段 (V1 baseline / V1 fallback, byte-stable);
 *   - 段内容 = 允许命令族 (coreutils 读族 / git 只读子命令 / rg / jq) +
 *     显式 reject 行为 + 替代工具引导 (read_file / grep / glob / lsp_*)。
 *   - 段位置可选两种形态, 本实现选 persona → constraints → addendum
 *     (constraints 是 persona 的 mode 延伸, addendum 是用户后置追加)。
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
    thinking: { type: "disabled" },
    maxTurns: undefined,
    timeoutMs: undefined,
  },
  web: { proxy: undefined, searchUrl: undefined },
  compress: { contextWindow: 200000, thresholdTokens: undefined },
  chat: { showThinking: false, quiet: false },
};

/** hermetic createWorkerDeps 装配: stub-model + 空 skill + noop trace + 占位 system。 */
function hermeticOpts(
  extra?: Partial<CreateWorkerDepsOptions>
): CreateWorkerDepsOptions {
  return {
    env: TEST_ENV,
    sandboxRoot: "/tmp/sb",
    model: createStubModel({ responses: [] }),
    skillCatalog: createSkillCatalog([]),
    system: () => undefined,
    trace: createNoopTraceService(),
    ...extra,
  };
}

const CONSTRAINTS_HEADER = "Tool constraints for this run";

// ─── A. 触发条件 (bashMode 决定是否注入) ───────────────────────────────────────

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

// ─── B. 段位置 (LOCKED 5 段不动, persona 之后, addendum 关系可选) ─────────────

describe("tool constraints segment: 段位置 (LOCKED 5 段不动)", () => {
  it("readonly worker → Tool constraints 段位置在 persona (catalog body) 之后", async () => {
    const deps = await createWorkerDeps(hermeticOpts({ role: "explore" }));
    const out = (await deps.system?.()) ?? "";
    const personaIdx = out.indexOf(getAgentEntry("explore").body);
    const constraintsIdx = out.indexOf(CONSTRAINTS_HEADER);
    assert.ok(personaIdx >= 0, "persona 段存在");
    assert.ok(constraintsIdx > personaIdx, "constraints 在 persona 之后");
  });

  it("readonly worker + addendum → 顺序 persona < constraints < addendum", async () => {
    const deps = await createWorkerDeps(
      hermeticOpts({ role: "explore", addendum: "MY ADDENDUM" })
    );
    const out = (await deps.system?.()) ?? "";
    const personaIdx = out.indexOf(getAgentEntry("explore").body);
    const constraintsIdx = out.indexOf(CONSTRAINTS_HEADER);
    const addendumIdx = out.indexOf("MY ADDENDUM");
    assert.ok(personaIdx >= 0);
    assert.ok(constraintsIdx > personaIdx);
    assert.ok(addendumIdx > constraintsIdx, "addendum 在 constraints 之后");
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

// ─── C. 段内容 (允许族 / reject / 替代工具引导) ───────────────────────────────

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

  it("段内容含替代工具引导 (read_file / grep / glob / lsp_*)", async () => {
    const deps = await createWorkerDeps(hermeticOpts({ role: "explore" }));
    const out = (await deps.system?.()) ?? "";
    assert.ok(out.includes("read_file"), "段含 read_file 引导");
    assert.ok(out.includes("grep"), "段含 grep 引导");
    assert.ok(out.includes("glob"), "段含 glob 引导");
    assert.ok(out.includes("lsp_"), "段含 lsp_* 工具引导");
  });
});

// ─── D. 纯函数 toolConstraintsSegment 直接覆盖 (renderer 形态) ───────────────

describe("toolConstraintsSegment (#562 T7) 纯函数", () => {
  it("mode='readonly' → 返回含 Tool constraints for this run 标题的非空文本", () => {
    const out = toolConstraintsSegment("readonly");
    assert.ok(out.includes("## Tool constraints for this run"));
    assert.ok(out.length > 100, "段非空");
  });

  it("mode='readonly' → 文本含允许族 + reject + 替代工具三类关键字", () => {
    const out = toolConstraintsSegment("readonly");
    // 允许族
    assert.ok(
      out.includes("cat") || out.includes("grep") || out.includes("ls")
    );
    assert.ok(out.includes("git"));
    // reject
    assert.match(out, /reject|not allowed|forbidden|denied/i);
    // 替代工具
    assert.ok(out.includes("read_file"));
    assert.ok(out.includes("lsp_"));
  });
});
