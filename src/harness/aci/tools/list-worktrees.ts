/**
 * Read-only task-worktree discovery ACI.
 *
 * The host owns git inspection and the path/ownership SSOT. This tool only
 * validates the small model-facing option and serializes the host projection
 * for the tool result.
 */
import type { LiveTaskRoot } from "../../session-roots.js";
import { ToolExecutionError, errorMessage } from "../../errors.js";
import type {
  TaskWorktreeInfo,
  WorktreeListFn,
} from "../../isolation/worktree-gate.js";
import { WorktreeIsolationError } from "../../isolation/worktree-gate.js";
import type { AciToolDef } from "../types.js";

export interface ListWorktreesToolDeps {
  readonly worktreeList: WorktreeListFn;
  readonly root: string | LiveTaskRoot;
}

function readRoot(root: string | LiveTaskRoot): string {
  return typeof root === "string" ? root : root.read();
}

function includeStaleFrom(input: unknown): boolean {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ToolExecutionError("[list-worktrees] input must be an object");
  }
  const value = (input as { include_stale?: unknown }).include_stale;
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new ToolExecutionError(
      "[list-worktrees] include_stale must be a boolean"
    );
  }
  return value;
}

function serialize(entries: ReadonlyArray<TaskWorktreeInfo>): string {
  return JSON.stringify(
    entries.map((entry) => ({
      label: entry.label ?? null,
      conversationId: entry.conversationId,
      path: entry.path,
      branch: entry.branch,
      head: entry.head,
      dirty: entry.dirty,
      ...(entry.stale === true ? { stale: true } : {}),
      // Issue #1231 — a linked checkout outside the task area. Its
      // conversationId is empty and its label is null; the path is the handle
      // for enter-worktree.
      ...(entry.external === true ? { external: true } : {}),
    }))
  );
}

export function createListWorktreesTool(
  deps: ListWorktreesToolDeps
): AciToolDef {
  return Object.freeze({
    name: "list-worktrees",
    description:
      "List the checkouts belonging to this repository with their label, conversation id, path, branch, HEAD, and dirty state. " +
      "Entries marked external=true are linked checkouts that live outside the task worktree area (for example an operator's own git worktree) and can be entered by their path. " +
      "Use include_stale=true to also discover task branches that currently have no linked checkout; the result is JSON " +
      "suitable for selecting a unique label before enter-worktree or auditing a cleanup.",
    inputSchema: {
      type: "object",
      properties: {
        include_stale: {
          type: "boolean",
          default: false,
          description:
            "Include task branches whose worktree is not currently linked.",
        },
      },
      additionalProperties: false,
    },
    aci: {
      category: "read-only",
      isConcurrencySafe: true,
      interruptBehavior: "cancel",
      timeoutTier: "default",
    } as const,
    handler: async (input: unknown) => {
      const includeStale = includeStaleFrom(input);
      try {
        const entries = await deps.worktreeList({
          root: readRoot(deps.root),
          ...(includeStale ? { includeStale: true } : {}),
        });
        return serialize(entries);
      } catch (err) {
        if (err instanceof WorktreeIsolationError) {
          throw new ToolExecutionError(
            `[list-worktrees] kind=${err.kind} — ${err.detail}`
          );
        }
        throw new ToolExecutionError(
          `[list-worktrees] list failed: ${errorMessage(err)}`
        );
      }
    },
  });
}
