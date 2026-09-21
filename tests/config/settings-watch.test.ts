/**
 * settings-watch pure module — file-level events → throttled callback.
 *
 * Coverage (≥8 cases):
 *  1. touch existing settings.json → onChange fires with path + reason.
 *  2. create settings.json (first time) → onChange fires.
 *  3. repeated writes within 100ms → onChange fires only once.
 *  4. write after stop() → no fire.
 *  5. both files watched: user change → user path; project change → project path.
 *  6. throw inside onChange callback → does not block later events.
 *  7. file / dir missing → no throw (startup-time semantics).
 *  8. repeated stop() after stop is idempotent (no throw).
 *
 * Discipline:
 *  - mkdtempSync + explicit stop() + rmSync at test end;
 *  - per-case timeout relaxed to 3000ms (fs.watch occasionally slow on WSL / CI);
 *  - vitest, matching the rest of tests/config (pre-commit's `vitest run --changed`
 *    collects this file, so bun:test must not be introduced). bun test also runs it.
 *  - home / cwd both point at tmp dirs, never the real ~/.iknow.
 */
import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEBOUNCE_MS,
  watchSettings,
  type SettingsChangeEvent,
} from "../../src/config/settings-watch.ts";

/** Per-case timeout (fs.watch occasionally slow on WSL/CI; vitest / bun share the 3rd param). */
const TEST_TIMEOUT_MS = 3000;
/**
 * Stable window for watcher event delivery. Must be ≥ 750ms: when the primary fs.watch
 * channel is occasionally slow, the watchFile poll (interval=500ms) is the redundant
 * fallback; a window shorter than the poll interval defeats the dual-channel redundancy.
 */
const SETTLE_MS = DEBOUNCE_MS + 750;

/** Build an isolated tmp dir pair: return { base, cwd, home, userFile, projectFile }. */
function makeDirs(): {
  base: string;
  cwd: string;
  home: string;
  userFile: string;
  projectFile: string;
} {
  const base = mkdtempSync(join(tmpdir(), "iknow-settings-watch-"));
  const home = join(base, "home");
  const cwd = join(base, "cwd");
  mkdirSync(join(home, ".iknow"), { recursive: true });
  mkdirSync(join(cwd, ".iknow"), { recursive: true });
  return {
    base,
    cwd,
    home,
    userFile: join(home, ".iknow", "settings.json"),
    projectFile: join(cwd, ".iknow", "settings.json"),
  };
}

