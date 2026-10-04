/**
 * The real host arm of the fresh-process crash harness. One file, one process
 * role per `input.role`, all running PRODUCTION code against a temp session
 * pool: the real `SessionStore`, the real CLI chat host
 * (`createChatSessionPersistence` + `processChatLine`), the real graph tool
 * with a real sub-agent manager, and the real recovery entry
 * (`recoverChatSessionEntry`).
 *
 * Nothing here is a mock of the system under test. The only test doubles are
 * (a) the model adapter, which the repo's own fixtures already stub, and (b) a
 * scripted sub-agent worker that answers a task by its own name, both standing
 * in for a provider — never for the store, the host wiring, the publication
 * path, or recovery.
 *
 * The tool-dispatch probe is not a stub either: the arms that arm it assemble
 * the REAL production toolset (`createDefaultAciRegistry`, the factory
 * `buildHarnessEngine` calls) in the child process and wrap every def it
 * produces.
 *
 * A crashing arm never exits: it announces the crash point it reached on
 * `crashPointPath` and then holds a real interval open, so the parent's
 * `SIGKILL` to the process group lands on a live, blocked process. That is the
 * abnormal host exit the spec asks for — no handler, no flush, no unwinding.
 */
import {
  chmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  createChatSessionPersistence,
  processChatLine,
  recoverChatSessionEntry,
} from "../../../src/cli/chat-session.ts";
import { createDefaultAciRegistry } from "../../../src/harness/aci/tools/registry.ts";
import { createLiveGraphLedgerHost } from "../../../src/harness/graph/ledger.ts";
import { createRunGraphTool } from "../../../src/harness/graph/run-graph-tool.ts";
import type {
  ToolDef,
  ToolExecutionResult,
} from "../../../src/harness/tools/types.ts";
import { createRegistry } from "../../../src/harness/tools/registry.ts";
import { createExecutor } from "../../../src/harness/tools/executor.ts";
import { createAciExecutor } from "../../../src/harness/aci/aci-executor.ts";
import { createRuntimePersistenceBinder } from "../../../src/session-api/store/runtime-persistence-host.ts";
import {
  parseSessionJsonl,
  SESSION_JSONL_EXT,
  type SessionOperationFactRecord,
} from "../../../src/session-api/store/jsonl.ts";
import {
  CURRENT_SCHEMA_VERSION,
  NATIVE_STATE_FORMAT_VERSION,
} from "../../../src/session-api/store/schema.ts";
import {
  resolveConversationDir,
  SessionStore,
} from "../../../src/session-api/store/session-store.ts";
import { createDefaultSubAgentSpawn } from "../../../src/harness/subagent/spawn.ts";
import { createSubAgentManager } from "../../../src/harness/subagent/manager.ts";
import { createMergedCatalogResolver } from "../../../src/harness/subagent/user-catalog.ts";
import {
  createBackgroundTaskManager,
  defaultBackgroundSpawn,
} from "../../../src/harness/background/manager.ts";
import { createMcpManager } from "../../../src/harness/mcp/manager.ts";
import { createSkillCatalog } from "../../../src/harness/skill/catalog.ts";
import type { AnthropicNativeMessage } from "../../../src/harness/model-adapter/types.ts";
import type { CrashPoint, CrashRoleRequest, PlanOp } from "./crash-harness.ts";
import type { NativeStateMessage } from "../../../src/shared/native-state-port.ts";

const input = JSON.parse(
  readFileSync(process.argv[2] as string, "utf8")
) as CrashRoleRequest;

const asNative = (
  messages: ReadonlyArray<NativeStateMessage>
): ReadonlyArray<AnthropicNativeMessage> =>
  messages as unknown as ReadonlyArray<AnthropicNativeMessage>;

const logPathOf = (req: CrashRoleRequest): string =>
  join(
    resolveConversationDir({
      projectDir: new SessionStore(
        req.sessionPoolDir,
        req.workspaceRoot
      ).getProjectDir(),
      conversationId: req.conversationId,
    }),
    `${req.conversationId}${SESSION_JSONL_EXT}`
  );

/**
 * Announce the named crash point, then block on a real handle forever.
 *
 * The returned promise never settles, which is what keeps the host ALIVE for
 * the parent's `SIGKILL`: an unresolved promise with no handle would let Node
 * exit on its own, and a throwing "crash" would unwind through whatever error
 * handling the caller has. A live, blocked process is the thing the spec asks
 * to kill.
 */
function announceCrashPoint(
  point: CrashPoint,
  detail: Record<string, unknown>
): Promise<never> {
  writeFileSync(input.crashPointPath, JSON.stringify({ point, detail }));
  writeSync(1, `REACHED ${point}\n`);
  setInterval(() => {}, 1000);
  return new Promise<never>(() => {});
}

const RESULT_PREFIX = "IKNOW-CRASH-RESULT ";

function report(value: unknown): void {
  writeSync(1, `${RESULT_PREFIX}${JSON.stringify(value)}\n`);
}

// -- role: publish -------------------------------------------------------------

/**
 * Run the caller's real store operations, then reach the requested crash point.
 *
 * The two crash points are the ones the spec names for the publication path:
 * the body on disk with the record absent, and a half-written trailing record.
 */
async function publishArm(): Promise<void> {
  const store = new SessionStore(input.sessionPoolDir, input.workspaceRoot);
  for (const op of input.plan ?? []) {
    await runPlanOp(store, op);
  }
  if (input.crashPointHint === undefined) {
    // A seeding pass: the real store wrote the log and this host exits
    // normally, leaving the log a later crash can land on.
    report({ ops: input.plan?.length ?? 0 });
    return;
  }
  if (input.crashPointHint === "torn_trailing_append") {
    await writeTornRecordTail();
  }
  if (input.faultedPublish !== undefined) {
    await faultedPublishArm(store);
  }
  throw new Error(
    `publish arm reached no crash point (hint=${String(input.crashPointHint)})`
  );
}

