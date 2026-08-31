/**
 * Review round 3 — `src/cli/runtime.ts` 的 wrapper 按**白名单**逐字段转发到
 * `buildHarnessEngine`，未声明的字段会被静默丢掉：编译绿、全量测试绿，只有真
 * 跑才发现宿主钉的根没生效（实测 `projectIdentityRoot` 在 `iknow chat` 上整条
 * 失效）。既有测试都只钉 build-engine 自己认字段，没人钉这一层，所以缺口能
 * 带着绿灯发车。
 *
 * 本文件钉的就是这一层：会话根必须原样落到 build-engine 的 opts 上，且空串
 * 不得在转发时被吞（round 4 实测：真值判会把它吞掉，装配层继而静默退
 * `mainCheckoutOf(cwd)`，SSOT 的 fail-closed 永远等不到那个值）。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockState = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../src/harness/build-engine.ts", () => ({
  buildHarnessEngine: vi.fn(async (opts: Record<string, unknown>) => {
    mockState.calls.push(opts);
    return { deps: {}, shutdown: undefined };
  }),
}));

// 宿主初始化的副作用（seed `~/.iknow`、跑 init.sh）与本契约无关，且会碰真实
// home —— 装配缝之外的东西一律挡掉。
vi.mock("../../src/harness/identity/index.ts", () => ({
  initIknowWorkspaceSafe: vi.fn(async () => undefined),
  runHostInitScriptSafe: vi.fn(async () => undefined),
}));

const { buildHarnessEngine } = await import("../../src/cli/runtime.ts");
type CliBuildEngineOpts = import("../../src/cli/runtime.ts").CliBuildEngineOpts;

// wrapper 的 `resolveWorkspaceRoot` 要求根真实存在（typed WorkspaceRootError），
// 所以用真目录而不是字面量路径。
let anchor = "";
let project = "";

beforeAll(async () => {
  anchor = await mkdtemp(join(tmpdir(), "iknow-cli-fwd-"));
  project = join(anchor, "the-project");
  await mkdir(project, { recursive: true });
  return async () => {
    await rm(anchor, { recursive: true, force: true });
  };
});

afterEach(() => {
  mockState.calls.length = 0;
});

function bundle(): Parameters<typeof buildHarnessEngine>[0] {
  return {
    env: { workspaceRoot: undefined } as never,
    session: {},
  } as Parameters<typeof buildHarnessEngine>[0];
}

describe("cli runtime wrapper forwards the session roots", () => {
  it("passes productRoot and projectIdentityRoot through to build-engine", async () => {
    const opts: CliBuildEngineOpts = {
      askUser: (() => {
        throw new Error("unused");
      }) as never,
      surface: "chat",
      workspaceRoot: anchor,
      productRoot: anchor,
      projectIdentityRoot: project,
      cwd: project,
    };

    await buildHarnessEngine(bundle(), opts);

    expect(mockState.calls).toHaveLength(1);
    const forwarded = mockState.calls[0]!;
    expect(forwarded.productRoot).toBe(anchor);
    expect(forwarded.projectIdentityRoot).toBe(project);
    expect(forwarded.cwd).toBe(project);
  });

  it("forwards an explicit empty root instead of swallowing it, so the SSOT can fail closed", async () => {
    const opts: CliBuildEngineOpts = {
      askUser: (() => {
        throw new Error("unused");
      }) as never,
      productRoot: anchor,
      projectIdentityRoot: "",
      cwd: project,
    };

    await buildHarnessEngine(bundle(), opts);

    const forwarded = mockState.calls[0]!;
    expect(
      Object.hasOwn(forwarded, "projectIdentityRoot"),
      "wrapper swallowed an explicit empty identity root"
    ).toBe(true);
    expect(forwarded.projectIdentityRoot).toBe("");
  });

  it("cannot be talked out of its own injected fields by a stray key in opts", async () => {
    // round 5：rest 整体透传的代价是 opts 里混进本层负责的键也会跟着流下去。
    // 类型只在字面量上挡得住，所以顺序必须保证注入值最后写。
    const opts = {
      askUser: (() => {
        throw new Error("unused");
      }) as never,
      productRoot: anchor,
      projectIdentityRoot: project,
      env: { hijacked: true },
      surface: undefined,
    } as unknown as CliBuildEngineOpts;

    await buildHarnessEngine(bundle(), opts);

    const forwarded = mockState.calls[0]!;
    expect((forwarded.env as Record<string, unknown>).hijacked).toBeUndefined();
    expect(forwarded.surface).toBe("chat");
    expect(forwarded.projectIdentityRoot).toBe(project);
  });

  it("keeps every root the opts type declares — a field the wrapper forgets to forward is a silent drop", async () => {
    // 白名单缺口的通用守门：opts 里出现的根字段，转发后必须都在。
    const rootFields = [
      "workspaceRoot",
      "productRoot",
      "projectIdentityRoot",
      "cwd",
    ] as const;
    const opts: CliBuildEngineOpts = {
      askUser: (() => {
        throw new Error("unused");
      }) as never,
      workspaceRoot: anchor,
      productRoot: anchor,
      projectIdentityRoot: project,
      cwd: project,
    };

    await buildHarnessEngine(bundle(), opts);

    const forwarded = mockState.calls[0]!;
    for (const field of rootFields) {
      expect(Object.hasOwn(forwarded, field), `wrapper dropped ${field}`).toBe(
        true
      );
    }
  });
});
