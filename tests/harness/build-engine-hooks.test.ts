/**
 * user-hook-router（specs/user-hook-router.md）SC7 / SC8 / SC9 装配级回归钉子。
 *
 * 工厂层单元语义已由 tests/harness/hooks/user-hooks.test.ts 钉住；本文件钉
 * 的是 build-engine 装配缝 —— 用户钩子（user hooks） 与 内置钩子（builtin hooks）（auto-memory host
 * 钩子、secrets guard）经真实 buildHarnessEngine 装配后互不覆盖：
 *   - SC7: hooks 总闸关不掉 memory.autoExtract 的 auto-memory host 钩子
 *     （断言面沿用 tests/harness/build-engine-auto-memory.test.ts 的
 *     `engine.autoMemory` 装配断言）。
 *   - SC8: secrets.mode="block" 时 secrets guard 仍在 Pre 缝（真实
 *     `[hook_blocked]` message，沿 permission-executor.test.ts 断言形态）；
 *     反向：enabled user rule 真被编进产品 executor（不只工厂单测）。
 *   - SC9: TUI opts.hooks（postToolUse，Step 5 观测）与 user Pre（Step 1
 *     deny）同时在场互不覆盖 —— deny 短路时 inner 零调用故 spy 零触发，
 *     放行时观测照常。
 *
 * 测试缝（对齐 build-engine-auto-memory.test.ts / #406 e2e）：opts.settings
 * 注入（#126 T5）+ tmp cwd/userHome 隔离，不读真实 ~/.iknow、不污染
 * process.env。executor 调用全部在 Pre/permission 层短路或走真实 read_file
 * 内实现，不需要 LLM 连接。
 */
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildHarnessEngine,
  type BuiltEngine,
} from "../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import type { PostToolUseHook } from "../../src/harness/permission/types.ts";
import type { IknowEnv } from "../../src/config/env.ts";
import type { IknowSettings } from "../../src/config/settings.ts";

const built: BuiltEngine[] = [];
const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(built.map((b) => b.shutdown?.()));
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** Deterministic env — never reads process.env / .env files (env.ts SSOT). */
function makeEnv(): IknowEnv {
  return {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      fallback: [],
      apiKey: "sk-test-hook-router",
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
  };
}

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(root);
  return root;
}

async function build(
  settings: IknowSettings,
  opts: { postToolUse?: PostToolUseHook; root?: string } = {}
): Promise<BuiltEngine> {
  const root = opts.root ?? (await makeRoot("iknow-hook-router-"));
  const engine = await buildHarnessEngine({
    env: makeEnv(),
    askUser: createNoAskUser(),
    cwd: root,
    userHome: root,
    workspaceRoot: root,
    sandboxRoot: root,
    // 本文件验 hooks 路由与 memory 正交,不验溢出退场 / 索引降档(专测见
    // build-engine-tool-overflow.test.ts、disclosure-index-align/)。
    // 旁路装配期 countTokens:缝语义见 BuildEngineOpts.skipCountTokens 注释。
    skipCountTokens: true,
    ...(opts.postToolUse ? { hooks: opts.postToolUse } : {}),
    settings,
  });
  built.push(engine);
  return engine;
}

describe("buildHarnessEngine — user-hook-router SC7（hooks 总闸与 memory 正交）", () => {
  it("hooks.enabled=false + 恶意通配规则 → auto-memory host 钩子仍按现约装配", async () => {
    const root = await makeRoot("iknow-sc7-off-");
    const engine = await build(
      {
        hooks: {
          enabled: false,
          rules: [
            { id: "evil", event: "PreToolUse", pattern: ".*", reason: "x" },
          ],
        },
        memory: { autoExtract: true },
      },
      { root }
    );
    // 断言面与 build-engine-auto-memory.test.ts「wires autoMemory on an
    // explicit true」同构：装配在场的判据是有 onTurnComplete 的 host 钩子。
    expect(engine.autoMemory).toBeDefined();
    expect(typeof engine.autoMemory!.onTurnComplete).toBe("function");
  });

  it("同一总闸下通配规则确实不拦（enabled=false 分支有判别力）", async () => {
    const root = await makeRoot("iknow-sc7-passthrough-");
    const filePath = join(root, "note.txt");
    await writeFile(filePath, "hello sc7\n", "utf8");
    const engine = await build(
      {
        hooks: {
          enabled: false,
          rules: [
            { id: "evil", event: "PreToolUse", pattern: ".*", reason: "x" },
          ],
        },
      },
      { root }
    );
    const [result] = await engine.deps.executor.executeAll([
      { id: "sc7-read", name: "read_file", input: { path: filePath } },
    ]);
    expect(result.kind).toBe("ok");
  });

  it("对照：同一条通配规则 enabled=true 时真的拦（证明上一条不是空转）", async () => {
    const root = await makeRoot("iknow-sc7-teeth-");
    const filePath = join(root, "note.txt");
    await writeFile(filePath, "hello sc7 teeth\n", "utf8");
    const engine = await build(
      {
        hooks: {
          enabled: true,
          rules: [
            { id: "evil", event: "PreToolUse", pattern: ".*", reason: "x" },
          ],
        },
      },
      { root }
    );
    const [result] = await engine.deps.executor.executeAll([
      { id: "sc7-teeth", name: "read_file", input: { path: filePath } },
    ]);
    expect(result.kind).toBe("execution_failed");
    if (result.kind === "execution_failed") {
      expect(result.message.includes("[hook_blocked]")).toBe(true);
    }
  });
});

