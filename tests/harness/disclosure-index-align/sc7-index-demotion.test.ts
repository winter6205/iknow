/**
 * T5 / ADR-0046 Decision 2 + spec disclosure-index-align Does #6 / SC7 —
 * MCP + skill 索引降档「仅剥描述」。
 *
 * 钉住的不变式:
 *   1. 闸门 = `<mcp_name_directory>` + `<available_skills>` 两段**合计**超
 *      端点 contextWindow 的 10%(countTokens 实测,禁 chars/4)。
 *   2. 降档动作 = 从大到小(按各自索引条目渲染体积)剥描述只留名。
 *      **名字永不删**、段永不缺席。
 *   3. `<deferred_internal_tools>`(退场内建件,T4 名+描述形态)不参与剥描述。
 *   4. 剥光仍超阈 → 接受超阈、不删名、不剥内建描述。
 *   5. countTokens 失败 → 跳过本会话 + `console.warn`,两段保持带描述形态。
 *   6. 降档结果首轮定稿、会话内恒定 → 相邻轮 system deep-equal(SC2)。
 *
 * 判定层单测(纯逻辑,无装配)在本文件前半;build-engine wire 形态在后半。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runIndexDemotion,
  renderIndexText,
  type IndexDemotionInput,
} from "../../../src/harness/identity/index-demotion.ts";
import {
  mcpNameDirectorySegment,
  shortToolDescription,
  skillsSegment,
  type McpServiceSummary,
  type SkillSummary,
} from "../../../src/harness/identity/assemble.ts";
import {
  buildHarnessEngine,
  type BuiltEngine,
} from "../../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../../src/harness/permission/ask-user.ts";
import type { IknowEnv } from "../../../src/config/env.ts";
import type { McpClientHandle } from "../../../src/harness/mcp/manager.js";
import type { Tool as McpTool } from "@modelcontextprotocol/client";

// ---------------------------------------------------------------------------
// 判定层 fixtures
// ---------------------------------------------------------------------------

function svc(
  name: string,
  tools: ReadonlyArray<{ name: string; description?: string }>
): McpServiceSummary {
  return {
    name,
    state: "connected",
    tools: tools.map((t) => ({
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
    })),
  };
}

/** 判定入参装配:threshold + countTokens 由用例控制。 */
function input(
  over: Partial<IndexDemotionInput> & Pick<IndexDemotionInput, "countTokens">
): IndexDemotionInput {
  return {
    mcp: [],
    skills: [],
    threshold: 100,
    ...over,
  };
}

