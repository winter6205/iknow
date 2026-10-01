/**
 * T5 / ADR-0132 + ADR-0133 — the Bash handler must consume the SAME host root
 * context that permission admission consumed, and must reach the same verdict.
 *
 * ADR-0132 requires one trusted per-call snapshot shared by both gates, and
 * ADR-0133 requires the two to agree ("admission and the Bash handler must
 * consume the same host-owned root context and classification"). A permission
 * test alone cannot show that: it never runs the handler. This file closes
 * the gap by driving the REAL handler and comparing its gate against the
 * shared classifier fed the snapshot the handler itself builds.
 *
 * The commands are not executed: every case is a gate decision, and the target
 * files are real files on a real filesystem under one `mkdtemp` root, because
 * containment here is resolved through `realpath`.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";

import { createBashTool } from "../../../src/harness/aci/tools/bash.js";
import { snapshotBashCleanupRoots } from "../../../src/harness/sandbox/fence-tmp.js";
import {
  classifyBoundedCleanupException,
  findDangerousPattern,
} from "../../../src/harness/permission/hard-walls.js";
import { ToolExecutionError } from "../../../src/harness/errors.js";

/**
 * The fixture is module-scope because the `it` titles interpolate its paths.
 * Everything lives under one real temp root; nothing touches the repository's
 * `data/` or a user session directory.
 */
