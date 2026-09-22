/**
 * tests/tui/yolo-toggle.test.ts
 *
 * ADR-0119 / specs/yolo-mode.md plan acceptance, six cases: confirm, cancel,
 * Esc, second entry, entry refused on a host without bwrap, exit refused on a
 * host without bwrap.
 *
 * Shape: a pure mirror of app.tsx's confirm branch — reduceYoloConfirmKey routing
 * with the actions wired to createYoloController (an INJECTED FAILING probe stands
 * in for a host without bwrap, so nothing depends on real bubblewrap). Each case
 * asserts the EXIT contract: refused -> ok:false + guidance copy + zero state
 * change (none of the yolo / permission / fsMode holders moves), session continues.
 */
import { describe, expect, test } from "bun:test";
import { ToolExecutionError } from "../../src/harness/errors.js";
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { createFsModeContext } from "../../src/harness/sandbox/fs-mode.js";
import {
  createYoloContext,
  createYoloController,
  YOLO_ENTER_TEXT,
  YOLO_EXIT_TEXT,
  type YoloActionResult,
  type YoloController,
} from "../../src/harness/sandbox/yolo.js";
import type { ModalKeyEvent } from "../../src/tui/modal.js";
import { reduceYoloConfirmKey } from "../../src/tui/yolo-picker.js";

/** Toggleable failing probe: probeFails=true -> throws the typed error (a host without bwrap). */
function makeFixture() {
  const yolo = createYoloContext(false);
  const permission = createPermissionModeContext("default");
  const fsMode = createFsModeContext("workspace");
  let probeFails = false;
  const probe = (): void => {
    if (probeFails) {
      throw new ToolExecutionError(
        "bwrap not available (injected failing probe)"
      );
    }
  };
  const controller = createYoloController({ yolo, permission, fsMode, probe });
  return {
    yolo,
    permission,
    fsMode,
    controller,
    setProbeFails: (v: boolean) => {
      probeFails = v;
    },
  };
}

const noKey = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  tab: false,
  space: false,
  return: false,
  escape: false,
  ctrl: false,
  meta: false,
};
const key = (patch: Partial<ModalKeyEvent["key"]>): ModalKeyEvent => ({
  input: "",
  key: { ...noKey, ...patch },
});

/**
 * Isomorphic mirror of app.tsx's confirm branch (**entry arm only**): the reducer
 * routes keys, the action wires to the controller. Returns (whether the panel
 * closed, the action result on execute); cancel / ignore return result=undefined,
 * mirroring the host's "zero controller calls".
 *
 * The setters object mirrors the host's YoloSetters landing sequence: after
 * `enter()` the host re-reads BOTH holders — yolo (red marker) and permission
 * (mode-row label; the mirror has no subscription, a pty-verified stale-mirror
 * bug the sync fixes).
 *
 * Exit deliberately does not go through this mirror — ADR-0119 ruling 6 plus the
 * lock table's "exit is immediate": with yolo ON another /yolo calls
 * controller.exit() straight away, no modal (see hostExitImmediately).
 */
interface HostSetters {
  readonly setYoloConfirming: (v: boolean | undefined) => void;
  readonly setYoloOn: (v: boolean) => void;
  readonly setPermMode: (mode: string) => void;
  readonly permissionMode: { get(): string };
  readonly notices: (lines: readonly string[] | undefined) => void;
}

function makeHostSetters(permissionMode: { get(): string }): HostSetters & {
  readonly permModeCalls: string[];
  readonly yoloOnCalls: boolean[];
} {
  const permModeCalls: string[] = [];
  const yoloOnCalls: boolean[] = [];
  return {
    setYoloConfirming: () => undefined,
    setYoloOn: (v) => yoloOnCalls.push(v),
    setPermMode: (m) => permModeCalls.push(m),
    permissionMode,
    notices: () => undefined,
    permModeCalls,
    yoloOnCalls,
  };
}

function hostConfirmKey(
  event: ModalKeyEvent,
  controller: YoloController,
  setters: HostSetters
): { closed: boolean; result: YoloActionResult | undefined } {
  const action = reduceYoloConfirmKey(event);
  switch (action) {
    case "execute": {
      const result = controller.enter();
      setters.setYoloConfirming(undefined);
      setters.setYoloOn(controller.context.get());
      setters.setPermMode(setters.permissionMode.get());
      return { closed: true, result };
    }
    case "cancel":
      setters.setYoloConfirming(undefined);
      return { closed: true, result: undefined };
    case "ignore":
      return { closed: false, result: undefined };
  }
}

/** Isomorphic mirror of app.tsx's immediate-exit branch: yolo ON -> no modal, exit() straight away. */
function hostExitImmediately(
  controller: YoloController,
  setters: HostSetters
): YoloActionResult {
  const result = controller.exit();
  setters.setYoloOn(controller.context.get());
  setters.setPermMode(setters.permissionMode.get());
  return result;
}

