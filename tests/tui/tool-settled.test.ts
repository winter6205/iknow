/**
 * tests/tui/tool-settled.test.ts
 *
 * 策略核 deriveSlot 表测（spec specs/tui-tool-settled-appearance.md SC1/SC2）：
 *  - SC1：read_file 成功收（showTitle/showPreview 同假、进折叠计数），
 *    失败横切覆盖为 error 形态（error 优先于任何 class）；
 *  - SC2 五类边界：empty（纯函数 N/A，调用方空列表语义）/ negative
 *    （未注册名缺省 retract）/ overflow（≥20 retract 各自 inFoldCount 真，
 *    摊平计数由调用方聚合）/ concurrent（running 全部逐条可见；纯函数
 *    无共享可变状态）/ exception（三类失败统一 error 形态）。
 *
 * 该核是单一派生 SSOT：渲染层只消费 slot，不再自行组合 hideToolSummaries
 * 与预览（spec D7）。本测试钉住核的输出契约，生产接线在后续 bullet。
 */
import { describe, expect, test } from "bun:test";
import {
  deriveSlot,
  settledClassOf,
  type SettledSlot,
} from "../../src/tui/tool-settled.js";

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
});

describe("deriveSlot: keep class（留的足迹，spec D4）", () => {
  test("bash 成功 → 标题 + 结果预览", () => {
    expect(deriveSlot("bash", { running: false, failed: false })).toEqual({
      showTitle: true,
      showPreview: true,
      inFoldCount: false,
      color: "default",
    });
  });

  test("write_file / edit_file 成功 → 标题 + 既有预览通道", () => {
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
});

describe("deriveSlot: accent class（点名着色，spec D6）", () => {
  test("skill / 建树四件成功 → accent 色、标题、无预览、不进计数", () => {
    for (const name of [
      "skill",
      "create-task-worktree",
      "enter-task-worktree",
      "exit-task-worktree",
      "remove-task-worktree",
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
  // empty：N/A: pure deriveSlot —— 零工具时调用方持空列表、不调核，
  // 「零条收不画计数行」语义由调用方（折叠聚合）认证，非核职责。
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
      "skill_search",
      "bash_output",
      "list_mcp_resources",
      "read_mcp_resource",
      "query_trace",
      "list-task-worktrees",
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
    // N/A: pure deriveSlot —— 纯函数无共享可变状态，running 语义由入参表达。
    for (const name of ["bash", "read_file", "skill", "spawn_subagent"]) {
      const slot = deriveSlot(name, { running: true, failed: false });
      expect(slot.showTitle).toBe(true);
      expect(slot.inFoldCount).toBe(false);
    }
    // retract 收类 running 期间不残留下沉态（不提前进折叠计数）。
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
    // accent 工具失败时 error 覆盖 accent 色（spec D5：error 优先于 accent）。
    const accentFailed = deriveSlot("skill", {
      running: false,
      failed: true,
    });
    expect(accentFailed.color).toBe("error");
  });
});
