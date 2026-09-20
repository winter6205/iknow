/**
 * Render + API-contract asserts for the top-bar chip and the workspace picker.
 *
 * Coverage:
 * - basename, 4 cases (POSIX / Windows paths + root-path boundary)
 * - /api/v1/workspace* endpoint fetch contract (URL / method / body)
 * - WorkspaceChip two-state render (bound basename / unbound CTA + bg-warn-soft)
 * - WorkspacePicker default state (input / trust toggle / recents list)
 * - onBind payload construction (confirmTrust pass-through + empty-input fallback)
 *
 * renderToStaticMarkup + fetch-stub pattern (see tests/web/subagents-api.test.ts,
 * tests/web/usage-chip.test.tsx); no jsdom needed.
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
  pickRecentForBind,
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
    // the hook layer degrades silently via .catch; here we assert the fetch endpoint contract directly
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
    // bound state must not render the warning CTA
    assert.ok(!html.includes("选择工作空间"), "must NOT include unbound CTA");
  });
});

describe("WorkspacePicker 渲染", () => {
  it("recents 非空 → 默认折叠 path picker, 顶部「已存在工作空间」+ 折叠 CTA", () => {
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
    // recents section title + content
    assert.ok(
      html.includes("已存在工作空间"),
      "must include recents section title"
    );
    assert.ok(html.includes("old"), "must include first recent basename");
    assert.ok(html.includes("older"), "must include second recent basename");
    assert.ok(html.includes("/abs/old"), "must include full recent path");
    assert.ok(
      html.includes("/abs/older"),
      "must include second recent full path"
    );
    // path picker folded by default: input / trust / bind absent from the DOM
    assert.ok(
      !html.includes('aria-label="工作空间绝对路径"'),
      "must NOT render path input when picker folded"
    );
    assert.ok(
      !html.includes('aria-label="浏览子目录"'),
      "must NOT render browser aria-label when picker folded"
    );
    assert.ok(
      !html.includes("绑定"),
      "must NOT render bind button when picker folded"
    );
    // fold CTA present + aria-expanded=false + aria-controls
    assert.ok(
      html.includes("选择路径新建工作空间"),
      "must render fold CTA text"
    );
    assert.ok(
      html.includes('aria-expanded="false"'),
      "must mark fold CTA as collapsed by default"
    );
    assert.ok(
      html.includes("ws-path-picker-panel"),
      "must include aria-controls target id"
    );
  });

  it("recents 为空 → path picker 默认展开（CTA aria-expanded=true）", () => {
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
    assert.ok(
      !html.includes("已存在工作空间"),
      "must NOT render recents section"
    );
    // path picker expanded by default
    assert.ok(
      html.includes('aria-label="工作空间绝对路径"'),
      "must render path input when picker auto-expanded"
    );
    assert.ok(html.includes("信任"), "must render trust toggle when expanded");
    assert.ok(html.includes("绑定"), "must render bind button when expanded");
    assert.ok(
      html.includes('aria-expanded="true"'),
      "must mark fold CTA as expanded by default"
    );
    // subdir-browser fold button (still folded inside the browser, no wasted request)
    assert.ok(
      html.includes('aria-label="浏览子目录"'),
      "must render browser toggle when picker expanded"
    );
  });

  it("currentRoot 命中 → recents 该项高亮（bg-accent-soft）", () => {
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

  it("recents 列表项 className 一律不含 rounded-pill (T5 list-style 收紧)", () => {
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
    // recents <li><button> nodes must drop the pill class. In the folded state the path
    // picker's subdir list is absent, so rounded-pill must not appear anywhere in the html.
    assert.ok(
      !html.includes("rounded-pill"),
      "T5: list items must drop rounded-pill (use rounded-md)"
    );
    // tightened to a small radius (rounded-md = Tailwind 6px, equivalent to rounded-[6px])
    assert.ok(
      html.includes("rounded-md"),
      "must render list items with rounded-md (Tailwind 6px)"
    );
  });

  it("recents 列表项 aria-label 含 workspace 名 (a11y)", () => {
    const html = renderToStaticMarkup(
      <WorkspacePicker
        recents={["/abs/projects/iknow", "/abs/old"]}
        currentRoot={null}
        onBind={async () => {}}
        onClose={() => {}}
        onNotice={() => {}}
        onBrowseSubdirs={async () => []}
      />
    );
    assert.ok(
      html.includes('aria-label="选择工作空间 iknow"'),
      "must include aria-label '选择工作空间 iknow' for first recent"
    );
    assert.ok(
      html.includes('aria-label="选择工作空间 old"'),
      "must include aria-label '选择工作空间 old' for second recent"
    );
  });

  it("折叠 CTA 自身为 button + aria-expanded/aria-controls + 不是 div onClick", () => {
    const html = renderToStaticMarkup(
      <WorkspacePicker
        recents={["/abs/old"]}
        currentRoot={null}
        onBind={async () => {}}
        onClose={() => {}}
        onNotice={() => {}}
        onBrowseSubdirs={async () => []}
      />
    );
    // the fold CTA is a <button> with aria-expanded + aria-controls set; <div/span onClick> is not allowed
    assert.ok(
      html.includes('aria-controls="ws-path-picker-panel"'),
      "fold CTA must declare aria-controls"
    );
    // recents list items are also <button>s (static markup check — no div onClick)
    assert.ok(
      !/<div[^>]*\sonClick=/.test(html),
      "must NOT contain <div onClick> (a11y red line)"
    );
    assert.ok(
      !/<span[^>]*\sonClick=/.test(html),
      "must NOT contain <span onClick> (a11y red line)"
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

describe("WorkspacePicker — pickRecentForBind (recents 列表项 onBind 契约)", () => {
  it("任意根 → path 不变 + confirmTrust=false（recents 全部为已信任）", () => {
    assert.deepEqual(pickRecentForBind("/abs/projects/iknow"), {
      path: "/abs/projects/iknow",
      confirmTrust: false,
    });
  });

  it("Windows 路径同样透传 + 不走 trust", () => {
    assert.deepEqual(pickRecentForBind("C:\\Users\\me\\proj"), {
      path: "C:\\Users\\me\\proj",
      confirmTrust: false,
    });
  });

  it("根路径 '/' → 原样返回 + 不走 trust", () => {
    assert.deepEqual(pickRecentForBind("/"), {
      path: "/",
      confirmTrust: false,
    });
  });
});

/**
 * WorkspaceChip context awareness — display priority:
 *  1. activeWorkspaceRoot first (after the user switches to a session inside a
 *     workspace, the chip shows that root's basename)
 *  2. else bound + root (picker fallback)
 *  3. else unbound CTA (warn color)
 *
 * All three states render as <button> (a11y); always clickable to open the popover.
 */
