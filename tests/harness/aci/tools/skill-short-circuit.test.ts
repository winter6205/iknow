/**
 * tests/harness/aci/tools/skill-short-circuit.test.ts
 *
 * skill() 二次短路（spec skill-body-short-circuit.md SC2/SC3/SC5/SC7 +
 * S2 五类输入表）。行为合同：
 *   - 可见 messages 已有该名成功全文 tool_result（337 装配形态：同时含
 *     `Base directory:` 与 `</skill_files>` 双标记）→ 只回短回执；
 *   - compact 丢掉该条 / 历史快照缺席 → fail-closed 灌全文（不得假装已加载）；
 *   - 同一波（同 turnId）第二次同名短路 —— wave map 承载（同波 tool_result
 *     尚未入史，单靠历史快照看不见）；
 *   - 未知名引导句既不算已加载、也不进 wave map；
 *   - 短回执本身不是全文（无双标记），因此「只剩回执」的历史会再灌全文。
 * 闸只罩 ACI `skill()` handler；slash / Web 不经此路径。
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

/** 337 装配形态的全文样本（双标记齐全）。 */
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

/** 未知名引导句样本（不含任何双标记）。 */
const GUIDANCE_SAMPLE =
  "skill 'echo' not found. Pick the name from the `<available_skills>` list in the system prompt.";

/** 一对（assistant tool_use + user tool_result）消息。 */
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
    // 未命中不进 wave map：同回合再调合法名不受污染（下条用 negative 钉）。
  });

  it("negative：可见历史无该名全文（或只有引导句）→ 灌全文（337 形态）", async () => {
    const dir = join(scratch, "echo");
    await writeEcho(dir);
    const tool = echoTool(dir);
    // 空历史
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
    // 历史只有引导句（曾叫错名）→ 仍灌全文
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
    // 回执不得同时含双标记（否则会被 recognizer 误认成全文）
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
    // 生产路径 ACI executor 的 wave 是 Promise.all 并发启动 —— 两次 handler
    // 调用在同一同步批里启动，模拟真实并发形态。
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
    // 未知名 + ctx 在场 → 引导句
    const outUnknown = await invokeSkill(
      tool,
      { name: "nope" },
      {
        turnId: "turn-1",
        messages: [textMessage("user", "go")],
      }
    );
    expect(outUnknown).toMatch(/available_skills|read_file/);

    // ctx 整体缺席（slash / 直调 handler 路径）→ 全文
    const outNoCtx = await invokeSkill(tool, { name: "echo" });
    expect(outNoCtx).toContain("Base directory:");
    expect(outNoCtx.trimEnd().endsWith("</skill_files>")).toBe(true);

    // messages 缺席（缝未接）→ fail-closed 灌全文。第一次装配即预记 wave
    // map（fail-closed 灌的是真实全文，会被 commit 成 tool_result），所以
    // 同 turnId 第二次短路 —— 与 SC7 语义一致（首次装配成功，第二次不再重装）。
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
    // SKILL.md 缺席 → 第一次装配抛错，预记回滚，错误显形。
    await expect(invokeSkill(tool, { name: "echo" }, ctx)).rejects.toThrow();

    // 恢复文件：同 turnId 第二次同名调用必须重新装配全文（预记已回滚，
    // 不得返回「already in context」短回执——正文从未入史）。
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
    // 短回执语义：已在可见上下文 / 勿再调 / 按先前正文执行
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
    // 全文在史 → 短回执
    const shortCircuited = await invokeSkill(
      tool,
      { name: "echo" },
      {
        turnId: "turn-1",
        messages: fullHistory,
      }
    );
    expect(shortCircuited).not.toContain("procedure line");

    // compact 后：全文被丢，只剩边界占位符（截断窗口外）
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

    // 历史只剩短回执（全文已丢）→ 同样重灌全文（回执不算全文）
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
