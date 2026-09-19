import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { ProtocolError } from "../../src/harness/errors.ts";
import {
  PARENT_SCHEMA,
  parseParentEnvelope,
  parseWorkerEnvelope,
  projectParentVisibleEnvelope,
  truncateEnvelopeResult,
} from "../../src/harness/subagent/envelope.ts";
import type {
  SubAgentEnvelope,
  WorkerEnvelope,
} from "../../src/harness/subagent/envelope.ts";

describe("subagent envelope schema (SC13 / D1)", () => {
  it("parses a valid worker request (parent → child)", () => {
    const env = parseWorkerEnvelope(
      JSON.stringify({
        task: "investigate X",
        systemPrompt: "be concise",
        disallowedTools: ["edit_file"],
        model: "opus",
        maxTurns: 5,
        timeoutMs: 30000,
        sandboxRoot: "/tmp/sb",
        env: { FOO: "bar" },
      })
    );
    assert.equal(env.task, "investigate X");
    assert.equal(env.systemPrompt, "be concise");
    assert.deepEqual(env.disallowedTools, ["edit_file"]);
    assert.equal(env.model, "opus");
    assert.equal(env.maxTurns, 5);
    assert.equal(env.timeoutMs, 30000);
    assert.equal(env.sandboxRoot, "/tmp/sb");
    assert.deepEqual(env.env, { FOO: "bar" });
  });

  it("parses a minimal worker request (only required fields)", () => {
    const env = parseWorkerEnvelope(
      JSON.stringify({ task: "minimal", sandboxRoot: "/tmp/sb" })
    );
    assert.equal(env.task, "minimal");
    assert.equal(env.sandboxRoot, "/tmp/sb");
    assert.equal(env.maxTurns, undefined);
  });

  it("throws ProtocolError when a required worker field is missing (task)", () => {
    assert.throws(
      () => parseWorkerEnvelope(JSON.stringify({ sandboxRoot: "/tmp/sb" })),
      ProtocolError
    );
  });

  it("throws ProtocolError when a required worker field is missing (sandboxRoot)", () => {
    assert.throws(
      () => parseWorkerEnvelope(JSON.stringify({ task: "no root" })),
      ProtocolError
    );
  });

  it("throws ProtocolError on wrong field type (task: 123)", () => {
    assert.throws(
      () =>
        parseWorkerEnvelope(
          JSON.stringify({ task: 123, sandboxRoot: "/tmp/sb" })
        ),
      ProtocolError
    );
  });

  it("throws ProtocolError on non-object input (bare string)", () => {
    assert.throws(() => parseWorkerEnvelope('"just a string"'), ProtocolError);
  });

  it("throws ProtocolError on non-object input (array)", () => {
    assert.throws(() => parseWorkerEnvelope("[1, 2, 3]"), ProtocolError);
  });

  it("throws ProtocolError on invalid JSON", () => {
    assert.throws(() => parseWorkerEnvelope("{not json"), ProtocolError);
  });

  it("parses a valid line with a trailing newline", () => {
    const env = parseWorkerEnvelope(
      JSON.stringify({ task: "trailing", sandboxRoot: "/tmp/sb" }) + "\n"
    );
    assert.equal(env.task, "trailing");
  });

  it("multi-newline input parses by the first standalone JSON", () => {
    const first = JSON.stringify({ task: "first", sandboxRoot: "/tmp/sb" });
    const second = JSON.stringify({ task: "second", sandboxRoot: "/tmp/sb" });
    const env = parseWorkerEnvelope(`${first}\n${second}`);
    assert.equal(env.task, "first");
  });

  it("parses a valid parent (child → parent) ok envelope", () => {
    const env = parseParentEnvelope(
      JSON.stringify({ status: "ok", summary: "s", result: "r" })
    );
    assert.equal(env.status, "ok");
    assert.equal(env.summary, "s");
    assert.equal(env.result, "r");
  });

  it("parses a failed parent envelope with reason", () => {
    const env = parseParentEnvelope(
      JSON.stringify({
        status: "failed",
        reason: "crashed",
        summary: "s",
        result: "r",
      })
    );
    assert.equal(env.status, "failed");
    assert.equal(env.reason, "crashed");
  });

  it("rejects an invalid status enum value", () => {
    assert.throws(
      () =>
        parseParentEnvelope(
          JSON.stringify({ status: "running", summary: "s", result: "r" })
        ),
      ProtocolError
    );
  });

  it("rejects an invalid reason enum value", () => {
    assert.throws(
      () =>
        parseParentEnvelope(
          JSON.stringify({
            status: "failed",
            reason: "exploded",
            summary: "s",
            result: "r",
          })
        ),
      ProtocolError
    );
  });

  it("throws ProtocolError when parent status is missing", () => {
    assert.throws(
      () => parseParentEnvelope(JSON.stringify({ summary: "s", result: "r" })),
      ProtocolError
    );
  });

  it("rejects additional unknown properties", () => {
    assert.throws(
      () =>
        parseParentEnvelope(
          JSON.stringify({
            status: "ok",
            summary: "s",
            result: "r",
            sneaky: true,
          })
        ),
      ProtocolError
    );
  });

  it("rejects a bare JSON array for the parent envelope", () => {
    assert.throws(
      () =>
        parseParentEnvelope(
          JSON.stringify([{ status: "ok", summary: "s", result: "r" }])
        ),
      ProtocolError
    );
  });
});

