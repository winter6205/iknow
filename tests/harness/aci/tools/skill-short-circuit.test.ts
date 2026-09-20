/**
 * tests/harness/aci/tools/skill-short-circuit.test.ts
 *
 * skill() second-call short circuit. Behavior contract:
 *   - visible messages already hold a successful full-body tool_result for this name
 *     (the assembled form carrying both `Base directory:` and `</skill_files>` markers)
 *     → reply with only the short receipt;
 *   - compact dropped that entry / history snapshot absent → fail-closed: load the full
 *     body again (never pretend it is already loaded);
 *   - the second same-name call within one wave (same turnId) also short-circuits, via the
 *     wave map (the same wave's tool_result is not yet in history, invisible to a snapshot alone);
 *   - an unknown-name guidance line counts as neither loaded nor enters the wave map;
 *   - the short receipt itself is not the full body (no marker pair), so a "receipt only"
 *     history triggers a full reload again.
 * The gate covers only the ACI `skill()` handler; slash / Web do not take this path.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSkillCatalog,
  type SkillEntry,
} from "../../../../src/harness/skill/catalog.js";
import {
  createSkillTool,
  hasVisibleFullSkillBody,
} from "../../../../src/harness/aci/tools/skill.js";
import type { AciToolDef } from "../../../../src/harness/aci/types.js";
import type { ToolExecutionContext } from "../../../../src/harness/tools/types.js";
import { createRegistry } from "../../../../src/harness/tools/registry.js";
import { createExecutor } from "../../../../src/harness/tools/executor.js";
import { run } from "../../../../src/harness/loop-engine.js";
import { createStubModel } from "../../../../src/harness/stubs/stub-model.js";
import { assistantResult } from "../../../cli/_fixtures.js";
import type { AnthropicNativeMessage } from "../../../../src/harness/model-adapter/types.js";

function entry(
  overrides: Partial<SkillEntry> & Pick<SkillEntry, "name" | "dir">
): SkillEntry {
  return {
    description: "default",
    disabled: false,
    ...overrides,
  };
}

async function invokeSkill(
  tool: AciToolDef,
  input: unknown,
  ctx?: ToolExecutionContext
): Promise<string> {
  return (await tool.handler(input, ctx)) as string;
}

/** Full-body sample in the assembled form (both markers present). */
const FULL_BODY_SAMPLE = [
  "# echo body",
  "follow the steps above",
  "",
  "Base directory: /tmp/somewhere/echo",
  "",
  "<skill_files>",
  "/tmp/somewhere/echo/a.md",
  "</skill_files>",
].join("\n");

/** Unknown-name guidance line sample (carries neither marker). */
const GUIDANCE_SAMPLE =
  "skill 'echo' not found. Pick the name from the `<available_skills>` list in the system prompt.";

/** One message pair (assistant tool_use + user tool_result). */
function skillPair(
  toolUseId: string,
  name: string,
  resultText: string,
  opts?: { readonly isError?: boolean }
): ReadonlyArray<AnthropicNativeMessage> {
  return [
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: toolUseId, name: "skill", input: { name } },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: [{ type: "text", text: resultText }],
          ...(opts?.isError ? { is_error: true } : {}),
        },
      ],
    },
  ];
}

function textMessage(
  role: "user" | "assistant",
  text: string
): AnthropicNativeMessage {
  return { role, content: [{ type: "text", text }] };
}

