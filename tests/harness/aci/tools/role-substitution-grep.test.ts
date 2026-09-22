/**
 * ADR-0117 tool-role substitution refusal — ACI grep arm contract.
 *
 * Invariants certified:
 *   - A structure-shaped pattern (definition-syntax regex table) fired at
 *     the grep tool without fallback trajectory evidence is refused
 *     fail-closed, pointing ONLY to find_symbol.
 *   - ctx.messages absent → no evidence (fail-closed, skill.ts precedent).
 *   - E2 = strictly-prior tool_use of any query-side symbol tool (a
 *     same-wave sibling dispatch is current intent, not evidence);
 *     E3 = prior tool_result from a symbol-tool call carrying the LSP
 *     readable-failure sentinel (isLspFailureSentinel).
 *   - Plain content patterns and explicitly non-code scopes
 *     (path/glob restricted to docs/config extensions) never fire.
 *   - Not a hard-wall: prefix contract + no VIOLATION_PREFIXES token.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import { createGrepTool } from "../../../../src/harness/aci/tools/grep.ts";
import { toAnthropicToolResults } from "../../../../src/harness/tools/tool-result.ts";
import type { ToolExecutionResult } from "../../../../src/harness/tools/types.ts";
import { VIOLATION_PREFIXES } from "../../../../src/harness/permission/prefixes.ts";
import type { AnthropicNativeMessage } from "../../../../src/harness/model-adapter/types.ts";
import {
  ROLE_SUBSTITUTION_PREFIX,
  isStructureShapedPattern,
  isNonCodeScopedCall,
  hasFallbackTrajectoryEvidence,
} from "../../../../src/harness/aci/tools/role-substitution.ts";

const scratchPaths: string[] = [];

async function makeScratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    scratchPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

function assistantToolUse(name: string, id: string): AnthropicNativeMessage {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input: {} }],
  };
}

function userToolResult(
  toolUseId: string,
  text: string
): AnthropicNativeMessage {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: toolUseId, content: text }],
  };
}

/** LSP readable-failure sentinel shape as rendered by lsp.ts renderNoServer. */
const LSP_FAILURE_SENTINEL =
  "(no LSP server configured; supported extensions: ts, tsx)";

async function expectGrepRefusal(
  root: string,
  input: unknown,
  messages?: ReadonlyArray<AnthropicNativeMessage>
): Promise<string> {
  const tool = createGrepTool(root);
  let caught: unknown;
  try {
    await tool.handler(
      input,
      messages === undefined ? undefined : { messages }
    );
  } catch (error) {
    caught = error;
  }
  assert.ok(
    caught instanceof ToolExecutionError,
    `结构形 grep 无证据必须被拒，实际: ${String(caught)}`
  );
  return caught.message;
}

