/**
 * T1 — 主会话围栏 /tmp 垫底（specs/parent-visible-tmp.md SC1 / SC9 / SC10）。
 *
 * 垫底目录名钉死为会话文件夹下的 `fence-tmp/`（不与 T3 `subagents/<taskId>/` 碰撞）。
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
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { createBashTool } from "../../../src/harness/aci/tools/bash.js";
import { createBwrapFence } from "../../../src/harness/sandbox/bwrap.js";
import { createFsPolicy } from "../../../src/harness/sandbox/fs-policy.js";
import { createNetworkPolicy } from "../../../src/harness/sandbox/network-policy.js";
import { createResourceLimits } from "../../../src/harness/sandbox/resource-limits.js";
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

describe("main-session fence-tmp pad (T1)", () => {
  it("argv binds the session pad at /tmp and does not mount a per-invocation tmpfs", () => {
    const { taskRoot, pad } = makeSessionPad();
    const argv = createBwrapFence({
      command: "bash",
      args: ["-c", "true"],
      fsPolicy: createFsPolicy({
        cwd: taskRoot,
        home: homedir(),
        tmpDir: pad,
      }),
      networkPolicy: createNetworkPolicy(),
      resourceLimits: createResourceLimits(),
      env: { PATH: "/bin", TMPDIR: "/tmp" },
      cwd: taskRoot,
    }).argv;

    const tmpfsAtTmp = argv.some(
      (arg, i) => arg === "--tmpfs" && argv[i + 1] === "/tmp"
    );
    assert.equal(
      tmpfsAtTmp,
      false,
      "per-invocation --tmpfs /tmp is retired (ADR-0074)"
    );

    const bindPadAsTmp = argv.some(
      (arg, i) =>
        arg === "--bind" && argv[i + 1] === pad && argv[i + 2] === "/tmp"
    );
    assert.equal(
      bindPadAsTmp,
      true,
      `expected --bind ${pad} /tmp; argv=${JSON.stringify(argv)}`
    );
  });

  it.skipIf(!hasBwrap())(
    "two sequential bash calls in one main session persist /tmp/x (SC1) and do not copy it into taskRoot (SC10)",
    async () => {
      const { taskRoot, pad } = makeSessionPad();
      const bash = createBashTool(taskRoot, {
        tmpDir: pad,
        home: makeScratch("home-"),
      });
      const write = parseBash(
        await bash.handler({ command: "printf persist-sc1 >/tmp/x" })
      );
      assert.equal(write.code, 0, write.stderr);
      const read = parseBash(await bash.handler({ command: "cat /tmp/x" }));
      assert.equal(read.code, 0, read.stderr);
      assert.equal(read.stdout, "persist-sc1");
      assert.equal(readFileSync(join(pad, "x"), "utf8"), "persist-sc1");
      assert.equal(existsSync(join(taskRoot, "x")), false);
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
        home: makeScratch("home-"),
      });
      const write = parseBash(
        await bash.handler(
          { command: "printf via-project >/tmp/x" },
          { conversationId }
        )
      );
      assert.equal(write.code, 0, write.stderr);
      const pad = join(
        projectDir,
        sanitizeConversationSegment(conversationId),
        MAIN_SESSION_FENCE_TMP_DIR_NAME
      );
      assert.equal(readFileSync(join(pad, "x"), "utf8"), "via-project");
      assert.equal(existsSync(join(projectDir, "escape")), false);
    }
  );

  it.skipIf(!hasBwrap())(
    "TMPDIR and mktemp land on the same main-session fence-tmp pad (SC9)",
    async () => {
      const { taskRoot, pad } = makeSessionPad();
      const bash = createBashTool(taskRoot, {
        tmpDir: pad,
        home: makeScratch("home-"),
      });
      const tmpdirOut = parseBash(
        await bash.handler({ command: 'printf %s "$TMPDIR"' })
      );
      assert.equal(tmpdirOut.code, 0, tmpdirOut.stderr);
      assert.ok(
        tmpdirOut.stdout === "/tmp" || tmpdirOut.stdout.startsWith("/tmp/"),
        `TMPDIR must be /tmp or a child; got ${JSON.stringify(tmpdirOut.stdout)}`
      );
      const mk = parseBash(await bash.handler({ command: "mktemp" }));
      assert.equal(mk.code, 0, mk.stderr);
      const created = mk.stdout.trim();
      assert.ok(created.startsWith("/tmp"), `mktemp path ${created}`);
      const rel = created.replace(/^\/tmp\/?/, "");
      assert.ok(rel.length > 0, "mktemp must create a file under /tmp");
      assert.equal(existsSync(join(pad, rel)), true);
    }
  );
});
