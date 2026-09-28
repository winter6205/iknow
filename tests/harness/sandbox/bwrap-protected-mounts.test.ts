/**
 * T7 mount layer — protected-target `--ro-bind` block in createBwrapFence argv
 * (specs/effect-boundary-protection.md SC1/SC5/SC7(a)/SC8/SC10).
 *
 * Pure argv-shape surface (no bwrap dependency; real-fence behavior lives in
 * protected-target-mount.test.ts):
 *   - present inventory targets emit `--ro-bind src src` AFTER every writable
 *     bind and before `--proc` (last-mount-wins: the ro override lands above
 *     the workspace-tier write whitelists and the unbound-fence pad re-cover);
 *   - an absent target omits exactly its own triple — siblings stay present
 *     and ordered, the fence still assembles — and is reported as a typed
 *     ProtectedTargetSkippedWarning on the warn channel (not a counted
 *     failure, not model-facing noise), with a non-zero remainingProtected;
 *   - a PATH_MAX-or-over resolved path is a typed refusal BEFORE assembly
 *     completes: no argv tokens and no skip diagnostics at all — "refused"
 *     stays distinguishable from "dropped" (SC8a);
 *   - an argv that would exceed the kernel's expressible limits is a typed
 *     refusal naming the overflow before spawn, never an opaque E2BIG
 *     (SC8b);
 *   - global-mode argv with no protected targets configured is byte-identical
 *     to the pre-change shape (SC5 hard regression pin).
 *
 * Fixtures live in mkdtemp dirs only; the operator's real home and credentials
 * are never read or written (membership is pure resolved-path data, so unit
 * fixtures need not exist on disk except where presence is the point).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  createBwrapFence,
  OPTIONAL_HOST_RO_PREFIXES,
  type ProtectedTargetSkippedWarning,
} from "../../../src/harness/sandbox/bwrap.js";
import {
  READ_ONLY_SYSTEM_PATHS,
  createFsPolicy,
} from "../../../src/harness/sandbox/fs-policy.js";
import {
  createProtectedTargetInventory,
  type ProtectedTargetInventory,
} from "../../../src/harness/sandbox/protected-targets.js";
import { ToolExecutionError } from "../../../src/harness/errors.js";

const FIX_ROOT = mkdtempSync(join(tmpdir(), "iknow-t7-mount-"));
const HOME = join(FIX_ROOT, "home");
const TASK = join(FIX_ROOT, "task");
const TMP = join(FIX_ROOT, "tmp");
const PAD = join(FIX_ROOT, "pad");

// Deterministic presence set: these subtree targets exist on the host, these
// do not — the assembly-time existence check keys off exactly this.
const PRESENT = [".ssh", ".aws", ".gnupg", join(".config", "gh")];
const ABSENT = [".kube", ".docker", ".netrc"];

beforeAll(() => {
  mkdirSync(TASK, { recursive: true });
  mkdirSync(TMP, { recursive: true });
  mkdirSync(PAD, { recursive: true });
  for (const rel of PRESENT) mkdirSync(join(HOME, rel), { recursive: true });
});

afterAll(() => {
  rmSync(FIX_ROOT, { recursive: true, force: true });
});

function inventory(): ProtectedTargetInventory {
  return createProtectedTargetInventory({ home: HOME, scanRoot: HOME });
}

interface FenceCase {
  readonly mode?: "global" | "workspace";
  readonly protectedTargets?: ProtectedTargetInventory;
  readonly unboundFence?: { mainCheckout: string; tmpPad?: string };
  readonly args?: readonly string[];
}

function assemble(caseSpec: FenceCase): {
  readonly argv: readonly string[];
  readonly warnings: ProtectedTargetSkippedWarning[];
} {
  const warnings: ProtectedTargetSkippedWarning[] = [];
  const mode = caseSpec.mode ?? "global";
  const argv = createBwrapFence({
    command: "bash",
    args: caseSpec.args ?? ["-c", "true"],
    fsPolicy: createFsPolicy({ tmpDir: TMP, mode }),
    env: { PATH: "/bin" },
    cwd: TASK,
    ...(mode === "workspace"
      ? { homeRoot: HOME, workspaceRoot: TASK, tmpRoot: TMP }
      : {}),
    ...(caseSpec.protectedTargets
      ? { protectedTargets: caseSpec.protectedTargets }
      : {}),
    ...(caseSpec.unboundFence ? { unboundFence: caseSpec.unboundFence } : {}),
    onProtectedTargetSkipped: (warning) => warnings.push(warning),
  }).argv;
  return { argv, warnings };
}

function tripleIdx(
  argv: readonly string[],
  verb: string,
  target: string
): number {
  return argv.findIndex(
    (arg, i) => arg === verb && argv[i + 1] === target && argv[i + 2] === target
  );
}

function firstProtectedTripleIdx(argv: readonly string[]): number {
  return argv.findIndex(
    (arg, i) =>
      arg === "--ro-bind" &&
      i + 2 < argv.length &&
      argv[i + 1] === argv[i + 2] &&
      argv[i + 1].startsWith(`${HOME}/`)
  );
}

describe("T7 protected-target mount block — argv shape pins", () => {
  it("SC5 hard pin: global argv with no protected targets is byte-identical to the pre-change shape", () => {
    const { argv, warnings } = assemble({});
    const expected = [
      "bwrap",
      "--unshare-user-try",
      "--unshare-net",
      "--die-with-parent",
      "--bind",
      "/",
      "/",
      ...READ_ONLY_SYSTEM_PATHS.flatMap((p) => ["--ro-bind", p, p]),
      ...OPTIONAL_HOST_RO_PREFIXES.filter((p) => existsSync(p)).flatMap((p) => [
        "--ro-bind",
        p,
        p,
      ]),
      "--proc",
      "/proc",
      "--dev-bind",
      "/dev",
      "/dev",
      "--clearenv",
      "--setenv",
      "PATH",
      "/bin",
      "--chdir",
      TASK,
      "--",
      "bash",
      "-c",
      "true",
    ];
    assert.deepEqual([...argv], expected);
    assert.deepEqual(warnings, []);
    // The warn callback being wired without an inventory is inert too.
    const withCallbackOnly = assemble({ protectedTargets: undefined });
    assert.deepEqual([...withCallbackOnly.argv], expected);
  });

  it("SC5 (the half the no-inventory pin cannot reach): with an inventory, global argv is the baseline PLUS exactly the workspace-scoped protected tokens — and nothing else", () => {
    // `SC5 hard pin` above only proves "absent inventory ⇒ unchanged". The
    // clause that actually matters is the other direction: a configured
    // inventory must ADD the protected layer and change NOTHING else, or
    // global mode's meaning has silently moved.
    //
    // The scan root is a separate fixture WORKSPACE, not `HOME`, because the
    // name arm's scope is `resolveWorkspaceRoot`'s directory: rooting it at the
    // fixture home would pin the withdrawn home-wide scope instead of the
    // contract, and a home-rooted token would make "no home-root-wide token"
    // untestable.
    const SC5_ROOT = mkdtempSync(join(tmpdir(), "iknow-sc5-"));
    try {
      const ws = join(SC5_ROOT, "ws");
      const home = join(SC5_ROOT, "home");
      const tmp = join(SC5_ROOT, "tmp");
      const cwd = join(SC5_ROOT, "cwd");
      const external = join(SC5_ROOT, "external-operator-target");
      for (const d of [ws, home, tmp, cwd, external]) {
        mkdirSync(d, { recursive: true });
      }
      // No `~/.ssh` and no other sensitive subtree exists here on purpose: the
      // fixture home holds NO protected path, so every extra token in argv is
      // attributable to the workspace-scoped name match or to the one explicit
      // concrete target, and a home-root-wide token would be plainly visible.
      mkdirSync(join(ws, "certs"), { recursive: true });
      writeFileSync(join(ws, "certs", "server.pem"), "fixture\n");

      const build = (withInventory: boolean): readonly string[] => {
        const base = {
          command: "bash",
          args: ["-c", "true"],
          fsPolicy: createFsPolicy({ tmpDir: tmp, mode: "global" as const }),
          env: { PATH: "/bin" },
          cwd,
        };
        return createBwrapFence({
          ...base,
          ...(withInventory
            ? {
                protectedTargets: createProtectedTargetInventory({
                  home,
                  scanRoot: ws,
                  extraTargets: [
                    {
                      targetClass: "operator_backup",
                      arm: "filesystem",
                      path: external,
                    },
                  ],
                }),
              }
            : {}),
          onProtectedTargetSkipped: () => undefined,
        }).argv;
      };

      const baseline = [...build(false)];
      const withInv = [...build(true)];

      // Exactly two extra PATHS in this fixture, both triples (src === dest):
      // the materialized workspace-scoped match and the one explicit concrete
      // target. Nothing else — so the "and nothing else" half of SC5 is what is
      // being asserted, not merely "something was added".
      const extraPaths = [
        ...new Set(withInv.filter((t) => !baseline.includes(t))),
      ].sort();
      assert.deepEqual(
        extraPaths,
        [join(ws, "certs", "server.pem"), external].sort(),
        "the inventory adds exactly the protected layer's tokens and nothing else"
      );

      // Nothing home-root-wide leaked in: the fixture home is a plain empty
      // directory and contributes ZERO tokens.
      assert.ok(
        !extraPaths.some((t) => t === home || t.startsWith(`${home}/`)),
        `no home-root-wide token may appear (SC5's only tightening is the protected layer); got ${JSON.stringify(extraPaths)}`
      );
      assert.ok(
        !baseline.some((t) => t === home || t.startsWith(`${home}/`)),
        "and the no-inventory baseline is home-agnostic to begin with"
      );
      assert.ok(
        extraPaths.every((t) => t.startsWith(`${ws}/`) || t === external),
        "every added path is either a workspace-scoped match or the explicit concrete target"
      );

      // Structural, not just set-theoretic: each delta lands as a real
      // `--ro-bind <path> <path>` triple in the boundary block, after every
      // writable bind and before `--proc` — and removing both triples
      // reproduces the baseline byte-for-byte.
      for (const added of extraPaths) {
        const idx = withInv.indexOf(added);
        assert.equal(withInv[idx - 1], "--ro-bind", `${added} is a ro-bind`);
        assert.equal(withInv[idx + 1], added, `${added} binds src to dest`);
        assert.ok(idx > withInv.indexOf("--bind"), `${added} follows the writable binds`);
        assert.ok(idx < withInv.indexOf("--proc"), `${added} is inside the boundary block`);
      }
      const dropSet = new Set(
        extraPaths.flatMap((p) => {
          const i = withInv.indexOf(p);
          return [i - 1, i, i + 1];
        })
      );
      const spliced = withInv.filter((_, i) => !dropSet.has(i));
      assert.deepEqual(
        spliced,
        baseline,
        "beyond the protected layer the argv is byte-identical to the no-inventory baseline"
      );
    } finally {
      rmSync(SC5_ROOT, { recursive: true, force: true });
    }
  });

  it("present targets emit --ro-bind triples after every writable bind, before --proc", () => {
    const { argv } = assemble({
      mode: "workspace",
      protectedTargets: inventory(),
      unboundFence: { mainCheckout: FIX_ROOT, tmpPad: PAD },
    });
    const procIdx = argv.indexOf("--proc");
    assert.ok(procIdx > 0);
    const first = firstProtectedTripleIdx(argv);
    assert.ok(first > 0 && first < procIdx, "block sits before --proc");
    // last-mount-wins: the ro block lands above every writable bind — the
    // workspace-tier write whitelists and the unbound-fence pad re-cover.
    for (const writable of [TASK, TMP, PAD]) {
      const bindIdx = tripleIdx(argv, "--bind", writable);
      assert.notEqual(bindIdx, -1, `${writable} has a writable bind`);
      assert.ok(
        first > bindIdx,
        `protected block must follow the writable bind of ${writable}`
      );
    }
    for (const rel of PRESENT) {
      const idx = tripleIdx(argv, "--ro-bind", join(HOME, rel));
      assert.ok(idx >= first, `${rel} is bound inside the block`);
    }
    // Entry order inside the block is inventory order.
    const sshIdx = tripleIdx(argv, "--ro-bind", join(HOME, ".ssh"));
    const awsIdx = tripleIdx(argv, "--ro-bind", join(HOME, ".aws"));
    const ghIdx = tripleIdx(argv, "--ro-bind", join(HOME, ".config", "gh"));
    assert.ok(sshIdx < awsIdx && awsIdx < ghIdx);
  });

  it("absent target omits exactly its own triple; siblings survive; fence assembles", () => {
    const { argv, warnings } = assemble({ protectedTargets: inventory() });
    for (const rel of ABSENT) {
      assert.equal(
        tripleIdx(argv, "--ro-bind", join(HOME, rel)),
        -1,
        `absent ${rel} contributes no argv tokens`
      );
    }
    const kube = warnings.find((w) => w.target === join(HOME, ".kube"));
    assert.ok(kube, "the absent .kube entry is diagnosed");
    assert.equal(kube.kind, "protected_target_absent_on_host");
    assert.equal(kube.targetClass, "kube_config");
    assert.ok(kube.remainingProtected > 0, "siblings are still enforced");
    // One skip never drops a sibling: every present target is still bound,
    // every present-target triple still follows the writable binds.
    for (const rel of PRESENT) {
      assert.notEqual(tripleIdx(argv, "--ro-bind", join(HOME, rel)), -1);
    }
    assert.ok(firstProtectedTripleIdx(argv) < argv.indexOf("--proc"));
    // The .netrc exact-file target is absent too — one warning per entry.
    assert.ok(warnings.some((w) => w.target === join(HOME, ".netrc")));
    // .docker exists? No — its exact bind path config.json was never created.
    assert.ok(
      warnings.some((w) => w.target === join(HOME, ".docker", "config.json"))
    );
  });

  it("system-block coverage dedups: no duplicate /etc /usr /opt triples, no /proc tokens", () => {
    const { argv } = assemble({ protectedTargets: inventory() });
    for (const p of READ_ONLY_SYSTEM_PATHS) {
      const first = tripleIdx(argv, "--ro-bind", p);
      const second = argv.findIndex(
        (arg, i) =>
          i > first &&
          arg === "--ro-bind" &&
          argv[i + 1] === p &&
          argv[i + 2] === p
      );
      assert.equal(second, -1, `${p} is ro-bound exactly once`);
    }
    // /etc/passwd and /etc/shadow live under the already-read-only /etc bind.
    assert.equal(tripleIdx(argv, "--ro-bind", "/etc/passwd"), -1);
    assert.equal(tripleIdx(argv, "--ro-bind", "/etc/shadow"), -1);
    // --proc remounts /proc wholesale: a protected block emitted before it
    // cannot cover /proc subtrees, so no host-proc tokens are emitted.
    assert.equal(tripleIdx(argv, "--ro-bind", "/proc/self/environ"), -1);
    assert.ok(
      !argv.some((a) => a === "/proc/self/environ"),
      "no /proc bind tokens at all"
    );
  });

  it("SC8a: a PATH_MAX-or-over resolved target is a typed refusal with zero argv tokens", () => {
    const overLong = `/${"a".repeat(4096)}`;
    const inv = createProtectedTargetInventory({
      home: HOME,
      scanRoot: HOME,
      extraTargets: [
        { targetClass: "test_overflow", arm: "filesystem", path: overLong },
      ],
    });
    let argv: readonly string[] | undefined;
    let caught: unknown;
    try {
      argv = assemble({ protectedTargets: inv }).argv;
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof ToolExecutionError, "typed refusal");
    assert.match(String(caught), /PATH_MAX/);
    assert.equal(argv, undefined, "refusal assembles no argv at all");
    // refused ≠ dropped: a refusal emits no skip warning either.
    assert.deepEqual(assembleWarningsOnly(inv), [], "no warnings pre-throw");
  });

  it("SC8b: an argv the kernel could not express is a typed refusal naming the overflow, before spawn", () => {
    const huge = "x".repeat(3 * 1024 * 1024);
    assert.throws(
      () => assemble({ protectedTargets: inventory(), args: ["-c", huge] }),
      (error: unknown) =>
        error instanceof ToolExecutionError && /overflow/i.test(String(error)),
      "overflow must be named in the typed refusal"
    );
    // The refusal is pre-spawn at assembly, not conditional on the protected
    // block being configured — the same shape without it is still refused.
    assert.throws(() => assemble({ args: ["-c", huge] }), ToolExecutionError);
  });

  it("SC7(a): a blank resolved target stays a typed fail-loud at inventory, never a half-formed pair", () => {
    assert.throws(
      () =>
        createProtectedTargetInventory({
          home: HOME,
          scanRoot: HOME,
          extraTargets: [{ targetClass: "x", arm: "filesystem", path: "   " }],
        }),
      ToolExecutionError
    );
    const { argv } = assemble({ protectedTargets: inventory() });
    assert.ok(!argv.includes(""));
  });
});

/**
 * The system read-only block is the fence's own baseline protection: every
 * system prefix stays `--ro-bind` at its exact position, and nothing ever
 * re-binds one of them writable. Lifted from the removed cleanup-receipt
 * suite — the pin is about the protection, not about any authorization.
 */
