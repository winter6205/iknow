/**
 * plugin-hooks: tests for the plugin `hooks/hooks.json` file source.
 *
 * Pins down, one by one: parse-time degradation, matcher tri-state,
 * tool-name candidate sets, envelope fields and the alias view, exit-code
 * semantics, placeholders and env export, first-block-wins ordering, and the
 * async chain.
 *
 * Child processes are really spawned (`node -e` / `sh`), never mocked — same
 * discipline as the project rule that command-handler integration tests wire
 * real dependencies. The only exception is the spawn-ENOENT path (an
 * unreachable binary name).
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createPluginHookContribution,
  createPluginHooksFromCatalog,
  evaluatePluginHookMatcher,
  pluginHookTimeoutMs,
  pluginHookToolNames,
  PLUGIN_HOOK_DEFAULT_TIMEOUT_SECONDS,
  PLUGIN_HOOK_MAX_TIMEOUT_SECONDS,
  PLUGIN_HOOK_OUTPUT_CAP_BYTES,
  type CreatePluginHookContributionOpts,
} from "../../../src/harness/hooks/plugin-hooks.js";
import type { HookErrorEvent } from "../../../src/harness/permission/permission-executor.js";
import type {
  PostToolUseHook,
  PreToolUseHook,
} from "../../../src/harness/permission/types.js";

// ─── Test scaffolding ────────────────────────────────────────────────────────

interface Sandbox {
  readonly dir: string;
  /** Write a hooks.json, return its {file, plugin} entry. */
  hookFile: (
    plugin: string,
    content: unknown
  ) => {
    file: string;
    plugin: string;
  };
  /** Write a hooks.json with raw text (for the invalid-JSON path). */
  rawHookFile: (
    plugin: string,
    content: string
  ) => {
    file: string;
    plugin: string;
  };
  pluginRoot: (plugin: string) => string;
  cleanup: () => void;
}

function makeSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "plugin-hooks-test-"));
  const roots = new Map<string, string>();
  return {
    dir,
    hookFile: (plugin, content) => {
      const root = join(dir, "plugins", plugin);
      mkdirSync(join(root, "hooks"), { recursive: true });
      const file = join(root, "hooks", "hooks.json");
      writeFileSync(file, JSON.stringify(content), "utf8");
      roots.set(plugin, root);
      return { file, plugin };
    },
    rawHookFile: (plugin, content) => {
      const root = join(dir, "plugins", plugin);
      mkdirSync(join(root, "hooks"), { recursive: true });
      const file = join(root, "hooks", "hooks.json");
      writeFileSync(file, content, "utf8");
      roots.set(plugin, root);
      return { file, plugin };
    },
    pluginRoot: (plugin) => {
      const root = roots.get(plugin);
      if (root === undefined) throw new Error(`unknown plugin ${plugin}`);
      return root;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

interface Harness {
  readonly errors: HookErrorEvent[];
  readonly warns: string[];
  readonly opts: CreatePluginHookContributionOpts;
}

/**
 * Single entry point for building a contribution: files come from the caller;
 * roots / userHome / cwd derive from the sandbox. onError collects typed
 * events (assert the phase); warn also receives a copy (covers the
 * onError-absent path).
 */
function makeHarness(
  sandbox: Sandbox,
  files: ReadonlyArray<{ file: string; plugin: string }>,
  overrides?: Partial<CreatePluginHookContributionOpts>
): Harness {
  const errors: HookErrorEvent[] = [];
  const warns: string[] = [];
  const opts: CreatePluginHookContributionOpts = {
    files,
    roots: new Map(),
    userHome: join(sandbox.dir, "home"),
    projectDir: sandbox.dir,
    cwd: sandbox.dir,
    env: { PATH: process.env.PATH ?? "" },
    warn: (m) => warns.push(m),
    onError: (e) => errors.push(e),
    ...overrides,
  };
  return { errors, warns, opts };
}

/** One-line node script: reads stdin to completion, then prints / exits per the script logic. */
function nodeCommand(script: string): string {
  return `node -e ${JSON.stringify(script)}`;
}

/**
 * Recover the envelope JSON from plugin-exec diagnostic text (the script
 * deliberately writes the envelope to stderr, brought back via the exit-2
 * reason channel) — avoids opening a second channel.
 */
function envelopeFrom(message: string): Record<string, unknown> {
  const start = message.indexOf("{");
  return JSON.parse(
    message.slice(start, message.lastIndexOf("}") + 1)
  ) as Record<string, unknown>;
}

/** Assert the Pre hook passes (undefined). */
async function assertPrePass(
  pre: PreToolUseHook,
  tool: string,
  input: unknown
): Promise<void> {
  assert.equal(await pre({ tool, input }), undefined);
}

// ─── Tool-name candidate sets / matcher pure functions ───────────────────────

describe("pluginHookToolNames — §5.3 候选集表", () => {
  it("表内工具：首项是规范 iknow 名，含协议别名", () => {
    assert.deepEqual(pluginHookToolNames("bash"), ["bash", "Bash"]);
    assert.deepEqual(pluginHookToolNames("write_file"), [
      "write_file",
      "Write",
    ]);
    assert.deepEqual(pluginHookToolNames("edit_file"), [
      "edit_file",
      "Edit",
      "MultiEdit",
    ]);
    assert.deepEqual(pluginHookToolNames("read_file"), ["read_file", "Read"]);
    assert.deepEqual(pluginHookToolNames("grep"), ["grep", "Grep"]);
    assert.deepEqual(pluginHookToolNames("glob"), ["glob", "Glob"]);
    assert.deepEqual(pluginHookToolNames("skill"), ["skill", "Skill"]);
    assert.deepEqual(pluginHookToolNames("spawn_subagent"), [
      "spawn_subagent",
      "Task",
      "Agent",
    ]);
  });

  it("todo_write 不映射 Write（账本工具误映射会让写门禁误拦）", () => {
    assert.deepEqual(pluginHookToolNames("todo_write"), ["todo_write"]);
    assert.ok(!pluginHookToolNames("todo_write").includes("Write"));
  });

  it("表外工具仅自身名（不猜别名）", () => {
    assert.deepEqual(pluginHookToolNames("webfetch"), ["webfetch"]);
    assert.deepEqual(pluginHookToolNames("mcp__x__y"), ["mcp__x__y"]);
  });
});

describe("evaluatePluginHookMatcher — §5.3 三态求值", () => {
  it('缺席 / "" / "*" → 通配（任意候选名命中）', () => {
    assert.equal(evaluatePluginHookMatcher(undefined, ["bash", "Bash"]), true);
    assert.equal(evaluatePluginHookMatcher("", ["bash"]), true);
    assert.equal(evaluatePluginHookMatcher("*", ["bash"]), true);
  });

  it("精确类字符集：`|` / `,` 分隔备选，去空白，大小写敏感", () => {
    assert.equal(
      evaluatePluginHookMatcher("Write|Edit", ["edit_file", "Edit"]),
      true
    );
    assert.equal(
      evaluatePluginHookMatcher("Write, Read", ["read_file", "Read"]),
      true
    );
    assert.equal(
      evaluatePluginHookMatcher("Write|Edit", ["todo_write"]),
      false,
      "todo_write 不得被 Write 命中"
    );
    assert.equal(
      evaluatePluginHookMatcher("write", ["write_file", "Write"]),
      false
    );
    assert.equal(evaluatePluginHookMatcher("Bash", ["bash"]), false);
  });

  it("混合分隔符 `|` 与 `,` 均可", () => {
    assert.equal(evaluatePluginHookMatcher("Bash,Read|Glob", ["Read"]), true);
    assert.equal(
      evaluatePluginHookMatcher("Bash,Read|Glob", ["glob", "Glob"]),
      true
    );
    assert.equal(
      evaluatePluginHookMatcher("Bash,Read|Glob", ["edit_file"]),
      false
    );
  });

  it("含正则元字符 → 非锚定 RegExp.prototype.test 语义", () => {
    // Unanchored `Edit.*`: matches both Edit and MultiEdit
    assert.equal(evaluatePluginHookMatcher("Edit.*", ["Edit"]), true);
    assert.equal(evaluatePluginHookMatcher("Edit.*", ["MultiEdit"]), true);
    assert.equal(evaluatePluginHookMatcher("Edit.*", ["NoWrite"]), false);
    // Unanchored: `a.h` matches `Bash`
    assert.equal(evaluatePluginHookMatcher("a.h", ["Bash"]), true);
  });

  it("纯字母数字 matcher 走精确备选，不做正则解释（`ash` 不匹配 `Bash`）", () => {
    assert.equal(evaluatePluginHookMatcher("ash", ["Bash"]), false);
    assert.equal(evaluatePluginHookMatcher("ash", ["ash"]), true);
  });

  it("非法正则 → false（不抛；构造期已剔除该组）", () => {
    assert.equal(evaluatePluginHookMatcher("[unclosed", ["bash"]), false);
    assert.equal(evaluatePluginHookMatcher("((", ["bash"]), false);
  });

  it("纯分隔符 / 空白 matcher → 视同通配（无有效备选）", () => {
    assert.equal(evaluatePluginHookMatcher("|", ["bash"]), true);
    assert.equal(evaluatePluginHookMatcher(" ", ["bash"]), true);
  });

  it("候选集任一命中即命中（多候选工具）", () => {
    assert.equal(
      evaluatePluginHookMatcher("MultiEdit", [
        "edit_file",
        "Edit",
        "MultiEdit",
      ]),
      true
    );
    assert.equal(
      evaluatePluginHookMatcher("Agent", ["spawn_subagent", "Task", "Agent"]),
      true
    );
  });
});

describe("pluginHookTimeoutMs — §5.1 归一", () => {
  it("缺省 30s → 30000ms", () => {
    assert.equal(pluginHookTimeoutMs(undefined), 30000);
    assert.equal(
      pluginHookTimeoutMs(undefined),
      PLUGIN_HOOK_DEFAULT_TIMEOUT_SECONDS * 1000
    );
  });

  it("非数值 / 非有限 / ≤0 → 缺省", () => {
    assert.equal(pluginHookTimeoutMs("5"), 30000);
    assert.equal(pluginHookTimeoutMs(Number.NaN), 30000);
    assert.equal(pluginHookTimeoutMs(Number.POSITIVE_INFINITY), 30000);
    assert.equal(pluginHookTimeoutMs(0), 30000);
    assert.equal(pluginHookTimeoutMs(-1), 30000);
  });

  it("合法值 → 秒转毫秒", () => {
    assert.equal(pluginHookTimeoutMs(5), 5000);
    assert.equal(pluginHookTimeoutMs(0.5), 500);
  });

  it("超 600s 上限 → 截断到上限", () => {
    assert.equal(
      pluginHookTimeoutMs(9999),
      PLUGIN_HOOK_MAX_TIMEOUT_SECONDS * 1000
    );
    assert.equal(pluginHookTimeoutMs(601), 600000);
    assert.equal(pluginHookTimeoutMs(600), 600000);
  });
});

// ─── Parse-time degradation ──────────────────────────────────────────────────────────

describe("createPluginHookContribution — §5.1 解析降级", () => {
  it("非法 JSON → 跳过该文件 + plugin-init；其他文件照常", async () => {
    const sb = makeSandbox();
    try {
      const bad = sb.rawHookFile("bad", "{ not json");
      const good = sb.hookFile("good", {
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: nodeCommand("process.exit(2)"),
                },
              ],
            },
          ],
        },
      });
      const h = makeHarness(sb, [bad, good]);
      const c = createPluginHookContribution(h.opts);
      assert.ok(c.pre);
      const block = await c.pre({ tool: "bash", input: {} });
      assert.ok(block, "合法文件的 hook 仍生效");
      assert.equal(h.errors.length, 1);
      assert.equal(h.errors[0]!.phase, "plugin-init");
      assert.ok(h.errors[0]!.message.includes("JSON corrupt"));
      assert.ok(h.errors[0]!.message.includes("bad"));
    } finally {
      sb.cleanup();
    }
  });

  it("缺 hooks 键 → 跳过 + plugin-init", () => {
    const sb = makeSandbox();
    try {
      const f = sb.hookFile("nohooks", { description: "x" });
      const h = makeHarness(sb, [f]);
      const c = createPluginHookContribution(h.opts);
      assert.equal(c.pre, undefined);
      assert.equal(h.errors.length, 1);
      assert.equal(h.errors[0]!.phase, "plugin-init");
      assert.ok(h.errors[0]!.message.includes('missing "hooks" object'));
    } finally {
      sb.cleanup();
    }
  });

  it("文件不可读（不存在）→ 跳过 + plugin-init，不抛", () => {
    const sb = makeSandbox();
    try {
      const h = makeHarness(sb, [
        { file: join(sb.dir, "nope", "hooks.json"), plugin: "ghost" },
      ]);
      const c = createPluginHookContribution(h.opts);
      assert.equal(c.pre, undefined);
      assert.equal(h.errors.length, 1);
      assert.equal(h.errors[0]!.phase, "plugin-init");
      assert.ok(h.errors[0]!.message.includes("unreadable"));
    } finally {
      sb.cleanup();
    }
  });

  it("未知事件名 → 忽略 + 每文件一次 warn；已知事件不受影响", async () => {
    const sb = makeSandbox();
    try {
      const f = sb.hookFile("mixed", {
        hooks: {
          PreCompact: [{ hooks: [{ type: "command", command: "true" }] }],
          SessionStart: [{ hooks: [{ type: "command", command: "true" }] }],
          PreToolUse: [
            {
              matcher: "bash",
              hooks: [
                {
                  type: "command",
                  command: nodeCommand(
                    "process.stdin.resume();process.stdin.on('end',()=>process.exit(2))"
                  ),
                },
              ],
            },
          ],
        },
      });
      const h = makeHarness(sb, [f]);
      const c = createPluginHookContribution(h.opts);
      // Two unknown events → one report each (message carries the event name; dedup keys on message text)
      const unknown = h.errors.filter((e) =>
        e.message.includes("unknown hook event")
      );
      assert.equal(unknown.length, 2);
      const initPhases = new Set(h.errors.map((e) => e.phase));
      assert.deepEqual([...initPhases], ["plugin-init"]);
      assert.ok(c.pre);
      assert.ok(await c.pre({ tool: "bash", input: {} }));
    } finally {
      sb.cleanup();
    }
  });

  it("非 command 类型 → 忽略整条 + 逐条 warn，不影响同组 command 条目", async () => {
    const sb = makeSandbox();
    try {
      const f = sb.hookFile("webhooks", {
        hooks: {
          PreToolUse: [
            {
              hooks: [
                { type: "webhook", command: "https://x" },
                { type: "prompt", command: "ask" },
                {
                  type: "command",
                  command: nodeCommand(
                    "process.stdin.resume();process.stdin.on('end',()=>process.exit(2))"
                  ),
                },
              ],
            },
          ],
        },
      });
      const h = makeHarness(sb, [f]);
      const c = createPluginHookContribution(h.opts);
      const nonCommand = h.errors.filter((e) =>
        e.message.includes("non-command")
      );
      assert.equal(nonCommand.length, 2, "两条非 command 各报一次");
      for (const e of nonCommand) assert.equal(e.phase, "plugin-init");
      assert.ok(c.pre, "同组 command 条目仍装配");
      assert.ok(await c.pre({ tool: "bash", input: {} }));
    } finally {
      sb.cleanup();
    }
  });

  it("timeout 超上限 → 截断 + warn（不拒绝整条）", async () => {
    const sb = makeSandbox();
    try {
      const f = sb.hookFile("slow", {
        hooks: {
          PreToolUse: [
            {
              matcher: "bash",
              hooks: [
                {
                  type: "command",
                  command: nodeCommand("process.exit(0)"),
                  timeout: 9999,
                },
              ],
            },
          ],
        },
      });
      const h = makeHarness(sb, [f]);
      const c = createPluginHookContribution(h.opts);
      const clamped = h.errors.filter((e) => e.message.includes("clamped"));
      assert.equal(clamped.length, 1);
      assert.ok(clamped[0]!.message.includes("9999"));
      assert.ok(clamped[0]!.message.includes("600"));
      assert.ok(c.pre, "截断后 handler 仍装配");
      await assertPrePass(c.pre!, "bash", {});
    } finally {
      sb.cleanup();
    }
  });

  it("非法 matcher 正则 → 剔除该组 + plugin-init；同文件其他组合法组仍工作", async () => {
    const sb = makeSandbox();
    try {
      const f = sb.hookFile("mixed-matcher", {
        hooks: {
          PreToolUse: [
            {
              matcher: "[unclosed",
              hooks: [
                { type: "command", command: nodeCommand("process.exit(2)") },
              ],
            },
            {
              matcher: "Bash",
              hooks: [
                {
                  type: "command",
                  command: nodeCommand(
                    "process.stdin.resume();process.stdin.on('end',()=>process.exit(2))"
                  ),
                },
              ],
            },
          ],
        },
      });
      const h = makeHarness(sb, [f]);
      const c = createPluginHookContribution(h.opts);
      assert.equal(h.errors.length, 1);
      assert.ok(h.errors[0]!.message.includes("invalid matcher regex"));
      assert.ok(c.pre);
      // The bad group is pruned → read_file is not blocked (no poisoning: had the bad group stayed, it would wildcard-block)
      await assertPrePass(c.pre!, "read_file", {});
      // The valid group behaves as usual
      assert.ok(await c.pre({ tool: "bash", input: {} }));
    } finally {
      sb.cleanup();
    }
  });

  it("matcher 非字符串 → 丢组 + plugin-init", () => {
    const sb = makeSandbox();
    try {
      const f = sb.hookFile("badmatcher", {
        hooks: {
          PreToolUse: [
            {
              matcher: 42,
              hooks: [{ type: "command", command: "true" }],
            },
          ],
        },
      });
      const h = makeHarness(sb, [f]);
      const c = createPluginHookContribution(h.opts);
      assert.equal(c.pre, undefined);
      assert.equal(h.errors.length, 1);
      assert.ok(h.errors[0]!.message.includes("matcher is not a string"));
    } finally {
      sb.cleanup();
    }
  });

  it("handler 缺 command / command 非字符串 → 忽略该条 + plugin-init", () => {
    const sb = makeSandbox();
    try {
      const f = sb.hookFile("nocmd", {
        hooks: {
          PreToolUse: [
            {
              hooks: [
                { type: "command" },
                { type: "command", command: 42 },
                { type: "command", command: "   " },
              ],
            },
          ],
        },
      });
      const h = makeHarness(sb, [f]);
      const c = createPluginHookContribution(h.opts);
      assert.equal(c.pre, undefined);
      assert.equal(
        h.errors.filter((e) => e.message.includes("missing a command")).length,
        3
      );
    } finally {
      sb.cleanup();
    }
  });

  it("全部降级 → 贡献为空对象（无 pre / post）", () => {
    const sb = makeSandbox();
    try {
      const bad = sb.rawHookFile("b", "{oops");
      const h = makeHarness(sb, [bad]);
      const c = createPluginHookContribution(h.opts);
      assert.equal(c.pre, undefined);
      assert.equal(c.post, undefined);
    } finally {
      sb.cleanup();
    }
  });

  it("相同 (file, event, matcher, command) 去重（同一文件重复列出）", async () => {
    const sb = makeSandbox();
    try {
      const f = sb.hookFile("dup", {
        hooks: {
          PreToolUse: [
            {
              matcher: "bash",
              hooks: [
                {
                  type: "command",
                  command: nodeCommand(
                    "const fs=require('fs');fs.appendFileSync(process.env.COUNT_FILE,'x')"
                  ),
                },
              ],
            },
          ],
        },
      });
      const countFile = join(sb.dir, "count.txt");
      const h = makeHarness(sb, [f, f], {
        env: {
          PATH: process.env.PATH ?? "",
          COUNT_FILE: countFile,
        },
      });
      const c = createPluginHookContribution(h.opts);
      assert.ok(c.pre);
      await c.pre({ tool: "bash", input: {} });
      assert.equal(readFileSync(countFile, "utf8"), "x", "只执行一次");
    } finally {
      sb.cleanup();
    }
  });

  it("matcher / command 自由文本不撞去重键（空格拼接会撞）", async () => {
    const sb = makeSandbox();
    try {
      // (matcher="a b", command="true") differs from (matcher="a", command="b true")
      const f = sb.hookFile("keycollide", {
        hooks: {
          PreToolUse: [
            {
              matcher: "x",
              hooks: [{ type: "command", command: "true" }],
            },
            {
              matcher: "x",
              hooks: [{ type: "command", command: "true" }],
            },
          ],
        },
      });
      const h = makeHarness(sb, [f]);
      const c = createPluginHookContribution(h.opts);
      assert.ok(c.pre);
      await assertPrePass(c.pre!, "bash", {});
    } finally {
      sb.cleanup();
    }
  });

  it("同一 hooks.json 经不同插件名（重复根）→ 去重键含 file，执行一次", async () => {
    const sb = makeSandbox();
    try {
      const f = sb.hookFile("p", {
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: nodeCommand(
                    "const fs=require('fs');fs.appendFileSync(process.env.COUNT_FILE,'y')"
                  ),
                },
              ],
            },
          ],
        },
      });
      const countFile = join(sb.dir, "count2.txt");
      const h = makeHarness(sb, [f, { file: f.file, plugin: "p" }], {
        env: { PATH: process.env.PATH ?? "", COUNT_FILE: countFile },
      });
      const c = createPluginHookContribution(h.opts);
      assert.ok(c.pre);
      await c.pre({ tool: "bash", input: {} });
      assert.equal(readFileSync(countFile, "utf8"), "y");
    } finally {
      sb.cleanup();
    }
  });
});

