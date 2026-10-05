/**
 * Name-pattern scan scope + the read-side coverage floor
 * (specs/effect-boundary-protection.md "Name patterns: materialization at each
 * fence assembly", issue #1155, scope revised).
 *
 * The scan root is the WORKSPACE directory, not the user's home. This file
 * pins the contract, not the enumerator:
 *   - the scan entry refuses an absent / non-directory / blank root at
 *     assembly (never a silently skipped scan arm);
 *   - no implicit exclusions: `node_modules`, hidden files, gitignored files
 *     and caches inside the scope are all enumerated;
 *   - the accepted coverage FLOOR is asserted explicitly, not papered over: a
 *     name match OUTSIDE the scan scope gets nothing physical from the name
 *     arm;
 *   - fixed sensitive paths (`~/.ssh` etc.) keep their direct mounts and are
 *     never enumerated by the name scan.
 *
 * Fixture discipline (same header discipline as
 * `protected-target-mount.test.ts`): every root is an mkdtemp scratch dir
 * created per case, `HOME` is redirected into the fixture, and the operator's
 * real `~/.ssh`, `~/.aws`, `~/.gnupg` and every real credential value are
 * never read, written or copied. No fixture value is a real credential.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import {
  createBwrapFence,
  type ProtectedTargetSkippedWarning,
} from "../../../src/harness/sandbox/bwrap.js";
import { createFsPolicy } from "../../../src/harness/sandbox/fs-policy.js";
import { ToolExecutionError } from "../../../src/harness/errors.js";
import {
  createProtectedTargetInventory,
  materializeProtectedTargets,
  protectedTargetBindPaths,
} from "../../../src/harness/sandbox/protected-targets.js";

import { canRunBwrapFence } from "../../_helpers/bwrap-capability.js";

const scratch: string[] = [];
function scratchDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A fixture workspace holding one match per pattern shape, plus the
 *  directories the "no implicit exclusions" rule names. */
function workspaceWithMatches(prefix: string): string {
  const ws = scratchDir(prefix);
  mkdirSync(join(ws, "certs"), { recursive: true });
  mkdirSync(join(ws, "node_modules", "server-pkg"), { recursive: true });
  mkdirSync(join(ws, ".cache"), { recursive: true });
  mkdirSync(join(ws, "build"), { recursive: true });
  writeFileSync(join(ws, ".gitignore"), "build/\n*.local\n");
  writeFileSync(join(ws, "certs", "server.pem"), "fixture\n");
  writeFileSync(
    join(ws, "node_modules", "server-pkg", "server.pem"),
    "fixture\n"
  );
  writeFileSync(join(ws, ".hidden.pem"), "fixture\n");
  writeFileSync(join(ws, ".env"), "fixture\n");
  writeFileSync(join(ws, ".env.production"), "fixture\n");
  // gitignored by `.gitignore` above — the walk does not honor ignore files,
  // so both enumerators must still find it.
  writeFileSync(join(ws, "build", "ignored.pem"), "fixture\n");
  writeFileSync(join(ws, "build", "config.local.pem"), "fixture\n");
  writeFileSync(join(ws, ".cache", "junk.key"), "fixture\n");
  writeFileSync(join(ws, "id_rsa"), "fixture\n");
  return ws;
}

