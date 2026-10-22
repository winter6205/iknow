/**
 * Remote seat assembly (spec specs/remote-sync.md §3.1, §4.5-§4.6, §5,
 * ADR-0149 §1/§6-7; plan tasks 4 and 6).
 *
 * The TUI owns this module's lifetime. `startRemoteSeat` reads the `remote`
 * settings once, starts the projector (with or without the socket, because
 * `remote.notify` is independent of `remote.enabled`), opens the local seat
 * server when enabled, and returns a handle whose `stop()` is idempotent.
 *
 * Failure discipline (spec §3 invariant 7): every optional failure becomes a
 * notice and a degraded handle — never a throw, never a delayed turn. Notices
 * name the fault and, for a held seat, the holder pid; they never carry
 * prompts, paths, model output or tokens.
 *
 * `createRemoteSeatLifecycle` is the TUI-lifetime wrapper used by run.tsx: it
 * buffers the latest projection state and notices until the app has bound its
 * sinks, and a stop requested while the start promise is still pending stops
 * the returned handle immediately when it resolves.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { IknowSettingsRemote } from "../../config/settings.js";
import {
  createNtfyPublisher,
  type NtfyPublisher,
  type NtfySettings,
} from "../../remote-api/notify-ntfy.js";
import type {
  SeatEvent,
  SeatEventBody,
  Snapshot,
} from "../../remote-api/protocol.js";
import {
  startRemoteSeatServer,
  type RemoteSeatHost,
  type RemoteSeatStartResult,
} from "../../remote-api/socket-server.js";
import type { HubEvent } from "../../session-api/hub.js";
import { readPackageVersion } from "../../shared/package-version.js";
import type { TuiAskUserBridge } from "../ask-user.js";
import type { TuiToolEvent } from "../deps.js";
import type { TuiLoadedSessionFile } from "../session-state.js";
import type { RemoteInputPort } from "./input-port.js";
import {
  createSeatProjector,
  type ProjectionActiveState,
  type SeatProjector,
} from "./projector.js";

/** The seat's socket path under the resolved data dir (spec §5.1). */
const SOCKET_RELATIVE_PATH = join("run", "remote.sock");

const UNSAFE_PATH_NOTICE =
  "remote seat not started: the run directory is not a private directory owned by this user";
const LISTEN_FAILED_NOTICE =
  "remote seat not started: could not listen on the seat socket";
const UNEXPECTED_FAILURE_NOTICE =
  "remote seat not started: unexpected error (turns are unaffected)";

