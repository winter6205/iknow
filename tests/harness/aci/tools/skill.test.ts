/**
 * tests/harness/aci/tools/skill.test.ts
 *
 * Unit tests for the `skill` ACI tool — contract:
 *   - inputSchema `{name: string required}`
 *   - a correct name returns the body (SKILL.md content); a wrong name returns
 *     guidance back to the `<available_skills>` list or `read_file`
 *     (ADR-0046; the guidance must not mention skill_search)
 *   - aci metadata: read-only / lazy:false / timeoutTier:fast
 *   - handler returns a string synchronously (catalog.getBodyPath() → synchronous readFile)
 *
 * **Fixture shape**: feed entries directly to `createSkillCatalog(entries)` (no
 * scanner / real SKILL.md filesystem needed); the handler gets the absolute
 * SKILL.md path via `deps.catalog.getBodyPath()` and readFile's it. `dir`
 * points at a tmpdir where SKILL.md is really written, so readFile succeeds.
 */
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
  SkillBodyReadError,
  SkillNotModelIndexedError,
} from "../../../../src/harness/aci/tools/skill.js";
import type { AciToolDef } from "../../../../src/harness/aci/types.js";
import { createRegistry } from "../../../../src/harness/tools/registry.js";
import { createExecutor } from "../../../../src/harness/tools/executor.js";
import type { ToolExecutionContext } from "../../../../src/harness/tools/types.js";
import type { AnthropicNativeMessage } from "../../../../src/harness/model-adapter/types.js";
import {
  createLiveTaskRoot,
  writeLiveTaskRoot,
} from "../../../../src/harness/session-roots.js";

function entry(
  overrides: Partial<SkillEntry> & Pick<SkillEntry, "name" | "dir">
): SkillEntry {
  return {
    description: "default",
    disabled: false,
    ...overrides,
  };
}

/** Call the handler directly (sync, returns string; an async handler resolves after internal awaits). */
async function invokeSkill(
  tool: AciToolDef,
  input: unknown,
  ctx?: ToolExecutionContext
): Promise<string> {
  const handler = tool.handler as (
    input: unknown,
    ctx?: ToolExecutionContext
  ) => Promise<unknown> | unknown;
  return (await handler(input, ctx)) as string;
}

describe("skill — 元数据 (G1 Q1 / T5 acceptance 3)", () => {
  it("name === 'skill'", () => {
    const tool = createSkillTool({
      catalog: createSkillCatalog([]),
    });
    expect(tool.name).toBe("skill");
  });

  it("aci: read-only / lazy:false / timeoutTier:fast", () => {
    const tool = createSkillTool({
      catalog: createSkillCatalog([]),
    });
    expect(tool.aci.category).toBe("read-only");
    expect(tool.aci.lazy).toBe(false);
    expect(tool.aci.timeoutTier).toBe("fast");
  });

  it("exemptFromOutputCap === true（ADR-0083 装配期落值）", () => {
    // The single landing point of the exemption declaration: a static
    // assembly-time field read by executor's safeContent. Contract X (executor
    // is the sole authority on truncation metadata) is unaffected — this is a
    // tool-definition property, not a truncation claim about any output.
    const tool = createSkillTool({
      catalog: createSkillCatalog([]),
    });
    expect(tool.exemptFromOutputCap).toBe(true);
  });

  it("inputSchema: { name: string required, additionalProperties:false }", () => {
    const tool = createSkillTool({
      catalog: createSkillCatalog([]),
    });
    expect(tool.inputSchema).toMatchObject({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    });
  });

  it("description: 直呼 `<available_skills>` 精确名,不再 pair skill_search(SC5)", () => {
    // `skill`'s wording = call the exact name from `<available_skills>`
    // directly, no pairing with skill_search (ADR-0046). The text also
    // explicitly guides back to the `<available_skills>` list or, when the
    // operator points at a file path, `read_file`.
    const tool = createSkillTool({
      catalog: createSkillCatalog([]),
    });
    expect(tool.description).toContain("available_skills");
    expect(tool.description).not.toContain("skill_search");
  });
});

