/**
 * Engine-absent contract for the npm-provisioned engine (ADR-0089).
 *
 * `@vscode/ripgrep` ships the per-platform binary as its own
 * `optionalDependencies` package, and its entry **throws at import time** when
 * that package is absent. That is the new way for the engine to be missing, and
 * it must degrade exactly like the old shapes did: the resolver answers
 * `undefined`, rg-engine tags the result `{kind:"unavailable"}`, and the Node
 * scan answers the call. A module-scope `import { rgPath }` would instead crash
 * the process — the resolver resolves lazily inside try/catch.
 *
 * `vi.doMock` + `vi.resetModules` (not the hoisted `vi.mock`) because each arm
 * needs its own module graph: one arm where the package resolves, one where it
 * throws. A single hoisted mock could only ever prove the throwing half, and
 * would pass against a resolver that ignores the package entirely.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, vi } from "vitest";

const MANIFEST = "../../../../src/harness/aci/search/engine-manifest.ts";
const GREP = "../../../../src/harness/aci/tools/grep.ts";

const scratchPaths: string[] = [];

async function makeScratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    scratchPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("engine provisioning — @vscode/ripgrep 的懒解析与缺席降级", () => {
  it("路径来自该包；包在 import 期抛错时解析器给 undefined，Node 遍历仍作答", async () => {
    // ── 1. The path comes from the package, not from a composed vendor path ──
    const sentinel = join(tmpdir(), "iknow-fake-rg", "bin", "rg");
    vi.doMock("@vscode/ripgrep", () => ({ rgPath: sentinel }));
    vi.resetModules();
    {
      const { engineBinaryPath } = await import(MANIFEST);
      assert.equal(
        await engineBinaryPath(),
        sentinel,
        "解析器必须原样给出依赖解析出的 rgPath，不得自行拼装路径"
      );
    }

    // ── 2. The throwing import degrades to `undefined`, and the call survives ──
    vi.doMock("@vscode/ripgrep", () => {
      throw new Error(
        "Could not find @vscode/ripgrep-fake-platform-x64. Ensure optionalDependencies are installed for this platform."
      );
    });
    vi.resetModules();
    const { engineBinaryPath } = await import(MANIFEST);
    const { DEGRADED_ENGINE_NOTICE, createGrepTool } = await import(GREP);

    assert.equal(
      await engineBinaryPath(),
      undefined,
      "包在 import 期抛错 ⇒ 解析器必须给出 undefined，而不是把错误抛给调用方"
    );

    const root = await makeScratch("grep-rg-absent-");
    await writeFile(join(root, "a.ts"), "alpha\nbeta hitOne\n", "utf8");

    // No deps override: production resolution, which now answers `undefined`
    // and therefore takes the same Node path as any other engine absence.
    const result = (await createGrepTool(root).handler({
      pattern: "hit",
      output: "content",
    })) as string;

    assert.equal(
      result,
      "a.ts:2:beta hitOne\n" + DEGRADED_ENGINE_NOTICE,
      "降级路径须附一行披露，且披露之前是完整的 Node 命中行"
    );
  });

  it("负结果不粘：一次解析失败后，下一次调用会重新尝试", async () => {
    // Absence is a per-call degradation, not permanent process state: a
    // long-lived serve whose first call loses a race with an incomplete
    // install must recover once the install settles. Only a successful
    // resolution may be cached.
    vi.doMock("@vscode/ripgrep", () => {
      throw new Error("Could not find @vscode/ripgrep-fake-platform-x64.");
    });
    vi.resetModules();
    const { engineBinaryPath } = await import(MANIFEST);

    assert.equal(
      await engineBinaryPath(),
      undefined,
      "首次解析失败应给出 undefined"
    );

    // Same module instance, no reset: only the underlying package changed.
    const sentinel = join(tmpdir(), "iknow-late-rg", "bin", "rg");
    vi.doMock("@vscode/ripgrep", () => ({ rgPath: sentinel }));

    assert.equal(
      await engineBinaryPath(),
      sentinel,
      "负结果被缓存会让本进程永久退到 Node 引擎；第二次调用必须重新尝试"
    );
  });
});
