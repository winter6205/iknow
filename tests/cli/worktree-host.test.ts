/**
 * Regression for the CLI worktree-isolation host seam (src/cli/worktree-host.ts):
 * the hub entry passes create-worktree's `name` label through to the provisioner,
 * but cli.ts main() once hand-destructured the ctx and silently dropped `name`,
 * degrading every CLI provision to a UUID-only leaf while still compiling. Wire
 * the host to the **real provisioner** over a temp git repo with a fresh
 * conversationId so the CLI assembly must forward ctx intact (including `name`).
 * Invariant: a labeled leaf directory is the label alone — the uuid is not part
 * of the folder name.
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
  const store = new SessionStore(storeDir, process.cwd());
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

    expect(root).toBe(join(repo, ".iknow", "worktrees", "fix-648"));
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