describe("skill — 直呼名返回 SKILL.md 正文(T5 acceptance 3)", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "aci-skill-"));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it("直呼名 → 返回该 skill 的 SKILL.md 原始内容", async () => {
    const dir = join(scratch, "echo");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      "---\nname: echo\ndescription: Echo a value\n---\n# echo body\nreflect text\n",
      "utf8"
    );
    const catalog = createSkillCatalog([
      entry({ name: "echo", dir, description: "Echo a value" }),
    ]);
    const tool = createSkillTool({ catalog });
    const out = await invokeSkill(tool, { name: "echo" });
    expect(out).toContain("# echo body");
    expect(out).toContain("reflect text");
  });

  it("多个 skill 直呼 → 只返回目标正文(不动他人)", async () => {
    const dirA = join(scratch, "alpha");
    const dirB = join(scratch, "beta");
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    await writeFile(
      join(dirA, "SKILL.md"),
      "---\nname: alpha\ndescription: a\n---\n# alpha body\n",
      "utf8"
    );
    await writeFile(
      join(dirB, "SKILL.md"),
      "---\nname: beta\ndescription: b\n---\n# beta body\n",
      "utf8"
    );
    const catalog = createSkillCatalog([
      entry({ name: "alpha", dir: dirA, description: "a" }),
      entry({ name: "beta", dir: dirB, description: "b" }),
    ]);
    const tool = createSkillTool({ catalog });
    const out = await invokeSkill(tool, { name: "beta" });
    expect(out).toContain("# beta body");
    expect(out).not.toContain("# alpha body");
  });
});

describe("skill — 叫错名返回引导回 <available_skills> / read_file 的文本(T5 acceptance 3 + SC6)", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "aci-skill-"));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it("unknown name → 引导回 <available_skills> / read_file,绝不提 skill_search", async () => {
    const dir = join(scratch, "echo");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      "---\nname: echo\ndescription: Echo a value\n---\nbody\n",
      "utf8"
    );
    const catalog = createSkillCatalog([
      entry({ name: "echo", dir, description: "Echo a value" }),
    ]);
    const tool = createSkillTool({ catalog });
    const out = await invokeSkill(tool, { name: "nope" });
    expect(out.toLowerCase()).toContain("nope");
    // The guidance text must never mention the removed skill_search.
    expect(out).not.toContain("skill_search");
    expect(out).not.toContain("body");
    // Guidance lands on available_skills / read_file (when the operator points at a path in chat).
    expect(out).toMatch(/available_skills|read_file/);
  });

  it("空 catalog 直呼 → 仍返回引导文本(不抛),且不含 skill_search", async () => {
    const catalog = createSkillCatalog([]);
    const tool = createSkillTool({ catalog });
    const out = await invokeSkill(tool, { name: "anything" });
    expect(out).not.toContain("skill_search");
    expect(out).toMatch(/available_skills|read_file/);
  });

  it("disabled skill 直呼 → 按模型索引资格拒（SC6），不灌正文", async () => {
    // The old lock ("disabled skills still serve the body") is rewritten per
    // specs/skill-index-increment.md: `skill()` serves model-index
    // eligibility only (CONTEXT: has description and not
    // disable-model-invocation); disabled names go through the human-side
    // slash only — reject, and output must contain no body fragment. catalog
    // .get still returns disabled entries by name (the loadable-skills face);
    // the gate lives in this tool's handler.
    const dir = join(scratch, "secret");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      "---\nname: secret\ndescription: hidden\ndisable-model-invocation: true\n---\nhidden body\n",
      "utf8"
    );
    const catalog = createSkillCatalog([
      entry({
        name: "secret",
        dir,
        description: "hidden",
        disabled: true,
      }),
    ]);
    const tool = createSkillTool({ catalog });
    const thrown = await invokeSkill(tool, { name: "secret" }).catch((e) => e);
    expect(thrown).toBeInstanceOf(SkillNotModelIndexedError);
    expect((thrown as Error).message).toContain("disable-model-invocation");
    expect((thrown as Error).message).not.toContain("hidden body");
  });
});

