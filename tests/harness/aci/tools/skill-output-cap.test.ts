/**
 * tests/harness/aci/tools/skill-output-cap.test.ts
 *
 * ADR-0083 behavior contract: skill bodies bypass the executor's
 * `OUTPUT_HARD_CAP` (20000 chars) fallback gate.
 *
 * Assertions deliberately run through the **real executor**
 * (`createExecutor` + `createRegistry`), not direct handler calls — the
 * exemption is decided by the executor reading the assembly-time declaration
 * on the def; handler-level assertions cannot prove the gate was bypassed.
 *
 *   - Over-long bodies delivered whole: a >20000-char SKILL.md → delivered text
 *     is byte-equal to the `createSkillBody` product, ends with
 *     `</skill_files>`, no truncation marker.
 *   - The gate does not leak: over-long output from a built-in non-exempt tool
 *     (read_file) and from the MCP shape (toAciToolDef product) is still cut to
 *     <= 20000 with the existing marker.
 *   - Failure surface unchanged: unknown name → existing guidance sentence;
 *     SKILL.md read failure → executor `execution_failed`; the exemption never
 *     rewrites it into a silent false success.
 *
 * Environment note: this file assembles the production executor via
 * `buildHarnessEngine`, and that chain goes
 * `createDefaultAciRegistry` → `createBashTool` → `requireBwrap` fail-loud, so
 * it is in the CI --exclude set (runners without bwrap structurally cannot run
 * it; full verification happens locally on WSL). That case is ADR-0083's only
 * evidence of "the production assembly really lands the value" — a hand-built
 * registry must not substitute (it would bypass the assembly chain under test).
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSkillTool } from "../../../../src/harness/aci/tools/skill.js";
import { createReadFileTool } from "../../../../src/harness/aci/tools/read-file.js";
import { toAciToolDef } from "../../../../src/harness/mcp/adapter.js";
import { createAciRegistry } from "../../../../src/harness/aci/aci-registry.js";
import { createExecutor } from "../../../../src/harness/tools/executor.js";
import { createRegistry } from "../../../../src/harness/tools/registry.js";
import {
  createSkillCatalog,
  type SkillEntry,
} from "../../../../src/harness/skill/catalog.js";
import { createSkillBody } from "../../../../src/harness/skill/body.js";
import { buildHarnessEngine } from "../../../../src/harness/build-engine.js";
import { createNoAskUser } from "../../../../src/harness/permission/ask-user.js";
import type { AciToolDef } from "../../../../src/harness/aci/types.js";
import type { RegistryImpl } from "../../../../src/harness/tools/registry.js";
import type { ToolExecutionResult } from "../../../../src/harness/tools/types.js";
import type { CallToolResult } from "@modelcontextprotocol/client";
import type { AnthropicNativeMessage } from "../../../../src/harness/model-adapter/types.js";

/** Fallback-gate threshold (ADR-0006): > 20000 chars → truncate + marker. */
const OUTPUT_HARD_CAP = 20000;

/** Prefix of the existing truncation marker (verbatim from the executor.ts template). */
const TRUNCATION_MARKER = "[executor: 输出超长已截断";

/** Char count of one fixture line (`repeat` counts are derived from target char counts). */
const PROCEDURE_LINE_CHARS = "procedure line\n".length;

/**
 * Line count for the 1MB-grade fixture body: the overflow contract is ">20000
 * char bodies (including 1MB grade)", with 1M chars as the upper bound.
 */
const MEGABYTE_BODY_REPEATS = Math.ceil(1_000_000 / PROCEDURE_LINE_CHARS);

/**
 * Over-long body (frontmatter included) — still > 20000 chars after stripping.
 * `name` is also the scan-time catalog key (the scanner reads the frontmatter
 * name, not the directory name).
 */
function longSkillMarkdown(name: string, repeats = 1800): string {
  const body = `${"procedure line\n".repeat(repeats)}`;
  const raw = `---\nname: ${name}\ndescription: Echo a value\n---\n${body}`;
  assert.ok(
    raw.length > OUTPUT_HARD_CAP,
    `fixture 必须超闸，实际 ${raw.length}`
  );
  return raw;
}

/**
 * Empty-body fixtures — `createSkillBody`'s `if (body.length > 0)` guard omits
 * only the body segment; both skeleton sections must still be present.
 */
