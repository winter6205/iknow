/**
 * T6 (plans/write-situation-disclosure.md) — manager.buildWorkerPayload 在
 * spawn 期算 `writeSituation` 并透传到 envelope（ADR-0069 D2）。
 *
 * Acceptance:
 *   - `isolationOn: false` → writable_main（无论 sandboxRoot 是否树形,
 *     negative 臂钉死防形状判断被单独误用 — 与 writeSituation.test.ts 对齐);
 *   - `isolationOn: true` + 树形 sandboxRoot → writable_tree;
 *   - `isolationOn: true` + 非树形 sandboxRoot → no_writable_root;
 *   - `isolationOn: undefined` → 默认 false（manager 直造场景如
 *     manager.test.ts makeHarness 走默认行为,与改造前 byte-equal);
 *   - 透传字段名 = writeSituation,值是三态枚举字面量（typed,非字符串）。
 *
 * 装配 SSOT: 写处境判定函数 = `writeSituation(isolationOn, sandboxRoot)`
 * (src/harness/isolation/write-situation.ts);manager 只是用 sandboxRoot 的
 * resolved 值调用 —— 不重复形状判断(ACR bounded-context-guardian 钉死)。
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

// `isTaskWorktreePath` 接受 `<repo>/.iknow/worktrees/<convId>` 形态。构造真实
// 的 tmp 路径作为 parentSandboxRoot（realpath 必须解析得到），并模拟树形 vs
// 主仓两种形态 —— 用真实存在的子路径触发对应分支。
//   - `treePath` 在 temp root 下创建真实目录 `<root>/.iknow/worktrees/<convId>`,
//     树形形态可命中 isTaskWorktreePath;
//   - `mainPath` 直接用 temp root(非 `.iknow/worktrees/...` 形态),非树形。

let tempRoot: string;
let mainPath: string;
let treePath: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "iknow-mgr-ws-"));
  // 主仓形态: tempRoot 直接做 sandboxRoot（非 `.iknow/worktrees/<x>` 形态）。
  mainPath = tempRoot;
  // 树形形态: <root>/.iknow/worktrees/convXXXX 真实存在。
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
  readonly isolationOn?: boolean;
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

describe("buildWorkerPayload — T6 writeSituation 透传 (ADR-0069 D2)", () => {
  it("isolationOn = false + 树形 sandboxRoot → writeSituation = writable_main", () => {
    // negative 臂钉死(对齐 writeSituation.test.ts):隔离 OFF 时即使沙箱根
    // 是树形路径,仍说 writable_main(防形状判断被单独误用)。
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
    // 这是 T6 的核心 acceptance:未绑树的父会话派出的子代理,envelope 上
    // 带的 writeSituation = no_writable_root —— worker 据此渲染 ③ 态披露,
    // 不会向模型说「写主仓」。
    const { manager, calls } = makeManagerCapturingPayload({
      isolationOn: true,
      parentSandboxRoot: mainPath,
    });
    manager.spawn({ task: "hello" });
    assert.equal(calls[0]!.payload.writeSituation, "no_writable_root");
  });

  it("isolationOn 缺省 → 默认 false + writable_main（manager 直造场景向后兼容）", () => {
    // 既有 manager.test.ts makeHarness 路径不传 isolationOn;manager 内部
    // 默认 false → writable_main,与改造前 byte-equal。
    const { manager, calls } = makeManagerCapturingPayload({
      parentSandboxRoot: mainPath,
    });
    manager.spawn({ task: "hello" });
    assert.equal(calls[0]!.payload.writeSituation, "writable_main");
  });

  it("envelope.writeSituation 是写处境枚举字面量（typed,不丢类型）", () => {
    // shape: 直接断言字段是三态枚举字面量之一,防止意外写成字符串拼接。
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