describe("T5 six cases: /yolo confirmed switch (pure reducer + injected failing probe)", () => {
  test("1 confirm -> yolo ON with the T3 state combination applied (permission=full_auto, fsMode workspace->global)", () => {
    const f = makeFixture();
    expect(f.yolo.get()).toBe(false);
    const setters = makeHostSetters(f.permission);
    const { closed, result } = hostConfirmKey(
      key({ return: true }),
      f.controller,
      setters
    );
    expect(closed).toBe(true);
    expect(result).toEqual({ ok: true, yolo: true, text: YOLO_ENTER_TEXT });
    expect(f.yolo.get()).toBe(true);
    expect(f.permission.get()).toBe("full_auto");
    expect(f.fsMode.get()).toBe("global");
    // The mode-row mirrors land together: yolo marker + permission label.
    expect(setters.yoloOnCalls).toEqual([true]);
    expect(setters.permModeCalls).toEqual(["full_auto"]);
  });

  test("2 cancel -> panel closes, all three holders unchanged", () => {
    const f = makeFixture();
    const before = {
      yolo: f.yolo.get(),
      permission: f.permission.get(),
      fsMode: f.fsMode.get(),
    };
    const setters = makeHostSetters(f.permission);
    // The cancel channel is Esc (the "cancel" option's key path; the reducer does not consume ↑↓).
    const { closed, result } = hostConfirmKey(
      key({ escape: true }),
      f.controller,
      setters
    );
    expect(closed).toBe(true);
    expect(result).toBeUndefined(); // controller never reached
    expect(f.yolo.get()).toBe(before.yolo);
    expect(f.permission.get()).toBe(before.permission);
    expect(f.fsMode.get()).toBe(before.fsMode);
    // Zero mirror traffic on cancel (no holder moved).
    expect(setters.permModeCalls).toEqual([]);
    expect(setters.yoloOnCalls).toEqual([]);
  });

  test("3 Esc -> cancel (entry-confirm arm; exit is immediate so there is no exit-arm Esc)", () => {
    const f = makeFixture();
    const setters = makeHostSetters(f.permission);
    expect(
      hostConfirmKey(key({ escape: true }), f.controller, setters)
    ).toEqual({
      closed: true,
      result: undefined,
    });
    // Exit is immediate: with yolo ON another /yolo opens no modal, so Esc has no
    // exit arm to land on.
    f.setProbeFails(false);
    f.controller.enter();
    expect(f.yolo.get()).toBe(true);
    // An ignored key (up / Tab) neither closes the panel nor touches the controller.
    expect(
      hostConfirmKey(key({ upArrow: true }), f.controller, setters)
    ).toEqual({
      closed: false,
      result: undefined,
    });
  });

  test("4 second entry -> takes the exit path: yolo OFF, snapshot restored (permission / fsMode back to pre-entry values)", () => {
    const f = makeFixture();
    f.setProbeFails(false);
    f.controller.enter();
    expect(f.permission.get()).toBe("full_auto");
    expect(f.fsMode.get()).toBe("global");
    // With yolo ON another /yolo exits immediately (ADR-0119 ruling 6: no
    // confirmation; the asymmetry with entry is deliberate).
    const setters = makeHostSetters(f.permission);
    const result = hostExitImmediately(f.controller, setters);
    expect(result).toEqual({ ok: true, yolo: false, text: YOLO_EXIT_TEXT });
    expect(f.yolo.get()).toBe(false);
    expect(f.permission.get()).toBe("default"); // pre-entry snapshot
    expect(f.fsMode.get()).toBe("workspace"); // pre-entry snapshot
    // The stale-mirror bug fix: the mode-row permission label re-reads the
    // holder after exit (it showed Auto after a real exit until the mirror synced).
    expect(setters.yoloOnCalls).toEqual([false]);
    expect(setters.permModeCalls).toEqual(["default"]);
  });

  test("5 entry refused on a host without bwrap -> ok:false + install guidance, zero state change", () => {
    const f = makeFixture();
    f.setProbeFails(true);
    const setters = makeHostSetters(f.permission);
    const { closed, result } = hostConfirmKey(
      key({ return: true }),
      f.controller,
      setters
    );
    expect(closed).toBe(true);
    expect(result?.ok).toBe(false);
    if (result?.ok === false) {
      expect(result.text).toContain("yolo mode refused");
      expect(result.text).toContain("bubblewrap");
      // typed-error rendering contract: the injected ToolExecutionError keeps its message.
      expect(result.text).toContain("injected failing probe");
    }
    // Zero state change: yolo not flipped, no full_auto, fsMode untouched.
    expect(f.yolo.get()).toBe(false);
    expect(f.permission.get()).toBe("default");
    expect(f.fsMode.get()).toBe("workspace");
  });

  test("6 exit refused on a host without bwrap -> ok:false + exit guidance, yolo stays ON with no silent rollback", () => {
    const f = makeFixture();
    f.setProbeFails(false);
    f.controller.enter(); // really enter first (bwrap present)
    f.setProbeFails(true); // bwrap disappears afterwards
    const setters = makeHostSetters(f.permission);
    const result = hostExitImmediately(f.controller, setters);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.text).toContain("refused to exit");
      expect(result.text).toContain("quit the TUI");
    }
    // Zero state change: yolo stays ON (a silent exit would turn every bash call
    // into a runtime failure) and the snapshot is not misapplied — permission /
    // fsMode keep their yolo-posture values.
    expect(f.yolo.get()).toBe(true);
    expect(f.permission.get()).toBe("full_auto");
    expect(f.fsMode.get()).toBe("global");
    // Mirrors re-read the untouched holders: same values, never stale-wrong.
    expect(setters.yoloOnCalls).toEqual([true]);
    expect(setters.permModeCalls).toEqual(["full_auto"]);
  });
});