async function runPlanOp(store: SessionStore, op: PlanOp): Promise<void> {
  if (op.op === "create") {
    await store.save({
      id: input.conversationId,
      file: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        conversation_id: input.conversationId,
        title: "",
        cwd: op.cwd,
        sanitized_at: new Date().toISOString(),
        messages: [],
        jsonMode: false,
        turnCount: 0,
        updatedAt: new Date().toISOString(),
        checkpoints: [],
        // The recovery path only selects a published state for a session the
        // new native-state format identifies as such.
        nativeStateFormat: NATIVE_STATE_FORMAT_VERSION,
        workspaceRoot: input.workspaceRoot,
      },
    });
    return;
  }
  if (op.op === "appendEvents") {
    await store.appendEvents({
      id: input.conversationId,
      events: asNative(op.messages),
    });
    return;
  }
  await store.appendNativeState({
    id: input.conversationId,
    anchorEventId: op.anchorEventId,
    boundary: op.boundary,
    snapshot: { boundary: op.boundary, messages: op.messages },
  });
}

/**
 * The publication fault: the log is made un-appendable for real (no mock, no
 * injected error), then the production `appendNativeState` runs. Its body write
 * lands in the immutable pool; its record append is refused by the OS. That is
 * the on-disk state a crash between the two statements leaves behind.
 */
async function faultedPublishArm(store: SessionStore): Promise<void> {
  const want = input.faultedPublish;
  if (want === undefined) throw new Error("faultedPublish missing");
  chmodSync(logPathOf(input), 0o444);
  let observed: string;
  try {
    await store.appendNativeState({
      id: input.conversationId,
      anchorEventId: want.anchorEventId,
      boundary: want.boundary,
      snapshot: { boundary: want.boundary, messages: want.messages },
    });
    throw new Error(
      "the log was made un-appendable, so the record append cannot have succeeded"
    );
  } catch (err) {
    const kind = (err as { kind?: string }).kind;
    if (kind === undefined) throw err;
    observed = kind;
  }
  await announceCrashPoint("after_body_write_before_record_append", {
    refusedKind: observed,
    bytesAppended: false,
  });
}

/**
 * Leave a real record's first bytes on disk and no newline: the torn trailing
 * append. The bytes go through a real file descriptor and the process is then
 * killed mid-record, so the fragment is what a SIGKILL inside the append leaves
 * — chosen rather than raced, because a kill during a sub-millisecond write is
 * not reproducible.
 */
async function writeTornRecordTail(): Promise<void> {
  const line =
    JSON.stringify({
      type: "native_state",
      anchorEventId: "e-torn",
      bodySha: "0".repeat(64),
      boundary: "input",
      messageCount: 1,
      createdAt: "1970-01-01T00:00:00.000Z",
    }) + "\n";
  const total = Buffer.byteLength(line, "utf8");
  const keep = input.tornBytes ?? Math.floor(total / 2);
  const fd = openSync(logPathOf(input), "a");
  writeSync(fd, Buffer.from(line, "utf8").subarray(0, keep));
  await announceCrashPoint("torn_trailing_append", {
    bytesOnDisk: keep,
    recordBytes: total,
  });
}

// -- role: chat_turn -----------------------------------------------------------

/**
 * The real CLI chat host: it accepts a user line, commits the accepted input
 * through the production commit hook, and the loop publishes the input state
 * through the production binder — then the tripwire adapter refuses to answer
 * the first MAIN-LOOP model request, which is the moment the parent kills the
 * group. A request with no tools is the compaction arm's summariser call and is
 * answered by the scripted stub; only a main-loop dispatch blocks.
 */
async function chatTurnArm(): Promise<void> {
  const { makeDeps, makeCtx, assistantResult } =
    await import("../../../tests/cli/_fixtures.ts");
  const store = new SessionStore(input.sessionPoolDir, input.workspaceRoot);
  const projectDir = store.getProjectDir();
  const responses =
    input.compress === true
      ? [assistantResult({ texts: ["compacted summary"] })]
      : [];
  const base = makeDeps(responses);
  const step = base.adapter.step.bind(base.adapter);
  let ctx: ReturnType<typeof makeCtx>;
  const persistence = createChatSessionPersistence({
    store,
    conversationId: input.conversationId,
    newFormat: true,
    jsonMode: false,
    getPriors: () => ctx.state.messages,
    workspaceRoot: projectDir,
    deps: base,
  });
  const deps: typeof base = {
    ...base,
    commitMessages: persistence.commit,
    ...(persistence.runtimePersistence !== undefined
      ? { runtimePersistence: persistence.runtimePersistence }
      : {}),
    ...(input.compress === true
      ? { compress: { contextWindow: 200_000, thresholdTokens: 1 } }
      : {}),
    adapter: {
      ...base.adapter,
      step: (...args: Parameters<typeof step>) => {
        if (args[1].tools !== undefined) {
          // The accepted input is already on disk; the host has handed the
          // request to the model and will never get an answer back. A request
          // with no tools is the compaction summariser's, answered by the stub.
          return announceCrashPoint("first_model_dispatch", {
            conversationId: input.conversationId,
            contextMessages: args[0].messages.length,
          });
        }
        return step(...args);
      },
    },
  };
  ctx = makeCtx({
    responses,
    checkpointStore: store,
    workspaceRoot: projectDir,
    stateOverrides: {
      conversationId: input.conversationId,
      ...(input.priorMessages !== undefined
        ? { messages: asNative(input.priorMessages) }
        : {}),
    },
  });
  await processChatLine({
    line: input.line ?? "remember this",
    ctx: {
      ...ctx,
      deps,
      newFormatSession: true,
      commitAcceptedInput: persistence.commitAcceptedInput,
    },
  });
  throw new Error("the chat turn ended without reaching a model dispatch");
}

/**
 * The same real host with a real `tool_use` in the scripted model response,
 * run either to COMPLETION or to the `tool_use_committed_before_kill` crash
 * point — the Prove-It arm and the seeding leg of the deliberate-replay control.
 *
 * `toolUse.killAfterCommit` decides which: absent, the turn completes and the
 * arm reports; present, the loop dispatches the real tool, the real persistence
 * commits the assistant `tool_use` and its `tool_result`, and the host is killed
 * with the NEXT main-loop model request in flight — so the log a later reopen
 * restores really holds a tool round-trip.
 *
 * Either way the SAME probe, over the SAME real production tool surface behind
 * the SAME real registry and executor, is driven by the real loop from a real
 * `tool_use` block, and it reads non-zero with the handler's own file contents
 * coming back. It also reports the input the provider returned beside the input
 * the handler observed, so a dispatch's provenance is compared rather than
 * assumed.
 */
