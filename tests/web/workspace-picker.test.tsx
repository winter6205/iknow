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
    // recents 段标题 + 内容
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
    // path picker 默认折叠: input / trust / bind 不在 DOM
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
    // 折叠 CTA 存在 + aria-expanded=false + aria-controls
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
    // path picker 默认展开
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
    // 子目录浏览器折叠按钮 (浏览器内仍需折叠, 不空请求)
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
    // recents <li><button> 节点不应再贴 pill 类。路径里没有 ws-path-picker 内
    // 的子目录 list (折叠态), 所以全 html 范围内 recents 列表项不应出现 rounded-pill。
    assert.ok(
      !html.includes("rounded-pill"),
      "T5: list items must drop rounded-pill (use rounded-md)"
    );
    // 收紧 → 替换为小圆角 (rounded-md 即 Tailwind 6px, 或等效 rounded-[6px])
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
    // 折叠 CTA 是 <button>, aria-expanded + aria-controls 都在, 不允许 <div/span onClick>
    assert.ok(
      html.includes('aria-controls="ws-path-picker-panel"'),
      "fold CTA must declare aria-controls"
    );
    // recents 列表项也都是 <button> (静态 markup 检验 — 无 div onClick)
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
 * serve-workspace T8: WorkspaceChip 上下文感知 — 显示优先级
 *  1. activeWorkspaceRoot 优先（用户切到某工作空间内的会话后, chip 显示该根名）
 *  2. 否则 bound + root（picker 兜底）
 *  3. 否则 unbound CTA（warn color）
 *
 * 三态都用 <button> (a11y); 永远可点击触发 popover。
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
    // spec §Commands 5 "换根 = 新会话" — 用户切到新会话但 picker ws.root 还没刷新
    // 这种临时态下, chip 显示 active 会话所在根 (优先级最高)。
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
 * serve-workspace T8: WorkspacePicker popover shell — a11y 三件套
 *  - role="dialog"
 *  - aria-modal="true"
 *  - aria-labelledby 指向 sr-only 标题 (h2#workspace-picker-title)
 *  - 零 div/span onClick (a11y 红线)
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
    // 第一项 recent button 应有 autofocus 锚点; 第二项无。
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
    // path picker input 应有 autofocus 锚点。
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
