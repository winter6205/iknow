/**
 * tests/harness/aci/tools/skill-output-cap.test.ts
 *
 * ADR-0083 / specs/skill-body-load-contract.md 的行为合同：skill 正文不经
 * executor 的 `OUTPUT_HARD_CAP`（20000 字符）兜底闸。
 *
 * 断言面刻意走**真实 executor**（`createExecutor` + `createRegistry`），
 * 不是 handler 直调 —— 豁免是 executor 读 def 上的装配期声明决定的，handler
 * 级断言证明不了闸被绕过。
 *
 *   - SC1 超长正文完整交付：>20000 字符 SKILL.md → 交付文本与
 *     `createSkillBody` 产物逐字节相等、含 `</skill_files>`、无截断标记。
 *   - SC3 闸不泄漏：内建非豁免工具（read_file）与 MCP 形态（toAciToolDef
 *     产物）的超长输出仍截到 <= 20000 且带既有标记。
 *   - SC6 失败面不变：未知名 → 既有引导句；SKILL.md 读失败 → executor
 *     `execution_failed`，不被豁免改写成静默假成功。
 *
 * 环境依赖说明：本文件用 `buildHarnessEngine` 装配生产 executor 取证，
 * 该装配链经 `createDefaultAciRegistry` → `createBashTool` →
 * `requireBwrap` fail-loud，故已进 CI --exclude 集（bwrap 缺失的 runner
 * 结构性跑不了，本地 WSL 全量验证）。该用例是 ADR-0083 唯一「生产装配实际
 * 落值」的证据，不用自建 registry 顶替（那会绕开被测的装配链本身）。
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

/** 兜底闸阈值（ADR-0006）：> 20000 字符即截断 + 标记。 */
const OUTPUT_HARD_CAP = 20000;

/** 既有截断标记前缀（executor.ts 模板，逐字）。 */
const TRUNCATION_MARKER = "[executor: 输出超长已截断";

/** 一行 fixture 正文的字符数（`repeat` 次数按目标字符数换算）。 */
const PROCEDURE_LINE_CHARS = "procedure line\n".length;

/**
 * 1MB 级 fixture 的正文行数：spec S2 overflow 行口径是「>20000 字符正文
 * （含 1MB 级）」，上界取 1MB 字符。
 */
const MEGABYTE_BODY_REPEATS = Math.ceil(1_000_000 / PROCEDURE_LINE_CHARS);

/**
 * 超长正文（含 frontmatter）——剥离后仍 > 20000 字符。`name` 同时是扫描期
 * catalog 键（scanner 取 frontmatter name，不是目录名）。
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
 * 空正文 S2 类 fixture（spec 输入表 empty 行）——`createSkillBody` 的
 * `if (body.length > 0)` 守卫只省掉正文段，两段骨架仍必须齐全。
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

/** 取 ok result 的交付文本（模型可见 tool_result 的 text 块）。 */
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