async function chatTurnToolArm(): Promise<void> {
  const { makeDeps, makeCtx, assistantResult } =
    await import("../../../tests/cli/_fixtures.ts");
  const want = input.toolUse;
  if (want === undefined) throw new Error("toolUse missing");
  const store = new SessionStore(input.sessionPoolDir, input.workspaceRoot);
  const projectDir = store.getProjectDir();
  const target = await writeProbeTarget(input.workspaceRoot);
  const { surface, result: probe } = await armProductionToolProbe(store);
  const providerToolUseInput = { path: target };
  const responses = [
    assistantResult({
      texts: [],
      toolCalls: [
        { id: want.id, name: PROBE_TOOL, input: providerToolUseInput },
      ],
    }),
    assistantResult({ texts: ["tool answered"] }),
  ];
  const base = makeDeps(responses);
  const step = base.adapter.step.bind(base.adapter);
  let mainLoopDispatches = 0;
  let ctx: ReturnType<typeof makeCtx>;
  const persistence = createChatSessionPersistence({
    store,
    conversationId: input.conversationId,
    newFormat: true,
    jsonMode: false,
    getPriors: () => ctx.state.messages,
    workspaceRoot: projectDir,
    deps: base,
  });
  const deps: typeof base = {
    ...base,
    // The real tool surface the real loop will dispatch through, probed.
    registry: surface.registry,
    executor: surface.executor,
    commitMessages: persistence.commit,
    ...(persistence.runtimePersistence !== undefined
      ? { runtimePersistence: persistence.runtimePersistence }
      : {}),
    ...(want.killAfterCommit === true
      ? {
          // The second main-loop request is only reached once the tool phase
          // has settled and been committed, so blocking here leaves a real
          // `tool_use` + `tool_result` pair on disk.
          adapter: {
            ...base.adapter,
            step: (...args: Parameters<typeof step>) => {
              // Only a request carrying tools is a MAIN-LOOP request, so this
              // counter is main-loop turns alone (the compaction summariser's
              // request carries none). The SECOND one is the first that can
              // follow a settled tool batch: the loop commits the assistant
              // `tool_use` and its `tool_result` before asking again, so blocking
              // here leaves a real tool round-trip on disk.
              if (args[1].tools === undefined) return step(...args);
              mainLoopDispatches += 1;
              if (mainLoopDispatches < 2) return step(...args);
              return announceCrashPoint("tool_use_committed_before_kill", {
                conversationId: input.conversationId,
                contextMessages: args[0].messages.length,
                toolHits: surface.hits.length,
                mainLoopDispatches,
              });
            },
          },
        }
      : {}),
  };
  ctx = makeCtx({
    responses,
    checkpointStore: store,
    workspaceRoot: projectDir,
    stateOverrides: { conversationId: input.conversationId },
  });
  try {
    await processChatLine({
      line: input.line ?? "read the probe file",
      ctx: {
        ...ctx,
        deps,
        newFormatSession: true,
        commitAcceptedInput: persistence.commitAcceptedInput,
      },
    });
    if (want.killAfterCommit === true) {
      throw new Error("the chat turn ended without reaching a model dispatch");
    }
    report({
      toolProbe: {
        // `armed` is the LOOP's own verdict here: a real dispatch from a real
        // `tool_use` block landed on the probed production surface. The control's
        // own lines ride along in `controls` so the two are never confused.
        armed: surface.hits.length > 0,
        controls: [
          ...probe.controls,
          `loopTool=${surface.hits.length > 0 ? "fired" : "MISSED"}`,
        ],
        hits: surface.hits,
        wrapped: probe.wrapped,
        productionCount: probe.productionCount,
        wrappedCount: probe.wrappedCount,
        minDefs: probe.minDefs,
      },
      providerToolUseInput,
      handlerObservedInput: surface.observed[0] ?? null,
      sentinel: PROBE_SENTINEL,
    });
  } finally {
    // On the `killAfterCommit` path this never RUNS: the crash point returns a
    // never-settling promise and the parent SIGKILLs the group, so the process
    // is KILLED, not unwound, and no handler below fires. This teardown covers
    // the completed run only.
    await surface.dispose();
  }
}

// -- role: graph_host ----------------------------------------------------------

/** The worker the production spawn factory starts. Written as a `.cjs` entry
 *  because that factory launches a plain script, not a TypeScript module, and
 *  the task text alone decides how the node settles. */
const WORKER_SOURCE = `
const fs = require("node:fs");
const path = require("node:path");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  if (!buf.includes("\\n")) return;
  const envelope = JSON.parse(buf.split("\\n", 1)[0]);
  if (typeof envelope.transcriptPath === "string") {
    fs.mkdirSync(path.dirname(envelope.transcriptPath), { recursive: true });
    fs.appendFileSync(
      envelope.transcriptPath,
      JSON.stringify({ role: "user", content: [{ type: "text", text: envelope.task }] }) + "\\n",
      "utf8"
    );
  }
  const settle = envelope.task.split(":")[0];
  if (settle === "hold") {
    setInterval(() => {}, 1000);
    return;
  }
  const failed = settle === "fail";
  process.stdout.write(
    JSON.stringify({
      status: failed ? "failed" : "ok",
      summary: failed ? "node refused" : "node finished",
      result: failed ? "" : "SETTLED-OUTPUT",
      ...(failed ? { reason: "crashed" } : {}),
    }) + "\\n"
  );
  setTimeout(() => process.exit(0), 20);
});
`;

/**
 * A real graph host: the real tool, the real ledger, a real sub-agent manager
 * whose children are real processes, and the real binder carrying node facts
 * into the store. It blocks at the crash point once one node has settled and
 * another is still running.
 */