// ---------------------------------------------------------------------------
// ADR-0085 / SC9: todoLedger wire 字段（父会话账本锚点）
//
// `additionalProperties: false` 下新字段必须显式声明,否则 ajv 把带字段的
// envelope 判成 ProtocolError。旧 envelope（缺此字段）必须继续被接受 ——
// 与 role / writeSituation 同形态的 wire-additive 纪律。
// ---------------------------------------------------------------------------

describe("WorkerEnvelope.todoLedger (ADR-0085 / SC9)", () => {
  it("带完整锚点的 envelope 被接受,两字段原样透传", () => {
    const env = parseWorkerEnvelope(
      JSON.stringify({
        task: "work",
        sandboxRoot: "/tmp/sb",
        todoLedger: {
          projectDir: "/data/projects/repo-abc123",
          conversationId: "conv-parent",
        },
      })
    );
    assert.deepEqual(env.todoLedger, {
      projectDir: "/data/projects/repo-abc123",
      conversationId: "conv-parent",
    });
  });

  it("旧 envelope 缺 todoLedger → 接受且字段为 undefined(跨版本 resume 不退化)", () => {
    const env = parseWorkerEnvelope(
      JSON.stringify({ task: "legacy", sandboxRoot: "/tmp/sb" })
    );
    assert.equal(env.todoLedger, undefined);
  });

  it("锚点不完整(缺 conversationId)→ ProtocolError,不落半个 ledger 缝", () => {
    assert.throws(
      () =>
        parseWorkerEnvelope(
          JSON.stringify({
            task: "work",
            sandboxRoot: "/tmp/sb",
            todoLedger: { projectDir: "/data/projects/repo-abc123" },
          })
        ),
      ProtocolError
    );
  });

  it("锚点空串(projectDir: '')→ ProtocolError(minLength:1)", () => {
    assert.throws(
      () =>
        parseWorkerEnvelope(
          JSON.stringify({
            task: "work",
            sandboxRoot: "/tmp/sb",
            todoLedger: { projectDir: "", conversationId: "conv-parent" },
          })
        ),
      ProtocolError
    );
  });

  it("锚点含未声明子字段 → ProtocolError(additionalProperties:false)", () => {
    assert.throws(
      () =>
        parseWorkerEnvelope(
          JSON.stringify({
            task: "work",
            sandboxRoot: "/tmp/sb",
            todoLedger: {
              projectDir: "/p",
              conversationId: "c",
              canAdd: false,
            },
          })
        ),
      ProtocolError
    );
  });
});

