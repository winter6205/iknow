/**
 * The engine version has three homes: the pinned dependency range, the
 * `RIPGREP_VERSION` constant interpolated into the model-visible tool
 * description, and the generated `type-table.ts`. Nothing bound them together,
 * so a dependency bump could leave the model told a false version and the Node
 * fallback's type table quietly desynced from the binary that actually runs -
 * the failure `type-table.ts:4-9` says must never happen.
 *
 * This test is the binding. It asks the installed binary and compares.
 *
 * Skips (never fails) when the engine is absent: that path is the Node
 * fallback, covered by `engine-absent.test.ts`, and reporting it here as a
 * failure would double-count one condition.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

import { describe, it } from "vitest";

import {
  engineBinaryPath,
  RIPGREP_VERSION,
} from "../../../../src/harness/aci/search/engine-manifest.ts";
import { KNOWN_TYPES } from "../../../../src/harness/aci/search/type-table.ts";

const run = promisify(execFile);

/** Resolved once at module scope: the resolver is async and `it.skipIf` reads this synchronously. */
const engine: string | undefined = await engineBinaryPath();
const present = engine !== undefined && existsSync(engine);

async function engineStdout(
  binary: string,
  ...args: string[]
): Promise<string> {
  const { stdout } = await run(binary, args, { maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

describe("引擎版本与类型表同二进制绑定", () => {
  it.skipIf(!present)("RIPGREP_VERSION 等于二进制自报版本", async () => {
    const stdout = await engineStdout(engine!, "--version");
    const reported = /^ripgrep (\d+\.\d+\.\d+)/m.exec(stdout)?.[1];
    assert.ok(reported, `could not read a version out of: ${stdout}`);
    assert.equal(
      reported,
      RIPGREP_VERSION,
      "依赖二进制换了版本：同步改 RIPGREP_VERSION，并按 type-table.ts 头部的说明重新生成该表"
    );
  });

  it.skipIf(!present)(
    "type-table 的类型名集合等于二进制 --type-list",
    async () => {
      const stdout = await engineStdout(engine!, "--type-list");
      const fromEngine = new Set(
        stdout
          .split("\n")
          .map((line) => line.split(":")[0]?.trim())
          .filter(
            (name): name is string => name !== undefined && name.length > 0
          )
      );
      assert.ok(
        fromEngine.size > 0,
        "the binary reported no types; the guard would pass vacuously"
      );

      const missing = [...fromEngine].filter((name) => !KNOWN_TYPES.has(name));
      const extra = [...KNOWN_TYPES].filter((name) => !fromEngine.has(name));
      assert.deepEqual(
        { missing, extra },
        { missing: [], extra: [] },
        "类型表与二进制不一致：按 type-table.ts 头部的说明用该二进制的 --type-list 重新生成"
      );
    }
  );
});
