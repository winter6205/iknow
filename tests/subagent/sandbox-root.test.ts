/**
 * #357 T1 — SubAgentManager sandboxRoot 收窄校验（manager 单点 prefix-of-parent）。
 *
 * 设计契约（spec SC1 / SC2 / SC8 + plan T1 acceptance 1-3）：
 *   - 所有 spawn 路径必经 `buildWorkerPayload` 单点校验 —— 校验失败同步抛
 *     SubAgentSandboxRootError，spawn 工厂不被调用。
 *   - 校验用 realpath 防符号链接逃逸；越界（含 ".."、绝对路径超出、symlink 出父）
 *     一律拒绝并 typed error。
 *   - 缺省行为变更：def.sandboxRoot 缺席时 envelope 写入**父 sandboxRoot**
 *     （manager 的 sandboxRoot opt），不是 process.cwd()（SC8）。
 *   - 缺省边界兼容：manager 未传 sandboxRoot opt 时，fallback 仍为 process.cwd()
 *     （manager.test.ts 既有用例的覆盖不降）。
 *
 * 测试覆盖六类（spec mutate-write-contract SC6/SC7 + 「输入五类」表 B）：
 *   1 正常：合法子路径 → 通过校验、payload.sandboxRoot === resolved
 *   2 失败：越界绝对路径 → SubAgentSandboxRootError，spawnCalls.length === 0；
 *          符号链接逃逸 → realpath 解析后拒绝
 *   3 边界：相等合法（请求 = 父本身）；缺省继承父 sandboxRoot（不是 process.cwd()）
 *   4 相对：def.sandboxRoot = "sub" → resolve 通过；"../outside" → 拒绝
 *   5 不存在路径（父根下尚未存在的子路径，SC6）→ **词法放行**：spawn 正常
 *          携带 resolve(path)；`/tmp` 当 sandboxRoot（SC7）仍拒
 *   6 spawn-subagent 透传断言（独立测试文件，详见 spawn-subagent.test.ts）
 */
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  realpathSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import {
  createSubAgentManager,
  type SubAgentDefinition,
  type SubAgentManager,
} from "../../src/harness/subagent/manager.ts";
import type { WorkerEnvelope } from "../../src/harness/subagent/envelope.ts";
import { SubAgentSandboxRootError } from "../../src/harness/errors.ts";

// ── fake ChildProcess 工厂（与 manager.test.ts 同形）─────────────────────────

interface FakeChild {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly pid: number;
  readonly kill: ReturnType<typeof vi.fn>;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  emit: (event: string | symbol, ...args: unknown[]) => boolean;
  once: (event: string | symbol, ...args: unknown[]) => unknown;
}

function makeFakeChild(): FakeChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = vi.fn(() => true);
  return Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: 12345,
    kill,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  }) as unknown as FakeChild;
}

/** 收 wrapper：记录 spawn 入参 + spawnCalls，供测试断言。 */
function makeHarness(
  opts: {
    readonly parentSandboxRoot?: string;
  } = {}
) {
  const spawned: FakeChild[] = [];
  const spawnCalls: {
    def: SubAgentDefinition;
    taskId: string;
    payload: WorkerEnvelope;
  }[] = [];
  const manager = createSubAgentManager({
    spawn: (def, taskId, payload) => {
      const child = makeFakeChild();
      spawned.push(child);
      spawnCalls.push({ def, taskId, payload });
      return child as unknown as ChildProcess;
    },
    ...(opts.parentSandboxRoot !== undefined
      ? { sandboxRoot: opts.parentSandboxRoot }
      : {}),
  });
  return { manager, spawned, spawnCalls };
}

// ── helper：fresh tmpdir 父 + 子 ─────────────────────────────────────────────

function freshTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}

// ── fixture 1:正常路径 ──────────────────────────────────────────────────────

describe("SubAgentManager sandboxRoot 收窄 — 正常路径", () => {
  it("合法子路径 → spawn 成功，payload.sandboxRoot === realpathSync(子路径)", () => {
    const parent = freshTmpDir("sb-parent-");
    const child = join(parent, "work");
    mkdirSync(child);
    try {
      const { manager, spawnCalls } = makeHarness({
        parentSandboxRoot: parent,
      });
      const { taskId } = manager.spawn({ sandboxRoot: child });
      assert.ok(taskId.length > 0);
      assert.equal(spawnCalls.length, 1);
      assert.equal(spawnCalls[0]!.payload.sandboxRoot, realpathSync(child));
    } finally {
      cleanup(parent);
    }
  });
});

