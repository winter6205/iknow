/**
 * Layer 1 (specs/subagent-layers-worktree-deps.md items 2–3) — provision
 * installs PROJECT deps from the tree's lockfile, silently and fail-open.
 *
 * Invariants pinned here (input-contract table "provision install" row):
 *   - empty       → no `package.json` / no lockfile → skip + reason, no spawn;
 *   - invalid     → lockfile present but manager binary missing → failure
 *                   reason, never a throw out of the provisioner;
 *   - concurrent  → second provision on a resolved tree is idempotent (no
 *                   second install);
 *   - exception   → install throw or non-zero exit → fail-open (the caller
 *                   keeps the worktree).
 *
 * The runner is injected: these tests never shell out to a real installer.
 * "Never install a global CLI" is asserted on the frozen argv table rather
 * than on a live binary (the argv IS the SSOT the installer consumes).
 */
import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TIMEOUT_TIER_MS } from "../../src/harness/aci/types.ts";
import { createCreateWorktreeTool } from "../../src/harness/aci/tools/create-worktree.ts";
import { createEnterWorktreeTool } from "../../src/harness/aci/tools/enter-worktree.ts";
import {
  PACKAGE_MANAGER_COMPLETION_MARKERS,
  PACKAGE_MANAGER_INSTALL_ARGS,
  PACKAGE_MANAGER_INSTALL_TIMEOUT_MS,
  PACKAGE_MANAGER_LOCKFILES,
  createPackageManagerRunner,
  createProjectDepProvisioner,
  resolvePackageManager,
  type PackageManagerInvocation,
  type PackageManagerRunner,
} from "../../src/session-api/worktree-deps.ts";

const roots: string[] = [];

function makeTree(): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-wt-deps-"));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** Write an executable file (the manager shims are `#!/bin/sh` scripts). */
function writeFileSyncMode(path: string, contents: string): void {
  writeFileSync(path, contents, { encoding: "utf8", mode: 0o755 });
  chmodSync(path, 0o755); // umask can strip the exec bit from `mode`
}

/**
 * Host env for a shim run: the shim's directory FIRST on PATH so
 * `execFile("npm", …)` resolves to it, plus the names
 * `createEnvIsolation`'s allowlist keeps (`PATH` is the one that matters).
 */
function shimEnv(binDir: string): NodeJS.ProcessEnv {
  return { PATH: `${binDir}:${process.env.PATH ?? ""}` };
}

/** Recording runner: every invocation is captured, result scripted per test. */
function makeRunner(
  result: PackageManagerRunner = async () => ({ code: 0, stderr: "" })
): { runner: PackageManagerRunner; calls: PackageManagerInvocation[] } {
  const calls: PackageManagerInvocation[] = [];
  return {
    calls,
    runner: async (invocation) => {
      calls.push(invocation);
      return result(invocation);
    },
  };
}

describe("lockfile → manager decision (pure)", () => {
  it("maps each supported lockfile to its manager", () => {
    expect(resolvePackageManager(["pnpm-lock.yaml"])).toBe("pnpm");
    expect(resolvePackageManager(["bun.lock"])).toBe("bun");
    expect(resolvePackageManager(["bun.lockb"])).toBe("bun");
    expect(resolvePackageManager(["package-lock.json"])).toBe("npm");
  });

  it("no lockfile → undefined (skip, never a guessed manager)", () => {
    expect(resolvePackageManager(["package.json", "README.md"])).toBe(
      undefined
    );
  });

  it("precedence is deterministic when several lockfiles exist (pnpm → bun → npm)", () => {
    expect(resolvePackageManager(["package-lock.json", "bun.lock"])).toBe(
      "bun"
    );
    expect(
      resolvePackageManager(["package-lock.json", "bun.lock", "pnpm-lock.yaml"])
    ).toBe("pnpm");
  });

  it("install argv never targets a global prefix (any manager)", () => {
    for (const [manager, args] of Object.entries(
      PACKAGE_MANAGER_INSTALL_ARGS
    )) {
      expect(args.join(" "), manager).not.toMatch(/(^|\s)-g(\s|$)/);
      expect(args.join(" "), manager).not.toMatch(/--global|--prefix/);
      expect(PACKAGE_MANAGER_LOCKFILES[manager as "npm"]).toBeDefined();
    }
  });
});