const EMPTY_BODY_FIXTURES: ReadonlyArray<readonly [string, string]> = [
  ["fm-only", "---\nname: fm-only\n---\n"],
  ["blank-only", "   \n\n  \n"],
];

function entry(
  overrides: Partial<SkillEntry> & Pick<SkillEntry, "name" | "dir">
): SkillEntry {
  return { description: "default", disabled: false, ...overrides };
}

/** Extract the delivered text of an ok result (the text block of the model-visible tool_result). */
function deliveredText(result: ToolExecutionResult | undefined): string {
  assert.equal(result?.kind, "ok");
  if (result?.kind !== "ok") throw new Error("unreachable");
  const block = result.payload[0];
  assert.equal(block?.type, "text");
  return block?.type === "text" ? block.text : "";
}

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "aci-skill-cap-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function writeSkillDir(name: string, raw: string): Promise<string> {
  const dir = join(scratch, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), raw, "utf8");
  return dir;
}

/** Run the skill tool once through the real executor (optionally with a messages snapshot). */
async function runSkillThroughExecutor(opts: {
  readonly tool: AciToolDef;
  readonly callName?: string;
  readonly input?: unknown;
  readonly messages?: ReadonlyArray<AnthropicNativeMessage>;
}): Promise<ToolExecutionResult | undefined> {
  const registry = createRegistry([opts.tool]);
  const executor = createExecutor(registry);
  const results = await executor.executeAll(
    [
      {
        id: "s1",
        name: opts.callName ?? opts.tool.name,
        input: opts.input ?? { name: "echo" },
      },
    ],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    opts.messages
  );
  return results[0];
}