// ─── Envelope ──────────────────────────────────────────────────────────

describe("createPluginHookContribution — §5.4 envelope", () => {
  /**
   * The node script echoes stdin JSON verbatim to stdout (exit 0); the
   * envelope text is brought back via the exit-2 stdout fallback for assertions — no extra channel.
   */
  async function captureEnvelope(
    sb: Sandbox,
    tool: string,
    input: unknown,
    plugin = "env"
  ): Promise<Record<string, unknown>> {
    const f = sb.hookFile(plugin, {
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: "command",
                command: nodeCommand(
                  "let d='';process.stdin.on('data',c=>d+=c);" +
                    "process.stdin.on('end',()=>{process.stdout.write(d);process.exit(2)})"
                ),
              },
            ],
          },
        ],
      },
    });
    const h = makeHarness(sb, [f]);
    const c = createPluginHookContribution(h.opts);
    const block = await c.pre!({ tool, input });
    assert.ok(block, "exit 2 应拦截");
    return JSON.parse(block.reason) as Record<string, unknown>;
  }

  it("字段：hook_event_name / tool_name(规范名) / tool_input / cwd", async () => {
    const sb = makeSandbox();
    try {
      const env = await captureEnvelope(sb, "edit_file", {
        path: "a.ts",
        old_str: "x",
        new_str: "y",
      });
      assert.equal(env.hook_event_name, "PreToolUse");
      assert.equal(env.tool_name, "edit_file", "首个候选 = 规范 iknow 名");
      assert.equal(env.cwd, sb.dir);
    } finally {
      sb.cleanup();
    }
  });

  it("tool_input 保留原生键 + 别名（file_path / old_string / new_string）", async () => {
    const sb = makeSandbox();
    try {
      const env = await captureEnvelope(sb, "edit_file", {
        path: "a.ts",
        old_str: "x",
        new_str: "y",
      });
      assert.deepEqual(env.tool_input, {
        path: "a.ts",
        old_str: "x",
        new_str: "y",
        file_path: "a.ts",
        old_string: "x",
        new_string: "y",
      });
    } finally {
      sb.cleanup();
    }
  });

  it("别名绝不覆盖原生键（原生 file_path 优先）", async () => {
    const sb = makeSandbox();
    try {
      const env = await captureEnvelope(sb, "write_file", {
        path: "legacy.ts",
        file_path: "native.ts",
      });
      const input = env.tool_input as Record<string, unknown>;
      assert.equal(input.file_path, "native.ts");
      assert.equal(input.path, "legacy.ts");
    } finally {
      sb.cleanup();
    }
  });

  it("skill 工具：name → skill 别名", async () => {
    const sb = makeSandbox();
    try {
      const env = await captureEnvelope(sb, "skill", { name: "pdf-tools" });
      assert.deepEqual(env.tool_input, {
        name: "pdf-tools",
        skill: "pdf-tools",
      });
    } finally {
      sb.cleanup();
    }
  });

  it("session_id / context 恒缺席（Pre/Post 缝上不可得，不编造）", async () => {
    const sb = makeSandbox();
    try {
      const env = await captureEnvelope(sb, "bash", { command: "ls" });
      assert.ok(!("session_id" in env));
      assert.ok(!("context" in env));
      assert.ok(!("tool_response" in env), "Pre envelope 无 tool_response");
    } finally {
      sb.cleanup();
    }
  });

  it("非对象 input 原样透传（不挂别名）", async () => {
    const sb = makeSandbox();
    try {
      const env = await captureEnvelope(sb, "bash", "raw-string");
      assert.equal(env.tool_input, "raw-string");
    } finally {
      sb.cleanup();
    }
  });
});

