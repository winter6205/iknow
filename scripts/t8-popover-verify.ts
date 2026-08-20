/**
 * serve-workspace T8 — Playwright verification for popover shape.
 *
 * 验证:
 *  (a) chip 三态切换 (unbound CTA → bound basename)
 *  (b) popover 打开不挤消息区 (MessageList 高度 0 变化)
 *  (c) Esc 关 + 焦点回 chip
 *  (d) outside-click 关
 *  (e) pickRecent 后关
 *  (f) 视觉无 layout shift
 *
 * 前置: npm run serve (后台), http://127.0.0.1:8787 可达。
 * stub backend mock: bindWorkspace / listSessions / workspace / workspaces
 * (需要 pre-populate; 此脚本独立可达, 不依赖真实 serve workspace)。
 */
// CJS-friendly import — playwright ESM exports 在不同 node 版本下偶发
// resolution 错, 用 createRequire 兜底。
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const BASE = process.env.IKNOW_VERIFY_URL ?? "http://127.0.0.1:8787";

interface SessionOverride {
  state?: "bound" | "unbound";
  root?: string;
  recents?: string[];
  sessions?: Array<{
    conversation_id: string;
    updatedAt: string;
    lastFinalText: string;
    workspaceRoot?: string;
  }>;
}

async function runScenario(label: string, ov: SessionOverride): Promise<void> {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  // Stub API responses (serve 真实依赖 workspace picker + session list)
  // 1) /api/v1/health
  await page.route("**/api/v1/health", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        service: "iknow-session-api",
        version: "0.1.0",
        contextWindow: 200000,
        model: "minimax-cn/MiniMax-M3",
      }),
    })
  );
  // 2) /api/v1/workspace
  await page.route("**/api/v1/workspace", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        bound: ov.state === "bound",
        root: ov.root ?? null,
      }),
    })
  );
  // 3) /api/v1/workspaces (recents)
  await page.route("**/api/v1/workspaces", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        workspaces: (ov.recents ?? []).map((r) => ({ root: r })),
      }),
    })
  );
  // 4) /api/v1/sessions
  await page.route("**/api/v1/sessions", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: ov.sessions ?? [
          {
            conversation_id: "conv-active",
            updatedAt: new Date().toISOString(),
            lastFinalText: "hi",
            workspaceRoot: ov.root ?? "/abs/projects/active",
          },
        ],
      }),
    })
  );
  // 5) /api/v1/sessions/*/messages — noop
  await page.route("**/api/v1/sessions/**", (route) => {
    if (route.request().method === "POST") {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          session: {
            conversation_id: "conv-active",
            json_mode: false,
            turn_count: 0,
            prior_count: 0,
          },
          turn: {
            query: "",
            answer: { finalText: "", stopReason: "completed", turnCount: 0 },
          },
        }),
      });
    } else {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          session: {
            conversation_id: "conv-active",
            json_mode: false,
            turn_count: 0,
            prior_count: 0,
          },
          turns: [],
        }),
      });
    }
  });
  await page.route("**/api/v1/skills", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ skills: [] }),
    })
  );
  await page.route("**/api/v1/mcp", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ servers: [], tools: [] }),
    })
  );
  await page.route("**/api/v1/subagents", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ subagents: [] }),
    })
  );

  await page.goto(BASE);
  await page.waitForLoadState("networkidle");

  // Chip 三态校验
  const chipText = await page
    .locator('button[aria-label*="工作空间"]')
    .first()
    .textContent();

  // 测 MessageList 高度 popover 开前
  const before = await page.evaluate(() => {
    const main = document.querySelector("main");
    return main ? main.getBoundingClientRect().height : 0;
  });

  // 点 chip 开 popover
  await page.locator('button[aria-label*="工作空间"]').first().click();
  await page.waitForTimeout(200);

  const dialogVisible = await page
    .locator('[role="dialog"][aria-modal="true"]')
    .isVisible();

  const after = await page.evaluate(() => {
    const main = document.querySelector("main");
    return main ? main.getBoundingClientRect().height : 0;
  });
  const layoutShift = Math.abs(after - before);

  // Esc 关 + 焦点回 chip
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  const dialogClosed = !(await page
    .locator('[role="dialog"][aria-modal="true"]')
    .isVisible());
  const focusedAfterEsc = await page.evaluate(() => {
    const el = document.activeElement;
    return el ? el.getAttribute("aria-label") : null;
  });

  // outside-click 关
  await page.locator('button[aria-label*="工作空间"]').first().click();
  await page.waitForTimeout(200);
  await page.mouse.click(50, 50); // outside popover + chip
  await page.waitForTimeout(200);
  const outsideClosed = !(await page
    .locator('[role="dialog"][aria-modal="true"]')
    .isVisible());

  // pickRecent 关 (recents 在 dialog 内 → click first recent)
  if (ov.recents && ov.recents.length > 0) {
    // 重开 popover (after outside-click 关)
    await page.locator('button[aria-label*="工作空间"]').first().click();
    await page.waitForTimeout(200);
    const recentsBtn = page.locator("[data-workspace-path]").first();
    const recentsBtnVisible = await recentsBtn.isVisible();
    if (recentsBtnVisible) {
      await recentsBtn.click();
      await page.waitForTimeout(300);
    }
    const recentClosed = !(await page
      .locator('[role="dialog"][aria-modal="true"]')
      .isVisible());
    console.log(
      JSON.stringify(
        {
          label,
          chipText: chipText?.trim().slice(0, 80),
          dialogVisible,
          layoutShiftPx: layoutShift,
          escClosed: dialogClosed,
          focusedAfterEsc,
          outsideClosed,
          recentClosed,
        },
        null,
        2
      )
    );
  } else {
    console.log(
      JSON.stringify(
        {
          label,
          chipText: chipText?.trim().slice(0, 80),
          dialogVisible,
          layoutShiftPx: layoutShift,
          escClosed: dialogClosed,
          focusedAfterEsc,
          outsideClosed,
          recentClosed: null,
        },
        null,
        2
      )
    );
  }

  await browser.close();
}

const scenarios: Array<{ label: string; ov: SessionOverride }> = [
  {
    label: "unbound-no-recents",
    ov: { state: "unbound", root: null, recents: [] },
  },
  {
    label: "bound-active-session-workspaceRoot",
    ov: {
      state: "bound",
      root: "/abs/projects/picker",
      recents: ["/abs/projects/picker", "/abs/projects/other"],
      sessions: [
        {
          conversation_id: "conv-active",
          updatedAt: new Date().toISOString(),
          lastFinalText: "hi",
          workspaceRoot: "/abs/projects/session-root",
        },
      ],
    },
  },
];

(async () => {
  for (const s of scenarios) {
    await runScenario(s.label, s.ov);
  }
})();