export interface StartRemoteSeatOptions {
  readonly settings: IknowSettingsRemote | undefined;
  readonly dataDir: string;
  readonly cwd: string;
  readonly hub: {
    subscribeEvents(listener: (event: HubEvent) => void): () => void;
  };
  readonly askBridge: Pick<
    TuiAskUserBridge,
    "subscribe" | "pendingAll" | "onSettled"
  >;
  readonly toolEventSink: {
    subscribe(listener: (event: TuiToolEvent) => void): () => void;
  };
  readonly loadTranscript: (
    conversationId: string
  ) => Promise<TuiLoadedSessionFile>;
  readonly inputPort: RemoteInputPort;
  readonly onNotice?: (text: string) => void;
  /** Notifier test seam; production uses the global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Notification clock (turn durations); defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface RemoteSeatHandle {
  readonly instanceId: string;
  readonly socketPath: string | undefined;
  setActive(state: ProjectionActiveState | undefined): void;
  stop(): Promise<void>;
}

/** One TUI-lifetime controller (used by run.tsx). */
export interface RemoteSeatLifecycle {
  readonly inputPort: RemoteInputPort;
  /** Call once after the app is mounted; never awaited on the startup path. */
  startAfterMount(): void;
  setProjectionActive(state: ProjectionActiveState | undefined): void;
  registerNoticeSink(show: (line: string) => void): () => void;
  stop(): Promise<void>;
}

export type RemoteSeatLifecycleOptions = Omit<
  StartRemoteSeatOptions,
  "onNotice"
>;

/** `remote.enabled` or a publishable `remote.notify` needs seat assembly. */
export function isRemoteSeatConfigured(
  settings: IknowSettingsRemote | undefined
): boolean {
  return (
    settings?.enabled === true || resolveNotifySettings(settings) !== undefined
  );
}

/** Notify is on only when both `url` and `topic` are non-empty (spec §4.5). */
function resolveNotifySettings(
  settings: IknowSettingsRemote | undefined
): NtfySettings | undefined {
  const notify = settings?.notify;
  if (notify === undefined) return undefined;
  const url = notify.url?.trim();
  const topic = notify.topic?.trim();
  if (url === undefined || url.length === 0) return undefined;
  if (topic === undefined || topic.length === 0) return undefined;
  return {
    url,
    topic,
    ...(notify.token !== undefined ? { token: notify.token } : {}),
    ...(notify.turnEndMinMs !== undefined
      ? { turnEndMinMs: notify.turnEndMinMs }
      : {}),
  };
}

function seatFailureNotice(result: RemoteSeatStartResult): string | undefined {
  if (result.ok) return undefined;
  if (result.reason === "unsafe_path") return UNSAFE_PATH_NOTICE;
  if (result.reason === "listen_failed") return LISTEN_FAILED_NOTICE;
  return result.holderPid === undefined
    ? "remote seat not started: another process is serving it"
    : `remote seat not started: another TUI is serving it (pid ${result.holderPid})`;
}

/** Notice delivery never throws back into the seat (spec §3 invariant 7). */
function createNoticeSink(
  onNotice: ((text: string) => void) | undefined
): (text: string) => void {
  return (text: string): void => {
    try {
      onNotice?.(text);
    } catch {
      // EXIT: a broken notice sink must not fail the seat or a turn.
    }
  };
}

/** Turn durations for the notifier, keyed by the projector's `turnId`. */
function attachNotifier(
  projector: SeatProjector,
  publisher: NtfyPublisher,
  now: () => number
): void {
  const startedAt = new Map<string, number>();
  projector.subscribeLive((event: SeatEvent): void => {
    const body: SeatEventBody = event.event;
    if (body.kind === "approval_pending") {
      publisher.approvalPending({ tool: body.tool });
      return;
    }
    if (body.kind === "turn_started") {
      startedAt.set(body.turnId, now());
      return;
    }
    if (body.kind !== "turn_ended") return;
    const start = startedAt.get(body.turnId);
    startedAt.delete(body.turnId);
    publisher.turnEnded({
      status: body.status,
      durationMs: start === undefined ? 0 : Math.max(0, now() - start),
    });
  });
}

/** Catch-up is atomic: the replay window is taken and live delivery registered
 *  in one synchronous turn, so no event can slip between them (spec §5.7). */
function canCatchUp(
  projector: SeatProjector,
  instanceId: string,
  args: { instanceId?: string; sinceSeq?: number }
): args is { instanceId: string; sinceSeq: number } {
  const oldest = projector.oldestSeq;
  const sinceSeq = args.sinceSeq;
  return (
    args.instanceId === instanceId &&
    typeof sinceSeq === "number" &&
    Number.isInteger(sinceSeq) &&
    oldest !== undefined &&
    sinceSeq >= oldest - 1 &&
    sinceSeq <= projector.latestSeq
  );
}

/** Host adapter over the projector + input port; exported for the seat tests. */
export function createSeatHost(opts: {
  readonly instanceId: string;
  readonly cwd: string;
  readonly projector: SeatProjector;
  readonly inputPort: RemoteInputPort;
}): RemoteSeatHost {
  const { instanceId, projector, inputPort } = opts;
  return {
    instanceId,
    pid: process.pid,
    cwd: opts.cwd,
    iknowVersion: readPackageVersion(),
    snapshot: (): Promise<Snapshot> => projector.snapshot(),
    // The reply carries the live-delivery cleanup so the server can release
    // this connection's projector subscription on close / supersede.
    async subscribe(args, deliver) {
      if (canCatchUp(projector, instanceId, args)) {
        const events = projector.replaySince(args.sinceSeq);
        const unsubscribe = projector.subscribeLive(deliver);
        return {
          mode: "catchup",
          fromSeq: args.sinceSeq,
          events,
          unsubscribe,
        };
      }
      // Register live delivery before awaiting the snapshot: the snapshot's
      // seq boundary is taken synchronously, and the server buffers live
      // frames until the result is written.
      const unsubscribe = projector.subscribeLive(deliver);
      return {
        mode: "snapshot",
        snapshot: await projector.snapshot(),
        unsubscribe,
      };
    },
    sendMessage: (args) =>
      inputPort.sendMessage(args.text, args.conversationId),
    answerApproval: (args) =>
      inputPort.answerApproval(args.toolUseId, args.answer),
    abort: () => inputPort.abort(),
  };
}

interface SeatResources {
  readonly instanceId: string;
  readonly socketPath: string | undefined;
  readonly server: { close(): Promise<void> } | undefined;
  readonly projector: SeatProjector | undefined;
  readonly publisher: NtfyPublisher | undefined;
}

/** Idempotent, non-throwing teardown (spec §5.7 goodbye + unlink). */
function createSeatHandle(resources: SeatResources): RemoteSeatHandle {
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async (): Promise<void> => {
      try {
        await resources.server?.close();
      } catch {
        // EXIT: a teardown fault must not block TUI exit.
      }
      resources.projector?.stop();
      resources.publisher?.close();
    })();
    return stopping;
  };
  return {
    instanceId: resources.instanceId,
    socketPath: resources.socketPath,
    setActive: (state): void => {
      resources.projector?.setActive(state);
    },
    stop,
  };
}

function createDegradedHandle(
  instanceId: string,
  projector: SeatProjector | undefined,
  publisher: NtfyPublisher | undefined
): RemoteSeatHandle {
  return createSeatHandle({
    instanceId,
    socketPath: undefined,
    server: undefined,
    projector,
    publisher,
  });
}

