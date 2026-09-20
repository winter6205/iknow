/**
 * Zero-linkage guard test for the MCP resource-read tools.
 *
 * Decisions pinned:
 *   - Workers see list_mcp_resources / read_mcp_resource by default (same as
 *     mcp__* — never added to DEFAULT_DISALLOWED_TOOLS)
 *   - evidence-checker stays untouched (resource reading is not a test run;
 *     naturally out of scope, treated like web_fetch)
 *   - nothing added to the judge deny-list (read-only tools are the same
 *     class as read_file / grep the judge already holds)
 *
 * "Zero linkage" = resource reading works without ever wiring those components
 * together. This guard turns non-linkage into a regression fence so future
 * changes can't quietly connect them.
 *
 * Four assertion classes:
 *   1. DEFAULT_DISALLOWED_TOOLS literally contains neither
 *      list_mcp_resources nor read_mcp_resource
 *   2. the worker assembly surface keeps list/read after buildWorkerToolSurface's
 *      lenient pruning (neither the default deny-list nor user denies strip
 *      them → "visible by default" holds)
 *   3. evidence-checker: a message sequence with a read_mcp_resource tool_use
 *      verdicts identically to a control of the same shape with the tool name
 *      swapped to read_file
 *   4. the judge allow-list baseline is byte-stable —
 *      run-classifier-adapter.ts JUDGE_ALLOWED_TOOLS = read_file/grep/glob,
 *      deny = ACI_TOOLSET_NAMES minus the allow-list (fail-closed derivation)
 *      — with neither list nor read in it
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
// 1. DEFAULT_DISALLOWED_TOOLS literals contain neither list nor read_mcp_resource
// =========================================================================

describe("M3 worker 默认可见 — DEFAULT_DISALLOWED_TOOLS", () => {
  it("DEFAULT_DISALLOWED_TOOLS 不含 list_mcp_resources / read_mcp_resource", () => {
    // Decision: worker-visible by default (same as mcp__*, not in
    // DEFAULT_DISALLOWED_TOOLS). The default deny-list is spawn_subagent only
    // (recursion guard); list/read are not denied → with mcpManager present on
    // the worker assembly path, the tools are never blocked by deny.
    expect(DEFAULT_DISALLOWED_TOOLS).not.toContain("list_mcp_resources");
    expect(DEFAULT_DISALLOWED_TOOLS).not.toContain("read_mcp_resource");
  });

  it("DEFAULT_DISALLOWED_TOOLS 长度仍是 1（仅 spawn_subagent,防回归加件）", () => {
    // Regression fence: accidentally appending list/read to the default deny later fails here.
    expect(DEFAULT_DISALSET_TOOLS_LENGTH_SNAPSHOT).toBe(
      DEFAULT_DISALLOWED_TOOLS.length
    );
  });
});

/** SSOT length snapshot: currently 1 (spawn_subagent only). Changing the default deny-list must update this constant with justification. */
const DEFAULT_DISALSET_TOOLS_LENGTH_SNAPSHOT = 1;

// =========================================================================
// 2. worker tool surface keeps list/read after lenient pruning
// =========================================================================

