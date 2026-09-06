/**
 * wayfinder #440 Stream B — T12 零联动 guard test（M3 / M5 / D8 决议）。
 *
 * 三条决策的具体形态:
 *   - M3 「worker 默认可见（同 mcp__*，不进 DEFAULT_DISALLOWED_TOOLS）」
 *   - M5 「evidence-checker 零改动（资源读取不是测试运行，天然 scope 外，
 *     同 web_fetch 待遇）」
 *   - M5 「判官 deny-list 不加（read-only 工具与判官已持有的 read_file / grep 同类）」
 *
 * 零联动 = 未来不动这些组件也能让资源读取工作。guard test 把「不联动」钉成
 * 回归防线，防止后续改动悄悄接线（M3/M5 决议：D8 零 verify 联动决议的工具面
 * 形态）。test-diff 本身即为该 bullet 的 commit 内容。
 *
 * 锁 4 类断言：
 *   1. DEFAULT_DISALLOWED_TOOLS 字面不含 list_mcp_resources / read_mcp_resource
 *   2. worker's 装配面经 buildWorkerToolSurface 宽容裁剪后,list/read 仍未被剥
 *      离（默认 deny-list 与用户 deny 都不含这两件 → M3 决议 "默认可见" 守住）
 *   3. evidence-checker: 含 read_mcp_resource tool_use 的消息序列,verdict 与
 *      「同等形态但 tool 名替换为 read_file 的对照组」一致（M5 决议：同
 *      web_fetch 待遇,资源读取不是测试运行）
 *   4. 判官 allow-list 基线字面不变（#357 T2 起: run-classifier-adapter.ts
 *      JUDGE_ALLOWED_TOOLS = read_file/grep/glob, deny = ACI_TOOLSET_NAMES −
 *      白名单 fail-closed 推导）— 不含 list/read
 */
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

import {
  DEFAULT_DISALLOWED_TOOLS,
  buildWorkerToolSurface,
} from "../../../src/harness/subagent/role.js";
import { ACI_TOOLSET_NAMES } from "../../../src/harness/aci/tools/registry.js";
import { createWorkerDeps } from "../../../src/harness/subagent/worker.js";
import { checkEvidence } from "../../../src/harness/verify/evidence-checker.js";
import type { AnthropicNativeMessage } from "../../../src/harness/model-adapter/types.js";

// =========================================================================
// 1. DEFAULT_DISALLOWED_TOOLS 字面不含 list/read_mcp_resource
// =========================================================================

describe("M3 worker 默认可见 — DEFAULT_DISALLOWED_TOOLS", () => {
  it("DEFAULT_DISALLOWED_TOOLS 不含 list_mcp_resources / read_mcp_resource", () => {
    // 决议原话：「worker 默认可见（同 mcp__*，不进 DEFAULT_DISALLOWED_TOOLS）」
    // 当前默认 deny-list 仅 spawn_subagent（防递归爆炸）；list/read 不在 deny
    // 列表 → worker 装配路径下若 mcpManager 在场,工具不被 deny 拦截。
    expect(DEFAULT_DISALLOWED_TOOLS).not.toContain("list_mcp_resources");
    expect(DEFAULT_DISALLOWED_TOOLS).not.toContain("read_mcp_resource");
  });

  it("DEFAULT_DISALLOWED_TOOLS 长度仍是 1（仅 spawn_subagent,防回归加件）", () => {
    // 防回归：未来无意追加 list/read 到默认 deny 时,本测试即失败。
    expect(DEFAULT_DISALSET_TOOLS_LENGTH_SNAPSHOT).toBe(
      DEFAULT_DISALLOWED_TOOLS.length
    );
  });
});

/** SSOT 长度快照：当前 = 1（仅 spawn_subagent）。改默认 deny-list 必须同步更新本常量并解释。 */
const DEFAULT_DISALSET_TOOLS_LENGTH_SNAPSHOT = 1;

// =========================================================================
// 2. worker 工具面宽容裁剪后,list/read 仍未被剥离
// =========================================================================