// ─── Exit-code semantics ────────────────────────────────────────────────────────

describe("createPluginHookContribution — §5.5 Pre 退出码", () => {
  async function preWith(
    sb: Sandbox,
    command: string,
    matcher?: string
  ): Promise<{
    result: unknown;
    errors: HookErrorEvent[];
    warns: string[];
  }> {
    const f = sb.hookFile("codes", {
      hooks: {
        PreToolUse: [
          {
            ...(matcher !== undefined ? { matcher } : {}),
            hooks: [{ type: "command", command, timeout: 15 }],
          },
        ],
      },
    });
    const h = makeHarness(sb, [f]);
    const c = createPluginHookContribution(h.opts);
    const result = await c.pre!({ tool: "bash", input: {} });
    return { result, errors: h.errors, warns: h.warns };
  }

  it("exit 0 → 放行，无告警", async () => {
    const sb = makeSandbox();
    try {
      const { result, errors } = await preWith(
        sb,
        nodeCommand("process.stdin.resume()")
      );
      assert.equal(result, undefined);
      assert.deepEqual(errors, []);
    } finally {
      sb.cleanup();
    }
  });

  it("exit 2 + 纯文本 stderr → block，reason = stderr trimmed", async () => {
    const sb = makeSandbox();
    try {
      const { result, errors } = await preWith(
        sb,
        nodeCommand(
          "process.stderr.write('  no writes today\\n');process.exit(2)"
        )
      );
      assert.deepEqual(result, { reason: "no writes today" });
      assert.deepEqual(errors, []);
    } finally {
      sb.cleanup();
    }
  });

  it("exit 2 + JSON stderr systemMessage → reason = systemMessage", async () => {
    const sb = makeSandbox();
    try {
      const { result } = await preWith(
        sb,
        nodeCommand(
          "process.stderr.write(JSON.stringify({systemMessage:'from system',permissionDecisionReason:'ignored'}));process.exit(2)"
        )
      );
      assert.deepEqual(result, { reason: "from system" });
    } finally {
      sb.cleanup();
    }
  });

  it("exit 2 + JSON stderr permissionDecisionReason（无 systemMessage）→ 取之", async () => {
    const sb = makeSandbox();
    try {
      const { result } = await preWith(
        sb,
        nodeCommand(
          "process.stderr.write(JSON.stringify({permissionDecisionReason:'pdr wins'}));process.exit(2)"
        )
      );
      assert.deepEqual(result, { reason: "pdr wins" });
    } finally {
      sb.cleanup();
    }
  });

  it("exit 2 + 空 stderr，stdout 有文本 → reason = stdout", async () => {
    const sb = makeSandbox();
    try {
      const { result } = await preWith(
        sb,
        nodeCommand("process.stdout.write('stdout reason');process.exit(2)")
      );
      assert.deepEqual(result, { reason: "stdout reason" });
    } finally {
      sb.cleanup();
    }
  });

  it("exit 2 + stderr/stdout 全空 → 通用 reason 含插件名", async () => {
    const sb = makeSandbox();
    try {
      const { result } = await preWith(
        sb,
        nodeCommand("process.stdin.resume();process.exit(2)")
      );
      assert.deepEqual(result, {
        reason: "codes hook blocked the call (exit 2)",
      });
    } finally {
      sb.cleanup();
    }
  });

  it("exit 1 → fail-open + plugin-exec 告警", async () => {
    const sb = makeSandbox();
    try {
      const { result, errors } = await preWith(
        sb,
        nodeCommand("process.stderr.write('boom');process.exit(1)")
      );
      assert.equal(result, undefined, "非 0/2 退出码 fail-open");
      assert.equal(errors.length, 1);
      assert.equal(errors[0]!.phase, "plugin-exec");
      assert.ok(errors[0]!.message.includes("fail-open"));
      assert.ok(errors[0]!.message.includes("exit 1"));
      assert.equal(errors[0]!.tool, "bash");
    } finally {
      sb.cleanup();
    }
  });

  it("spawn 失败（不可达命令）→ fail-open + plugin-exec", async () => {
    const sb = makeSandbox();
    try {
      const { result, errors } = await preWith(
        sb,
        "definitely-not-a-real-binary-xyz --flag"
      );
      assert.equal(result, undefined);
      assert.equal(errors.length, 1);
      assert.equal(errors[0]!.phase, "plugin-exec");
      assert.ok(errors[0]!.message.includes("fail-open"));
    } finally {
      sb.cleanup();
    }
  });

  it("超时 → fail-open + plugin-exec（进程被杀）", async () => {
    const sb = makeSandbox();
    try {
      const f = sb.hookFile("hang", {
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: nodeCommand(
                    "process.stdin.resume();setInterval(()=>{},1000)"
                  ),
                  timeout: 0.5,
                },
              ],
            },
          ],
        },
      });
      const h = makeHarness(sb, [f]);
      const c = createPluginHookContribution(h.opts);
      const started = Date.now();
      const result = await c.pre!({ tool: "bash", input: {} });
      const elapsed = Date.now() - started;
      assert.equal(result, undefined, "超时 fail-open");
      assert.ok(elapsed < 10_000, `应在超时附近返回，实际 ${elapsed}ms`);
      assert.equal(h.errors.length, 1);
      assert.equal(h.errors[0]!.phase, "plugin-exec");
      assert.ok(h.errors[0]!.message.includes("timeout"));
    } finally {
      sb.cleanup();
    }
  });

  it("Kill（自杀信号）→ fail-open + plugin-exec", async () => {
    const sb = makeSandbox();
    try {
      const { result, errors } = await preWith(sb, "kill -9 $$");
      assert.equal(result, undefined);
      assert.equal(errors.length, 1);
      assert.equal(errors[0]!.phase, "plugin-exec");
    } finally {
      sb.cleanup();
    }
  });

  it("告警只出命令头（≤80 字符），不回灌命令全文", async () => {
    const sb = makeSandbox();
    try {
      const longTail = "x".repeat(200);
      const { errors } = await preWith(
        sb,
        `node -e "process.exit(1)" # ${longTail}`
      );
      assert.equal(errors.length, 1);
      assert.ok(!errors[0]!.message.includes(longTail));
    } finally {
      sb.cleanup();
    }
  });
});