/** skill 工具经真实 executor 执行一次（可带 messages 快照）。 */
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
  // 组合路径（createSkillTool + createExecutor 就地装配）——证明豁免在
  // 执行器读点生效，不证明生产装配链落值；后者是下一条（buildHarnessEngine）。
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
    // 本机实测：写盘 4ms + 装配 5ms + executeAll 43ms ≈ 52ms 总计（1MB
    // 正文）。30s 与同文件 buildHarnessEngine 用例同档，只兜 runner 抖动。
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

      // 100 倍于闸值：任何「按 OUTPUT_HARD_CAP 截断」的回归都会命中。
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
      // 扫描根注入是 scanner 三级通道之一（G1 Q6）：tmp fixture 走此通道进
      // catalog，不依赖 cwd/.iknow 约定。同时压掉用户级 / 项目级扫描根，让
      // 装配面只含本 fixture（同 tests/session-api/ensure-deps-aci-tools.test.ts）。
      const prevHome = process.env.HOME;
      const emptyHome = join(scratch, "home");
      await mkdir(emptyHome, { recursive: true });
      process.env.IKNOW_SKILL_DIRS = join(scratch);
      process.env.HOME = emptyHome;
      try {
        const built = await buildHarnessEngine({
          // 最小可用 IknowEnv（与 tests/harness/build-engine.test.ts 的
          // makeEnv 同形，apiKey 占位）。
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
          // 三根钉到 tmp scratch（同 tests/harness/build-engine.test.ts 的
          // sandboxRoot/workspaceRoot/productRoot 三连）：本用例证的是装配
          // 链落值 + executor 交付，不该把仓库自身的 mcp.json / .iknow/skills
          // 拖进扫描面（那会让用例依赖工作区内容并拉起无关 MCP 连接）。
          sandboxRoot: scratch,
          workspaceRoot: scratch,
          productRoot: scratch,
          // 项目身份根 = 项目 skills 的扫描根，也钉到 scratch，避免仓库
          // 自身的 `.iknow/skills` 混进 catalog（压掉无关 stderr 并让用例与
          // 工作区内容无关）。
          projectIdentityRoot: scratch,
          // 身份根 / cwd 也钉 scratch（否则 resolveSessionRoots 回落 cwd 再
          // 次扫到仓库）。cwd 只在缺省路径使用，钉住是让「生产装配」这一
          // 命题不被工作区状态污染。
          cwd: scratch,
          userHome: emptyHome,
        });
        try {
          const def = built.deps.registry.get("skill");
          assert.ok(def !== undefined, "生产装配必须含 skill 工具");
          // 这一条是本 spec 的核心：落值发生在生产装配链上（createSkillTool），
          // 不是只在测试自建的 def 上。
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

      // deliveredText 内含 assert.equal(result?.kind, "ok") —— 未 panic 的
      // 机器可检形态（失败会以 execution_failed 落，不会静默）。
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

    // 正文段缺席 → 首段即 `Base directory:`（createSkillBody 的
    // `if (body.length > 0)` 守卫），不是「空字符串 + 空行 + ...」。
    assert.ok(
      body.startsWith("Base directory:"),
      `实际开头：${body.slice(0, 40)}`
    );
  });
});

describe("ADR-0083 SC3 — 闸不泄漏（非豁免工具仍截断）", () => {
  it("内建 read_file：>20000 字符输出仍截到 <= 20000 并带既有标记", async () => {
    const dir = await writeSkillDir("plain", "x".repeat(30_000));
    const file = join(dir, "SKILL.md");
    const tool = createReadFileTool(dir);
    const results = await createExecutor(createRegistry([tool])).executeAll([
      { id: "r1", name: "read_file", input: { path: file, limit: 2000 } },
    ]);
    const text = deliveredText(results[0]);

    assert.ok(text.length <= OUTPUT_HARD_CAP, `实际 ${text.length} 超闸`);
    assert.ok(text.includes(TRUNCATION_MARKER), "既有截断标记必须保留");
  });

  it("MCP 形态（toAciToolDef 产物）：超长结果仍截断，且经 registerExternal 后声明被剥离", async () => {
    // 结构半：转换路径不落声明（防自称）；行为半：真实 ACI registry 存储的
    // def 上无声明 → 交付文本仍 <= 20000 且带既有标记。
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

    // 与上一条（未知名）同强度：引导句必须点名 `<available_skills>` 且
    // 不携带装配形态（`Base directory:` 是全文标记，出现即说明误装配）。
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

/** registry 里内建 def 的声明读点（与本文件 SC1 生产装配同源）。 */
describe("ADR-0083 — registry 冻结快照保留声明", () => {
  it("createRegistry 冻结后 def 上声明仍可读（executor 走注册表路径）", () => {
    const tool = createSkillTool({ catalog: createSkillCatalog([]) });
    const registry: RegistryImpl = createRegistry([tool]);

    assert.equal(registry.get("skill")?.exemptFromOutputCap, true);
  });
});
