/** @jsxImportSource @opentui/react */
/**
 * tests/tui/skill-catalog-live.test.tsx
 *
 * `specs/skill-index-increment.md` SC8 (slash side) — three invariants for keeping the TUI
 * slash-candidate surface hot on the spot:
 *
 *   1. panel **opens** (rising edge of "/") → rescan through the rescan seam, the current
 *      loadable surface replaces the assembly-time cache (a SKILL.md written mid-session
 *      enters the candidates immediately, no need to wait for the next turn);
 *   2. rescan **fails** (typed `SkillRescanError`) → keep cached candidates, don't throw,
 *      don't clear (the human-facing lenient surface: a bad root shouldn't make even the
 *      existing `/help` unusable); the failure surfaces via notice with fault detail (typed-error catch contract);
 *   3. seam **absent** (fixture / ask) → pass through the cached catalog identically (byte-for-byte the old behavior).
 *
 * The end-to-end case drives the real TuiApp + mockInput keys + captureCharFrame — the same
 * path that first pinned the SC8 gap (after one turn, /live still had no candidate).
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

/** plant a user-level skill (`<userHome>/.iknow/skills/<name>/SKILL.md`). */
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

/** empty catalog (degenerate shape with the seam missing on both ends). */
function emptyCatalog() {
  return createSkillCatalog([]);
}

/** assembly-time scan (same path as real run.tsx: scanner → createSkillCatalog). */
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
    // assembly-time scan: only before-scan (live-skill isn't on disk yet — exactly the
    // SC8 scenario: it appears mid-session).
    const frozenCatalog = await scanCatalog(userHome, root);
    expect(frozenCatalog.loadable().map((e) => e.name)).toEqual([
      "before-scan",
    ]);

    const rescanner = createSkillRescanner({
      userHome,
      projectIdentityRoot: root,
      env: {},
    });
    // written mid-session (the "moment of install").
    await plantSkill(userHome, "live-skill", "会话中途落盘的技能");

    const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-live-data-"));
    const app = await mountApp({
      skillCatalog: frozenCatalog,
      skillRescanner: rescanner,
      dataDir,
    });
    try {
      await untilFrame(app.setup, (f) => f.includes("Version"));
      // without this hook: candidates stay the frozen table → only /before-scan visible here.
      // opening the panel → rescan → live-skill enters candidates (SC8's criterion).
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
    // deterministic failure: bad root = scan root chmod 000 (root readdir must EACCES → typed
    // SkillRescanError; only ENOENT is a legal empty state). real chmod rather than a stub — the
    // failure is genuinely produced via the scanner's onIoFailure channel (same fixture as
    // tests/skill/index-delta). use the user skill root not the plugin root: the former is always
    // in the scan surface, unaffected by "whether the plugin root is walked by a consumer".
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
      // both halves of the failure surface hold: cached candidates remain (not cleared)
      // + notice carries faults detail (not [object Object]).
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
      // seam absent → no rescan → live-skill never appears (same as the old pre-change behavior).
      await new Promise((r) => setTimeout(r, 500));
      await app.setup.renderOnce();
      expect(app.setup.captureCharFrame()).not.toContain("/live-skill");
    } finally {
      await app.destroy();
    }
  }, 30_000);
});

describe("SC8 提交期竞态 — 快速键入/粘贴后立刻 Enter", () => {
  // defect confirmed on the real TUI: the rescan on panel open is async, so typing
  // `/zz-live` and hitting Enter immediately (paste shape, no per-key pause) can beat it —
  // consulting only the cached list reports the just-installed skill as 「未知命令」 ("unknown command").
  // The cases below pin submit-time resolution directly.
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
    // contract core: must never degrade to [object Object].
    expect(text).not.toContain("[object Object]");
  });

  test("非 rescan 形态（普通 Error）→ 退化 message，不冒充 rescan 故障", () => {
    expect(formatSkillRescanFailure(new Error("boom"))).toBe("boom");
    expect(formatSkillRescanFailure("plain")).toBe("plain");
  });

  test("plain object 错误 → 不得打成 [object Object]（typed-error 契约核心）", () => {
    // the contract forbids `err instanceof Error ? err.message : String(err)`: a plain
    // object through String() loses all structure. the sanctioned renderer (errorMessage)
    // keeps fields via JSON.stringify — this assertion must go red on the forbidden shape.
    const text = formatSkillRescanFailure({
      kind: "session_store_error",
      context: "conversation_id",
    });
    expect(text).not.toContain("[object Object]");
    expect(text).toContain("session_store_error");
  });
});

// `roots` cleanup: bun:test has no cross-file global afterAll, so every test here carries its
// own try/finally destroy; tmp dirs are left for OS reclaim (same as existing tests/tui fixtures).
void roots;
void rm;