// ── fixture 2:越界失败 ──────────────────────────────────────────────────────

describe("SubAgentManager sandboxRoot 收窄 — 越界失败 (typed error)", () => {
  it("越界绝对路径 (/etc) → 抛 SubAgentSandboxRootError，spawn 工厂未被调用", () => {
    const parent = freshTmpDir("sb-parent-");
    try {
      const { manager, spawnCalls, spawned } = makeHarness({
        parentSandboxRoot: parent,
      });
      // 父 = process.cwd() 之外的真实目录；def.sandboxRoot 越界到 /etc
      assert.throws(
        () => manager.spawn({ sandboxRoot: "/etc" }),
        (err: unknown) => {
          assert.ok(err instanceof SubAgentSandboxRootError);
          assert.equal(err.name, "SubAgentSandboxRootError");
          assert.ok(err.context.parentSandboxRoot.length > 0);
          assert.equal(err.context.requested, "/etc");
          // 错误消息面向模型：含 sandboxRoot / parent 概念
          assert.match(err.message, /sandboxRoot/i);
          return true;
        }
      );
      assert.equal(spawnCalls.length, 0, "spawn 工厂不应被调用");
      assert.equal(spawned.length, 0, "无 child 启动");
    } finally {
      cleanup(parent);
    }
  });

  it("符号链接逃逸（父内 symlink 指向父外目录）→ 拒绝", () => {
    const parent = freshTmpDir("sb-parent-");
    const outside = freshTmpDir("sb-outside-");
    const escape = join(parent, "escape");
    try {
      // parent/escape → outside（符号链接）
      symlinkSync(outside, escape);
      const { manager, spawnCalls } = makeHarness({
        parentSandboxRoot: parent,
      });
      assert.throws(
        () => manager.spawn({ sandboxRoot: escape }),
        SubAgentSandboxRootError
      );
      assert.equal(spawnCalls.length, 0);
    } finally {
      cleanup(parent);
      cleanup(outside);
    }
  });

  it("ENOENT（父根下尚未存在的子路径，SC6）→ 词法放行：spawn 携带 resolve(path)", () => {
    // spec mutate-write-contract SC6：「父根下尚未存在的子路径」**不是** outside。
    // 词法 prefix 裁决通过即可放行；worker 侧 fs 工具对不存在路径的处理由其
    // 自身负责，manager 不替它建目录（fail-open at validation, fail at use site）。
    const parent = freshTmpDir("sb-parent-");
    try {
      const { manager, spawnCalls } = makeHarness({
        parentSandboxRoot: parent,
      });
      const ghost = join(parent, "not-yet-created-dir");
      assert.doesNotThrow(() => manager.spawn({ sandboxRoot: ghost }));
      assert.equal(spawnCalls.length, 1);
      // payload.sandboxRoot = resolve(ghost) 的词法值（不创建目录）
      assert.equal(spawnCalls[0]!.payload.sandboxRoot, resolve(ghost));
    } finally {
      cleanup(parent);
    }
  });

  it("/tmp 当 sandboxRoot（SC7）→ 仍拒 outside", () => {
    // spec mutate-write-contract SC7：/tmp 是常用逃逸候选父根不在 /tmp 之下时
    // 仍应被 typed 拒绝；不变式：词法 prefix 判定即可，与路径是否存在无关。
    const parent = freshTmpDir("sb-parent-");
    try {
      const { manager, spawnCalls } = makeHarness({
        parentSandboxRoot: parent,
      });
      assert.throws(
        () => manager.spawn({ sandboxRoot: "/tmp" }),
        SubAgentSandboxRootError
      );
      assert.equal(spawnCalls.length, 0);
    } finally {
      cleanup(parent);
    }
  });
});

// ── fixture 3:边界 ──────────────────────────────────────────────────────────

