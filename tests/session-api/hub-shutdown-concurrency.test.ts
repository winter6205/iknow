import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionHub } from "../../src/session-api/hub.ts";
import { SessionStore } from "../../src/session-api/store/index.ts";
import { makeDeps } from "../cli/_fixtures.ts";

const cleanup: string[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const path = cleanup.pop();
    if (path !== undefined) await rm(path, { recursive: true, force: true });
  }
});

describe("SessionHub shutdown ownership", () => {
  it("starts the cached engine and every rebound root before waiting and latches one result", async () => {
    const { hub } = await makeHub();
    const first = deferred<void>();
    const second = deferred<void>();
    const cached = deferred<void>();
    const events: string[] = [];
    const internals = shutdownInternals(hub);
    internals.cachedShutdown = () => {
      events.push("cached-started");
      return cached.promise;
    };
    internals.engineByRoot.set("root-a", {
      shutdown: () => {
        events.push("root-a-started");
        return first.promise;
      },
    });
    internals.engineByRoot.set("root-b", {
      shutdown: () => {
        events.push("root-b-started");
        return second.promise;
      },
    });

    const firstCall = hub.shutdown();
    const duplicateCall = hub.shutdown();
    try {
      expect(duplicateCall).toBe(firstCall);
      expect(events).toEqual([
        "cached-started",
        "root-a-started",
        "root-b-started",
      ]);
    } finally {
      first.resolve();
      second.resolve();
      cached.resolve();
      await Promise.allSettled([firstCall, duplicateCall]);
    }
  });

  it("continues starting owners after a synchronous failure and reports cleanup failure", async () => {
    const { hub } = await makeHub();
    const events: string[] = [];
    const internals = shutdownInternals(hub);
    internals.cachedShutdown = () => {
      events.push("cached-failed");
      throw new Error("synthetic cached shutdown failure");
    };
    internals.engineByRoot.set("root-a", {
      shutdown: async () => {
        events.push("root-a-started");
      },
    });

    await expect(hub.shutdown()).rejects.toThrow(AggregateError);
    expect(events).toEqual(["cached-failed", "root-a-started"]);
  });

  it("latches before owner callbacks can synchronously reenter and preserves method receivers", async () => {
    const { hub } = await makeHub();
    const internals = shutdownInternals(hub);
    const owner = {
      hub,
      nestedCall: undefined as Promise<void> | undefined,
      shutdown() {
        this.nestedCall = this.hub.shutdown();
        return Promise.resolve();
      },
    };
    internals.engineByRoot.set("root-reentrant", owner);

    const firstCall = hub.shutdown();
    expect(owner.nestedCall).toBe(firstCall);
    await expect(firstCall).resolves.toBeUndefined();
  });

  it("keeps route ownership until in-flight serialized turns drain", async () => {
    const { hub } = await makeHub();
    const activeTurn = deferred<void>();
    const managerStop = deferred<void>();
    const internals = shutdownInternals(hub);
    internals.sessionRoutes.set("synthetic-session", "provider/model");
    internals.inflight.set("synthetic-session", activeTurn.promise);
    internals.engineByRoot.set("root-draining", {
      shutdown: () => managerStop.promise,
    });

    const stopping = hub.shutdown();
    await Promise.resolve();
    expect(internals.sessionRoutes.get("synthetic-session")).toBe(
      "provider/model"
    );

    managerStop.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(internals.sessionRoutes.get("synthetic-session")).toBe(
      "provider/model"
    );

    activeTurn.resolve();
    await stopping;
    expect(internals.sessionRoutes.has("synthetic-session")).toBe(false);
  });
});

async function makeHub(): Promise<{ readonly hub: SessionHub }> {
  const dataDir = await mkdtemp(join(tmpdir(), "iknow-hub-shutdown-"));
  cleanup.push(dataDir);
  const store = new SessionStore(dataDir, process.cwd());
  return {
    hub: new SessionHub({
      store,
      deps: makeDeps([]),
      surface: "tui",
      injectedEngineRoot: dataDir,
    }),
  };
}

function shutdownInternals(hub: SessionHub): {
  cachedShutdown: (() => Promise<void>) | undefined;
  engineByRoot: Map<string, { readonly shutdown?: () => Promise<void> }>;
  inflight: Map<string, Promise<void>>;
  sessionRoutes: Map<string, string>;
} {
  return hub as unknown as {
    cachedShutdown: (() => Promise<void>) | undefined;
    engineByRoot: Map<string, { readonly shutdown?: () => Promise<void> }>;
    inflight: Map<string, Promise<void>>;
    sessionRoutes: Map<string, string>;
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
