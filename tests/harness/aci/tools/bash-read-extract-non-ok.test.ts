/**
 * SC-S4-1 (T24) census — the non-`ok` arms of `extractSingleReadPath`.
 *
 * The ledger gate RECORDS NOTHING for all five non-`ok` verdicts
 * (`unknown-syntax` / `malformed` / `aborted` / `over-cap` /
 * `parser-unavailable`) and for the pre-parse `vetoed` arm: `undefined`,
 * no splitter fallback behind it
 * (`docs/shell-parse-non-ok-consumer-contracts.md`). A ledger record is
 * an affordance, not a refusal, so recording nothing is always the
 * stricter side — which is why `malformed` is spelled out here: the
 * extractor is reached from the ledger path at `bash.ts:1236`, where no
 * wall pre-emption runs in front of it.
 *
 * Two rows replace a shape that booked a path under the old text
 * segmentation — the `cat a.ts &&`-style malformed row and the over-cap
 * row, plus the spec-named zero-width `vetoed` pin
 * (`extractSingleReadPath("cat a.ts" + U+200B)` returned that
 * zero-width-suffixed path before this rule; it now records nothing).
 * Each is the declared non-`ok` answer, tagged `expected-relaxation`
 * with the SC-S4-1 warrant in the divergence log (SC-S4-7), pinned here
 * so the direction is written down rather than assumed.
 *
 * Every row is two-sided: the shape first proves it carries the verdict
 * it names through `parseForSecurity`, then the extractor answers, and a
 * same-words `ok` control still books where the contract allows.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";

import {
  parseForSecurity,
  setBindingLoaderForTest,
  setTreeBuilderSpyForTest,
  type TreeBuilderSpy,
} from "../../../../src/harness/permission/shell-parse.ts";
import { extractSingleReadPath } from "../../../../src/harness/aci/tools/bash-read-extract.ts";

type ShellParseModule = typeof import("../../../../src/harness/permission/shell-parse.js");
type ExtractModule = typeof import("../../../../src/harness/aci/tools/bash-read-extract.js");

async function freshModules(): Promise<{
  parse: ShellParseModule;
  extract: ExtractModule;
}> {
  // A load failure is process-terminal for the binding, so the
  // parser-unavailable row takes its own fresh copy of the graph; both
  // imports after ONE reset share that copy.
  vi.resetModules();
  const parse = await import(
    "../../../../src/harness/permission/shell-parse.js"
  );
  const extract = await import(
    "../../../../src/harness/aci/tools/bash-read-extract.js"
  );
  return { parse, extract };
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

describe("入账提取器 non-ok 普查 — 一律不入账（SC-S4-1）", () => {
  it("unknown-syntax → undefined", () => {
    const shape = "cat a.ts; [[ x == y ]]";
    assert.equal(parseForSecurity(shape).kind, "unknown-syntax");
    assert.equal(extractSingleReadPath(shape), undefined);
  });

  it("malformed → undefined（`cat a.ts &&` 旧拆段会入账，非-ok 声明覆盖它）", () => {
    const shape = "cat a.ts &&";
    assert.equal(parseForSecurity(shape).kind, "malformed");
    assert.equal(extractSingleReadPath(shape), undefined);
    // Same-shape control the contract keeps: a closed single command.
    assert.equal(extractSingleReadPath("cat a.ts && cat b.ts"), undefined);
  });

  it("over-cap → undefined（超上限不进解析器，旧文本路径会把 70KiB 参数当唯一操作数入账）", () => {
    const shape = `cat ${"a".repeat(70_000)}`;
    assert.equal(parseForSecurity(shape).kind, "over-cap");
    assert.equal(extractSingleReadPath(shape), undefined);
  });

  it("vetoed → undefined（spec 点名的零宽形态 `cat a.ts` + U+200B，入账前形态改判不入账）", () => {
    const zeroWidth = "cat a.ts\u200B";
    assert.equal(parseForSecurity(zeroWidth).kind, "vetoed");
    assert.equal(extractSingleReadPath(zeroWidth), undefined);
    const backslash = "cat\\ a.ts";
    assert.equal(parseForSecurity(backslash).kind, "vetoed");
    assert.equal(extractSingleReadPath(backslash), undefined);
  });

  it("aborted → undefined（READY 之后的解析故障），解除后同词照常入账", () => {
    const shape = "cat unique-abort-t24-marker.ts";
    const spy = recorderSpy();
    setTreeBuilderSpyForTest(spy);
    spy.armNextParseThrow(new RangeError("stack exhausted"));
    assert.equal(parseForSecurity(shape).kind, "aborted");
    spy.armNextParseThrow(new RangeError("stack exhausted"));
    assert.equal(extractSingleReadPath(shape), undefined);
    setTreeBuilderSpyForTest(null);
    // Two-sided: the miss came from the verdict, not from a dead gate.
    assert.equal(parseForSecurity(shape).kind, "ok");
    assert.equal(extractSingleReadPath(shape), "unique-abort-t24-marker.ts");
  });

  it("parser-unavailable → undefined（绑定加载失败 terminal 态；fresh module instance）", async () => {
    const { parse, extract } = await freshModules();
    parse.setBindingLoaderForTest(() => {
      throw new Error("injected load failure for the census row");
    });
    assert.equal(parse.parseForSecurity("cat a.ts").kind, "parser-unavailable");
    assert.equal(extract.extractSingleReadPath("cat a.ts"), undefined);
  });
});
