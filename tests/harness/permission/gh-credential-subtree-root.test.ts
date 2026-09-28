import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  commandContainsSensitivePath,
  hardWalls,
} from "../../../src/harness/permission/hard-walls.js";

// `~/.config/gh` is the one credential subtree whose ROOTS the shell roster
// did not guard: `.config/gh/` covers every file below it, but the directory
// itself was an allow, so `cp a ~/.config/gh` and a redirect onto it were
// refused only by the fence's ro-bind, never pre-execution. Every sibling
// subtree root carries the `$`-anchored arm (`\.ssh$` / `\.aws$` / `\.gnupg$`
// / `\.kube$`); this file pins that `\.config/gh$` closes the same gap and
// that anchoring it introduces no new denies.

const sensitivePathWall = hardWalls().find(
  (rule) => rule.id === "hard-wall:sensitive-path"
);
assert.ok(sensitivePathWall, "hard-wall:sensitive-path must exist");
const sensitivePathRule: NonNullable<typeof sensitivePathWall> =
  sensitivePathWall;

function deniedByPathArm(path: string): boolean {
  return sensitivePathRule.match({ tool: "write", input: { path } });
}

function deniedByTextArm(command: string): boolean {
  return commandContainsSensitivePath(command);
}

describe("gh credential subtree root — both roster arms refuse it", () => {
  const roots = [
    "/home/u/.config/gh",
    "/home/u/.ssh",
    "/home/u/.aws",
    "/home/u/.gnupg",
    "/home/u/.kube",
  ];

  for (const root of roots) {
    it(`denies the path-bearing arm for ${root}`, () => {
      assert.equal(deniedByPathArm(root), true);
    });

    it(`denies the command-text arm for a write onto ${root}`, () => {
      assert.equal(deniedByTextArm(`cp /tmp/a ${root}`), true);
    });
  }

  it("keeps denying the subtree's files", () => {
    assert.equal(deniedByPathArm("/home/u/.config/gh/hosts.yml"), true);
    assert.equal(
      deniedByTextArm("cp /tmp/a /home/u/.config/gh/hosts.yml"),
      true
    );
  });
});

describe("gh credential subtree root — anchoring adds no new denies", () => {
  // The anchored arm can only fire where the text ends in `.config/gh`, so a
  // longer sibling name or a same-basename directory elsewhere is untouched.
  const notDenied = [
    "/home/u/.config/ghfoo",
    "/home/u/.config/gh-backup/x",
    "/home/u/.config/ghhosts.yml",
    "/tmp/config/gh",
    "/home/u/config/gh",
  ];

  for (const path of notDenied) {
    it(`leaves ${path} alone on both arms`, () => {
      assert.equal(deniedByPathArm(path), false);
      assert.equal(deniedByTextArm(`cp /tmp/a ${path}`), false);
    });
  }

  // Same end-of-text discipline as the sibling `$.` arms: the anchored form
  // answers for the bare directory, not for a directory named mid-line.
  it("does not deny a mid-line mention of the subtree root", () => {
    assert.equal(
      deniedByTextArm("ls -la /home/u/.config/gh && echo done"),
      false
    );
  });
});
