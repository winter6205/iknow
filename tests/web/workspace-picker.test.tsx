/**
 * serve-workspace T5: 顶栏 chip + picker 渲染与 API 契约断言。
 *
 * 覆盖：
 * - basename 4 例（POSIX / Windows 路径 + 根路径边界）
 * - /api/v1/workspace* 端点 fetch 契约（URL / method / body）
 * - WorkspaceChip 两态渲染（bound basename / unbound CTA + bg-warn-soft）
 * - WorkspacePicker 默认态（input / 信任 toggle / recents 列表）
 * - onBind payload 构造（confirmTrust 透传 + 空输入兜底）
 *
 * 沿用 renderToStaticMarkup + fetch-stub 模式（参考 tests/web/subagents-api.test.ts、
 * tests/web/usage-chip.test.tsx），无需 jsdom。
 */
import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  getWorkspace,
  listTrustedWorkspaces,
  putWorkspace,
} from "../../web/src/api/client.ts";
import {
  basename,
  WorkspaceChip,
} from "../../web/src/components/WorkspaceChip.tsx";
import {
  buildBindPayload,
  WorkspacePicker,
} from "../../web/src/components/WorkspacePicker.tsx";

describe("basename — POSIX / Windows / 根路径", () => {
  it("典型 POSIX 路径 → 最后一段", () => {
    assert.equal(basename("/foo/bar"), "bar");
  });

  it("POSIX 路径带尾斜杠 → 去掉后取最后一段", () => {
    assert.equal(basename("/foo/"), "foo");
  });

  it("根路径（无 basename）→ 原样返回（chip 展示成 /）", () => {
    assert.equal(basename("/"), "/");
  });

  it("Windows 反斜杠路径 → 最后一段", () => {
    assert.equal(basename("C:\\a\\b"), "b");
  });
});

describe("api workspace 端点（serve-workspace T3 + T5）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("getWorkspace → GET /api/v1/workspace，unwrap { bound, root? }", async () => {
    const calls: Array<{ input: RequestInfo; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        calls.push({ input, init });
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ bound: true, root: "/abs/proj" }),
        };
      }) as unknown as typeof fetch
    );

    const res = await getWorkspace();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.input, "/api/v1/workspace");
    assert.equal(calls[0]?.init?.method ?? "GET", "GET");
    assert.equal(res.bound, true);
    assert.equal(res.root, "/abs/proj");
  });

  it("putWorkspace({ path, confirmTrust }) → PUT + JSON body", async () => {
    const calls: Array<{ input: RequestInfo; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        calls.push({ input, init });
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ bound: true, root: "/x" }),
        };
      }) as unknown as typeof fetch
    );

    const res = await putWorkspace({ path: "/abs/new", confirmTrust: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.input, "/api/v1/workspace");
    assert.equal(calls[0]?.init?.method, "PUT");
    assert.equal(
      calls[0]?.init?.body,
      JSON.stringify({ path: "/abs/new", confirmTrust: true })
    );
    const headers = calls[0]?.init?.headers as Headers | undefined;
    assert.equal(headers?.get("Content-Type"), "application/json");
    assert.equal(res.root, "/x");
  });

  it("listTrustedWorkspaces → GET /api/v1/workspaces，unwrap { workspaces: [] }", async () => {
    const calls: Array<{ input: RequestInfo; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        calls.push({ input, init });
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              workspaces: [{ root: "/abs/a" }, { root: "/abs/b" }],
            }),
        };
      }) as unknown as typeof fetch
    );

    const res = await listTrustedWorkspaces();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.input, "/api/v1/workspaces");
    assert.equal(calls[0]?.init?.method ?? "GET", "GET");
    assert.deepEqual(
      res.workspaces.map((w) => w.root),
      ["/abs/a", "/abs/b"]
    );
  });

  it("非 2xx → reject with SessionApiError（typed-error 传播）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        text: async () =>
          JSON.stringify({
            error: {
              kind: "not_found",
              message: "workspaces recents not wired",
            },
          }),
      })) as unknown as typeof fetch
    );
    // hook 层 .catch 静默降级；这里直接验证 fetch 端契约
    await assert.rejects(
      listTrustedWorkspaces(),
      /workspaces recents not wired/
    );
  });
});