describe("recognizer — 可见历史全文判据 hasVisibleFullSkillBody", () => {
  it("该名 skill 的非 error tool_result 双标记齐全 → true", () => {
    const messages = [
      textMessage("user", "go"),
      ...skillPair("t1", "echo", FULL_BODY_SAMPLE),
    ];
    expect(hasVisibleFullSkillBody(messages, "echo")).toBe(true);
  });

  it("只有引导句（未知名历史）→ false", () => {
    const messages = [
      textMessage("user", "go"),
      ...skillPair("t1", "echo", GUIDANCE_SAMPLE),
    ];
    expect(hasVisibleFullSkillBody(messages, "echo")).toBe(false);
  });

  it("只有短回执 → false（回执无双标记，不会被误认成全文）", () => {
    const receipt =
      "The full body of skill 'echo' is already present in the visible context. Do not call skill() again.";
    const messages = [
      textMessage("user", "go"),
      ...skillPair("t1", "echo", receipt),
    ];
    expect(hasVisibleFullSkillBody(messages, "echo")).toBe(false);
  });

  it("is_error: true 的 tool_result 即使双标记齐全 → false", () => {
    const messages = [
      textMessage("user", "go"),
      ...skillPair("t1", "echo", FULL_BODY_SAMPLE, { isError: true }),
    ];
    expect(hasVisibleFullSkillBody(messages, "echo")).toBe(false);
  });

  it("tool_use 名字不同 → false（同名才判）", () => {
    const messages = [
      textMessage("user", "go"),
      ...skillPair("t1", "other", FULL_BODY_SAMPLE),
    ];
    expect(hasVisibleFullSkillBody(messages, "echo")).toBe(false);
  });

  it("截断形态（只有 Base directory: 缺 </skill_files>）→ false（fail-open 再灌）", () => {
    const truncated = `${FULL_BODY_SAMPLE.slice(0, FULL_BODY_SAMPLE.indexOf("</skill_files>"))}[truncated]`;
    const messages = [
      textMessage("user", "go"),
      ...skillPair("t1", "echo", truncated),
    ];
    expect(hasVisibleFullSkillBody(messages, "echo")).toBe(false);
  });

  it("历史为空 / 无该名 skill 调用 → false", () => {
    expect(hasVisibleFullSkillBody([], "echo")).toBe(false);
    expect(hasVisibleFullSkillBody([textMessage("user", "go")], "echo")).toBe(
      false
    );
  });

  it("tool_use input 形态异常（name 非 string）→ false 不抛", () => {
    const messages: ReadonlyArray<AnthropicNativeMessage> = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "skill", input: { name: 42 } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [{ type: "text", text: FULL_BODY_SAMPLE }],
          },
        ],
      },
    ];
    expect(hasVisibleFullSkillBody(messages, "echo")).toBe(false);
  });
});