describe("buildHarnessEngine — user-hook-router SC8（secrets guard 与 hooks 总闸正交）", () => {
  it("secrets.mode=block + hooks.enabled=false → secrets guard 仍在 Pre 缝拦密钥形态", async () => {
    const root = await makeRoot("iknow-sc8-guard-");
    const engine = await build(
      { secrets: { mode: "block" }, hooks: { enabled: false } },
      { root }
    );
    // sk- 后 20+ 字符命中内置集 `sk-[A-Za-z0-9_-]{20,}`（secret-roundtrip/patterns.ts）。
    const [result] = await engine.deps.executor.executeAll([
      {
        id: "sc8-leak",
        name: "bash",
        input: { command: "echo sk-abcdef0123456789abcdef01" },
      },
    ]);
    expect(result.kind).toBe("execution_failed");
    if (result.kind === "execution_failed") {
      // guard 拦截经 executor 包装成 [hook_blocked]（permission-executor 契约）。
      expect(result.message.startsWith("[hook_blocked]")).toBe(true);
    }
  });

  it("反向：enabled user rule 真被编进产品 executor（read_file → [hook_blocked] no reads）", async () => {
    const root = await makeRoot("iknow-sc8-user-");
    const filePath = join(root, "note.txt");
    await writeFile(filePath, "hello sc8 user\n", "utf8");
    const engine = await build(
      {
        hooks: {
          enabled: true,
          rules: [
            {
              id: "r1",
              event: "PreToolUse",
              tool: "read_file",
              reason: "no reads",
            },
          ],
        },
      },
      { root }
    );
    const [result] = await engine.deps.executor.executeAll([
      { id: "sc8-user-read", name: "read_file", input: { path: filePath } },
    ]);
    expect(result.kind).toBe("execution_failed");
    if (result.kind === "execution_failed") {
      expect(result.message.includes("[hook_blocked]")).toBe(true);
      expect(result.message.includes("no reads")).toBe(true);
    }
  });
});

describe("buildHarnessEngine — user-hook-router SC9（postToolUse 观测与 user Pre deny 互不覆盖）", () => {
  it("deny 短路时 Step 5 spy 零触发；放行调用时观测照常", async () => {
    const root = await makeRoot("iknow-sc9-");
    const notePath = join(root, "note.txt");
    const secretPath = join(root, "secret.txt");
    await writeFile(notePath, "hello sc9\n", "utf8");
    await writeFile(secretPath, "s\n", "utf8");

    const postCalls: Array<Parameters<PostToolUseHook>[0]> = [];
    const engine = await build(
      {
        hooks: {
          enabled: true,
          rules: [
            {
              id: "r1",
              event: "PreToolUse",
              tool: "read_file",
              pattern: "secret",
              reason: "no secret reads",
            },
          ],
        },
      },
      {
        postToolUse: (result) => {
          postCalls.push(result);
        },
        root,
      }
    );

    // 被拦调用：Pre deny（Step 1）短路 → inner 零调用 → Step 5 不跑。
    const [blocked] = await engine.deps.executor.executeAll([
      { id: "sc9-blocked", name: "read_file", input: { path: secretPath } },
    ]);
    expect(blocked.kind).toBe("execution_failed");
    if (blocked.kind === "execution_failed") {
      expect(blocked.message.includes("[hook_blocked] no secret reads")).toBe(
        true
      );
    }
    expect(postCalls.length).toBe(0);

    // 未拦调用：pattern 不命中 → 放行 → inner 真执行 → Step 5 spy 触发。
    const [passed] = await engine.deps.executor.executeAll([
      { id: "sc9-passed", name: "read_file", input: { path: notePath } },
    ]);
    expect(passed.kind).toBe("ok");
    expect(postCalls.length).toBe(1);
    expect(postCalls[0]!.toolUseId).toBe("sc9-passed");
    expect(postCalls[0]!.name).toBe("read_file");
    expect(postCalls[0]!.kind).toBe("ok");
  });
});

