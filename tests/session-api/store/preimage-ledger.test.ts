/**
 * ADR-0036: preimage ledger — process-memory host accumulator.
 * Pins the consume-semantics invariant that keeps parallel write-waves correct:
 *   - consume returns ONLY the ids present in the passed iterable and removes
 *     exactly those (a batch commits one tool at a time; a later batch must
 *     still find its own pending id → the parallel-wave invariant)
 *   - a missing conversation / id → empty map, never throws
 *   - buckets isolated per conversationId; clear drops one conversation only
 * Plus the commit-side drain (`drainPreimageRefs`), the one shape all three
 * ledger owners share: it pulls exactly the batch's own tool_result ids and
 * reports "nothing pending" as undefined, never as an empty Map.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  createPreimageLedger,
  drainPreimageRefs,
} from "../../../src/session-api/store/preimage-ledger.ts";
import type { PreimageRef } from "../../../src/session-api/store/jsonl.ts";
import type { AnthropicNativeMessage } from "../../../src/harness/index.ts";

const ref = (sha: string, relPath = "a.ts"): PreimageRef => ({
  relPath,
  rootIdentity: "/root",
  preimageSha: sha,
  postimageSha: `${sha}-post`,
});

describe("createPreimageLedger", () => {
  it("(a) consume 只返回/移除传入 iterable 里的 id —— 平行 wave 不变式", () => {
    const ledger = createPreimageLedger();
    const conv = "c1";
    ledger.set(conv, "A", ref("shaA", "a.ts"));
    ledger.set(conv, "B", ref("shaB", "b.ts"));

    const first = ledger.consume(conv, ["A"]);
    // 只拿到 A, 且 A 携带正确 ref
    assert.deepEqual([...first.keys()], ["A"]);
    assert.deepEqual(first.get("A"), ref("shaA", "a.ts"));

    // B 必须仍在桶里, 后一批 consume 还能拿到 —— 平行 wave 的核心
    const second = ledger.consume(conv, ["B"]);
    assert.deepEqual([...second.keys()], ["B"]);
    assert.deepEqual(second.get("B"), ref("shaB", "b.ts"));

    // 两个都被取走后, 再 consume 空
    assert.equal(ledger.consume(conv, ["A", "B"]).size, 0);
  });

  it("consume iterable 里含未知 id 时只返回命中的子集", () => {
    const ledger = createPreimageLedger();
    ledger.set("c2", "X", ref("shaX"));
    const out = ledger.consume("c2", ["X", "Y", "Z"]);
    assert.deepEqual([...out.keys()], ["X"]);
  });

  it("(b) consume 不存在的 id → 空 Map, 不抛 (未知 conversation 也一样)", () => {
    const ledger = createPreimageLedger();
    assert.equal(ledger.consume("nope", ["missing"]).size, 0);
    ledger.set("present", "K", ref("shaK"));
    // 桶存在但 id 不在 → 空, 且不污染已存在的 K
    assert.equal(ledger.consume("present", ["absent"]).size, 0);
    assert.deepEqual([...ledger.consume("present", ["K"]).keys()], ["K"]);
  });

  it("(c) 桶按 conversationId 隔离 —— 一个 conv 的 id 不会被另一个 consume 到", () => {
    const ledger = createPreimageLedger();
    ledger.set("conv1", "shared_id", ref("sha1"));
    ledger.set("conv2", "shared_id", ref("sha2"));

    const fromConv2 = ledger.consume("conv2", ["shared_id"]);
    assert.deepEqual(fromConv2.get("shared_id"), ref("sha2"));
    // conv1 的同名 id 不受影响
    const fromConv1 = ledger.consume("conv1", ["shared_id"]);
    assert.deepEqual(fromConv1.get("shared_id"), ref("sha1"));
  });

  it("(d) clear(conv) 只丢该 conversation 的 pending, 其余 conversation 保留", () => {
    const ledger = createPreimageLedger();
    ledger.set("drop", "id1", ref("d1"));
    ledger.set("drop", "id2", ref("d2"));
    ledger.set("keep", "id3", ref("k3"));

    ledger.clear("drop");
    assert.equal(ledger.consume("drop", ["id1", "id2"]).size, 0);
    assert.deepEqual([...ledger.consume("keep", ["id3"]).keys()], ["id3"]);
  });

  it("同 (conv, toolUseId) 重复 set → 后写覆盖前写 (re-capture before commit)", () => {
    const ledger = createPreimageLedger();
    ledger.set("c", "same", ref("first"));
    ledger.set("c", "same", ref("second"));
    const out = ledger.consume("c", ["same"]);
    assert.deepEqual(out.get("same"), ref("second"));
  });
});

// -- drainPreimageRefs -------------------------------------------------------

const toolResult = (...toolUseIds: string[]): AnthropicNativeMessage =>
  ({
    role: "user",
    content: toolUseIds.map((id) => ({
      type: "tool_result",
      tool_use_id: id,
      content: "ok",
    })),
  }) as AnthropicNativeMessage;

describe("drainPreimageRefs", () => {
  it("pulls exactly the batch's own tool_result ids, leaving a later wave pending", () => {
    const ledger = createPreimageLedger();
    ledger.set("c1", "A", ref("shaA", "a.ts"));
    ledger.set("c1", "B", ref("shaB", "b.ts"));

    const drained = drainPreimageRefs(ledger, "c1", [toolResult("A")]);
    assert.deepEqual([...drained!.keys()], ["A"]);
    assert.deepEqual(drained!.get("A"), ref("shaA", "a.ts"));
    // B belongs to the next commit, not this one.
    assert.deepEqual(
      [...drainPreimageRefs(ledger, "c1", [toolResult("B")])!.keys()],
      ["B"]
    );
  });

  it("undefined ledger → undefined (capture disabled: append stays byte-identical)", () => {
    assert.equal(
      drainPreimageRefs(undefined, "c1", [toolResult("A")]),
      undefined
    );
  });

  it("a batch without tool_result blocks drains nothing and consumes nothing", () => {
    const ledger = createPreimageLedger();
    ledger.set("c1", "A", ref("shaA"));
    const text: AnthropicNativeMessage = {
      role: "user",
      content: [{ type: "text", text: "hello" }],
    };
    assert.equal(drainPreimageRefs(ledger, "c1", [text]), undefined);
    assert.deepEqual(
      [...drainPreimageRefs(ledger, "c1", [toolResult("A")])!.keys()],
      ["A"]
    );
  });

  it("string content is skipped, not thrown on (some adapters send plain strings)", () => {
    const ledger = createPreimageLedger();
    ledger.set("c1", "A", ref("shaA"));
    const plain = { role: "user", content: "raw" } as AnthropicNativeMessage;
    assert.equal(drainPreimageRefs(ledger, "c1", [plain]), undefined);
  });

  it("nothing pending for the batch's ids → undefined, not an empty Map", () => {
    const ledger = createPreimageLedger();
    ledger.set("c1", "OTHER", ref("shaOther"));
    assert.equal(
      drainPreimageRefs(ledger, "c1", [toolResult("A", "B")]),
      undefined
    );
    assert.deepEqual(
      [...drainPreimageRefs(ledger, "c1", [toolResult("OTHER")])!.keys()],
      ["OTHER"]
    );
  });
});