async function graphHostArm(): Promise<void> {
  const store = new SessionStore(input.sessionPoolDir, input.workspaceRoot);
  const subagentsDir = join(input.workspaceRoot, "subagents");
  mkdirSync(subagentsDir, { recursive: true });
  const workerScript = join(input.workspaceRoot, "node-worker.cjs");
  writeFileSync(workerScript, WORKER_SOURCE, "utf8");
  const binder = createRuntimePersistenceBinder({
    store,
    serialize: (_id, work) => work(),
    shouldPublish: () => true,
  });
  const started: string[] = [];
  const baseSpawn = createDefaultSubAgentSpawn();
  const manager = createSubAgentManager({
    spawn: (def, taskId, payload) => {
      started.push(taskId);
      return baseSpawn(def, taskId, payload);
    },
    subagentsDir,
    sandboxRoot: subagentsDir,
    runtimePersistence: binder,
  });
  const tool = createRunGraphTool({
    manager,
    ledger: createLiveGraphLedgerHost(),
    isEnabled: () => true,
    runtimePersistence: binder,
  });
  const original = process.argv[1];
  process.argv[1] = workerScript;
  try {
    const running = tool.handler(
      {
        nodes: [
          { id: "alpha", task: "settle:alpha" },
          { id: "beta", task: "hold:beta" },
          { id: "gamma", task: "fail:gamma" },
        ],
      },
      { conversationId: input.conversationId }
    );
    // Wait for the two settled nodes' facts to reach the real log, then hold
    // the in-flight one: that is the state the host dies in.
    await waitForSettledNodes();
    // The graph is still running: the host dies holding it.
    void Promise.resolve(running).catch(() => {});
    await announceCrashPoint("graph_node_in_flight", {
      spawned: started.length,
    });
  } finally {
    process.argv[1] = original;
  }
}

/** Poll the REAL log until the settled nodes' operation facts are durable. */
async function waitForSettledNodes(): Promise<void> {
  const path = logPathOf(input);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const log = parseSessionJsonl(readFileSync(path, "utf8"));
    const states = new Set(
      log.records
        .filter((rec) => rec.type === "operation_fact")
        .map((rec) => (rec as SessionOperationFactRecord).fact)
        .filter((fact) => (fact as { kind?: string }).kind === "graph_node")
        .map((fact) => (fact as { status?: string }).status ?? "unknown")
    );
    if (states.has("done") && states.has("failed")) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("no graph node settled within 30s");
}

// -- role: reopen_chat ---------------------------------------------------------

/** A fresh process's reopen: the real recovery entry, with two probes armed
 *  BEFORE it runs — the provider-request tripwire on `globalThis.fetch`, and
 *  the tool-dispatch probe over the REAL production toolset this process
 *  assembled (`createDefaultAciRegistry`, every def wrapped, behind the real
 *  registry and the real base executor).
 *
 *  What the tool probe's zero rests on, all of it measured in this process: the
 *  probe is the only tool surface this process assembles; it rides the WHOLE
 *  real production toolset — every def it produced, `wrappedCount ===
 *  productionCount`, both at or above the host's own floor — rather than one
 *  hand-picked def; and its own control fires through it, on a real production
 *  tool, with the real handler's bytes coming back, before anything under test
 *  runs.
 *
 *  The bound, stated rather than papered over: the probe sees dispatches made
 *  THROUGH it, and this arm assembles it — recovery is handed neither a
 *  registry nor an executor. Its own doc says the shared host contract takes no
 *  engine deps, which is the structural reason it cannot issue a model or tool
 *  call, so the counter reads zero for ANY implementation of recovery: this is
 *  not a discriminating test of recovery's code. Nor is the probe the
 *  production dispatch stack — that is `createAciExecutor` over
 *  `createExecutor` over `withLazyLspWarmup(reg.inner, …)` against the probe's
 *  bare `createExecutor(createRegistry(wrapped))` — and a dispatch made on some
 *  other stack in this process would not be observed here.
 *
 *  `replayRestoredToolUse` is what keeps the zero from being a quiet absence:
 *  after recovery, the arm DELIBERATELY dispatches the restored `tool_use`
 *  through that same surface, on the very block recovery restored. */
async function reopenChatArm(): Promise<void> {
  const store = new SessionStore(input.sessionPoolDir, input.workspaceRoot);
  const tripwire = await armTripwire();
  const { surface, result: toolProbe } = await armProductionToolProbe(store);
  try {
    const { recovery, messages } = await recoverChatSessionEntry({
      store,
      conversationId: input.conversationId,
      taskRoot: input.workspaceRoot,
      liveRootIdentity: input.liveRootIdentity,
      seedMessages: asNative(input.seedMessages ?? []),
    });
    // The negative window closes HERE: these are the hits recovery produced,
    // read on the live surface and snapshotted ONCE, so the replay leg in the
    // same process reports the same number off one source and cannot contaminate
    // it.
    const hitsAfterRecovery = [...surface.hits];
    const dispatchesAfterRecovery = [...surface.dispatches];
    const replay =
      input.replayRestoredToolUse === true
        ? await replayRestoredToolUse(
            surface,
            recovery.restoredContext,
            hitsAfterRecovery
          )
        : null;
    // Continue the host for real: a second window in the SAME process, opened by
    // the product's own next turn rather than by the test.
    const continued =
      input.continueTurn === undefined
        ? null
        : await continueTurnOnHostPath(
            surface,
            store,
            messages,
            input.continueTurn
          );
    report({
      status: recovery.status,
      savedMessageCount: recovery.savedMessageCount,
      restoredContext: recovery.restoredContext,
      messages,
      outcome: recovery.outcome ?? null,
      operations: recovery.operations,
      tripwire,
      // The counter as the window closed, NOT the live array.
      toolProbe: { ...toolProbe, hits: hitsAfterRecovery },
      ...(replay === null ? {} : { replay }),
      ...(continued === null ? {} : { continued, dispatchesAfterRecovery }),
    });
  } finally {
    await surface.dispose();
  }
}

/** What the continued turn dispatched, and what the product decided to run. */
interface ContinuedTurn {
  /** The NEW `tool_use` the scripted response carried — a different call from
   *  anything the checkpoint restored, so a dispatch can be attributed. */
  readonly newToolUseId: string;
  readonly newToolUseInput: { readonly path: string };
  /** Counter after the turn, minus the recovery window: what the host's own
   *  dispatch path ran while continuing from the restored context. */
  readonly hitsDuringTurn: ReadonlyArray<string>;
  /** Per-dispatch records, carrying the wire id of the call that reached the
   *  handler, so "the restored block never ran" is a claim about THAT call. */
  readonly dispatchesDuringTurn: ReadonlyArray<{
    readonly name: string;
    readonly toolUseId: string | undefined;
    readonly input: unknown;
  }>;
  /** The history the turn actually started from, so the test can confirm the
   *  restored context really was on it. */
  readonly priorMessageCount: number;
  readonly priorTexts: ReadonlyArray<string>;
}