describe("skill() 二次短路 — S2 五类（handler 级）", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "aci-skill-sc-"));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  async function writeEcho(dir: string, body?: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      `---\nname: echo\ndescription: Echo a value\n---\n${body ?? "# echo body\nstep one\nstep two\n"}`,
      "utf8"
    );
  }

  function echoTool(dir: string): AciToolDef {
    return createSkillTool({
      catalog: createSkillCatalog([
        entry({ name: "echo", dir, description: "Echo a value" }),
      ]),
    });
  }

  it("empty：name 空 / 非 string → 既有引导句，且不记为已加载（同回合再调仍引导）", async () => {
    const dir = join(scratch, "echo");
    await writeEcho(dir);
    const tool = echoTool(dir);
    const ctx: ToolExecutionContext = {
      turnId: "turn-1",
      messages: [textMessage("user", "go")],
    };
    for (const badInput of [{}, { name: "" }, { name: 42 }, null]) {
      const out = await invokeSkill(tool, badInput, ctx);
      expect(out).toMatch(/available_skills|read_file/);
    }
    // a miss does not enter the wave map: a later legal-name call in the same turn stays unpolluted (nailed by the negative case below).
  });

  it("negative：可见历史无该名全文（或只有引导句）→ 灌全文（337 形态）", async () => {
    const dir = join(scratch, "echo");
    await writeEcho(dir);
    const tool = echoTool(dir);
    // empty history
    const outEmpty = await invokeSkill(
      tool,
      { name: "echo" },
      {
        turnId: "turn-1",
        messages: [textMessage("user", "go")],
      }
    );
    expect(outEmpty).toContain("Base directory:");
    expect(outEmpty.trimEnd().endsWith("</skill_files>")).toBe(true);
    expect(outEmpty).toContain("# echo body");
    // history holds only guidance lines (a wrong name was called before) → still load the full body
    const outGuidanceOnly = await invokeSkill(
      tool,
      { name: "echo" },
      {
        turnId: "turn-2",
        messages: [
          textMessage("user", "go"),
          ...skillPair("t9", "echo", GUIDANCE_SAMPLE),
        ],
      }
    );
    expect(outGuidanceOnly).toContain("Base directory:");
    expect(outGuidanceOnly).toContain("# echo body");
  });

  it("overflow：超长 SKILL.md 首次可装配全文；二次（全文仍在史）→ 短回执", async () => {
    const dir = join(scratch, "echo");
    const longBody = `# echo body\n${"x".repeat(30_000)}\n`;
    await writeEcho(dir, longBody);
    const tool = echoTool(dir);
    const first = await invokeSkill(
      tool,
      { name: "echo" },
      {
        turnId: "turn-1",
        messages: [textMessage("user", "go")],
      }
    );
    expect(first).toContain("# echo body");
    expect(first).toContain("Base directory:");
    expect(first.trimEnd().endsWith("</skill_files>")).toBe(true);

    const history = [
      textMessage("user", "go"),
      ...skillPair("t1", "echo", first),
    ];
    const second = await invokeSkill(
      tool,
      { name: "echo" },
      {
        turnId: "turn-2",
        messages: history,
      }
    );
    expect(second.length).toBeGreaterThan(0);
    expect(second.length).toBeLessThan(first.length / 10);
    expect(second).not.toContain("# echo body");
    expect(second).not.toContain("x".repeat(100));
    // the receipt must not carry both markers at once (the recognizer would mistake it for the full body)
    expect(
      second.includes("Base directory:") && second.includes("</skill_files>")
    ).toBe(false);
  });

  it("concurrent（SC7）：同一波（同 turnId）两次同名 → 恰好一个全文、一个短回执", async () => {
    const dir = join(scratch, "echo");
    await writeEcho(dir);
    const tool = echoTool(dir);
    const ctx: ToolExecutionContext = {
      turnId: "turn-1",
      messages: [textMessage("user", "go")],
    };
    // In production the ACI executor wave starts via Promise.all — launch both handler
    // calls in one synchronous batch to mimic the real concurrent shape.
    const [a, b] = await Promise.all([
      invokeSkill(tool, { name: "echo" }, ctx),
      invokeSkill(tool, { name: "echo" }, ctx),
    ]);
    const texts = [a, b];
    const fullBodies = texts.filter(
      (t) =>
        t.includes("Base directory:") && t.trimEnd().endsWith("</skill_files>")
    );
    const receipts = texts.filter(
      (t) => !(t.includes("Base directory:") && t.includes("</skill_files>"))
    );
    assert.equal(fullBodies.length, 1, "同波两次同名只允许一份全文");
    assert.equal(receipts.length, 1, "另一次必须是短回执");
    expect(receipts[0]).not.toContain("# echo body");
  });

  it("exception：catalog 无此名 → 引导句（ctx 在场也不变）；ctx / messages 缺席 → fail-closed 灌全文", async () => {
    const dir = join(scratch, "echo");
    await writeEcho(dir);
    const tool = echoTool(dir);
    // unknown name + ctx present → guidance line
    const outUnknown = await invokeSkill(
      tool,
      { name: "nope" },
      {
        turnId: "turn-1",
        messages: [textMessage("user", "go")],
      }
    );
    expect(outUnknown).toMatch(/available_skills|read_file/);

    // ctx absent entirely (slash / direct handler-call path) → full body
    const outNoCtx = await invokeSkill(tool, { name: "echo" });
    expect(outNoCtx).toContain("Base directory:");
    expect(outNoCtx.trimEnd().endsWith("</skill_files>")).toBe(true);

    // messages absent (seam not wired) → fail-closed loads the full body. The first assembly
    // already pre-records into the wave map (fail-closed loads the real full body, which gets
    // committed as a tool_result), so the second same-name call in the same turnId short-circuits
    // — consistent with the same-wave semantics (first assembly succeeds, the second no longer re-assembles).
    const outNoMessages1 = await invokeSkill(
      tool,
      { name: "echo" },
      {
        turnId: "turn-9",
      }
    );
    const outNoMessages2 = await invokeSkill(
      tool,
      { name: "echo" },
      {
        turnId: "turn-9",
      }
    );
    expect(outNoMessages1).toContain("Base directory:");
    expect(outNoMessages1.trimEnd().endsWith("</skill_files>")).toBe(true);
    expect(outNoMessages2).not.toContain("Base directory:");
    expect(outNoMessages2.length).toBeGreaterThan(0);
  });

  it("exception：装配抛错回滚预记 —— 同波第二次同名调用重装配或让错误显形，不谎称已加载", async () => {
    const dir = join(scratch, "echo");
    const tool = echoTool(dir);
    const ctx: ToolExecutionContext = {
      turnId: "turn-fail",
      messages: [textMessage("user", "go")],
    };
    // SKILL.md absent → the first assembly throws, the pre-record is rolled back, the error surfaces.
    await expect(invokeSkill(tool, { name: "echo" }, ctx)).rejects.toThrow();

    // File restored: a second same-name call with the same turnId must re-assemble the full body
    // (the pre-record was rolled back; it must not return the "already in context" short receipt —
    // the body never entered history).
    await writeEcho(dir, "# re-assembled body\n");
    const second = await invokeSkill(tool, { name: "echo" }, ctx);
    expect(second).toContain("Base directory:");
    expect(second).toContain("# re-assembled body");
    expect(second).not.toContain("already in context");
  });

  it("跨 turn 不串：不同 turnId 且历史无全文 → 都灌全文（wave map 不跨回合）", async () => {
    const dir = join(scratch, "echo");
    await writeEcho(dir);
    const tool = echoTool(dir);
    const out1 = await invokeSkill(
      tool,
      { name: "echo" },
      {
        turnId: "turn-1",
        messages: [textMessage("user", "go")],
      }
    );
    const out2 = await invokeSkill(
      tool,
      { name: "echo" },
      {
        turnId: "turn-2",
        messages: [textMessage("user", "go")],
      }
    );
    expect(out1).toContain("# echo body");
    expect(out2).toContain("# echo body");
    expect(out2).toContain("Base directory:");
  });

  it("SC5：未知名引导句不记为已加载 —— 同回合第二次同错名仍引导", async () => {
    const dir = join(scratch, "echo");
    await writeEcho(dir);
    const tool = echoTool(dir);
    const ctx: ToolExecutionContext = {
      turnId: "turn-1",
      messages: [textMessage("user", "go")],
    };
    const first = await invokeSkill(tool, { name: "nope" }, ctx);
    const second = await invokeSkill(tool, { name: "nope" }, ctx);
    expect(first).toMatch(/available_skills|read_file/);
    expect(second).toMatch(/available_skills|read_file/);
  });
});