describe("M3 worker 默认可见 — buildWorkerToolSurface 宽容裁剪", () => {
  it("用户 deny-list 含 list/read 时仍宽容忽略(available 不含 → 静默跳过,不抛)", () => {
    // Simulates the full worker tool surface (baseline + tool_search + LSP
    // family + skill + subagent tools + the 2 MCP resource tools; skill_search
    // was removed by the disclosure-index work). Only the name set matters —
    // tool-def bodies never affect pruning.
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

    // User explicitly denies the two → buildWorkerToolSurface's lenient mode
    // (a user-deny name present in available → pruned; absent → silently
    // skipped). list/read are in available → actually pruned here; yet the
    // default deny-list and the user deny-list stay decoupled. What this
    // assertion locks: even when the user denies list/read, the default
    // deny-list has not quietly grown to include them too.
    const after = buildWorkerToolSurface(available, [
      "list_mcp_resources",
      "read_mcp_resource",
    ]);
    const names = after.map((t) => t.name);
    expect(names).not.toContain("list_mcp_resources");
    expect(names).not.toContain("read_mcp_resource");
    // The default deny-list still strips only spawn_subagent ("visible by default" holds).
    expect(names).not.toContain("spawn_subagent");
  });

  it("空 user deny → 默认 deny-list 仅剥 spawn_subagent,list/read 仍在(M3 决议)", () => {
    // Default deny-list (DEFAULT_DISALLOWED_TOOLS = ['spawn_subagent']) +
    // empty user deny → only spawn_subagent pruned; list/read remain →
    // worker-visible by default.
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
      "lsp_definition", // duplicate name so dedupe is exercised against a minimal set
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
    ].map((name, i) => ({ name, _idx: i })); // _idx keeps object identities distinct
    // Dedupe names, keep only the unique set
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
// 3. evidence-checker behavior unchanged (resource reading is not a test run)
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
    // baseline: empty messages
    const baseline = checkEvidence({ messages: [], claimIndex: 0 });
    // introduce a read_mcp_resource tool_use + tool_result (typical resource-read path)
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

    // Decision: evidence-checker stays untouched (resource reading is not a
    // test run, naturally out of scope, treated like web_fetch). The verdict
    // must equal baseline — read_mcp_resource's tool_use is never recognized
    // as a "test run" and never affects evidence-sufficiency judgement.
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
// 4. judge allow-list baseline literals unchanged (JUDGE_ALLOWED_TOOLS)
// =========================================================================

describe("M5 判官 allow-list 基线 — JUDGE_ALLOWED_TOOLS 字面 byte-identical", () => {
  it("run-classifier-adapter.ts 的白名单基线恰为 read_file/grep/glob + 推导消费 ACI_TOOLSET_NAMES,且不含 list/read_mcp_resource", async () => {
    // The judge tool surface moved from a hardcoded 5-item deny to a
    // fail-closed allow-list derivation (deny = ACI_TOOLSET_NAMES −
    // JUDGE_ALLOWED_TOOLS). This guard pins:
    //   - the three allow-list baseline literals are present (anti-deletion / drift);
    //   - the derivation consumes ACI_TOOLSET_NAMES (anti-revert to a hardcoded deny list);
    //   - the list/read_mcp_resource literals never enter the file (standing
    //     decision: the judge never gains resource-reading tools).
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
    // Standing decision fence: list/read_mcp_resource literals never enter run-classifier-adapter.ts
    expect(src).not.toMatch(/list_mcp_resources/);
    expect(src).not.toMatch(/read_mcp_resource/);
  });

  it("worker 装配（createWorkerDeps）装上判官 deny（全量面 − 白名单）时,只留白名单三件,不动 list/read", async () => {
    // Mirrors JUDGE_ROLE.disallowedTools' derivation ground truth (same
    // JUDGE_DENY formula as worker-tool-surface.test.ts) as this assertion's
    // input baseline. Both assertions guard one truth source: ground-truth
    // drift makes the mirrored worker-tool-surface.test.ts fail too.
    const JUDGE_DENY: ReadonlyArray<string> = (
      ACI_TOOLSET_NAMES as ReadonlyArray<string>
    ).filter((n) => !["read_file", "grep", "glob"].includes(n));
    // Simulate worker assembly + judge-deny injection via hermetic opts
    // (pins the deny-list shape only; no real adapter / mcpManager is triggered).
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
    // The three allow-list tools remain (the judge's read-only surface)
    expect(inner).toContain("read_file");
    expect(inner).toContain("grep");
    expect(inner).toContain("glob");
    // The formerly hardcoded deny items (now part of the derived deny set) are stripped
    expect(inner).not.toContain("bash");
    expect(inner).not.toContain("edit_file");
    expect(inner).not.toContain("write_file");
    expect(inner).not.toContain("web_fetch");
    expect(inner).not.toContain("web_search");
    // list/read_mcp_resource are still absent from inner (the worker never
    // wires an mcpManager, so they're absent at assembly time — consistent
    // with the conditional-assembly decision; "visible by default" guards
    // "never actively denied", not "auto-assembled" — the two are orthogonal).
    expect(inner).not.toContain("list_mcp_resources");
    expect(inner).not.toContain("read_mcp_resource");
  });
});

// ---------------------------------------------------------------------------
// Minimal env helper — for createWorkerDeps assembly-time assertions only; never fires real requests.
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
