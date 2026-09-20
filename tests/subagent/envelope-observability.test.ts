/**
 * Observability floor: `envelope.fileRefs` real writes + additive `stop_reason`.
 *
 * Covers three things:
 *   1. `deriveFileRefs` collects `path` from write-class tools' `tool_use` blocks in the authoritative history;
 *   2. `toOkEnvelope` / `toFailedEnvelope` set `stop_reason` (additive, not in
 *      the two frozen enums `status` / `reason`);
 *   3. `PARENT_SCHEMA` accepts envelopes carrying `stop_reason` (under
 *      `additionalProperties: false`, an undeclared field would be a ProtocolError).
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  deriveFileRefs,
  writeToolNamesFrom,
} from "../../src/harness/subagent/file-refs.ts";
import {
  toFailedEnvelope,
  toOkEnvelope,
} from "../../src/harness/subagent/worker.ts";
import { parseParentEnvelope } from "../../src/harness/subagent/envelope.ts";
import type {
  AnthropicNativeMessage,
  RunResult,
} from "../../src/harness/model-adapter/types.ts";
import type { AciCatalog, AciToolDef } from "../../src/harness/aci/types.ts";

function toolUse(name: string, input: unknown): AnthropicNativeMessage {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id: `tu_${name}`, name, input }],
  };
}

function fakeResult(opts: {
  readonly finalText?: string | null;
  readonly stopReason?: RunResult["stopReason"];
  readonly messages?: ReadonlyArray<AnthropicNativeMessage>;
}): RunResult {
  return {
    finalText: opts.finalText ?? "done",
    lastUsage: null,
    messages: opts.messages ?? [],
    stopReason: opts.stopReason ?? "completed",
    turnCount: 1,
  };
}

function fakeCatalog(defs: ReadonlyArray<AciToolDef>): AciCatalog {
  return Object.freeze({
    get: (name: string) => defs.find((d) => d.name === name),
    all: () => defs,
  });
}

function fakeToolDef(
  name: string,
  category: AciToolDef["aci"]["category"]
): AciToolDef {
  return {
    name,
    description: name,
    inputSchema: { type: "object" },
    aci: {
      category,
      isConcurrencySafe: true,
      interruptBehavior: "cancel",
      timeoutTier: "default",
    },
    handler: async () => "",
  } as unknown as AciToolDef;
}

describe("subagent observability floor: writeToolNamesFrom", () => {
  it("只收 category === write 的工具名（不硬编码名单）", () => {
    const names = writeToolNamesFrom(
      fakeCatalog([
        fakeToolDef("write_file", "write"),
        fakeToolDef("edit_file", "write"),
        fakeToolDef("read_file", "read-only"),
        fakeToolDef("bash", "execute"),
      ])
    );
    assert.deepEqual([...names].sort(), ["edit_file", "write_file"]);
  });
});

describe("subagent observability floor: deriveFileRefs", () => {
  const writeTools = new Set(["write_file", "edit_file"]);

  it("按首次出现顺序收 write 类工具的 input.path，去重", () => {
    const refs = deriveFileRefs(
      [
        toolUse("write_file", { path: "a.ts", content: "x" }),
        toolUse("read_file", { path: "never.ts" }),
        toolUse("edit_file", { path: "b.ts" }),
        toolUse("write_file", { path: "a.ts", content: "y" }),
      ],
      writeTools
    );
    assert.deepEqual(refs, ["a.ts", "b.ts"]);
  });

  it("形状异常（input 非对象 / path 非字符串 / 空串）跳过，不抛", () => {
    const refs = deriveFileRefs(
      [
        toolUse("write_file", null),
        toolUse("write_file", { path: 42 }),
        toolUse("write_file", { path: "" }),
        toolUse("edit_file", { path: "ok.ts" }),
      ],
      writeTools
    );
    assert.deepEqual(refs, ["ok.ts"]);
  });

  it("无写操作 → 空数组（调用方据此不落 fileRefs key）", () => {
    assert.deepEqual(deriveFileRefs([], writeTools), []);
  });
});

describe("subagent observability floor: envelope stop_reason (additive)", () => {
  it("toOkEnvelope 恒填 stop_reason，不动 status / reason 冻结枚举", () => {
    const env = toOkEnvelope(fakeResult({ stopReason: "completed" }));
    assert.equal(env.status, "ok");
    assert.equal(env.stop_reason, "completed");
    assert.equal(env.reason, undefined);
  });

  it("有 writeToolNames 且确有写路径 → fileRefs 落值", () => {
    const env = toOkEnvelope(
      fakeResult({ messages: [toolUse("write_file", { path: "x.ts" })] }),
      { writeToolNames: new Set(["write_file"]) }
    );
    assert.deepEqual(env.fileRefs, ["x.ts"]);
  });

  it("无派生源（缺 writeToolNames）→ 不写 fileRefs key（Postel）", () => {
    const env = toOkEnvelope(
      fakeResult({ messages: [toolUse("write_file", { path: "x.ts" })] })
    );
    assert.equal("fileRefs" in env, false);
  });

  it("toFailedEnvelope 的 extras 承载 stop_reason；缺省不写 key", () => {
    const withExtras = toFailedEnvelope("protocolError", "fused", {
      stop_reason: "fused",
    });
    assert.equal(withExtras.stop_reason, "fused");
    assert.equal(withExtras.reason, "protocolError");
    const bare = toFailedEnvelope("crashed");
    assert.equal("stop_reason" in bare, false);
  });
});

describe("subagent observability floor: PARENT_SCHEMA 收 stop_reason", () => {
  it("带 stop_reason 的信封能通过 parseParentEnvelope（不判 ProtocolError）", () => {
    const wire = JSON.stringify({
      status: "ok",
      summary: "s",
      result: "r",
      stop_reason: "completed",
      fileRefs: ["a.ts"],
    });
    const parsed = parseParentEnvelope(wire);
    assert.equal(parsed.stop_reason, "completed");
    assert.deepEqual(parsed.fileRefs, ["a.ts"]);
  });

  it("SC4: 带 task_id + tmp_root 的成功信封仍通过 parse（无 product_roster）", () => {
    const parsed = parseParentEnvelope(
      JSON.stringify({
        status: "ok",
        summary: "s",
        result: "r",
        stop_reason: "completed",
        task_id: "tid-obs",
        tmp_root: "/pad/fence-tmp",
      })
    );
    assert.equal(parsed.task_id, "tid-obs");
    assert.equal(parsed.tmp_root, "/pad/fence-tmp");
    assert.ok(
      parsed.product_roster === undefined || parsed.product_roster.length === 0
    );
  });
});