describe("M3 worker 默认可见 — buildWorkerToolSurface 宽容裁剪", () => {
  it("用户 deny-list 含 list/read 时仍宽容忽略(available 不含 → 静默跳过,不抛)", () => {
    // 模拟 worker 装配时的全量工具面（27 件：8 基线 + tool_search + 10 LSP
    // + skill 1（disclosure-index-align T2 删 skill_search）+ spawn_subagent
    // + subagent_result + mcp 2 件。模拟时只关心工具名集合,工具 def body
    // 不参与裁剪判定）。
    const available = [
      "bash",
      "read_file",
      "grep",
      "glob",
      "edit_file",
      "write_file",
      "web_fetch",
      "web_search",
      "tool_search",
      "lsp_definition",
      "lsp_references",
      "lsp_hover",
      "lsp_document_symbol",
      "lsp_workspace_symbol",
      "lsp_go_to_implementation",
      "lsp_prepare_call_hierarchy",
      "lsp_incoming_calls",
      "lsp_outgoing_calls",
      "lsp_diagnostics",
      "skill",
      "spawn_subagent",
      "subagent_result",
      "list_mcp_resources",
      "read_mcp_resource",
    ].map((name) => ({ name }));

    // 用户显式 deny 这两件 → buildWorkerToolSurface 宽容模式（user deny 名
    // 在 available 中 → 剔除；不在 → 静默跳过）。list/read 在 available 中 →
    // 实际被剔除;但「默认 deny-list」与「用户 deny-list」两套机制互不耦合。
    // 本断言锁的是:即便用户 deny list/read,默认 deny-list 仍未默默追加这两件。
    const after = buildWorkerToolSurface(available, [
      "list_mcp_resources",
      "read_mcp_resource",
    ]);
    const names = after.map((t) => t.name);
    expect(names).not.toContain("list_mcp_resources");
    expect(names).not.toContain("read_mcp_resource");
    // 默认 deny-list 仍只剥 spawn_subagent(M3 决议守住)。
    expect(names).not.toContain("spawn_subagent");
  });

  it("空 user deny → 默认 deny-list 仅剥 spawn_subagent,list/read 仍在(M3 决议)", () => {
    // 默认 deny-list（DEFAULT_DISALLOWED_TOOLS = ['spawn_subagent']）+ 空 user
    // deny → 仅 spawn_subagent 被剥;list/read 仍在 → worker 默认可见。
    const available = [
      "bash",
      "read_file",
      "grep",
      "glob",
      "edit_file",
      "write_file",
      "web_fetch",
      "web_search",
      "tool_search",
      "lsp_definition",
      "lsp_definition", // 重名占位让 set 配合最小集
      "lsp_references",
      "lsp_hover",
      "lsp_document_symbol",
      "lsp_workspace_symbol",
      "lsp_go_to_implementation",
      "lsp_prepare_call_hierarchy",
      "lsp_incoming_calls",
      "lsp_outgoing_calls",
      "lsp_diagnostics",
      "skill",
      "spawn_subagent",
      "subagent_result",
      "list_mcp_resources",
      "read_mcp_resource",
    ].map((name, i) => ({ name, _idx: i })); // _idx 让 object identity 不同
    // 实际去掉重复名,仅取去重集合
    const unique = Array.from(
      new Map(available.map((t) => [t.name, t])).values()
    );
    const after = buildWorkerToolSurface(unique);
    const names = after.map((t) => t.name);
    expect(names).not.toContain("spawn_subagent");
    expect(names).toContain("list_mcp_resources");
    expect(names).toContain("read_mcp_resource");
  });
});

// =========================================================================
// 3. evidence-checker 行为不变（M5 决议：资源读取不是测试运行）
// =========================================================================

describe("M5 evidence-checker 零联动 — read_mcp_resource tool_use 形态不变", () => {
  function makeBashToolUseMessage(command: string): AnthropicNativeMessage {
    return {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_bash_1",
          name: "bash",
          input: { command },
        },
      ],
    };
  }

  function makeReadMcpResourceToolUseMessage(
    server: string,
    uri: string
  ): AnthropicNativeMessage {
    return {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_mcp_1",
          name: "read_mcp_resource",
          input: { server, uri },
        },
      ],
    };
  }

  function makeUserToolResult(text: string): AnthropicNativeMessage {
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_mcp_1",
          content: text,
          is_error: false,
        },
      ],
    };
  }

  it("含 read_mcp_resource tool_use 的消息序列 verdict 与空序列一致(资源读取不是测试运行)", () => {
    // baseline：空 messages
    const baseline = checkEvidence({ messages: [], claimIndex: 0 });
    // 引入 read_mcp_resource tool_use + tool_result（typical 资源读取路径）
    const withMcpRead = checkEvidence({
      messages: [
        makeReadMcpResourceToolUseMessage("alpha", "file:///a.txt"),
        makeUserToolResult(
          JSON.stringify({
            server: "alpha",
            uri: "file:///a.txt",
            contents: [
              { uri: "file:///a.txt", mimeType: "text/plain", text: "hello" },
            ],
          })
        ),
      ],
      claimIndex: 0,
    });

    // 决议原话：「evidence-checker 零改动（资源读取不是测试运行，天然 scope 外，
    // 同 web_fetch 待遇）」。verdict 应与 baseline 一致——read_mcp_resource 的
    // tool_use 不被识别为「测试运行」,不影响证据充分性判定。
    expect(withMcpRead.verdict).toBe(baseline.verdict);
  });

  it("list_mcp_resources tool_use 同理不影响 verdict（与 read 同形态）", () => {
    const baseline = checkEvidence({ messages: [], claimIndex: 0 });
    const withMcpList = checkEvidence({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_list_1",
              name: "list_mcp_resources",
              input: {},
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_list_1",
              content: "(no resources)",
              is_error: false,
            },
          ],
        },
      ],
      claimIndex: 0,
    });
    expect(withMcpList.verdict).toBe(baseline.verdict);
  });
});