describe("skill() 二次短路 — SC2/SC3 场景", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "aci-skill-sc2-"));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  async function echoSetup(): Promise<AciToolDef> {
    const dir = join(scratch, "echo");
    await mkdir(dir, { recursive: true });
    await mkdir(join(dir, "references"), { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      `---\nname: echo\ndescription: Echo a value\n---\n# echo body\n${"procedure line\n".repeat(30)}`,
      "utf8"
    );
    await writeFile(join(dir, "helper.md"), "helper content\n", "utf8");
    return createSkillTool({
      catalog: createSkillCatalog([
        entry({ name: "echo", dir, description: "Echo a value" }),
      ]),
    });
  }

  it("SC2：二次调用 → 非空短回执，不含 SKILL 程序正文，字节远小于全文", async () => {
    const tool = await echoSetup();
    const first = await invokeSkill(
      tool,
      { name: "echo" },
      {
        turnId: "turn-1",
        messages: [textMessage("user", "go")],
      }
    );
    const history = [
      textMessage("user", "go"),
      ...skillPair("t1", "echo", first),
    ];
    const second = await invokeSkill(
      tool,
      { name: "echo" },
      {
        turnId: "turn-2",
        messages: history,
      }
    );
    expect(second.length).toBeGreaterThan(0);
    expect(second).not.toContain("procedure line");
    expect(second.length).toBeLessThan(first.length / 2);
    // short-receipt semantics: already in visible context / do not call again / act on the earlier body
    expect(second).toContain("already in context");
    expect(second).toContain("Do not call");
  });

  it("SC3：compact 丢掉全文后（历史只剩占位符 / 回执）→ 再调重灌全文", async () => {
    const tool = await echoSetup();
    const fullHistory = [
      textMessage("user", "go"),
      ...skillPair(
        "t1",
        "echo",
        "# echo body\nprocedure line\n\nBase directory: /tmp/x\n\n<skill_files>\n/tmp/x/a.md\n</skill_files>"
      ),
    ];
    // full body in history → short receipt
    const shortCircuited = await invokeSkill(
      tool,
      { name: "echo" },
      {
        turnId: "turn-1",
        messages: fullHistory,
      }
    );
    expect(shortCircuited).not.toContain("procedure line");

    // after compact: the full body is dropped, only the boundary placeholder remains (outside the truncated window)
    const compacted = [textMessage("user", "[earlier messages compacted]")];
    const refed = await invokeSkill(
      tool,
      { name: "echo" },
      {
        turnId: "turn-2",
        messages: compacted,
      }
    );
    expect(refed).toContain("procedure line");
    expect(refed).toContain("Base directory:");
    expect(refed.trimEnd().endsWith("</skill_files>")).toBe(true);

    // history holds only the short receipt (full body gone) → reload the full body too (a receipt is not the full body)
    const receiptOnly = [
      textMessage("user", "go"),
      ...skillPair("t2", "echo", shortCircuited),
    ];
    const refedAfterReceipt = await invokeSkill(
      tool,
      { name: "echo" },
      {
        turnId: "turn-3",
        messages: receiptOnly,
      }
    );
    expect(refedAfterReceipt).toContain("procedure line");
  });
});