/**
 * Run ONE REAL turn in the reopened process, starting from the restored context,
 * with the tool surface wired as the loop's own deps.
 *
 * This is the difference between observing the behavior under test and observing
 * a registry the test happens to own. Nothing here dispatches anything: the turn
 * goes through `processChatLine` → the real loop → `deps.executor` (the probed
 * production toolset behind the production permission stack) → the real handler
 * bodies, exactly as a host that resumed from a checkpoint and then took the
 * operator's next line would. The restored messages go in as the turn's prior
 * history through `state.messages`, which is the seam the CLI's `--resume` path
 * itself uses (`state.messages = entry.messages` before the next line).
 */
async function continueTurnOnHostPath(
  surface: ProbedToolSurface,
  store: SessionStore,
  restored: ReadonlyArray<AnthropicNativeMessage>,
  want: NonNullable<CrashRoleRequest["continueTurn"]>
): Promise<ContinuedTurn> {
  const { makeDeps, makeCtx, assistantResult } =
    await import("../../../tests/cli/_fixtures.ts");
  const projectDir = store.getProjectDir();
  // A DIFFERENT file from the one the checkpoint's `tool_use` names, so a
  // dispatch is attributable by content as well as by wire id.
  const target = await writeProbeTarget(
    input.workspaceRoot,
    `${PROBE_FILE}.after-recovery`
  );
  const newToolUseInput = { path: target };
  const responses = [
    assistantResult({
      texts: [],
      toolCalls: [{ id: want.id, name: PROBE_TOOL, input: newToolUseInput }],
    }),
    assistantResult({ texts: ["tool answered after recovery"] }),
  ];
  const base = makeDeps(responses);
  let ctx: ReturnType<typeof makeCtx>;
  const persistence = createChatSessionPersistence({
    store,
    conversationId: input.conversationId,
    newFormat: true,
    jsonMode: false,
    getPriors: () => ctx.state.messages,
    workspaceRoot: projectDir,
    deps: base,
  });
  const deps: typeof base = {
    ...base,
    registry: surface.registry,
    executor: surface.executor,
    commitMessages: persistence.commit,
    ...(persistence.runtimePersistence !== undefined
      ? { runtimePersistence: persistence.runtimePersistence }
      : {}),
  };
  ctx = makeCtx({
    responses,
    checkpointStore: store,
    workspaceRoot: projectDir,
    stateOverrides: {
      conversationId: input.conversationId,
      // The resumed host's starting history IS the restored context.
      messages: Object.freeze([...restored]),
    },
  });
  const before = surface.dispatches.length;
  const hitsBefore = surface.hits.length;
  await processChatLine({
    line: want.line,
    ctx: {
      ...ctx,
      deps,
      newFormatSession: true,
      commitAcceptedInput: persistence.commitAcceptedInput,
    },
  });
  return {
    newToolUseId: want.id,
    newToolUseInput,
    hitsDuringTurn: surface.hits.slice(hitsBefore),
    dispatchesDuringTurn: surface.dispatches.slice(before),
    priorMessageCount: restored.length,
    priorTexts: restored.map((m) =>
      m.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
        .slice(0, 80)
    ),
  };
}

/** What the deliberate replay dispatched, and what the counter read after it. */
interface ReplayLeg {
  /** The `tool_use` block recovery really restored, and where it was found. */
  readonly restoredToolUse: {
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
  } | null;
  /** The counter as the NEGATIVE window closed — the SAME snapshot the reopen
   *  arm reports, handed in rather than re-read here. */
  readonly hitsAfterRecovery: ReadonlyArray<string>;
  /** The real dispatch's own verdict, from the real executor. */
  readonly dispatch: {
    readonly kind: string;
    /** The real handler's own output, so a hit is tied to the handler body. */
    readonly readBack: boolean;
  };
  /** The counter after the replay — MUST be non-zero. */
  readonly hitsAfterReplay: ReadonlyArray<string>;
  /** Inputs every production handler on the surface was called with. */
  readonly observedInputs: ReadonlyArray<unknown>;
}

/**
 * DELIBERATELY replay the restored `tool_use` — the bug this criterion forbids.
 *
 * The block is taken from the context `recoverChatSessionEntry` really
 * restored, dispatched as the call shape a `tool_use` produces, through the same
 * probed production registry and the real executor the negative window was read
 * on. A non-zero counter here is what keeps the reopen's zero from being a quiet
 * absence: the instrument fires on exactly the thing recovery declined to do.
 *
 * `hitsAfterRecovery` is PASSED IN, not re-read: the negative window closed
 * before this leg ran, and a second snapshot of the same array would be a second
 * copy of one number, not a second measurement.
 */
async function replayRestoredToolUse(
  surface: ProbedToolSurface,
  restoredContext: ReadonlyArray<NativeStateMessage> | null,
  hitsAfterRecovery: ReadonlyArray<string>
): Promise<ReplayLeg> {
  const restored = lastToolUse(restoredContext);
  if (restored === null) {
    throw new Error(
      "the replay control needs a restored tool_use block, and the restored context has none"
    );
  }
  const results = await surface.executor.executeAll([
    { id: restored.id, name: restored.name, input: restored.input },
  ]);
  const result = results[0];
  return {
    restoredToolUse: {
      id: restored.id,
      name: restored.name,
      input: restored.input,
    },
    hitsAfterRecovery,
    dispatch: {
      kind: result?.kind ?? "missing",
      readBack: payloadText(result).includes(PROBE_SENTINEL),
    },
    hitsAfterReplay: [...surface.hits],
    observedInputs: surface.observed,
  };
}

/** The LAST `tool_use` block in a restored context, as the call it describes. */
function lastToolUse(
  restoredContext: ReadonlyArray<NativeStateMessage> | null
): {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
} | null {
  let found: { id: string; name: string; input: unknown } | null = null;
  for (const message of restoredContext ?? []) {
    for (const block of message?.content ?? []) {
      if (block.type !== "tool_use") continue;
      found = { id: block.id, name: block.name, input: block.input ?? {} };
    }
  }
  return found;
}

