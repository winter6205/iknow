/**
 * ADR-0117 tool-role substitution refusal — acceptance-side boundary matrix
 * (issue #1089 section A, rows B1..B11). This file is ADDITIVE to
 * role-substitution.test.ts (bash arm) + role-substitution-grep.test.ts
 * (grep arm): those 20 cases pin the contract half (keyword / `^` /
 * modifier group / E2 strictly-prior). This set pins the ACCEPTED escape
 * surface the ticket exists to close — what must still PASS and is not a
 * bug — driven through the real handlers where feasible (so receipts, the
 * last-read ledger, and the actual search engine are exercised), plus the
 * pure gate entry for offline/deterministic non-refusal checks.
 *
 * Row -> test map is asserted in the case titles ("B#"). Categories follow
 * the boundary-testing protocol's 5 classes; a note in each block tags it.
 *
 * Do NOT edit gate source to make a case green: a red case here is a
 * finding about the gate, not a test to weaken.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import { createBashTool } from "../../../../src/harness/aci/tools/bash.ts";
import { createGrepTool } from "../../../../src/harness/aci/tools/grep.ts";
import { VIOLATION_PREFIXES } from "../../../../src/harness/permission/prefixes.ts";
import type { AnthropicNativeMessage } from "../../../../src/harness/model-adapter/types.ts";
import type { AciToolDef } from "../../../../src/harness/aci/types.ts";
import {
  ROLE_SUBSTITUTION_PREFIX,
  assertNoBashGrepSubstitution,
  detectBashGrepSubstitution,
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

/** LSP readable-failure sentinel shape (lsp.ts renderNoServer prefix). */
const LSP_FAILURE_SENTINEL =
  "(no LSP server configured; supported extensions: ts, tsx)";

/** bash handler envelope: {output: JSON.stringify({code,stdout,stderr})}. */
interface BashEnvelope {
  readonly output: string;
}

async function runBash(
  tool: AciToolDef,
  command: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  const envelope = (await tool.handler({ command })) as BashEnvelope;
  // Real JSON hop: prove the pass path returns a parseable envelope, not a
  // refusal. This is the acceptance side of the gate.
  return JSON.parse(envelope.output) as {
    code: number;
    stdout: string;
    stderr: string;
  };
}

/** Assert the real bash handler throws a role-substitution refusal. */
async function expectBashRefusal(
  tool: AciToolDef,
  command: string
): Promise<string> {
  let caught: unknown;
  try {
    await tool.handler({ command });
  } catch (error) {
    caught = error;
  }
  assert.ok(
    caught instanceof ToolExecutionError,
    `${command} -> must be refused fail-closed (ToolExecutionError), got: ${String(caught)}`
  );
  return caught.message;
}

/** Assert the real grep handler throws a role-substitution refusal. */
async function expectGrepRefusal(
  tool: AciToolDef,
  input: unknown,
  ctx?: {
    readonly messages?: ReadonlyArray<AnthropicNativeMessage>;
    readonly toolUseId?: string;
  }
): Promise<string> {
  let caught: unknown;
  try {
    await tool.handler(input, ctx);
  } catch (error) {
    caught = error;
  }
  assert.ok(
    caught instanceof ToolExecutionError,
    `structure-shaped grep must be refused, got: ${String(caught)}`
  );
  return caught.message;
}