describe("buildHarnessEngine — #global-plugins T2 插件 hooks 装配面", () => {
  /** 造一个插件目录：`<root>/<name>/hooks/hooks.json`。 */
  async function makePlugin(
    base: string,
    name: string,
    hooksJson: unknown
  ): Promise<string> {
    const dir = join(base, name, "hooks");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "hooks.json"), JSON.stringify(hooksJson), "utf8");
    return join(base, name);
  }

  it("插件 Pre hook 经产品 executor 真拦下（exit 2 → [hook_blocked]）", async () => {
    const root = await makeRoot("iknow-plugins-pre-");
    const pluginsRoot = join(root, "plugin-roots");
    const pluginRoot = await makePlugin(pluginsRoot, "gatekeeper", {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command:
                  "node -e \"process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('plugin said no');process.exit(2)})\"",
                timeout: 15,
              },
            ],
          },
        ],
      },
    });
    const engine = await build({ plugins: { roots: [pluginsRoot] } }, { root });
    expect(pluginRoot.endsWith("gatekeeper")).toBe(true);

    const [blocked] = await engine.deps.executor.executeAll([
      { id: "pg-1", name: "bash", input: { command: "echo hi" } },
    ]);
    expect(blocked.kind).toBe("execution_failed");
    if (blocked.kind === "execution_failed") {
      expect(blocked.message.startsWith("[hook_blocked]")).toBe(true);
      expect(blocked.message.includes("plugin said no")).toBe(true);
    }
  });

  it("插件 Post hook 与 TUI post 并存（TUI 在前、两者都观测到结果）", async () => {
    const root = await makeRoot("iknow-plugins-post-");
    const pluginsRoot = join(root, "plugin-roots");
    // 插件 Post 把观测落到 `${*_PLUGIN_DATA}` —— 一并验占位符替换 + 首引即建
    // （userHome = root），无需依赖测试进程 env。
    await makePlugin(pluginsRoot, "observer", {
      hooks: {
        PostToolUse: [
          {
            matcher: "read_file",
            hooks: [
              {
                type: "command",
                command:
                  "node -e \"require('fs').appendFileSync(process.argv[1],'p');process.stdin.resume()\" \"${OBS_PLUGIN_DATA}/post.txt\"",
                timeout: 15,
              },
            ],
          },
        ],
      },
    });
    const notePath = join(root, "note.txt");
    await writeFile(notePath, "hello plugin post\n", "utf8");
    const pluginDataFile = join(
      root,
      ".iknow",
      "plugin-data",
      "observer",
      "post.txt"
    );
    // TUI hook 记录「自己被调用时插件文件是否已存在」—— 用于证明 TUI 在前。
    const tuiSaw: string[] = [];
    const engine = await build(
      { plugins: { roots: [pluginsRoot] } },
      {
        root,
        postToolUse: () => {
          tuiSaw.push(
            existsSync(pluginDataFile)
              ? readFileSync(pluginDataFile, "utf8")
              : "<absent>"
          );
        },
      }
    );
    const [result] = await engine.deps.executor.executeAll([
      { id: "pg-post", name: "read_file", input: { path: notePath } },
    ]);
    expect(result.kind).toBe("ok");
    // 插件 Post 真观测到（文件被写出）
    expect(existsSync(pluginDataFile)).toBe(true);
    expect(readFileSync(pluginDataFile, "utf8")).toBe("p");
    // TUI 在前：TUI hook 跑时插件 hook 尚未执行（文件仍缺席）
    expect(tuiSaw).toEqual(["<absent>"]);
  });

  it("disabled 插件的 hooks 不装配（§3.3）", async () => {
    const root = await makeRoot("iknow-plugins-disabled-");
    const pluginsRoot = join(root, "plugin-roots");
    await makePlugin(pluginsRoot, "muted", {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: 'node -e "process.exit(2)"',
                timeout: 15,
              },
            ],
          },
        ],
      },
    });
    const engine = await build(
      { plugins: { roots: [pluginsRoot], disabled: ["muted"] } },
      { root }
    );
    const [result] = await engine.deps.executor.executeAll([
      { id: "pg-off", name: "bash", input: { command: "echo hi" } },
    ]);
    // disabled → 无插件 hook；bash 走正常权限路径（非 [hook_blocked]）。
    if (result.kind === "execution_failed") {
      expect(result.message.includes("plugin")).toBe(false);
    } else {
      expect(result.kind).toBe("ok");
    }
  });

  it("无插件根 → 装配路径不变（既有无插件行为回归钉子）", async () => {
    const root = await makeRoot("iknow-plugins-none-");
    const notePath = join(root, "note.txt");
    await writeFile(notePath, "no plugins here\n", "utf8");
    const engine = await build({}, { root });
    const [result] = await engine.deps.executor.executeAll([
      { id: "pg-none", name: "read_file", input: { path: notePath } },
    ]);
    expect(result.kind).toBe("ok");
  });
});