describe("ACI grep 替岗拒绝 — 结构形 pattern 需轨迹证据（ADR-0117）", () => {
  it("结构形判定表：定义语法命中，正文词不命中", () => {
    for (const pattern of [
      "function\\s+runForeground",
      "class Foo",
      "interface GrepToolDeps",
      "type QuerySpec =",
      "enum Kind",
      "struct Frame",
      "impl Handler for",
      "def process",
      "export const ROLES",
    ]) {
      assert.equal(isStructureShapedPattern(pattern), true, pattern);
    }
    for (const pattern of [
      "needle",
      "TODO: fix",
      "\\bfoo\\b",
      "the result of the classification of parts",
    ]) {
      assert.equal(isStructureShapedPattern(pattern), false, pattern);
    }
  });

  it("非代码 scope 判定表：docs/config 扩展名豁免，代码/混合扩展名不豁免", () => {
    assert.equal(isNonCodeScopedCall({ glob: "*.md" }), true);
    assert.equal(isNonCodeScopedCall({ glob: "**/*.{json,yaml}" }), true);
    assert.equal(isNonCodeScopedCall({ path: "notes.md" }), true);
    assert.equal(isNonCodeScopedCall({ glob: "*.ts" }), false);
    assert.equal(isNonCodeScopedCall({ glob: "*.{md,ts}" }), false);
    assert.equal(isNonCodeScopedCall({}), false);
  });

  it("锚定定义形：^ + 标识符 + 分隔 + 开括号/字符类 = 结构查询（真实trace tempt-1078-t01）", () => {
    // Verbatim from the real-model run that slipped past the keyword table:
    // TS methods carry modifier keywords, not function/class.
    for (const pattern of [
      String.raw`^\s*(public |private |protected |static |async )*load\s*\(`,
      String.raw`^\s*load\s*[<(]`,
      String.raw`^\s*(export\s+)?(async\s+)?function\s+load\s*\(`,
    ]) {
      assert.equal(isStructureShapedPattern(pattern), true, pattern);
    }
    // Unanchored call shapes and plain content must not fire.
    for (const pattern of [
      String.raw`\bload\s*\(`,
      String.raw`console\.log\(`,
      "TODO",
      "error:",
    ]) {
      assert.equal(isStructureShapedPattern(pattern), false, pattern);
    }
  });

  it("修饰组定义形：(async)?/(public |private )* 组 + 标识符 + 开括号 = 结构查询（真实trace grouped anchor）", () => {
    // Verbatim from real-model runs: the grouped anchor `(^|\s)` evades the
    // `^`-prefixed entry, but the modifier group is regex-source signature.
    for (const pattern of [
      String.raw`(^|\s)(async\s+)?load\s*[(=]`,
      String.raw`(public |private |protected )*handler\s*\(`,
      String.raw`\bload\s*[=:]\s*(async\s*)?(\(|function)`,
      // Same query, third shape: the modifier group is nested and the opener
      // sits inside an alternation group. A real-model run answered a
      // definition question with this and the gate called it content.
      String.raw`^\s*((public|private|protected|static|override|async)\s+)*#?load\s*(\(|=|:)`,
      String.raw`^\s*((public|private|protected|static|override|async|declare)\s+)*#?(load|loadAsync|loadAll)\s*(\(|=|:)`,
    ]) {
      assert.equal(isStructureShapedPattern(pattern), true, pattern);
    }
    // No modifier group, no anchor → content-class, must not fire.
    for (const pattern of [
      String.raw`load\s*[(=]`,
      String.raw`(see appendix) load`,
      String.raw`\bfoo\b`,
      // A modifier word in prose, with no identifier→opener coupling.
      "static analysis of the result",
      "public api (v2) notes",
    ]) {
      assert.equal(isStructureShapedPattern(pattern), false, pattern);
    }
  });

  it("锚定定义形同样过闸：无证据拒、E2 放行", async () => {
    const root = await makeScratch("role-sub-grep-anchored-");
    await writeFile(join(root, "a.ts"), "  load(x: number) {}\n");
    const anchored = String.raw`^\s*load\s*[<(]`;
    await expectGrepRefusal(root, { pattern: anchored }, []);
    const tool = createGrepTool(root);
    const out = (await tool.handler(
      { pattern: anchored },
      { messages: [assistantToolUse("find_symbol", "tu_sym_2")] }
    )) as string;
    assert.equal(typeof out, "string");
  });

  it("ctx 缺席 / messages 缺席 / messages 空 → 结构形一律拒（fail-closed）", async () => {
    const root = await makeScratch("role-sub-grep-empty-");
    const message = await expectGrepRefusal(root, { pattern: "class Foo" });
    assert.ok(message.startsWith(ROLE_SUBSTITUTION_PREFIX));
    assert.ok(message.includes("find_symbol"), "回执只指向 find_symbol");
    assert.ok(!message.includes("hard_wall"));
    for (const prefix of Object.values(VIOLATION_PREFIXES)) {
      assert.ok(!message.includes(prefix), `不得含违例前缀 ${prefix}`);
    }
    assert.equal(hasFallbackTrajectoryEvidence([]), false);
    await expectGrepRefusal(root, { pattern: "class Foo" }, []);
  });

  it("E2：轨迹里有查侧符号工具 tool_use → 放行", async () => {
    const root = await makeScratch("role-sub-grep-e2-");
    await writeFile(join(root, "a.ts"), "export class Foo {}\n");
    const tool = createGrepTool(root);
    const out = (await tool.handler(
      { pattern: "class Foo" },
      { messages: [assistantToolUse("find_symbol", "tu_sym_1")] }
    )) as string;
    assert.equal(typeof out, "string");
    assert.ok(out.includes("a.ts"));
  });

  it("证据必须严格在先：同 wave 并发的符号 tool_use 不豁免，先前 turn 的豁免", async () => {
    // 认轨迹不认自觉：同一条 assistant 消息里 grep 与 find_symbol 并发是
    // 当前意图不是已完成咨询（真实 trace tempt-1078-t01：grep 因看见同
    // wave 兄弟 find_symbol 而漏放行）。
    const root = await makeScratch("role-sub-grep-prior-");
    await writeFile(join(root, "a.ts"), "export class Foo {}\n");
    const tool = createGrepTool(root);
    const sameWave: AnthropicNativeMessage = {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu_g_9",
          name: "grep",
          input: { pattern: "class Foo" },
        },
        { type: "tool_use", id: "tu_sym_9", name: "find_symbol", input: {} },
      ],
    };
    let caught: unknown;
    try {
      await tool.handler(
        { pattern: "class Foo" },
        { messages: [sameWave], toolUseId: "tu_g_9" }
      );
    } catch (error) {
      caught = error;
    }
    assert.ok(
      caught instanceof ToolExecutionError,
      `同 wave 兄弟符号调用不得豁免 grep，实际: ${String(caught)}`
    );
    assert.ok(caught.message.startsWith(ROLE_SUBSTITUTION_PREFIX));

    const priorTurn: ReadonlyArray<AnthropicNativeMessage> = [
      assistantToolUse("find_symbol", "tu_sym_p"),
      userToolResult("tu_sym_p", "no symbol found"),
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu_g_p",
            name: "grep",
            input: { pattern: "class Foo" },
          },
        ],
      },
    ];
    const out = (await tool.handler(
      { pattern: "class Foo" },
      { messages: priorTurn, toolUseId: "tu_g_p" }
    )) as string;
    assert.ok(
      out.includes("a.ts"),
      "先前 turn 的 find_symbol 咨询豁免后续 grep"
    );

    // toolUseId 不在快照里 → 空窗口，fail closed。
    assert.equal(hasFallbackTrajectoryEvidence(priorTurn, "tu_absent"), false);
  });

  it("E3：改侧符号工具的 tool_result 携带 LSP 可读失败哨兵 → 放行", async () => {
    const root = await makeScratch("role-sub-grep-e3-");
    await writeFile(join(root, "a.ts"), "export class Foo {}\n");
    const tool = createGrepTool(root);
    const out = (await tool.handler(
      { pattern: "class Foo" },
      {
        messages: [
          assistantToolUse("rename_symbol", "tu_mut_1"),
          userToolResult("tu_mut_1", LSP_FAILURE_SENTINEL),
        ],
      }
    )) as string;
    assert.equal(typeof out, "string");
  });

  it("假证据不放行：哨兵串挂在 bash 调用下 / tool_use 与 result 不配对", async () => {
    const root = await makeScratch("role-sub-grep-fake-");
    assert.equal(
      hasFallbackTrajectoryEvidence([
        assistantToolUse("bash", "tu_b_1"),
        userToolResult("tu_b_1", LSP_FAILURE_SENTINEL),
      ]),
      false,
      "哨兵必须来自符号工具调用的 result"
    );
    assert.equal(
      hasFallbackTrajectoryEvidence([
        userToolResult("tu_orphan", LSP_FAILURE_SENTINEL),
      ]),
      false,
      "无配对 tool_use 的 result 不算证据"
    );
    assert.equal(
      hasFallbackTrajectoryEvidence([
        assistantToolUse("rename_symbol", "tu_mut_2"),
        userToolResult("tu_mut_2", "renamed 3 symbols"),
      ]),
      false,
      "非哨兵内容不算 E3"
    );
    await expectGrepRefusal(root, { pattern: "class Foo" }, [
      assistantToolUse("bash", "tu_b_1"),
      userToolResult("tu_b_1", LSP_FAILURE_SENTINEL),
    ]);
  });

  it("正文 pattern 永不误伤（无证据也放行）", async () => {
    const root = await makeScratch("role-sub-grep-content-");
    await writeFile(join(root, "a.txt"), "needle here\n");
    const tool = createGrepTool(root);
    const out = (await tool.handler(
      { pattern: "needle" },
      { messages: [] }
    )) as string;
    assert.ok(out.includes("a.txt"));
  });

  it("结构形 pattern + 显式非代码 scope → 放行；代码 scope 仍拒", async () => {
    const root = await makeScratch("role-sub-grep-scope-");
    await writeFile(join(root, "a.md"), "see class Foo below\n");
    const tool = createGrepTool(root);
    const out = (await tool.handler(
      { pattern: "class Foo", glob: "*.md" },
      { messages: [] }
    )) as string;
    assert.ok(out.includes("a.md"));
    await expectGrepRefusal(root, { pattern: "class Foo", glob: "*.ts" }, []);
  });

  it("执行失败编码：拒绝经 ToolExecutionError 抵达模型侧 [execution_failed]", async () => {
    const root = await makeScratch("role-sub-grep-encode-");
    const tool = createGrepTool(root);
    let caught: unknown;
    try {
      await tool.handler({ pattern: "function main" });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof ToolExecutionError);
    const failure: ToolExecutionResult = {
      kind: "execution_failed",
      toolUseId: "tu_g_1",
      message: caught.message,
    };
    const [block] = toAnthropicToolResults([failure]);
    const text =
      block && block.type === "tool_result" && Array.isArray(block.content)
        ? (block.content[0] as { text: string }).text
        : "";
    assert.ok(
      block?.type === "tool_result" && block.is_error === true,
      "must encode as error tool_result"
    );
    assert.ok(
      text.startsWith(`[execution_failed] ${ROLE_SUBSTITUTION_PREFIX}`),
      `模型侧回执必须以 [execution_failed] + 拒绝前缀开头，实际: ${text}`
    );
  });
});