describe("#1089 bash arm — accepted escape surface (B1..B3b)", () => {
  // B1 — Category A (positive control): still refuses the plain grep family
  // via the real handler. Distinct spellings from the pinned set: `-n`
  // flag-before-operand and recursive `-rn` (the ADR "Why not" line calls
  // out `grep -r` specifically — this proves the first-token rule catches it).
  it("B1 [A]: grep -n / rg -n / grep -rn / egrep -r are refused at the handler", async () => {
    const cwd = await makeScratch("b1089-b1-");
    await writeFile(join(cwd, "src.txt"), "needle\n");
    const bash = createBashTool(cwd);
    for (const command of [
      "grep -n needle src.txt",
      "rg -n needle src.txt",
      "grep -rn needle .",
      "egrep -r needle .",
    ]) {
      const message = await expectBashRefusal(bash, command);
      assert.ok(
        message.startsWith(ROLE_SUBSTITUTION_PREFIX),
        `${command} refusal must start with ${ROLE_SUBSTITUTION_PREFIX}`
      );
      assert.ok(
        message.includes("grep"),
        `${command} receipt points to ACI grep`
      );
      assert.ok(
        message.includes("find_symbol"),
        `${command} receipt points to find_symbol`
      );
    }
  });

  // B2 — Category D (out-of-domain): build/test processes are not text
  // search. Driven through the EXACT gate entry bash.ts calls
  // (assertNoBashGrepSubstitution) so the check is offline + deterministic;
  // `go test ./...` additionally runs the real handler to confirm a
  // non-refusal envelope reaches the model.
  it("B2 [D]: go test / npm test / make / pytest / cargo are not substitution", async () => {
    const cwd = await makeScratch("b1089-b2-");
    for (const command of [
      "go test ./...",
      "npm test",
      "make build",
      "pytest -q",
      "cargo build",
    ]) {
      assert.doesNotThrow(
        () => assertNoBashGrepSubstitution(command),
        `${command} must not trip the gate entry`
      );
    }
    // Real-handler confirmation (offline: no go.mod -> fast non-zero, never a refusal).
    const bash = createBashTool(cwd);
    const result = await runBash(bash, "go test ./...");
    assert.equal(typeof result.code, "number");
  });

  // B3 — Category B (negation / registered escape): indirect grep that the
  // first-token rule demonstrably does NOT catch. This ticket only locks
  // "still passes", it does not plug the hole.
  it("B3 [B]: find|xargs grep escapes the gate and executes; $(which grep) escapes the gate (caught by a different wall)", async () => {
    // Predicate: the substitution gate is silent on both indirect forms.
    assert.equal(
      detectBashGrepSubstitution("find . | xargs grep needle"),
      undefined,
      "xargs grep tail is not a segment-leading grep token"
    );
    assert.equal(
      detectBashGrepSubstitution("$(which grep) needle f"),
      undefined,
      "command-substituted grep is not a segment-leading grep token"
    );

    // find|xargs grep is neither dangerous nor sensitive -> it reaches the
    // sandbox and returns an envelope (not a refusal). Real FS + real JSON.
    const cwd = await makeScratch("b1089-b3-xargs-");
    await writeFile(join(cwd, "a.ts"), "needle here\n");
    const bash = createBashTool(cwd);
    const result = await runBash(bash, "find . | xargs grep needle");
    assert.equal(typeof result.code, "number");

    // $(rm -rf /tmp/x) is stopped by the command-substitution HARD WALL (the
    // dangerous inner propagates), not by the substitution gate — its
    // rejection message must NOT carry the [role_substitution] prefix (proves
    // the gate itself let it through).
    let caught: unknown;
    try {
      await bash.handler({ command: "$(rm -rf /tmp/x) needle f" });
    } catch (error) {
      caught = error;
    }
    assert.ok(
      caught instanceof ToolExecutionError,
      "$(rm -rf /tmp/x) is rejected by the command-substitution hard-wall"
    );
    const msg = (caught as ToolExecutionError).message;
    assert.ok(
      !msg.includes(ROLE_SUBSTITUTION_PREFIX),
      `must NOT be a role_substitution refusal (gate let it through), got: ${msg}`
    );
  });

  // B3b — Category B, registered by ADR-0117 after the #1089 boundary matrix
  // ran: this gate reads command units off the parse (separator facts:
  // `;` / `&&` / `||` / `|`), which do NOT treat a newline as a unit
  // boundary — unlike the ADR-0068
  // dangerous-scan face, which splits per line. Locking the divergence, not
  // plugging it: the product bar is majority routing, not airtight enforcement.
  it("B3b [B]: grep after a newline escapes the gate and really executes (newline is not this gate's segment boundary)", async () => {
    assert.equal(
      detectBashGrepSubstitution("printf x\ngrep needle a.ts"),
      undefined,
      "grep on a following line is not a segment-leading token for this gate"
    );

    // It is neither dangerous nor sensitive, so it reaches the sandbox — and
    // there the second line really runs, which is the escape being registered.
    const cwd = await makeScratch("b1089-b3b-newline-");
    await writeFile(join(cwd, "a.ts"), "needle here\n");
    const bash = createBashTool(cwd);
    const result = await runBash(bash, "printf x\ngrep needle a.ts");
    assert.equal(typeof result.code, "number");
    assert.ok(
      result.stdout.includes("needle"),
      `grep must have actually executed (proves the gate let the segment through), got: ${result.stdout}`
    );
  });
});

