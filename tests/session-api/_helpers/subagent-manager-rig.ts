/**
 * Manager-fake rig shared by session-api hub tests that need to observe the
 * registry fan-out (`abortTask`) without a real SubAgentManager.
 *
 * Extracted from `hub-abort-session-foreground.test.ts` (its 10-member fake is
 * the full `SubAgentManager` surface the hub reads) so rewind tests can pin
 * abort targeting with the same recording seam. Behaviour of the rig is
 * identical to the original: `abortTask` records the id, returns the per-id
 * override or true; `listSubagents` filters rows by conversationId.
 */
import type {
  SubAgentManager,
  SubagentInfo,
} from "../../../src/harness/subagent/manager.ts";
import { createSubAgentMailbox } from "../../../src/harness/subagent/mailbox.ts";

export interface ManagerRig {
  readonly manager: SubAgentManager;
  readonly abortCalls: string[];
  setRows: (rows: ReadonlyArray<SubagentInfo>) => void;
}

export function makeManagerRig(
  initialRows: ReadonlyArray<SubagentInfo>,
  abortResults: Record<string, boolean> = {}
): ManagerRig {
  let rows = initialRows;
  const abortCalls: string[] = [];
  const mailbox = createSubAgentMailbox();
  const manager: SubAgentManager = {
    spawn: () => ({ taskId: "unused" }),
    queryBuffer: () => ({ status: "not_found" }),
    waitFor: async () => {
      throw new Error("unused");
    },
    shutdown: async () => {},
    drainCompleted: () => [],
    listActive: () => [],
    abortTask: (taskId) => {
      abortCalls.push(taskId);
      return abortResults[taskId] ?? true;
    },
    getCapacity: () => 15,
    listSubagents: (conversationId?: string) =>
      conversationId === undefined
        ? rows
        : rows.filter((row) => row.conversationId === conversationId),
    subscribe: mailbox.subscribe,
  };
  return {
    manager,
    abortCalls,
    setRows: (next) => {
      rows = next;
    },
  };
}

export function subagentInfo(
  taskId: string,
  overrides: Partial<SubagentInfo> & Pick<SubagentInfo, "state">
): SubagentInfo {
  return {
    taskId,
    taskPreview: taskId,
    startedAt: "2026-09-17T00:00:00.000Z",
    ...overrides,
  };
}
