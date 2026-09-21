/**
 * manager.buildWorkerPayload computes `writeSituation` at spawn time and
 * passes it through to the envelope.
 *
 * Acceptance:
 *   - `isolationOn: false` → writable_main (regardless of sandboxRoot shape;
 *     the negative arm pins this so shape detection is never used on its own —
 *     aligned with writeSituation.test.ts);
 *   - `isolationOn: true` + tree-shaped sandboxRoot → writable_tree;
 *   - `isolationOn: true` + non-tree sandboxRoot → no_writable_root;
 *   - `isolationOn: undefined` → defaults false (direct manager construction
 *     as in manager.test.ts makeHarness keeps byte-equal pre-change behavior);
 *   - pass-through field name = writeSituation, value is the tri-state enum
 *     literal (typed, not string).
 *
 * Assembly SSOT: the decision function is `writeSituation(isolationOn,
 * sandboxRoot)` (src/harness/isolation/write-situation.ts); manager only calls
 * it with the resolved sandboxRoot — no duplicated shape logic here.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "vitest";

import { createSubAgentManager } from "../../src/harness/subagent/manager.ts";
import type { SubAgentDefinition } from "../../src/harness/subagent/manager.ts";
import type { WorkerEnvelope } from "../../src/harness/subagent/envelope.ts";

// `isTaskWorktreePath` accepts the `<repo>/.iknow/worktrees/<convId>` shape.
// Use real tmp paths as parentSandboxRoot (realpath must resolve) to trigger
// the tree vs main-repo branches:
//   - `treePath`: real dir `<root>/.iknow/worktrees/<convId>` under the temp
//     root, hitting isTaskWorktreePath;
//   - `mainPath`: the temp root itself (not `.iknow/worktrees/...`), non-tree.

let tempRoot: string;
let mainPath: string;
let treePath: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "iknow-mgr-ws-"));
  // main-repo shape: tempRoot itself as sandboxRoot (not `.iknow/worktrees/<x>`).
  mainPath = tempRoot;
  // tree shape: <root>/.iknow/worktrees/convXXXX really exists.
  treePath = join(tempRoot, ".iknow", "worktrees", "convXXXX");
  mkdirSync(treePath, { recursive: true });
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
  readonly taskId: string;
  readonly payload: WorkerEnvelope;
}

function makeManagerCapturingPayload(opts: {
  readonly isolationOn?: boolean | (() => boolean);
  readonly parentSandboxRoot: string;
}): {
  readonly manager: ReturnType<typeof createSubAgentManager>;
  readonly calls: CapturedSpawn[];
} {
  const calls: CapturedSpawn[] = [];
  const manager = createSubAgentManager({
    spawn: (def, taskId, payload) => {
      const child = makeFakeChild();
      calls.push({ def, taskId, payload });
      return child;
    },
    sandboxRoot: opts.parentSandboxRoot,
    ...(opts.isolationOn !== undefined
      ? { isolationOn: opts.isolationOn }
      : {}),
  });
  return { manager, calls };
}

describe("buildWorkerPayload — writeSituation 透传", () => {
  it("isolationOn = false + 树形 sandboxRoot → writeSituation = writable_main", () => {
    // negative arm (aligned with writeSituation.test.ts): with isolation OFF,
    // even a tree-shaped sandbox root still reports writable_main, so the
    // shape check can never be used on its own.
    const { manager, calls } = makeManagerCapturingPayload({
      isolationOn: false,
      parentSandboxRoot: treePath,
    });
    manager.spawn({ task: "hello" });
    assert.equal(calls[0]!.payload.writeSituation, "writable_main");
  });

  it("isolationOn = false + 非树形 sandboxRoot → writeSituation = writable_main", () => {
    const { manager, calls } = makeManagerCapturingPayload({
      isolationOn: false,
      parentSandboxRoot: mainPath,
    });
    manager.spawn({ task: "hello" });
    assert.equal(calls[0]!.payload.writeSituation, "writable_main");
  });

  it("isolationOn = true + 树形 sandboxRoot → writeSituation = writable_tree", () => {
    const { manager, calls } = makeManagerCapturingPayload({
      isolationOn: true,
      parentSandboxRoot: treePath,
    });
    manager.spawn({ task: "hello" });
    assert.equal(calls[0]!.payload.writeSituation, "writable_tree");
  });

  it("isolationOn = true + 非树形 sandboxRoot（未绑树）→ writeSituation = no_writable_root", () => {
    // Core acceptance: children of a parent not bound to a tree carry
    // writeSituation = no_writable_root — the worker renders the state-3
    // disclosure from it and never tells the model it can write the main repo.
    const { manager, calls } = makeManagerCapturingPayload({
      isolationOn: true,
      parentSandboxRoot: mainPath,
    });
    manager.spawn({ task: "hello" });
    assert.equal(calls[0]!.payload.writeSituation, "no_writable_root");
  });

  it("isolationOn getter 在 spawn 时再读：ON→OFF 后 writeSituation = writable_main", () => {
    let on = true;
    const { manager, calls } = makeManagerCapturingPayload({
      isolationOn: () => on,
      parentSandboxRoot: mainPath,
    });
    manager.spawn({ task: "first" });
    assert.equal(calls[0]!.payload.writeSituation, "no_writable_root");
    on = false;
    manager.spawn({ task: "second" });
    assert.equal(calls[1]!.payload.writeSituation, "writable_main");
  });

  it("isolationOn 缺省 → 默认 false + writable_main（manager 直造场景向后兼容）", () => {
    // The existing manager.test.ts makeHarness path omits isolationOn; the
    // internal default false → writable_main stays byte-equal to before.
    const { manager, calls } = makeManagerCapturingPayload({
      parentSandboxRoot: mainPath,
    });
    manager.spawn({ task: "hello" });
    assert.equal(calls[0]!.payload.writeSituation, "writable_main");
  });

  it("envelope.writeSituation 是写处境枚举字面量（typed,不丢类型）", () => {
    // shape: assert the field is one of the three enum literals, guarding
    // against an accidental string-concatenated value.
    const { manager, calls } = makeManagerCapturingPayload({
      isolationOn: true,
      parentSandboxRoot: treePath,
    });
    manager.spawn({ task: "hello" });
    const sit = calls[0]!.payload.writeSituation;
    assert.ok(
      sit === "writable_main" ||
        sit === "writable_tree" ||
        sit === "no_writable_root",
      `writeSituation 必须是三态枚举字面量,实际: ${String(sit)}`
    );
  });
});