describe("ADR-0083 SC1 — 超长正文经 executor 完整交付", () => {
  // Composition path (createSkillTool + createExecutor assembled here) — proves
  // the exemption takes effect at the executor's read point, not that the
  // production assembly chain lands it; that is the next case (buildHarnessEngine).
  it("组合路径 >20000 字符 SKILL.md：交付文本与 createSkillBody 产物逐字节相等、无截断标记", async () => {
    const dir = await writeSkillDir("echo", longSkillMarkdown("echo"));
    const tool = createSkillTool({
      catalog: createSkillCatalog([entry({ name: "echo", dir })]),
    });
    const expected = await createSkillBody({
      entry: entry({ name: "echo", dir }),
      dir,
    });

    const text = deliveredText(await runSkillThroughExecutor({ tool }));

    assert.ok(expected.length > OUTPUT_HARD_CAP, "装配产物本身必须超闸");
    assert.equal(text, expected, "交付文本必须与装配产物逐字节相等");
    assert.ok(text.length > OUTPUT_HARD_CAP, `实际 ${text.length} 未超闸`);
    assert.ok(
      text.trimEnd().endsWith("</skill_files>"),
      "末段必须是 </skill_files>"
    );
    assert.equal(text.includes(TRUNCATION_MARKER), false, "不得出现截断标记");
  });

  it(
    "1MB 级正文（spec S2 overflow 上界）：经 executor 完整交付、逐字节相等、无截断标记",
    // Measured locally at ~52ms total for a 1MB body (write + assembly +
    // executeAll). 30s matches the buildHarnessEngine case in this file; it only absorbs runner jitter.
    { timeout: 30_000 },
    async () => {
      const raw = longSkillMarkdown("huge", MEGABYTE_BODY_REPEATS);
      const dir = await writeSkillDir("huge", raw);
      const tool = createSkillTool({
        catalog: createSkillCatalog([entry({ name: "huge", dir })]),
      });
      const expected = await createSkillBody({
        entry: entry({ name: "huge", dir }),
        dir,
      });

      const text = deliveredText(
        await runSkillThroughExecutor({ tool, input: { name: "huge" } })
      );

      // 50x the gate: any "truncate at OUTPUT_HARD_CAP" regression would hit.
      assert.ok(
        expected.length > OUTPUT_HARD_CAP * 50,
        `装配产物须为 MB 级，实际 ${expected.length}`
      );
      assert.equal(text, expected, "MB 级交付必须与装配产物逐字节相等");
      assert.equal(
        text.length,
        expected.length,
        "交付不得短一个字节（截断会改变长度）"
      );
      assert.ok(
        text.trimEnd().endsWith("</skill_files>"),
        "末段必须是 </skill_files>"
      );
      assert.equal(text.includes(TRUNCATION_MARKER), false, "不得出现截断标记");
    }
  );

  it(
    "生产装配（buildHarnessEngine）的 registry 上 skill def 带声明，且真执行路径完整交付",
    { timeout: 30_000 },
    async () => {
      const dir = await writeSkillDir(
        "prod-echo",
        longSkillMarkdown("prod-echo")
      );
      const prevSkillDirs = process.env.IKNOW_SKILL_DIRS;
      // Scan-root injection is one of the scanner's three channels: the tmp
      // fixture enters the catalog this way instead of relying on cwd/.iknow
      // conventions. Also suppress the user-level / project-level scan roots so
      // the assembled surface contains only this fixture (same as
      // tests/session-api/ensure-deps-aci-tools.test.ts).
      const prevHome = process.env.HOME;
      const emptyHome = join(scratch, "home");
      await mkdir(emptyHome, { recursive: true });
      process.env.IKNOW_SKILL_DIRS = join(scratch);
      process.env.HOME = emptyHome;
      try {
        const built = await buildHarnessEngine({
          // Minimal usable IknowEnv (same shape as makeEnv in
          // tests/harness/build-engine.test.ts, placeholder apiKey).
          env: {
            llm: {
              baseUrl: "http://127.0.0.1:9999",
              model: "test-model",
              fallback: [],
              apiKey: "sk-test-adr0083",
              maxOutputTokens: 1024,
              timeoutMs: 60_000,
              temperature: 0,
              thinking: "off",
              thinkingEffort: "",
              stream: "on",
            },
            chat: { showThinking: false },
            web: { searchUrl: undefined, proxy: undefined },
            compress: { contextWindow: 200_000, thresholdTokens: undefined },
            mcp: { connectTimeoutMs: 60_000 },
            subagent: { taskTimeoutMs: undefined },
            workspaceRoot: undefined,
            productRoot: undefined,
          },
          askUser: createNoAskUser(),
          // Pin all three roots to the tmp scratch (same triple as
          // tests/harness/build-engine.test.ts): this case proves the assembly
          // chain lands the value + executor delivery; it must not drag the
          // repo's own mcp.json / .iknow/skills into the scan surface (that
          // would couple the test to workspace content and start unrelated MCP connections).
          sandboxRoot: scratch,
          workspaceRoot: scratch,
          productRoot: scratch,
          // The project identity root doubles as the project-skills scan root;
          // pin it to scratch too, so the repo's own `.iknow/skills` stays out
          // of the catalog (suppresses unrelated stderr and decouples from workspace content).
          projectIdentityRoot: scratch,
          // Identity root / cwd pinned to scratch as well (otherwise
          // resolveSessionRoots falls back to cwd and scans the repo again).
          // cwd is only used on the default path; pinning it keeps the
          // "production assembly" proposition uncontaminated by workspace state.
          cwd: scratch,
          userHome: emptyHome,
          // This case verifies exemptFromOutputCap landing on the **production
          // assembly chain**; overflow ejection / index downgrade are not
          // tested here (see build-engine-tool-overflow.test.ts and
          // disclosure-index-align). Assembly-time countTokens is bypassed; the
          // seam's semantics are in the BuildEngineOpts.skipCountTokens comment.
          skipCountTokens: true,
        });
        try {
          const def = built.deps.registry.get("skill");
          assert.ok(def !== undefined, "生产装配必须含 skill 工具");
          // The core point: the value lands on the production assembly chain
          // (createSkillTool), not only on a test-built def.
          assert.equal(def!.exemptFromOutputCap, true);

          const text = deliveredText(
            await built.deps.executor
              .executeAll([
                { id: "s1", name: "skill", input: { name: "prod-echo" } },
              ])
              .then((r) => r[0])
          );
          const expected = await createSkillBody({
            entry: entry({ name: "prod-echo", dir }),
            dir,
          });
          assert.equal(text, expected);
          assert.ok(text.length > OUTPUT_HARD_CAP);
          assert.equal(text.includes(TRUNCATION_MARKER), false);
        } finally {
          await built.shutdown?.();
        }
      } finally {
        if (prevSkillDirs === undefined) delete process.env.IKNOW_SKILL_DIRS;
        else process.env.IKNOW_SKILL_DIRS = prevSkillDirs;
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
      }
    }
  );
});

