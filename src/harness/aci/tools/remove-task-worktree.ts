/**
 * Explicit task-worktree removal ACI.
 *
 * The host performs all repository validation and safety checks. The model
 * supplies a conversation id or a label, never a filesystem path.
 */
import type { LiveTaskRoot } from "../../session-roots.js";
import { ToolExecutionError, errorMessage } from "../../errors.js";
import type {
  WorktreeRemoveFn,
  WorktreeRemoval,
} from "../../isolation/worktree-gate.js";
import {
  SAFE_CONVERSATION_ID_RE,
  WorktreeIsolationError,
} from "../../isolation/worktree-gate.js";
import type { AciToolDef } from "../types.js";
import type { ToolExecutionContext } from "../../tools/types.js";

export interface RemoveTaskWorktreeToolDeps {
  readonly worktreeRemove: WorktreeRemoveFn;
  readonly root: string | LiveTaskRoot;
}

function readRoot(root: string | LiveTaskRoot): string {
  return typeof root === "string" ? root : root.read();
}

function parseInput(input: unknown): {
  readonly selector: string;
  readonly deleteBranch: boolean;
} {
  if (input === null || typeof input !== "object") {
    throw new ToolExecutionError(
      "[remove-task-worktree] input must be an object"
    );
  }
  const raw = input as {
    conversationId?: unknown;
    delete_branch?: unknown;
  };
  if (
    typeof raw.conversationId !== "string" ||
    raw.conversationId.length === 0
  ) {
    throw new ToolExecutionError(
      "[remove-task-worktree] conversationId must be a non-empty conversation id or task label"
    );
  }
  if (!SAFE_CONVERSATION_ID_RE.test(raw.conversationId)) {
    throw new ToolExecutionError(
      `[remove-task-worktree] kind=worktree_not_found — selector ${JSON.stringify(raw.conversationId)} is not a safe conversation id or label`
    );
  }
  if (
    raw.delete_branch !== undefined &&
    typeof raw.delete_branch !== "boolean"
  ) {
    throw new ToolExecutionError(
      "[remove-task-worktree] delete_branch must be a boolean"
    );
  }
  return {
    selector: raw.conversationId,
    deleteBranch: raw.delete_branch === true,
  };
}

function serialize(removal: WorktreeRemoval): string {
  return JSON.stringify({
    label: removal.label ?? null,
    conversationId: removal.conversationId,
    path: removal.path,
    branch: removal.branch,
    head: removal.head,
    branchDeleted: removal.branchDeleted,
  });
}

export function createRemoveTaskWorktreeTool(
  deps: RemoveTaskWorktreeToolDeps
): AciToolDef {
  return Object.freeze({
    name: "remove-task-worktree",
    description:
      "Remove a clean task worktree selected by conversationId or label after its task is finished. Use delete_branch=true to remove the associated local task branch too. The host checks the current root, working-tree status, repository ownership, and unpushed commits first, then returns an auditable JSON receipt with the path, branch, HEAD, and branchDeleted result.",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: {
          type: "string",
          minLength: 1,
          description:
            "Conversation id or the unique label returned by list-task-worktrees.",
        },
        delete_branch: {
          type: "boolean",
          default: false,
          description:
            "Delete the local task branch after safe worktree removal.",
        },
      },
      required: ["conversationId"],
      additionalProperties: false,
    },
    aci: {
      category: "write",
      isConcurrencySafe: false,
      interruptBehavior: "block",
      timeoutTier: "default",
    } as const,
    handler: async (input: unknown, ctx?: ToolExecutionContext) => {
      const parsed = parseInput(input);
      try {
        const removal = await deps.worktreeRemove({
          root: readRoot(deps.root),
          ...(ctx?.conversationId !== undefined
            ? { conversationId: ctx.conversationId }
            : {}),
          targetConversationId: parsed.selector,
          ...(parsed.deleteBranch ? { deleteBranch: true } : {}),
        });
        return serialize(removal);
      } catch (err) {
        if (err instanceof WorktreeIsolationError) {
          throw new ToolExecutionError(
            `[remove-task-worktree] kind=${err.kind} — ${err.detail}`
          );
        }
        throw new ToolExecutionError(
          `[remove-task-worktree] remove failed: ${errorMessage(err)}`
        );
      }
    },
  });
}