describe("subagent envelope truncation (SC10)", () => {
  it("replaces a mid-size draft with the parent-visible short handoff", () => {
    const draft = "final draft body ".repeat(40);
    const env: SubAgentEnvelope = {
      status: "ok",
      summary: "changed the parser",
      result: draft,
      fileRefs: ["src/parser.ts"],
      stop_reason: "completed",
    };
    const out = projectParentVisibleEnvelope(env);
    assert.equal(out.status, "ok");
    assert.notEqual(out.result, draft);
    assert.match(out.result, /changed the parser/);
    assert.match(out.result, /src\/parser\.ts/);
    assert.match(out.result, /Stop reason: completed/);
    assert.equal(out.stop_reason, "completed");
  });

  it("folds a long success report into a short handoff with paths", () => {
    const long = "x".repeat(25000);
    const env: SubAgentEnvelope = {
      status: "ok",
      summary: long,
      result: long,
      fileRefs: ["src/changed.ts", "tests/changed.test.ts"],
      stop_reason: "completed",
    };
    const out = truncateEnvelopeResult(env);
    assert.equal(out.status, "ok");
    assert.equal(out.truncated, true);
    assert.equal(out.totalLength, 25000);
    assert.ok(out.summary.length < long.length);
    assert.ok(out.result.length < 20000);
    assert.notEqual(out.result, long);
    assert.match(out.result, /src\/changed\.ts/);
    assert.match(out.result, /tests\/changed\.test\.ts/);
    assert.match(out.result, /report folded/);
    assert.equal(out.stop_reason, "completed");
  });

  it("folding a failed report keeps its reason and non-empty summary", () => {
    const out = truncateEnvelopeResult({
      status: "failed",
      reason: "protocolError",
      summary: "protocol failure\n" + "x".repeat(25000),
      result: "x".repeat(25000),
    });
    assert.equal(out.status, "failed");
    assert.equal(out.reason, "protocolError");
    assert.ok(out.summary.length > 0);
    assert.equal(out.truncated, true);
  });

  it("failed envelope without a summary gets a parent-visible reason", () => {
    const out = truncateEnvelopeResult({
      status: "failed",
      reason: "maxTurnsExceeded",
      summary: "",
      result: "",
    });
    assert.equal(out.status, "failed");
    assert.equal(out.reason, "maxTurnsExceeded");
    assert.ok(out.summary.length > 0);
  });

  // ADR-0111 Decision 2: modelTransient = 上游瞬时可续失败,与 protocolError
  // (真协议损坏)、crashed(进程级异常死亡)在父可见文案面上必须可分辨,
  // 且给出 ADR-0102 Decision 1 的续跑出路(闸天然放行,文案引导)。
  it("empty-summary failed reason=modelTransient → 父可见文案含续跑引导 (ADR-0111/0102)", () => {
    const out = truncateEnvelopeResult({
      status: "failed",
      reason: "modelTransient",
      summary: "",
      result: "",
    });
    assert.equal(out.reason, "modelTransient");
    assert.match(out.summary, /modelTransient/);
    assert.match(out.summary, /subagent_continue/);
  });

  it("其它 reason 的父可见文案 byte-stable (只给 modelTransient 加引导)", () => {
    const protocol = truncateEnvelopeResult({
      status: "failed",
      reason: "protocolError",
      summary: "",
      result: "",
    });
    assert.equal(protocol.summary, "subagent failed: protocolError");
    const maxTurns = truncateEnvelopeResult({
      status: "failed",
      reason: "maxTurnsExceeded",
      summary: "",
      result: "",
    });
    assert.equal(maxTurns.summary, "subagent failed: maxTurnsExceeded");
  });

  it("exactly-20000 draft is still a short handoff, not the full body", () => {
    const env: SubAgentEnvelope = {
      status: "ok",
      summary: "s",
      result: "y".repeat(20000),
    };
    const out = projectParentVisibleEnvelope(env);
    assert.notEqual(out.result, env.result);
    assert.match(out.result, /^s/);
    assert.equal(out.truncated, true);
    assert.equal(out.totalLength, 20000);
  });
});