describe("ADR-0083 — S2 empty 类：空正文仍装配两段骨架（经真实 executor）", () => {
  it.each(EMPTY_BODY_FIXTURES)(
    "%s：Base directory + <skill_files> 均在，无 panic、无截断标记",
    async (name, raw) => {
      const dir = await writeSkillDir(name, raw);
      const tool = createSkillTool({
        catalog: createSkillCatalog([entry({ name, dir })]),
      });
      const expected = await createSkillBody({
        entry: entry({ name, dir }),
        dir,
      });

      // deliveredText contains assert.equal(result?.kind, "ok") — the
      // machine-checkable form of "no panic" (failure lands as execution_failed, never silent).
      const text = deliveredText(
        await runSkillThroughExecutor({ tool, input: { name } })
      );

      assert.ok(text.includes("Base directory:"), "Base directory 行必须在");
      assert.ok(text.includes("<skill_files>"), "<skill_files> 段必须在");
      assert.ok(text.includes("</skill_files>"), "</skill_files> 必须在");
      assert.equal(text, expected, "空正文交付仍与装配产物逐字节相等");
      assert.equal(text.includes(TRUNCATION_MARKER), false, "不得出现截断标记");
    }
  );

  it("正文段在空正文时被省掉，段间不由空格段落顶替", async () => {
    const dir = await writeSkillDir("fm-only-2", "---\nname: fm-only-2\n---\n");
    const body = await createSkillBody({
      entry: entry({ name: "fm-only-2", dir }),
      dir,
    });

    // Body segment absent → the first section is `Base directory:` (the
    // `if (body.length > 0)` guard in createSkillBody), not "empty string + blank line + ...".
    assert.ok(
      body.startsWith("Base directory:"),
      `实际开头：${body.slice(0, 40)}`
    );
  });
});

describe("ADR-0083 SC3 — 闸不泄漏（非豁免工具仍截断）", () => {
  it("内建 read_file：工具层页预算先收束，交付 <= 20000 且无 executor 二次截断标记（ADR-0006 D4）", async () => {
    // read_file is not exempt (the def carries no declaration below) — but its
    // **precision gate** already bounds every reachable output: explicit limit
    // and whole-file reads share the 16000 cp / 19000 unit page budget, and
    // even a 1MB single-line file is truncated at the tool layer with an
    // explicit note. So delivering through the real executor never triggers the
    // fallback gate — exactly the two non-overlapping layers ADR-0006
    // Decision 4 wants (tool layer governs "how much to read", executor
    // governs "output stays under the cap"), not a bypassed gate. That the
    // executor gate still bites non-exempt tools is proven by the MCP-shape
    // case in this describe (its producer has no tool-layer budget, so output
    // really can exceed the cap).
    const dir = await writeSkillDir("plain", "x".repeat(30_000));
    const file = join(dir, "SKILL.md");
    const tool = createReadFileTool(dir);
    assert.equal(tool.exemptFromOutputCap, undefined, "read_file 不得豁免");

    const results = await createExecutor(createRegistry([tool])).executeAll([
      { id: "r1", name: "read_file", input: { path: file, limit: 2000 } },
    ]);
    const text = deliveredText(results[0]);

    assert.ok(text.length <= OUTPUT_HARD_CAP, `实际 ${text.length} 超闸`);
    assert.ok(
      text.includes("truncated at the page budget"),
      "工具层必须显式标注截断（ADR-0006 D4 无静默截断）"
    );
    assert.equal(
      text.includes(TRUNCATION_MARKER),
      false,
      "工具层已收束的输出不得被 executor 二次截断"
    );
  });

  it("MCP 形态（toAciToolDef 产物）：超长结果仍截断，且经 registerExternal 后声明被剥离", async () => {
    // Structural half: the conversion path drops the declaration (no
    // self-claiming). Behavioral half: the def stored in the real ACI registry
    // carries no declaration → delivered text is still <= 20000 with the existing marker.
    const call = async (): Promise<CallToolResult> => ({
      content: [{ type: "text", text: "m".repeat(30_000) }],
    });
    const external = toAciToolDef({
      server: "server",
      tool: {
        name: "big",
        description: "big",
        inputSchema: { type: "object", additionalProperties: false },
      },
      call,
      timeoutMs: 1234,
    });
    assert.equal(external.exemptFromOutputCap, undefined, "转换路径不落声明");

    const aciRegistry = createAciRegistry([
      createSkillTool({ catalog: createSkillCatalog([]) }),
    ]);
    aciRegistry.registerExternal([external]);
    const stored = aciRegistry.catalog.get(external.name);
    assert.ok(stored !== undefined);
    assert.equal(
      "exemptFromOutputCap" in stored!,
      false,
      "外部源落值必须被剥离"
    );

    const results = await createExecutor(createRegistry([stored!])).executeAll([
      { id: "m1", name: external.name, input: {} },
    ]);
    const text = deliveredText(results[0]);

    assert.ok(text.length <= OUTPUT_HARD_CAP, `实际 ${text.length} 超闸`);
    assert.ok(text.includes(TRUNCATION_MARKER), "既有截断标记必须保留");
  });
});