describe("T5 SC7 — runIndexDemotion 判定层(纯逻辑)", () => {
  it("无可剥条目(全部裸名 + 空 skills)→ no_index,零 countTokens 调用,数据原样", async () => {
    let calls = 0;
    const mcp = [svc("svc", [{ name: "mcp__svc__a" }])];
    const out = await runIndexDemotion(
      input({
        mcp,
        skills: [],
        countTokens: async () => {
          calls += 1;
          return 9_999;
        },
      })
    );
    assert.equal(out.reason, "no_index");
    assert.equal(calls, 0, "无可剥条目 → 不必实测(阈值判定无意义)");
    assert.deepEqual(out.mcp, mcp);
    assert.deepEqual(out.demoted, []);
  });

  it("未超阈 → no_overflow,描述全留,只测一次", async () => {
    let calls = 0;
    const mcp = [svc("svc", [{ name: "mcp__svc__a", description: "does a" }])];
    const skills: ReadonlyArray<SkillSummary> = [
      { name: "alpha", description: "first" },
    ];
    const out = await runIndexDemotion(
      input({
        mcp,
        skills,
        threshold: 10_000,
        countTokens: async () => {
          calls += 1;
          return 50;
        },
      })
    );
    assert.equal(out.reason, "no_overflow");
    assert.equal(calls, 1);
    assert.deepEqual(out.mcp, mcp);
    assert.deepEqual(out.skills, skills);
    assert.deepEqual(out.demoted, []);
  });

  it("超阈 → 从大到小剥:体积悬殊的两条目里大者先被剥,退到 ≤ 阈值即停", async () => {
    // 条目体积:big 行 ≫ small 行 → big 先剥;剥 1 件后实测降到阈值内 → 停,
    // small 的描述保留(证明"从大到小"而非全剥)。
    const measurements = [500, 80];
    let idx = 0;
    const out = await runIndexDemotion(
      input({
        mcp: [
          svc("svc", [
            { name: "mcp__svc__big", description: "B".repeat(100) },
            { name: "mcp__svc__small", description: "s" },
          ]),
        ],
        threshold: 100,
        countTokens: async () => {
          const v = measurements[idx];
          idx += 1;
          if (v === undefined) throw new Error("countTokens: out of fixtures");
          return v;
        },
      })
    );
    assert.equal(out.reason, "demoted");
    assert.deepEqual(out.demoted, ["mcp__svc__big"]);
    assert.equal(idx, 2, "1 次首测 + 1 次剥后重测");
    const tools = out.mcp[0]!.tools;
    const big = tools.find((t) => t.name === "mcp__svc__big")!;
    const small = tools.find((t) => t.name === "mcp__svc__small")!;
    // 大者剥成仅名字:description 缺席,但**名字仍在**。
    assert.equal(big.description, undefined);
    assert.equal(big.name, "mcp__svc__big");
    // 小者未被剥。
    assert.equal(small.description, "s");
  });

  it("MCP 与 skill 条目同池排序:跨两类都按体积从大到小剥", async () => {
    const measurements = [900, 800, 700, 50];
    let idx = 0;
    const out = await runIndexDemotion(
      input({
        mcp: [
          svc("svc", [
            { name: "mcp__svc__mid", description: "M".repeat(40) },
            { name: "mcp__svc__tiny", description: "t" },
          ]),
        ],
        skills: [
          { name: "huge", description: "H".repeat(120) },
          { name: "large", description: "L".repeat(60) },
        ],
        threshold: 100,
        countTokens: async () => {
          const v = measurements[idx];
          idx += 1;
          if (v === undefined) throw new Error("countTokens: out of fixtures");
          return v;
        },
      })
    );
    assert.equal(out.reason, "demoted");
    // 体积序:huge(120) > large(60) > mid(40) > tiny(1)
    assert.deepEqual(out.demoted, ["huge", "large", "mcp__svc__mid"]);
    // 未被剥的 tiny 仍带描述;被剥的三条名字都还在。
    const tools = out.mcp[0]!.tools;
    assert.equal(
      tools.find((t) => t.name === "mcp__svc__tiny")!.description,
      "t"
    );
    assert.equal(
      tools.find((t) => t.name === "mcp__svc__mid")!.description,
      undefined
    );
    const byName = new Map(out.skills.map((s) => [s.name, s]));
    assert.equal(byName.get("huge")!.description, undefined);
    assert.equal(byName.get("large")!.description, undefined);
    assert.deepEqual(
      [...byName.keys()].sort(),
      ["huge", "large"],
      "skill 名字永不删"
    );
  });

  it("剥光仍超阈 → 接受超阈、不删名、reason 仍为 demoted", async () => {
    let calls = 0;
    const out = await runIndexDemotion(
      input({
        mcp: [svc("svc", [{ name: "mcp__svc__a", description: "aaa" }])],
        skills: [{ name: "alpha", description: "bbb" }],
        threshold: 10,
        countTokens: async () => {
          calls += 1;
          return 5_000; // 恒超阈
        },
      })
    );
    assert.equal(out.reason, "demoted");
    assert.deepEqual(out.demoted.slice().sort(), ["alpha", "mcp__svc__a"]);
    assert.equal(calls, 3, "1 首测 + 2 次剥后重测(候选池剥光)");
    // 名字全在,描述全无。
    assert.deepEqual(
      out.mcp[0]!.tools.map((t) => t.name),
      ["mcp__svc__a"]
    );
    assert.equal(out.mcp[0]!.tools[0]!.description, undefined);
    assert.deepEqual(
      out.skills.map((s) => s.name),
      ["alpha"]
    );
    assert.equal(out.skills[0]!.description, undefined);
    // 段仍渲染(名字在 = 段不缺席)。
    const text = renderIndexText(out.mcp, out.skills);
    assert.ok(text.includes("mcp__svc__a"));
    assert.ok(text.includes("alpha"));
  });

  it("首测 countTokens 失败 → countTokens_failed,数据原样(描述全留)", async () => {
    const mcp = [svc("svc", [{ name: "mcp__svc__a", description: "aaa" }])];
    const skills: ReadonlyArray<SkillSummary> = [
      { name: "alpha", description: "bbb" },
    ];
    const out = await runIndexDemotion(
      input({
        mcp,
        skills,
        countTokens: async () => {
          throw new Error("network down");
        },
      })
    );
    assert.equal(out.reason, "countTokens_failed");
    assert.deepEqual(out.mcp, mcp);
    assert.deepEqual(out.skills, skills);
    assert.deepEqual(out.demoted, []);
    assert.ok(out.cause instanceof Error);
  });

  it("剥途中 countTokens 失败 → 全量跳过(数据原样),不留半剥态", async () => {
    const measurements = [900];
    let idx = 0;
    const mcp = [
      svc("svc", [
        { name: "mcp__svc__big", description: "B".repeat(80) },
        { name: "mcp__svc__small", description: "s" },
      ]),
    ];
    const out = await runIndexDemotion(
      input({
        mcp,
        threshold: 100,
        countTokens: async () => {
          const v = measurements[idx];
          idx += 1;
          if (v === undefined) throw new Error("mid-loop failure");
          return v;
        },
      })
    );
    assert.equal(out.reason, "countTokens_failed");
    assert.deepEqual(out.mcp, mcp, "半剥态不落地 —— 失败 = 跳过本会话");
    assert.deepEqual(out.demoted, []);
  });

  it("非有限数 / 负数实测 → 同失败语义(跳过)", async () => {
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      const out = await runIndexDemotion(
        input({
          mcp: [svc("svc", [{ name: "mcp__svc__a", description: "aaa" }])],
          countTokens: async () => bad,
        })
      );
      assert.equal(out.reason, "countTokens_failed", `bad=${bad}`);
      assert.equal(out.mcp[0]!.tools[0]!.description, "aaa");
    }
  });

  it("disabled skill 不进候选(与 skillsSegment 过滤同源)", async () => {
    let calls = 0;
    const out = await runIndexDemotion(
      input({
        skills: [{ name: "hidden", description: "secret", disabled: true }],
        countTokens: async () => {
          calls += 1;
          return 9_999;
        },
      })
    );
    assert.equal(out.reason, "no_index");
    assert.equal(calls, 0);
  });

  it("非 connected 服务不进候选(与 mcpNameDirectorySegment 过滤同源)", async () => {
    let calls = 0;
    const out = await runIndexDemotion(
      input({
        mcp: [
          {
            name: "dead",
            state: "failed",
            tools: [{ name: "mcp__dead__a", description: "aaa" }],
          },
        ],
        countTokens: async () => {
          calls += 1;
          return 9_999;
        },
      })
    );
    assert.equal(out.reason, "no_index");
    assert.equal(calls, 0);
  });

  it("renderIndexText = 两段渲染 SSOT 的拼接(不含 deferred_internal_tools)", () => {
    const mcp = [svc("svc", [{ name: "mcp__svc__a", description: "aaa" }])];
    const skills: ReadonlyArray<SkillSummary> = [
      { name: "alpha", description: "bbb" },
    ];
    const text = renderIndexText(mcp, skills);
    assert.ok(text.includes(mcpNameDirectorySegment(mcp)!));
    assert.ok(text.includes(skillsSegment(skills)));
    assert.ok(!text.includes("deferred_internal_tools"));
  });
});

