/**
 * T9a (serve-workspace-folder-browse): default-workspace helper tests.
 *
 * Validates:
 *  - resolveSessionDefaultWorkspace() returns an absolute path ending
 *    with `.iknow/default` (no fs side effect).
 *  - resolveSessionDefaultWorkspace() tracks current $HOME (re-resolves at
 *    call time).
 *  - ensureDefaultWorkspace() creates the dir if missing and is idempotent.
 *
 * HOME override strategy: installTestSettingsSource is a fixture used by
 * other test files but it doesn't take a custom HOME (it derives one from
 * mkdtemp). For T9a we want a deterministic HOME per test, so we manage
 * `process.env.HOME` directly here. resolveSessionDefaultWorkspace() reads
 * HOME at call time → no vi.resetModules needed for this file.
 *
 * review L2 follow-up: the `DEFAULT_SESSION_WORKSPACE` const that was
 * locked to module-load $HOME has been removed (single source of truth =
 * the function). Tests that asserted "const is locked" are deleted;
 * tests that verify the function behavior remain.
 */
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureDefaultWorkspace,
  resolveSessionDefaultWorkspace,
} from "../../src/session-api/default-workspace.ts";

describe("resolveSessionDefaultWorkspace — function", () => {
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

  it("resolves to an absolute path ending with .iknow/default", () => {
    const resolved = resolveSessionDefaultWorkspace();
    assert.ok(
      resolved.startsWith("/"),
      `expected absolute path, got ${resolved}`
    );
    assert.ok(
      resolved.endsWith("/.iknow/default"),
      `expected to end with /.iknow/default, got ${resolved}`
    );
  });

  it("re-resolves $HOME at call time (tracks HOME overrides)", () => {
    // Override HOME → next call must observe it.
    const resolved = resolveSessionDefaultWorkspace();
    assert.equal(resolved, join(tmpHome, ".iknow", "default"));
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
    assert.equal(resolveSessionDefaultWorkspace(), expected);
    await ensureDefaultWorkspace();
    assert.equal(existsSync(expected), true);
  });
});