// -- role: reopen_graph --------------------------------------------------------

/**
 * The fresh process after an abnormal graph host death: recover the session,
 * seed the live ledger from the durable per-node view, then submit the same
 * graph again and observe which nodes are dispatched. Dispatch evidence is
 * real child processes through the real manager, not a counter on a fake.
 */
async function reopenGraphArm(): Promise<void> {
  const store = new SessionStore(input.sessionPoolDir, input.workspaceRoot);
  const subagentsDir = join(input.workspaceRoot, "subagents");
  mkdirSync(subagentsDir, { recursive: true });
  const workerScript = join(input.workspaceRoot, "node-worker.cjs");
  await writeFile(workerScript, WORKER_SOURCE, "utf8");
  const binder = createRuntimePersistenceBinder({
    store,
    serialize: (_id, work) => work(),
    shouldPublish: () => true,
  });
  const ledgerHost = createLiveGraphLedgerHost();
  const spawned: string[] = [];
  const baseSpawn = createDefaultSubAgentSpawn();
  const manager = createSubAgentManager({
    spawn: (def, taskId, payload) => {
      spawned.push(String(def.task));
      return baseSpawn(def, taskId, payload);
    },
    subagentsDir,
    sandboxRoot: subagentsDir,
    runtimePersistence: binder,
  });
  const { recovery } = await recoverChatSessionEntry({
    store,
    conversationId: input.conversationId,
    taskRoot: input.workspaceRoot,
    liveRootIdentity: input.liveRootIdentity,
    seedMessages: [],
    liveGraphLedger: ledgerHost,
    write: () => {},
  });
  // Read the seeded ledger BEFORE any submission: a rescue run would settle the
  // in-flight node and freeze it, and the recovery-time view is what the
  // criterion is about.
  const seededLedger = seedSummary(ledgerHost, input.conversationId);
  const tool = createRunGraphTool({
    manager,
    ledger: ledgerHost,
    isEnabled: () => true,
    runtimePersistence: binder,
  });
  // The same spec the killed host ran, submitted again to a live graph. A frozen
  // id refuses the whole spec, so this is where a settled node shows up: a typed
  // refusal and zero spawns. The snapshot is taken here, before the rescue
  // dispatch below, so the two arms cannot contaminate each other.
  const resubmitAll = await Promise.resolve(
    tool.handler(
      {
        nodes: [
          { id: "alpha", task: "settle:alpha-again" },
          { id: "beta", task: "settle:beta-again" },
          { id: "gamma", task: "settle:gamma-again" },
        ],
      },
      { conversationId: input.conversationId }
    )
  ).then(
    () => ({ accepted: true, error: null }),
    (err: Error) => ({ accepted: false, error: err.message })
  );
  const spawnedByRefusedSpec = [...spawned];
  // The interrupted node on its own: never frozen, so it must still dispatch —
  // as a real child process, which is the evidence the criterion asks for.
  const rescue = await Promise.race([
    Promise.resolve(
      tool.handler(
        { nodes: [{ id: "beta", task: "settle:beta-again" }] },
        { conversationId: input.conversationId }
      )
    ).then(
      () => "accepted",
      (err: Error) => `rejected:${err.message}`
    ),
    new Promise<string>((r) => {
      setTimeout(() => r("still running"), 30_000);
    }),
  ]);
  await manager.shutdown();
  report({
    graphNodes: recovery.operationFacts?.graphNodes ?? [],
    seededLedger,
    resubmit: { ...resubmitAll, spawned: spawnedByRefusedSpec },
    rescue: { beta: rescue, spawned: [...spawned] },
  });
}

/** The ledger's own view of each node after recovery, read from the live
 *  ledger the reopen seeded — not from a value the seeding returned. */
function seedSummary(
  host: ReturnType<typeof createLiveGraphLedgerHost>,
  conversationId: string
): ReadonlyArray<{
  nodeId: string;
  frozen: boolean;
  status: string | null;
  output: string | undefined;
}> {
  const ledger = host.ledgerFor(conversationId);
  return ["alpha", "beta", "gamma"].map((nodeId) => ({
    nodeId,
    frozen: ledger.isFrozen(nodeId),
    status: ledger.statusOf(nodeId) ?? null,
    output: ledger.outputOf(nodeId),
  }));
}

// -- the reopen tripwire -------------------------------------------------------

/**
 * Arm the ONE sound in-process instrument for "recovery asked nobody anything":
 * `globalThis.fetch`, which every provider transport resolves off the global
 * at call time.
 *
 * Scope, stated because it bounds the claim the test may make: a module-level
 * patch (`node:child_process`, `node:fs/promises`, `node:https`) CANNOT observe
 * this repository's own calls, because a builtin's ESM facade snapshots its
 * named exports at link time. That was measured, not assumed — a real
 * `writeNativeStateBody` through the production pool writer did not register on
 * a patched `fs/promises.writeFile`. So this arm claims "no outbound provider
 * request through the standard transport", and the tool-dispatch half is carried
 * by `armToolProbe` below rather than by this instrument.
 *
 * The control is what makes the zero count meaningful: the patched global is
 * called once on a `data:` URL (no network, no provider), and the arm fails
 * loudly if that call did not register.
 */
async function armTripwire(): Promise<{
  armed: boolean;
  controls: ReadonlyArray<string>;
  hits: ReadonlyArray<string>;
}> {
  const realFetch = globalThis.fetch;
  const hits: string[] = [];
  globalThis.fetch = ((...args: Parameters<typeof realFetch>) => {
    hits.push(`fetch:${String(args[0])}`);
    return realFetch(...args);
  }) as typeof realFetch;
  const before = hits.length;
  await globalThis.fetch("data:text/plain,tripwire-control");
  const armed = hits.length > before;
  // The control's own hit leaves the measurement window: the array the reopen
  // is judged on must start empty, and it is the same array the patch writes to.
  hits.length = 0;
  return { armed, controls: [`fetch=${armed ? "fired" : "MISSED"}`], hits };
}

// -- the tool-dispatch probe ---------------------------------------------------

/** The production tool the control rides. A real `read_file` def, not a stub: the
 *  point is to observe the real executor calling the real handler body. */
