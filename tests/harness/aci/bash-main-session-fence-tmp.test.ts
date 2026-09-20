/**
 * ADR-0092 — main-session fence tmp.
 *
 * The session tmp keeps its host path `<sessionFolder>/fence-tmp/` (the
 * direction name is unchanged) but is **no longer** bound to the guest Linux
 * `/tmp`; `$TMPDIR` must equal that host path. Writes land on the host, never
 * inside taskRoot.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { createBashTool } from "../../../src/harness/aci/tools/bash.js";
import { createBwrapFence } from "../../../src/harness/sandbox/bwrap.js";
import { createFsPolicy } from "../../../src/harness/sandbox/fs-policy.js";
import { sanitizeConversationSegment } from "../../../src/harness/session-roots.js";
import { MAIN_SESSION_FENCE_TMP_DIR_NAME } from "../../../src/shared/session-tree-names.js";

const scratchPaths: string[] = [];

function makeScratch(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

afterEach(() => {
  for (const path of scratchPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function hasBwrap(): boolean {
  return spawnSync("bwrap", ["--version"], { stdio: "ignore" }).status === 0;
}

interface BashEnvelope {
  readonly output: string;
}

function parseBash(envelope: unknown): {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
} {
  return JSON.parse((envelope as BashEnvelope).output) as {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
  };
}

function makeSessionPad(): { readonly taskRoot: string; readonly pad: string } {
  const sessionFolder = makeScratch("main-session-folder-");
  const taskRoot = makeScratch("main-session-task-");
  const pad = join(sessionFolder, MAIN_SESSION_FENCE_TMP_DIR_NAME);
  mkdirSync(pad, { recursive: true });
  return { taskRoot, pad };
}

describe("main-session fence-tmp (ADR-0092)", () => {
  it("argv never binds the session pad at guest /tmp nor mounts a tmpfs", () => {
    const { taskRoot, pad } = makeSessionPad();
    const argv = createBwrapFence({
      command: "bash",
      args: ["-c", "true"],
      fsPolicy: createFsPolicy({
        tmpDir: pad,
      }),
      env: { PATH: "/bin", TMPDIR: pad },
      cwd: taskRoot,
    }).argv;

    assert.equal(
      argv.some((arg, i) => arg === "--tmpfs" && argv[i + 1] === "/tmp"),
      false,
      "per-invocation --tmpfs /tmp is retired (ADR-0092)"
    );
    assert.equal(
      argv.some(
        (arg, i) =>
          arg === "--bind" && argv[i + 1] === pad && argv[i + 2] === "/tmp"
      ),
      false,
      "the session pad is no longer aliased onto guest /tmp"
    );
    assert.equal(
      argv.some(
        (arg, i) =>
          (arg === "--bind" || arg === "--ro-bind" || arg === "--tmpfs") &&
          (argv[i + 1] === pad || argv[i + 2] === pad)
      ),
      false,
      "session tmp is never a bind/ro-bind/tmpfs target"
    );
    // It is still handed to the child as $TMPDIR via --setenv (host path, not
    // a guest mount), so the literal may appear only as a --setenv value.
    const setenvPadIdx = argv.findIndex(
      (arg, i) =>
        arg === "--setenv" && argv[i + 1] === "TMPDIR" && argv[i + 2] === pad
    );
    assert.notEqual(setenvPadIdx, -1, "expected --setenv TMPDIR <pad>");
  });

  it.skipIf(!hasBwrap())(
    "$TMPDIR equals the session tmp host path and writes land on the host (SC2 / SC3)",
    async () => {
      const { taskRoot, pad } = makeSessionPad();
      const bash = createBashTool(taskRoot, {
        tmpDir: pad,
      });
      const tmpdirOut = parseBash(
        await bash.handler({ command: 'printf %s "$TMPDIR"' })
      );
      assert.equal(tmpdirOut.code, 0, tmpdirOut.stderr);
      assert.equal(
        tmpdirOut.stdout,
        pad,
        `$TMPDIR must be the session tmp host path; got ${JSON.stringify(tmpdirOut.stdout)}`
      );
      const write = parseBash(
        await bash.handler({ command: 'printf persist-sc2 > "$TMPDIR/x"' })
      );
      assert.equal(write.code, 0, write.stderr);
      const read = parseBash(
        await bash.handler({ command: 'cat "$TMPDIR/x"' })
      );
      assert.equal(read.code, 0, read.stderr);
      assert.equal(read.stdout, "persist-sc2");
      assert.equal(readFileSync(join(pad, "x"), "utf8"), "persist-sc2");
      assert.equal(existsSync(join(taskRoot, "x")), false);
    }
  );

  it.skipIf(!hasBwrap())(
    "mktemp lands under $TMPDIR = the session tmp host dir",
    async () => {
      const { taskRoot, pad } = makeSessionPad();
      const bash = createBashTool(taskRoot, {
        tmpDir: pad,
      });
      const mk = parseBash(await bash.handler({ command: "mktemp" }));
      assert.equal(mk.code, 0, mk.stderr);
      const created = mk.stdout.trim();
      assert.ok(
        created.startsWith(`${pad}/`),
        `mktemp path ${created} must be under ${pad}`
      );
      const rel = created.slice(pad.length + 1);
      assert.equal(existsSync(join(pad, rel)), true);
    }
  );

  it.skipIf(!hasBwrap())(
    "projectDir + conversationId allocate <sessionFolder>/fence-tmp without escaping projectDir",
    async () => {
      const projectDir = makeScratch("main-session-project-");
      const taskRoot = makeScratch("main-session-task-");
      const conversationId = "conv/../escape";
      const bash = createBashTool(taskRoot, {
        projectDir,
      });
      const pad = join(
        projectDir,
        sanitizeConversationSegment(conversationId),
        MAIN_SESSION_FENCE_TMP_DIR_NAME
      );
      const tmpdirOut = parseBash(
        await bash.handler(
          { command: 'printf %s "$TMPDIR"' },
          { conversationId }
        )
      );
      assert.equal(tmpdirOut.code, 0, tmpdirOut.stderr);
      assert.equal(tmpdirOut.stdout, pad);
      assert.equal(existsSync(join(projectDir, "escape")), false);
    }
  );
});
