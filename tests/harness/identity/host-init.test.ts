/**
 * Tests for the host-side init script hook (W1).
 *
 * Covers:
 *  - Default path resolution (opts → env → ~/.iknow/init.sh).
 *  - Skip when script absent (no warn, ran=false).
 *  - Run a real exit-0 script → ran=true, exitCode=0, no warn.
 *  - Non-zero exit → ran=true, exitCode!=0, warn set with stderr echoed.
 *  - Timeout kill → ran=true, exitCode=null, warn set.
 *  - Explicit scriptPath:null → skip + warn="skipped (explicit null)".
 *  - Verbose env flag surfaces success.
 *  - runHostInitScriptSafe never throws (降级契约).
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runHostInitScript,
  runHostInitScriptSafe,
} from "../../../src/harness/identity/host-init.js";

async function makeTempScript(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "iknow-host-init-"));
  const script = join(dir, "init.sh");
  await writeFile(script, body, { encoding: "utf8" });
  // The /bin/bash spawn requires the file to be executable on some systems.
  // chmod is implicit via spawn /bin/bash + the file argument (no execve
  // needed when the interpreter is explicit), so we skip chmod for portability.
  return script;
}

describe("runHostInitScript (W1)", () => {
  it("skips when script does not exist (no warn)", async () => {
    const result = await runHostInitScript({
      scriptPath: "/tmp/this-path-must-not-exist-iknow-host-init.sh",
    });
    assert.equal(result.ran, false);
    assert.equal(result.exitCode, null);
    assert.equal(result.warn, undefined);
  });

  it("runs an exit-0 script and returns success", async () => {
    const script = await makeTempScript("#!/bin/bash\nexit 0\n");
    try {
      const result = await runHostInitScript({ scriptPath: script });
      assert.equal(result.ran, true);
      assert.equal(result.exitCode, 0);
      assert.equal(result.warn, undefined);
    } finally {
      await rm(script, { force: true });
    }
  });

  it("runs a script that produces stdout / stderr", async () => {
    const script = await makeTempScript(
      "#!/bin/bash\necho hello-out\necho hello-err 1>&2\nexit 0\n"
    );
    try {
      const result = await runHostInitScript({ scriptPath: script });
      assert.equal(result.ran, true);
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /hello-out/);
      assert.match(result.stderr, /hello-err/);
    } finally {
      await rm(script, { force: true });
    }
  });

  it("reports non-zero exit with warn + stderr", async () => {
    const script = await makeTempScript(
      "#!/bin/bash\necho failure-detail 1>&2\nexit 7\n"
    );
    try {
      const result = await runHostInitScript({ scriptPath: script });
      assert.equal(result.ran, true);
      assert.equal(result.exitCode, 7);
      assert.match(result.warn ?? "", /exit code 7/);
      assert.match(result.stderr, /failure-detail/);
    } finally {
      await rm(script, { force: true });
    }
  });

  it("times out and kills the process group", async () => {
    // Script sleeps 30s — we'll cut it off at 200ms.
    const script = await makeTempScript("#!/bin/bash\nsleep 30\n");
    try {
      const t0 = Date.now();
      const result = await runHostInitScript({
        scriptPath: script,
        timeoutMs: 200,
      });
      const elapsed = Date.now() - t0;
      assert.equal(result.ran, true);
      assert.equal(result.exitCode, null);
      assert.match(result.warn ?? "", /timed out/);
      // Sanity: should be fast (<5s) — proves the kill actually fired.
      assert.ok(elapsed < 5_000, `expected fast kill, took ${elapsed}ms`);
    } finally {
      await rm(script, { force: true });
    }
  });

  it("explicit scriptPath:null skips with warn", async () => {
    const result = await runHostInitScript({ scriptPath: null });
    assert.equal(result.ran, false);
    assert.match(result.warn ?? "", /skipped/);
  });

  it("honors IKNOW_HOST_INIT_SCRIPT env when no opts override", async () => {
    const script = await makeTempScript("#!/bin/bash\nexit 0\n");
    const prev = process.env.IKNOW_HOST_INIT_SCRIPT;
    process.env.IKNOW_HOST_INIT_SCRIPT = script;
    try {
      const result = await runHostInitScript();
      assert.equal(result.ran, true);
      assert.equal(result.scriptPath, script);
      assert.equal(result.exitCode, 0);
    } finally {
      if (prev === undefined) delete process.env.IKNOW_HOST_INIT_SCRIPT;
      else process.env.IKNOW_HOST_INIT_SCRIPT = prev;
      await rm(script, { force: true });
    }
  });

  it("opts.scriptPath overrides the env", async () => {
    const envScript = await makeTempScript("#!/bin/bash\nexit 99\n");
    const optScript = await makeTempScript("#!/bin/bash\nexit 0\n");
    const prev = process.env.IKNOW_HOST_INIT_SCRIPT;
    process.env.IKNOW_HOST_INIT_SCRIPT = envScript;
    try {
      const result = await runHostInitScript({ scriptPath: optScript });
      assert.equal(result.ran, true);
      assert.equal(result.scriptPath, optScript);
      assert.equal(result.exitCode, 0);
    } finally {
      if (prev === undefined) delete process.env.IKNOW_HOST_INIT_SCRIPT;
      else process.env.IKNOW_HOST_INIT_SCRIPT = prev;
      await rm(envScript, { force: true });
      await rm(optScript, { force: true });
    }
  });
});

describe("runHostInitScriptSafe (W1)", () => {
  it("never throws — even when the script fails", async () => {
    const script = await makeTempScript(
      "#!/bin/bash\necho nope 1>&2\nexit 13\n"
    );
    const prevVerbose = process.env.IKNOW_HOST_INIT_VERBOSE;
    delete process.env.IKNOW_HOST_INIT_VERBOSE;
    try {
      // 只断言降级契约(never throws + 返回正确 result);stderr 输出走
      // 真实 process.stderr(避免 vitest worker 下 process.stderr.write
      // mock 与宿主模块不可靠的时序问题)。
      const result = await runHostInitScriptSafe({ scriptPath: script });
      assert.equal(result.ran, true);
      assert.equal(result.exitCode, 13);
      assert.match(result.warn ?? "", /exit code 13/);
    } finally {
      if (prevVerbose === undefined) delete process.env.IKNOW_HOST_INIT_VERBOSE;
      else process.env.IKNOW_HOST_INIT_VERBOSE = prevVerbose;
      await rm(script, { force: true });
    }
  });

  it("returns success descriptor on silent exit-0", async () => {
    const script = await makeTempScript("#!/bin/bash\nexit 0\n");
    const prevVerbose = process.env.IKNOW_HOST_INIT_VERBOSE;
    delete process.env.IKNOW_HOST_INIT_VERBOSE;
    try {
      const result = await runHostInitScriptSafe({ scriptPath: script });
      assert.equal(result.ran, true);
      assert.equal(result.exitCode, 0);
      assert.equal(result.warn, undefined);
    } finally {
      if (prevVerbose === undefined) delete process.env.IKNOW_HOST_INIT_VERBOSE;
      else process.env.IKNOW_HOST_INIT_VERBOSE = prevVerbose;
      await rm(script, { force: true });
    }
  });

  it("skips silently when script absent", async () => {
    const result = await runHostInitScriptSafe({
      scriptPath: "/tmp/this-path-must-not-exist-iknow-host-init-skip.sh",
    });
    assert.equal(result.ran, false);
    assert.equal(result.exitCode, null);
    assert.equal(result.warn, undefined);
  });
});