const PROBE_TOOL = "read_file";
/** Probe scratch file, inside the host's own temp workspaceRoot. */
const PROBE_FILE = "tool-probe-target.txt";
/** Bytes the control's real read must come back with. */
const PROBE_SENTINEL = "IKNOW-TOOL-PROBE-SENTINEL";
/**
 * How many production defs the probe must be riding: the arm REFUSES to run
 * below this. A one-def probe cannot notice a tool it never wrapped, and a
 * shrinking toolset must not turn the reopen's zero into a vacuous pass — so the
 * floor is enforced here and REPORTED as `minDefs`, so the test asserts this
 * same boundary instead of duplicating a literal that can drift.
 */
const MIN_WRAPPED_PRODUCTION_DEFS = 10;

export interface ToolProbeResult {
  readonly armed: boolean;
  readonly controls: ReadonlyArray<string>;
  readonly hits: ReadonlyArray<string>;
  /** Tool names the probe is actually riding; an empty list would be an
   *  unarmed probe, which is why the control has to be reported with it. */
  readonly wrapped: ReadonlyArray<string>;
  /** How many defs the REAL production toolset assembled in this process. */
  readonly productionCount: number;
  /** How many of them the probe wrapped. Must equal `productionCount`. */
  readonly wrappedCount: number;
  /** This host's own floor, reported so the caller asserts against the SAME
   *  boundary the arm enforces instead of a second literal that can drift. */
  readonly minDefs: number;
}

interface ProbedToolSurface {
  readonly registry: ReturnType<typeof createRegistry>;
  readonly executor: ReturnType<typeof createAciExecutor>;
  readonly hits: string[];
  /** Inputs the real handlers were called with, mutable so the control's own
   *  read can leave the window along with its hit. */
  readonly observed: unknown[];
  /** One record per dispatch, carrying the wire id of the call that reached the
   *  handler. A dispatch is therefore attributable to a specific `tool_use`,
   *  which is what lets a negative claim name the call it is about. */
  readonly dispatches: Array<{
    readonly name: string;
    readonly toolUseId: string | undefined;
    readonly input: unknown;
  }>;
  /** Production def names, in the order the real registry lists them. */
  readonly productionNames: ReadonlyArray<string>;
  /** Shut down every resource the production assembly started. */
  readonly dispose: () => Promise<void>;
}

/**
 * The REAL production toolset, assembled here in the reopen process, with EVERY
 * def wrapped before registration, behind the REAL registry and the REAL base
 * executor.
 *
 * Why the whole surface and not one hand-picked def: a probe that wraps only
 * `read_file` is blind to every other tool the host could dispatch, and this
 * criterion is about ALL of them. The production registry is built by calling
 * `createDefaultAciRegistry` — the very factory `buildHarnessEngine` calls — with
 * production-shaped options whose roots are this host's own temp session pool, so
 * a dispatch through this surface really runs these handlers.
 *
 * WHY this chokepoint works where a module patch could not: an ESM named
 * import binds the *binding*, not an object's properties, so `def.handler(...)`
 * resolves `.handler` off the def at CALL time. `createRegistry` stores
 * `Object.freeze({ ...def })` — a frozen shallow copy carrying whatever
 * `handler` the spread read — and the base executor invokes
 * `validation.def.handler(call.input, ctx)`. A wrapper installed BEFORE
 * registration is therefore the function the real executor really calls.
 * Installed AFTER registration it is not: the registry's copy is already frozen
 * (the assignment throws), which is why the order is load-bearing.
 */
