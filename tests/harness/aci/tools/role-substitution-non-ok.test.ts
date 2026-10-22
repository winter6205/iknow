/**
 * SC-S4-1 (T24) census — the non-`ok` arms of `detectBashGrepSubstitution`.
 *
 * Per `docs/shell-parse-non-ok-consumer-contracts.md`, the gate stays
 * SILENT for all five non-`ok` verdicts (`unknown-syntax` / `malformed` /
 * `aborted` / `over-cap` / `parser-unavailable`) and the pre-parse
 * `vetoed` arm: `undefined`, no refusal. Every row is two-sided — the
 * shape first proves it carries the verdict it names through
 * `parseForSecurity`, then the gate answers — and one negative control
 * (an `ok` parse of the same words still fires) so the silence reads as
 * verdict-driven, never as a dead gate.
 *
 * The `unknown-syntax` / `malformed` rows are the REGISTERED relaxation,
 * not an accident: the old text splitter fired on the segment-leading
 * grep there, and silence replaces a possible recognition. It is tagged
 * `expected-relaxation` citing ADR-0117's not-a-hard-wall scope and
 * SC-S4-7's named warrant (the case the contract doc admits: an
 * `unknown-syntax` command the user then approves at the ask prompt).
 * The zero-width `vetoed` row replaces a shape that fired too — the
 * closed-set declaration in SC-S4-1 covers it.
 *
 * #1188 split the old backslash-whitespace row in two: the odd-parity
 * escaped SPACE and the word-separator LF continuation now reach this
 * gate's `ok` arm, so they are asserted as positive rows (the gate fires
 * again on `grep x\ f`); the RETAINED roster (backslash+TAB, even-parity
 * run) keeps the stay-silent contract.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";

import {
  parseForSecurity,
  setBindingLoaderForTest,
  setTreeBuilderSpyForTest,
  type TreeBuilderSpy,
} from "../../../../src/harness/permission/shell-parse.ts";
import { detectBashGrepSubstitution } from "../../../../src/harness/aci/tools/role-substitution.ts";

type ShellParseModule = typeof import("../../../../src/harness/permission/shell-parse.js");
type RoleModule = typeof import("../../../../src/harness/aci/tools/role-substitution.js");

async function freshModules(): Promise<{
  parse: ShellParseModule;
  gate: RoleModule;
}> {
  // A load failure is process-terminal for the binding, so the
  // parser-unavailable row takes its own fresh copy of the graph; both
  // imports after ONE reset share that copy.
  vi.resetModules();
  const parse = await import(
    "../../../../src/harness/permission/shell-parse.js"
  );
  const gate = await import(
    "../../../../src/harness/aci/tools/role-substitution.js"
  );
  return { parse, gate };
}

function recorderSpy(): TreeBuilderSpy & { armNextParseThrow(error: Error): void } {
  const spy: TreeBuilderSpy & { armed: Error | null } = {
    armed: null,
    onSetTimeoutMicros(): void {},
    onParse(): void {
      if (spy.armed !== null) {
        const fault = spy.armed;
        spy.armed = null;
        throw fault;
      }
    },
    armNextParseThrow(error: Error): void {
      spy.armed = error;
    },
  };
  return spy;
}

afterEach(() => {
  setTreeBuilderSpyForTest(null);
  setBindingLoaderForTest(null);
});

describe("替岗闸 non-ok 普查 — 一律沉默（SC-S4-1）", () => {
  it("unknown-syntax → undefined（登记在册的 expected-relaxation，ADR-0117 / SC-S4-7）", () => {
    const shape = "grep x f; [[ a == b ]]";
    assert.equal(parseForSecurity(shape).kind, "unknown-syntax");
    assert.equal(detectBashGrepSubstitution(shape), undefined);
  });

  it("malformed → undefined（`grep x f &&` 旧拆段会触发，非-ok 声明覆盖它）", () => {
    const shape = "grep x f &&";
    assert.equal(parseForSecurity(shape).kind, "malformed");
    assert.equal(detectBashGrepSubstitution(shape), undefined);
  });

  it("over-cap → undefined（超上限的命令根本没进解析器）", () => {
    const shape = `grep x ${"f".repeat(70_000)}`;
    assert.equal(parseForSecurity(shape).kind, "over-cap");
    assert.equal(detectBashGrepSubstitution(shape), undefined);
  });

  it("vetoed → undefined（零宽字符前解析否决）", () => {
    const zeroWidth = "grep x f\u200B";
    assert.equal(parseForSecurity(zeroWidth).kind, "vetoed");
    assert.equal(detectBashGrepSubstitution(zeroWidth), undefined);
  });

  it("backslash-whitespace → undefined（保留类：反斜杠+TAB、词内折行、反斜杠偶数串）", () => {
    // #1188 admitted the odd-parity escaped SPACE and the word-separator LF
    // continuation, so `grep x\ f` is no longer this consumer's non-`ok`
    // premise — it moved to the admitted row below. The RETAINED roster must
    // still stay silent, and each of these three was a shape the old text
    // splitter fired on.
    for (const shape of [
      "grep x\\\t f", // 反斜杠 + TAB：旧拆段会触发
      "grep x\\\tf", // 反斜杠 + TAB，词内
      "grep x\\\\ f", // 偶数串：空白是真实分隔符，形状未证明
    ]) {
      assert.equal(parseForSecurity(shape).kind, "vetoed", shape);
      assert.equal(detectBashGrepSubstitution(shape), undefined, shape);
    }
  });

  it("反斜杠空格（#1188 放行）到达 `ok` 分支并如实识别", () => {
    // 放行后的正例：转义空格折进 pattern 这个词，段首 grep 词照常被识别。
    // 修复前这条被 `backslash-whitespace` 前解析否决吞掉，闸门是沉默的。
    const admitted = "grep x\\ f";
    const parsed = parseForSecurity(admitted);
    assert.equal(parsed.kind, "ok");
    assert.deepEqual(
      parsed.kind === "ok" ? parsed.words.map((word) => word.value) : [],
      ["grep", "x f"],
      "转义空格折进 pattern 词内，命令词与 pattern 仍是两个词"
    );
    assert.equal(detectBashGrepSubstitution(admitted), "grep");

    // 同样放行的词分隔折行：段首 grep 词跨过折行仍被识别。
    const continued = "grep x \\\n f";
    assert.equal(parseForSecurity(continued).kind, "ok");
    assert.equal(detectBashGrepSubstitution(continued), "grep");
  });

  it("aborted → undefined（READY 之后的解析故障），解除后同词照常识别", () => {
    const shape = "grep unique-abort-t24-marker f";
    const spy = recorderSpy();
    setTreeBuilderSpyForTest(spy);
    spy.armNextParseThrow(new RangeError("stack exhausted"));
    assert.equal(parseForSecurity(shape).kind, "aborted");
    spy.armNextParseThrow(new RangeError("stack exhausted"));
    assert.equal(detectBashGrepSubstitution(shape), undefined);
    setTreeBuilderSpyForTest(null);
    // Two-sided: the silence came from the verdict, not from a dead gate.
    assert.equal(parseForSecurity(shape).kind, "ok");
    assert.equal(detectBashGrepSubstitution(shape), "grep");
  });

  it("parser-unavailable → undefined（绑定加载失败 terminal 态；fresh module instance）", async () => {
    const { parse, gate } = await freshModules();
    parse.setBindingLoaderForTest(() => {
      throw new Error("injected load failure for the census row");
    });
    assert.equal(parse.parseForSecurity("grep x f").kind, "parser-unavailable");
    assert.equal(gate.detectBashGrepSubstitution("grep x f"), undefined);
  });
});
