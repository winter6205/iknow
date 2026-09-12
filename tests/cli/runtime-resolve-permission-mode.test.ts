/**
 * tests/cli/runtime-resolve-permission-mode.test.ts
 *
 * T5 (ADR-0090) startup-mode seed. `resolvePermissionMode` in
 * `src/cli/runtime.ts` is the shared seed for the interactive entry points
 * (chat / serve / tui). This file nails the priority:
 * explicit > env IKNOW_PERMISSION_MODE > project permissions.defaultMode
 * > "default", plus the fail-loud of project `defaultMode: "full_auto"`.
 *
 * Boundary classes covered:
 *  - normal: explicit wins, env wins over project, project seed honoured
 *    when both explicit + env are absent.
 *  - absent: missing settings file / missing `permissions` section /
 *    missing `defaultMode` → project seed undefined → "default".
 *  - negative: project `defaultMode: "full_auto"` → typed fail-loud
 *    propagated verbatim (the repo must not self-grant automatic mode).
 *
 * The ask entry (`runOneShot`) deliberately does not consume the project
 * seed — the spec seeds only the interactive surfaces; ask reads
 * `IKNOW_PERMISSION_MODE` directly (see `cli.ts` runOneShot). Not under test.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolvePermissionMode } from "../../src/cli/runtime.js";
import { ProjectSettingsError } from "../../src/harness/permission/project-settings.js";

const ROOTS: string[] = [];

function scratchRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "iknow-runtime-resolve-"));
  ROOTS.push(root);
  return root;
}

/** Write `<root>/.iknow/settings.json` with the given top-level object. */
function writeProjectSettings(
  root: string,
  document: Record<string, unknown>
): void {
  mkdirSync(join(root, ".iknow"), { recursive: true });
  writeFileSync(
    join(root, ".iknow", "settings.json"),
    JSON.stringify(document),
    "utf8"
  );
}

describe("resolvePermissionMode — T5 project defaultMode seed (ADR-0090)", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.IKNOW_PERMISSION_MODE;
    delete process.env.IKNOW_PERMISSION_MODE;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.IKNOW_PERMISSION_MODE;
    else process.env.IKNOW_PERMISSION_MODE = originalEnv;
    for (const root of ROOTS.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("explicit 'full_auto' wins over a project seed of 'plan'", () => {
    const root = scratchRoot();
    writeProjectSettings(root, { permissions: { defaultMode: "plan" } });

    const ctx = resolvePermissionMode("full_auto", { cwd: root });
    expect(ctx.get()).toBe("full_auto");
  });

  it("env IKNOW_PERMISSION_MODE wins over the project seed", () => {
    const root = scratchRoot();
    writeProjectSettings(root, { permissions: { defaultMode: "plan" } });
    process.env.IKNOW_PERMISSION_MODE = "default";

    const ctx = resolvePermissionMode(undefined, { cwd: root });
    expect(ctx.get()).toBe("default");
  });

  it("with neither explicit nor env, the project seed 'plan' becomes the initial mode", () => {
    const root = scratchRoot();
    writeProjectSettings(root, { permissions: { defaultMode: "plan" } });

    const ctx = resolvePermissionMode(undefined, { cwd: root });
    expect(ctx.get()).toBe("plan");
  });

  it("project settings file absent → 'default'", () => {
    const root = scratchRoot();

    const ctx = resolvePermissionMode(undefined, { cwd: root });
    expect(ctx.get()).toBe("default");
  });

  it("project file without a `permissions` section → 'default'", () => {
    const root = scratchRoot();
    writeProjectSettings(root, { verify: { command: "npm test" } });

    const ctx = resolvePermissionMode(undefined, { cwd: root });
    expect(ctx.get()).toBe("default");
  });

  it("project `permissions` section without `defaultMode` → 'default'", () => {
    const root = scratchRoot();
    writeProjectSettings(root, {
      permissions: { allow: ["Bash(git status:*)"] },
    });

    const ctx = resolvePermissionMode(undefined, { cwd: root });
    expect(ctx.get()).toBe("default");
  });

  it("project defaultMode 'full_auto' → typed fail-loud propagates verbatim", () => {
    const root = scratchRoot();
    writeProjectSettings(root, {
      permissions: { defaultMode: "full_auto" },
    });

    let caught: unknown;
    try {
      resolvePermissionMode(undefined, { cwd: root });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProjectSettingsError);
    const settingsError = caught as ProjectSettingsError;
    expect(settingsError.kind).toBe("forbidden_default_mode");
    expect(settingsError.message).toMatch(/full_auto/);
  });

  it("no project root passed → env / default only (1-arg contract preserved)", () => {
    process.env.IKNOW_PERMISSION_MODE = "plan";
    expect(resolvePermissionMode(undefined).get()).toBe("plan");

    delete process.env.IKNOW_PERMISSION_MODE;
    expect(resolvePermissionMode(undefined).get()).toBe("default");
  });
});
