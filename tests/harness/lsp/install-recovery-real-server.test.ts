/**
 * Same-session recovery against a **real** language server (plan T5: "after an
 * approved install or repair, the affected server can be retried successfully in
 * the same session without an unbounded retry loop").
 *
 * The install is simulated through the existing `ctx.resolveBin` seam (highest
 * precedence, production-wired shape) — first pointing at a path that does not
 * exist (server not installed), then at the real Pyright executable (install
 * completed). Everything below the resolution seam is real: real spawn, real
 * JSON-RPC handshake, real `textDocument/definition` answer.
 */
import { afterAll, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { Pyright } from "../../../src/harness/lsp/server.ts";
import type { LspCtx } from "../../../src/harness/lsp/types.ts";
import {
  createLspClientPool,
  getClientDetailed,
  retryFailedLspStart,
} from "../../../src/harness/lsp/client.ts";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const requireFromRepo = createRequire(join(REPO, "noop.js"));

/** The real pyright executable this repository actually ships. */
function realPyrightBin(): string {
  const bin = join(REPO, "node_modules", ".bin", "pyright-langserver");
  if (!existsSync(bin))
    throw new Error(`pyright not installed in this worktree: ${bin}`);
  return bin;
}

const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A minimal real Python project: pyproject.toml + two cross-referencing files. */
function makePythonProject(): { root: string; caller: string; callee: string } {
  const root = mkdtempSync(join(tmpdir(), "lsp-recover-"));
  tmpDirs.push(root);
  mkdirSync(join(root, "pkg"), { recursive: true });
  writeFileSync(
    join(root, "pyproject.toml"),
    '[project]\nname = "recover-probe"\nversion = "0.0.0"\n'
  );
  writeFileSync(
    join(root, "pkg", "offset.py"),
    "def compute_offset(base: int, step: int = 1) -> int:\n    return base + step\n"
  );
  writeFileSync(
    join(root, "app.py"),
    "from pkg.offset import compute_offset\n\n\ndef main() -> int:\n    return compute_offset(1)\n"
  );
  return {
    root,
    caller: join(root, "app.py"),
    callee: join(root, "pkg", "offset.py"),
  };
}

describe("real pyright: failed start is typed, then recoverable in the same session", () => {
  it("names the stage on a missing executable, then serves a real request after the install", async () => {
    const project = makePythonProject();
    const pool = createLspClientPool();
    let bin = join(project.root, "node_modules", ".bin", "not-installed-yet");
    const ctx: LspCtx = {
      directory: project.root,
      pool,
      resolveBin: async (pkgName) => (pkgName === "pyright" ? bin : undefined),
    };

    // 1) server missing: a typed failure, not a hang and not an unhandled error.
    const failed = await getClientDetailed(ctx, project.caller, {
      server: Pyright,
    });
    expect(failed.client).toBeUndefined();
    expect(failed.failure?.serverId).toBe("pyright");
    expect(["executable-resolution", "process-spawn"]).toContain(
      failed.failure?.stage
    );
    expect(failed.failure?.cause ?? "").not.toBe("");

    // 2) the approved install completes.
    bin = realPyrightBin();
    expect(
      retryFailedLspStart(ctx, { root: project.root, serverId: "pyright" })
    ).toBe(true);

    // 3) same session, same pool, no terminal shutdown: a real definition request.
    const recovered = await getClientDetailed(ctx, project.caller, {
      server: Pyright,
    });
    expect(recovered.client).toBeDefined();
    expect(pool.shutDown).toBe(false);

    const answer = await recovered.client!.withDocumentOpen(
      project.caller,
      () =>
        recovered.client!.sendRequest("textDocument/definition", {
          textDocument: { uri: `file://${project.caller}` },
          position: { line: 4, character: 11 },
        })
    );
    // The definition answer is a Location list: the cross-file target file and
    // the range of `def compute_offset` inside it.
    const locations = answer as {
      uri: string;
      range: { start: { line: number } };
    }[];
    expect(locations.length).toBeGreaterThan(0);
    expect(locations[0].uri).toContain("offset.py");
    expect(locations[0].range.start.line).toBe(0);

    await pool.disposeAll();
  }, 120_000);

  it("a globally repaired server resolves through the worktree chain without an override", async () => {
    // Sanity on the resolution contract used by the recovery above: with no
    // override at all, the harness still resolves the shipped pyright.
    const project = makePythonProject();
    const pool = createLspClientPool();
    const ctx: LspCtx = { directory: project.root, pool };
    const { client } = await getClientDetailed(ctx, project.caller, {
      server: Pyright,
    });
    expect(client).toBeDefined();
    await pool.disposeAll();
  }, 120_000);
});

// Keep the require reference meaningful for readers of this file: the real
// executable is the package's published bin entry.
void requireFromRepo;
void realPyrightBin;