describe("WorkspaceChip — T8 显示优先级", () => {
  it("activeWorkspaceRoot 优先 → 即使 ws.bound=false 也显示 basename", () => {
    const html = renderToStaticMarkup(
      <WorkspaceChip
        bound={false}
        root={null}
        activeWorkspaceRoot="/abs/projects/iknow"
        onOpen={() => {}}
      />
    );
    assert.ok(html.includes("iknow"), "must render active root basename");
    assert.ok(
      html.includes('title="工作空间：/abs/projects/iknow"'),
      "must include active root in title"
    );
    assert.ok(html.includes("📁"), "must include folder glyph");
    assert.ok(
      !html.includes("选择工作空间"),
      "must NOT render unbound CTA when active root present"
    );
  });

  it("activeWorkspaceRoot + ws.bound=true (根不一致) → 显示 active 优先", () => {
    const html = renderToStaticMarkup(
      <WorkspaceChip
        bound={true}
        root="/abs/other"
        activeWorkspaceRoot="/abs/projects/active"
        onOpen={() => {}}
      />
    );
    // "switching root = new session": the user moved to a new session while the picker's
    // ws.root has not refreshed yet — in this transient state the chip shows the active
    // session's root (highest priority).
    assert.ok(html.includes("active"), "must render active root basename");
    assert.ok(
      !html.includes("other"),
      "must NOT render stale ws.root when active differs"
    );
  });

  it("activeWorkspaceRoot 空字符串 → 退到 bound/root 兜底", () => {
    const html = renderToStaticMarkup(
      <WorkspaceChip
        bound={true}
        root="/abs/projects/fallback"
        activeWorkspaceRoot=""
        onOpen={() => {}}
      />
    );
    assert.ok(
      html.includes("fallback"),
      "empty activeWorkspaceRoot must fall back to ws.root basename"
    );
  });

  it("activeWorkspaceRoot=null + bound=true → 显示 ws.root basename", () => {
    const html = renderToStaticMarkup(
      <WorkspaceChip
        bound={true}
        root="/abs/projects/fb"
        activeWorkspaceRoot={null}
        onOpen={() => {}}
      />
    );
    assert.ok(html.includes("fb"), "null activeWorkspaceRoot must fall back");
  });

  it("activeWorkspaceRoot=undefined + bound=false → unbound CTA 兜底", () => {
    const html = renderToStaticMarkup(
      <WorkspaceChip
        bound={false}
        root={null}
        activeWorkspaceRoot={undefined}
        onOpen={() => {}}
      />
    );
    assert.ok(
      html.includes("选择工作空间"),
      "must render unbound CTA when all empty"
    );
    assert.ok(html.includes("bg-warn-soft"), "must include warn-soft color");
  });
});