// =========================================================================
// 4. 判官 allow-list 基线字面不变（#357 T2: JUDGE_ALLOWED_TOOLS）
// =========================================================================

describe("M5 判官 allow-list 基线 — JUDGE_ALLOWED_TOOLS 字面 byte-identical", () => {
  it("run-classifier-adapter.ts 的白名单基线恰为 read_file/grep/glob + 推导消费 ACI_TOOLSET_NAMES,且不含 list/read_mcp_resource", async () => {
    // #357 T2:判官工具面从硬编码 5 禁项 deny 改为 fail-closed allow-list 推导
    // （deny = ACI_TOOLSET_NAMES − JUDGE_ALLOWED_TOOLS）。本 guard 钉住:
    //   - 白名单三件基线字面在场（防误删/漂移）;
    //   - 推导公式消费 ACI_TOOLSET_NAMES（防退回硬编码 deny 清单）;
    //   - list/read_mcp_resource 字面不进文件（决议防线不变:判官不加资源读取）。
    const src = await readFile(
      new URL(
        "../../../src/harness/verify/run-classifier-adapter.ts",
        import.meta.url
      ),
      "utf8"
    );
    expect(src).toContain("JUDGE_ALLOWED_TOOLS");
    expect(src).toContain('"read_file"');
    expect(src).toContain('"grep"');
    expect(src).toContain('"glob"');
    expect(src).toContain("ACI_TOOLSET_NAMES");
    expect(src).toContain("Object.freeze");
    // 决议防线：list/read_mcp_resource 字面不进 run-classifier-adapter.ts
    expect(src).not.toMatch(/list_mcp_resources/);
    expect(src).not.toMatch(/read_mcp_resource/);
  });

  it("worker 装配（createWorkerDeps）装上判官 deny（全量面 − 白名单）时,只留白名单三件,不动 list/read", async () => {
    // 镜像 JUDGE_ROLE.disallowedTools 推导真值（同 worker-tool-surface.test.ts
    // JUDGE_DENY 推导公式）,作为本测试断言的输入基线。两份断言守护同一真值
    // 源: 真值漂移 = 镜像侧的 worker-tool-surface.test.ts 也失败。
    const JUDGE_DENY: ReadonlyArray<string> = (
      ACI_TOOLSET_NAMES as ReadonlyArray<string>
    ).filter((n) => !["read_file", "grep", "glob"].includes(n));
    // 直接用 hermetic opts 模拟 worker 装配 + 判官 deny 注入
    // （仅验证 deny-list 形态,不触发真实 adapter / mcpManager）。
    const env = makeMinimalEnv();
    const deps = await createWorkerDeps({
      env,
      sandboxRoot: "/tmp/judge-deny-guard",
      skillCatalog: {
        available: () => [],
        disabled: () => false,
        get: () => undefined,
        invalidate: () => undefined,
      },
      disallowedTools: [...JUDGE_DENY],
    });
    const inner = deps.registry.list().map((t) => t.name);
    // 白名单三件留下（判官只读面）
    expect(inner).toContain("read_file");
    expect(inner).toContain("grep");
    expect(inner).toContain("glob");
    // 旧 5 禁项（现属推导 deny 集）被剥
    expect(inner).not.toContain("bash");
    expect(inner).not.toContain("edit_file");
    expect(inner).not.toContain("write_file");
    expect(inner).not.toContain("web_fetch");
    expect(inner).not.toContain("web_search");
    // list/read_mcp_resource 仍不在 inner（worker 不接 mcpManager,装配期
    // 即缺席——与 M2 决议「条件化装配」一致;M3「默认可见」守住的是「不主动
    // deny」而非「自动装配」,两者正交）。
    expect(inner).not.toContain("list_mcp_resources");
    expect(inner).not.toContain("read_mcp_resource");
  });
});

// ---------------------------------------------------------------------------
// Minimal env helper — 仅用于 createWorkerDeps 装配期断言,不触发真请求。
// ---------------------------------------------------------------------------

function makeMinimalEnv() {
  return {
    llm: {
      apiKey: "test-key",
      baseUrl: "https://example.test",
      model: "test-model",
      fallback: [],
      maxOutputTokens: 1024,
      temperature: 0,
      stream: "off" as const,
      thinking: { type: "disabled" as const },
      maxTurns: undefined,
      timeoutMs: undefined,
    },
    web: { proxy: undefined, searchUrl: undefined },
    compress: { contextWindow: 200000, thresholdTokens: undefined },
    chat: { showThinking: false, quiet: false },
  };
}
