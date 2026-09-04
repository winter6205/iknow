/**
 * CLI 入口的 worktree isolation host 缝（src/cli/worktree-host.ts）回归：
 * PR #869 在 hub 入口让 create-task-worktree 的 `name` label 透传到
 * provisioner（labeled leaf `<label>--<conversationId>`），但 cli.ts main()
 * 内联的手工解构 wrapper 把 `name` 静默丢弃 → CLI 入口全部退化为
 * UUID-only leaf（编译仍绿）。本测试接**真实 provisioner** + 临时 git repo
 * + fresh conversationId，钉死 CLI 装配层必须整 ctx 透传（含 `name`）。
 *
 * 背景（iknow trace 0cee57d3-39cc-45b3 自查发现，2026-09-04 修复）。
 */
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWorktreeIsolationHost } from "../../src/cli/worktree-host.ts";
import { createTaskWorktreeProvisioner } from "../../src/session-api/worktree-rebind.ts";
import {
  SessionStore,
  CURRENT_SCHEMA_VERSION,
} from "../../src/session-api/store/index.ts";
import type { SessionFileV1 } from "../../src/session-api/store/index.ts";
import { taskWorktreeOwnerOf } from "../../src/harness/isolation/worktree-gate.ts";

const roots: string[] = [];

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-cli-wt-host-"));
  roots.push(dir);
  git(dir, "init", "-q");
  git(
    dir,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "--allow-empty",
    "-qm",
    "init"
  );
  return dir;
}

async function makeStoreWithSession(
  repo: string,
  conversationId: string
): Promise<SessionStore> {
  const storeDir = mkdtempSync(join(tmpdir(), "iknow-cli-wt-host-store-"));
  roots.push(storeDir);
  const store = new SessionStore(storeDir);
  const now = new Date().toISOString();
  const file: SessionFileV1 = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: conversationId,
    messages: [],
    jsonMode: true,
    turnCount: 0,
    updatedAt: now,
    title: "",
    cwd: repo,
    sanitized_at: now,
    checkpoints: [],
    workspaceRoot: repo,
  };
  await store.save({ id: conversationId, file });
  return store;
}

describe("createWorktreeIsolationHost (CLI provision seam)", () => {
  it("passes `name` through so a labeled task worktree leaf is created", async () => {
    const repo = makeGitRepo();
    const conversationId = "conv-cli-a";
    const store = await makeStoreWithSession(repo, conversationId);
    const provisioner = createTaskWorktreeProvisioner({ store });
    const host = createWorktreeIsolationHost({
      worktreeProvisioner: provisioner,
    });

    const root = await host.provision({
      conversationId,
      root: repo,
      name: "fix-648",
    });

    expect(root).toBe(join(repo, ".iknow", "worktrees", "fix-648--conv-cli-a"));
    expect(taskWorktreeOwnerOf(root)).toBe(conversationId);
  });

  it("still provisions a UUID-only leaf when the model supplies no name", async () => {
    const repo = makeGitRepo();
    const conversationId = "conv-cli-b";
    const store = await makeStoreWithSession(repo, conversationId);
    const provisioner = createTaskWorktreeProvisioner({ store });
    const host = createWorktreeIsolationHost({
      worktreeProvisioner: provisioner,
    });

    const root = await host.provision({ conversationId, root: repo });

    expect(root).toBe(join(repo, ".iknow", "worktrees", conversationId));
    expect(taskWorktreeOwnerOf(root)).toBe(conversationId);
  });
});