describe("scan entry — an invalid scan root is a typed fail-loud, never a skipped scan", () => {
  it("refuses an ABSENT scan root at assembly", () => {
    const home = scratchDir("t2-scan-absent-home-");
    const absent = join(scratchDir("t2-scan-absent-"), "no-such-dir");
    assert.throws(
      () => createProtectedTargetInventory({ home, scanRoot: absent }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        /scan root .* does not exist/.test(String(error)),
      "an absent root must refuse, never assemble a fence whose name arm silently matched nothing"
    );
  });

  it("refuses a scan root that exists but is NOT a directory", () => {
    // `resolveWorkspaceRoot`'s `assertAbsoluteExists` accepts a regular file;
    // the scan entry is where "invalid" becomes observable.
    const root = scratchDir("t2-scan-file-");
    const file = join(root, "not-a-dir");
    writeFileSync(file, "fixture\n");
    assert.throws(
      () =>
        createProtectedTargetInventory({
          home: root,
          scanRoot: file,
        }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        /scan root .* is not a directory/.test(String(error)),
      "a file as scan scope would enumerate zero entries and report success"
    );
  });

  it("refuses a BLANK scan root and an OMITTED one", () => {
    const root = scratchDir("t2-scan-blank-");
    for (const scanRoot of ["", "   "]) {
      assert.throws(
        () => createProtectedTargetInventory({ home: root, scanRoot }),
        (error: unknown) =>
          error instanceof ToolExecutionError &&
          /scan root is blank/.test(String(error)),
        "blank is illegal input, not a fall-through to home"
      );
    }
    assert.throws(
      () => createProtectedTargetInventory({ home: root }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        /no name-pattern scan scope was supplied/.test(String(error)),
      "omitted scope is SC7(a) fail-loud: there is no implicit default root"
    );
  });
});

describe("scan scope — the workspace directory, one root for both fs modes", () => {
  it("(a) a name match INSIDE the workspace becomes an effective physical target", () => {
    const ws = workspaceWithMatches("t2-scan-inside-");
    const result = materializeProtectedTargets(
      createProtectedTargetInventory({ home: ws, scanRoot: ws })
    );
    const paths = result.targets.map((t) => t.path);
    assert.ok(paths.includes(join(ws, "certs", "server.pem")));
    assert.ok(paths.includes(join(ws, "id_rsa")));
    assert.ok(paths.includes(join(ws, ".env")));
    assert.ok(paths.includes(join(ws, ".env.production")));
  });

  it("(c) no implicit exclusions — node_modules, hidden, gitignored and cache are all enumerated", () => {
    const ws = workspaceWithMatches("t2-scan-noexcl-");
    const paths = materializeProtectedTargets(
      createProtectedTargetInventory({ home: ws, scanRoot: ws })
    ).targets.map((t) => t.path);
    for (const inScope of [
      join(ws, "node_modules", "server-pkg", "server.pem"),
      join(ws, ".hidden.pem"),
      join(ws, ".env"),
      join(ws, "build", "ignored.pem"),
      join(ws, "build", "config.local.pem"),
      join(ws, ".cache", "junk.key"),
    ]) {
      assert.ok(
        paths.includes(inScope),
        `${inScope} is inside the scan scope and must be protected — speed comes from the narrowed scope, never from skipping directories`
      );
    }
  });

  it("(b) COVERAGE FLOOR: a name match OUTSIDE the scan scope gets nothing physical", () => {
    // Asserted explicitly so the accepted trade stays visible rather than
    // reading as an accident: outside the scope, the name arm contributes no
    // mount. The designated remedy is an explicit concrete target (below).
    const root = scratchDir("t2-scan-floor-");
    const ws = join(root, "workspace");
    const elsewhere = join(root, "elsewhere");
    mkdirSync(ws, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(ws, "inside.pem"), "fixture\n");
    const outsideMatch = join(elsewhere, "outside.pem");
    writeFileSync(outsideMatch, "fixture\n");

    const withoutEscapeHatch = materializeProtectedTargets(
      createProtectedTargetInventory({ home: root, scanRoot: ws })
    );
    assert.deepEqual(
      withoutEscapeHatch.targets.map((t) => t.path),
      [join(ws, "inside.pem")],
      "only the in-scope match is a target"
    );
    assert.ok(
      !withoutEscapeHatch.targets.some((t) => t.path === outsideMatch),
      "the coverage floor: an out-of-scope name match receives no mount from the name arm"
    );

    // The escape hatch is unchanged: an explicit concrete target is a subtree
    // bind of its own, carrying the out-of-scope location physically.
    const withEscapeHatch = createProtectedTargetInventory({
      home: root,
      scanRoot: ws,
      extraTargets: [
        {
          targetClass: "operator_backup",
          arm: "credential",
          path: elsewhere,
        },
      ],
    });
    assert.ok(
      protectedTargetBindPaths(withEscapeHatch).some(
        (b) => b.path === elsewhere
      ),
      "an explicit concrete target is the designated remedy for an out-of-scope location"
    );
  });

  it("fixed sensitive paths keep their DIRECT mounts and are not enumerated by the name scan", () => {
    // `~/.ssh` is a subtree seed: its protection is a bind of the subtree, and
    // `id_rsa` inside it is a member of the name arm that adds nothing to it.
    const root = scratchDir("t2-scan-fixed-");
    const ws = join(root, "workspace");
    const home = join(root, "home");
    mkdirSync(ws, { recursive: true });
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "id_rsa"), "fixture\n");

    const inventory = createProtectedTargetInventory({
      home,
      scanRoot: ws,
    });
    const bindPaths = inventory.entries
      .map((e) => e.bindPath)
      .filter((p): p is string => p !== undefined);
    assert.ok(
      bindPaths.includes(join(home, ".ssh")),
      "the fixed sensitive path is protected directly by its own mount"
    );

    const result = materializeProtectedTargets(inventory);
    assert.ok(
      !result.targets.some((t) => t.path.startsWith(join(home, ".ssh"))),
      "the name scan never enumerates the fixed path — its own bind already covers it"
    );
  });
});

describe("mode proof — both fs modes scan the same root and order binds last", () => {
  function assemble(
    mode: "global" | "workspace",
    scanRoot: string
  ): {
    readonly argv: readonly string[];
  } {
    const ws = workspaceWithMatches("t2-mode-");
    return {
      argv: createBwrapFence({
        command: "bash",
        args: ["-c", "true"],
        fsPolicy: createFsPolicy({
          tmpDir: scratchDir("t2-mode-tmp-"),
          mode,
        }),
        env: { HOME: ws, PATH: "/usr/bin:/bin" },
        cwd: scratchDir("t2-mode-task-"),
        ...(mode === "workspace"
          ? {
              homeRoot: ws,
              workspaceRoot: ws,
              tmpRoot: scratchDir("t2-mode-wtmp-"),
            }
          : {}),
        protectedTargets: createProtectedTargetInventory({
          home: ws,
          scanRoot,
        }),
      }).argv,
    };
  }

  it("global mode mounts the SAME in-scope name matches workspace mode does", () => {
    // The scan scope is fs-mode-independent: global mode's writable `/` mount
    // is NOT what widens or narrows it, and neither is HOME or tmp.
    const ws = scratchDir("t2-mode-root-");
    mkdirSync(join(ws, "certs"), { recursive: true });
    writeFileSync(join(ws, "certs", "server.pem"), "fixture\n");

    const globalArgv = assemble("global", ws).argv;
    const workspaceArgv = assemble("workspace", ws).argv;
    for (const argv of [globalArgv, workspaceArgv]) {
      assert.ok(
        argv.includes(join(ws, "certs", "server.pem")),
        "the in-scope name match is an effective physical target in BOTH modes"
      );
    }
  });

  it("protected binds are ordered AFTER every writable bind and before --proc", () => {
    const ws = scratchDir("t2-mode-order-");
    mkdirSync(join(ws, "certs"), { recursive: true });
    const match = join(ws, "certs", "server.pem");
    writeFileSync(match, "fixture\n");

    const argv = assemble("workspace", ws).argv;
    const matchAt = argv.indexOf(match);
    const cwdBindAt = argv.indexOf("--bind");
    const procAt = argv.indexOf("--proc");
    assert.ok(
      matchAt > cwdBindAt,
      "the protected bind lands after the writable binds"
    );
    assert.ok(
      matchAt < procAt,
      "and before --proc, where the boundary block sits"
    );
  });
});

describe("W4 — a match that vanished before the bind takes the typed warn direction", () => {
  it("fires one ProtectedTargetSkippedWarning per vanished match and keeps the siblings", () => {
    const ws = workspaceWithMatches("t2-scan-vanished-");
    symlinkSync(join(ws, "gone-target.pem"), join(ws, "certs", "broken.pem"));
    const warnings: ProtectedTargetSkippedWarning[] = [];
    const argv = createBwrapFence({
      command: "bash",
      args: ["-c", "true"],
      fsPolicy: createFsPolicy({
        tmpDir: scratchDir("t2-scan-vanished-tmp-"),
        mode: "global",
      }),
      env: { HOME: ws, PATH: "/usr/bin:/bin" },
      cwd: scratchDir("t2-scan-vanished-task-"),
      protectedTargets: createProtectedTargetInventory({
        home: ws,
        scanRoot: ws,
      }),
      onProtectedTargetSkipped: (warning) => warnings.push(warning),
    }).argv;

    const vanished = warnings.filter(
      (w) => w.kind === "protected_target_absent_on_host"
    );
    assert.ok(
      vanished.some((w) => w.target === join(ws, "certs", "broken.pem")),
      "the disappearance is surfaced as a typed warning, not a silent drop"
    );
    assert.ok(
      (vanished[0]?.remainingProtected ?? 0) > 0,
      "the warning names how many protections survived — siblings stay mounted"
    );
    // The surviving siblings really are in argv, not merely counted.
    assert.ok(argv.includes(join(ws, "certs", "server.pem")));
    assert.ok(
      argv.includes(join(ws, "node_modules", "server-pkg", "server.pem"))
    );
  });
});

describe("W3 — a match behind a filesystem-arm ancestor is still masked on read", () => {
  /**
   * Capability gate, not a `bwrap --version` existence check: both cases below
   * really spawn the assembled fence argv (constant `--unshare-net`), so the
   * question is whether a fence can start HERE. The existence check passes on a
   * GHA runner that installed bwrap but has no user-namespace, and the refusal
   * (RTM_NEWADDR) then surfaces as a red instead of a skip.
   */
  const SKIP = !canRunBwrapFence();

  it.skipIf(SKIP)(
    "cat on a credential match whose only covering ancestor is a filesystem-arm entry is DENIED",
    () => {
      // `/.host-root` is registered as a FILESYSTEM-arm subtree (an operator
      // extra target), so `/.host-root/creds/.env` is a name-arm match whose
      // only covering ancestor carries no credential mask. Before the fix the
      // match landed in `coveredByAncestor`, got no bind and NO mask, and `cat`
      // returned the secret with status 0.
      const root = scratchDir("t2-w3-root-");
      const hostRoot = join(root, "host-root");
      mkdirSync(join(hostRoot, "creds"), { recursive: true });
      writeFileSync(join(hostRoot, "creds", ".env"), "FIXTURE-SECRET-VALUE\n");
      const tmp = scratchDir("t2-w3-tmp-");
      const task = scratchDir("t2-w3-task-");
      const warnings: ProtectedTargetSkippedWarning[] = [];

      // Sanity: the match IS covered by an ancestor, so no bind of its own is
      // emitted — the fix must not have converted this into a redundant bind.
      const inventory = createProtectedTargetInventory({
        home: root,
        scanRoot: root,
        extraTargets: [
          {
            targetClass: "host_read_root",
            arm: "filesystem",
            path: hostRoot,
          },
        ],
      });
      const result = materializeProtectedTargets(inventory);
      assert.deepEqual(result.targets, [], "the ancestor bind covers it");
      assert.deepEqual(
        result.coveredByAncestor.map((t) => t.path),
        [join(hostRoot, "creds", ".env")],
        "ancestor coverage is preserved (no redundant bind)"
      );

      const fence = createBwrapFence({
        command: "bash",
        args: ["-c", `cat ${join(hostRoot, "creds", ".env")}`],
        fsPolicy: createFsPolicy({ tmpDir: tmp, mode: "global" }),
        env: { HOME: root, PATH: "/usr/bin:/bin" },
        cwd: task,
        protectedTargets: inventory,
        protectCredentialReads: true,
        onProtectedTargetSkipped: (warning) => warnings.push(warning),
      });
      // Ancestor coverage is preserved: the fix adds a MASK, not a second
      // `--ro-bind` of the match. `/dev/null <path>` is the mask triple; a
      // redundant bind would be `<path> <path>`.
      const at = fence.argv.indexOf(join(hostRoot, "creds", ".env"));
      assert.ok(at > 0, "the match appears in argv — as a mask dest");
      assert.equal(
        fence.argv[at - 1],
        "/dev/null",
        "the match is masked with /dev/null, not bound a second time"
      );
      const r = spawnSync(fence.argv[0], fence.argv.slice(1), {
        encoding: "utf8",
      });
      const stdout = r.stdout ?? "";
      assert.ok(
        !stdout.includes("FIXTURE-SECRET-VALUE"),
        "the masked read must not return the bytes inside the fence"
      );
    }
  );

  it.skipIf(SKIP)(
    "control: a NON-credential entry under the same ancestor stays readable",
    () => {
      // The over-masking guard. The mask set is scoped by the MATCH's arm, not
      // by the ancestor's: `notes.txt` under the same filesystem-arm subtree is
      // no name-pattern match at all, so the read side must leave it readable.
      // Without this control, "mask every coveredByAncestor entry" would be
      // indistinguishable from "mask every file under the ancestor".
      const root = scratchDir("t2-w3-ctrl-");
      const hostRoot = join(root, "host-root");
      mkdirSync(join(hostRoot, "certs"), { recursive: true });
      const plain = join(hostRoot, "certs", "notes.txt");
      writeFileSync(plain, "PLAIN-FIXTURE-NOT-A-SECRET\n");
      const tmp = scratchDir("t2-w3-ctrl-tmp-");
      const task = scratchDir("t2-w3-ctrl-task-");

      const fence = createBwrapFence({
        command: "bash",
        args: ["-c", `cat ${plain}`],
        fsPolicy: createFsPolicy({ tmpDir: tmp, mode: "global" }),
        env: { HOME: root, PATH: "/usr/bin:/bin" },
        cwd: task,
        protectedTargets: createProtectedTargetInventory({
          home: root,
          scanRoot: root,
          extraTargets: [
            {
              targetClass: "host_read_root",
              arm: "filesystem",
              path: hostRoot,
            },
          ],
        }),
        protectCredentialReads: true,
        onProtectedTargetSkipped: () => undefined,
      });
      assert.ok(
        !fence.exactFileMaskPaths.includes(plain),
        "a non-credential file under the ancestor is not a mask dest"
      );
      const r = spawnSync(fence.argv[0], fence.argv.slice(1), {
        encoding: "utf8",
      });
      assert.ok(
        (r.stdout ?? "").includes("PLAIN-FIXTURE-NOT-A-SECRET"),
        "the read side stays scoped to the credential arm"
      );
    }
  );
});
