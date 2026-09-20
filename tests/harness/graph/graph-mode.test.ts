/**
 * Graph mode overlay tests (ADR-0030).
 *
 * Covers:
 *   1. Orthogonality: `PERMISSION_MODES` stays three-valued; Graph is not an enum member;
 *   2. Shift+Tab tri-state cycle `Default → Auto → Graph → Default`; entering Graph freezes the current permission, plan is not in the cycle;
 *   3. holder: `/graph on|off` and Shift+Tab mutate the same `GraphModeContext`;
 *   4. initial-value chain: settings > default-off (env is not the human-facing SSOT, excluded);
 *   5. `/graph` command semantics + wording (single point shared by three entry points).
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  GRAPH_MODE_DEFAULT_STATE,
  GRAPH_MODE_USAGE_TEXT,
  agentModeLabel,
  applyGraphCommand,
  applyShiftTabAgentModeFlip,
  createGraphModeContext,
  formatGraphStatus,
  nextShiftTabAgentMode,
  parseGraphCommand,
  parseGraphFlag,
  resolveGraphMode,
  splitGraphArgs,
  type AgentModeSnapshot,
} from "../../../src/harness/graph/mode.ts";
import {
  PERMISSION_MODES,
  createPermissionModeContext,
} from "../../../src/harness/permission/modes.ts";

describe("graph mode: 与 PermissionMode 正交（SC1）", () => {
  it("PERMISSION_MODES 仍仅 default | plan | full_auto", () => {
    assert.deepEqual([...PERMISSION_MODES], ["default", "plan", "full_auto"]);
  });
});

describe("graph mode: Shift+Tab 三态轮（ADR-0030）", () => {
  const from = (
    permission: AgentModeSnapshot["permission"],
    graph: boolean
  ): AgentModeSnapshot => ({ permission, graph });

  it("Default → Auto → Graph → Default", () => {
    const auto = nextShiftTabAgentMode(from("default", false));
    assert.deepEqual(auto, { permission: "full_auto", graph: false });
    const graph = nextShiftTabAgentMode(auto);
    assert.deepEqual(graph, { permission: "full_auto", graph: true });
    const back = nextShiftTabAgentMode(graph);
    assert.deepEqual(back, { permission: "default", graph: false });
  });

  it("进 Graph 冻结当时 permission（不改 ask/auto 轴）", () => {
    assert.equal(
      nextShiftTabAgentMode(from("full_auto", false)).permission,
      "full_auto"
    );
  });

  it("plan 不进轮：一次 Shift+Tab 直接到 Auto，且不开 graph", () => {
    assert.deepEqual(nextShiftTabAgentMode(from("plan", false)), {
      permission: "full_auto",
      graph: false,
    });
  });

  it("标签：graph 开 → Graph；否则沿用 permission 标签", () => {
    assert.equal(agentModeLabel(from("full_auto", true)), "Graph");
    assert.equal(agentModeLabel(from("default", true)), "Graph");
    assert.equal(agentModeLabel(from("full_auto", false)), "Auto");
    assert.equal(agentModeLabel(from("default", false)), "Default");
    assert.equal(agentModeLabel(from("plan", false)), "Plan Mode");
  });
});

describe("graph mode: applyShiftTabAgentModeFlip（键位守卫 + 双 holder）", () => {
  it("Shift+Tab 同时推进 permission holder 与 graph holder", () => {
    const permission = createPermissionModeContext("default");
    const graph = createGraphModeContext();
    const seen: AgentModeSnapshot[] = [];
    const press = (): boolean =>
      applyShiftTabAgentModeFlip({
        key: { name: "tab", shift: true },
        permission,
        graph,
        onFlip: (next) => seen.push(next),
      });

    assert.equal(press(), true);
    assert.equal(permission.get(), "full_auto");
    assert.equal(graph.get().enabled, false);

    assert.equal(press(), true);
    assert.equal(permission.get(), "full_auto");
    assert.equal(graph.get().enabled, true);

    assert.equal(press(), true);
    assert.equal(permission.get(), "default");
    assert.equal(graph.get().enabled, false);

    assert.deepEqual(
      seen.map((s) => agentModeLabel(s)),
      ["Auto", "Graph", "Default"]
    );
  });

  it("非 Shift+Tab 键 / Ctrl+Tab / Meta+Tab → no-op", () => {
    const permission = createPermissionModeContext("default");
    const graph = createGraphModeContext();
    for (const key of [
      { name: "tab", shift: false },
      { name: "tab", shift: true, ctrl: true },
      { name: "tab", shift: true, meta: true },
      { name: "a", shift: true },
      undefined,
    ]) {
      assert.equal(
        applyShiftTabAgentModeFlip({
          key,
          permission,
          graph,
          onFlip: () => {
            throw new Error("must not flip");
          },
        }),
        false
      );
    }
    assert.equal(permission.get(), "default");
    assert.equal(graph.get().enabled, false);
  });

  it("graph holder 缺席（ask/serve 早期路径）→ 退回单轴 permission 轮", () => {
    const permission = createPermissionModeContext("default");
    const flipped = applyShiftTabAgentModeFlip({
      key: { name: "tab", shift: true },
      permission,
      graph: undefined,
      onFlip: () => {},
    });
    assert.equal(flipped, true);
    assert.equal(permission.get(), "full_auto");
  });
});

describe("graph mode: holder + 初值链", () => {
  it("默认关（graph = 可选 overlay，默认任务走 spawn_subagent）", () => {
    assert.equal(GRAPH_MODE_DEFAULT_STATE.enabled, false);
    assert.equal(createGraphModeContext().get().enabled, false);
  });

  it("resolveGraphMode: settings.enabled > 默认关", () => {
    assert.equal(resolveGraphMode().enabled, false);
    assert.equal(resolveGraphMode({ settings: {} }).enabled, false);
    assert.equal(
      resolveGraphMode({ settings: { enabled: true } }).enabled,
      true
    );
    assert.equal(
      resolveGraphMode({ settings: { enabled: false } }).enabled,
      false
    );
  });

  it("get() 返回冻结快照：改快照不影响 holder", () => {
    const ctx = createGraphModeContext();
    const snapshot = ctx.get();
    assert.throws(() => {
      (snapshot as { enabled: boolean }).enabled = true;
    });
    assert.equal(ctx.get().enabled, false);
  });

  it("setEnabled 就地翻（引擎不重建）", () => {
    const ctx = createGraphModeContext();
    ctx.setEnabled(true);
    assert.equal(ctx.get().enabled, true);
    ctx.setEnabled(false);
    assert.equal(ctx.get().enabled, false);
  });
});

describe("graph mode: parseGraphFlag", () => {
  it("on|true|1|yes → true（trim + 大小写不敏感）", () => {
    for (const raw of ["on", "ON", " true ", "1", "yes"]) {
      assert.equal(parseGraphFlag(raw), true, raw);
    }
  });

  it("off|false|0|no → false", () => {
    for (const raw of ["off", "FALSE", "0", " no"]) {
      assert.equal(parseGraphFlag(raw), false, raw);
    }
  });

  it("非法值 / 非字符串 → undefined（调用方回退下一层，不抛）", () => {
    for (const raw of ["maybe", "", 1, null, undefined, {}]) {
      assert.equal(parseGraphFlag(raw), undefined);
    }
    assert.equal(parseGraphFlag(true), true);
  });
});

describe("graph mode: /graph 命令语义（三入口共享单点）", () => {
  it("空 / status → 查询", () => {
    assert.deepEqual(parseGraphCommand([]), { kind: "status" });
    assert.deepEqual(parseGraphCommand([""]), { kind: "status" });
    assert.deepEqual(parseGraphCommand(["status"]), { kind: "status" });
  });

  it("on / off → 翻开关", () => {
    assert.deepEqual(parseGraphCommand(["on"]), { kind: "set", enabled: true });
    assert.deepEqual(parseGraphCommand(["off"]), {
      kind: "set",
      enabled: false,
    });
  });

  it("多余 args / 非法值 → usage（不静默忽略）", () => {
    assert.deepEqual(parseGraphCommand(["on", "extra"]), { kind: "usage" });
    assert.deepEqual(parseGraphCommand(["maybe"]), { kind: "usage" });
  });

  it("applyGraphCommand 在 holder 上执行并给文案", () => {
    const ctx = createGraphModeContext();
    const on = applyGraphCommand(ctx, ["on"]);
    assert.equal(on.ok, true);
    assert.equal(ctx.get().enabled, true);

    const status = applyGraphCommand(ctx, ["status"]);
    assert.equal(status.ok, true);
    assert.equal(status.text, formatGraphStatus(ctx.get()));

    const off = applyGraphCommand(ctx, ["off"]);
    assert.equal(off.ok, true);
    assert.equal(ctx.get().enabled, false);

    const bad = applyGraphCommand(ctx, ["nope"]);
    assert.equal(bad.ok, false);
    assert.equal(bad.text, GRAPH_MODE_USAGE_TEXT);
    assert.equal(ctx.get().enabled, false);
  });

  it("Shift+Tab 与 /graph on 改的是同一个 holder（SC3 斜杠对等）", () => {
    const permission = createPermissionModeContext("full_auto");
    const graph = createGraphModeContext();
    applyGraphCommand(graph, ["on"]);
    assert.equal(graph.get().enabled, true);
    // Same holder: one Shift+Tab from the Graph state returns to Default, which turns it off
    applyShiftTabAgentModeFlip({
      key: { name: "tab", shift: true },
      permission,
      graph,
      onFlip: () => {},
    });
    assert.equal(graph.get().enabled, false);
    assert.equal(permission.get(), "default");
  });

  it("splitGraphArgs 切词", () => {
    assert.deepEqual(splitGraphArgs("  on  "), ["on"]);
    assert.deepEqual(splitGraphArgs(""), []);
    assert.deepEqual(splitGraphArgs("on extra"), ["on", "extra"]);
  });
});
