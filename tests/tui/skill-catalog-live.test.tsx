/** @jsxImportSource @opentui/react */
/**
 * tests/tui/skill-catalog-live.test.tsx
 *
 * `specs/skill-index-increment.md` SC8（slash 侧）—— TUI 斜杠候选面「当场
 * 热」的三条不变式：
 *
 *   1. 面板**打开**（输入 "/" 上升沿）→ 经 T6 rescan 缝重扫，现行可加载面
 *      替换装配期缓存（会话中途落盘的 SKILL.md 立刻进候选，不必等下一 turn）；
 *   2. rescan **失败**（typed `SkillRescanError`）→ 保留缓存候选、不抛、不
 *      清空（人侧宽松面：坏根不该让人连既有 `/help` 都用不了），失败经
 *      notice 呈现且带 faults 明细（typed-error catch 契约）；
 *   3. 缝**缺席**（fixture / ask）→ 恒等透传缓存 catalog（旧行为逐字节一致）。
 *
 * 端到端那一条走真实 TuiApp + mockInput 按键 + captureCharFrame —— 与当初
 * 坐实 SC8 缺失（「一轮 turn 之后 /live 仍无候选」）的探针同一条路径。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import type { TestRendererSetup } from "@opentui/core/testing";
import {
  TuiApp,
  createToolEventSink,
  resolveSkillLoadSubmit,
} from "../../src/tui/app.js";
import { formatSkillRescanFailure } from "../../src/tui/skill-catalog-live.js";
import {
  createInflightRegistry,
  createTuiBridge,
  type TuiBridge,
} from "../../src/tui/hub-bridge.js";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { createSessionGrants } from "../../src/harness/permission/session-grants.js";
import { createSkillCatalog } from "../../src/harness/skill/catalog.js";
import { createSkillRescanner } from "../../src/harness/skill/rescan.js";
import { createSkillScanner } from "../../src/harness/skill/scanner.js";
import { SkillRescanError } from "../../src/harness/skill/rescan.js";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";

const roots: string[] = [];

async function makeRoots(): Promise<{ root: string; userHome: string }> {
  const root = await mkdtemp(join(tmpdir(), "iknow-tui-skill-live-"));
  roots.push(root);
  const userHome = join(root, "home");
  await mkdir(join(userHome, ".iknow", "skills"), { recursive: true });
  return { root, userHome };
}

/** 落一个 user 级 skill（`<userHome>/.iknow/skills/<name>/SKILL.md`）。 */
async function plantSkill(
  userHome: string,
  name: string,
  description: string
): Promise<void> {
  const dir = join(userHome, ".iknow", "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`,
    "utf8"
  );
}

async function untilFrame(
  setup: TestRendererSetup,
  pred: (frame: string) => boolean,
  ms = 8000
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 50));
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    if (pred(frame)) return frame;
  }
  throw new Error(`untilFrame timeout:\n${setup.captureCharFrame()}`);
}

/** 空 catalog（缝两端都缺的退化形态）。 */
function emptyCatalog() {
  return createSkillCatalog([]);
}

/** 装配期扫描（与真实 run.tsx 同路径：scanner → createSkillCatalog）。 */
async function scanCatalog(userHome: string, root: string) {
  const entries = await createSkillScanner({
    userHome,
    projectIdentityRoot: root,
    env: {},
  }).scan();
  return createSkillCatalog(entries);
}

interface DrivenApp {
  readonly bridge: TuiBridge;
  readonly setup: TestRendererSetup;
  readonly destroy: () => Promise<void>;
  readonly typeText: (text: string) => Promise<void>;
}

async function mountApp(input: {
  readonly skillCatalog: ReturnType<typeof createSkillCatalog>;
  readonly skillRescanner?: ReturnType<typeof createSkillRescanner>;
  readonly dataDir: string;
}): Promise<DrivenApp> {
  const bridge = createTuiBridge({
    dataDir: input.dataDir,
    workspaceRoot: input.dataDir,
    deps: makeDeps([assistantResult({ texts: ["ok"] })]),
    inflight: createInflightRegistry(),
  });
  const askBridge = createTuiAskUserBridge();
  let setupRef: TestRendererSetup | undefined;
  const setup = await testRender(
    <TuiApp
      bridge={bridge}
      askBridge={askBridge}
      toolEventSink={createToolEventSink()}
      cwd="/tmp/proj"
      dataDir={input.dataDir}
      permissionMode={createPermissionModeContext("default")}
      sessionGrants={createSessionGrants()}
      skillCatalog={input.skillCatalog}
      {...(input.skillRescanner !== undefined
        ? { skillRescanner: input.skillRescanner }
        : {})}
      onQuit={() => {
        if (setupRef && !setupRef.renderer.isDestroyed)
          setupRef.renderer.destroy();
      }}
    />,
    { width: 80, height: 60, exitOnCtrlC: false, consoleMode: "disabled" }
  );
  setupRef = setup;
  await new Promise((r) => setTimeout(r, 300));
  await setup.waitForVisualIdle();
  return {
    bridge,
    setup,
    destroy: async () => {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    },
    typeText: async (text: string) => {
      for (const ch of text) {
        setup.mockInput.pressKey(ch);
        await new Promise((r) => setTimeout(r, 30));
      }
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
    },
  };
}