// D2 — the receipt must survive the enclosing ACI tier. Two independent
// mechanisms have to agree for that: the tool's tier has to outlive the
// install, and the install's own bound has to fire FIRST so the model gets a
// typed line instead of the executor's bare `timeout` (which discards the
// receipt while the install keeps running detached). Pinned as a relation
// rather than two literals so either side moving alone fails this test.
describe("install bound vs ACI tier (D2 — the receipt must land)", () => {
  it("the create-worktree tier outlives the install's own bound", () => {
    const tool = createCreateWorktreeTool({
      provision: async () => "/repo/.iknow/worktrees/conv-1",
      root: "/repo",
    });
    const tierMs = TIMEOUT_TIER_MS[tool.aci.timeoutTier];

    expect(tool.aci.timeoutTier).toBe("build");
    // strict: the install bound must expire with room to spare, otherwise the
    // tier timer can still win the race and drop the receipt
    expect(tierMs).toBeGreaterThan(PACKAGE_MANAGER_INSTALL_TIMEOUT_MS);
    // and the bound must clear a real install (measured: 53 s for one `npm ci`)
    expect(PACKAGE_MANAGER_INSTALL_TIMEOUT_MS).toBeGreaterThan(60_000);
  });

  // enter also runs the same ensure/install path as create, so its tier has to
  // outlive the install bound for the same reason: the executor's bare
  // `timeout` discards the install receipt while the install keeps running.
  // Mirrors the create assertion above as a sibling invariant.
  it("the enter-worktree tier outlives the install's own bound", () => {
    const tool = createEnterWorktreeTool({
      worktreeEnter: async () => ({
        path: "/repo/.iknow/worktrees/conv-1",
        receipt: "entered task worktree: /repo/.iknow/worktrees/conv-1",
      }),
      root: "/repo",
    });
    const tierMs = TIMEOUT_TIER_MS[tool.aci.timeoutTier];

    expect(tool.aci.timeoutTier).toBe("build");
    expect(tierMs).toBeGreaterThan(PACKAGE_MANAGER_INSTALL_TIMEOUT_MS);
  });
});