describe("subagent envelope types (SC2 field shape)", () => {
  it("WorkerEnvelope exposes optional camelCase fields", () => {
    const env: WorkerEnvelope = {
      task: "t",
      sandboxRoot: "/tmp/sb",
      systemPrompt: "p",
      disallowedTools: ["a"],
      model: "m",
      maxTurns: 3,
      timeoutMs: 1000,
      env: { K: "v" },
    };
    assert.equal(env.task, "t");
    assert.equal(env.sandboxRoot, "/tmp/sb");
  });

  it("SubAgentEnvelope exposes reason enum + truncation meta fields", () => {
    const env: SubAgentEnvelope = {
      status: "failed",
      summary: "s",
      result: "r",
      reason: "maxTurnsExceeded",
      truncated: true,
      totalLength: 25000,
    };
    assert.equal(env.reason, "maxTurnsExceeded");
    assert.equal(env.truncated, true);
  });
});

describe("parent-visible tmp locator (SC4)", () => {
  const locator = {
    task_id: "11111111-1111-4111-8111-111111111111",
    tmp_root:
      "/session/subagents/11111111-1111-4111-8111-111111111111/fence-tmp",
  };

  it("PARENT_SCHEMA declares task_id and tmp_root as non-empty strings", () => {
    const props = PARENT_SCHEMA.properties as Record<
      string,
      { type?: string; minLength?: number }
    >;
    assert.equal(props.task_id?.type, "string");
    assert.equal(props.task_id?.minLength, 1);
    assert.equal(props.tmp_root?.type, "string");
    assert.equal(props.tmp_root?.minLength, 1);
  });

  it("parses success and failure envelopes that carry task_id + tmp_root", () => {
    const ok = parseParentEnvelope(
      JSON.stringify({
        status: "ok",
        summary: "done",
        result: "done",
        ...locator,
      })
    );
    assert.equal(ok.task_id, locator.task_id);
    assert.equal(ok.tmp_root, locator.tmp_root);
    assert.ok(
      ok.product_roster === undefined || ok.product_roster.length === 0,
      "success path has no product roster (or empty)"
    );

    const failed = parseParentEnvelope(
      JSON.stringify({
        status: "failed",
        reason: "crashed",
        summary: "boom",
        result: "",
        ...locator,
      })
    );
    assert.equal(failed.task_id, locator.task_id);
    assert.equal(failed.tmp_root, locator.tmp_root);
  });

  it("rejects empty task_id or empty tmp_root", () => {
    assert.throws(
      () =>
        parseParentEnvelope(
          JSON.stringify({
            status: "ok",
            summary: "s",
            result: "r",
            task_id: "",
            tmp_root: locator.tmp_root,
          })
        ),
      ProtocolError
    );
    assert.throws(
      () =>
        parseParentEnvelope(
          JSON.stringify({
            status: "ok",
            summary: "s",
            result: "r",
            task_id: locator.task_id,
            tmp_root: "",
          })
        ),
      ProtocolError
    );
  });

  it("legacy envelopes without locator fields still parse", () => {
    const env = parseParentEnvelope(
      JSON.stringify({ status: "ok", summary: "s", result: "r" })
    );
    assert.equal(env.task_id, undefined);
    assert.equal(env.tmp_root, undefined);
  });

  it("projectParentVisibleEnvelope keeps non-empty locator on success and failure", () => {
    const ok = projectParentVisibleEnvelope({
      status: "ok",
      summary: "changed the parser",
      result: "draft body",
      ...locator,
    });
    assert.equal(ok.task_id, locator.task_id);
    assert.equal(ok.tmp_root, locator.tmp_root);
    assert.ok(
      ok.product_roster === undefined || ok.product_roster.length === 0
    );

    const failed = projectParentVisibleEnvelope({
      status: "failed",
      reason: "timeout",
      summary: "timeout after 1ms",
      result: "",
      ...locator,
    });
    assert.equal(failed.task_id, locator.task_id);
    assert.equal(failed.tmp_root, locator.tmp_root);
  });
});