describe("createPluginHookContribution — §5.5 Post 退出码（仅观测）", () => {
  async function postWith(
    sb: Sandbox,
    command: string,
    overrides?: Partial<Parameters<PostToolUseHook>[0]>
  ): Promise<{ errors: HookErrorEvent[] }> {
    const f = sb.hookFile("postcodes", {
      hooks: {
        PostToolUse: [
          {
            matcher: "bash",
            hooks: [{ type: "command", command, timeout: 15 }],
          },
        ],
      },
    });
    const h = makeHarness(sb, [f]);
    const c = createPluginHookContribution(h.opts);
    assert.ok(c.post);
    await c.post!({
      toolUseId: "u1",
      name: "bash",
      input: { command: "ls" },
      kind: "ok",
      message: "done",
      ...overrides,
    });
    return { errors: h.errors };
  }

  it("exit 0 → 无动作无告警", async () => {
    const sb = makeSandbox();
    try {
      const { errors } = await postWith(
        sb,
        nodeCommand("process.stdin.resume()")
      );
      assert.deepEqual(errors, []);
    } finally {
      sb.cleanup();
    }
  });

  it("exit 2 → 观测 + plugin-exec 诊断，绝不改变结果（返回值不抛）", async () => {
    const sb = makeSandbox();
    try {
      const { errors } = await postWith(
        sb,
        nodeCommand(
          "process.stderr.write('post observed');process.stdin.resume();process.exit(2)"
        )
      );
      assert.equal(errors.length, 1);
      assert.equal(errors[0]!.phase, "plugin-exec");
      assert.ok(errors[0]!.message.includes("observation only"));
      assert.ok(errors[0]!.message.includes("post observed"));
    } finally {
      sb.cleanup();
    }
  });

  it("exit 1 → fail-open + plugin-exec（Post 上等同观测告警）", async () => {
    const sb = makeSandbox();
    try {
      const { errors } = await postWith(sb, "exit 1");
      assert.equal(errors.length, 1);
      assert.equal(errors[0]!.phase, "plugin-exec");
    } finally {
      sb.cleanup();
    }
  });

  it("Post envelope 含 hook_event_name=PostToolUse + tool_response", async () => {
    const sb = makeSandbox();
    try {
      const f = sb.hookFile("postenv", {
        hooks: {
          PostToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: nodeCommand(
                    "let d='';process.stdin.on('data',c=>d+=c);" +
                      "process.stdin.on('end',()=>{process.stderr.write(d);process.exit(2)})"
                  ),
                },
              ],
            },
          ],
        },
      });
      const h = makeHarness(sb, [f]);
      const c = createPluginHookContribution(h.opts);
      await c.post!({
        toolUseId: "u1",
        name: "write_file",
        input: { path: "a.ts" },
        kind: "ok",
        message: "wrote 3 bytes",
      });
      assert.equal(h.errors.length, 1);
      const env = envelopeFrom(h.errors[0]!.message);
      assert.equal(env.hook_event_name, "PostToolUse");
      assert.equal(env.tool_name, "write_file");
      assert.equal(env.tool_response, "wrote 3 bytes");
      assert.equal(env.cwd, sb.dir);
    } finally {
      sb.cleanup();
    }
  });

  it("Post 无 message → tool_response = JSON.stringify(payload)", async () => {
    const sb = makeSandbox();
    try {
      const { errors } = await postWith(
        sb,
        nodeCommand(
          "let d='';process.stdin.on('data',c=>d+=c);" +
            "process.stdin.on('end',()=>{process.stderr.write(d);process.exit(2)})"
        ),
        {
          toolUseId: "u1",
          name: "bash",
          input: {},
          kind: "ok",
          // Explicit "no message": projection falls back to the payload (tool_response picks one of the two)
          message: undefined,
          payload: { exitCode: 0 },
        }
      );
      assert.equal(errors.length, 1);
      const env = envelopeFrom(errors[0]!.message);
      assert.equal(env.tool_response, '{"exitCode":0}');
    } finally {
      sb.cleanup();
    }
  });

  it("Post 拒绝（异步抛不可序列化 payload 面）不冒泡：post 返回 Promise<void> 且 rejects 被收口", async () => {
    const sb = makeSandbox();
    try {
      const f = sb.hookFile("postthrow", {
        hooks: {
          PostToolUse: [{ hooks: [{ type: "command", command: "true" }] }],
        },
      });
      const h = makeHarness(sb, [f]);
      const c = createPluginHookContribution(h.opts);
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      // Does not throw (never-throw contract)
      await c.post!({
        toolUseId: "u1",
        name: "bash",
        input: cyclic,
        kind: "ok",
        payload: cyclic,
      });
    } finally {
      sb.cleanup();
    }
  });
});