describe("system read-only binds — verb and position pins", () => {
  it("system read-only binds keep their exact verb and position", () => {
    const { argv } = assemble({ protectedTargets: inventory() });
    for (const prefix of ["/usr", "/bin", "/lib", "/lib64", "/etc"]) {
      assert.notEqual(
        tripleIdx(argv, "--ro-bind", prefix),
        -1,
        `${prefix} stays ro-bound`
      );
      assert.equal(
        tripleIdx(argv, "--bind", prefix),
        -1,
        `${prefix} is never re-bound writable anywhere in argv`
      );
    }
    const procIdx = argv.indexOf("--proc");
    const etcIdx = tripleIdx(argv, "--ro-bind", "/etc");
    assert.ok(etcIdx > -1 && etcIdx < procIdx, "ordering unchanged");
  });

  it("the system read-only mount shape is unchanged by the protected block", () => {
    const { argv } = assemble({ protectedTargets: inventory() });
    const baseline = assemble({}).argv;
    // Every system triple the baseline carries is present verbatim, in the
    // same relative order, once the protected block is wired.
    const systemTriples = (source: readonly string[]): string[][] =>
      READ_ONLY_SYSTEM_PATHS.map((p) => [
        "--ro-bind",
        p,
        p,
      ]).filter((t) => source.includes(t.join("\0")));
    assert.deepEqual(systemTriples(argv), systemTriples(baseline));
    for (const p of READ_ONLY_SYSTEM_PATHS) {
      const first = tripleIdx(argv, "--ro-bind", p);
      const second = argv.findIndex(
        (arg, i) =>
          i > first &&
          arg === "--ro-bind" &&
          argv[i + 1] === p &&
          argv[i + 2] === p
      );
      assert.equal(second, -1, `${p} is ro-bound exactly once`);
    }
  });
});