describe("createProjectDepProvisioner — skip / install / fail-open", () => {
  it("no package.json → skip with reason, zero runner calls", async () => {
    const tree = makeTree();
    const { runner, calls } = makeRunner();
    const result = await createProjectDepProvisioner({ runner })(tree);

    expect(result.status).toBe("skipped");
    expect(result.line).toMatch(/package\.json/);
    expect(calls).toEqual([]);
  });

  it("package.json without lockfile → skip with reason naming the lockfile gap", async () => {
    const tree = makeTree();
    await writeFile(join(tree, "package.json"), "{}", "utf8");
    const { runner, calls } = makeRunner();
    const result = await createProjectDepProvisioner({ runner })(tree);

    expect(result.status).toBe("skipped");
    expect(result.line).toMatch(/lockfile/i);
    expect(calls).toEqual([]);
  });

  it("lockfile present → runs the manager in the tree with the frozen argv", async () => {
    const tree = makeTree();
    await writeFile(join(tree, "package.json"), "{}", "utf8");
    await writeFile(
      join(tree, "pnpm-lock.yaml"),
      "lockfileVersion: 9\n",
      "utf8"
    );
    const { runner, calls } = makeRunner();
    const result = await createProjectDepProvisioner({ runner })(tree);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      manager: "pnpm",
      args: [...PACKAGE_MANAGER_INSTALL_ARGS.pnpm],
      cwd: tree,
    });
    expect(result.status).toBe("installed");
    expect(result.manager).toBe("pnpm");
    expect(result.line).toContain("pnpm");
  });

  it("already-resolved tree (install completed) → skip, no second install", async () => {
    const tree = makeTree();
    await writeFile(join(tree, "package.json"), "{}", "utf8");
    await writeFile(join(tree, "package-lock.json"), "{}\n", "utf8");
    // D3: evidence of a COMPLETED install, not the bare directory — see the
    // dedicated marker cases below for the per-manager pinning.
    await mkdir(join(tree, "node_modules"), { recursive: true });
    await writeFile(
      join(tree, PACKAGE_MANAGER_COMPLETION_MARKERS.npm),
      "{}\n",
      "utf8"
    );
    const { runner, calls } = makeRunner();
    const result = await createProjectDepProvisioner({ runner })(tree);

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("already_resolved");
    expect(result.line).toMatch(/already/i);
    expect(calls).toEqual([]);
  });

  it("missing manager binary (spawn throw) → failed, no rethrow", async () => {
    const tree = makeTree();
    await writeFile(join(tree, "package.json"), "{}", "utf8");
    await writeFile(join(tree, "bun.lock"), "\n", "utf8");
    const { runner, calls } = makeRunner(async () => {
      const err = new Error("spawn bun ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    const result = await createProjectDepProvisioner({ runner })(tree);

    expect(calls).toHaveLength(1);
    expect(result.status).toBe("failed");
    expect(result.manager).toBe("bun");
    expect(result.line).toMatch(/bun/);
    expect(result.line).toMatch(/ENOENT|not installed|missing/i);
  });

  it("non-zero install exit → failed with the manager's stderr, no rethrow", async () => {
    const tree = makeTree();
    await writeFile(join(tree, "package.json"), "{}", "utf8");
    await writeFile(join(tree, "package-lock.json"), "{}\n", "utf8");
    const { runner } = makeRunner(async () => ({
      code: 1,
      stderr: "npm ERR! Cannot read properties of undefined",
    }));
    const result = await createProjectDepProvisioner({ runner })(tree);

    expect(result.status).toBe("failed");
    expect(result.line).toMatch(/npm ci/);
    expect(result.line).toContain("npm ERR!");
  });

  // D11 — the DEFAULT path, actually executed. Every other case in this file
  // injects a runner, which left `defaultPackageManagerRunner` and
  // `createProjectDepProvisioner()`'s default wiring with zero coverage
  // (spec-reviewer verified the production runner by hand; that is a coverage
  // gap, not an implementation gap). These cases spawn a REAL subprocess: a
  // PATH-fronted shim records the argv/cwd/env it was handed, so the seam is
  // asserted end to end without touching a real installer.
  //
  // POSIX-only by construction: the shim is a `#!/bin/sh` script with
  // chmod +x, so on win32 the cases are skipped explicitly (vitest
  // `it.skipIf`) rather than failing on a platform the shim cannot serve.
  // `.claude/rules/test.md`: skip must state its reason, which the title and
  // this comment carry.
  describe("default runner path (real subprocess, PATH-fronted shim)", () => {
    /** Write an executable manager shim that records its argv/cwd/env, then exits. */
    function installShim(
      binDir: string,
      manager: string,
      exitCode: number
    ): { argvFile: string; cwdFile: string; envFile: string } {
      const argvFile = join(binDir, `${manager}.argv`);
      const cwdFile = join(binDir, `${manager}.cwd`);
      const envFile = join(binDir, `${manager}.env`);
      const script = [
        "#!/bin/sh",
        `printf '%s\\n' "$*" > ${JSON.stringify(argvFile)}`,
        `printf '%s\\n' "$PWD" > ${JSON.stringify(cwdFile)}`,
        `env > ${JSON.stringify(envFile)}`,
        `exit ${exitCode}`,
      ].join("\n");
      const shimPath = join(binDir, manager);
      writeFileSyncMode(shimPath, `${script}\n`);
      return { argvFile, cwdFile, envFile };
    }

    it.skipIf(process.platform === "win32")(
      "runs the real manager binary with the frozen argv in the tree and reports `installed`",
      async () => {
        const tree = makeTree();
        await writeFile(join(tree, "package.json"), "{}", "utf8");
        await writeFile(join(tree, "package-lock.json"), "{}\n", "utf8");
        const binDir = makeTree();
        const { argvFile, cwdFile } = installShim(binDir, "npm", 0);

        // PATH override is the injection point: `execFile("npm", …)` resolves
        // through it, so this exercises the real spawn without a real install.
        const runner = createPackageManagerRunner({ env: shimEnv(binDir) });
        const result = await createProjectDepProvisioner({ runner })(tree);

        expect(result.status).toBe("installed");
        expect(result.manager).toBe("npm");
        // the argv the manager ACTUALLY received == the frozen SSOT row
        expect(readFileSync(argvFile, "utf8").trim()).toBe(
          PACKAGE_MANAGER_INSTALL_ARGS.npm.join(" ")
        );
        // …and it ran in the new tree, not the process cwd
        expect(readFileSync(cwdFile, "utf8").trim()).toBe(tree);
      }
    );

    // D6 — the child env is the repo's allowlist, not the whole host env. The
    // shim dumps `env`, so a secret planted in the parent is visible iff the
    // install would really have handed it to a `postinstall` script.
    it.skipIf(process.platform === "win32")(
      "hands the install the allowlisted env only — a planted secret never reaches the child",
      async () => {
        const tree = makeTree();
        await writeFile(join(tree, "package.json"), "{}", "utf8");
        await writeFile(join(tree, "package-lock.json"), "{}\n", "utf8");
        const binDir = makeTree();
        const { envFile } = installShim(binDir, "npm", 0);

        const runner = createPackageManagerRunner({
          env: {
            ...shimEnv(binDir),
            IKNOW_TEST_PLANTED_SECRET: "leak-me-please",
          },
        });
        const result = await createProjectDepProvisioner({ runner })(tree);

        expect(result.status).toBe("installed");
        const childEnv = readFileSync(envFile, "utf8");
        expect(childEnv).not.toContain("leak-me-please");
        expect(childEnv).not.toContain("IKNOW_TEST_PLANTED_SECRET");
        // PATH survived the allowlist, which is what makes the spawn possible
        expect(childEnv).toContain(binDir);
      }
    );

    // D2 — the runner's own bound, measured on a real subprocess: a manager
    // that hangs is KILLED and reported as a typed timeout, and the call
    // returns control instead of hanging until the enclosing ACI tier fires.
    it.skipIf(process.platform === "win32")(
      "kills an install that outruns its bound and reports the typed timeout",
      async () => {
        const tree = makeTree();
        await writeFile(join(tree, "package.json"), "{}", "utf8");
        await writeFile(join(tree, "package-lock.json"), "{}\n", "utf8");
        const binDir = makeTree();
        const marker = join(binDir, "finished");
        writeFileSyncMode(
          join(binDir, "npm"),
          [
            "#!/bin/sh",
            // ignore TERM so only SIGKILL can end this — proves killSignal
            `trap '' TERM`,
            "sleep 30",
            `touch ${JSON.stringify(marker)}`,
            "exit 0",
            "",
          ].join("\n")
        );

        const started = Date.now();
        const runner = createPackageManagerRunner({
          env: shimEnv(binDir),
          timeoutMs: 400,
        });
        const result = await createProjectDepProvisioner({ runner })(tree);
        const elapsed = Date.now() - started;

        expect(result.status).toBe("failed");
        expect(result.line).toMatch(/timed out/i);
        expect(result.line).toContain("npm ci");
        // returned promptly (bound + kill), it did not wait out the sleep
        expect(elapsed).toBeLessThan(10_000);
        // the killed manager never reached its completion side effect
        expect(existsSync(marker)).toBe(false);
      }
    );

    // A missing manager binary is a spawn failure, NOT an install result: it
    // must reject into the "could not run" branch, which is what distinguishes
    // it in the receipt.
    it.skipIf(process.platform === "win32")(
      "reports a missing manager binary through the `could not run` branch",
      async () => {
        const tree = makeTree();
        await writeFile(join(tree, "package.json"), "{}", "utf8");
        await writeFile(
          join(tree, "pnpm-lock.yaml"),
          "lockfileVersion: 9\n",
          "utf8"
        );

        const runner = createPackageManagerRunner({
          // no PATH entry can resolve `pnpm` here
          env: { PATH: makeTree() },
        });
        const result = await createProjectDepProvisioner({ runner })(tree);

        expect(result.status).toBe("failed");
        expect(result.line).toMatch(/could not run/i);
        expect(result.line).toContain("pnpm");
      }
    );
  });

  it("checks package.json before the lockfile (a stray lockfile alone still skips)", async () => {
    const tree = makeTree();
    await writeFile(join(tree, "package-lock.json"), "{}\n", "utf8");
    const { runner, calls } = makeRunner();
    const result = await createProjectDepProvisioner({ runner })(tree);

    expect(result.status).toBe("skipped");
    expect(result.line).toMatch(/package\.json/);
    expect(calls).toEqual([]);
  });

  it("missing tree directory → failed (fail-open), never a throw", async () => {
    const { runner, calls } = makeRunner();
    const result = await createProjectDepProvisioner({ runner })(
      join(tmpdir(), "iknow-wt-deps-does-not-exist")
    );

    expect(result.status).toBe("failed");
    expect(calls).toEqual([]);
  });

  it("a throwing runner is reported as failed, never propagated", async () => {
    const tree = makeTree();
    await writeFile(join(tree, "package.json"), "{}", "utf8");
    await writeFile(join(tree, "bun.lockb"), "\n", "utf8");
    const { runner } = makeRunner(async () => {
      throw new Error("EACCES: permission denied");
    });
    const result = await createProjectDepProvisioner({ runner })(tree);

    expect(result.status).toBe("failed");
    expect(result.line).toContain("EACCES");
  });

  // D3 — a `node_modules` left half-written by a failed install is NOT
  // evidence that the tree is ready. The old assertion here was
  // `status === "skipped"` for exactly this input, which pinned the bug: one
  // failed install would mark the tree resolved forever. The replacement is
  // strictly stronger — it pins BOTH directions (the install must re-run, and
  // nothing may delete the partial tree) where the old one pinned only the
  // second, and it pins them on an input that must not take the skip path.
  it("a half-written node_modules from an earlier failed install is re-installed, not judged ready, and never deleted", async () => {
    const tree = makeTree();
    await writeFile(join(tree, "package.json"), "{}", "utf8");
    await writeFile(join(tree, "package-lock.json"), "{}\n", "utf8");
    const partial = join(tree, "node_modules", "half");
    await mkdir(partial, { recursive: true });
    const { runner, calls } = makeRunner(async () => ({
      code: 1,
      stderr: "boom",
    }));
    const result = await createProjectDepProvisioner({ runner })(tree);

    // no completion marker → the manager is invoked again (idempotent retry)
    expect(calls).toHaveLength(1);
    expect(result.status).toBe("failed");
    // fail-open: no rollback, no rm -rf — the partial tree survives untouched
    expect(existsSync(partial)).toBe(true);
  });

  // D3 — the positive direction, per manager: the marker the manager writes on
  // COMPLETION is what makes the skip legitimate. Asserted on the frozen SSOT
  // rather than a literal path so a marker move cannot silently drop the skip.
  it("skips on the manager's completion marker (npm hidden lockfile)", async () => {
    const tree = makeTree();
    await writeFile(join(tree, "package.json"), "{}", "utf8");
    await writeFile(join(tree, "package-lock.json"), "{}\n", "utf8");
    const marker = PACKAGE_MANAGER_COMPLETION_MARKERS.npm;
    await mkdir(join(tree, "node_modules"), { recursive: true });
    await writeFile(join(tree, marker), "{}\n", "utf8");
    const { runner, calls } = makeRunner();
    const result = await createProjectDepProvisioner({ runner })(tree);

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("already_resolved");
    expect(result.line).toContain(marker);
    expect(calls).toEqual([]);
  });

  it("skips on the manager's completion marker (pnpm workspace state)", async () => {
    const tree = makeTree();
    await writeFile(join(tree, "package.json"), "{}", "utf8");
    await writeFile(
      join(tree, "pnpm-lock.yaml"),
      "lockfileVersion: 9\n",
      "utf8"
    );
    const marker = PACKAGE_MANAGER_COMPLETION_MARKERS.pnpm;
    await mkdir(join(tree, "node_modules"), { recursive: true });
    await writeFile(join(tree, marker), "lockfileVersion: 9\n", "utf8");
    const { runner, calls } = makeRunner();
    const result = await createProjectDepProvisioner({ runner })(tree);

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("already_resolved");
    expect(result.line).toContain(marker);
    expect(calls).toEqual([]);
  });

  // bun writes no completion marker of its own (measured: hoisted trees carry
  // no dot-entry at all for a bin-less dependency set), so its evidence is a
  // non-empty `node_modules`. An EMPTY directory is not evidence and must not
  // be confused with the marker path.
  it("bun: a non-empty node_modules is evidence, an empty one is not", async () => {
    const tree = makeTree();
    await writeFile(join(tree, "package.json"), "{}", "utf8");
    await writeFile(join(tree, "bun.lock"), "\n", "utf8");
    await mkdir(join(tree, "node_modules"), { recursive: true });

    const empty = makeRunner();
    const emptyResult = await createProjectDepProvisioner({
      runner: empty.runner,
    })(tree);
    expect(empty.calls).toHaveLength(1);

    await mkdir(join(tree, "node_modules", "lodash"), { recursive: true });
    const nonEmpty = makeRunner();
    const nonEmptyResult = await createProjectDepProvisioner({
      runner: nonEmpty.runner,
    })(tree);
    expect(nonEmpty.calls).toEqual([]);
    expect(nonEmptyResult.reason).toBe("already_resolved");
    expect(emptyResult.reason).toBe(undefined);
  });

  // D2 — the receipt must survive a slow install. The runner's own bound fires
  // long before the enclosing ACI tier, so the provisioner reports a typed
  // failure line instead of the tool call dying with a bare `timeout`.
  it("an install that outruns the bound reports a typed failure line, never a bare timeout", async () => {
    const tree = makeTree();
    await writeFile(join(tree, "package.json"), "{}", "utf8");
    await writeFile(join(tree, "package-lock.json"), "{}\n", "utf8");
    const { runner } = makeRunner(async () => ({
      code: 0,
      stderr: "",
      timedOut: true,
    }));
    const result = await createProjectDepProvisioner({ runner })(tree);

    expect(result.status).toBe("failed");
    expect(result.manager).toBe("npm");
    // the receipt says WHAT happened and what to do — not just "timeout"
    expect(result.line).toMatch(/timed out/i);
    expect(result.line).toContain("npm ci");
    expect(result.line).toMatch(/install manually/i);
  });
});