async function buildProbedProductionSurface(
  store: SessionStore
): Promise<ProbedToolSurface> {
  const workspaceRoot = input.workspaceRoot;
  const projectDir = store.getProjectDir();
  // Every tool root lives under the host's own temp project dir, never the repo
  // `data/` and never a real user pool.
  const subagentsDir = join(projectDir, "subagents");
  const tasksDir = join(projectDir, "tasks");
  const todoDir = join(projectDir, "todos");
  const memoryDir = join(projectDir, "memory");
  const traceDir = join(projectDir, "trace");
  const tmpDir = join(projectDir, "fence-tmp");
  for (const dir of [
    subagentsDir,
    tasksDir,
    todoDir,
    memoryDir,
    traceDir,
    tmpDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  const subagentManager = createSubAgentManager({
    spawn: createDefaultSubAgentSpawn(),
    subagentsDir,
    sandboxRoot: workspaceRoot,
  });
  const backgroundManager = createBackgroundTaskManager({
    tasksDir,
    spawn: defaultBackgroundSpawn,
  });
  const mcpManager = createMcpManager({
    config: [],
    workspaceRoot,
    // An empty MCP config means this registration hook is never invoked; the
    // manager is the real one, and the defs reading it are production shapes.
    registerExternal: () => {},
  });
  const production = createDefaultAciRegistry({
    // The model-facing web SSOT, as the engine passes it.
    env: { web: { searchUrl: undefined, proxy: undefined } },
    sandboxRoot: workspaceRoot,
    workspaceRoot,
    memoryDir,
    // An explicit empty catalog + a temp `home` keeps the agent catalog off the
    // operator's real `~/.iknow`; the def shape is the production one either way.
    skillCatalog: createSkillCatalog([]),
    agentCatalog: createMergedCatalogResolver({
      home: projectDir,
      pluginAgentDirs: [],
      pluginNames: [],
    }),
    subagentManager,
    mcpManager,
    backgroundManager,
    graphAssembly: { enabled: () => true },
    liveGraphLedger: createLiveGraphLedgerHost(),
    todoDir,
    sessionRootDir: projectDir,
    tmpDir,
    lspCtx: { directory: workspaceRoot },
    traceDir,
    // No def assembled above opens an editor, so this sink is never called; the
    // engine wires the same shape, and nothing here is standing in for one.
    onEdit: () => {},
  });
  const defs = production.inner.list();
  const hits: string[] = [];
  const observed: unknown[] = [];
  // Per-dispatch record: the handler's ctx carries the Anthropic `tool_use_id`
  // of the call that reached it (types.ts `ToolExecutionContext.toolUseId`),
  // so a dispatch can be attributed to the exact call that caused it — which is
  // what makes "the restored block was never dispatched" an observation about a
  // specific call rather than a count.
  const dispatches: Array<{
    readonly name: string;
    readonly toolUseId: string | undefined;
    readonly input: unknown;
  }> = [];
  const wrapped: ToolDef[] = defs.map((def) => ({
    ...def,
    handler: (toolInput, ctx) => {
      hits.push(`handler:${def.name}`);
      observed.push(toolInput);
      dispatches.push({
        name: def.name,
        toolUseId: ctx?.toolUseId,
        input: toolInput,
      });
      return def.handler(toolInput, ctx);
    },
  }));
  // Invariant, enforced HERE and not only in the test: a probe that wrapped
  // fewer defs than production assembles would report its zero for free.
  if (wrapped.length !== defs.length) {
    throw new Error(
      `probe wrapped ${wrapped.length} of ${defs.length} production defs`
    );
  }
  if (wrapped.length < MIN_WRAPPED_PRODUCTION_DEFS) {
    throw new Error(
      `probe wrapped only ${wrapped.length} production defs; the floor is ${MIN_WRAPPED_PRODUCTION_DEFS}`
    );
  }
  const registry = createRegistry(wrapped);
  return {
    registry,
    // The production dispatch STACK, not just the production toolset: production
    // wires `createAciExecutor` over `createExecutor` over the registry
    // (src/harness/build-engine.ts), so the arm runs the same permission
    // middleware the product runs instead of reaching handlers through a
    // side door. `createDynamicExecutorRegistry` and `withLazyLspWarmup` are
    // deliberately not wired: the first re-resolves MCP-backed defs and the
    // second arms language servers lazily on first LSP tool-name resolution —
    // neither changes which handler body runs for a call that got this far.
    executor: createAciExecutor({
      inner: createExecutor(registry),
      catalog: production.catalog,
    }),
    hits,
    observed,
    dispatches,
    productionNames: defs.map((def) => def.name),
    dispose: async () => {
      // Nothing above spawns at assembly time, but the managers own real process
      // groups and an MCP client each: shut them down so a probed arm leaves no
      // stray child and nothing bound.
      await subagentManager.shutdown();
      await backgroundManager.shutdown();
      await mcpManager.shutdown();
    },
  };
}

/** The model-facing text of a settled tool result. */
function payloadText(result: ToolExecutionResult | undefined): string {
  if (result?.kind !== "ok") return "";
  return result.payload
    .map((block) => (block.type === "text" ? block.text : `[${block.type}]`))
    .join("");
}

/** Write the control's real target file and return its path. */
async function writeProbeTarget(
  root: string,
  name = PROBE_FILE
): Promise<string> {
  const target = join(root, name);
  await writeFile(target, `${PROBE_SENTINEL}\n`, "utf8");
  return target;
}

/**
 * Arm the tool-dispatch probe and prove it can fire, IN THIS PROCESS, before
 * anything under test runs.
 *
 * The control is a real production `read_file` really reading a real file
 * through the probed full-surface registry and the real executor, and it asserts
 * the handler's own output came back with the sentinel in it — so a non-zero hit
 * means the real handler BODY ran, not merely that a call was routed. A probe
 * that cannot fire is worse than no probe: it turns "unobserved" into "observed
 * as absent". Hence the control, and hence `armed`.
 *
 * The surface is RETURNED, not disposed: it stays live for the whole arm, so the
 * zero is read on the same registry and executor the replay leg dispatches
 * through.
 */
async function armProductionToolProbe(store: SessionStore): Promise<{
  readonly result: ToolProbeResult;
  readonly surface: ProbedToolSurface;
}> {
  const surface = await buildProbedProductionSurface(store);
  const target = await writeProbeTarget(input.workspaceRoot);
  const [result] = await surface.executor.executeAll([
    { id: "tool-probe-control", name: PROBE_TOOL, input: { path: target } },
  ]);
  const reached = surface.hits.length > 0;
  const readBack = payloadText(result).includes(PROBE_SENTINEL);
  const armed = reached && readBack;
  const controls = [
    `handler=${reached ? "fired" : "MISSED"}`,
    `realRead=${readBack ? "fired" : "MISSED"}`,
    `surface=${surface.productionNames.length} defs wrapped`,
  ];
  // The control leaves the measurement window entirely: the counter the reopen is
  // judged on is the same array the wrapper writes to, and so are the input and
  // dispatch logs — an `observed[0]` that is the control's own read would make a
  // provenance comparison pass for the wrong reason, and a dispatch record naming
  // `tool-probe-control` would make the negative count a dispatch the test caused
  // rather than one the product caused.
  surface.hits.length = 0;
  surface.observed.length = 0;
  surface.dispatches.length = 0;
  return {
    surface,
    result: {
      armed,
      controls,
      hits: surface.hits,
      // Read back from the PROBED registry, not echoed from production: these are
      // the defs a dispatch through this surface really finds.
      wrapped: surface.registry.list().map((def) => def.name),
      productionCount: surface.productionNames.length,
      wrappedCount: surface.registry.list().length,
      minDefs: MIN_WRAPPED_PRODUCTION_DEFS,
    },
  };
}

// -- dispatch ------------------------------------------------------------------

const ARMS: Readonly<Record<CrashRoleRequest["role"], () => Promise<unknown>>> =
  {
    publish: publishArm,
    chat_turn: chatTurnArm,
    graph_host: graphHostArm,
    reopen_chat: reopenChatArm,
    reopen_graph: reopenGraphArm,
  };

// `chat_turn` with a scripted `toolUse` is the tool-dispatch Prove-It arm: the
// same real host, run to completion instead of to a crash point.
const arm =
  input.role === "chat_turn" && input.toolUse !== undefined
    ? chatTurnToolArm
    : ARMS[input.role];
if (arm === undefined) throw new Error(`unknown role ${String(input.role)}`);
try {
  await arm();
} catch (err) {
  // The store rejects with typed plain objects, not Errors, so a child's
  // failure must serialize the value rather than stringify it to
  // "[object Object]" — the parent reports this text on a failed crash point.
  const text =
    err instanceof Error
      ? (err.stack ?? err.message)
      : JSON.stringify(err, null, 2);
  writeSync(2, `CRASH-HOST-FAILED ${text}\n`);
  process.exit(1);
}
process.exit(0);