// ---------------------------------------------------------------------------
// build-engine wire(与 build-engine-tool-overflow.test.ts 同款装配)
// ---------------------------------------------------------------------------

function makeEnv(apiKey: string): IknowEnv {
  return {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      fallback: [],
      apiKey,
      maxOutputTokens: 1024,
      timeoutMs: 60_000,
      temperature: 0,
      thinking: "off",
      thinkingEffort: "",
      stream: "on",
    },
    chat: { showThinking: false },
    web: { searchUrl: undefined, proxy: undefined },
    // contextWindow = 20_000 → 阈值 2_000(10%)。
    compress: { contextWindow: 20_000, thresholdTokens: undefined },
    mcp: { connectTimeoutMs: 60_000 },
    subagent: { taskTimeoutMs: undefined },
  };
}

function makeInstantClient(tools: readonly McpTool[]): McpClientHandle {
  return {
    connect: async () => {},
    listTools: async () => tools,
    callTool: async () => ({ result: { content: [] } }),
    close: async () => {},
    onListChanged: () => {},
    onClose: () => {},
    listResources: async () => ({ resources: [] }),
    readResource: async () => ({ contents: [] }),
  };
}

async function plantMcpConfig(cwd: string, servers: string[]): Promise<void> {
  const entries = servers
    .map((name) => `"${name}": { "type": "stdio", "command": "node" }`)
    .join(", ");
  await mkdir(join(cwd, ".iknow"), { recursive: true });
  await writeFile(
    join(cwd, ".iknow", "mcp.json"),
    `{ "mcpServers": { ${entries} } }`,
    "utf8"
  );
}

