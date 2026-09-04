/**
 * B8 / spec model-prefix-layering SC9 — 真实接通模型 e2e。
 *
 * 本轮 LLM-touching 改动(B3/B4/B6)配套的真实端点验证(测试规范
 * 「LLM-touching 代码」条款):仅 stub 全绿不算,必须真实打模型。
 *
 *   it 1 — 真实端点多 turn 会话 + ≥1 次真实 tool_call:
 *     buildHarnessEngine(真实 adapter,chat surface)驱 run() 两个回合,
 *     模型经 executor 真调 read_file。loop-engine 多 turn 契约 + B3 消息
 *     追加缝在真实 adapter 路径上打穿。
 *
 *   it 2 — MCP 真连接(stdio fixture 子进程,非 stub client)+ 名字目录 +
 *     tool_search 加载回路(B4 / ADR-0043 §2):首轮 system 含
 *     `<mcp_name_directory>`、visibleSchemas 不含 mcp__ schema;模型真实
 *     调 tool_search 拉回 schema(tools 尾部追加),再真实调 mcp__ echo 工具。
 *
 *   it 3 — countTokens 真实冒烟(B6):adapter.countTokens 透传 SDK
 *     client.messages.countTokens,返回正数。装配期溢出治理同源。
 *
 * skip-guard:HAS_KEY 缺失 → describe.skip + Not run(照抄 t8 形态,
 * 不 stub 替身、不删测试)。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadIknowEnv } from "../../src/config/env.ts";
import { buildHarnessEngine } from "../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import { run } from "../../src/harness/loop-engine.ts";

// ── env + HAS_KEY 守卫(t8 同款)──────────────────────────────────────────
const env = loadIknowEnv(process.cwd());
const HAS_KEY =
  typeof env.llm.apiKey === "string" &&
  env.llm.apiKey.length > 0 &&
  env.llm.apiKey !== "your-api-key" &&
  !env.llm.apiKey.startsWith("YOUR_");
if (!HAS_KEY) console.log("[SKIP] LLM key not set; Not run");

const MCP_SERVER_FIXTURE = join(
  import.meta.dirname,
  "fixtures/layering-mcp-server.mjs"
);

const runOrSkip = HAS_KEY ? describe : describe.skip;

runOrSkip("model-prefix-layering real-LLM e2e (B8 / SC9)", () => {
  const roots: string[] = [];
  const shutdowns: Array<() => Promise<void>> = [];
  afterAll(async () => {
    await Promise.all(shutdowns.splice(0).map((f) => f()));
    await Promise.all(
      roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))
    );
  });

  async function buildChatEngine(
    opts: { readonly mcpServers?: string } = {}
  ): Promise<{
    deps: Awaited<ReturnType<typeof buildHarnessEngine>>["deps"];
    catalog: NonNullable<
      Awaited<ReturnType<typeof buildHarnessEngine>>["catalog"]
    >;
    root: string;
  }> {
    const root = await mkdtemp(join(tmpdir(), "iknow-b8-real-"));
    roots.push(root);
    await mkdir(join(root, ".iknow"), { recursive: true });
    await writeFile(join(root, "note.txt"), "layering-e2e-marker-42\n", "utf8");
    if (opts.mcpServers !== undefined) {
      await writeFile(join(root, ".iknow", "mcp.json"), opts.mcpServers, "utf8");
    }
    const built = await buildHarnessEngine({
      env,
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
    });
    if (built.shutdown) shutdowns.push(built.shutdown);
    return {
      deps: built.deps,
      // BuiltEngine 全量视图透出的 AciCatalog(reg.catalog 等价面,
      // registerExternal / discover 副作用都打在装配单点 reg 上)。
      catalog: built.catalog!,
      root,
    };
  }

  it(
    "[llm] 真实端点多 turn 会话 + ≥1 次真实 tool_call",
    async () => {
      const { deps, root } = await buildChatEngine();
      const { result } = await run(
        `Read the file note.txt in the project root using the read_file tool. ` +
          `Then reply with exactly the file's content and stop. Do not use any other tools.`,
        { ...deps, maxTurns: 4 }
      );
      // 多 turn:turn ≥ 2(text-only 一回合结束的 turnCount = 1;经真实
      // tool_call 回路至少 2 个 assistant 回合)。
      expect(result.stopReason).toBe("completed");
      expect(result.turnCount).toBeGreaterThanOrEqual(2);
      expect(result.finalText).toContain("layering-e2e-marker-42");
      // 权威历史含真实 tool_use + tool_result 块(B3 消息追加缝真打通)。
      const tools = result.messages.flatMap((m) =>
        Array.isArray((m as { content?: unknown }).content)
          ? ((m as { content: Array<{ type: string }> }).content ?? [])
          : []
      );
      expect(tools.some((b) => b.type === "tool_use")).toBe(true);
      expect(tools.some((b) => b.type === "tool_result")).toBe(true);
      void root;
    },
    360_000
  );

  it(
    "[mcp] MCP 真连接 + 名字目录 + tool_search 加载回路",
    async () => {
      const { deps, catalog, root } = await buildChatEngine({
        mcpServers: JSON.stringify({
          mcpServers: {
            layering: {
              type: "stdio",
              command: "node",
              args: [MCP_SERVER_FIXTURE],
            },
          },
        }),
      });
      // 1) 首轮 system 含名字目录(裸名,无 schema);visibleSchemas 首轮
      //    不含 mcp__ schema(lazy 不进 promptTools)。
      const systemText = await deps.system?.();
      expect(systemText).toContain("<mcp_name_directory>");
      expect(systemText).toContain("mcp__layering__echo");
      expect(systemText).not.toContain("inputSchema");
      const firstSchemas = deps.promptTools!();
      expect(
        firstSchemas.some((t) => t.name.startsWith("mcp__"))
      ).toBe(false);
      expect(firstSchemas.some((t) => t.name === "tool_search")).toBe(true);
      // 2) 模型真实调 tool_search → schema 尾部追加进 tools 双写。
      //    tool_search 的 discover 副作用打在装配单点 reg 上,下一轮
      //    promptTools 即含 mcp__ schema(尾部,注册序前缀逐位不变)。
      const { result } = await run(
        `Load the tool named "mcp__layering__echo" with the tool_search tool (pass names: ["mcp__layering__echo"]). ` +
          `Then call it with text "real-mcp-roundtrip". Report its exact output and stop. ` +
          `Do not use any other tools besides tool_search and that one MCP tool.`,
        { ...deps, maxTurns: 6 }
      );
      expect(result.stopReason).toBe("completed");
      expect(result.finalText).toContain("echo: real-mcp-roundtrip");
      // tools 尾部追加:相邻轮 promptTools 相比首轮尾部多出 mcp__ schema,
      // 注册序前缀逐位不变(#224 / ADR-0043 §2 尾部追加纪律)。
      const afterSchemas = deps.promptTools!();
      expect(
        afterSchemas.some((t) => t.name === "mcp__layering__echo")
      ).toBe(true);
      expect(
        afterSchemas.slice(0, firstSchemas.length).map((t) => t.name)
      ).toEqual(firstSchemas.map((t) => t.name));
      expect(afterSchemas.length).toBe(firstSchemas.length + 1);
      // 真实 MCP 工具调用进了权威历史(tool_use 名 = mcp__layering__echo)。
      const blocks = result.messages.flatMap((m) =>
        Array.isArray((m as { content?: unknown }).content)
          ? ((m as { content: Array<{ type: string; name?: string }> })
              .content ?? [])
          : []
      );
      expect(
        blocks.some(
          (b) => b.type === "tool_use" && b.name === "mcp__layering__echo"
        )
      ).toBe(true);
      // catalog 全量含 MCP 件(registerExternal 打在装配单点)。
      expect(
        catalog!.all().some((t) => t.name === "mcp__layering__echo")
      ).toBe(true);
      void root;
    },
    360_000
  );

  it(
    "[countTokens] B6 — adapter.countTokens 真实冒烟(返正数)",
    async () => {
      // 不经 build-engine(装配期溢出治理已各自覆盖);直接取装配同源
      // adapter(与 build-engine createAdapterFromEnv 同一构造路径)。
      const { createAdapterFromEnv } = await import(
        "../../src/harness/build-engine.ts"
      );
      const { adapter } = createAdapterFromEnv(env);
      const res = await adapter.countTokens!({
        tools: [
          {
            name: "bash",
            description: "Run shell commands.",
            inputSchema: {
              type: "object",
              properties: { cmd: { type: "string" } },
              required: ["cmd"],
            },
          },
        ],
        system: "You are a harness under test.",
      });
      expect(Number.isFinite(res.inputTokens)).toBe(true);
      expect(res.inputTokens).toBeGreaterThan(0);
    },
    120_000
  );
});