/**
 * T2 argv shape: a name-pattern match with no covering ancestor concrete rule
 * is emitted as a real `--ro-bind` inside the protected block, ordered after
 * the writable binds like every other target; a match already covered by an
 * ancestor subtree contributes no bind and leaves that ancestor's mount alone.
 */
describe("T2 name-pattern materialization — argv shape", () => {
  const MAT_ROOT = mkdtempSync(join(tmpdir(), "iknow-t2-argv-"));
  const MAT_HOME = join(MAT_ROOT, "home");
  const MAT_TASK = join(MAT_ROOT, "task");
  const MAT_TMP = join(MAT_ROOT, "tmp");
  const LOOSE = join(MAT_HOME, "project", "server.pem");
  const LOOSE_SIBLING = join(MAT_HOME, "project", "notes.txt");
  const ANCESTORED = join(MAT_HOME, ".ssh", "id_rsa");

  beforeAll(() => {
    mkdirSync(join(MAT_HOME, "project"), { recursive: true });
    mkdirSync(join(MAT_HOME, ".ssh"), { recursive: true });
    mkdirSync(MAT_TASK, { recursive: true });
    mkdirSync(MAT_TMP, { recursive: true });
    writeFileSync(LOOSE, "fixture\n");
    writeFileSync(LOOSE_SIBLING, "fixture\n");
    writeFileSync(ANCESTORED, "fixture\n");
  });

  afterAll(() => {
    rmSync(MAT_ROOT, { recursive: true, force: true });
  });

  function matAssemble(): {
    readonly argv: readonly string[];
    readonly warnings: ProtectedTargetSkippedWarning[];
  } {
    const warnings: ProtectedTargetSkippedWarning[] = [];
    const argv = createBwrapFence({
      command: "bash",
      args: ["-c", "true"],
      fsPolicy: createFsPolicy({ tmpDir: MAT_TMP, mode: "workspace" }),
      env: { PATH: "/bin" },
      cwd: MAT_TASK,
      homeRoot: MAT_HOME,
      workspaceRoot: MAT_TASK,
      tmpRoot: MAT_TMP,
      protectedTargets: createProtectedTargetInventory({
        home: MAT_HOME,
        scanRoot: MAT_HOME,
      }),
      protectCredentialReads: true,
      onProtectedTargetSkipped: (warning) => warnings.push(warning),
    }).argv;
    return { argv, warnings };
  }

  it("emits the uncovered match as an --ro-bind inside the protected block", () => {
    const { argv } = matAssemble();
    const idx = tripleIdx(argv, "--ro-bind", LOOSE);
    assert.ok(idx >= 0, "the materialized match carries a real ro-bind triple");
    assert.ok(idx < argv.indexOf("--proc"), "inside the protected block");
    assert.ok(
      idx > tripleIdx(argv, "--bind", MAT_TASK),
      "after every writable bind (last-mount-wins placement)"
    );
  });

  it("leaves the ancestor subtree's mount untouched and adds no bind of its own", () => {
    const { argv } = matAssemble();
    assert.equal(
      tripleIdx(argv, "--ro-bind", ANCESTORED),
      -1,
      "a match covered by the .ssh ancestor contributes no bind"
    );
    // The ancestor's own ro-bind stands exactly where the inventory puts it.
    const ssh = tripleIdx(argv, "--ro-bind", join(MAT_HOME, ".ssh"));
    assert.ok(ssh >= 0, "the .ssh ancestor subtree is still ro-bound");
    const loose = tripleIdx(argv, "--ro-bind", LOOSE);
    assert.ok(loose > ssh, "materialized targets follow the concrete block");
  });

  it("does not bind the non-matching sibling in the match's directory", () => {
    const { argv } = matAssemble();
    assert.equal(
      tripleIdx(argv, "--ro-bind", LOOSE_SIBLING),
      -1,
      "protection is scoped to the match, not to its directory"
    );
  });

  it("masks the materialized match's read side when credential reads are on", () => {
    const { argv } = matAssemble();
    const maskIdx = argv.findIndex(
      (arg, i) =>
        arg === "--ro-bind" && argv[i + 1] === "/dev/null" && argv[i + 2] === LOOSE
    );
    assert.ok(maskIdx >= 0, "the materialized match takes the per-file credential mask");
    assert.ok(
      maskIdx > tripleIdx(argv, "--ro-bind", LOOSE),
      "the read mask lands above the materialized ro-bind (one coordinated plan)"
    );
  });

  it("a name rule matching zero files on this host emits nothing and warns nothing", () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "iknow-t2-empty-"));
    try {
      const warnings: ProtectedTargetSkippedWarning[] = [];
      const argv = createBwrapFence({
        command: "bash",
        args: ["-c", "true"],
        fsPolicy: createFsPolicy({ tmpDir: emptyRoot, mode: "workspace" }),
        env: { PATH: "/bin" },
        cwd: emptyRoot,
        homeRoot: emptyRoot,
        workspaceRoot: emptyRoot,
        tmpRoot: emptyRoot,
        protectedTargets: createProtectedTargetInventory({
          home: emptyRoot,
          scanRoot: emptyRoot,
        }),
        onProtectedTargetSkipped: (warning) => warnings.push(warning),
      }).argv;
      assert.ok(!argv.includes(""), "no half-formed pair");
      const ssh = tripleIdx(argv, "--ro-bind", join(emptyRoot, ".ssh"));
      assert.ok(ssh < argv.indexOf("--proc"), "sibling subtree binds survive");
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});

function assembleWarningsOnly(
  inv: ProtectedTargetInventory
): ProtectedTargetSkippedWarning[] {
  const warnings: ProtectedTargetSkippedWarning[] = [];
  try {
    createBwrapFence({
      command: "bash",
      args: ["-c", "true"],
      fsPolicy: createFsPolicy({ tmpDir: TMP }),
      env: { PATH: "/bin" },
      cwd: TASK,
      protectedTargets: inv,
      onProtectedTargetSkipped: (warning) => warnings.push(warning),
    });
  } catch {
    // the refusal is the point; the collected warnings are the assertion.
  }
  return warnings;
}
