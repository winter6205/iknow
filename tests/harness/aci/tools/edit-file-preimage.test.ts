/**
 * tests/harness/aci/tools/edit-file-preimage.test.ts — ADR-0036 / ADR-0121
 * preimage seam on the edit path.
 *
 * Invariant pinned: `edit_file` hands the capture port the exact bytes it is
 * about to replace, and a refusal from that port leaves the file at those
 * bytes. Without the first half a rewind could not tell what it was undoing;
 * without the second the transcript would claim a preimage for a mutation that
 * already happened.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";

import { createEditFileTool } from "../../../../src/harness/aci/tools/edit-file.ts";
import type { PreimageCaptureInput } from "../../../../src/harness/aci/preimage-port.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "iknow-ef-preimg-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ctx = { toolUseId: "tu-edit", conversationId: "conv-edit" };
const ORIGINAL = "const a = 1;\nconst b = 2;\n";

describe("edit_file → preimage port", () => {
  it("captures pre = on-disk bytes and post = the edited bytes, once", async () => {
    const file = join(root, "editme.ts");
    await writeFile(file, ORIGINAL, "utf8");
    const seen: PreimageCaptureInput[] = [];
    const tool = createEditFileTool(root, {
      preimageCapture: (input) => {
        seen.push(input);
      },
    });

    await tool.handler(
      { path: "editme.ts", old_str: "const b = 2;", new_str: "const b = 3;" },
      ctx
    );

    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.preBytes.toString("utf8"), ORIGINAL);
    assert.equal(
      seen[0]!.postBytes.toString("utf8"),
      "const a = 1;\nconst b = 3;\n"
    );
    assert.equal(seen[0]!.relPath, "editme.ts");
    assert.equal(seen[0]!.rootIdentity, root);
    assert.equal(seen[0]!.toolUseId, "tu-edit");
    assert.equal(seen[0]!.conversationId, "conv-edit");
    assert.equal(await readFile(file, "utf8"), "const a = 1;\nconst b = 3;\n");
  });

  it("a throwing capture aborts the edit: the file keeps its original bytes", async () => {
    const file = join(root, "protected.ts");
    await writeFile(file, ORIGINAL, "utf8");
    const tool = createEditFileTool(root, {
      preimageCapture: () => {
        throw new Error("capture refused");
      },
    });

    await assert.rejects(async () => {
      await tool.handler(
        {
          path: "protected.ts",
          old_str: "const a = 1;",
          new_str: "const a = 9;",
        },
        ctx
      );
    }, /capture refused/);
    assert.equal(await readFile(file, "utf8"), ORIGINAL);
  });
});
