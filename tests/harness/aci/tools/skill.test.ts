/**
 * tests/harness/aci/tools/skill.test.ts
 *
 * `skill` 工具（第 22 件 ACI，#337 T5）单元测试 — 对齐 spec
 * 337-skill-mcp-extension.md § Code Style + T5 acceptance +
 * spec disclosure-index-align.md SC6（未知名引导文本不含 skill_search）：
 *   - inputSchema `{name: string required}`
 *   - 直呼名返回正文（cat SKILL.md 内容）；叫错名返回引导文本,引导回
 *     `<available_skills>` 清单或 `read_file`(spec ADR-0046 / SC6)
 *   - aci 元数据：read-only / lazy:false / timeoutTier:fast
 *   - handler 同步返回 string（与 catalog.getBodyPath() → readFile 同步读）
 *
 * **fixture 形态**：用 `createSkillCatalog(entries)` 直接喂 entries（不必经
 * scanner / SKILL.md 真实文件系统），handler 通过 `deps.catalog` 的
 * `getBodyPath()` 拿 SKILL.md 绝对路径并 readFile。`dir` 字段指向 tmpdir
 * 真实写入 SKILL.md，确保 readFile 成功。
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

/** 直呼 handler(同步,返回 string;async handler 内部 await 后 resolve)。 */
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
    // 豁免声明的唯一落值点：装配期静态字段，executor 的 safeContent 读它。
    // 契约 X（executor 是截断元数据唯一权威）不受影响——本字段是工具定义
    // 属性，不是任何一次输出的截断声称。
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
    // SC5:`skill` 文案 = 从 `<available_skills>` 精确名直呼,不再 pair
    // skill_search(spec ADR-0046)。文案同时显式引导回 `<available_skills>`
    // 清单或（操作员指路径时）`read_file`。
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
    // SC6 契约:引导文本绝不出现已删的 skill_search 字样。
    expect(out).not.toContain("skill_search");
    expect(out).not.toContain("body");
    // 引导落到 available_skills / read_file 任一(operator 在对话里指路径时)。
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
    // 旧锁（「disabled 仍灌正文」）按 spec skill-index-increment SC6 改写：
    // `skill()` 只服务模型索引资格（CONTEXT：有 description 且未
    // disable-model-invocation），disabled 名字只走人侧 slash —— 拒、且输出
    // 不含正文任何片段。catalog.get 仍按名返回含 disabled 的条目（可加载
    // 技能面），闸落在本工具 handler。
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

// spec skill-index-increment.md SC5/SC6 + Input-contract 表 `skill()` 行：
// 「非模型索引 → 拒、不灌正文」「读盘失败 typed，与『资格拒』分型」。
//
// 模型索引资格（docs/CONTEXT.md「技能模型索引」）= 有 description 且未
// `disable-model-invocation`。本 describe 钉三件事：
//   1. 两类不合格名（无 description / disabled）都拒，且输出不含正文任何片段；
//   2. 资格拒与读盘失败是**不同型**的 typed error（调用方可分辨下一步）；
//   3. 闸只罩 ACI `skill()` —— 文件工具读同一份 SKILL.md 不因本闸失败
//      （SC5 末句：不禁止 `read_file`；read-file.ts 与本闸无代码耦合）。
describe("skill — 模型索引资格闸（SC5/SC6：资格拒 vs 读盘失败分型）", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "aci-skill-elig-"));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  /** 写一份带唯一正文标记的 SKILL.md，返回其 dir。 */
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
    // 无 description 只从模型索引面隐去（SC5）；人侧仍可 slash 信封加载。
    // 直呼该名是「模型不知道怎么用它对」的调用，必须拒而不是灌正文。
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
    // 出路必须写明：该名是人力 slash 专用，或作者补 description。
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
    // 出路必须写明：人力 slash 专用。
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
    // 合格名 + dir 在但 SKILL.md 缺席：资格闸放行、装配期读盘失败。
    // 两类失败必须先分型：资格拒是「这条路对你不开放」，读盘失败是
    // 「本该开放但现在读不到」—— 调用方下一步不同（换名 vs 重试 / 报障）。
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
    // ENOENT 的原始故障保留在 cause 上，不吞。
    expect((thrown as SkillBodyReadError).cause).toBeDefined();
  });

  it("⑦闸只罩 skill()：read_file 读同一份 disabled SKILL.md 不因本闸失败", async () => {
    // SC5 末句 / spec Boundaries：「`skill()`：非模型索引资格 → 拒、不灌正文；
    // 不禁止 `read_file`」。read-file.ts 与本闸无代码耦合 —— 本用例钉住
    // 这一点，防止后人把资格闸上移成跨模块拦截。
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
    // 顺序钉死：资格检查先于短路 / wave 预记 / 装配 —— 不合格名不该进任何
    // 路径，否则历史里恰好存在的同名旧全文会把它「洗白」成已加载。本用例
    // 用「可见历史已有该名成功全文」的构造认证：闸若在短路之后，这里会
    // 拿到短回执而不是拒。
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
    // 文案必须到达模型：executor 的 sanitizeFailure 只放行
    // ToolExecutionError（含子类）的 message，其余塌成 "tool execution
    // failed"。本用例钉住「拒绝原因可见」这一环（与 memory_save 的
    // 端到端同法）。
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

// ADR-0079 — skill() 工具不再挂写根 trailer（specs/skill-load-write-root.md
// 合同 6 amend）。handler 装配正文末段始终是 </skill_files>，与 #337 SC6
// 形态逐字节一致；未知 skill 名仍是引导句。`SkillToolDeps` 也不再接受
// `liveTaskRoot` / `isolationOn`（写处境披露的权威路径迁到 worker prior +
// chat-session rebind，共用同一 helper `writeRootSegment`）。
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
    // TypeScript 编译期钉住：SkillToolDeps 上不再有 liveTaskRoot / iso-
    // lationOn 字段。本用例在运行期只验工厂可被不含这俩字段的 deps 调用。
    const dir = join(scratch, "echo-type");
    const tool = createSkillTool({ catalog: echoCatalog(dir) });
    expect(tool.name).toBe("skill");
  });

  it("handler 调用 → 末段是 </skill_files>，正文不出现 current write root（即使 caller 持 cell）", async () => {
    // 守门 ADR-0079：cell 在场也不再渲染 trailer。本用例直接构造 cell 仅
    // 是模拟「caller 侧仍在持有活根」，但 SkillToolDeps 已不接它；如要
    // 模拟错误地把 cell 传过去，应通过未声明字段（编译失败）做强制收口。
    const dir = join(scratch, "echo");
    await writeEcho(dir);
    const tool = createSkillTool({ catalog: echoCatalog(dir) });
    const out = await invokeSkill(tool, { name: "echo" });
    expect(out).not.toContain("current write root");
    expect(out).not.toContain("no writable root");
    expect(out.trimEnd().endsWith("</skill_files>")).toBe(true);
    // 正文仍含 skill 自身装配形态（frontmatter 剥离 + Base directory 行）
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
    // writeRootSegment 的下游消费者（worker prior / chat-session rebind）
    // 仍用 createLiveTaskRoot / writeLiveTaskRoot 持有活根 —— 本用例守
    // 门 helper 不被本轮 T1 误删。
    const cell = createLiveTaskRoot("/tmp/keep-alive");
    writeLiveTaskRoot(cell, "/tmp/rebind");
    expect(cell.read()).toBe("/tmp/rebind");
  });
});
