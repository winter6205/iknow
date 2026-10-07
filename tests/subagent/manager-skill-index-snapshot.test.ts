/**
 * Parent-side wiring (`specs/skill-index-increment.md` SC10): at spawn time,
 * drop the parent session's **current** full model-index snapshot into the worker envelope.
 *
 * Contract:
 *   - `opts.skillIndexSnapshot` is a getter **read fresh per spawn** — the
 *     parent's index entry history grows over the session, so "at spawn time"
 *     only holds with a fresh read (same shape as `sandboxRootCell`, not a
 *     value frozen at manager construction);
 *   - getter absent / returns `undefined` → **no** such key on the envelope →
 *     the worker falls back to its own independent rescan (old wire /
 *     directly-constructed manager paths byte-identical);
 *   - returns `[]` → key **present** as an empty array — "the parent really
 *     has no model index" and "nobody supplied a snapshot" are two different
 *     facts (the worker renders `No skills installed` vs. its own scan result
 *     separately). An empty array is distinguishable in JSON: `"skillIndexSnapshot":[]`;
 *   - elements go over the wire as `{name, description?}` only: the rendering
 *     SSOT is `skillsSegment` worker-side; the parent does not pre-render text (avoiding two renderers).
 *
 * Isolation: real tmp dir as sandboxRoot anchor; spawn uses a fake child, no
 * real subprocess (same style as manager-todo-ledger.test.ts).
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "vitest";

import { createSubAgentManager } from "../../src/harness/subagent/manager.ts";
import type { SubAgentDefinition } from "../../src/harness/subagent/manager.ts";
import {
  WORKER_SCHEMA,
  parseWorkerEnvelope,
} from "../../src/harness/subagent/envelope.ts";
import type {
  SkillIndexSnapshotEntry,
  WorkerEnvelope,
} from "../../src/harness/subagent/envelope.ts";

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "iknow-mgr-skill-index-"));
});

function makeFakeChild(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  }) as unknown as ChildProcess;
}

interface CapturedSpawn {
  readonly def: SubAgentDefinition;
  readonly payload: WorkerEnvelope;
}

function makeManagerCapturingPayload(opts: {
  // The seam hands the getter this spawn's parent-session anchor, exactly like
  // `CreateSubAgentManagerOptions.skillIndexSnapshot`.
  readonly skillIndexSnapshot?: (
    conversationId: string | undefined
  ) => readonly SkillIndexSnapshotEntry[] | undefined;
  readonly parentSandboxRoot: string;
}): {
  readonly manager: ReturnType<typeof createSubAgentManager>;
  readonly calls: CapturedSpawn[];
} {
  const calls: CapturedSpawn[] = [];
  const manager = createSubAgentManager({
    spawn: (def, _taskId, payload) => {
      calls.push({ def, payload });
      return makeFakeChild();
    },
    sandboxRoot: opts.parentSandboxRoot,
    ...(opts.skillIndexSnapshot !== undefined
      ? { skillIndexSnapshot: opts.skillIndexSnapshot }
      : {}),
  });
  return { manager, calls };
}

const ENTRY: SkillIndexSnapshotEntry = {
  name: "frozen-a",
  description: "开场冻表条目",
};

describe("buildWorkerPayload — T7 父会话模型索引快照落线（SC10）", () => {
  it("getter 在场 → envelope.skillIndexSnapshot === 当时快照（JSON 可往返）", () => {
    const { manager, calls } = makeManagerCapturingPayload({
      skillIndexSnapshot: () => [
        ENTRY,
        { name: "injected-b", description: "已进场" },
      ],
      parentSandboxRoot: tempRoot,
    });
    manager.spawn({ task: "carry the parent index" });
    const payload = calls[0]!.payload;
    assert.deepEqual(payload.skillIndexSnapshot, [
      ENTRY,
      { name: "injected-b", description: "已进场" },
    ]);
    // Cross-process boundary (worker is a child process): the envelope must survive one JSON round trip verbatim.
    const roundTripped = parseWorkerEnvelope(JSON.stringify(payload));
    assert.deepEqual(
      roundTripped.skillIndexSnapshot,
      payload.skillIndexSnapshot
    );
  });

  it("getter 每次 spawn 现读 —— 第二次 spawn 拿到增长后的快照（「当时」语义）", () => {
    // First spawn sees only the opening frozen-table entry; after the parent
    // session incrementally admits more, the second spawn's snapshot must
    // contain the new name. A construction-time-frozen implementation goes red
    // here (both spawns would only have frozen-a).
    let ledger: SkillIndexSnapshotEntry[] = [ENTRY];
    const { manager, calls } = makeManagerCapturingPayload({
      skillIndexSnapshot: () => ledger,
      parentSandboxRoot: tempRoot,
    });
    manager.spawn({ task: "first" });
    ledger = [...ledger, { name: "injected-b", description: "中途进场" }];
    manager.spawn({ task: "second" });

    assert.deepEqual(
      calls[0]!.payload.skillIndexSnapshot?.map((e) => e.name),
      ["frozen-a"]
    );
    assert.deepEqual(
      calls[1]!.payload.skillIndexSnapshot?.map((e) => e.name),
      ["frozen-a", "injected-b"]
    );
    // The already-written envelope is not rewritten by later growth (the snapshot is a value, not a reference alias).
    assert.equal(calls[0]!.payload.skillIndexSnapshot?.length, 1);
  });

  it("getter 收到该 spawn 的父会话锚 —— 两个会话各拿各的进场史（serve 共用一台 manager）", () => {
    // Entry history is a per-session leaf, while the manager is shared across
    // sessions via build-engine. Pinning conversationId at assembly time would
    // hand both sessions the same history.
    const seen: Array<string | undefined> = [];
    const byConv: Record<string, SkillIndexSnapshotEntry[]> = {
      "conv-A": [ENTRY, { name: "only-in-A" }],
      "conv-B": [ENTRY],
    };
    const { manager, calls } = makeManagerCapturingPayload({
      skillIndexSnapshot: (conversationId) => {
        seen.push(conversationId);
        return conversationId === undefined
          ? undefined
          : byConv[conversationId];
      },
      parentSandboxRoot: tempRoot,
    });

    manager.spawn({ task: "in A", conversationId: "conv-A" });
    manager.spawn({ task: "in B", conversationId: "conv-B" });

    // The anchor is passed through per spawn (not a construction-time frozen value).
    assert.deepEqual(seen, ["conv-A", "conv-B"]);
    assert.deepEqual(
      calls[0]!.payload.skillIndexSnapshot?.map((e) => e.name),
      ["frozen-a", "only-in-A"]
    );
    assert.deepEqual(
      calls[1]!.payload.skillIndexSnapshot?.map((e) => e.name),
      ["frozen-a"],
      "B 会话不得看见 A 会话的进场史"
    );
  });

  it("def 无会话锚 → getter 收到 undefined 且可据它省键（无锚 = 无从谈该会话的史）", () => {
    const { manager, calls } = makeManagerCapturingPayload({
      skillIndexSnapshot: () => undefined,
      parentSandboxRoot: tempRoot,
    });
    manager.spawn({ task: "unanchored" });
    assert.ok(!("skillIndexSnapshot" in calls[0]!.payload));
  });

  it("getter 缺席 → 键缺席（旧 wire / manager 直造路径逐字节不变）", () => {
    const { manager, calls } = makeManagerCapturingPayload({
      parentSandboxRoot: tempRoot,
    });
    manager.spawn({ task: "no snapshot" });
    assert.ok(
      !("skillIndexSnapshot" in calls[0]!.payload),
      "getter 缺席时不得落一个空数组冒充快照"
    );
  });

  it("getter 返回 undefined → 键缺席（与 getter 缺席同形）", () => {
    const { manager, calls } = makeManagerCapturingPayload({
      skillIndexSnapshot: () => undefined,
      parentSandboxRoot: tempRoot,
    });
    manager.spawn({ task: "unknown snapshot" });
    assert.ok(!("skillIndexSnapshot" in calls[0]!.payload));
  });

  it("getter 返回 [] → 键在场且为空数组（「父无模型索引」≠「没人给快照」）", () => {
    const { manager, calls } = makeManagerCapturingPayload({
      skillIndexSnapshot: () => [],
      parentSandboxRoot: tempRoot,
    });
    manager.spawn({ task: "empty index" });
    assert.deepEqual(calls[0]!.payload.skillIndexSnapshot, []);
    assert.ok("skillIndexSnapshot" in calls[0]!.payload);
  });
});

describe("WORKER_SCHEMA.skillIndexSnapshot — wire 冻结形态（additive, optional）", () => {
  const properties = (WORKER_SCHEMA as { properties: Record<string, unknown> })
    .properties;

  it("字段已声明（additionalProperties:false 下新字段必须显式声明）", () => {
    assert.ok(properties["skillIndexSnapshot"], "字段在 WORKER_SCHEMA 里");
    assert.equal(
      (WORKER_SCHEMA as { additionalProperties: boolean }).additionalProperties,
      false,
      "additionalProperties:false 保持"
    );
  });

  it("旧 envelope（无此字段）仍被接受 → 解析后字段 undefined（worker 走自有退路）", () => {
    const env = parseWorkerEnvelope(
      JSON.stringify({ task: "x", sandboxRoot: "/tmp/sb" })
    );
    assert.equal(env.skillIndexSnapshot, undefined);
  });

  it("元素 schema 锁 name（必填、非空）+ description（可选）+ 不收额外键", () => {
    const entrySchema = properties["skillIndexSnapshot"] as {
      readonly type?: string;
      readonly items?: {
        readonly type?: string;
        readonly required?: ReadonlyArray<string>;
        readonly additionalProperties?: boolean;
        readonly properties?: Record<string, { readonly minLength?: number }>;
      };
    };
    assert.equal(entrySchema.type, "array");
    assert.equal(entrySchema.items?.type, "object");
    assert.deepEqual(
      [...(entrySchema.items?.required ?? [])].sort(),
      ["name"],
      "description 可选（降档后的条目就是裸名行）"
    );
    assert.equal(entrySchema.items?.additionalProperties, false);
    assert.equal(entrySchema.items?.properties?.["name"]?.minLength, 1);
  });

  it("空 name → ajv 拒收（minLength:1：裸名行仍必须有名字）", () => {
    const json = JSON.stringify({
      task: "x",
      sandboxRoot: "/tmp/sb",
      skillIndexSnapshot: [{ name: "", description: "d" }],
    });
    assert.throws(() => parseWorkerEnvelope(json));
  });

  it("条目多带键 → ajv 拒收（枚举不出第二套字段）", () => {
    const json = JSON.stringify({
      task: "x",
      sandboxRoot: "/tmp/sb",
      skillIndexSnapshot: [{ name: "a", description: "d", dir: "/x" }],
    });
    assert.throws(() => parseWorkerEnvelope(json));
  });

  it("非数组 / 元素非对象 → ajv 拒收", () => {
    for (const bogus of ["a", { name: "a" }, [123], [null]]) {
      const json = JSON.stringify({
        task: "x",
        sandboxRoot: "/tmp/sb",
        skillIndexSnapshot: bogus,
      });
      assert.throws(() => parseWorkerEnvelope(json), String(bogus));
    }
  });
});