describe("#1089 grep arm — accepted escape surface (B4..B11)", () => {
  // B4 — Category B: plain content patterns pass at the handler with real
  // hits (the pinned set only exercised `needle`; add `TODO` + word-boundary).
  it("B4 [B]: TODO / \\bfoo\\b are treated as content and return hits", async () => {
    const root = await makeScratch("b1089-b4-");
    await writeFile(join(root, "notes.txt"), "TODO: fix later\n");
    await writeFile(join(root, "a.txt"), "a foo bar\n");
    const grep = createGrepTool(root);
    const todo = (await grep.handler(
      { pattern: "TODO" },
      { messages: [] }
    )) as string;
    assert.ok(
      todo.includes("notes.txt"),
      "TODO must return the file, not refuse"
    );
    const foo = (await grep.handler(
      { pattern: "\\bfoo\\b" },
      { messages: [] }
    )) as string;
    assert.ok(
      foo.includes("a.txt"),
      "\\bfoo\\b must return the file, not refuse"
    );
  });

  // B5 — Category A: def / modifier-group shapes refuse at the handler with
  // no trajectory (the pinned set refused class Foo / function main at the
  // handler; add a Python def + a `(async )?load[(=]` modifier group). The
  // third entry is the shape a real-model run actually wrote for a definition
  // question — nested modifier group, opener inside an alternation group —
  // which the first table revision classified as content.
  it("B5 [A]: def process / modifier-group load refuse at the handler (no trajectory)", async () => {
    const root = await makeScratch("b1089-b5-");
    const grep = createGrepTool(root);
    for (const pattern of [
      "def process",
      String.raw`(async\s+)?load\s*[(=]`,
      String.raw`^\s*((public|private|protected|static|override|async)\s+)*#?load\s*(\(|=|:)`,
    ]) {
      assert.equal(isStructureShapedPattern(pattern), true, pattern);
      const msg = await expectGrepRefusal(grep, { pattern }, { messages: [] });
      assert.ok(msg.startsWith(ROLE_SUBSTITUTION_PREFIX), pattern);
      assert.ok(msg.includes("find_symbol"), pattern);
      for (const prefix of Object.values(VIOLATION_PREFIXES)) {
        assert.ok(!msg.includes(prefix), `${pattern} must not carry ${prefix}`);
      }
    }
  });

  // B6 — Category E (reverse semantics): the pattern LOOKS structural (an
  // identifier coupled to a call opener) but is UNANCHORED, i.e. the ADR
  // accepted content surface. Must PASS with real hits, not refuse.
  it("B6 [E]: unanchored \\bload\\s*\\( and console.log( PASS with real hits (accepted content surface)", async () => {
    assert.equal(isStructureShapedPattern(String.raw`\bload\s*\(`), false);
    assert.equal(isStructureShapedPattern(String.raw`console\.log\(`), false);
    const root = await makeScratch("b1089-b6-");
    await writeFile(join(root, "a.ts"), "  load(x: number) {}\n");
    await writeFile(join(root, "b.ts"), 'console.log("hi");\n');
    const grep = createGrepTool(root);
    const load = (await grep.handler(
      { pattern: String.raw`\bload\s*\(` },
      { messages: [] }
    )) as string;
    assert.ok(
      load.includes("a.ts"),
      "unanchored ident+paren must be searchable"
    );
    const log = (await grep.handler(
      { pattern: String.raw`console\.log\(` },
      { messages: [] }
    )) as string;
    assert.ok(log.includes("b.ts"), "console.log( must be searchable");
  });

  // B7 — Category C (ambiguous: two symbol/grep candidates in one wave):
  // a same-wave sibling find_symbol is current intent, not a completed
  // consultation -> still refuse. Uses the ANCHORED shape (the pinned
  // same-wave test used class Foo), tying B5 evidence rules to B7.
  it("B7 [C]: anchored shape + same-wave sibling find_symbol is STILL refused", async () => {
    const root = await makeScratch("b1089-b7-");
    await writeFile(join(root, "a.ts"), "  load(x: number) {}\n");
    const grep = createGrepTool(root);
    const anchored = String.raw`^\s*load\s*[<(]`;
    const sameWave: AnthropicNativeMessage = {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu_g_1",
          name: "grep",
          input: { pattern: anchored },
        },
        { type: "tool_use", id: "tu_s_1", name: "find_symbol", input: {} },
      ],
    };
    const msg = await expectGrepRefusal(
      grep,
      { pattern: anchored },
      { messages: [sameWave], toolUseId: "tu_g_1" }
    );
    assert.ok(
      msg.startsWith(ROLE_SUBSTITUTION_PREFIX),
      "same-wave must refuse"
    );
  });

  // B8 (E2 half) — Category B: the same anchored shape PASSES on a
  // strictly-prior find_symbol consult (evidence in an earlier message).
  it("B8 [B]: anchored shape + strictly-prior find_symbol PASSES (E2)", async () => {
    const root = await makeScratch("b1089-b8e2-");
    await writeFile(join(root, "a.ts"), "  load(x: number) {}\n");
    const grep = createGrepTool(root);
    const anchored = String.raw`^\s*load\s*[<(]`;
    const out = (await grep.handler(
      { pattern: anchored },
      { messages: [assistantToolUse("find_symbol", "tu_sym")] }
    )) as string;
    assert.ok(out.includes("a.ts"), "E2 must let the anchored grep through");
  });

  // B8 (E3 half) — Category E: no keyword spells "fallback"; only the
  // trajectory (a mutate-symbol call whose result is an LSP failure
  // sentinel) carries the intent. Anchored shape -> PASS.
  it("B8 [E]: anchored shape + mutate-symbol LSP failure sentinel PASSES (E3)", async () => {
    const root = await makeScratch("b1089-b8e3-");
    await writeFile(join(root, "a.ts"), "  load(x: number) {}\n");
    const grep = createGrepTool(root);
    const anchored = String.raw`^\s*load\s*[<(]`;
    const out = (await grep.handler(
      { pattern: anchored },
      {
        messages: [
          assistantToolUse("rename_symbol", "tu_mut"),
          userToolResult("tu_mut", LSP_FAILURE_SENTINEL),
        ],
      }
    )) as string;
    assert.equal(
      hasFallbackTrajectoryEvidence([
        assistantToolUse("rename_symbol", "tu_mut"),
        userToolResult("tu_mut", LSP_FAILURE_SENTINEL),
      ]),
      true
    );
    assert.ok(out.includes("a.ts"), "E3 must let the anchored grep through");
  });

  // B9 — Category C (ambiguous scope: a brace lists both a doc and a code
  // extension; the call must resolve to "under the gate"): mixed-extension
  // glob refuses at the handler (never reaches the engine); pure non-code
  // brace is exempt at the predicate.
  it("B9 [C]: class Foo + glob *.{md,ts} refuses; *.{md,json} is non-code exempt", async () => {
    assert.equal(isNonCodeScopedCall({ glob: "*.{md,json}" }), true);
    assert.equal(isNonCodeScopedCall({ glob: "*.{md,ts}" }), false);
    const root = await makeScratch("b1089-b9-");
    const grep = createGrepTool(root);
    const msg = await expectGrepRefusal(
      grep,
      { pattern: "class Foo", glob: "*.{md,ts}" },
      { messages: [] }
    );
    assert.ok(
      msg.startsWith(ROLE_SUBSTITUTION_PREFIX),
      "mixed-ext glob must refuse"
    );
  });

  // B10 — Category D (out-of-domain languages): Go `func` / Rust `fn` are
  // NOT in the frozen definition table -> accepted content surface, must
  // PASS with real hits (no `^`, no modifier group).
  it("B10 [D]: Go func main / Rust fn foo PASS as content (off-table keywords)", async () => {
    assert.equal(isStructureShapedPattern("func main"), false);
    assert.equal(isStructureShapedPattern("fn foo"), false);
    const root = await makeScratch("b1089-b10-");
    await writeFile(join(root, "main.go"), "func main() {}\n");
    await writeFile(join(root, "lib.rs"), "fn foo() {}\n");
    const grep = createGrepTool(root);
    const go = (await grep.handler(
      { pattern: "func main" },
      { messages: [] }
    )) as string;
    assert.ok(go.includes("main.go"), "Go func must be searchable");
    const rs = (await grep.handler(
      { pattern: "fn foo" },
      { messages: [] }
    )) as string;
    assert.ok(rs.includes("lib.rs"), "Rust fn must be searchable");
  });

  // B11 — Category C (three fail-closed context shapes on an anchored
  // structure query): ctx absent / messages [] / a toolUseId not present in
  // the snapshot. All must refuse (empty or truncated evidence window).
  it("B11 [C]: anchored shape fail-closed on missing ctx / [] messages / unknown toolUseId", async () => {
    const root = await makeScratch("b1089-b11-");
    const grep = createGrepTool(root);
    const anchored = String.raw`^\s*load\s*[<(]`;
    // (a) no ctx at all -> messages undefined.
    await expectGrepRefusal(grep, { pattern: anchored });
    // (b) explicit empty trajectory.
    await expectGrepRefusal(grep, { pattern: anchored }, { messages: [] });
    // (c) a prior find_symbol exists but current toolUseId is not in the
    // snapshot -> empty window -> fail closed.
    const withFindFirst: ReadonlyArray<AnthropicNativeMessage> = [
      assistantToolUse("find_symbol", "tu_sym"),
      userToolResult("tu_sym", "no symbol found"),
    ];
    const msg = await expectGrepRefusal(
      grep,
      { pattern: anchored },
      { messages: withFindFirst, toolUseId: "tu_not_in_snapshot" }
    );
    assert.ok(
      msg.startsWith(ROLE_SUBSTITUTION_PREFIX),
      "unknown id must fail closed"
    );
  });

  // B12 — Category D (regex-dialect boundary, ADR-0117 接受面): POSIX bracket
  // classes are not part of the identifier→opener separator class, so a
  // POSIX-flavored pattern is structural only when it also carries the
  // modifier-group signature. Locking both sides here keeps the ADR prose
  // machine-checked instead of folklore: the gate does not chase dialects, and
  // what it does accept is written down.
  it("B12 [D]: POSIX bracket classes ride on the modifier-group signature", async () => {
    assert.equal(
      isStructureShapedPattern(
        String.raw`^[[:space:]]*(public |private |protected |static |async |override |abstract )*(\* *)?load[[:space:]]*[(<]`
      ),
      true,
      "POSIX + modifier group is the definition shape a real model wrote"
    );
    assert.equal(
      isStructureShapedPattern(String.raw`^[[:space:]]*load[[:space:]]*\(`),
      false,
      "POSIX alone must not couple identifier to the opener"
    );
    const root = await makeScratch("b1089-b12-");
    await writeFile(join(root, "a.ts"), "  load(x: number) {}\n");
    const grep = createGrepTool(root);
    const hit = (await grep.handler(
      { pattern: String.raw`[[:space:]]*(load|save)[[:space:]]*\(` },
      { messages: [] }
    )) as string;
    assert.ok(
      hit.includes("a.ts"),
      "unmodifiers POSIX call-shape must stay searchable"
    );
  });
});