/**
 * Assemble the seat for one TUI process. Never throws: a failed optional
 * startup becomes a notice plus a degraded handle.
 */
export async function startRemoteSeat(
  opts: StartRemoteSeatOptions
): Promise<RemoteSeatHandle> {
  const instanceId = randomUUID();
  const notice = createNoticeSink(opts.onNotice);
  let projector: SeatProjector | undefined;
  let publisher: NtfyPublisher | undefined;
  let server:
    { close(): Promise<void>; readonly socketPath: string } | undefined;
  try {
    const notify = resolveNotifySettings(opts.settings);
    const enabled = opts.settings?.enabled === true;
    if (!enabled && notify === undefined) {
      return createDegradedHandle(instanceId, undefined, undefined);
    }
    projector = createSeatProjector({
      instanceId,
      hub: opts.hub,
      askBridge: opts.askBridge,
      toolEventSink: opts.toolEventSink,
      loadTranscript: opts.loadTranscript,
      onNotice: notice,
    });
    if (notify !== undefined) {
      publisher = createNtfyPublisher({
        settings: notify,
        ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
        onNotice: notice,
      });
      attachNotifier(projector, publisher, opts.now ?? Date.now);
    }
    // Start after subscribing the notifier: asks queued before the seat
    // started are announced by start() and must reach ntfy too.
    projector.start();
    if (!enabled) {
      return createDegradedHandle(instanceId, projector, publisher);
    }
    const result = await startRemoteSeatServer({
      socketPath: join(opts.dataDir, SOCKET_RELATIVE_PATH),
      host: createSeatHost({
        instanceId,
        cwd: opts.cwd,
        projector,
        inputPort: opts.inputPort,
      }),
      onNotice: notice,
    });
    if (!result.ok) {
      notice(seatFailureNotice(result) ?? UNEXPECTED_FAILURE_NOTICE);
      return createDegradedHandle(instanceId, projector, publisher);
    }
    server = result.server;
    return createSeatHandle({
      instanceId,
      socketPath: server.socketPath,
      server,
      projector,
      publisher,
    });
  } catch {
    // EXIT: optional seat assembly must never fail TUI startup (spec §3.1).
    notice(UNEXPECTED_FAILURE_NOTICE);
    try {
      await server?.close();
    } catch {
      // EXIT: best-effort cleanup on the unexpected-failure path.
    }
    projector?.stop();
    publisher?.close();
    return createDegradedHandle(instanceId, undefined, undefined);
  }
}

/**
 * TUI-lifetime wrapper: buffers the latest projection state and any notice
 * until the app has bound its sinks, starts after mount, and honours a stop
 * requested while the start promise is still in flight.
 */
export function createRemoteSeatLifecycle(
  opts: RemoteSeatLifecycleOptions,
  startImpl: (
    options: StartRemoteSeatOptions
  ) => Promise<RemoteSeatHandle> = startRemoteSeat
): RemoteSeatLifecycle {
  let handle: RemoteSeatHandle | undefined;
  let started = false;
  let stopRequested = false;
  let stopping: Promise<void> | undefined;
  let latestActive: ProjectionActiveState | undefined;
  let noticeSink: ((line: string) => void) | undefined;
  const pendingNotices: string[] = [];

  const showNotice = (text: string): void => {
    if (noticeSink === undefined) {
      pendingNotices.push(text);
      return;
    }
    noticeSink(text);
  };

  const flushNotices = (): void => {
    if (noticeSink === undefined) return;
    for (const line of pendingNotices.splice(0)) noticeSink(line);
  };

  const stopOnArrival = (resolved: RemoteSeatHandle): Promise<void> => {
    handle = resolved;
    if (stopRequested) return resolved.stop();
    if (latestActive !== undefined) resolved.setActive(latestActive);
    return Promise.resolve();
  };

  const startAfterMount = (): void => {
    if (started) return;
    started = true;
    void (async (): Promise<void> => {
      try {
        await stopOnArrival(await startImpl({ ...opts, onNotice: showNotice }));
      } catch {
        // EXIT: startRemoteSeat does not reject; a test seam might.
        showNotice(UNEXPECTED_FAILURE_NOTICE);
      }
    })();
  };

  const stop = (): Promise<void> => {
    stopRequested = true;
    stopping ??= (async (): Promise<void> => {
      try {
        await handle?.stop();
      } catch {
        // EXIT: seat teardown must not fail TUI shutdown.
      }
    })();
    return stopping;
  };

  return {
    inputPort: opts.inputPort,
    startAfterMount,
    setProjectionActive: (state): void => {
      latestActive = state;
      handle?.setActive(state);
    },
    registerNoticeSink: (show): (() => void) => {
      noticeSink = show;
      flushNotices();
      return (): void => {
        if (noticeSink === show) noticeSink = undefined;
      };
    },
    stop,
  };
}
