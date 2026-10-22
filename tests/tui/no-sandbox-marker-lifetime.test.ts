/**
 * ADR-0141 / specs/yolo-mode.md — the 无沙箱 marker's lifetime across a preset
 * exit (spec:195).
 *
 * The marker is derived from the effective configuration PLUS the descendants
 * that were spawned while the fence was retired. So a live bare descendant keeps
 * saying "no sandbox" after the preset that spawned it has cleared — and the
 * marker only goes dark once every such descendant has ended.
 *
 * Liveness rides the EXISTING status filters (`isLiveTask` / the subagent row
 * filter). There is no delete hook: a finished descendant simply stops being
 * live, and the predicate falls back to the main process's own posture.
 */
import { describe, expect, test } from "bun:test";

import {
  isNoSandboxActive,
  type FenceRegistration,
} from "../../src/harness/sandbox/no-sandbox-marker.js";
import type { SubagentInfo } from "../../src/harness/subagent/manager.js";

/** A subagent row as the manager projects it; only the fields under test matter. */
function subagentRow(
  state: SubagentInfo["state"],
  fenceRetiredAtSpawn?: boolean
): SubagentInfo {
  return {
    taskId: "sub-1",
    state,
    taskPreview: "",
    startedAt: "2026-10-15T00:00:00.000Z",
    ...(fenceRetiredAtSpawn !== undefined ? { fenceRetiredAtSpawn } : {}),
  };
}

/** The manager's own liveness test, mirrored from `background/manager.ts`. */
const isLiveBackgroundTask = (t: { status: string }): boolean =>
  t.status === "running";
/** The subagent row projection keeps terminal entries, so readers filter too. */
const isLiveSubagentRow = (r: { state: string }): boolean =>
  r.state === "starting" || r.state === "running";

describe("无沙箱 marker — survives the preset exit while a bare descendant is live", () => {
  test("a live bare background task keeps the marker lit after the preset clears", () => {
    // Preset in force: the main process itself is unfenced.
    const duringPreset = isNoSandboxActive({
      fenceRetired: true,
      liveDescendants: [{ fenceRetiredAtSpawn: true }],
    });
    expect(duringPreset).toBe(true);

    // Preset cleared — the main process is fenced again, but the background
    // task spawned under it is still running, so the marker stays lit.
    const afterExit = isNoSandboxActive({
      fenceRetired: false,
      liveDescendants: [{ fenceRetiredAtSpawn: true }],
    });
    expect(afterExit).toBe(true);
  });

  test("the marker goes dark once that task ends", () => {
    const tasks = [
      { status: "running", fenceRetiredAtSpawn: true },
      { status: "exited", fenceRetiredAtSpawn: true },
    ];
    const live: FenceRegistration[] = tasks
      .filter(isLiveBackgroundTask)
      .map((t) => ({ fenceRetiredAtSpawn: t.fenceRetiredAtSpawn === true }));
    expect(live).toHaveLength(1);

    // ...and with the last one finished too, nothing bare is left.
    const allDone = tasks.map((t) => ({ ...t, status: "exited" }));
    expect(
      isNoSandboxActive({
        fenceRetired: false,
        liveDescendants: allDone.filter(isLiveBackgroundTask),
      })
    ).toBe(false);
  });

  test("a descendant spawned under the fence never lights the marker", () => {
    expect(
      isNoSandboxActive({
        fenceRetired: false,
        liveDescendants: [{ fenceRetiredAtSpawn: false }],
      })
    ).toBe(false);
  });
});

describe("无沙箱 marker — a live bare subagent row behaves the same way", () => {
  test("a running bare row keeps the marker lit; a terminal one does not", () => {
    const rows = [
      subagentRow("running", true),
      subagentRow("completed", true),
    ];
    const live = rows
      .filter(isLiveSubagentRow)
      .map((r) => ({ fenceRetiredAtSpawn: r.fenceRetiredAtSpawn === true }));
    expect(isNoSandboxActive({ fenceRetired: false, liveDescendants: live })).toBe(
      true
    );

    // Both finished → nothing bare is left, the marker goes dark.
    const finished = rows.map(() => subagentRow("completed", true));
    expect(
      isNoSandboxActive({
        fenceRetired: false,
        liveDescendants: finished
          .filter(isLiveSubagentRow)
          .map((r) => ({ fenceRetiredAtSpawn: r.fenceRetiredAtSpawn === true })),
      })
    ).toBe(false);
  });

  test("a row spawned under the fence carries no bare registration", () => {
    const rows = [subagentRow("running"), subagentRow("running", false)];
    const live = rows
      .filter(isLiveSubagentRow)
      .map((r) => ({ fenceRetiredAtSpawn: r.fenceRetiredAtSpawn === true }));
    expect(isNoSandboxActive({ fenceRetired: false, liveDescendants: live })).toBe(
      false
    );
  });
});