// specs/skill-index-increment.md + the Input-contract table's `skill()` row:
// "not model-indexed → reject, no body served"; "disk-read failure is typed and
// a different error class from an eligibility rejection".
//
// Model-index eligibility (docs/CONTEXT.md section `技能模型索引`, "skill model
// index") = has description and
// not `disable-model-invocation`. This describe pins three things:
//   1. both unqualified kinds (no description / disabled) are rejected with no
//      body fragment in the output;
//   2. eligibility rejection and disk-read failure are **different** typed
//      errors (the caller can tell the next step apart);
//   3. the gate covers only the ACI `skill()` — file tools reading the same
//      SKILL.md never fail because of it (`read_file` is not forbidden;
//      read-file.ts has no code coupling to this gate).
describe("skill — 模型索引资格闸（SC5/SC6：资格拒 vs 读盘失败分型）", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "aci-skill-elig-"));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  /** Write a SKILL.md with a unique body marker; return its dir. */
  async function writeSkill(
    name: string,
    frontmatter: string,
    bodyMarker: string
  ): Promise<string> {
    const dir = join(scratch, name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\n${frontmatter}---\n${bodyMarker}\n`,
      "utf8"
    );
    return dir;
  }

  it("①无 description → 拒（typed），输出不含正文任何片段、不含装配双标记", async () => {
    // A missing description only hides the skill from the model-facing index;
    // humans can still load it via slash. Calling it by name directly is a call
    // the model cannot know how to use, so it must be rejected, not served.
    const bodyMarker = "SECRET_BODY_MARKER_NO_DESCRIPTION";
    const dir = await writeSkill("nodesc", "", bodyMarker);
    const tool = createSkillTool({
      catalog: createSkillCatalog([
        entry({ name: "nodesc", dir, description: undefined }),
      ]),
    });

    const thrown = await invokeSkill(tool, { name: "nodesc" }).catch((e) => e);

    expect(thrown).toBeInstanceOf(SkillNotModelIndexedError);
    const message = (thrown as Error).message;
    expect(message).not.toContain(bodyMarker);
    expect(message).not.toContain("Base directory:");
    expect(message).not.toContain("</skill_files>");
    // The escape hatch must be spelled out: human slash use only, or the author adds a description.
    expect(message).toMatch(/description/);
  });

  it("②disabled（有 description）→ 拒（typed），输出不含正文任何片段", async () => {
    const bodyMarker = "SECRET_BODY_MARKER_DISABLED";
    const dir = await writeSkill(
      "secret2",
      "description: hidden\ndisable-model-invocation: true\n",
      bodyMarker
    );
    const tool = createSkillTool({
      catalog: createSkillCatalog([
        entry({
          name: "secret2",
          dir,
          description: "hidden",
          disabled: true,
        }),
      ]),
    });

    const thrown = await invokeSkill(tool, { name: "secret2" }).catch((e) => e);

    expect(thrown).toBeInstanceOf(SkillNotModelIndexedError);
    const message = (thrown as Error).message;
    expect(message).not.toContain(bodyMarker);
    expect(message).not.toContain("Base directory:");
    expect(message).not.toContain("</skill_files>");
    // The escape hatch must be spelled out: human slash use only.
    expect(message).toMatch(/slash|disable-model-invocation/);
  });

  it("③合格名（有 description 且未 disable）→ 仍返回正文，末段 </skill_files>", async () => {
    const dir = await writeSkill(
      "qualified",
      "description: Echo a value\n",
      "# qualified body\nstep"
    );
    const tool = createSkillTool({
      catalog: createSkillCatalog([
        entry({ name: "qualified", dir, description: "Echo a value" }),
      ]),
    });

    const out = await invokeSkill(tool, { name: "qualified" });

    expect(out).toContain("# qualified body");
    expect(out).toContain("Base directory:");
    expect(out.trimEnd().endsWith("</skill_files>")).toBe(true);
  });

  it("④未知名 → 既有 guidance 串逐字节不变（资格闸不吞未知名路径）", async () => {
    const dir = await writeSkill(
      "echo4",
      "description: Echo a value\n",
      "body"
    );
    const tool = createSkillTool({
      catalog: createSkillCatalog([
        entry({ name: "echo4", dir, description: "Echo a value" }),
      ]),
    });

    const out = await invokeSkill(tool, { name: "not-installed" });

    expect(out).toBe(
      "skill 'not-installed' not found. Pick the name from the `<available_skills>` list in the system prompt, or — if the operator pointed at a file path outside the scan root — use `read_file`."
    );
  });

  it("⑤空 name → 走既有未知名校验（不因资格闸改道）", async () => {
    const dir = await writeSkill(
      "nodesc5",
      "",
      "SECRET_BODY_MARKER_EMPTY_NAME"
    );
    const tool = createSkillTool({
      catalog: createSkillCatalog([
        entry({ name: "nodesc5", dir, description: undefined }),
      ]),
    });

    for (const badInput of [{}, { name: "" }, { name: 42 }, null]) {
      const out = await invokeSkill(tool, badInput);
      expect(out).toMatch(/available_skills|read_file/);
      expect(out).not.toContain("SECRET_BODY_MARKER_EMPTY_NAME");
    }
  });

  it("⑥读盘失败（SKILL.md 不可读）→ 与资格拒不同型：SkillBodyReadError，cause 保留读盘故障", async () => {
    // Qualified name + dir present but SKILL.md missing: the eligibility gate
    // passes, then assembly-time disk read fails. The two failure kinds must be
    // typed apart: eligibility rejection means "this path is not open to you",
    // a read failure means "it should be open but is unreadable right now" —
    // the caller's next step differs (pick another name vs retry / report).
    const dir = join(scratch, "broken");
    await mkdir(dir, { recursive: true });
    const tool = createSkillTool({
      catalog: createSkillCatalog([
        entry({ name: "broken", dir, description: "Echo a value" }),
      ]),
    });

    const thrown = await invokeSkill(tool, { name: "broken" }).catch((e) => e);

    expect(thrown).toBeInstanceOf(SkillBodyReadError);
    expect(thrown).not.toBeInstanceOf(SkillNotModelIndexedError);
    expect((thrown as SkillBodyReadError).name).toBe("SkillBodyReadError");
    expect((thrown as Error).message).toContain("broken");
    // The original ENOENT fault stays on `cause`, not swallowed.
    expect((thrown as SkillBodyReadError).cause).toBeDefined();
  });

  it("⑦闸只罩 skill()：read_file 读同一份 disabled SKILL.md 不因本闸失败", async () => {
    // Boundaries: "`skill()`: non-model-indexed → reject, no body; does not
    // forbid `read_file`". read-file.ts has no code coupling to this gate —
    // this case pins that, so a later refactor cannot lift the eligibility
    // gate into a cross-module interception.
    const dir = await writeSkill(
      "secret7",
      "description: hidden\ndisable-model-invocation: true\n",
      "# readable by file tools\n"
    );
    const tool = createSkillTool({
      catalog: createSkillCatalog([
        entry({ name: "secret7", dir, description: "hidden", disabled: true }),
      ]),
    });
    await expect(invokeSkill(tool, { name: "secret7" })).rejects.toBeInstanceOf(
      SkillNotModelIndexedError
    );

    const { createReadFileTool } =
      await import("../../../../src/harness/aci/tools/read-file.js");
    const readTool = createReadFileTool(dir);
    const out = (await readTool.handler({
      path: join(dir, "SKILL.md"),
    })) as string;
    expect(out).toContain("readable by file tools");
  });

  it("⑧资格闸先于二次短路：全文在史也不放行不合格名（拒不是回执）", async () => {
    // Order pinned: the eligibility check runs before the short-circuit / wave
    // pre-record / assembly — an unqualified name must enter no path, otherwise
    // an old full-body copy of the same name sitting in history would "launder"
    // it into loaded. The construction here has visible history already
    // containing a successful full body for this name: if the gate ran after
    // the short-circuit, this call would get a short receipt instead of a rejection.
    const bodyMarker = "SECRET_BODY_MARKER_SHORTCIRCUIT";
    const dir = await writeSkill(
      "secret8",
      "description: hidden\ndisable-model-invocation: true\n",
      bodyMarker
    );
    const tool = createSkillTool({
      catalog: createSkillCatalog([
        entry({ name: "secret8", dir, description: "hidden", disabled: true }),
      ]),
    });
    const fullBody = [
      "# secret8",
      "",
      "Base directory: /tmp/somewhere/secret8",
      "",
      "<skill_files>",
      "</skill_files>",
    ].join("\n");
    const messages: ReadonlyArray<AnthropicNativeMessage> = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "skill",
            input: { name: "secret8" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [{ type: "text", text: fullBody }],
          },
        ],
      },
    ];
    const ctx: ToolExecutionContext = { turnId: "turn-1", messages };

    const thrown = await invokeSkill(tool, { name: "secret8" }, ctx).catch(
      (e) => e
    );

    expect(thrown).toBeInstanceOf(SkillNotModelIndexedError);
    expect((thrown as Error).message).not.toContain("already in context");
    expect((thrown as Error).message).not.toContain(bodyMarker);
  });
});

describe("skill — 资格拒经真实 executor 到模型面（execution_failed + is_error）", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "aci-skill-elig-exec-"));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it("不合格名：execution_failed，message 是资格拒文案（不被 executor 净化成通用串）", async () => {
    // The reason must reach the model: executor's sanitizeFailure only passes
    // through the message of ToolExecutionError (incl. subclasses); everything
    // else collapses to "tool execution failed". This case pins the
    // "rejection reason is visible" leg (same end-to-end method as memory_save).
    const dir = join(scratch, "secret");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      "---\nname: secret\ndescription: hidden\ndisable-model-invocation: true\n---\nSECRET_BODY\n",
      "utf8"
    );
    const tool = createSkillTool({
      catalog: createSkillCatalog([
        entry({ name: "secret", dir, description: "hidden", disabled: true }),
      ]),
    });
    const executor = createExecutor(createRegistry([tool]));

    const results = await executor.executeAll([
      { id: "s1", name: "skill", input: { name: "secret" } },
    ]);

    const result = results[0];
    expect(result?.kind).toBe("execution_failed");
    if (result?.kind !== "execution_failed") throw new Error("unreachable");
    expect(result.message).not.toBe("tool execution failed");
    expect(result.message).not.toContain("SECRET_BODY");
    expect(result.message).toMatch(/slash|disable-model-invocation/);
  });
});

// ADR-0079 — the skill() tool no longer appends a write-root trailer (amending
// the earlier write-root load contract). The assembled body always ends with
// </skill_files>, byte-identical in shape to the normal delivery; unknown skill
// names still get the guidance sentence. `SkillToolDeps` also no longer accepts
// `liveTaskRoot` / `isolationOn` — the authoritative path for write-context
// disclosure moved to worker prior + chat-session rebind, sharing the
// `writeRootSegment` helper.
describe("skill — 正文不挂写根（ADR-0079）", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "aci-skill-wrt-"));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  function echoCatalog(dir: string) {
    return createSkillCatalog([
      entry({ name: "echo", dir, description: "Echo a value" }),
    ]);
  }

  async function writeEcho(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      "---\nname: echo\ndescription: Echo a value\n---\n# echo body\n",
      "utf8"
    );
  }

  it("SkillToolDeps 不再接受 liveTaskRoot（类型层钉死）", () => {
    // Pinned at TypeScript compile time: SkillToolDeps no longer has
    // liveTaskRoot / isolationOn fields. At runtime this case only checks the
    // factory accepts deps without them.
    const dir = join(scratch, "echo-type");
    const tool = createSkillTool({ catalog: echoCatalog(dir) });
    expect(tool.name).toBe("skill");
  });

  it("handler 调用 → 末段是 </skill_files>，正文不出现 current write root（即使 caller 持 cell）", async () => {
    // Guarding ADR-0079: even with a cell present, no trailer is rendered. The
    // cell constructed here merely simulates "the caller still holds a live
    // root", but SkillToolDeps no longer accepts it; an erroneous cell pass-
    // through would have to use an undeclared field (compile error), so the
    // surface is closed off by the type system.
    const dir = join(scratch, "echo");
    await writeEcho(dir);
    const tool = createSkillTool({ catalog: echoCatalog(dir) });
    const out = await invokeSkill(tool, { name: "echo" });
    expect(out).not.toContain("current write root");
    expect(out).not.toContain("no writable root");
    expect(out.trimEnd().endsWith("</skill_files>")).toBe(true);
    // The body still carries the skill's own assembled form (frontmatter stripped + Base directory line)
    expect(out).toContain("# echo body");
    expect(out).toContain("Base directory:");
  });

  it("未知 skill 名 → 仍是引导句，无 trailer", async () => {
    const dir = join(scratch, "echo");
    await writeEcho(dir);
    const tool = createSkillTool({ catalog: echoCatalog(dir) });
    const out = await invokeSkill(tool, { name: "nope" });
    expect(out).toMatch(/available_skills|read_file/);
    expect(out).not.toContain("current write root");
    expect(out).not.toContain("skill_search");
  });

  it("createLiveTaskRoot / writeLiveTaskRoot helper 仍存在（写处境披露的下游消费者继续用）", () => {
    // Downstream consumers of writeRootSegment (worker prior / chat-session
    // rebind) still use createLiveTaskRoot / writeLiveTaskRoot to hold the live
    // root — this guards the helpers against accidental deletion by the
    // skill-side cleanup.
    const cell = createLiveTaskRoot("/tmp/keep-alive");
    writeLiveTaskRoot(cell, "/tmp/rebind");
    expect(cell.read()).toBe("/tmp/rebind");
  });
});
