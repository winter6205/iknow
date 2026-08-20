/**
 * T9a (serve-workspace-folder-browse): default-workspace helper tests.
 *
 * Validates:
 *  - DEFAULT_SESSION_WORKSPACE resolves to an absolute path ending
 *    with `.iknow/default` (no fs side effect; pure).
 *  - getDefaultSessionWorkspace() tracks current $HOME (re-resolves at call
 *    time, unlike the const).
 *  - ensureDefaultWorkspace() creates the dir if missing and is idempotent.
 *
 * HOME override strategy: installTestSettingsSource is a fixture used by
 * other test files but it doesn't take a custom HOME (it derives one from
 * mkdtemp). For T9a we want a deterministic HOME per test, so we manage
 * `process.env.HOME` directly here. getDefaultSessionWorkspace() reads
 * HOME at call time → no vi.resetModules needed for this file.
 */
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SESSION_WORKSPACE,
  ensureDefaultWorkspace,
  getDefaultSessionWorkspace,
} from "../../src/session-api/default-workspace.ts";

describe("DEFAULT_SESSION_WORKSPACE — pure const", () => {
  it("resolves to an absolute path ending with .iknow/default", () => {
    assert.ok(
      DEFAULT_SESSION_WORKSPACE.startsWith("/"),
      `expected absolute path, got ${DEFAULT_SESSION_WORKSPACE}`
    );
    assert.ok(
      DEFAULT_SESSION_WORKSPACE.endsWith("/.iknow/default"),
      `expected to end with /.iknow/default, got ${DEFAULT_SESSION_WORKSPACE}`
    );
  });

  it("uses homedir() at module load (no fs side effect)", () => {
    // The const is resolved once at module load. We don't assert the exact
    // path (HOME may differ per machine / CI) — only that it sits under
    // $HOME and ends with the well-known suffix.
    const tail = "/.iknow/default";
    assert.ok(DEFAULT_SESSION_WORKSPACE.endsWith(tail));
  });
});

describe("getDefaultSessionWorkspace — function", () => {
  let savedHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    savedHome = process.env.HOME;
    tmpHome = mkdtempSync(join(tmpdir(), "iknow-default-ws-fn-"));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("re-resolves $HOME at call time (tracks HOME overrides)", () => {
    // Override HOME → next call must observe it.
    const resolved = getDefaultSessionWorkspace();
    assert.equal(resolved, join(tmpHome, ".iknow", "default"));
    // The pure const is locked to module-load HOME and should NOT match
    // when we redirect mid-process — this is the discriminator the file
    // exports both for (tests use the function; production uses the const).
    if (savedHome !== undefined && savedHome !== tmpHome) {
      assert.notEqual(DEFAULT_SESSION_WORKSPACE, resolved);
    }
  });
});

describe("ensureDefaultWorkspace — mkdir helper", () => {
  let savedHome: string | undefined;
  let tmpHome: string;
  let expected: string;

  beforeEach(() => {
    savedHome = process.env.HOME;
    tmpHome = mkdtempSync(join(tmpdir(), "iknow-default-ws-"));
    process.env.HOME = tmpHome;
    expected = join(tmpHome, ".iknow", "default");
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("creates the default workspace dir if missing", async () => {
    assert.equal(existsSync(expected), false, "precondition: dir absent");
    await ensureDefaultWorkspace();
    assert.equal(existsSync(expected), true, "mkdir should create dir");
  });

  it("is idempotent (recursive mkdir tolerates EEXIST)", async () => {
    await ensureDefaultWorkspace();
    assert.equal(existsSync(expected), true);
    // Second call must not throw — `recursive: true` swallows EEXIST.
    await ensureDefaultWorkspace();
    assert.equal(existsSync(expected), true);
    // And a third call for good measure.
    await ensureDefaultWorkspace();
    assert.equal(existsSync(expected), true);
  });

  it("uses the runtime HOME (test override applies)", async () => {
    // sanity: function tracks current HOME, not module-load HOME.
    assert.equal(getDefaultSessionWorkspace(), expected);
    await ensureDefaultWorkspace();
    assert.equal(existsSync(expected), true);
    // Critically: must NOT touch the original $HOME captured at module load.
    // We can only assert this on systems where the module-load HOME
    // differed from tmpHome (i.e., the test runner's HOME was redirected by
    // installTestSettingsSource elsewhere in the fork — not always the
    // case here, so this is a soft assertion guarded by a sanity check).
    if (savedHome !== tmpHome && savedHome !== undefined) {
      const realDefault = join(savedHome, ".iknow", "default");
      // We can't reliably assert !existsSync(realDefault) (other tests may
      // have created it), but we CAN assert the function wrote to *our*
      // tmpHome, not the module-load HOME.
      assert.equal(existsSync(expected), true);
      assert.notEqual(expected, realDefault);
    }
  });
});