describe("executor / loop-engine 接线 — 可见历史快照缝", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "aci-skill-seam-"));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  async function echoTool(): Promise<AciToolDef> {
    const dir = join(scratch, "echo");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      `---\nname: echo\ndescription: Echo a value\n---\n# echo body\n${"step line\n".repeat(20)}`,
      "utf8"
    );
    return createSkillTool({
      catalog: createSkillCatalog([
        entry({ name: "echo", dir, description: "Echo a value" }),
      ]),
    });
  }

  it("createExecutor：第 8 参 messages 进 ctx.messages（ref 透传）；缺席 → 键缺席", async () => {
    const seen: Array<ToolExecutionContext | undefined> = [];
    const probe = Object.freeze({
      name: "probe",
      description: "records ctx",
      inputSchema: { type: "object", additionalProperties: false },
      handler: (_input: unknown, ctx?: ToolExecutionContext) => {
        seen.push(ctx);
        return "ok";
      },
    });
    const registry = createRegistry([probe]);
    const executor = createExecutor(registry);
    const call = { id: "c1", name: "probe", input: {} };
    const messages = [textMessage("user", "go")];

    await executor.executeAll([call]);
    assert.ok(seen[0] !== undefined);
    assert.ok(!("messages" in seen[0]!));

    await executor.executeAll(
      [call],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      messages
    );
    assert.equal(seen[1]?.messages, messages);
  });

  it("createExecutor 端到端：messages 快照含该名全文 → tool_result 是短回执", async () => {
    const tool = await echoTool();
    const registry = createRegistry([tool]);
    const executor = createExecutor(registry);
    const first = await executor.executeAll([
      { id: "s1", name: "skill", input: { name: "echo" } },
    ]);
    assert.equal(first[0]?.kind, "ok");
    const fullText =
      first[0]?.kind === "ok" && first[0]!.payload[0]?.type === "text"
        ? first[0]!.payload[0].text
        : "";
    expect(fullText).toContain("# echo body");

    const history = [
      textMessage("user", "go"),
      ...skillPair("t1", "echo", fullText),
    ];
    const second = await executor.executeAll(
      [{ id: "s2", name: "skill", input: { name: "echo" } }],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      history
    );
    assert.equal(second[0]?.kind, "ok");
    const receiptText =
      second[0]?.kind === "ok" && second[0]!.payload[0]?.type === "text"
        ? second[0]!.payload[0].text
        : "";
    expect(receiptText.length).toBeGreaterThan(0);
    expect(receiptText).not.toContain("# echo body");
    expect(receiptText.length).toBeLessThan(fullText.length);
  });

  it("SC7 集成（loop-engine）：同一波两次同名 skill()，第一个全文、第二个短回执", async () => {
    const tool = await echoTool();
    const registry = createRegistry([tool]);
    const executor = createExecutor(registry);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [
            { id: "s1", name: "skill", input: { name: "echo" } },
            { id: "s2", name: "skill", input: { name: "echo" } },
          ],
        }),
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    const { result } = await run("go", {
      adapter: model,
      executor,
      registry,
      maxTurns: 5,
    });
    assert.equal(result.stopReason, "completed");
    // messages: [user go, assistant(tool_uses), user(tool_results), assistant done]
    const toolResultMessage = result.messages[2]!;
    const resultBlockOf = (id: string) => {
      const block = toolResultMessage.content.find(
        (b) => b.type === "tool_result" && b.tool_use_id === id
      );
      assert.ok(block && block.type === "tool_result");
      return block;
    };
    const firstBlock = resultBlockOf("s1");
    const secondBlock = resultBlockOf("s2");
    const asText = (
      block: Extract<
        (typeof toolResultMessage.content)[number],
        { type: "tool_result" }
      >
    ): string => {
      const content = block.content;
      if (typeof content === "string") return content;
      const first = Array.isArray(content) ? content[0] : undefined;
      return first?.type === "text" ? first.text : "";
    };
    const firstText = asText(firstBlock);
    const secondText = asText(secondBlock);
    expect(firstText).toContain("# echo body");
    expect(firstText).toContain("Base directory:");
    expect(firstText.trimEnd().endsWith("</skill_files>")).toBe(true);
    expect(secondText.length).toBeGreaterThan(0);
    expect(secondText).not.toContain("# echo body");
    expect(secondText.length).toBeLessThan(firstText.length);
  });
});