/**
 * WorkspacePicker popover shell — the a11y trio:
 *  - role="dialog"
 *  - aria-modal="true"
 *  - aria-labelledby pointing at the sr-only title (h2#workspace-picker-title)
 *  - zero div/span onClick (a11y red line)
 */
describe("WorkspacePicker — T8 popover shell + a11y", () => {
  it("popover shell 含 role=dialog + aria-modal + aria-labelledby 链到 sr-only h2", () => {
    const html = renderToStaticMarkup(
      <WorkspacePicker
        recents={["/abs/a"]}
        currentRoot={null}
        onBind={async () => {}}
        onClose={() => {}}
        onNotice={() => {}}
        onBrowseSubdirs={async () => []}
      />
    );
    assert.ok(html.includes('role="dialog"'), "must render role=dialog");
    assert.ok(
      html.includes('aria-modal="true"'),
      "must declare aria-modal=true"
    );
    assert.ok(
      html.includes('aria-labelledby="workspace-picker-title"'),
      "must link aria-labelledby to popover title id"
    );
    assert.ok(
      html.includes('id="workspace-picker-title"'),
      "must render h2 with workspace-picker-title id"
    );
  });

  it("popover 含边框 + shadow (既有 token), 不挤消息区", () => {
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
    assert.ok(html.includes("border-line"), "popover must have border-line");
    assert.ok(
      html.includes("shadow-bubble"),
      "popover must have shadow-bubble"
    );
  });

  it("popover 全树零 div onClick / span onClick (a11y 红线)", () => {
    const html = renderToStaticMarkup(
      <WorkspacePicker
        recents={["/abs/a", "/abs/b"]}
        currentRoot="/abs/a"
        onBind={async () => {}}
        onClose={() => {}}
        onNotice={() => {}}
        onBrowseSubdirs={async () => []}
      />
    );
    assert.ok(
      !/<div[^>]*\sonClick=/.test(html),
      "must NOT contain <div onClick> (a11y red line)"
    );
    assert.ok(
      !/<span[^>]*\sonClick=/.test(html),
      "must NOT contain <span onClick> (a11y red line)"
    );
  });

  it("recents 首项打 data-ws-picker-autofocus 锚点 (auto-open 后焦点进 popover)", () => {
    const html = renderToStaticMarkup(
      <WorkspacePicker
        recents={["/abs/projects/first", "/abs/second"]}
        currentRoot={null}
        onBind={async () => {}}
        onClose={() => {}}
        onNotice={() => {}}
        onBrowseSubdirs={async () => []}
      />
    );
    // the first recent button should carry the autofocus anchor; the second must not.
    const firstButtonMatch = html.match(
      /data-workspace-path="\/abs\/projects\/first"[^>]*data-ws-picker-autofocus/
    );
    assert.ok(
      firstButtonMatch,
      "first recents button must declare data-ws-picker-autofocus"
    );
    const secondButtonMatch = html.match(
      /data-workspace-path="\/abs\/second"[^>]*data-ws-picker-autofocus/
    );
    assert.equal(
      secondButtonMatch,
      null,
      "second recents button must NOT carry autofocus anchor"
    );
  });

  it("recents 空 → path picker input 打 autofocus 锚点 (auto-open 后焦点进 input)", () => {
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
    // the path picker input should carry the autofocus anchor.
    assert.ok(
      html.includes('aria-label="工作空间绝对路径"'),
      "must render path input when recents empty"
    );
    assert.ok(
      html.match(
        /aria-label="工作空间绝对路径"[^>]*data-ws-picker-autofocus/
      ) ||
        html.match(
          /data-ws-picker-autofocus[^>]*aria-label="工作空间绝对路径"/
        ),
      "path input must carry data-ws-picker-autofocus when recents empty"
    );
  });
});
