/**
 * T7 (`specs/skill-index-increment.md` / SC10 + assumption 7) — 父侧接线：
 * spawn 期把父会话**当时**的完整模型索引快照落进 worker envelope。
 *
 * 契约：
 *   - `opts.skillIndexSnapshot` 是**每次 spawn 现读**的 getter —— 父的索引进场史
 *     随会话增长，「spawn 当时」只有现读才成立（与 `sandboxRootCell` 同形态，
 *     不是 manager 构造期的冻结值）；
 *   - getter 缺席 / 返回 `undefined` → envelope **无**该键 → worker 退回自己的
 *     独立 rescan（旧 wire / manager 直造路径逐字节不变）；
 *   - 返回 `[]` → 键**在场**且为空数组 —— 「父确实没有模型索引」与「没人给
 *     快照」是两件事（worker 侧分别渲染 `No skills installed` 与自己的扫描
 *     结果）。空数组在 JSON 里是可分辨的：`"skillIndexSnapshot":[]`；
 *   - 元素只走 wire 面 `{name, description?}`：渲染 SSOT 在 worker 侧的
 *     `skillsSegment`，父不预渲染文本（避免两套渲染）。
 *
 * Isolation: 真实 tmp 目录做 sandboxRoot 锚点；spawn 用 fake child，无真实
 * 子进程（与 manager-todo-ledger.test.ts 同款）。
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
  readonly skillIndexSnapshot?: () =>
    readonly SkillIndexSnapshotEntry[] | undefined;
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
    // 跨进程边界（worker 是子进程）：信封必须能原样过 JSON 一趟。
    const roundTripped = parseWorkerEnvelope(JSON.stringify(payload));
    assert.deepEqual(
      roundTripped.skillIndexSnapshot,
      payload.skillIndexSnapshot
    );
  });

  it("getter 每次 spawn 现读 —— 第二次 spawn 拿到增长后的快照（「当时」语义）", () => {
    // 第一次 spawn 只有开场冻表名；父会话中途增量进场后，第二次 spawn 的快照
    // 必须含新名。构造期冻结的实现会在这里红（两次都只有 frozen-a）。
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
    // 先落线的信封不被后续增长改写（快照是值，不是引用别名）。
    assert.equal(calls[0]!.payload.skillIndexSnapshot?.length, 1);
  });

  it("getter 收到该 spawn 的父会话锚 —— 两个会话各拿各的进场史（serve 共用一台 manager）", () => {
    // 进场史是 per-session 叶子，而 manager 随 build-engine 跨会话共享。
    // 若把 conversationId 钉进装配期，两个会话会拿到同一份史。
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

    // 锚逐 spawn 透传（不是构造期的冻结值）。
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