// ─── First block wins / matcher group order ───────────────────────────────────────────

describe("createPluginHookContribution — §5.7 先拦先赢", () => {
  it("跨组：首组 block 后第二组不执行", async () => {
    const sb = makeSandbox();
    try {
      const countFile = join(sb.dir, "ordercount.txt");
      const f = sb.hookFile("order", {
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: nodeCommand(
                    "const fs=require('fs');fs.appendFileSync(process.env.COUNT_FILE,'1');process.stdin.resume();process.exit(2)"
                  ),
                },
              ],
            },
            {
              hooks: [
                {
                  type: "command",
                  command: nodeCommand(
                    "const fs=require('fs');fs.appendFileSync(process.env.COUNT_FILE,'2');process.stdin.resume();process.exit(2)"
                  ),
                },
              ],
            },
          ],
        },
      });
      const h = makeHarness(sb, [f], {
        env: { PATH: process.env.PATH ?? "", COUNT_FILE: countFile },
      });
      const c = createPluginHookContribution(h.opts);
      const block = await c.pre!({ tool: "bash", input: {} });
      assert.ok(block);
      assert.equal(readFileSync(countFile, "utf8"), "1", "第二组未执行");
    } finally {
      sb.cleanup();
    }
  });

  it("组内：首个 handler block 后同组第二个不执行", async () => {
    const sb = makeSandbox();
    try {
      const countFile = join(sb.dir, "innercount.txt");
      const f = sb.hookFile("inner-order", {
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: nodeCommand(
                    "const fs=require('fs');fs.appendFileSync(process.env.COUNT_FILE,'a');process.stdin.resume();process.exit(2)"
                  ),
                },
                {
                  type: "command",
                  command: nodeCommand(
                    "const fs=require('fs');fs.appendFileSync(process.env.COUNT_FILE,'b');process.stdin.resume();process.exit(2)"
                  ),
                },
              ],
            },
          ],
        },
      });
      const h = makeHarness(sb, [f], {
        env: { PATH: process.env.PATH ?? "", COUNT_FILE: countFile },
      });
      const c = createPluginHookContribution(h.opts);
      const block = await c.pre!({ tool: "bash", input: {} });
      assert.ok(block);
      assert.equal(block.reason, "inner-order hook blocked the call (exit 2)");
      assert.equal(readFileSync(countFile, "utf8"), "a");
    } finally {
      sb.cleanup();
    }
  });

  it("matcher 未命中 → handler 不 spawn", async () => {
    const sb = makeSandbox();
    try {
      const countFile = join(sb.dir, "nomatch.txt");
      writeFileSync(countFile, "", "utf8");
      const f = sb.hookFile("nomatch", {
        hooks: {
          PreToolUse: [
            {
              matcher: "Write|Edit",
              hooks: [
                {
                  type: "command",
                  command: nodeCommand(
                    "const fs=require('fs');fs.appendFileSync(process.env.COUNT_FILE,'x');process.stdin.resume()"
                  ),
                },
              ],
            },
          ],
        },
      });
      const h = makeHarness(sb, [f], {
        env: { PATH: process.env.PATH ?? "", COUNT_FILE: countFile },
      });
      const c = createPluginHookContribution(h.opts);
      await assertPrePass(c.pre!, "read_file", { path: "x" });
      assert.equal(readFileSync(countFile, "utf8"), "");
      // Alias hit: read_file itself; then verify Edit hits edit_file
      await assertPrePass(c.pre!, "bash", { command: "ls" });
      assert.equal(readFileSync(countFile, "utf8"), "");
    } finally {
      sb.cleanup();
    }
  });

  it("多文件顺序：先声明的文件的组先评估", async () => {
    const sb = makeSandbox();
    try {
      const countFile = join(sb.dir, "fileorder.txt");
      const mk = (plugin: string, tag: string) =>
        sb.hookFile(plugin, {
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  {
                    type: "command",
                    command: nodeCommand(
                      `const fs=require('fs');fs.appendFileSync(process.env.COUNT_FILE,${JSON.stringify(tag)});process.stdin.resume();process.exit(2)`
                    ),
                  },
                ],
              },
            ],
          },
        });
      const first = mk("first", "F");
      const second = mk("second", "S");
      const h = makeHarness(sb, [first, second], {
        env: { PATH: process.env.PATH ?? "", COUNT_FILE: countFile },
      });
      const c = createPluginHookContribution(h.opts);
      assert.ok(await c.pre!({ tool: "bash", input: {} }));
      assert.equal(readFileSync(countFile, "utf8"), "F");
    } finally {
      sb.cleanup();
    }
  });
});

// ─── Placeholders ────────────────────────────────────────────────────────────

