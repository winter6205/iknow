/**
 * cursor-git-attribution apply: worktree `.husky` must get gitignored
 * strip hooks, not untracked `*.cursor.*` files (basename is `.husky`).
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../scripts/cursor-git-attribution.sh"
);

function isolatedGitEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

describe("cursor-git-attribution.sh apply — worktree .husky", () => {
  it("writes strip commit-msg hooks, not *.cursor.* files", () => {
    const tmp = mkdtempSync(join(tmpdir(), "iknow-git-attr-"));
    try {
      const repo = join(tmp, "repo");
      const home = join(tmp, "home");
      mkdirSync(repo);
      mkdirSync(home);
      execFileSync("git", ["init"], {
        cwd: repo,
        env: isolatedGitEnv(home),
      });
      mkdirSync(join(repo, ".husky"));
      writeFileSync(join(repo, ".husky", "pre-commit"), "#!/bin/sh\nexit 0\n");

      execFileSync("bash", [SCRIPT], {
        cwd: repo,
        env: isolatedGitEnv(home),
      });

      const huskyNames = readdirSync(join(repo, ".husky"));
      assert.equal(
        huskyNames.some((name) => name.includes("cursor")),
        false,
        `worktree .husky must not get *.cursor.* files: ${huskyNames.join(",")}`
      );
      assert.ok(existsSync(join(repo, ".husky", "commit-msg")));
      assert.ok(existsSync(join(repo, ".husky", "prepare-commit-msg")));
      assert.ok(existsSync(join(repo, ".husky", "pre-commit")));
      assert.match(
        readFileSync(join(repo, ".husky", "commit-msg"), "utf8"),
        /drop platform lines from COMMIT_EDITMSG/
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
