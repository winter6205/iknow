/**
 * SubAgentManager sandboxRoot narrowing — single validation point in the manager
 * (prefix-of-parent).
 *
 * Design contract:
 *   - Every spawn path goes through `buildWorkerPayload` validation — on failure
 *     throw SubAgentSandboxRootError synchronously; the spawn factory is never called.
 *   - Validation uses realpath to block symlink escape; out-of-scope requests
 *     ("..", absolute paths beyond parent, symlinks resolving outside) are rejected
 *     with a typed error.
 *   - Default: when def.sandboxRoot is absent the envelope carries the **parent
 *     sandboxRoot** (manager's sandboxRoot opt), not process.cwd().
 *   - Compat boundary: when the manager has no sandboxRoot opt, fallback stays
 *     process.cwd() (existing manager.test.ts coverage must not regress).
 *
 * Coverage: valid child path passes; out-of-scope absolute path and symlink escape
 * reject without spawning; lexical prefix pass for not-yet-existing child paths;
 * /tmp rejection; default inheritance; relative paths; error context fields.
 * spawn-subagent pass-through is asserted separately in spawn-subagent.test.ts.
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
import { dirname, join, relative, resolve } from "node:path";
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

// ── fake ChildProcess factory (same shape as manager.test.ts) ────────────────

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

/** Collecting wrapper: records spawn args + spawnCalls for assertions. */
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

// ── helper: fresh tmpdir parent + child ─────────────────────────────────────

function freshTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ── fixture 1: happy path ───────────────────────────────────────────────────

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

// ── fixture 2: out-of-scope failure ─────────────────────────────────────────

describe("SubAgentManager sandboxRoot 收窄 — 越界失败 (typed error)", () => {
  it("越界绝对路径 (/etc) → 抛 SubAgentSandboxRootError，spawn 工厂未被调用", () => {
    const parent = freshTmpDir("sb-parent-");
    try {
      const { manager, spawnCalls, spawned } = makeHarness({
        parentSandboxRoot: parent,
      });
      // parent = a real dir outside process.cwd(); def.sandboxRoot escapes to /etc
      assert.throws(
        () => manager.spawn({ sandboxRoot: "/etc" }),
        (err: unknown) => {
          assert.ok(err instanceof SubAgentSandboxRootError);
          assert.equal(err.name, "SubAgentSandboxRootError");
          assert.ok(err.context.parentSandboxRoot.length > 0);
          assert.equal(err.context.requested, "/etc");
          // error message is model-facing: mentions sandboxRoot / parent concepts
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
      // parent/escape → outside (symlink)
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
    // A not-yet-existing child path under the parent root is **not** outside.
    // Lexical prefix verdict passing is enough; handling of missing paths on the
    // worker's fs side is the worker's own concern — the manager does not create
    // directories for it (fail-open at validation, fail at use site).
    const parent = freshTmpDir("sb-parent-");
    try {
      const { manager, spawnCalls } = makeHarness({
        parentSandboxRoot: parent,
      });
      const ghost = join(parent, "not-yet-created-dir");
      assert.doesNotThrow(() => manager.spawn({ sandboxRoot: ghost }));
      assert.equal(spawnCalls.length, 1);
      // payload.sandboxRoot = lexical resolve(ghost) value (no directory created)
      assert.equal(spawnCalls[0]!.payload.sandboxRoot, resolve(ghost));
    } finally {
      cleanup(parent);
    }
  });

  it("/tmp 当 sandboxRoot（SC7）→ 仍拒 outside", () => {
    // /tmp is a common escape candidate; when the parent root is not under /tmp it
    // must still be typed-rejected. Invariant: lexical prefix verdict only, independent of path existence.
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

  it("symlinked 父根 + 父根下尚未存在的子路径（SC6）→ 放行，不假越界", () => {
    // Invariant: the ENOENT fallback builds the child as "realpath of nearest
    // existing ancestor + unresolved suffix", aligning with the parent arm's
    // realpath shape — when the parent root arrives as a symlink (WSL /tmp →
    // /tmpXXX, macOS /var → /private/var), a purely lexical child against
    // realpath(parent) would falsely report outside. A not-yet-existing child
    // under the parent root must never report outside.
    const real = freshTmpDir("sb-real-");
    const link = join(freshTmpDir("sb-link-"), "parent-link");
    symlinkSync(real, link);
    try {
      const { manager, spawnCalls } = makeHarness({
        parentSandboxRoot: link, // manager realpaths it to the real form internally
      });
      const ghost = join(link, "not-yet-created-dir");
      assert.doesNotThrow(() => manager.spawn({ sandboxRoot: ghost }));
      assert.equal(spawnCalls.length, 1);
      // payload carries the real form (ghost's existing ancestor = link → realpaths to real)
      assert.equal(
        spawnCalls[0]!.payload.sandboxRoot,
        join(realpathSync(real), "not-yet-created-dir")
      );
    } finally {
      cleanup(real);
      cleanup(dirname(link));
    }
  });
});

// ── fixture 3: boundaries ───────────────────────────────────────────────────

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
      // explicitly give the manager a parentSandboxRoot ≠ process.cwd()
      const { manager, spawnCalls } = makeHarness({
        parentSandboxRoot: parent,
      });
      // def without sandboxRoot
      manager.spawn({ task: "do work" });
      assert.equal(spawnCalls.length, 1);
      const expected = realpathSync(parent);
      // key assertion: default = parent sandboxRoot, not process.cwd()
      assert.equal(spawnCalls[0]!.payload.sandboxRoot, expected);
      assert.notEqual(spawnCalls[0]!.payload.sandboxRoot, process.cwd());
    } finally {
      cleanup(parent);
    }
  });

  it("manager 未传 sandboxRoot opt（直造 manager）→ fallback = process.cwd()（兼容既有测试）", () => {
    // existing manager.test.ts makeHarness passes no sandboxRoot — behavior stays compatible
    const { manager, spawnCalls } = makeHarness();
    manager.spawn({});
    assert.equal(spawnCalls.length, 1);
    assert.equal(
      spawnCalls[0]!.payload.sandboxRoot,
      realpathSync(process.cwd())
    );
  });
});