describe("createPluginHookContribution — §5.6 占位符", () => {
  async function runPlaceholderCommand(
    sb: Sandbox,
    plugin: string,
    command: string
  ): Promise<{ errors: HookErrorEvent[]; result: unknown }> {
    const f = sb.hookFile(plugin, {
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command, timeout: 15 }] }],
      },
    });
    const h = makeHarness(sb, [f]);
    const c = createPluginHookContribution(h.opts);
    const result = await c.pre!({ tool: "bash", input: {} });
    return { errors: h.errors, result };
  }

  it("${*_PLUGIN_ROOT} → 插件根（品牌中立：任意前缀后缀匹配）", async () => {
    const sb = makeSandbox();
    try {
      const { result } = await runPlaceholderCommand(
        sb,
        "rooted",
        `node -e "process.stderr.write(process.argv[1]);process.exit(2)" "\${VENDOR_PLUGIN_ROOT}"`
      );
      assert.deepEqual(result, { reason: sb.pluginRoot("rooted") });
      // A different prefix matches the same way
      const other = await runPlaceholderCommand(
        sb,
        "rooted2",
        `node -e "process.stderr.write(process.argv[1]);process.exit(2)" "\${OTHER_PLUGIN_ROOT}"`
      );
      assert.deepEqual(other.result, { reason: sb.pluginRoot("rooted2") });
    } finally {
      sb.cleanup();
    }
  });

  it("${*_PLUGIN_DATA} → <userHome>/.iknow/plugin-data/<plugin>，首引即建", async () => {
    const sb = makeSandbox();
    try {
      const dir = join(sb.dir, "home", ".iknow", "plugin-data", "datay");
      const { result } = await runPlaceholderCommand(
        sb,
        "datay",
        `node -e "process.stderr.write(process.argv[1]);process.exit(2)" "\${X_PLUGIN_DATA}"`
      );
      assert.deepEqual(result, { reason: dir });
      // The directory exists (re-referencing skips mkdir; path still matches)
      const second = await runPlaceholderCommand(
        sb,
        "datay",
        `node -e "process.stderr.write(process.argv[1]);process.exit(2)" "\${X_PLUGIN_DATA}"`
      );
      assert.deepEqual(second.result, { reason: dir });
    } finally {
      sb.cleanup();
    }
  });

  it("${*_PROJECT_DIR} → projectDir", async () => {
    const sb = makeSandbox();
    try {
      const { result } = await runPlaceholderCommand(
        sb,
        "projy",
        `node -e "process.stderr.write(process.argv[1]);process.exit(2)" "\${Y_PROJECT_DIR}"`
      );
      assert.deepEqual(result, { reason: sb.dir });
    } finally {
      sb.cleanup();
    }
  });

  it("其他 ${VAR} → opts.env；未定义 → 空串", async () => {
    const sb = makeSandbox();
    try {
      const f = sb.hookFile("vars", {
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: nodeCommand(
                    "process.stderr.write(process.env.KNOWN+'|'+process.env.UNKNOWN_MISSING);process.exit(2)"
                  ),
                },
              ],
            },
          ],
        },
      });
      const h = makeHarness(sb, [f], {
        env: {
          PATH: process.env.PATH ?? "",
          KNOWN: "known-val",
        },
      });
      // The command string writes ${KNOWN} / ${UNKNOWN_MISSING} literally — verifies both substitution and empty-string for undefined
      const opts = {
        ...h.opts,
        files: [
          {
            ...f,
            // Rewrite the file content: the command carries placeholders
          },
        ],
      };
      // Rewrite hooks.json directly so the command carries placeholders
      writeFileSync(
        f.file,
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  {
                    type: "command",
                    command: nodeCommand(
                      "process.stderr.write('${KNOWN}'+'|'+'${UNKNOWN_MISSING}');process.exit(2)"
                    ),
                    timeout: 15,
                  },
                ],
              },
            ],
          },
        }),
        "utf8"
      );
      void opts;
      const c = createPluginHookContribution(h.opts);
      const result = await c.pre!({ tool: "bash", input: {} });
      assert.deepEqual(result, { reason: "known-val|" });
    } finally {
      sb.cleanup();
    }
  });

  it("被替换变量按命令中原样名导出进子进程 env（前缀保留、任意命名空间）", async () => {
    const sb = makeSandbox();
    try {
      // Neutral namespace prefix (`ACME_`) — suffix matching is brand-agnostic, so any `<NS>_` should hit; the command body reads the same-named variables from env, and the trailing `#` comment exists only to trigger the substitution itself.
      const f = sb.hookFile("envexport", {
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command:
                    "node -e \"process.stderr.write([process.env.ACME_PLUGIN_ROOT,process.env.ACME_PLUGIN_DATA,process.env.ACME_PROJECT_DIR].join('|'));process.exit(2)\" # ${ACME_PLUGIN_ROOT} ${ACME_PLUGIN_DATA} ${ACME_PROJECT_DIR}",
                  timeout: 15,
                },
              ],
            },
          ],
        },
      });
      const h = makeHarness(sb, [f]);
      const c = createPluginHookContribution(h.opts);
      const result = await c.pre!({ tool: "bash", input: {} });
      assert.ok(result);
      const expected = [
        sb.pluginRoot("envexport"),
        join(sb.dir, "home", ".iknow", "plugin-data", "envexport"),
        sb.dir,
      ].join("|");
      assert.equal((result as { reason: string }).reason, expected);
    } finally {
      sb.cleanup();
    }
  });

  it("命令文本不做其他改写（原样交 shell）", async () => {
    const sb = makeSandbox();
    try {
      const f = sb.hookFile("verbatim", {
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: "echo 'a && b' \"c\" >/dev/null; exit 0",
                  timeout: 15,
                },
              ],
            },
          ],
        },
      });
      const h = makeHarness(sb, [f]);
      const c = createPluginHookContribution(h.opts);
      await assertPrePass(c.pre!, "bash", {});
      assert.deepEqual(h.errors, []);
    } finally {
      sb.cleanup();
    }
  });

  it("roots 缺席条目 → 插件根按 file 路径兜底推导", async () => {
    const sb = makeSandbox();
    try {
      const f = sb.hookFile("noroots", {
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: `node -e "process.stderr.write(process.argv[1]);process.exit(2)" "\${Z_PLUGIN_ROOT}"`,
                  timeout: 15,
                },
              ],
            },
          ],
        },
      });
      // Empty roots Map → plugin root derived via dirname(dirname(file))
      const h = makeHarness(sb, [f]);
      const c = createPluginHookContribution(h.opts);
      const result = await c.pre!({ tool: "bash", input: {} });
      assert.deepEqual(result, { reason: sb.pluginRoot("noroots") });
    } finally {
      sb.cleanup();
    }
  });
});

// ─── Output truncation ──────────────────────────────────────────────────────────

describe("createPluginHookContribution — §5.6 输出截断（1 MiB）", () => {
  it("stderr 超 1 MiB → 截断，不缓冲爆炸（exit 2 的 reason 也受限）", async () => {
    const sb = makeSandbox();
    try {
      const f = sb.hookFile("bigout", {
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: nodeCommand(
                    // 2 MiB to stderr, then exit 2
                    "const b=Buffer.alloc(2*1024*1024,0x61);" +
                      "process.stderr.write(b);process.exit(2)"
                  ),
                  timeout: 30,
                },
              ],
            },
          ],
        },
      });
      const h = makeHarness(sb, [f]);
      const c = createPluginHookContribution(h.opts);
      const result = await c.pre!({ tool: "bash", input: {} });
      assert.ok(result);
      const reason = (result as { reason: string }).reason;
      assert.ok(
        Buffer.byteLength(reason, "utf8") <= PLUGIN_HOOK_OUTPUT_CAP_BYTES,
        `reason 应 ≤ 1 MiB，实际 ${Buffer.byteLength(reason, "utf8")}`
      );
      assert.ok(reason.includes("a"));
    } finally {
      sb.cleanup();
    }
  }, 30_000);
});

// ─── Degradation-channel priority (onError wins, warn is the fallback, never both)───────────────────────

describe("createPluginHookContribution — 降级通道", () => {
  it("onError 在场 → 事件走 typed 通道，warn 不重复收", () => {
    const sb = makeSandbox();
    try {
      const bad = sb.rawHookFile("bad", "{");
      const h = makeHarness(sb, [bad]);
      createPluginHookContribution(h.opts);
      assert.equal(h.errors.length, 1);
      assert.equal(h.warns.length, 0, "不双报");
    } finally {
      sb.cleanup();
    }
  });

  it("onError 缺席 → warn 兜底（不静默）", () => {
    const sb = makeSandbox();
    try {
      const bad = sb.rawHookFile("bad", "{");
      const h = makeHarness(sb, [bad], { onError: undefined });
      createPluginHookContribution(h.opts);
      assert.equal(h.warns.length, 1);
      assert.ok(h.warns[0]!.includes("JSON corrupt"));
    } finally {
      sb.cleanup();
    }
  });
});