/** Wait for watcher firing: poll until `events.length` reaches the target count. */
async function waitForEvents(
  events: SettingsChangeEvent[],
  count: number,
  timeoutMs: number = SETTLE_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (events.length < count) {
    if (Date.now() > deadline) {
      throw new Error(
        `timeout waiting for ${count} events, got ${events.length}`
      );
    }
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** Quiet window: confirm no new events arrive within it. */
async function assertQuiet(
  events: SettingsChangeEvent[],
  count: number
): Promise<void> {
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  expect(events.length).toBe(count);
}

describe("watchSettings", () => {
  test(
    "touch 现有 settings.json → onChange 触发，含 path + reason",
    async () => {
      const { base, cwd, home, projectFile } = makeDirs();
      // Create the file first (exists before watcher registration → no startup echo).
      writeFileSync(projectFile, JSON.stringify({ llm: { model: "m1" } }));
      const events: SettingsChangeEvent[] = [];
      const w = watchSettings({
        cwd,
        home,
        onChange: (e) => events.push(e),
      });
      try {
        writeFileSync(projectFile, JSON.stringify({ llm: { model: "m2" } }));
        await waitForEvents(events, 1);
        expect(events[0]!.path).toBe(projectFile);
        expect(events[0]!.reason).toBe("change");
      } finally {
        w.stop();
        rmSync(base, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );

  test(
    "创建 settings.json（首次）→ onChange 触发",
    async () => {
      const { base, cwd, home, projectFile } = makeDirs();
      rmSync(projectFile, { force: true });
      const events: SettingsChangeEvent[] = [];
      const w = watchSettings({
        cwd,
        home,
        onChange: (e) => events.push(e),
      });
      try {
        writeFileSync(projectFile, JSON.stringify({ llm: { model: "m1" } }));
        await waitForEvents(events, 1);
        expect(events[0]!.path).toBe(projectFile);
        // Pin the first-create contract: reason === "rename" (dir fs.watch emits
        // rename on create; watchFile also sees the missing→exists transition as rename).
        expect(events[0]!.reason).toBe("rename");
      } finally {
        w.stop();
        rmSync(base, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );

  test(
    "100ms 内多次连续 write → onChange 只触发一次",
    async () => {
      const { base, cwd, home, projectFile } = makeDirs();
      writeFileSync(projectFile, JSON.stringify({ llm: { model: "m0" } }));
      const events: SettingsChangeEvent[] = [];
      const w = watchSettings({
        cwd,
        home,
        onChange: (e) => events.push(e),
      });
      try {
        // Wait for the watcher to be ready so a pre-registration write is not missed.
        await new Promise((r) => setTimeout(r, 80));
        for (let i = 1; i <= 5; i++) {
          writeFileSync(
            projectFile,
            JSON.stringify({ llm: { model: `m${i}` } })
          );
        }
        await waitForEvents(events, 1);
        // Still exactly 1 event after the window (no duplicate reports).
        await assertQuiet(events, 1);
      } finally {
        w.stop();
        rmSync(base, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );

  test(
    "debounce 边界：相隔 >100ms 的两次 write → 触发两次",
    async () => {
      const { base, cwd, home, projectFile } = makeDirs();
      writeFileSync(projectFile, JSON.stringify({ llm: { model: "m0" } }));
      const events: SettingsChangeEvent[] = [];
      const w = watchSettings({
        cwd,
        home,
        onChange: (e) => events.push(e),
      });
      try {
        await new Promise((r) => setTimeout(r, 80));
        writeFileSync(projectFile, JSON.stringify({ llm: { model: "m1" } }));
        await waitForEvents(events, 1);
        // Write again past the debounce window → should report as a separate event.
        await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 200));
        writeFileSync(projectFile, JSON.stringify({ llm: { model: "m2" } }));
        await waitForEvents(events, 2);
        expect(events[1]!.path).toBe(projectFile);
      } finally {
        w.stop();
        rmSync(base, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );

  test(
    "stop() 后 write → 不触发",
    async () => {
      const { base, cwd, home, projectFile } = makeDirs();
      writeFileSync(projectFile, JSON.stringify({ llm: { model: "m1" } }));
      const events: SettingsChangeEvent[] = [];
      const w = watchSettings({
        cwd,
        home,
        onChange: (e) => events.push(e),
      });
      try {
        await new Promise((r) => setTimeout(r, 80));
        w.stop();
        writeFileSync(projectFile, JSON.stringify({ llm: { model: "m2" } }));
        await assertQuiet(events, 0);
      } finally {
        w.stop(); // idempotent (second stop must not throw)
        rmSync(base, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );

  test(
    "两个文件都监听：user 改 → user 路径；project 改 → project 路径",
    async () => {
      const { base, cwd, home, userFile, projectFile } = makeDirs();
      writeFileSync(userFile, JSON.stringify({ llm: { model: "u0" } }));
      writeFileSync(projectFile, JSON.stringify({ llm: { model: "p0" } }));
      const events: SettingsChangeEvent[] = [];
      const w = watchSettings({
        cwd,
        home,
        onChange: (e) => events.push(e),
      });
      try {
        await new Promise((r) => setTimeout(r, 80));
        writeFileSync(projectFile, JSON.stringify({ llm: { model: "p1" } }));
        await waitForEvents(events, 1);
        expect(events[0]!.path).toBe(projectFile);

        writeFileSync(userFile, JSON.stringify({ llm: { model: "u1" } }));
        await waitForEvents(events, 2);
        expect(events[1]!.path).toBe(userFile);
      } finally {
        w.stop();
        rmSync(base, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );

  test(
    "onChange 回调内 throw → 不阻断后续事件",
    async () => {
      const { base, cwd, home, projectFile } = makeDirs();
      writeFileSync(projectFile, JSON.stringify({ llm: { model: "m1" } }));
      const events: SettingsChangeEvent[] = [];
      let callCount = 0;
      const w = watchSettings({
        cwd,
        home,
        onChange: (e) => {
          callCount++;
          events.push(e);
          if (callCount === 1) throw new Error("boom from callback");
        },
      });
      try {
        await new Promise((r) => setTimeout(r, 80));
        writeFileSync(projectFile, JSON.stringify({ llm: { model: "m2" } }));
        await waitForEvents(events, 1);
        // After the first callback throws, later writes still fire (not blocked).
        await new Promise((r) => setTimeout(r, 150));
        writeFileSync(projectFile, JSON.stringify({ llm: { model: "m3" } }));
        await waitForEvents(events, 2);
        expect(callCount).toBe(2);
      } finally {
        w.stop();
        rmSync(base, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );

  test(
    "文件 / 目录不存在 → 不抛错（启动期常见）",
    async () => {
      const { base, home } = makeDirs();
      // Fresh home / cwd: neither .iknow dir exists.
      const emptyHome = join(base, "empty-home");
      const emptyCwd = join(base, "empty-cwd");
      const events: SettingsChangeEvent[] = [];
      const w = watchSettings({
        cwd: emptyCwd,
        home: emptyHome,
        onChange: (e) => events.push(e),
      });
      // Construction itself must not throw (startup-time semantics):
      expect(typeof w.stop).toBe("function");
      w.stop();
      rmSync(base, { recursive: true, force: true });
      void home;
    },
    TEST_TIMEOUT_MS
  );
});