const root = realpathSync(mkdtempSync(join(tmpdir(), "bash-cleanup-roots-")));
const taskRoot = join(root, "task");
/** This identity's own session scratch — the handler's `tmpDir` option. */
const scratchRoot = join(root, "session-a", "fence-tmp");
/** A second identity's scratch: same shape, different path. */
const otherScratchRoot = join(root, "session-b", "fence-tmp");
const outside = join(root, "outside");
mkdirSync(taskRoot, { recursive: true });
mkdirSync(scratchRoot, { recursive: true });
mkdirSync(otherScratchRoot, { recursive: true });
mkdirSync(outside, { recursive: true });
mkdirSync(join(taskRoot, "sub"), { recursive: true });
writeFileSync(join(taskRoot, "tmp_pycheck.cjs"), "x");
writeFileSync(join(taskRoot, "user-note.md"), "user authored");
writeFileSync(join(taskRoot, ".env"), "SECRET=1");
writeFileSync(join(scratchRoot, "a.cjs"), "x");
writeFileSync(join(otherScratchRoot, "c.cjs"), "x");
writeFileSync(join(outside, "secret.txt"), "x");
symlinkSync(outside, join(taskRoot, "escape"));
symlinkSync(outside, join(scratchRoot, "escape"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The handler built exactly as production wires it: tmpDir + liveTaskRoot. */
function handler() {
  return createBashTool(taskRoot, {
    tmpDir: scratchRoot,
    liveTaskRoot: {
      read: () => taskRoot,
      bind: () => {},
      unbind: () => {},
    } as never,
  });
}

/** The snapshot the handler builds for itself — the value both gates must see. */
const HANDLER_ROOTS = snapshotBashCleanupRoots({
  tmpDir: scratchRoot,
  waveRoot: taskRoot,
});

/** The handler's gate verdict: `null` means it did not refuse at that gate. */
async function handlerVerdict(command: string): Promise<boolean> {
  try {
    await handler().handler({ command });
    return false;
  } catch (error) {
    if (
      error instanceof ToolExecutionError &&
      error.message.includes("bash: dangerous command rejected")
    ) {
      return true;
    }
    throw error;
  }
}

describe("the handler and the classifier read ONE root context", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["own scratch, $TMPDIR form", "rm -f $TMPDIR/a.cjs"],
    ["own scratch, absolute form", `rm -f ${scratchRoot}/a.cjs`],
    ["own scratch, several targets", "rm -f $TMPDIR/a.cjs $TMPDIR/a.cjs"],
    ["workspace file in taskRoot", "rm -f tmp_pycheck.cjs"],
    ["workspace user-created file", "rm -f user-note.md"],
    ["workspace absolute form", `rm -f ${taskRoot}/tmp_pycheck.cjs`],
    ["recursive form", "rm -rf $TMPDIR/a.cjs"],
    ["recursive workspace form", "rm -rf tmp_pycheck.cjs"],
    ["the scratch root itself", "rm -f $TMPDIR"],
    ["the taskRoot itself", `rm -f ${taskRoot}`],
    ["a directory target", "rm -f sub"],
    ["another identity's scratch", `rm -f ${otherScratchRoot}/c.cjs`],
    ["mixed scratch and workspace", `rm -f $TMPDIR/a.cjs ${taskRoot}/tmp_pycheck.cjs`],
    ["outside every root", `rm -f ${outside}/secret.txt`],
    ["escaping through a symlinked ancestor", "rm -f escape/secret.txt"],
    ["escaping scratch through a symlink", "rm -f $TMPDIR/escape/secret.txt"],
    ["a glob", "rm -f *.cjs"],
    ["an unresolved variable", "rm -f $NAME.cjs"],
    ["a protected target in the workspace", "rm -f .env"],
    ["a protected target in the scratch", "rm -f $TMPDIR/.env"],
    ["an unrelated destructive command", "rm -rf /"],
  ];

  for (const [why, command] of cases) {
    it(`agrees with the shared classifier — ${why}`, async () => {
      const classifierHit = findDangerousPattern(command, HANDLER_ROOTS);
      const refused = await handlerVerdict(command);
      // The contract, stated directly: the handler refuses if and only if the
      // shared wall still answers. A handler that refused an admitted command
      // (or admitted a denied one) is exactly the "reclassified with a broader
      // rule" failure ADR-0131/0132 forbid.
      assert.equal(
        refused,
        classifierHit !== null,
        `${command}: handler refusal must equal the classifier verdict`
      );
    });
  }

  it("every admitted case is admitted BY THE EXCEPTION, not by a wall that never fired", async () => {
    // The parity assertion above passes trivially for a command the wall never
    // matched. This is the check that actually earns the relaxation: for each
    // case that is NOT refused, the reason must be a real cleanup exception
    // over a contained target.
    const admitted: ReadonlyArray<readonly [string, string]> = [
      ["own scratch, $TMPDIR form", "rm -f $TMPDIR/a.cjs"],
      ["own scratch, absolute form", `rm -f ${scratchRoot}/a.cjs`],
      ["own scratch, several targets", "rm -f $TMPDIR/a.cjs $TMPDIR/a.cjs"],
      ["workspace file in taskRoot", "rm -f tmp_pycheck.cjs"],
      ["workspace user-created file", "rm -f user-note.md"],
      ["workspace absolute form", `rm -f ${taskRoot}/tmp_pycheck.cjs`],
    ];
    for (const [why, command] of admitted) {
      assert.equal(
        await handlerVerdict(command),
        false,
        `${why}: should be admitted`
      );
      const exception = classifyBoundedCleanupException(command, HANDLER_ROOTS);
      assert.notEqual(
        exception,
        null,
        `${why}: admission must be earned by a cleanup exception`
      );
      // And the targets it proved are inside the root it named.
      for (const target of exception!.targets) {
        assert.ok(
          target.startsWith(exception!.root + "/"),
          `${why}: target ${target} must sit under ${exception!.root}`
        );
      }
    }
  });
});

describe("the handler's roots are the ones it injects as $TMPDIR", () => {
  it("a scratch file is admitted, a foreign identity's identical file is not", async () => {
    // Both files exist and both are named `c.cjs` / `a.cjs`; only the identity
    // differs. If the handler had used any other scratch than the one it
    // injects, these two would answer alike.
    assert.equal(await handlerVerdict("rm -f $TMPDIR/a.cjs"), false);
    assert.equal(
      await handlerVerdict(`rm -f ${otherScratchRoot}/c.cjs`),
      true
    );
  });

  it("without a tmpDir the handler falls back to its own pad, still not a foreign one", async () => {
    const bare = createBashTool(taskRoot);
    // The fallback pad is a real mkdtemp directory, so a target inside the
    // configured scratch is outside it and the command is still refused.
    assert.equal(
      await (async () => {
        try {
          await bare.handler({ command: `rm -f ${scratchRoot}/a.cjs` });
          return false;
        } catch (error) {
          return (
            error instanceof ToolExecutionError &&
            error.message.includes("dangerous command rejected")
          );
        }
      })(),
      true
    );
  });
});
