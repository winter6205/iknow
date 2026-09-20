/**
 * tests/tui/tool-settled.test.ts
 *
 * Strategy-core deriveSlot table tests:
 *  - successful read_file settles retracts (showTitle/showPreview both false,
 *    joins the fold count); failure cuts across as the error shape (error
 *    takes priority over any class);
 *  - five boundary classes: empty (N/A for a pure function -- empty-list
 *    semantics belong to callers) / negative (unregistered names default to
 *    retract) / overflow (>=20 names each inFoldCount true; the flattened
 *    count is aggregated by callers) / concurrent (all running tools visible
 *    one by one; the pure function has no shared mutable state) / exception
 *    (all three failure kinds unify to the error shape).
 *
 * This core is the single derived SSOT: the render layer only consumes slots
 * -- title / preview / fold count / color all derive from the core; the
 * render layer never composes its own hiding or preview switches.
 */
import { describe, expect, test } from "bun:test";
import {
  deriveSlot,
  isLiveNoise,
  settledClassOf,
  TOOL_SETTLED_CLASS,
  type SettledSlot,
} from "../../src/tui/tool-settled.js";
import {
  isSubagentTool,
  registeredToolDisplayNames,
} from "../../src/tui/tool-summary.js";

const RETRACT_SHAPE: SettledSlot = {
  showTitle: false,
  showPreview: false,
  inFoldCount: true,
  color: "default",
};

const ERROR_SHAPE: SettledSlot = {
  showTitle: true,
  showPreview: false,
  inFoldCount: false,
  color: "error",
};

describe("deriveSlot: SC1 单一派生", () => {
  test("read_file 落定成功 → 收（标题与预览同假、进折叠计数）", () => {
    expect(deriveSlot("read_file", { running: false, failed: false })).toEqual(
      RETRACT_SHAPE
    );
  });

  test("read_file 失败 → 失败横切（标题留、error 色、不进计数、无预览）", () => {
    expect(deriveSlot("read_file", { running: false, failed: true })).toEqual(
      ERROR_SHAPE
    );
  });

  test("read_image 在 class 表内显式登记为 retract（缺省兜底不算登记）", () => {
    // read-image-vision assumption 11: same class as read_file; registered
    // explicitly so summary consumers (direct TOOL_SETTLED_CLASS[name] lookup)
    // never hit an undefined hole.
    expect(
      Object.prototype.hasOwnProperty.call(TOOL_SETTLED_CLASS, "read_image")
    ).toBe(true);
    expect(TOOL_SETTLED_CLASS.read_image).toBe("retract");
    expect(settledClassOf("read_image")).toBe("retract");
    expect(deriveSlot("read_image", { running: false, failed: false })).toEqual(
      RETRACT_SHAPE
    );
  });
});

describe("deriveSlot: keep class（留的足迹，spec D4）", () => {
  test("bash 成功 → 标题 + 折叠结果预览（KEEP_WITH_PREVIEW）", () => {
    // docs/CONTEXT.md keep class: a successful bash keeps the command plus a
    // folded result preview.
    expect(deriveSlot("bash", { running: false, failed: false })).toEqual({
      showTitle: true,
      showPreview: true,
      inFoldCount: false,
      color: "default",
    });
  });

  test("write_file / edit_file 成功 → 标题 + 既有 6 行预览通道（不变）", () => {
    // docs/CONTEXT.md keep class: write/edit additionally keep a 6-line
    // completion preview -- on the same frame bash's preview is retracted, the
    // write/edit preview footprint must not be affected.
    for (const name of ["write_file", "edit_file"]) {
      expect(deriveSlot(name, { running: false, failed: false })).toEqual({
        showTitle: true,
        showPreview: true,
        inFoldCount: false,
        color: "default",
      });
    }
  });

  test("bash_stop / todo_write / memory_save 成功 → 只留标题", () => {
    for (const name of ["bash_stop", "todo_write", "memory_save"]) {
      expect(deriveSlot(name, { running: false, failed: false })).toEqual({
        showTitle: true,
        showPreview: false,
        inFoldCount: false,
        color: "default",
      });
    }
  });

  test("子代理工具（三类之外）→ 标题 alone、default 色（glyph 在渲染层）", () => {
    for (const name of ["spawn_subagent", "subagent_result"]) {
      expect(deriveSlot(name, { running: false, failed: false })).toEqual({
        showTitle: true,
        showPreview: false,
        inFoldCount: false,
        color: "default",
      });
    }
  });

  test("子代理集合单源：核内 class 表与 isSubagentTool 对注册表全集一致", () => {
    // The strategy core stays dependency-free (no registry import): "who is a
    // subagent" is expressed inside the core via class-table entries
    // ("subagent" class) and in tool-summary via isSubagentTool -- the two
    // independent lists must agree over the same universe: adding or removing
    // a subagent name on one side alone fails (drift gate).
    const universe = new Set<string>([
      ...registeredToolDisplayNames(),
      "spawn_subagent",
      "subagent_result",
    ]);
    for (const name of universe) {
      expect([name, settledClassOf(name) === "subagent"]).toEqual([
        name,
        isSubagentTool(name),
      ]);
    }
  });
});