/** fixture skill:<root>/.iknow/skills/<name>/SKILL.md(与 e2e 同法)。 */
async function plantSkill(
  root: string,
  name: string,
  description: string
): Promise<void> {
  const dir = join(root, ".iknow", "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nbody of ${name}\n`,
    "utf8"
  );
}

const roots: string[] = [];
const shutdowns: Array<() => Promise<void>> = [];
const warnings: string[] = [];
const originalWarn = console.warn;

beforeEach(() => {
  warnings.length = 0;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
});

afterEach(async () => {
  console.warn = originalWarn;
  await Promise.all(shutdowns.splice(0).map((f) => f()));
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))
  );
});

function track(built: BuiltEngine): BuiltEngine {
  shutdowns.push(async () => {
    if (built.shutdown) await built.shutdown();
  });
  return built;
}

describe("T5 SC7 — build-engine wire:索引降档", () => {
  it("索引超阈 → MCP 工具行与 skill 行剥成仅名字(名仍在、段不缺席)", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t5-demote-"));
    roots.push(root);
    await plantMcpConfig(root, ["stubsvc"]);
    await plantSkill(root, "bigskill", "S".repeat(200));

    // 第 1 次 = 内建 schema 判定(1_000 ≤ 2_000 → no_overflow,零退场);
    // 之后是索引闸门:首测 9_000 超阈 → 逐件剥,每剥重测,末次 100 ≤ 阈值。
    const measurements = [1_000, 9_000, 8_000, 7_000, 100];
    let idx = 0;
    const built = track(
      await buildHarnessEngine({
        env: makeEnv("sk-test-t5-demote"),
        askUser: createNoAskUser(),
        surface: "chat",
        userHome: join(root, "home"),
        cwd: root,
        createMcpClient: () =>
          makeInstantClient([
            {
              name: "alpha",
              description: "A".repeat(100),
              inputSchema: { type: "object", properties: {} },
            },
            {
              name: "beta",
              description: "B".repeat(60),
              inputSchema: { type: "object", properties: {} },
            },
          ]),
        countTokens: async () => {
          const v = measurements[idx];
          idx += 1;
          if (v === undefined) throw new Error("countTokens: out of fixtures");
          return { inputTokens: v };
        },
      })
    );

    const systemText = await built.deps.system?.();
    expect(systemText).toBeDefined();
    // 两段都在(名字永不删 → 段永不缺席)。
    expect(systemText).toContain("<mcp_name_directory>");
    expect(systemText).toContain("<available_skills>");
    // 被降档的三条(bigskill 200 > alpha 100 > beta 60)剥成仅名字。
    expect(systemText).toMatch(/^- mcp__stubsvc__alpha$/m);
    expect(systemText).toMatch(/^- mcp__stubsvc__beta$/m);
    expect(systemText).toMatch(/^bigskill$/m);
    // 描述正文不再出现。
    expect(systemText).not.toContain("A".repeat(100));
    expect(systemText).not.toContain("S".repeat(200));
  }, 30_000);

  it("剥光仍超阈 → 接受超阈,名字全在,退场内建段仍带描述(不参与剥)", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t5-ceiling-"));
    roots.push(root);
    await plantMcpConfig(root, ["stubsvc"]);
    await plantSkill(root, "someskill", "skill description text");

    // 恒超阈:内建 schema 判定退光 5 件;索引闸门也剥光候选池。
    const built = track(
      await buildHarnessEngine({
        env: makeEnv("sk-test-t5-ceiling"),
        askUser: createNoAskUser(),
        surface: "chat",
        userHome: join(root, "home"),
        cwd: root,
        createMcpClient: () =>
          makeInstantClient([
            {
              name: "alpha",
              description: "alpha tool description",
              inputSchema: { type: "object", properties: {} },
            },
          ]),
        countTokens: async () => ({ inputTokens: 50_000 }),
      })
    );

    const systemText = await built.deps.system?.();
    expect(systemText).toBeDefined();
    // 索引名字全在。
    expect(systemText).toMatch(/^- mcp__stubsvc__alpha$/m);
    expect(systemText).toMatch(/^someskill$/m);
    expect(systemText).not.toContain("alpha tool description");
    expect(systemText).not.toContain("skill description text");

    // 退场内建段在场且**仍带描述**(ADR-0046 Decision 2:退场件不参与剥)。
    expect(systemText).toContain("<deferred_internal_tools>");
    const segment = systemText!.slice(
      systemText!.indexOf("<deferred_internal_tools>"),
      systemText!.indexOf("</deferred_internal_tools>")
    );
    const catalog = built.catalog;
    expect(catalog).toBeDefined();
    for (const retired of ["query_trace", "web_fetch"]) {
      const def = catalog!.get(retired);
      expect(def, `${retired} 应仍在 catalog`).toBeDefined();
      const short = shortToolDescription(def!.description);
      expect(short).toBeDefined();
      expect(segment).toContain(`- ${retired}: ${short}`);
    }
  }, 30_000);

  it("countTokens 失败 → 跳过降档 + warn,两段保持带描述形态", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t5-ctfail-"));
    roots.push(root);
    await plantMcpConfig(root, ["stubsvc"]);
    await plantSkill(root, "someskill", "skill description text");

    const built = track(
      await buildHarnessEngine({
        env: makeEnv("sk-test-t5-ctfail"),
        askUser: createNoAskUser(),
        surface: "chat",
        userHome: join(root, "home"),
        cwd: root,
        createMcpClient: () =>
          makeInstantClient([
            {
              name: "alpha",
              description: "alpha tool description",
              inputSchema: { type: "object", properties: {} },
            },
          ]),
        countTokens: async () => {
          throw new Error("network down");
        },
      })
    );

    const systemText = await built.deps.system?.();
    // 描述保留(降档跳过)。
    expect(systemText).toContain(
      "- mcp__stubsvc__alpha: alpha tool description"
    );
    expect(systemText).toContain("someskill: skill description text");
    // warn 一行,显式指名索引降档被跳过。
    expect(
      warnings.some((w) => w.includes("index demotion skipped")),
      `warnings=${JSON.stringify(warnings)}`
    ).toBe(true);
  }, 30_000);

  it("未超阈 → 零降档,描述全留", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t5-under-"));
    roots.push(root);
    await plantMcpConfig(root, ["stubsvc"]);
    await plantSkill(root, "someskill", "skill description text");

    const built = track(
      await buildHarnessEngine({
        env: makeEnv("sk-test-t5-under"),
        askUser: createNoAskUser(),
        surface: "chat",
        userHome: join(root, "home"),
        cwd: root,
        createMcpClient: () =>
          makeInstantClient([
            {
              name: "alpha",
              description: "alpha tool description",
              inputSchema: { type: "object", properties: {} },
            },
          ]),
        countTokens: async () => ({ inputTokens: 100 }),
      })
    );

    const systemText = await built.deps.system?.();
    expect(systemText).toContain(
      "- mcp__stubsvc__alpha: alpha tool description"
    );
    expect(systemText).toContain("someskill: skill description text");
    expect(systemText).not.toContain("<deferred_internal_tools>");
  }, 30_000);

  it("降档后相邻轮 tools + system deep-equal(SC2:首轮定稿、会话内恒定)", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t5-stable-"));
    roots.push(root);
    await plantMcpConfig(root, ["stubsvc"]);
    await plantSkill(root, "bigskill", "S".repeat(200));

    let calls = 0;
    const built = track(
      await buildHarnessEngine({
        env: makeEnv("sk-test-t5-stable"),
        askUser: createNoAskUser(),
        surface: "chat",
        userHome: join(root, "home"),
        cwd: root,
        createMcpClient: () =>
          makeInstantClient([
            {
              name: "alpha",
              description: "A".repeat(100),
              inputSchema: { type: "object", properties: {} },
            },
          ]),
        countTokens: async () => {
          calls += 1;
          return { inputTokens: 50_000 };
        },
      })
    );

    const callsAfterAssembly = calls;
    const system1 = await built.deps.system?.();
    const tools1 = built.deps.promptTools();
    const system2 = await built.deps.system?.();
    const tools2 = built.deps.promptTools();
    assert.deepEqual(system2, system1);
    assert.deepEqual(tools2, tools1);
    // 装配后不再实测(首轮一次)。
    expect(calls).toBe(callsAfterAssembly);
    // 降档确实发生过(否则本用例不测到降档态的稳定性)。
    expect(system1).toMatch(/^- mcp__stubsvc__alpha$/m);
  }, 30_000);
});