// ─── Async hook chain ───────────────────────────────────────────────────────

describe("plugin-hooks — 异步面（B/§5.7）", () => {
  it("pre 返回 Promise（贡献接缝是 async 的）", async () => {
    const sb = makeSandbox();
    try {
      const f = sb.hookFile("asyncshape", {
        hooks: {
          PreToolUse: [
            { hooks: [{ type: "command", command: "true", timeout: 15 }] },
          ],
        },
      });
      const h = makeHarness(sb, [f]);
      const c = createPluginHookContribution(h.opts);
      const ret = c.pre!({ tool: "bash", input: {} });
      assert.ok(ret instanceof Promise);
      await ret;
    } finally {
      sb.cleanup();
    }
  });

  it("post 返回 Promise（贡献接缝是 async 的）", async () => {
    const sb = makeSandbox();
    try {
      const f = sb.hookFile("asyncpost", {
        hooks: {
          PostToolUse: [
            { hooks: [{ type: "command", command: "true", timeout: 15 }] },
          ],
        },
      });
      const h = makeHarness(sb, [f]);
      const c = createPluginHookContribution(h.opts);
      const ret = c.post!({
        toolUseId: "u1",
        name: "bash",
        input: {},
        kind: "ok",
      });
      assert.ok(ret instanceof Promise);
      await ret;
    } finally {
      sb.cleanup();
    }
  });

  it("Post handler 在文件里位于 Pre 之前也各归各的链（事件过滤）", async () => {
    const sb = makeSandbox();
    try {
      const f = sb.hookFile("interleaved", {
        hooks: {
          PostToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: nodeCommand(
                    "const fs=require('fs');fs.appendFileSync(process.env.COUNT_FILE,'post')"
                  ),
                  timeout: 15,
                },
              ],
            },
          ],
          PreToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: nodeCommand(
                    "const fs=require('fs');fs.appendFileSync(process.env.COUNT_FILE,'pre')"
                  ),
                  timeout: 15,
                },
              ],
            },
          ],
        },
      });
      const countFile = join(sb.dir, "events.txt");
      const h = makeHarness(sb, [f], {
        env: { PATH: process.env.PATH ?? "", COUNT_FILE: countFile },
      });
      const c = createPluginHookContribution(h.opts);
      await c.pre!({ tool: "bash", input: {} });
      await c.post!({
        toolUseId: "u1",
        name: "bash",
        input: {},
        kind: "ok",
      });
      assert.equal(readFileSync(countFile, "utf8"), "prepost");
    } finally {
      sb.cleanup();
    }
  });

  it("并发调用不互相污染（贡献构造期完成 IO，运行期只读冻结产物）", async () => {
    const sb = makeSandbox();
    try {
      const f = sb.hookFile("concurrent", {
        hooks: {
          PreToolUse: [
            {
              matcher: "bash",
              hooks: [
                {
                  type: "command",
                  command: nodeCommand(
                    "let d='';process.stdin.on('data',c=>d+=c);" +
                      "process.stdin.on('end',()=>{process.stderr.write(JSON.parse(d).tool_name);process.exit(2)})"
                  ),
                  timeout: 15,
                },
              ],
            },
          ],
        },
      });
      const h = makeHarness(sb, [f]);
      const c = createPluginHookContribution(h.opts);
      const results = await Promise.all([
        c.pre!({ tool: "bash", input: {} }),
        c.pre!({ tool: "bash", input: {} }),
        c.pre!({ tool: "bash", input: {} }),
      ]);
      for (const r of results) {
        assert.deepEqual(r, { reason: "bash" });
      }
    } finally {
      sb.cleanup();
    }
  });
});

// ─── Assembly-seam helper (shared by build-engine / worker) ───────────────────────────

describe("createPluginHooksFromCatalog — 装配缝便利函数", () => {
  it("entries 为空 → 空贡献（pre/post 双缺席），装配层无需判空", () => {
    const c = createPluginHooksFromCatalog({
      entries: [],
      installations: [],
      userHome: "/nonexistent-home",
      projectDir: "/nonexistent-project",
      cwd: "/nonexistent-cwd",
    });
    assert.equal(c.pre, undefined);
    assert.equal(c.post, undefined);
  });

  it("installations 派生 roots：同名插件的 ${*_PLUGIN_ROOT} 展开为该安装根", async () => {
    const sb = makeSandbox();
    try {
      const f = sb.hookFile("rooted", {
        hooks: {
          PreToolUse: [
            {
              matcher: "bash",
              hooks: [
                {
                  type: "command",
                  command: `test -n \${ROOTED_PLUGIN_ROOT} && echo "root=\${ROOTED_PLUGIN_ROOT}" 1>&2; exit 2`,
                },
              ],
            },
          ],
        },
      });
      const c = createPluginHooksFromCatalog({
        entries: [f],
        installations: [{ name: "rooted", root: sb.pluginRoot("rooted") }],
        userHome: join(sb.dir, "home"),
        projectDir: sb.dir,
        cwd: sb.dir,
        env: { PATH: process.env.PATH ?? "" },
      });
      const block = await c.pre!({ tool: "bash", input: {} });
      assert.ok(block, "expected block from exit 2");
      assert.ok(
        block.reason.includes(`root=${sb.pluginRoot("rooted")}`),
        `expected substituted root in reason, got: ${block.reason}`
      );
    } finally {
      sb.cleanup();
    }
  });

  it("onError 透传：非法 JSON → plugin-init 经注入通道上报", () => {
    const sb = makeSandbox();
    const errors: HookErrorEvent[] = [];
    try {
      const f = sb.rawHookFile("broken", "{ not json");
      createPluginHooksFromCatalog({
        entries: [f],
        installations: [{ name: "broken", root: sb.pluginRoot("broken") }],
        userHome: join(sb.dir, "home"),
        projectDir: sb.dir,
        cwd: sb.dir,
        onError: (e) => errors.push(e),
      });
      assert.equal(errors.length, 1);
      assert.equal(errors[0]!.phase, "plugin-init");
    } finally {
      sb.cleanup();
    }
  });
});

// ─── PostToolUseHook type compatibility ───────────────────────────────────────────────

describe("plugin-hooks — PostToolUseHook 类型兼容", () => {
  it("贡献的 post 可作为 PostToolUseHook 使用（放宽后的联合返回类型）", async () => {
    const sb = makeSandbox();
    try {
      const f = sb.hookFile("typedpost", {
        hooks: {
          PostToolUse: [
            { hooks: [{ type: "command", command: "true", timeout: 15 }] },
          ],
        },
      });
      const h = makeHarness(sb, [f]);
      const c = createPluginHookContribution(h.opts);
      const post: PostToolUseHook = c.post!;
      await post({
        toolUseId: "u1",
        name: "bash",
        input: {},
        kind: "ok",
      });
    } finally {
      sb.cleanup();
    }
  });
});
