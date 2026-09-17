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
 * 该核是单一派生 SSOT：渲染层只消费 slot（spec D7）—— 标题 / 预览 /
 * 折叠计数 / 颜色均由核派生，渲染层不自组合隐藏开关与预览。
 */
import { describe, expect, test } from "bun:test";
import {
  deriveSlot,
  isLiveNoise,
  settledClassOf,
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
});

describe("deriveSlot: keep class（留的足迹，spec D4）", () => {
  test("bash 成功 → 标题 + 折叠结果预览（KEEP_WITH_PREVIEW）", () => {
    // docs/CONTEXT.md keep class：bash 成功留命令 + 折叠后的 result preview。
    expect(deriveSlot("bash", { running: false, failed: false })).toEqual({
      showTitle: true,
      showPreview: true,
      inFoldCount: false,
      color: "default",
    });
  });

  test("write_file / edit_file 成功 → 标题 + 既有 6 行预览通道（不变）", () => {
    // docs/CONTEXT.md keep class：write/edit 另留完成态 6 行预览 ——
    // bash 收走预览的同帧，write/edit 预览足迹不得被波及。
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
    // 策略核保持依赖无关（不 import 注册表），「谁是子代理」在核内以 class 表
    // 条目（"subagent" class）表达、在 tool-summary 以 isSubagentTool 表达
    // —— 两个独立名单必须对同一全集给出一致答案：任一侧单方面新增/删除一个
    // 子代理名即失败（漂移闸）。
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
      // disclosure-index-align T2 / SC5:skill_search 已删,缺省走 retract 兜底
      // （settledClassOf 未注册名缺省 retract）—— 不在声明表但历史回放可触发。
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

describe("isLiveNoise（live 块入场判据，specs live-signal revision #3）", () => {
  // settled 计数口径不变：web_search / web_fetch 仍归 retract（spec table row
  // 2 锁）。live 块入场只走 isLiveNoise —— web_* 在 live 阶段不算 noise，进
  // 实卡不进 unanchored 块；其余 retract 名一律进块。

  test("read_file / grep / glob / memory_recall → true（进 unanchored 块）", () => {
    for (const name of ["read_file", "grep", "glob", "memory_recall"]) {
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
    // 守住 spec table row 2 锁：web_* 仍属 retract，进 settled 计数 ——
    // live-signal revision 仅改 live 块入场判据，不动 settled 计数。
    expect(settledClassOf("web_search")).toBe("retract");
    expect(settledClassOf("web_fetch")).toBe("retract");
  });
});
