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
import { createSkillTool } from "../../../../src/harness/aci/tools/skill.js";
import type { AciToolDef } from "../../../../src/harness/aci/types.js";
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
async function invokeSkill(tool: AciToolDef, input: unknown): Promise<string> {
  const handler = tool.handler as (
    input: unknown
  ) => Promise<unknown> | unknown;
  return (await handler(input)) as string;
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

  it("disabled skill 直呼 → 同样按未注册处理(索引层过滤;get 不返回)", async () => {
    // disabled 入口在 catalog.index 中仍在(可 get / getBodyPath 返回 entry),
    // 但 available/search 排除。本测试聚焦 disabled 仍 get 到的情况 —— 当前
    // contract 是直呼命中 entry 即返回正文,disabled 在 T6 <available_skills>
    // / skill_search 排除;此处仅锁"已知名 = 返回正文"。
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
    const out = await invokeSkill(tool, { name: "secret" });
    expect(out).toContain("hidden body");
  });
});

// 写根 trailer（specs/skill-load-write-root.md）：skill() 工具 handler 调用
// 时机读活 taskRoot cell 快照传给 createSkillBody —— 与 TUI slash / hub
// loadSkillBody 同一装配口，正文末尾带当前写根；cell 缺席 → 无 trailer
// （legacy parity）；未知 skill 名仍是引导句、无 trailer。
describe("skill — 写根 trailer（specs/skill-load-write-root.md T3）", () => {
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

  it("liveTaskRoot 在场 → handler 调用时读 cell 快照，正文末尾含当前写根", async () => {
    const dir = join(scratch, "echo");
    await writeEcho(dir);
    const tool = createSkillTool({
      catalog: echoCatalog(dir),
      liveTaskRoot: createLiveTaskRoot("/tmp/task-wt-a"),
    });
    const out = await invokeSkill(tool, { name: "echo" });
    expect(out).toContain(
      "current write root (for write_file / edit_file / bash cwd): /tmp/task-wt-a"
    );
  });

  it("改绑后翻 cell → 同一工具下一次调用读到新根（活性：调用时读取）", async () => {
    const dir = join(scratch, "echo");
    await writeEcho(dir);
    const cell = createLiveTaskRoot("/tmp/task-wt-a");
    const tool = createSkillTool({
      catalog: echoCatalog(dir),
      liveTaskRoot: cell,
    });
    const before = await invokeSkill(tool, { name: "echo" });
    expect(before).toContain("/tmp/task-wt-a");
    // 模拟改绑：翻 cell（唯一 writer = writeLiveTaskRoot，装配层缝包装面）
    writeLiveTaskRoot(cell, "/tmp/task-wt-b");
    const after = await invokeSkill(tool, { name: "echo" });
    expect(after).toContain("/tmp/task-wt-b");
    expect(after).not.toContain("task-wt-a");
  });

  it("liveTaskRoot 缺席 → 无 trailer（与今日字节一致）", async () => {
    const dir = join(scratch, "echo");
    await writeEcho(dir);
    const tool = createSkillTool({ catalog: echoCatalog(dir) });
    const out = await invokeSkill(tool, { name: "echo" });
    expect(out).not.toContain("current write root");
    expect(out.trimEnd().endsWith("</skill_files>")).toBe(true);
  });

  it("未知 skill 名 → 仍是引导句，无 trailer（即使 cell 在场且非空）", async () => {
    const dir = join(scratch, "echo");
    await writeEcho(dir);
    const tool = createSkillTool({
      catalog: echoCatalog(dir),
      liveTaskRoot: createLiveTaskRoot("/tmp/task-wt-a"),
    });
    const out = await invokeSkill(tool, { name: "nope" });
    expect(out).toMatch(/available_skills|read_file/);
    expect(out).not.toContain("current write root");
  });
});
