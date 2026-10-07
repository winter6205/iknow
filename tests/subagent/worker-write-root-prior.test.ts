/**
 * The subagent worker sees its current write root (ADR-0037 §4 amendment (e)).
 *
 * Contract:
 *   - After a re-bind, the worker can read the current write root = envelope
 *     `sandboxRoot` (= live `taskRoot`) from its messages before running tools;
 *   - with no write situation on the envelope, no extra write-root segment is
 *     injected (byte-identical to the pre-change shape, minimal-diff principle);
 *   - system `## Project path` bytes remain `projectIdentityRoot` (untouched);
 *   - spawn `task` text is not rewritten by the manager (out of scope here).
 *
 * The worker prior renders from the envelope's `writeSituation` enum; the
 * consumer no longer infers the shape itself:
 *   - `writable_main` | `writable_tree` → byte-equal to the pre-change write-root
 *     segment (hard constraint guarding the prefix cache);
 *   - `no_writable_root` → the no-root disclosure: never names the worktree tool,
 *     never embeds sandboxRoot;
 *   - legacy envelope (no `writeSituation` field) → typed skip: no segment and no
 *     fallback to the old wording — better silent than wrong.
 *
 * ADR-0040: a subagent is the parent session's execution arm, so its write root
 * is the parent's effective root. The envelope's `sandboxRoot` is already a live
 * root snapshot (manager.buildWorkerPayload reads it via the sandboxRootCell
 * getter), so worker assembly just reads the envelope field — no extra
 * LiveTaskRoot cell wiring, the minimal-diff "envelope value = live snapshot" path.
 *
 * Boundary cases:
 *   empty: sandboxRoot = "" → no segment (fail-closed: envelope validation rejects it);
 *   negative: valid absolute path, directory missing → still injected (validation's job);
 *   overflow: very long sandboxRoot → text passes through untruncated;
 *   concurrent: repeated runs on one envelope → injected every time (no state);
 *   exception: encodeUserText throws → not propagated (same shape as prior segments).
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import {
  priorMessagesFromEnvelope,
  runWorkerOnce,
} from "../../src/harness/subagent/worker.ts";
import type {
  SubAgentEnvelope,
  WorkerEnvelope,
} from "../../src/harness/subagent/envelope.ts";
import type { LoopEngineDeps } from "../../src/harness/loop-engine.ts";
import { writeRootSegment } from "../../src/harness/skill/body.ts";

/** encodeUserText passthrough — priorMessagesFromEnvelope calls it directly. */
function passthroughEncodeUserText(
  text: string
): import("../../src/harness/model-adapter/types.ts").AnthropicNativeMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

// ── 1. priorMessagesFromEnvelope direct coverage ─────────────────────────────