// ── fixture 4: relative paths ───────────────────────────────────────────────

describe("SubAgentManager sandboxRoot 收窄 — 相对路径", () => {
  it("相对路径 'sub' 在父内 → resolve 后通过（process.cwd 切换场景）", () => {
    // exercise the real 'sub' form: chdir into the parent dir, then submit a relative path
    const parent = freshTmpDir("sb-parent-");
    const sub = join(parent, "sub");
    mkdirSync(sub);
    const originalCwd = process.cwd();
    try {
      process.chdir(parent);
      // parent = parent = process.cwd()
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
      // more reliable escaping relative path: relative(parent, outside) always contains '..'
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

// ── fixture 4b: overflow ────────────────────────────────────────────────────

describe("SubAgentManager sandboxRoot 收窄 — overflow", () => {
  it("极长相对路径仍在父根下 → 词法 prefix 裁决通过，不报笼统 outside", () => {
    // Length alone must not change the verdict — a path still lexically under the
    // parent root takes the normal pass branch; it must not blow up into a generic outside.
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
      // lexically inside the parent root but nonexistent → lexical pass, payload carries resolve value
      manager.spawn({ sandboxRoot: deepAbs });
      assert.equal(spawnCalls.length, 1);
      assert.equal(spawnCalls[0]!.payload.sandboxRoot, resolve(deepAbs));
    } finally {
      cleanup(parent);
    }
  });
});

// ── fixture 4c: concurrent / exception ──────────────────────────────────────

describe("SubAgentManager sandboxRoot 收窄 — exception", () => {
  // concurrent: N/A — pure (buildWorkerPayload validates synchronously, no shared mutable state)

  it("父根外绝对路径 → outside（SubAgentSandboxRootError）", () => {
    // Exception 1: lexically outside the parent root = outside, independent of path existence.
    const parent = freshTmpDir("sb-parent-");
    try {
      const { manager, spawnCalls } = makeHarness({
        parentSandboxRoot: parent,
      });
      // nonexistent absolute path outside the parent root: lexical verdict rejects, no realpath needed
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
    // Exception 2: I/O faults must surface verbatim, never wrapped as outside
    // (once ENOENT wording is split from outside, non-ENOENT errors must not be
    // swept into the same typed-error domain either).
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
      // restore permissions before cleanup, otherwise rmSync also hits EACCES
      chmodSync(inaccessible, 0o755);
      cleanup(parent);
    }
  });
});

// ── fixture 5: error context field contract ─────────────────────────────────

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

// ── fixture 6: createSubAgentManager opts.sandboxRoot validation ────────────

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
