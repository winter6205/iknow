import type {
  BackgroundLiveTask,
  BackgroundTaskManager,
} from "../harness/background/manager.js";

/** Read-only source for live background tasks across every engine built by the TUI. */
export interface QuitBackgroundTaskSource {
  /** Add an engine manager; undefined entries and repeated handles are ignored. */
  readonly register: (manager?: BackgroundTaskManager) => void;
  /** Return a fresh projection of all currently live tasks. Manager read errors propagate. */
  readonly listLiveTasks: () => ReadonlyArray<BackgroundLiveTask>;
}

/**
 * Own the manager handles used by `/quit`'s busy set. A TUI can rebuild engines
 * for another root while tasks from an earlier engine remain alive until exit,
 * so every distinct manager stays in the projection for the host lifetime.
 */
export function createQuitBackgroundTasks(): QuitBackgroundTaskSource {
  const managers = new Set<BackgroundTaskManager>();
  return Object.freeze({
    register: (manager?: BackgroundTaskManager): void => {
      if (manager !== undefined) managers.add(manager);
    },
    listLiveTasks: (): ReadonlyArray<BackgroundLiveTask> => {
      const tasks: BackgroundLiveTask[] = [];
      for (const manager of managers) {
        tasks.push(...manager.listLiveTasks());
      }
      return tasks;
    },
  });
}