describe("deriveSlot: accent class（点名着色，spec D6）", () => {
  test("skill / 建树四件成功 → accent 色、标题、无预览、不进计数", () => {
    for (const name of [
      "skill",
      "create-worktree",
      "enter-worktree",
      "exit-worktree",
      "remove-worktree",
    ]) {
      expect(deriveSlot(name, { running: false, failed: false })).toEqual({
        showTitle: true,
        showPreview: false,
        inFoldCount: false,
        color: "accent",
      });
    }
  });
});

describe("deriveSlot: SC2 五类边界", () => {
  // empty: N/A for pure deriveSlot -- with zero tools the caller holds an empty
  // list and never calls the core; the "zero rows draw no count line" semantics
  // is certified by the caller (fold aggregation), not the core's duty.
  test("negative: 未注册名 → 缺省 retract、无预览、不进 keep/accent", () => {
    expect(settledClassOf("mystery_tool")).toBe("retract");
    expect(
      deriveSlot("mystery_tool", { running: false, failed: false })
    ).toEqual(RETRACT_SHAPE);
  });

  test("overflow: ≥20 个不同 retract 名逐一 inFoldCount 真（摊平成一行计数由调用方聚合）", () => {
    const retractNames = [
      "read_file",
      "grep",
      "glob",
      "web_search",
      "web_fetch",
      "memory_recall",
      "tool_search",
      // skill_search was deleted; unregistered names fall back to retract
      // (settledClassOf defaults unknown names to retract) -- not in the
      // declared table but historical replay can still trigger it.
      "skill_search",
      "bash_output",
      "list_mcp_resources",
      "read_mcp_resource",
      "query_trace",
      "list-worktrees",
      "lsp_definition",
      "lsp_references",
      "lsp_hover",
      "lsp_go_to_implementation",
      "lsp_prepare_call_hierarchy",
      "lsp_incoming_calls",
      "lsp_outgoing_calls",
      "lsp_diagnostics",
      "lsp_document_symbol",
      "lsp_workspace_symbol",
    ];
    expect(retractNames.length).toBeGreaterThanOrEqual(20);
    for (const name of retractNames) {
      expect(settledClassOf(name)).toBe("retract");
      expect(deriveSlot(name, { running: false, failed: false })).toEqual(
        RETRACT_SHAPE
      );
    }
  });

  test("concurrent: running 时三类样本 showTitle 真、inFoldCount 假（live 与 idle 互不串）", () => {
    // N/A: pure deriveSlot -- a pure function with no shared mutable state; running semantics are expressed via arguments.
    for (const name of ["bash", "read_file", "skill", "spawn_subagent"]) {
      const slot = deriveSlot(name, { running: true, failed: false });
      expect(slot.showTitle).toBe(true);
      expect(slot.inFoldCount).toBe(false);
    }
    // retract-class names do not linger in the sunk state while running (they do not enter the fold count early).
    expect(deriveSlot("read_file", { running: true, failed: false })).toEqual({
      showTitle: true,
      showPreview: false,
      inFoldCount: false,
      color: "default",
    });
  });

  test("exception: 三类各取一件失败 → error 形态逐字节一致（error 优先于 accent）", () => {
    for (const name of ["bash", "read_file", "skill"]) {
      expect(deriveSlot(name, { running: false, failed: true })).toEqual(
        ERROR_SHAPE
      );
    }
    // When an accent tool fails, error overrides the accent color (error has priority over accent).
    const accentFailed = deriveSlot("skill", {
      running: false,
      failed: true,
    });
    expect(accentFailed.color).toBe("error");
  });
});

describe("isLiveNoise（live 块入场判据，specs live-signal revision #3）", () => {
  // The settled counting rule is unchanged: web_search / web_fetch still belong to retract (locked). Live-block entry goes only through isLiveNoise -- web_* is not noise during the live phase, so it forms a real card rather than joining the unanchored block; every other retract name goes into the block.

  test("read_file / read_image / grep / glob / memory_recall → true（进 unanchored 块）", () => {
    // read_image is the same tier as read_file (read-image-vision assumption 11):
    // isLiveNoise has no standalone list, it derives from settledClassOf; this
    // case locks the derived result.
    for (const name of [
      "read_file",
      "read_image",
      "grep",
      "glob",
      "memory_recall",
    ]) {
      expect(isLiveNoise(name)).toBe(true);
    }
  });

  test("web_search / web_fetch → false（live signal 实卡）", () => {
    expect(isLiveNoise("web_search")).toBe(false);
    expect(isLiveNoise("web_fetch")).toBe(false);
  });

  test("未注册名 → true（spec「未注册名缺省仍当噪音」）", () => {
    expect(isLiveNoise("mystery_tool")).toBe(true);
  });

  test("keep / accent / subagent → false（不进 unanchored 块）", () => {
    for (const name of ["bash", "write_file", "skill", "spawn_subagent"]) {
      expect(isLiveNoise(name)).toBe(false);
    }
  });

  test("web_search / web_fetch 在 settledClassOf 上仍归 retract（计数口径不变）", () => {
    // Hold the lock: web_* still belongs to retract and enters the settled
    // counting -- the live-signal revision only changes live-block entry, never the settled counting.
    expect(settledClassOf("web_search")).toBe("retract");
    expect(settledClassOf("web_fetch")).toBe("retract");
  });
});