describe("SubAgentManager sandboxRoot 收窄 — 边界", () => {
  it("def.sandboxRoot = 父本身（相等，合法）→ payload.sandboxRoot === parent", () => {
    const parent = freshTmpDir("sb-parent-");
    try {
      const { manager, spawnCalls } = makeHarness({
        parentSandboxRoot: parent,
      });
      manager.spawn({ sandboxRoot: parent });
      assert.equal(spawnCalls.length, 1);
      assert.equal(spawnCalls[0]!.payload.sandboxRoot, realpathSync(parent));
    } finally {
      cleanup(parent);
    }
  });

  it("def.sandboxRoot 缺席 → envelope 继承父 sandboxRoot（不是 process.cwd()）(SC8)", () => {
    const parent = freshTmpDir("sb-parent-");
    try {
      // 显式给 manager 一个 ≠ process.cwd() 的 parentSandboxRoot
      const { manager, spawnCalls } = makeHarness({
        parentSandboxRoot: parent,
      });
      // def 不带 sandboxRoot
      manager.spawn({ task: "do work" });
      assert.equal(spawnCalls.length, 1);
      const expected = realpathSync(parent);
      // 关键断言：缺省 = 父 sandboxRoot，不是 process.cwd()
      assert.equal(spawnCalls[0]!.payload.sandboxRoot, expected);
      assert.notEqual(spawnCalls[0]!.payload.sandboxRoot, process.cwd());
    } finally {
      cleanup(parent);
    }
  });

  it("manager 未传 sandboxRoot opt（直造 manager）→ fallback = process.cwd()（兼容既有测试）", () => {
    // 既有 manager.test.ts 的 makeHarness 不传 sandboxRoot，行为兼容
    const { manager, spawnCalls } = makeHarness();
    manager.spawn({});
    assert.equal(spawnCalls.length, 1);
    assert.equal(
      spawnCalls[0]!.payload.sandboxRoot,
      realpathSync(process.cwd())
    );
  });
});

// ── fixture 4:相对路径 ──────────────────────────────────────────────────────

describe("SubAgentManager sandboxRoot 收窄 — 相对路径", () => {
  it("相对路径 'sub' 在父内 → resolve 后通过（process.cwd 切换场景）", () => {
    // 真实测试 'sub' 形态：直接 process.chdir 到父目录，再提交相对路径
    const parent = freshTmpDir("sb-parent-");
    const sub = join(parent, "sub");
    mkdirSync(sub);
    const originalCwd = process.cwd();
    try {
      process.chdir(parent);
      // 父 = parent = process.cwd()
      const { manager, spawnCalls } = makeHarness({
        parentSandboxRoot: parent,
      });
      manager.spawn({ sandboxRoot: "sub" });
      assert.equal(spawnCalls.length, 1);
      assert.equal(spawnCalls[0]!.payload.sandboxRoot, realpathSync(sub));
    } finally {
      process.chdir(originalCwd);
      cleanup(parent);
    }
  });

  it("def.sandboxRoot 含 '..' 越界（'../outside'）→ 拒绝", () => {
    const parent = freshTmpDir("sb-parent-");
    const outside = freshTmpDir("sb-outside-");
    try {
      const { manager, spawnCalls } = makeHarness({
        parentSandboxRoot: parent,
      });
      // 用更可靠的越界相对路径：直接 relative(parent, outside) 必含 '..'
      const relOutside = relative(parent, outside);
      assert.ok(relOutside.startsWith(".."));
      assert.throws(
        () => manager.spawn({ sandboxRoot: relOutside }),
        SubAgentSandboxRootError
      );
      assert.equal(spawnCalls.length, 0);
    } finally {
      cleanup(parent);
      cleanup(outside);
    }
  });
});

// ── fixture 4b:overflow（spec 表 B）──────────────────────────────────────────

describe("SubAgentManager sandboxRoot 收窄 — overflow", () => {
  it("极长相对路径仍在父根下 → 词法 prefix 裁决通过，不报笼统 outside", () => {
    // spec mutate-write-contract 表 B overflow：长度本身不改变裁决 —— 路径
    // 词法仍在父根下就走正常放行分支，不得因长度炸成笼统 outside。
    const parent = freshTmpDir("sb-parent-");
    try {
      const { manager, spawnCalls } = makeHarness({
        parentSandboxRoot: parent,
      });
      const deepSegments = Array.from({ length: 64 }, (_, i) =>
        `seg-${i}-`.padEnd(24, "x")
      );
      const deepRel = deepSegments.join("/");
      assert.ok(deepRel.length > 1000);
      const deepAbs = join(parent, deepRel);
      // 词法在父根内但不存在 → SC6 词法放行，payload 携带 resolve 值
      manager.spawn({ sandboxRoot: deepAbs });
      assert.equal(spawnCalls.length, 1);
      assert.equal(spawnCalls[0]!.payload.sandboxRoot, resolve(deepAbs));
    } finally {
      cleanup(parent);
    }
  });
});

