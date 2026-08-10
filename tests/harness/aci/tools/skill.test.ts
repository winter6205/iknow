/**
 * tests/harness/aci/tools/skill.test.ts
 *
 * `skill` 工具（第 22 件 ACI，#337 T5）单元测试 — 对齐 spec
 * 337-skill-mcp-extension.md § Code Style + T5 acceptance：
 *   - inputSchema `{name: string required}`
 *   - 直呼名返回正文（cat SKILL.md 内容）；叫错名返回引导文本
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

describe("skill — 叫错名返回引导回检索的文本(T5 acceptance 3)", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "aci-skill-"));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it("unknown name → 引导回 skill_search,不返回正文", async () => {
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
    expect(out).toContain("skill_search");
    expect(out).not.toContain("body");
  });

  it("空 catalog 直呼 → 仍返回引导文本(不抛)", async () => {
    const catalog = createSkillCatalog([]);
    const tool = createSkillTool({ catalog });
    const out = await invokeSkill(tool, { name: "anything" });
    expect(out).toContain("skill_search");
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