describe("WorkspaceChip 渲染", () => {
  it("unbound → 警告 CTA「选择工作空间」 + bg-warn-soft", () => {
    const html = renderToStaticMarkup(
      <WorkspaceChip bound={false} root={null} onOpen={() => {}} />
    );
    assert.ok(html.includes("选择工作空间"), "must include unbound CTA text");
    assert.ok(html.includes("bg-warn-soft"), "must include warn-soft color");
    assert.ok(
      html.includes("未绑定工作空间，点击选择"),
      "must include aria-label for unbound"
    );
  });

  it("bound → basename 渲染 + 全路径在 title", () => {
    const html = renderToStaticMarkup(
      <WorkspaceChip
        bound={true}
        root="/abs/projects/myapp"
        onOpen={() => {}}
      />
    );
    assert.ok(html.includes("myapp"), "must include basename 'myapp'");
    assert.ok(
      html.includes('title="工作空间：/abs/projects/myapp"'),
      "must include root path in title"
    );
    assert.ok(html.includes("📁"), "must include folder glyph");
    // bound 态不应渲染警告 CTA
    assert.ok(!html.includes("选择工作空间"), "must NOT include unbound CTA");
  });
});

describe("WorkspacePicker 渲染", () => {
  it("默认态：input + 信任 toggle + recents 列表 + 子目录浏览器(折叠)", () => {
    const html = renderToStaticMarkup(
      <WorkspacePicker
        recents={["/abs/old", "/abs/older"]}
        currentRoot={null}
        onBind={async () => {}}
        onClose={() => {}}
        onNotice={() => {}}
        onBrowseSubdirs={async () => []}
      />
    );
    assert.ok(html.includes("选择工作空间根"), "must include picker title");
    assert.ok(
      html.includes('aria-label="工作空间绝对路径"'),
      "must render path input"
    );
    assert.ok(html.includes("信任"), "must render trust toggle");
    // recents 列表 → 两个 basename + 全路径
    assert.ok(html.includes("old"), "must include first recent basename");
    assert.ok(html.includes("older"), "must include second recent basename");
    assert.ok(html.includes("/abs/old"), "must include full recent path");
    // T3: 子目录浏览器(默认折叠, 仅 toggle button 可见)
    assert.ok(html.includes("浏览子目录"), "must render browser toggle");
    assert.ok(
      html.includes('aria-label="浏览子目录"'),
      "must render browser aria-label"
    );
  });

  it("recents 为空 → 不渲染「已信任的根」段", () => {
    const html = renderToStaticMarkup(
      <WorkspacePicker
        recents={[]}
        currentRoot={null}
        onBind={async () => {}}
        onClose={() => {}}
        onNotice={() => {}}
        onBrowseSubdirs={async () => []}
      />
    );
    assert.ok(!html.includes("已信任的根"), "must NOT render recents section");
  });

  it("currentRoot 命中 → 该项高亮（bg-accent-soft）", () => {
    const html = renderToStaticMarkup(
      <WorkspacePicker
        recents={["/abs/active"]}
        currentRoot="/abs/active"
        onBind={async () => {}}
        onClose={() => {}}
        onNotice={() => {}}
        onBrowseSubdirs={async () => []}
      />
    );
    assert.ok(
      html.includes("bg-accent-soft text-accent"),
      "must mark active recent with accent-soft"
    );
  });
});

describe("WorkspacePicker — buildBindPayload（onBind 契约）", () => {
  it("非空输入 + confirming=true → 带 confirmTrust=true 的 payload", () => {
    assert.deepEqual(buildBindPayload("/abs/new", true), {
      path: "/abs/new",
      confirmTrust: true,
    });
  });

  it("非空输入 + confirming=false → 带 confirmTrust=false 的 payload", () => {
    assert.deepEqual(buildBindPayload("/abs/new", false), {
      path: "/abs/new",
      confirmTrust: false,
    });
  });

  it("前后空白 trim + 仍带 confirming 透传", () => {
    assert.deepEqual(buildBindPayload("  /abs/new  ", true), {
      path: "/abs/new",
      confirmTrust: true,
    });
  });

  it("纯空白输入 → null（不调用 onBind）", () => {
    assert.equal(buildBindPayload("", false), null);
    assert.equal(buildBindPayload("   ", true), null);
  });
});