// ── fixture 4c:concurrent / exception（spec 表 B）────────────────────────────

describe("SubAgentManager sandboxRoot 收窄 — exception", () => {
  // concurrent: // N/A: pure（buildWorkerPayload 同步校验，无共享可变状态）

  it("父根外绝对路径 → outside（SubAgentSandboxRootError）", () => {
    // spec 表 B exception 1：词法在父根外 = outside，与路径是否存在无关。
    const parent = freshTmpDir("sb-parent-");
    try {
      const { manager, spawnCalls } = makeHarness({
        parentSandboxRoot: parent,
      });
      // 不存在的父根外绝对路径：词法裁决即可拒绝，不依赖 realpath 成功
      assert.throws(
        () =>
          manager.spawn({
            sandboxRoot: join(parent, "..", "elsewhere", "ghost"),
          }),
        SubAgentSandboxRootError
      );
      assert.equal(spawnCalls.length, 0);
    } finally {
      cleanup(parent);
    }
  });

  it("realpath 非 ENOENT I/O 错误（EACCES）→ 原样 rethrow，不是 SubAgentSandboxRootError", () => {
    // spec 表 B exception 2：I/O 故障必须原样暴露，不得包装成 outside
    // （error-handling-enforcer：ENOENT 文案与 outside 拆开后，非 ENOENT
    // 也不能被塞进同一个 typed 错误域）。
    const parent = freshTmpDir("sb-parent-");
    const inaccessible = join(parent, "inaccessible");
    mkdirSync(inaccessible);
    const probe = join(inaccessible, "probe");
    mkdirSync(probe);
    chmodSync(inaccessible, 0o000);
    try {
      const { manager, spawnCalls } = makeHarness({
        parentSandboxRoot: parent,
      });
      let caught: unknown;
      try {
        manager.spawn({ sandboxRoot: probe });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught !== undefined, "应有错误抛出");
      assert.ok(
        !(caught instanceof SubAgentSandboxRootError),
        "EACCES 不得包装成 SubAgentSandboxRootError"
      );
      assert.equal(spawnCalls.length, 0);
    } finally {
      // 先恢复权限再清理，否则 rmSync 也 EACCES
      chmodSync(inaccessible, 0o755);
      cleanup(parent);
    }
  });
});

// ── fixture 5:error context 字段契约 ─────────────────────────────────────────

describe("SubAgentSandboxRootError context 字段契约", () => {
  it("context 包含 parentSandboxRoot (resolved) + requested (原样)", () => {
    const parent = freshTmpDir("sb-parent-");
    try {
      const { manager } = makeHarness({ parentSandboxRoot: parent });
      assert.throws(
        () => manager.spawn({ sandboxRoot: "/etc" }),
        (err: unknown) => {
          assert.ok(err instanceof SubAgentSandboxRootError);
          // parent = realpathSync(parent)
          assert.equal(err.context.parentSandboxRoot, realpathSync(parent));
          assert.equal(err.context.requested, "/etc");
          return true;
        }
      );
    } finally {
      cleanup(parent);
    }
  });

  it("继承 Error + override name", () => {
    const err = new SubAgentSandboxRootError({
      parentSandboxRoot: "/x",
      requested: "/y",
    });
    assert.ok(err instanceof Error);
    assert.equal(err.name, "SubAgentSandboxRootError");
    assert.ok(err.message.length > 0);
  });

  it("message 面向模型：含 sandboxRoot + parent 概念", () => {
    const err = new SubAgentSandboxRootError({
      parentSandboxRoot: "/parent",
      requested: "/outside",
    });
    assert.match(err.message, /sandboxRoot/i);
    assert.match(err.message, /parent/i);
  });
});

// ── fixture 6:createSubAgentManager opts.sandboxRoot 验证 ───────────────────

describe("createSubAgentManager opts.sandboxRoot 字段契约", () => {
  it("opts 缺省时不破坏 SubAgentManager 接口形状", () => {
    const m: SubAgentManager = createSubAgentManager({
      spawn: () => null as unknown as ChildProcess,
    });
    expect(typeof m.spawn).toBe("function");
    expect(typeof m.queryBuffer).toBe("function");
    expect(typeof m.waitFor).toBe("function");
    expect(typeof m.shutdown).toBe("function");
  });
});
