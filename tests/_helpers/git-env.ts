/**
 * Env-immunity layer for git subprocesses spawned inside tests.
 *
 * Background: parent git operations (`git push` etc.) inject GIT_DIR /
 * GIT_WORK_TREE / GIT_INDEX_FILE / GIT_OBJECT_DIRECTORY and friends into hooks
 * (in worktree scenarios these point at the parent repo's worktree gitdir).
 * husky pre-push → vitest → a test's `git init` temp repo inherits them: once
 * GIT_DIR is pinned, `git commit` actually lands on the parent repo, tripping
 * husky pre-commit with "Current directory is not a git directory!" — the
 * ghost failure that passes standalone yet dies consistently during push.
 *
 * The only correct fix is stripping these variables from test-spawned git
 * subprocesses so the temp repo runs on its own cwd semantics. Consumers: the
 * unified entry point for execFileSync("git", ...) in tests.
 */
import { execFileSync } from "node:child_process";

const GIT_INHERITED_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_COMMON_DIR",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_PREFIX",
  "GIT_SUPER_PREFIX",
] as const;

/** Strip parent-git-injected env; returns an env safe for test git subprocesses. */
export function gitTestEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of GIT_INHERITED_VARS) {
    delete env[key];
  }
  return env;
}

/** Test-only form of execFileSync("git", args): cwd required, env immunized. */
export function gitIn(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: gitTestEnv(),
  });
}