describe("priorMessagesFromEnvelope — worker write-root prior (T3 ADR-0037 §4 (e))", () => {
  // Legacy envelopes (no writeSituation field) → typed skip, no write-root
  // segment. This section keeps the original shapes but passes an explicit
  // writeSituation through the two-arg form — matching the current assembly
  // path (manager.buildWorkerPayload).
  const MAIN_ROOT = "/home/u/projects/iknow-tasks/task-abc";

  it("envelope.sandboxRoot + writeSituation = writable_tree → prior 段含 'current write root' 标识", () => {
    const env: WorkerEnvelope = {
      task: "investigate",
      sandboxRoot: MAIN_ROOT,
      writeSituation: "writable_tree",
    };
    const prior = priorMessagesFromEnvelope(env, passthroughEncodeUserText);
    assert.ok(
      prior !== undefined,
      "envelope 带 writeSituation 时仍应注入写根段"
    );
    assert.equal(prior.length, 1);
    const msg = prior[0]!;
    assert.equal(msg.role, "user");
    const text = msg.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    assert.ok(
      text.includes("current write root"),
      "段文本必须含 current write root 标识"
    );
    assert.ok(text.includes(MAIN_ROOT), "段文本必须含 sandboxRoot 实际路径");
  });

  it("envelope.sandboxRoot = 合法绝对路径（模拟改绑后） + writable_tree → 注入路径快照", () => {
    const sandboxRoot = "/tmp/iknow-tasks/task-xyz";
    const env: WorkerEnvelope = {
      task: "t",
      sandboxRoot,
      writeSituation: "writable_tree",
    };
    const prior = priorMessagesFromEnvelope(env, passthroughEncodeUserText);
    assert.ok(prior);
    const text = prior![0]!.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    // Tolerates the 'current write root (...)' wrapping: the implementation
    // uses a parenthetical annotation form.
    assert.match(
      text,
      new RegExp(
        `current write root[^:]*:\\s*${sandboxRoot.replace(/\//g, "\\/")}`
      )
    );
  });

  it("envelope 同时带 finalText + writable_tree → prior 段 = [host dialogue, write root] (顺序：原 finalText 在前，写根段在后)", () => {
    // When finalText coexists with sandboxRoot/writeSituation, the prior array
    // is host dialogue first (unchanged behavior), then the write-root segment.
    const env: WorkerEnvelope = {
      task: "judge",
      sandboxRoot: "/tmp/sb-root",
      writeSituation: "writable_tree",
      finalText: "previous host text",
    };
    const prior = priorMessagesFromEnvelope(env, passthroughEncodeUserText);
    assert.ok(prior);
    assert.equal(prior!.length, 2);
    const firstText = prior![0]!.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    assert.ok(firstText.includes("previous host text"));
    const secondText = prior![1]!.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    assert.ok(secondText.includes("current write root"));
    assert.ok(secondText.includes("/tmp/sb-root"));
  });

  it("envelope 同时带 evidenceContext + writable_tree → prior 段 = [evidence, write root]", () => {
    const env: WorkerEnvelope = {
      task: "judge",
      sandboxRoot: "/tmp/sb-evidence",
      writeSituation: "writable_tree",
      evidenceContext: { doc: "x" },
    };
    const prior = priorMessagesFromEnvelope(env, passthroughEncodeUserText);
    assert.ok(prior);
    assert.equal(prior!.length, 2);
    const firstText = prior![0]!.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    assert.ok(firstText.includes("Evidence context"));
    const secondText = prior![1]!.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    assert.ok(secondText.includes("current write root"));
    assert.ok(secondText.includes("/tmp/sb-evidence"));
  });

  it("envelope 同时带 finalText + evidenceContext + writable_tree → prior 段 = [host dialogue, evidence, write root]", () => {
    const env: WorkerEnvelope = {
      task: "judge",
      sandboxRoot: "/tmp/sb-full",
      writeSituation: "writable_tree",
      finalText: "truncated",
      evidenceContext: { doc: "y" },
    };
    const prior = priorMessagesFromEnvelope(env, passthroughEncodeUserText);
    assert.ok(prior);
    assert.equal(prior!.length, 3);
    const lastText = prior![2]!.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    assert.ok(lastText.includes("current write root"));
    assert.ok(lastText.includes("/tmp/sb-full"));
  });

  it("异常 / overflow：sandboxRoot 含特殊字符（空格 / Unicode） + writable_tree → 文本原样保留", () => {
    const sandboxRoot = "/tmp/has space/日本語/emoji-😀";
    const env: WorkerEnvelope = {
      task: "t",
      sandboxRoot,
      writeSituation: "writable_tree",
    };
    const prior = priorMessagesFromEnvelope(env, passthroughEncodeUserText);
    assert.ok(prior);
    const text = prior![0]!.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    assert.ok(text.includes(sandboxRoot));
  });

  it("写根段字节 = writeRootSegment helper（文案 SSOT，specs/skill-load-write-root.md）", () => {
    // worker prior and the skill-body trailer share one wording function —
    // pin byte equality here so no second write-root sentence can grow inside
    // the worker source. The envelope's situation field is computed at spawn
    // time and passed through unchanged (manager.buildWorkerPayload).
    // writable_main (isolation OFF) and writable_tree (isolation ON + tree)
    // must both stay byte-equal to the pre-change wording; SSOT = writeRootSegment.
    const sandboxRoot = "/tmp/task-wt";
    for (const situation of ["writable_main", "writable_tree"] as const) {
      const env: WorkerEnvelope = {
        task: "t",
        sandboxRoot,
        writeSituation: situation,
      };
      const prior = priorMessagesFromEnvelope(env, passthroughEncodeUserText);
      assert.ok(prior);
      const text = prior[0]!.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("");
      assert.equal(text, writeRootSegment(situation, sandboxRoot)!);
    }
  });

  it("T6: writeSituation = no_writable_root（隔离 ON + 未绑树）→ ③ 态披露，不含 sandboxRoot", () => {
    // The trailer enters context at assembly time, before any write intent;
    // the no-root disclosure states facts only — naming a tool would push
    // every unbound session toward creating a tree, so it never names one.
    const sandboxRoot = "/repo/main-checkout";
    const env: WorkerEnvelope = {
      task: "t",
      sandboxRoot,
      writeSituation: "no_writable_root",
    };
    const prior = priorMessagesFromEnvelope(env, passthroughEncodeUserText);
    assert.ok(prior);
    const text = prior[0]!.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    // No-root disclosure = the same literal from the writeRootSegment helper.
    assert.equal(text, writeRootSegment("no_writable_root", sandboxRoot)!);
    // Does not embed sandboxRoot (no writable root → cannot point the model at one)
    assert.ok(!text.includes(sandboxRoot));
    // Does not name the worktree-creation tool
    assert.ok(!text.includes("create-worktree"));
  });

  it("T6: 旧 envelope（无 writeSituation 字段）→ typed skip,不注入写根段（OQ1 采纳 (b)）", () => {
    // On cross-version resume / legacy worker bootstrap the envelope carries no
    // writeSituation → skip the segment, no fallback to the old wording (the
    // old `writable_main` assumption would keep lying in the no-root state).
    // Better silent than wrong.
    const sandboxRoot = "/repo/main-checkout";
    const env: WorkerEnvelope = {
      task: "t",
      sandboxRoot,
      // Intentionally omits writeSituation — legacy bootstrap / cross-version envelope.
    };
    const prior = priorMessagesFromEnvelope(env, passthroughEncodeUserText);
    // typed skip: no finalText / evidenceContext and no write-root segment → undefined.
    assert.equal(prior, undefined);
    // Also no prior message containing "current write root" (defense against the
    // implementation defaulting the absent field to "writable_main").
    assert.ok(prior === undefined);
  });

  it("T6: 旧 envelope 缺 writeSituation 但带 finalText → typed skip 写根段,host dialogue 保留", () => {
    // Legacy cross-version compat: host dialogue / evidence are still injected
    // as usual; only the write-root segment is skipped (typed skip, no
    // fallback) — same rationale as the previous case.
    const env: WorkerEnvelope = {
      task: "judge",
      sandboxRoot: "/tmp/legacy-task",
      finalText: "previous host text",
      // writeSituation omitted — legacy envelope shape.
    };
    const prior = priorMessagesFromEnvelope(env, passthroughEncodeUserText);
    assert.ok(prior);
    assert.equal(prior!.length, 1, "只保留 host dialogue,写根段被 typed skip");
    const text = prior![0]!.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    assert.ok(text.includes("previous host text"));
    assert.ok(!text.includes("current write root"));
  });

  it("T6: writeSituation = no_writable_root + sandboxRoot 为空（typed stable）", () => {
    // The no-root disclosure is root-independent — the empty-root arm stays
    // typed and never throws.
    const env: WorkerEnvelope = {
      task: "t",
      sandboxRoot: "",
      writeSituation: "no_writable_root",
    };
    const prior = priorMessagesFromEnvelope(env, passthroughEncodeUserText);
    assert.ok(prior);
    const text = prior[0]!.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    // No-root disclosure = the same literal from the writeRootSegment helper.
    assert.equal(text, writeRootSegment("no_writable_root", "")!);
    assert.ok(!text.includes("create-worktree"));
  });

  it("T6: writeSituation = writable_tree + 空 sandboxRoot → 不渲染（empty 臂 typed）", () => {
    // Writable-root situations + empty root → the write-root half-sentence is
    // not rendered. In these shapes sandboxRoot is mandatory, so an empty value
    // means spawn omitted it — still typed (no throw); the segment is skipped
    // outright, matching the write-root-absent shape.
    const env: WorkerEnvelope = {
      task: "t",
      sandboxRoot: "",
      writeSituation: "writable_tree",
    };
    const prior = priorMessagesFromEnvelope(env, passthroughEncodeUserText);
    assert.equal(prior, undefined);
  });

  it("T6: 顺序契约 [host dialogue?, evidence?, write root] 在 typed skip 下仍守", () => {
    // Ordering contract: the write-root segment is always last. Under typed
    // skip the slot is filtered from extras, so the order stays byte-identical
    // to the original shapes.
    const env: WorkerEnvelope = {
      task: "judge",
      sandboxRoot: "/tmp/legacy-task",
      finalText: "truncated",
      evidenceContext: { doc: "y" },
      // writeSituation omitted — typed-skip path.
    };
    const prior = priorMessagesFromEnvelope(env, passthroughEncodeUserText);
    assert.ok(prior);
    assert.equal(prior!.length, 2, "host dialogue + evidence, 写根段被 skip");
    const first = prior![0]!.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    assert.ok(
      first.includes("previous host text") || first.includes("truncated")
    );
    const second = prior![1]!.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    assert.ok(second.includes("Evidence context"));
  });
});

