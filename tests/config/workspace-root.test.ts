/**
 * T1 — workspace-root resolver boundary tests (5 classes per test.md).
 *
 * Coverage map:
 *   1. empty    — explicit = "" / IKNOW_WORKSPACE_ROOT = "" → typed `empty_*` errors.
 *   2. negative — relative path → `non_absolute`.
 *   3. overflow — `/` + "x".repeat(8192) → `non_absolute` or `not_found`
 *                  (binary: does not crash, does not silently truncate).
 *   4. concurrent — two parallel calls with different inputs → both succeed,
 *                  caller's env Record is not mutated.
 *   5. exception — non-existent absolute path → `not_found`.
 *
 * Happy path also asserts priority chain `[explicit, env, cwd]`.
 *
 * Path deviation note (scope review): vitest.config.ts only collects
 * test files under the "tests" directory (glob include). Scope literal
 * says "src/config/workspace-root.test.ts"; placed here per project
 * convention. Run: "npm test -- tests/config/workspace-root.test.ts".
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveWorkspaceRoot,
  WORKSPACE_ROOT_ENV_KEY,
  type WorkspaceRootError,
} from "../../src/config/workspace-root.ts";

// Shared fixture directories (created once for the file).
const TMP_DIRS: string[] = [];
function freshTmp(prefix: string): string {
  const p = mkdtempSync(join(tmpdir(), prefix));
  TMP_DIRS.push(p);
  return p;
}

let tmpRoot: string;
let cwdDir: string;

beforeAll(() => {
  tmpRoot = freshTmp("iknow-wsr-");
  cwdDir = freshTmp("iknow-wsr-cwd-");
});
afterAll(() => {
  for (const p of TMP_DIRS) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

function asWorkspaceRootError(err: unknown): WorkspaceRootError {
  // Each error is a plain object literal — assert it's an object with a kind.
  if (err === null || typeof err !== "object") {
    throw new Error(`expected WorkspaceRootError object, got ${typeof err}`);
  }
  const e = err as Record<string, unknown>;
  if (typeof e.kind !== "string") {
    throw new Error(
      `expected WorkspaceRootError.kind, got ${JSON.stringify(e)}`
    );
  }
  return err as WorkspaceRootError;
}

describe("resolveWorkspaceRoot — happy path / priority chain", () => {
  it("priority slot 3: opts.cwd is the fallback when neither explicit nor env are set", () => {
    const r = resolveWorkspaceRoot({ cwd: cwdDir });
    assert.equal(r, cwdDir);
  });

  it("priority slot 2: env var wins over cwd", () => {
    const r = resolveWorkspaceRoot({
      cwd: cwdDir,
      env: { [WORKSPACE_ROOT_ENV_KEY]: tmpRoot },
    });
    assert.equal(r, tmpRoot);
  });

  it("priority slot 1: explicit wins over env var AND cwd", () => {
    const other = freshTmp("iknow-wsr-prio-");
    const r = resolveWorkspaceRoot({
      explicit: other,
      cwd: cwdDir,
      env: { [WORKSPACE_ROOT_ENV_KEY]: tmpRoot },
    });
    assert.equal(r, other);
  });

  it("env record without the workspace-root key is treated as unset (slot 3 wins)", () => {
    const r = resolveWorkspaceRoot({ cwd: cwdDir, env: {} });
    assert.equal(r, cwdDir);
  });

  it("env record with the key explicitly undefined is treated as unset", () => {
    const r = resolveWorkspaceRoot({
      cwd: cwdDir,
      env: { [WORKSPACE_ROOT_ENV_KEY]: undefined },
    });
    assert.equal(r, cwdDir);
  });
});

describe("resolveWorkspaceRoot — boundary class empty", () => {
  it("empty_explicit: explicit='' throws kind=empty_explicit, path='', NOT a fall-through", () => {
    assert.throws(
      () => resolveWorkspaceRoot({ explicit: "", cwd: tmpRoot }),
      (err: unknown) => {
        const e = asWorkspaceRootError(err);
        return e.kind === "empty_explicit" && e.path === "";
      }
    );
  });

  it("empty_env: IKNOW_WORKSPACE_ROOT='' throws kind=empty_env, varName='IKNOW_WORKSPACE_ROOT'", () => {
    assert.throws(
      () =>
        resolveWorkspaceRoot({
          env: { [WORKSPACE_ROOT_ENV_KEY]: "" },
          cwd: tmpRoot,
        }),
      (err: unknown) => {
        const e = asWorkspaceRootError(err);
        return e.kind === "empty_env" && e.varName === WORKSPACE_ROOT_ENV_KEY;
      }
    );
  });

  it("empty_explicit with env var set: explicit empty STILL throws (no fall-through to env)", () => {
    assert.throws(
      () =>
        resolveWorkspaceRoot({
          explicit: "",
          env: { [WORKSPACE_ROOT_ENV_KEY]: tmpRoot },
        }),
      (err: unknown) => {
        return asWorkspaceRootError(err).kind === "empty_explicit";
      }
    );
  });
});

describe("resolveWorkspaceRoot — boundary class negative", () => {
  it("non_absolute: 'not/absolute' (relative) throws kind=non_absolute, path echoed", () => {
    assert.throws(
      () => resolveWorkspaceRoot({ explicit: "not/absolute" }),
      (err: unknown) => {
        const e = asWorkspaceRootError(err);
        return e.kind === "non_absolute" && e.path === "not/absolute";
      }
    );
  });

  it("non_absolute: bare relative 'foo' (no slashes) is also rejected", () => {
    assert.throws(
      () => resolveWorkspaceRoot({ explicit: "foo" }),
      (err: unknown) => {
        return asWorkspaceRootError(err).kind === "non_absolute";
      }
    );
  });

  it("non_absolute: from env var path (env also goes through absolute check)", () => {
    assert.throws(
      () =>
        resolveWorkspaceRoot({
          env: { [WORKSPACE_ROOT_ENV_KEY]: "data/foo" },
          cwd: tmpRoot,
        }),
      (err: unknown) => {
        const e = asWorkspaceRootError(err);
        return e.kind === "non_absolute" && e.path === "data/foo";
      }
    );
  });
});

describe("resolveWorkspaceRoot — boundary class overflow", () => {
  it("absurdly long absolute path (8192-char 'x' tail) does not crash and throws typed error", () => {
    const longPath = "/" + "x".repeat(8192);
    let captured: WorkspaceRootError | undefined;
    try {
      resolveWorkspaceRoot({ explicit: longPath });
      throw new Error("expected throw");
    } catch (err) {
      captured = asWorkspaceRootError(err);
    }
    // Binary asserts: not crash, not silently truncate.
    assert.ok(captured, "expected throw");
    assert.ok(
      captured.kind === "non_absolute" || captured.kind === "not_found",
      `expected non_absolute|not_found, got ${captured.kind}`
    );
    // Echoes the original input verbatim (no truncation).
    assert.equal(captured.path.length, longPath.length);
  });
});

describe("resolveWorkspaceRoot — boundary class concurrent", () => {
  it("two parallel calls with different explicit → both succeed with their own root", () => {
    const a = freshTmp("iknow-wsr-conc-a-");
    const b = freshTmp("iknow-wsr-conc-b-");
    // Note: resolveWorkspaceRoot is synchronous — we still wrap to assert
    // that no shared mutable state corrupts the second call. Use
    // Promise.resolve to make the parallelism explicit.
    const [ra, rb] = [
      Promise.resolve(resolveWorkspaceRoot({ explicit: a })),
      Promise.resolve(resolveWorkspaceRoot({ explicit: b })),
    ];
    return Promise.all([ra, rb]).then(([resA, resB]) => {
      assert.equal(resA, a);
      assert.equal(resB, b);
    });
  });

  it("caller's env Record is not mutated (object identity preserved, key untouched)", () => {
    const shared: Record<string, string | undefined> = {
      [WORKSPACE_ROOT_ENV_KEY]: tmpRoot,
    };
    const before = JSON.stringify(shared);
    const r1 = resolveWorkspaceRoot({ env: shared, cwd: "/" });
    const r2 = resolveWorkspaceRoot({ env: shared, cwd: "/" });
    assert.equal(JSON.stringify(shared), before, "env Record mutated");
    assert.equal(r1, tmpRoot);
    assert.equal(r2, tmpRoot);
  });

  it("interleaved explicit + env calls do not cross-contaminate", () => {
    const explicitDir = freshTmp("iknow-wsr-int-explicit-");
    const envDir = freshTmp("iknow-wsr-int-env-");
    const seq: string[] = [];
    seq.push(resolveWorkspaceRoot({ explicit: explicitDir }));
    seq.push(
      resolveWorkspaceRoot({
        env: { [WORKSPACE_ROOT_ENV_KEY]: envDir },
        cwd: "/",
      })
    );
    seq.push(resolveWorkspaceRoot({ explicit: explicitDir }));
    assert.deepEqual(seq, [explicitDir, envDir, explicitDir]);
  });
});

describe("resolveWorkspaceRoot — boundary class exception", () => {
  it("not_found: absolute but non-existent path throws kind=not_found, path echoed", () => {
    const ghost = "/this/path/should/not/exist/iknow-wsr-xyz-123";
    assert.throws(
      () => resolveWorkspaceRoot({ explicit: ghost }),
      (err: unknown) => {
        const e = asWorkspaceRootError(err);
        return e.kind === "not_found" && e.path === ghost;
      }
    );
  });

  it("not_found: non-existent path from env also throws not_found", () => {
    const ghost = "/another/ghost/path/iknow-wsr-xyz-456";
    assert.throws(
      () =>
        resolveWorkspaceRoot({
          env: { [WORKSPACE_ROOT_ENV_KEY]: ghost },
          cwd: tmpRoot,
        }),
      (err: unknown) => {
        const e = asWorkspaceRootError(err);
        return e.kind === "not_found" && e.path === ghost;
      }
    );
  });
});

describe("resolveWorkspaceRoot — typed-error shape (typed-error catch contract)", () => {
  it("throws plain object with `kind` discriminator (NOT a string/Error message)", () => {
    try {
      resolveWorkspaceRoot({ explicit: "" });
      throw new Error("expected throw");
    } catch (err) {
      assert.ok(err !== null && typeof err === "object");
      assert.ok(
        !("message" in (err as object)) ||
          typeof (err as { message?: unknown }).message === "undefined",
        "typed-error should NOT leak a generic message"
      );
      assert.equal((err as { kind?: unknown }).kind, "empty_explicit");
    }
  });
});