describe("SC8 slash 当场热 — 打开面板即见中途落盘的 skill", () => {
  test("装配后落盘新 skill → 输入 / 即出候选（不等下一 turn）", async () => {
    const { root, userHome } = await makeRoots();
    await plantSkill(userHome, "before-scan", "开场就在的技能");
    // 装配期扫描：只有 before-scan（此刻 live-skill 尚未落盘 —— 正是 SC8
    // 的场景：会话中途才出现）。
    const frozenCatalog = await scanCatalog(userHome, root);
    expect(frozenCatalog.loadable().map((e) => e.name)).toEqual([
      "before-scan",
    ]);

    const rescanner = createSkillRescanner({
      userHome,
      projectIdentityRoot: root,
      env: {},
    });
    // 会话中途落盘（「安装当下」）。
    await plantSkill(userHome, "live-skill", "会话中途落盘的技能");

    const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-live-data-"));
    const app = await mountApp({
      skillCatalog: frozenCatalog,
      skillRescanner: rescanner,
      dataDir,
    });
    try {
      await untilFrame(app.setup, (f) => f.includes("Version"));
      // 无本 hook 时：候选恒为冻表 → 这里只会看到 /before-scan。打开面板
      // → rescan → live-skill 进候选（SC8 的判据）。
      await app.typeText("/live");
      await untilFrame(app.setup, (f) => f.includes("/live-skill"), 8000);
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("rescan 失败（typed SkillRescanError）→ 保留缓存候选 + notice，不抛不清空", async () => {
    const { root, userHome } = await makeRoots();
    await plantSkill(userHome, "before-scan", "开场就在的技能");
    const frozenCatalog = await scanCatalog(userHome, root);

    const realRescanner = createSkillRescanner({
      userHome,
      projectIdentityRoot: root,
      env: {},
    });
    // 确定性失败：坏根 = 扫描根 chmod 000（根 readdir 必 EACCES → typed
    // SkillRescanError；ENOENT 才是合法空态）。真实 chmod 而非 stub —— 失败
    // 是从 scanner 的 onIoFailure 通道真造出来的（tests/skill/index-delta
    // 同款夹具）。用 user 技能根而非插件根：前者必然在扫描面内，不受
    // 「插件根是否被 consumer 走」影响。
    const skillRoot = join(userHome, ".iknow", "skills");
    await chmod(skillRoot, 0o000);

    const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-live-data-"));
    const app = await mountApp({
      skillCatalog: frozenCatalog,
      skillRescanner: realRescanner,
      dataDir,
    });
    try {
      await untilFrame(app.setup, (f) => f.includes("Version"));
      await app.typeText("/before");
      // 失败面两条同时成立：缓存候选仍在（不清空）+ notice 带 faults 明细
      // （而非 [object Object]）。
      await untilFrame(app.setup, (f) => f.includes("/before-scan"), 8000);
      await untilFrame(app.setup, (f) => f.includes("技能重扫失败"), 8000);
    } finally {
      await chmod(skillRoot, 0o755);
      await app.destroy();
    }
  }, 30_000);

  test("缝缺席 → 恒等透传缓存 catalog（旧行为逐字节一致）", async () => {
    const { root, userHome } = await makeRoots();
    await plantSkill(userHome, "before-scan", "开场就在的技能");
    const frozenCatalog = await scanCatalog(userHome, root);
    await plantSkill(userHome, "live-skill", "会话中途落盘的技能");

    const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-live-data-"));
    const app = await mountApp({ skillCatalog: frozenCatalog, dataDir });
    try {
      await untilFrame(app.setup, (f) => f.includes("Version"));
      await app.typeText("/live");
      // 缝缺席 → 不重扫 → live-skill 不出现（与本切片前的旧行为同）。
      await new Promise((r) => setTimeout(r, 500));
      await app.setup.renderOnce();
      expect(app.setup.captureCharFrame()).not.toContain("/live-skill");
    } finally {
      await app.destroy();
    }
  }, 30_000);
});

describe("SC8 提交期竞态 — 快速键入/粘贴后立刻 Enter", () => {
  // 真实 TUI 实测坐实的缺陷：面板打开时那次 rescan 是异步的，键入
  // `/zz-live` 后立刻 Enter（粘贴形态、无逐键停顿）会赶在它落地之前 ——
  // 只看缓存列表就把刚装的技能报成「未知命令」。下面直接钉提交期解析。
  test("缓存里没有、重扫后有了 → 必须 hit（不得报未知命令）", async () => {
    const { root, userHome } = await makeRoots();
    await plantSkill(userHome, "zz-frozen", "开场就在");
    const frozenCatalog = await scanCatalog(userHome, root);
    const rescanner = createSkillRescanner({
      userHome,
      projectIdentityRoot: root,
      env: {},
    });
    await plantSkill(userHome, "zz-live", "中途落盘");

    const outcome = await resolveSkillLoadSubmit({
      text: "/zz-live",
      catalog: frozenCatalog,
      rescanner,
    });
    expect(outcome.kind).toBe("send");
    if (outcome.kind === "send") {
      expect(outcome.sendText).toContain("zz-live");
    }
  });

  test("缓存里已有 → 直接 hit，不白扫（缓存命中零额外 IO）", async () => {
    const { root, userHome } = await makeRoots();
    await plantSkill(userHome, "zz-frozen", "开场就在");
    const frozenCatalog = await scanCatalog(userHome, root);
    let scans = 0;
    const rescanner = createSkillRescanner({
      userHome,
      projectIdentityRoot: root,
      env: {},
    });
    const counting = {
      ...rescanner,
      rescan: () => {
        scans += 1;
        return rescanner.rescan();
      },
    };
    const outcome = await resolveSkillLoadSubmit({
      text: "/zz-frozen",
      catalog: frozenCatalog,
      rescanner: counting,
    });
    expect(outcome.kind).toBe("send");
    expect(scans).toBe(0);
  });

  test("静态命令 /quit 不为一次 skill 判定白扫全根", async () => {
    const { root, userHome } = await makeRoots();
    const frozenCatalog = await scanCatalog(userHome, root);
    const rescanner = createSkillRescanner({
      userHome,
      projectIdentityRoot: root,
      env: {},
    });
    let scans = 0;
    const counting = {
      ...rescanner,
      rescan: () => {
        scans += 1;
        return rescanner.rescan();
      },
    };
    const outcome = await resolveSkillLoadSubmit({
      text: "/quit",
      catalog: frozenCatalog,
      rescanner: counting,
    });
    expect(outcome.kind).toBe("not-skill");
    expect(scans).toBe(0);
  });

  test("普通消息 → not-skill，不扫盘（调用方落回原分流）", async () => {
    const { root, userHome } = await makeRoots();
    const frozenCatalog = await scanCatalog(userHome, root);
    const rescanner = createSkillRescanner({
      userHome,
      projectIdentityRoot: root,
      env: {},
    });
    let scans = 0;
    const counting = {
      ...rescanner,
      rescan: () => {
        scans += 1;
        return rescanner.rescan();
      },
    };
    const outcome = await resolveSkillLoadSubmit({
      text: "你好呀",
      catalog: frozenCatalog,
      rescanner: counting,
    });
    expect(outcome.kind).toBe("not-skill");
    expect(scans).toBe(0);
  });

  test("catalog 与 rescanner 都缺 → miss 落回既有分流（旧行为）", async () => {
    const outcome = await resolveSkillLoadSubmit({
      text: "/nope",
      catalog: emptyCatalog(),
      rescanner: undefined,
    });
    expect(outcome.kind).toBe("not-skill");
  });
});

describe("formatSkillRescanFailure — typed-error catch 契约", () => {
  test("SkillRescanError → 文案带 faults 的 kind/path/code", () => {
    const err = new SkillRescanError([
      { kind: "root_unreadable", path: "/x/skills", code: "EACCES" },
      { kind: "file_unreadable", path: "/y/SKILL.md", code: undefined },
    ]);
    const text = formatSkillRescanFailure(err);
    expect(text).toContain("技能重扫失败");
    expect(text).toContain("root_unreadable");
    expect(text).toContain("/x/skills");
    expect(text).toContain("EACCES");
    expect(text).toContain("/y/SKILL.md");
    // 契约核心：不得退化成 [object Object]。
    expect(text).not.toContain("[object Object]");
  });

  test("非 rescan 形态（普通 Error）→ 退化 message，不冒充 rescan 故障", () => {
    expect(formatSkillRescanFailure(new Error("boom"))).toBe("boom");
    expect(formatSkillRescanFailure("plain")).toBe("plain");
  });

  test("plain object 错误 → 不得打成 [object Object]（typed-error 契约核心）", () => {
    // 契约禁止 `err instanceof Error ? err.message : String(err)`：plain
    // object 走 String() 会丢全部结构。sanctioned renderer（errorMessage）
    // 经 JSON.stringify 保住字段 —— 本断言在禁止形态上必红。
    const text = formatSkillRescanFailure({
      kind: "session_store_error",
      context: "conversation_id",
    });
    expect(text).not.toContain("[object Object]");
    expect(text).toContain("session_store_error");
  });
});

// `roots` 清理：bun:test 无全局 afterAll 跨文件，本文件内每个 test 自带
// try/finally destroy；tmp 目录留给 OS 回收（与 tests/tui 既有 fixture 同）。
void roots;
void rm;
