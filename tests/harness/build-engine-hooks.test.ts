/**
 * 用户 command 钩子 + 插件 hooks 装配级回归（buildHarnessEngine）。
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
    skipCountTokens: true,
    ...(opts.postToolUse ? { hooks: opts.postToolUse } : {}),
    settings,
  });
  built.push(engine);
  return engine;
}

function denyCommand(reason: string): string {
  return `node -e ${JSON.stringify(
    `let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{process.stderr.write(${JSON.stringify(reason)});process.exit(2)})`
  )}`;
}

function denyIfPathIncludes(needle: string, reason: string): string {
  return `node -e ${JSON.stringify(
    `let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d||'{}');const p=String((j.tool_input&&(j.tool_input.file_path||j.tool_input.path))||'');if(p.includes(${JSON.stringify(needle)})){process.stderr.write(${JSON.stringify(reason)});process.exit(2)}process.exit(0)})`
  )}`;
}

describe("buildHarnessEngine — settings command hooks 与 memory 正交", () => {
  it("PreToolUse command 在场 → auto-memory host 钩子仍装配", async () => {
    const root = await makeRoot("iknow-sc7-off-");
    const engine = await build(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                { type: "command", command: denyCommand("x"), timeout: 15 },
              ],
            },
          ],
        },
        memory: { autoExtract: true },
      },
      { root }
    );
    expect(engine.autoMemory).toBeDefined();
    expect(typeof engine.autoMemory!.onTurnComplete).toBe("function");
  });

  it("matcher 未命中 → 放行", async () => {
    const root = await makeRoot("iknow-sc7-passthrough-");
    const filePath = join(root, "note.txt");
    await writeFile(filePath, "hello sc7\n", "utf8");
    const engine = await build(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                { type: "command", command: denyCommand("x"), timeout: 15 },
              ],
            },
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
});

describe("buildHarnessEngine — secrets guard 与 settings command 正交", () => {
  it("secrets.mode=block + settings command 在场 → secrets guard 仍拦密钥", async () => {
    const root = await makeRoot("iknow-sc8-guard-");
    const engine = await build(
      {
        secrets: { mode: "block" },
        hooks: {
          PreToolUse: [
            {
              matcher: "Read",
              hooks: [
                { type: "command", command: denyCommand("x"), timeout: 15 },
              ],
            },
          ],
        },
      },
      { root }
    );
    const [result] = await engine.deps.executor.executeAll([
      {
        id: "sc8-leak",
        name: "bash",
        input: { command: "echo sk-abcdef0123456789abcdef01" },
      },
    ]);
    expect(result.kind).toBe("execution_failed");
    if (result.kind === "execution_failed") {
      expect(result.message.startsWith("[hook_blocked]")).toBe(true);
    }
  });

  it("settings PreToolUse command 真拦 bash（exit 2）", async () => {
    const root = await makeRoot("iknow-sc8-user-");
    const engine = await build(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                {
                  type: "command",
                  command: denyCommand("no bash"),
                  timeout: 15,
                },
              ],
            },
          ],
        },
      },
      { root }
    );
    const [result] = await engine.deps.executor.executeAll([
      { id: "sc8-user-bash", name: "bash", input: { command: "echo hi" } },
    ]);
    expect(result.kind).toBe("execution_failed");
    if (result.kind === "execution_failed") {
      expect(result.message.includes("[hook_blocked]")).toBe(true);
      expect(result.message.includes("no bash")).toBe(true);
    }
  });
});

describe("buildHarnessEngine — postToolUse 观测与 settings Pre deny 互不覆盖", () => {
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
          PreToolUse: [
            {
              matcher: "Read",
              hooks: [
                {
                  type: "command",
                  command: denyIfPathIncludes("secret", "no secret reads"),
                  timeout: 15,
                },
              ],
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
    expect(existsSync(pluginDataFile)).toBe(true);
    expect(readFileSync(pluginDataFile, "utf8")).toBe("p");
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