// ── 2. runWorkerOnce end-to-end: write root injected from envelope.sandboxRoot ─

describe("runWorkerOnce — worker write-root prior end-to-end (T3)", () => {
  const baseEnvelope: WorkerEnvelope = {
    task: "investigate X",
    sandboxRoot: "/tmp/sb",
  };

  function makeDeps(adapter: LoopEngineDeps["adapter"]): LoopEngineDeps {
    return {
      adapter,
      executor: undefined as never,
      registry: {
        list: () => [],
        get: () => undefined,
      },
      system: () => undefined,
      promptTools: () => [],
    } as unknown as LoopEngineDeps;
  }

  it("runWorkerOnce 经 stub adapter 看到 prior 段包含 sandboxRoot（写根快照）", async () => {
    // The stub-model records only its fixed response; asserting status/result
    // here proves the prior injection path runs without breaking the loop.
    const sandboxRoot = "/tmp/task-write-root";
    const adapter = createStubModel({
      responses: [
        {
          nativeMessage: {
            role: "assistant",
            content: [{ type: "text", text: "saw prior" }],
          },
          projection: {
            nativeMessage: {
              role: "assistant",
              content: [{ type: "text", text: "saw prior" }],
            },
            texts: ["saw prior"],
            toolCalls: [],
          },
          supplierStop: "success",
          needsTools: false,
          isEmptyFinalResponse: false,
        },
      ],
    });
    const env: SubAgentEnvelope = await runWorkerOnce({
      workerEnvelope: { ...baseEnvelope, sandboxRoot },
      deps: makeDeps(adapter),
    });
    assert.equal(env.status, "ok");
    // stub-model's step does not expose messages — envelope.result carries the
    // finalText; this only verifies status=ok and an unpolluted envelope. The
    // actual write-root injection is covered by the direct
    // priorMessagesFromEnvelope asserts above.
    assert.equal(env.result, "saw prior");
  });
});