describe("ADR-0083 SC6 — 失败面不因豁免改写", () => {
  it("未知名：既有引导句（经 executor 交付，不触发装配）", async () => {
    const dir = await writeSkillDir("echo", longSkillMarkdown("echo"));
    const tool = createSkillTool({
      catalog: createSkillCatalog([entry({ name: "echo", dir })]),
    });

    const text = deliveredText(
      await runSkillThroughExecutor({ tool, input: { name: "nope" } })
    );

    assert.ok(text.includes("available_skills"));
    assert.equal(text.includes("Base directory:"), false);
    assert.ok(text.length < OUTPUT_HARD_CAP, "引导句远短于闸值");
  });

  it("catalog miss（catalog 为空）：同样回既有引导句", async () => {
    const tool = createSkillTool({ catalog: createSkillCatalog([]) });

    const text = deliveredText(await runSkillThroughExecutor({ tool }));

    // Same strength as the unknown-name case: the guidance sentence must name
    // `<available_skills>` and carry no assembled form (`Base directory:` is the
    // full-text marker; its presence means assembly happened by mistake).
    assert.ok(text.includes("available_skills"));
    assert.equal(text.includes("Base directory:"), false);
    assert.ok(text.length < OUTPUT_HARD_CAP, "引导句远短于闸值");
  });

  it("SKILL.md 读失败：executor 返 execution_failed（非静默假成功）", async () => {
    const missingDir = join(scratch, "missing");
    const tool = createSkillTool({
      catalog: createSkillCatalog([entry({ name: "echo", dir: missingDir })]),
    });

    const result = await runSkillThroughExecutor({ tool });

    assert.equal(result?.kind, "execution_failed");
    if (result?.kind !== "execution_failed") throw new Error("unreachable");
    assert.ok(result.message.length > 0);
  });

  it("失败后同波再调重装配：预记回滚，不静默假成功", async () => {
    const dir = join(scratch, "recover");
    const tool = createSkillTool({
      catalog: createSkillCatalog([entry({ name: "echo", dir })]),
    });
    const ctx = { turnId: "turn-fail" };
    await assert.rejects(async () => {
      await tool.handler({ name: "echo" }, ctx);
    });

    await writeSkillDir("recover", "# recovered body\n");
    const out = (await tool.handler({ name: "echo" }, ctx)) as string;
    assert.ok(out.includes("# recovered body"));
    assert.equal(out.includes("already in context"), false);
  });
});

describe("ADR-0083 — 声明不进 prompt schema / 不跨工具面漂移", () => {
  it("豁免声明不出现在模型可见的 inputSchema 或 description 上", () => {
    const tool = createSkillTool({ catalog: createSkillCatalog([]) });

    expect(JSON.stringify(tool.inputSchema)).not.toContain(
      "exemptFromOutputCap"
    );
    expect(tool.description).not.toContain("exemptFromOutputCap");
  });
});

/** Read point for built-in defs' declaration in the registry (same source as this file's production-assembly case). */
describe("ADR-0083 — registry 冻结快照保留声明", () => {
  it("createRegistry 冻结后 def 上声明仍可读（executor 走注册表路径）", () => {
    const tool = createSkillTool({ catalog: createSkillCatalog([]) });
    const registry: RegistryImpl = createRegistry([tool]);

    assert.equal(registry.get("skill")?.exemptFromOutputCap, true);
  });
});
