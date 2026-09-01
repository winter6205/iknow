/**
 * #562 T7 — Tool constraints prompt 段注入 readonly worker
 * (mirror #556 persona/addendum seam, #562 readonly validator 双层强制之
 *  一:validator + fence EROFS 是内层, prompt 段是外层引导)。
 *
 * Acceptance (plan T7):
 *   - readonly worker (role=explore, bashMode="readonly") → deps.system
 *     含 "Tool constraints for this run" 段, 位置在 persona 之后, LOCKED
 *     6 段不动 (identity < soul < usage < user_profile < bootstrap < memory_layer);
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

/** 从装配后的 system 文本里切出 "## Tool constraints for this run" 段
 *  (到下一个 "## " 标题或字符串末尾止)。persona 段 (含 explore 的 "lsp_*"
 *  提示) 与本段无关,内容级断言必须只针对切出来的段,否则会假阳。
 *  返回 "" 表示未装配该段。 */
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

// ─── B. 段位置 (LOCKED 6 段不动, persona 之后, addendum 关系可选) ─────────────

describe("tool constraints segment: 段位置 (LOCKED 6 段不动)", () => {
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

  it("段内容反映符号工具优先 + grep 三类回退（不列 lsp_* 作为同等首选）", async () => {
    const deps = await createWorkerDeps(hermeticOpts({ role: "explore" }));
    const out = (await deps.system?.()) ?? "";
    const seg = sliceConstraintsSegment(out);
    assert.ok(seg.length > 0, "constraints 段已切出");
    // 符号工具优先:10 件新符号查询工具至少要列 find_symbol 与 find_declaration
    // (其余 8 件由 SYMBOL_QUERY_TOOL_NAMES 锁名,组装入口与 symbol.ts 同源)
    assert.ok(seg.includes("find_symbol"), "段含 find_symbol");
    assert.ok(seg.includes("find_declaration"), "段含 find_declaration");
    // grep 三类回退:明示 grep 仅限三类场景 (非代码 / 还没找到符号名 / 语言服务器不可用)
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
    // 旧 lsp_* 不再与 grep 并列成同等首选(spec SC8)。注意:切片只看
    // constraints 段本身 —— 上游 persona 段(explore 提示词)仍含 lsp_*,
    // 与本约束无关。
    assert.ok(!seg.includes("lsp_"), "段不再列旧 lsp_* 工具引导");
    // 非 grep/read_file 路径仍可列:read_file / glob 保留作 helper
    assert.ok(seg.includes("read_file"), "段含 read_file helper");
    assert.ok(seg.includes("glob"), "段含 glob helper");
  });
});

// ─── D. 纯函数 toolConstraintsSegment 直接覆盖 (renderer 形态) ───────────────

describe("toolConstraintsSegment (#562 T7) 纯函数", () => {
  it("mode='readonly' → 返回含 Tool constraints for this run 标题的非空文本", () => {
    const out = toolConstraintsSegment("readonly");
    assert.ok(out.includes("## Tool constraints for this run"));
    assert.ok(out.length > 100, "段非空");
  });

  it("mode='readonly' → 文本含允许族 + reject + 符号工具优先三类关键字", () => {
    const out = toolConstraintsSegment("readonly");
    // 允许族
    assert.ok(
      out.includes("cat") || out.includes("grep") || out.includes("ls")
    );
    assert.ok(out.includes("git"));
    // reject
    assert.match(out, /reject|not allowed|forbidden|denied/i);
    // 符号工具优先 + grep 三类回退(spec SC8)
    assert.ok(out.includes("find_symbol"), "段含 find_symbol");
    assert.ok(out.includes("find_declaration"), "段含 find_declaration");
    assert.ok(!out.includes("lsp_"), "段不再列旧 lsp_* 工具引导");
  });
});
