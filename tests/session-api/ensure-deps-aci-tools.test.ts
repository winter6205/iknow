/**
 * `SessionHub.ensureDeps` integration pin.
 *
 * The fix for "serve mode stuck on echo/get_time stubs" is the SSOT
 * delegation in `src/session-api/hub.ts::ensureDeps`. The harness-level
 * test in `tests/harness/build-engine.test.ts` covers the SSOT directly;
 * this test covers the *wiring* — that calling `ensureDeps` on a hub
 * constructed without `deps` (the lazy path serve uses) returns the same
 * full ACI tool registry the CLI gets.
 *
 * Uses `createNoAskUser` so the permission middleware is bypassed (it is
 * not exercised here; the CLI path has its own coverage). The test
 * intentionally never calls `postMessage` — that would require a real LLM
 * response. The lookup of the private `ensureDeps` uses a typed escape
 * hatch (`as unknown as { ensureDeps: () => Promise<LoopEngineDeps> }`)
 * rather than exposing internals; if SSOT is moved, this test breaks
 * at the assignment and signals the refactor.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHub } from "../../src/session-api/hub.ts";
import { SessionStore } from "../../src/session-api/store/index.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import { createSkillBody } from "../../src/harness/skill/body.ts";
import { createSkillScanner } from "../../src/harness/skill/scanner.ts";
import type { LoopEngineDeps } from "../../src/harness/index.ts";
import { installTestSettingsSource } from "../_helpers/install-test-settings-source.ts";

// Append-only registry: membership and order mirror EXPECTED_TOOLS in
// tests/harness/build-engine.test.ts (SSOT). serve goes through the
// build-engine full assembly, so every group below is present.
const EXPECTED_TOOLS = [
  "bash",
  "read_file",
  "grep",
  "glob",
  "edit_file",
  "write_file",
  "web_fetch",
  "web_search",
  "memory_recall",
  "memory_save",
  "tool_search",
  // skill tool set, append-only (static list after skillCatalog assembly;
  // skill_search was later removed, leaving this one).
  "skill",
  // subagent tools, append-only (serve full assembly self-builds
  // subagentManager → both present).
  "spawn_subagent",
  "subagent_result",
  // todo_write, append-only (serve entry passes through todoDir → present,
  // matching the build-engine assembly side).
  "todo_write",
  // MCP resource tools, append-only (mcpManager self-built in full
  // assembly → both present).
  "list_mcp_resources",
  "read_mcp_resource",
  // background bash controls, append-only (backgroundManager self-built
  // when surface !== "ask" → both enter the registry; bash stays resident,
  // per-call background:true is decided by the handler at runtime).
  "bash_output",
  "bash_stop",
  // run_graph is resident — absent from the registry only when
  // subagentManager is absent (an absent graphAssembly is gated by the
  // handler's isEnabled default-off, so tool-face membership is unchanged).
  // serve full assembly includes subagentManager → run_graph enters,
  // byte-identical with promptTools on the adjacent turn.
  "run_graph",
  "query_trace",
  // symbol-query tool set, append-only, resident (shares lspCtx with the
  // lsp.ts SSOT; the former lsp_* set is retired).
  "find_symbol",
  "find_declaration",
  "find_referencing_symbols",
  "find_implementations",
  "get_symbols_overview",
  "get_hover",
  "get_diagnostics_for_file",
  "prepare_call_hierarchy",
  "list_incoming_calls",
  "list_outgoing_calls",
  // symbol-write tool set, append-only, resident (category=write; not
  // conditioned — shares lspCtx with the query side; onEdit is piped from
  // build-engine lspNotifier.invalidate, same post-write textDocument/
  // didChange pipeline as edit_file).
  "rename_symbol",
  "replace_symbol_body",
  "insert_before_symbol",
  "insert_after_symbol",
  "safe_delete_symbol",
  // trace read-side catalog axis, append-only, resident (no assembly
  // condition → always present in full assembly; mirrors build-engine).
  "list_sessions",
  // trace read-side content axis, append-only, resident (unconditional like
  // the catalog axis; three-axis order = append order, existing entries are
  // never reordered).
  "get_record",
  // ADR-0037: the five worktree ACI tools are driven by host-seam presence
  // (decoupled from isolation.worktreeOnMutate). The session-api hub is a
  // host that always wires all five (two buildHarnessEngine call sites in
  // hub.ts), so the serve-path registry equals ACI_TOOLSET_NAMES in full,
  // independent of toggle state.
  "create-worktree",
  "enter-worktree",
  "exit-worktree",
  "list-worktrees",
  "remove-worktree",
  // ADR-0101 / ADR-0102, append-only: serve full assembly self-builds
  // subagentManager → both present at the tail.
  "subagent_stop",
  "subagent_continue",
  // read_image, append-only: resident (no absence condition, specs/
  // read-image-vision.md SC6) → always present in full assembly.
  "read_image",
];

let baseDir: string;
let store: SessionStore;
let settingsSource: ReturnType<typeof installTestSettingsSource>;

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-ensure-deps-"));
  store = new SessionStore(baseDir, process.cwd());
  // IKNOW_LLM_MODEL is retired; the ensureDeps → buildHarnessEngine path
  // needs settings.llm.model + apiKey source → redirect HOME to tmp.
  settingsSource = installTestSettingsSource();
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
  settingsSource.restore();
});

describe("SessionHub.ensureDeps (lazy SSOT delegation)", () => {
  it("returns the full ACI registry (incl. todo_write + run_graph + the five worktree tools) when serve constructs without deps", async () => {
    const hub = new SessionHub({
      store,
      askUser: createNoAskUser(),
    });
    const ensure = (
      hub as unknown as { ensureDeps: () => Promise<LoopEngineDeps> }
    ).ensureDeps.bind(hub);

    const deps = await ensure();
    const names = deps.registry.list().map((def) => def.name);
    // serve entry injects todoDir → todo_write assembled; the full SSOT
    // registry is present (assembly conditions per group comment above).
    for (const expected of EXPECTED_TOOLS) {
      expect(names).toContain(expected);
    }
    expect(names).toHaveLength(EXPECTED_TOOLS.length);
    expect(names).toContain("todo_write");
    expect(names).toContain("run_graph");
  });
});

// Same skill entering context through three paths (TUI slash envelope / hub
// loadSkillBody / ACI skill()) must produce a body byte-identical to the
// createSkillBody product (one shared assembly point; the assembly shape is
// pinned by tests/skill/body.test.ts). The ACI leg is covered by
// tests/harness/aci/tools/skill-output-cap.test.ts; this describe adds the
// hub leg. The expected side never hand-builds an entry: the real catalog
// entry read at assembly time (the same read point loadSkillBody uses
// internally) is the evidence that "delivered body's dir = catalog entry's
// dir"; a hand-built entry would bypass that link. ADR-0079: even if an
// active taskRoot was captured at assembly time, hub-side bodies no longer
// render a write-root trailer — pinned jointly by byte-equality plus the
// no-write-root-section assertions. The slash face follows the same contract
// by derivation (no separate assembly test).
describe("SessionHub.loadSkillBody — 正文不挂写根（ADR-0079 / SC2）", () => {
  it("build-engine 装配后 loadSkillBody 正文与 createSkillBody 逐字节相等，末段 </skill_files>，不出现 current write root", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const skillDir = join(baseDir, "skills-wrt", "wrt-echo");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: wrt-echo\ndescription: echo\n---\nbody line\n",
      "utf8"
    );
    // Scan-root injection: IKNOW_SKILL_DIRS is one of the scanner's three
    // root channels; the tmp fixture enters the catalog through it without
    // relying on the cwd/.iknow convention.
    const prevSkillDirs = process.env.IKNOW_SKILL_DIRS;
    process.env.IKNOW_SKILL_DIRS = join(baseDir, "skills-wrt");
    try {
      const hub = new SessionHub({
        store,
        askUser: createNoAskUser(),
      });
      const load = hub as unknown as {
        ensureDeps: () => Promise<LoopEngineDeps>;
        loadSkillBody: (
          name: string
        ) => Promise<{ name: string; body: string }>;
      };
      await load.ensureDeps();
      // Expected value taken from the same read point used at assembly:
      // hub's skillCatalog is built by build-engine via the scanner over
      // three roots (userHome / projectIdentityRoot / IKNOW_SKILL_DIRS),
      // and loadSkillBody reads by entry.dir internally. Re-scanning here
      // with an identically-shaped scanner (settingsSource.home shares the
      // production assembly source) yields the real entry actually consumed
      // by the delivery path — no hand-built entry.
      const catalog = await createSkillScanner({
        userHome: settingsSource.home,
        projectIdentityRoot: process.cwd(),
        env: process.env,
      }).scan();
      const entry = catalog.find((candidate) => candidate.name === "wrt-echo");
      assert.ok(entry !== undefined, "fixture 必须经扫描根进 catalog");
      const expected = await createSkillBody({ entry, dir: entry.dir });

      const { body } = await load.loadSkillBody("wrt-echo");
      assert.equal(
        body,
        expected,
        "hub 交付正文必须与 createSkillBody 产物逐字节相等（SC2 三路同源）"
      );
      assert.ok(body.includes("body line"), "skill 自身正文必须保留");
      assert.ok(
        !body.includes("current write root"),
        "正文末尾不得出现写根段（ADR-0079：trailer 退场）"
      );
      assert.ok(
        !body.includes("no writable root"),
        "正文末尾不得出现 ③ 态披露（ADR-0079：trailer 退场）"
      );
      assert.ok(
        body.trimEnd().endsWith("</skill_files>"),
        "末段必须是 </skill_files>，与 #337 SC6 形态逐字节一致"
      );
    } finally {
      if (prevSkillDirs === undefined) {
        delete process.env.IKNOW_SKILL_DIRS;
      } else {
        process.env.IKNOW_SKILL_DIRS = prevSkillDirs;
      }
    }
  });
});

// specs/skill-index-increment.md SC5/SC6/SC9: the human-side slash works on
// the loadable-skill face. listSkills must contain entries lacking
// description and with disable-model-invocation, and an absent description
// stays undefined (never coerced to "" masquerading as an empty one);
// loadSkillBody rejects only `get` misses — disable gates the model index
// and skill(), never disk reads. Fixtures go through the real scanner (a
// hand-built entry would bypass the description/disabled semantics), same
// injection channel as the describe above.
describe("SessionHub skills 面 — 可加载面含无描述/disable（SC5/SC6/SC9）", () => {
  const plant = async (
    base: string,
    spec: { name: string; matter: string; text: string }
  ): Promise<void> => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const dir = join(base, spec.name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      `---\n${spec.matter}\n---\n${spec.text}\n`,
      "utf8"
    );
  };

  it("listSkills 含无 description 条目（description 缺席非空串）与 disable 条目；loadSkillBody 对 disable 条目仍交付正文", async () => {
    const skillRoot = join(baseDir, "skills-loadable");
    await plant(skillRoot, {
      name: "no-desc",
      matter: "name: no-desc",
      text: "# 无描述技能",
    });
    await plant(skillRoot, {
      name: "manual-only",
      matter:
        "name: manual-only\ndescription: 仅人侧\ndisable-model-invocation: true",
      text: "# 手动技能",
    });
    const prevSkillDirs = process.env.IKNOW_SKILL_DIRS;
    process.env.IKNOW_SKILL_DIRS = skillRoot;
    try {
      const hub = new SessionHub({ store, askUser: createNoAskUser() });
      const api = hub as unknown as {
        ensureDeps: () => Promise<LoopEngineDeps>;
        listSkills: () => Promise<
          readonly { name: string; description?: string }[]
        >;
        loadSkillBody: (
          name: string
        ) => Promise<{ name: string; body: string }>;
      };
      await api.ensureDeps();

      const skills = await api.listSkills();
      const byName = new Map(skills.map((s) => [s.name, s]));
      // SC9: the two faces' difference is visible on the DTO — both entries
      // are on the loadable face.
      assert.ok(
        byName.has("no-desc"),
        "无 description 条目必须进可加载面（SC9）"
      );
      assert.ok(byName.has("manual-only"), "disable 条目必须进可加载面（SC6）");
      // SC5: absence stays absence — never coerced to "" ("" would render as
      // an "empty description" host-side).
      assert.equal(
        Object.prototype.hasOwnProperty.call(
          byName.get("no-desc"),
          "description"
        ),
        false,
        '无 description 条目不得携带 description 键（不补 ""）'
      );
      assert.equal(byName.get("manual-only")?.description, "仅人侧");
      // The model-index face must NOT contain either entry (diverging from
      // the loadable face is the loadable face's reason to exist).
      const catalog = (
        hub as unknown as {
          skillCatalog?: { modelIndex(): readonly { name: string }[] };
        }
      ).skillCatalog;
      const indexed = (catalog?.modelIndex() ?? []).map((e) => e.name);
      assert.ok(!indexed.includes("no-desc"), "无描述条目不得进模型索引");
      assert.ok(!indexed.includes("manual-only"), "disable 条目不得进模型索引");

      // SC6: disable gates only the model index and skill(); human-side disk
      // reads are not blocked.
      const { body } = await api.loadSkillBody("manual-only");
      assert.ok(body.includes("# 手动技能"), "disable 技能正文必须可读");
      // SC5: the no-description entry is equally readable.
      const noDesc = await api.loadSkillBody("no-desc");
      assert.ok(noDesc.body.includes("# 无描述技能"));
      await assert.rejects(
        () => api.loadSkillBody("no-such-skill"),
        /skill not found/,
        "get miss 仍必须拒绝"
      );
    } finally {
      if (prevSkillDirs === undefined) {
        delete process.env.IKNOW_SKILL_DIRS;
      } else {
        process.env.IKNOW_SKILL_DIRS = prevSkillDirs;
      }
    }
  });
});
