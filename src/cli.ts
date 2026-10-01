#!/usr/bin/env node
/**
 * CLI entry:
 *   iknow                         → chat (TTY) / usage (pipe)
 *   iknow chat [options]
 *   iknow serve [options]         → HTTP session API + web UI
 *   iknow tui [session-id]        → terminal multi-session interactive UI
 *   iknow ask "<query>" [options] → one-shot JSON
 *   iknow "<query>" [options]     → one-shot JSON
 */
import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParsedCli } from "./cli/parse-args.js";
import { runChatSession } from "./cli/chat-session.js";
// Subagent worker headless re-entry: the child process returns early from main dispatch.
import {
  renderWorkerError,
  runEscapeEnvelope,
  runSubagentWorker,
  WORKER_EXIT_ENVELOPE_PROTOCOL,
  WORKER_EXIT_RUN_PHASE,
} from "./harness/subagent/worker.js";
import {
  storeWorkerPreimageCapture,
  storeWorkerTranscriptIo,
} from "./cli/worker-transcript.js";
import { shutdownDefaultLspPool } from "./harness/lsp/client.js";
import { securityReviewRouteFromAsk } from "./harness/build-engine.js";
import {
  buildHarnessEngine,
  prepareRuntime,
  registerShutdown,
  type RuntimeBundle,
} from "./cli/runtime.js";
import { isInteractive, writeErr } from "./cli/session-io.js";
import {
  getVersion,
  printUsage,
  tuiNodeInterceptMessage,
} from "./cli/usage.js";
import { formatRunJson } from "./cli/format.js";
import {
  run as runHarness,
  createJsonlTraceService,
  safeTrace,
  type LoopEngineDeps,
} from "./harness/index.js";
import { violationRecordFromReason } from "./harness/trace/violation-record.js";
import {
  createTtyAskUser,
  createFailClosedAskUser,
  createServeAskUser,
  createPermissionModeContext,
  parsePermissionMode,
} from "./harness/permission/index.js";
import type {
  PermissionMode,
  PermissionModeContext,
} from "./harness/permission/modes.js";
import {
  createGraphModeContext,
  resolveGraphMode,
} from "./harness/graph/mode.js";
import { createLiveGraphLedgerHost } from "./harness/graph/ledger.js";
import { createFsModeContext } from "./harness/sandbox/fs-mode.js";
import type { FsModeContext } from "./harness/sandbox/fs-mode.js";
import type { YoloContext } from "./harness/sandbox/yolo.js";
// ADR-0130 eval state: the headless, named entry to the same runtime posture
// `--yolo` reaches through the TUI (fence retired, permission full_auto, fs tier
// global). The entry notice and the published state label are this module's SSOT.
import {
  enterEvalState,
  EVAL_STATE_NOTICE,
  EVAL_STATE_RUN_LABEL,
  type EvalStateRunLabel,
} from "./harness/sandbox/eval-state.js";
import { isIknowError } from "./shared/errors.js";
import {
  isWorkspaceRootError,
  renderWorkspaceRootError,
  WORKSPACE_ROOT_ENV_KEY,
  resolveWorkspaceRoot,
} from "./config/workspace-root.js";
export { isWorkspaceRootError, renderWorkspaceRootError };
// ADR-0093: provider matched but apiKeyEnv unset → `loadIknowEnv` throws a
// plain object. Same shape as WorkspaceRootError above: it needs a discriminated
// guard + typed rendering, since `String(err)` would print `[object Object]`
// (providerId / env name both invisible). The output-budget error
// (`LlmBudgetConfigError`, thrown by the settings parser and the env loader) is
// dispatched the same way.
import {
  formatLlmProviderConfigError,
  isLlmProviderConfigError,
  type LlmProviderConfigError,
} from "./config/env.js";
import { MaxTurnsExceeded, ProtocolError } from "./harness/errors.js";
import { maxTurnsEnvelope } from "./cli/max-turns.js";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { buildViolationWiring } from "./harness/sandbox/violation-executor.js";
import { openBrowser } from "./cli/open-browser.js";
import type { TraceServeOptions } from "./traceserver/serve.js";
import {
  loadIknowSettings,
  analyzePlaceholderSyntax,
  resolveFsIsolationMode,
  formatLlmBudgetConfigError,
  isLlmBudgetConfigError,
  type LlmBudgetConfigError,
} from "./config/settings.js";
// ADR-0037: the chat entry's worktree isolation host seam, and settings pinned at startup.
import { SessionStore } from "./session-api/store/index.js";
import {
  resolveProjectSessionDir,
  resolveSubagentTraceDir,
} from "./session-api/store/index.js";
import { resolveServeDataDir } from "./session-api/serve.js";
import { createTaskWorktreeProvisioner } from "./session-api/worktree-rebind.js";
import type { WorktreeIsolationHostOpts } from "./harness/isolation/worktree-gate.js";
import { createWorktreeIsolationHost } from "./cli/worktree-host.js";
import { deriveProjectIdentityRoot } from "./harness/session-roots.js";
import { resolveTasksDir } from "./harness/background/paths.js";
import { MEMORY_DIR_NAME } from "./shared/session-tree-names.js";
// Shared assembly (used by the cli / serve / tui entries, SSOT): settings.verify → VerifyConfig.
import { resolveVerifyConfig } from "./config/verify-config.js";
import { resolveTraceRoot } from "./cli/trace-root.js";
// ADR-0090: project permissions.defaultMode startup seed — the chat entry reads it from the
// project identity root, default undefined. fail-loud cases (legacy / full_auto) rethrow
// as-is so the startup error path renders them.
import { readProjectDefaultMode } from "./harness/permission/project-settings.js";

/**
 * WorkspaceRootError type guard — the resolver throws a plain object
 * (`satisfies WorkspaceRootError`, not an Error instance), so it must be
 * recognized by the discriminated `kind` field, not via
 * `instanceof Error ? err.message : String(err)` (stringifying a plain object
 * yields `[object Object]`, hiding kind/path). The real definition lives in
 * `./config/workspace-root.ts`; this re-export keeps the CLI public API stable.
 */

/**
 * One-line envelope per LLM config typed error: `error` names the family,
 * `code` carries the discriminated `kind`, and the remaining fields are that
 * kind's own payload (never a value-free `String(err)`).
 */
function llmProviderErrorPayload(
  err: LlmProviderConfigError
): Record<string, unknown> {
  return err.kind === "provider_model_not_registered"
    ? {
        error: "llm_provider_model_not_registered",
        code: err.kind,
        model: err.model,
        message: formatLlmProviderConfigError(err),
      }
    : {
        error: "llm_provider_api_key_missing",
        code: err.kind,
        provider: err.providerId,
        apiKeyEnv: err.apiKeyEnv,
        message: formatLlmProviderConfigError(err),
      };
}

function llmBudgetErrorPayload(
  err: LlmBudgetConfigError
): Record<string, unknown> {
  return err.kind === "legacy_max_output_tokens_env"
    ? {
        error: "llm_budget_config",
        code: err.kind,
        varName: err.varName,
        value: err.value,
        message: formatLlmBudgetConfigError(err),
      }
    : {
        error: "llm_budget_config",
        code: err.kind,
        provider: err.providerId,
        model: err.modelId,
        field: err.field,
        value: err.value,
        message: formatLlmBudgetConfigError(err),
      };
}

function printCliError(err: unknown): void {
  if (isWorkspaceRootError(err)) {
    writeErr(
      JSON.stringify({
        error: "workspace_root",
        code: err.kind,
        message: renderWorkspaceRootError(err),
      })
    );
    return;
  }
  if (isLlmProviderConfigError(err)) {
    writeErr(JSON.stringify(llmProviderErrorPayload(err)));
    return;
  }
  if (isLlmBudgetConfigError(err)) {
    writeErr(JSON.stringify(llmBudgetErrorPayload(err)));
    return;
  }
  if (isIknowError(err)) {
    writeErr(
      JSON.stringify({
        error: err.code.toLowerCase(),
        name: err.name,
        message: err.message,
        details: err.details,
      })
    );
    return;
  }
  if (err instanceof Error) {
    writeErr(
      JSON.stringify({
        error: "error",
        message: err.message,
      })
    );
    return;
  }
  writeErr(
    JSON.stringify({
      error: "error",
      message: String(err),
    })
  );
}

function printChatError(err: unknown): void {
  if (isWorkspaceRootError(err)) {
    writeErr(`错误 ${renderWorkspaceRootError(err)}`);
    return;
  }
  if (isLlmProviderConfigError(err)) {
    writeErr(`错误 [${err.kind}]: ${formatLlmProviderConfigError(err)}`);
    return;
  }
  if (isLlmBudgetConfigError(err)) {
    writeErr(`错误 [${err.kind}]: ${formatLlmBudgetConfigError(err)}`);
    return;
  }
  if (isIknowError(err)) {
    writeErr(`错误 [${err.code}]: ${err.message}`);
    return;
  }
  if (err instanceof Error) {
    writeErr(`错误: ${err.message}`);
    return;
  }
  writeErr(`错误: ${String(err)}`);
}

/**
 * Everything one eval-state invocation contributes to its consumer, in ONE
 * object: the two `buildHarnessEngine` assembly fields (fence-retire holder +
 * the fs tier the enter combination landed on) and the ADR-0130 §5 published
 * state label. All three come from the same entry decision, so they travel
 * together and the consumer never re-derives "is this an eval run?".
 *
 * One object rather than three because the alternative — a holder plus two
 * `...(evalHolders ? … : {})` spreads — puts the same predicate at two call
 * sites inside `runOneShot`, a function already carrying pre-logged length
 * debt. The consumers are object-literal targets with declared key sets, and
 * they read only their own keys, so spreading the whole projection is inert for
 * the ones that do not take all three (`formatRunJson` reads `opts.runState`;
 * `buildHarnessEngine` reads `opts.yolo` / `opts.fsMode`).
 */
interface EvalStateProjection {
  readonly yolo: YoloContext;
  readonly fsMode: FsModeContext;
  /** ADR-0130 §5: the state a number produced here must be published under. */
  readonly runState: EvalStateRunLabel;
}

/**
 * Spread-guard helper, the same shape as `yoloHolderSpread`
 * (`src/harness/sandbox/yolo.ts`): it moves the "emit the keys only when the
 * posture was entered" branch out of the hosting function, so
 * `lint:s5:staged` sees a branch-free call site instead of one more ternary in
 * `runOneShot`.
 *
 * Semantics are byte-identical to the inline
 * `...(projection !== undefined ? projection : {})`.
 */
function evalStateSpread(
  projection: EvalStateProjection | undefined
): Partial<EvalStateProjection> {
  return projection !== undefined ? projection : {};
}

/**
 * ADR-0130 eval state at the ask entry: `--eval-state` → the yolo-shaped holders,
 * anything else → `undefined`, so the call site keeps the fenced baseline.
 */
function enterEvalStateForAsk(
  parsed: ParsedCli,
  permission: PermissionModeContext
): EvalStateProjection | undefined {
  if (parsed.evalState !== true) {
    return undefined;
  }
  const holders = enterEvalState({
    permission,
    // Seeded from settings like every other entry (runChat / tui), so the
    // workspace → global flip yolo's enter combination performs is the real one
    // rather than a no-op on a holder nobody seeded.
    fsMode: createFsModeContext(resolveFsIsolationMode(loadIknowSettings())),
  });
  writeErr(EVAL_STATE_NOTICE);
  // ONE projection for the whole posture: the two assembly fields and the
  // published state label are the three keys the entry contributes, and they
  // come from one decision, so they are assembled together here rather than
  // re-asked at two call sites (which is what grew `runOneShot` past its S5
  // baseline — see `evalStateSpread` for the spread-guard rationale).
  return {
    yolo: holders.yolo,
    fsMode: holders.fsMode,
    runState: EVAL_STATE_RUN_LABEL,
  };
}

async function runOneShot(parsed: ParsedCli): Promise<void> {
  if (parsed.missingQuery) {
    printUsage();
    process.exitCode = 1;
    return;
  }
  const bundle: RuntimeBundle = await prepareRuntime();
  // Writer-side data root, single source: the ask entry's store pool =
  // `resolveServeDataDir(parsed.dataDir)` (independent of workspaceRoot); the
  // reader-side default root follows the same pool. ADR-0087: explicit
  // `--data-dir` is passed through — `--data-dir <alt>` opens an isolated
  // pool, and trace / any future store paths resolve under `<alt>` too.
  const dataDir = resolveServeDataDir(parsed.dataDir);
  const tracePath = resolveTraceRoot(parsed.traceOut, dataDir);

  // The ask entry reads the static mode from env IKNOW_PERMISSION_MODE; oneshot
  // exposes no switching (the context is never set, equivalent to static).
  const permissionMode = createPermissionModeContext(
    (process.env.IKNOW_PERMISSION_MODE as PermissionMode | undefined) ??
      "default"
  );
  // ADR-0130: eval state flips this same holder and hands back the fence-retire
  // holder; undefined when the flag was not asked for (the entry then keeps
  // today's fenced shape).
  const evalState = enterEvalStateForAsk(parsed, permissionMode);

  // ADR-0132 / spec SC4: the session scratch this one-shot run owns. The ask
  // route is non-interactive and single-run, so the identity is a plain value
  // rather than serve's coarse live reader — the same shape chat pins for its
  // whole REPL. Resolved through the same `(dataDir, projectIdentityRoot)`
  // formula every other entry uses, so this run's `$TMPDIR` is the production
  // session pad and not a private guess.
  const conversationId = randomUUID();
  const todoProjectDir = resolveProjectSessionDir(
    dataDir,
    deriveProjectIdentityRoot({ cwd: process.cwd() })
  );

  let built: { deps: LoopEngineDeps };
  try {
    // ask oneshot: no interactive user → fail-closed askUser (always deny).
    // The ask surface skips the BOOTSTRAP section (surface="ask" → bootstrapActive=false).
    // Ask explicitly sets memory:{enabled:false}: the registry strips the 8 memory
    // tools and the memory_layer section is not assembled; the other 4 identity
    // sections stay as-is (deps.system still wires createIknowSystemResolver).
    // ADR-0019: the `--workspace-root` flag is passed through — ask is also a
    // per-root state consumer.
    built = await buildHarnessEngine(bundle, {
      askUser: createFailClosedAskUser(),
      surface: "ask",
      memory: { enabled: false },
      permissionMode,
      // ADR-0130 eval state → the same two assembly fields yolo uses: `yolo`
      // retires the fence on all four routes (ADR-0119 §ruling 2), `fsMode`
      // carries the global tier the enter combination landed on. Emitted only
      // when the flag was asked for: a non-eval ask keeps the absent-holder V1
      // baseline (no tier holder → global at the factory, no yolo holder → the
      // fence stays up), byte-identical to before this entry existed.
      ...evalStateSpread(evalState),
      // Gate on `!== undefined`, not truthiness — an empty string must reach
      // buildHarnessEngine explicitly to trigger the resolver's empty_explicit.
      // A truthy gate would swallow `""` as "unset", and the CLI would show a
      // silent cwd fallback instead of the typed error — not what was promised.
      ...(parsed.workspaceRoot !== undefined
        ? { workspaceRoot: parsed.workspaceRoot }
        : {}),
      // ADR-0132: the two seams the identity-scratch cleanup exception reads.
      // `todoDir` is the session project dir the scratch hangs under and
      // `sessionConversationId` is this run's own id; together they are what
      // turns the main-session scratch arm on for `ask`. Absent either one,
      // the arm stays off and every destructive-rm verdict is unchanged — the
      // fail-toward-deny direction this entry shipped with.
      todoDir: todoProjectDir,
      sessionConversationId: () => conversationId,
      // ADR-0132: the scratch anchor, named for what it is rather than reusing
      // `todoDir` above. The line above is withheld by ADR-0028's ask gate, and
      // the Bash handler must still reach this run's session pad — the two
      // ADR-0132 gates are only in agreement when both are handed the anchor.
      sessionRootDir: todoProjectDir,
      subagentDiagnosticsDir: resolve(tracePath),
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("LLM mode needs")) {
      // The ask error envelope no longer carries an env-var name (the apiKeyEnv
      // field was retired); instead `apiKey` holds the raw settings.llm.apiKey
      // shape (None or a placeholder string like "${ANTHROPIC_AUTH_TOKEN}") so
      // callers can be told why. `apiKey_placeholder` lets consumers tell that
      // `apiKey: "${VAR}"` is a placeholder, not a real value
      // (true=placeholder / false=literal / omitted when undefined).
      const rawApiKey = loadIknowSettings().llm?.apiKey;
      const apiKeyIsPlaceholder =
        rawApiKey !== undefined &&
        analyzePlaceholderSyntax(rawApiKey.trim()).placeholders.length > 0;
      writeErr(
        JSON.stringify({
          error: "llm_mode_missing_api_key",
          message: err.message,
          apiKey: rawApiKey === undefined ? "None" : rawApiKey,
          ...(rawApiKey !== undefined
            ? { apiKey_placeholder: apiKeyIsPlaceholder }
            : {}),
        })
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  // ask path: each invocation gets its own conversation_id (ADR-0003) — the
  // same id the assembly above named as this run's cleanup identity, so the
  // trace anchor and the scratch the wall judges are one identity rather than
  // two independently minted values.
  const traceService = createJsonlTraceService({
    filePath: tracePath,
    conversationId,
  });
  // T6: wrap the executor with the violation kill-session hook so the ask
  // entry point surfaces violation escalations on stderr + exits with code 1.
  //
  // ADR-0135 / SC12: the same interruption is also written to the trace the
  // run already owns, through the same shared JSONL service the turn and tool
  // rows use. Before this, `ask` printed the operator notice and exited 1 but
  // left no `violation` row behind, so a retained trial trajectory could not
  // show why the run stopped — the exact gap the pilot report names. The write
  // is best-effort: an unwritable trace must not turn an already-failing run
  // into a different failure.
  const { executor } = buildViolationWiring(built.deps.executor, {
    onInterrupt: (reason: string) => {
      const record = violationRecordFromReason(
        reason,
        new Date().toISOString()
      );
      if (record === undefined) return;
      void safeTrace(() => traceService.recordViolation(record));
    },
  });
  // The `--max-turns` flag wins; otherwise fall back to the assembly-layer env
  // value (undefined = unlimited). agentVersion is injected CLI-side from
  // getVersion() so the session L1 root record lands at the end of the run.
  // The Loop Engine must not import cli/usage.ts — inject instead of importing
  // at the harness layer, to avoid a writer-side ← cli reverse dependency.
  const askDeps: LoopEngineDeps = {
    ...built.deps,
    executor,
    trace: traceService,
    agentVersion: getVersion(),
    maxTurns: parsed.maxTurns ?? built.deps.maxTurns,
    // ADR-0132: this run's own id, into the per-call tool context. The scratch
    // pad is named `<sessionRootDir>/<conversationId>/fence-tmp`, and the Bash
    // handler resolves that half from the call context — so handing it the
    // `sessionRootDir` alone still left the two ADR-0132 gates naming different
    // directories (the handler fell back to its own `mkdtemp` pad). Same value
    // the trace above is stamped with, so one run has one identity.
    //
    // Absent → every other `ctx.conversationId` consumer (worktree tools,
    // bash_output / bash_stop scoping) reads it as "no filtering", which on
    // this surface is the pre-existing state: the ask entry assembles neither
    // the worktree tools nor the background manager that consume it.
    conversationId,
  };
  let stopSummary: string | undefined;
  const onStream = (
    event: import("./harness/index.js").HarnessStreamEvent
  ): void => {
    if (event.type === "stop_summary") stopSummary = event.text;
  };
  // runHarness returns LoopTrace as `trace`; rename to loopTrace to avoid
  // shadowing the TraceService injected into deps.
  let result: import("./harness/index.js").RunResult;
  let loopTrace: import("./harness/index.js").LoopTrace;
  try {
    const out = await runHarness(parsed.query, askDeps, undefined, {
      onStream,
    });
    result = out.result;
    loopTrace = out.trace;
  } catch (err) {
    if (err instanceof MaxTurnsExceeded) {
      // ADR-0011: maxTurns exceeded → JSON envelope on stderr + exitCode=1.
      // stopSummary is captured by the onStream wrapper above (loop-engine
      // emits stop_summary before rethrowing; the summary turn is not counted
      // toward maxTurns).
      writeErr(maxTurnsEnvelope(err, stopSummary));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  // ADR-0130 §5: a number produced in eval state must name that state in the
  // same artifact. A non-eval run passes nothing → the key is dropped, so the
  // published ask / oneshot JSON keeps its exact key set.
  process.stdout.write(
    `${formatRunJson({
      result,
      trace: loopTrace,
      ...evalStateSpread(evalState),
    })}\n`
  );
}

async function runChat(parsed: ParsedCli): Promise<void> {
  let bundle: RuntimeBundle;
  try {
    bundle = await prepareRuntime();
  } catch (err) {
    printChatError(err);
    process.exitCode = 1;
    return;
  }
  let workspaceRoot: string;
  try {
    workspaceRoot = resolveWorkspaceRoot({
      explicit: parsed.workspaceRoot,
      cwd: process.cwd(),
      env: { [WORKSPACE_ROOT_ENV_KEY]: bundle.env.workspaceRoot },
    });
  } catch (err) {
    printChatError(err);
    process.exitCode = 1;
    return;
  }
  // ADR-0071: the chat entry pins this conversationId — the subagent
  // lifecycle / content trace directory = `<parent conversation folder>/subagents/`,
  // file name = agent-<taskId>.jsonl. rebuildDeps (on rebind) reuses the same
  // conversationId instead of minting a new one (a rebuild is not a new session).
  //
  // With --resume <id>, conversationId = resumeId rather than a random UUID —
  // subagent directories, checkpoint files and trace anchors must all bind to
  // the resumed session's folder; otherwise a resumed run's subagent directory
  // lands under a fresh random UUID folder, detached from the parent session,
  // and the per-agent file set would scatter across two sessions.
  const conversationId = parsed.resumeId ?? randomUUID();

  // ADR-0035: lifecycle trace and content trace are decoupled. chat does not
  // assemble a content trace, but subagent spawn/state_change/stop records are
  // permanently written to the default trace directory. Per ADR-0071, the
  // aggregated single file `subagent.jsonl` (conversationId:"subagent") is
  // retired — buildHarnessEngine(opts.subagentsDir) now derives per-agent
  // `<parent conversation folder>/subagents/agent-<taskId>.jsonl`.
  // The resolution order (traceOut flag > IKNOW_TRACE_OUT env > default) stays
  // and serves the remaining subagent-related shapes (the stderr pointer fallback).
  // The default shares the chat writer-side data root (chat-session.ts's store
  // pool = `resolveServeDataDir(parsed.dataDir)`, independent of workspaceRoot;
  // the workspaceRoot variable only feeds identity derivation).
  // Per ADR-0087, an explicit `--data-dir` passes through to trace / store /
  // checkpointStore, parsed the same way as in runServe — "explicit dataDir =
  // isolated pool" applies to chat too (otherwise `--data-dir <alt>` would
  // silently write into `~/.iknow`).
  const dataDir = resolveServeDataDir(parsed.dataDir);
  const tracePath = resolve(resolveTraceRoot(parsed.traceOut, dataDir));

  let built: import("./harness/build-engine.js").BuiltEngine;
  // Settings are read exactly once at the startup load point; the same object
  // drives graph / verify assembly and engine build — rebind's per-root rebuild
  // reuses it, and a missing `.iknow/` inside the worktree (gitignored) must
  // never trigger an implicit settings reload.
  const startupSettings = loadIknowSettings();
  // ADR-0090: the chat REPL holds one mutable PermissionModeContext —
  // the /permissions command flips it in place without rebuilding the engine.
  // Startup precedence: CLI flag (tui only) > env IKNOW_PERMISSION_MODE >
  // project permissions.defaultMode > "default". Project settings read from
  // projectIdentityRoot (not cwd): after a rebind the cwd is a bare task
  // worktree without `.iknow`, while the project contract lives on the identity root.
  // fail-loud cases (legacy shape / full_auto) rethrow to the startup error path.
  const projectDefaultMode = readProjectDefaultMode({
    cwd: deriveProjectIdentityRoot({ cwd: workspaceRoot }),
  });
  const permissionMode = createPermissionModeContext(
    parsePermissionMode(process.env.IKNOW_PERMISSION_MODE) ??
      projectDefaultMode ??
      "default"
  );
  const graphMode = createGraphModeContext(
    resolveGraphMode({ settings: startupSettings.graph })
  );
  // ADR-0092: filesystem isolation mode holder — initial value from settings
  // (default global), flipped in place by chat REPL's `/config`. Same shape as
  // graphMode: the engine (build-engine via opts.fsMode, bash factory reads
  // per-call) and the REPL host share one instance (same holder across all
  // three entries). Orthogonal to permissionMode.
  const fsMode = createFsModeContext(resolveFsIsolationMode(startupSettings));
  // Live-graph ledger host — single session, same lifetime as the chat REPL
  // (destroyed on reset / process exit). The CLI does not need per-conversationId
  // distinction but keeps the same host shape (unified build-engine wiring, no
  // type fork).
  const liveGraphLedger = createLiveGraphLedgerHost();
  // Worktree isolation host seam — provision creates the task worktree and
  // rebinds only this session's root (session-api worktree-rebind SSOT).
  // The store shares the pool with chat-session's checkpointStore (per
  // ADR-0087: `dataDir` = `resolveServeDataDir(parsed.dataDir)`, landing in
  // `<alt>` when `--data-dir` is explicit). The switch is read at the
  // build-engine startup load point (via startupSettings); OFF → no wrapping.
  const worktreeProvisioner = createTaskWorktreeProvisioner({
    store: new SessionStore(
      dataDir,
      // The store namespace keys by projectIdentityRoot, not cwd
      // (mirrors build-engine.ts).
      deriveProjectIdentityRoot({ cwd: workspaceRoot })
    ),
  });
  // Factory assembly from worktree-host.ts (name pass-through fix point; unit-testable).
  const worktreeIsolation: WorktreeIsolationHostOpts =
    createWorktreeIsolationHost({ worktreeProvisioner });
  // The workspace at startup is the stable productRoot — rebind only swaps
  // workspaceRoot; the MCP project-config root keeps this value across rebuilds.
  const productRoot = workspaceRoot;
  // The chat entry injects the "session project directory" as todoDir — the
  // same `(dataDir, deriveProjectIdentityRoot(...))` pair as the SessionStore
  // above, so one conversation resolves to the same projectDir across the chat /
  // serve / TUI entries (the `<surface>` split is eliminated). Per-conversationId
  // file paths derive at call time via todo-write.ts:resolveConversationTodoPath.
  // `dataDir` already includes an explicit `--data-dir` (see tracePath above).
  const todoProjectDir = resolveProjectSessionDir(
    dataDir,
    deriveProjectIdentityRoot({ cwd: workspaceRoot })
  );
  // ADR-0088: background-task registration follows the **same** project tree at
  // `(dataDir, projectIdentityRoot)` — same slug as the session folder, decoupled
  // from workspaceRoot (a throwaway `--workspace-root` no longer opens a second
  // live ledger). rebuild reuses chatEngineOpts, so tasksDir is unchanged after
  // rebind (the registry is not per-root state).
  const tasksDir = resolveTasksDir({
    dataDir,
    projectIdentityRoot: deriveProjectIdentityRoot({ cwd: workspaceRoot }),
  });
  const memoryDir = join(todoProjectDir, MEMORY_DIR_NAME);
  // ADR-0127: the chat entry's ask inlet is a real human path (readline y/N)
  // — the security-review route shares it. The ordinary ask semantics are
  // unchanged; reviews ride the same prompt with the typed-cause hint.
  const chatAskUser = createTtyAskUser();
  // Assembly opts shared by the initial build and rebind rebuilds (same askUser/holders/settings).
  const chatEngineOpts = {
    askUser: chatAskUser,
    securityReview: securityReviewRouteFromAsk(chatAskUser),
    surface: "chat" as const,
    memory: { enabled: true } as const,
    permissionMode,
    graphMode,
    // ADR-0092: fs isolation holder enters engine assembly (bash factory reads per-call).
    fsMode,
    liveGraphLedger,
    todoDir: todoProjectDir,
    // ADR-0132: the identity whose session scratch this engine may clean. A
    // reader for uniformity with the other entries even though chat's value is
    // already fixed — `conversationId` is pinned once for the whole REPL
    // (line above) and reused across every rebind rebuild, so a reader and a
    // plain string name the same pad here. Wrapping it keeps the three
    // entries on one seam shape: a host that later learns a per-turn id has
    // one place to read it from.
    sessionConversationId: () => conversationId,
    // ADR-0132: the same scratch anchor the ask entry passes, on the ungated
    // channel. `todoDir` above already carries this value here, so this line
    // changes no behavior on this surface — it exists so both CLI entries hand
    // the engine the anchor through one named seam instead of relying on
    // `todoDir` happening to be ungated on this particular surface.
    sessionRootDir: todoProjectDir,
    // ADR-0088: registration root follows the session pool, not workspaceRoot.
    tasksDir,
    // ADR-0099: project memory follows the same tree, not workspaceRoot.
    memoryDir,
    // ADR-0071: subagentsDir derives from (projectDir, conversationId) via
    // `resolveSubagentTraceDir` — same source as the SessionStore above
    // (`todoProjectDir === store.projectDir`). build-engine passes subagentsDir
    // to both SubAgentManager (opts.subagentsDir) and the traceFilePath entry in
    // the envelope — replacing the old `subagentTrace` aggregated single file
    // (conversationId:"subagent", retired).
    subagentsDir: resolveSubagentTraceDir({
      projectDir: todoProjectDir,
      conversationId,
    }),
    subagentDiagnosticsDir: tracePath,
    // Gate on `!== undefined` — an empty string passes through to trigger empty_explicit.
    workspaceRoot,
    productRoot,
    // Startup settings object + isolation seam (see notes above).
    settings: startupSettings,
    worktreeIsolation,
  };
  try {
    // chat TTY REPL: interactive y/N prompt via stdin/stdout.
    // chat activates BOOTSTRAP (surface="chat" → bootstrapActive=true) and
    // explicitly sets memory:{enabled:true} — 10 tools + memory_layer assembly.
    // The chat entry injects the session-folder todoDir; per-conversationId
    // resolution lives in todo-write.ts:resolveConversationTodoPath (one SSOT
    // anchor, see todoProjectDir above).
    // ADR-0019: `--workspace-root` passes through to the per-root identity / memory seam.
    built = await buildHarnessEngine(bundle, chatEngineOpts);
  } catch (err) {
    printChatError(err);
    process.exitCode = 1;
    return;
  }

  // The `--max-turns` flag wins; otherwise the assembly-layer env value (undefined = unlimited).
  // The chat path injects agentVersion the same way as ask/serve, so chat session
  // files also produce the session root record.
  const chatDeps: LoopEngineDeps = {
    ...built.deps,
    agentVersion: getVersion(),
    maxTurns: parsed.maxTurns ?? built.deps.maxTurns,
  };
  // The chat REPL is a long-running entry — before SIGINT/SIGTERM it must call
  // built.shutdown (composed handle: mcpManager first → subagentManager second),
  // otherwise the parent dies and subagent child processes never receive
  // SIGTERM cleanup. chat-session's own second SIGINT → process.exit(130) is
  // kept (user force-kill semantics): first signal runs this dispose hook, the
  // second exits directly.
  //
  // Shutdown handle box for the active engine: registerShutdown installs the
  // signal hooks only once, and the closure reads
  // activeEngineShutdown.current; the rebind rebuild switch point
  // (refreshChatDepsForRebind) closes the old engine then writes the rebuilt
  // engine's shutdown into current. Otherwise the rebuilt engine's
  // mcpManager/subagentManager never close (the signal path stays on the
  // initial engine).
  const activeEngineShutdown: { current?: () => Promise<void> } = {
    current: built.shutdown,
  };
  // Chat process exit seam (shared by signals and natural REPL exit): besides
  // engine shutdown it must also terminate the shared LSP pool — language
  // server children spawned by warmup / lsp_* hold stdio pipes open, the event
  // loop never drains, and the process (after EOF) never exits. Engine
  // shutdown does not cover this (it runs mid-rebind too and must not latch
  // the process-level shared pool; see the shutdownDefaultLspPool comment in
  // client.ts).
  const chatProcessShutdown = async (): Promise<void> => {
    await activeEngineShutdown.current?.();
    // Destroy the live-graph ledger at session end. The object would be GC'd
    // with the process anyway; clearing explicitly removes the freeze semantics
    // and leaves no half-alive reference.
    liveGraphLedger.destroyAll();
    await shutdownDefaultLspPool();
  };
  registerShutdown({ shutdown: chatProcessShutdown });
  await runChatSession({
    deps: chatDeps,
    session: bundle.session,
    jsonMode: parsed.json,
    workspaceRoot,
    // Source of truth for the one-time root-section write after rebind: same
    // read point as build-engine's `isolationEnabled` (`startupSettings` read
    // once at startup).
    // OFF → rebind notification keeps the old `writable_main` shape;
    // ON → the post-rebind root is tree-shaped → `writable_tree`, byte-equal to pre-change.
    isolationOn: built.isolationOn ?? false,
    // The gate's live holder singleton — chat REPL's verify fence and the
    // build-engine bash factory read the same instance; absent → key omitted,
    // bytes unchanged.
    ...(built.worktreeOnMutate !== undefined
      ? { worktreeOnMutate: built.worktreeOnMutate }
      : {}),
    // Thinking visibility surface (env flag → chat-session → format-run-human).
    // env.ts is the SSOT; default off.
    showThinking: bundle.env.chat.showThinking,
    // Passed to the REPL host; its /permissions slash command flips the mode in place.
    permissionMode,
    // The same graph holder — Shift+Tab's three-state cycle and /graph both
    // flip it, and build-engine's assembly snapshot reads it too (one holder across entries).
    graphMode,
    // ADR-0092: the same fs holder — chat REPL's /config flips it, and
    // build-engine's bash factory (via chatEngineOpts.fsMode) reads it
    // per-call (one holder across entries).
    fsMode,
    // A snapshot taken before each query line starts running — flipping the key
    // means "effective from the next run()".
    graphAssembly: built.graphAssembly,
    // The ledger host passes to chat-session — parallel to graphMode,
    // destroyed on reset / process exit.
    liveGraphLedger,
    // `--resume <id>` continuation anchor. Only chat consumes it; ask/serve/tui
    // entries do not pass it (parsing is command-agnostic, each host decides).
    // undefined = start a new session.
    resumeId: parsed.resumeId,
    // Single REPL-level conversationId source — computed once at the cli.ts
    // entry (= resumeId when resuming, else random) and passed explicitly;
    // checkpoint / subagent dir / trace anchors all derive from it.
    // runChatSession no longer generates a second one internally.
    conversationId,
    // ADR-0087: `--data-dir` is passed through so chat-session's checkpointStore
    // uses the same pool (otherwise resolveServeDataDir() with zero args silently
    // falls back to ~/.iknow, inconsistent with runServe).
    // `undefined` → default `~/.iknow`, behavior unchanged.
    dataDir: parsed.dataDir,
    // Host drain — before each runHarness round, the chat entry folds completed
    // subagent results into priorMessages. The ask entry has no manager
    // (surface-gated), so it does not pass this.
    subagentManager: built.subagentManager,
    // ADR-0135: the live background-task manager, so a security interruption
    // can cancel the finite background jobs the interrupted turn launched.
    backgroundManager: built.backgroundManager,
    // The loadable-skills surface — CLI, TUI and Web share one slash entry.
    // `/skill-name [remainder]` goes through the skill-load envelope assembly
    // (buildSkillLoadText + createSkillBody, same source as the TUI).
    skillCatalog: built.skillCatalog,
    // The rescan seam that makes the loadable surface "hot in place" — every
    // non-empty slash line rescans the current skill roots, so a just-installed
    // skill enters `/` candidates immediately (no waiting for the next turn).
    // The ask surface does not assemble this seam (`built.skillRescanner` absent).
    ...(built.skillRescanner !== undefined
      ? { skillRescanner: built.skillRescanner }
      : {}),
    // ADR-0031: automatic memory hooks. build-engine only assembles them when
    // `settings.memory.autoExtract === true`; absent (default OFF) → the chat
    // host never calls it, behavior byte-for-byte unchanged.
    autoMemory: built.autoMemory,
    overlayMemoryPrefetch: built.overlayMemoryPrefetch,
    // settings.verify section → closed-loop config. Missing command (including
    // a missing verify section) → { command: "" }; when subagentManager is
    // present (chat), runClassifier takes over as the classifier judge; the
    // ask shape has no manager → verify-loop stays transparently off
    // (backward compatible). Remaining fields pass through verbatim.
    // Same startup-assembly settings object (no re-read of the settings file).
    verifyConfig: resolveVerifyConfig(startupSettings.verify),
    // Active-engine shutdown box — swapped at the rebind switch point by
    // refreshChatDepsForRebind (see the activeEngineShutdown note above).
    engineShutdown: activeEngineShutdown,
    // The per-root engine rebuild seam after rebind — rerun buildHarnessEngine
    // with the same chatEngineOpts + same startup settings, root switched to
    // the task worktree (cwd / workspaceRoot anchors move with the rebind,
    // ADR-0037). productRoot is kept verbatim via chatEngineOpts; only
    // workspaceRoot/cwd change. Returns the full handle bundle (RebuiltChatEngine,
    // matching the TUI buildEngine seam shape) — besides deps, the shutdown /
    // subagentManager / graphAssembly / autoMemory / overlayMemoryPrefetch of
    // the rebuilt engine are rewired into ctx by refresh; returning only deps
    // would strand the rebuilt engine's handles in the seam (split-brain + leak).
    engineRoot: productRoot,
    rebuildDeps: async (root: string) => {
      const rebuilt = await buildHarnessEngine(bundle, {
        ...chatEngineOpts,
        cwd: root,
        workspaceRoot: root,
        productRoot,
      });
      return {
        deps: {
          ...rebuilt.deps,
          agentVersion: getVersion(),
          maxTurns: parsed.maxTurns ?? rebuilt.deps.maxTurns,
        },
        shutdown: rebuilt.shutdown,
        subagentManager: rebuilt.subagentManager,
        graphAssembly: rebuilt.graphAssembly,
        autoMemory: rebuilt.autoMemory,
        overlayMemoryPrefetch: rebuilt.overlayMemoryPrefetch,
        // The slash skill surface swaps with the active engine — after
        // rebinding to the task worktree, skill candidates / bodies read the
        // new root's catalog.
        skillCatalog: rebuilt.skillCatalog,
        // The rescanner swaps **together with** the catalog — replacing only
        // the catalog would serve "hot in place" candidates from the old root's
        // scanner.
        skillRescanner: rebuilt.skillRescanner,
        // ADR-0135: the background-task manager swaps with the active engine
        // too, so an interrupted turn never cancels jobs through a retired
        // manager.
        backgroundManager: rebuilt.backgroundManager,
      };
    },
  });
  // REPL end point (EOF / pipe drained) goes through the same exit seam:
  // engine shutdown + LSP pool termination (same root cause as the TUI /quit
  // hang — the natural-exit path previously had nobody closing it).
  await chatProcessShutdown();
}

/**
 * Subagent worker dispatch (early branch in cli main) — the subagent process
 * re-enters headlessly: stdin envelope → run() → stdout envelope. Earlier than
 * the product-shape dispatch (chat/ask/serve/tui/oneshot); this command is only
 * triggered by the parent agent's child_process.spawn, never called directly
 * by an operator.
 *
 * Exit-code semantics codified (ADR-0111):
 *   - exit 2 = envelope protocol errors **only** — ProtocolError from
 *     parseWorkerEnvelope (stdin JSON failure / missing envelope fields); no
 *     envelope can be written, a dedicated code for protocol-layer crashes;
 *   - run-phase escape (runSubagentWorker already closes it into a failed
 *     envelope + exit 1; this is the process-level last line of defense for the
 *     stdin/stdout seam) → best-effort envelope + exit 1, never borrowing 2;
 *   - module-level main().catch covers all product-shape errors → exit 1,
 *     distinct from the worker's dedicated code.
 */
async function runSubagentWorkerCommand(): Promise<void> {
  try {
    // ADR-0102: worker transcript IO is injected here (the codec belongs to
    // session-api; the harness only sees the narrow interface).
    // ADR-0121: the worker preimage-capture factory likewise lands here
    // (Gate B — the session blob store is session-api, invisible to the
    // harness); the write-tool port it builds is threaded into the worker's
    // registry by runSubagentWorker.
    await runSubagentWorker(
      storeWorkerTranscriptIo,
      storeWorkerPreimageCapture
    );
  } catch (err) {
    if (err instanceof ProtocolError) {
      const msg = err.stack ?? err.message;
      process.stderr.write(`[subagent-worker] fatal: ${msg}\n`);
      process.exit(WORKER_EXIT_ENVELOPE_PROTOCOL);
    }
    // Last line of defense (process-level exceptions outside the envelope protocol): never borrow exit 2.
    process.stderr.write(
      `[subagent-worker] run-phase error: ${renderWorkerError(err)}\n`
    );
    try {
      process.stdout.write(JSON.stringify(runEscapeEnvelope(err)) + "\n");
    } catch {
      // EXIT: stdout already unwritable → no envelope can land; exit 1 as a
      // run-phase escape (ADR-0111: a missing best-effort envelope does not
      // change exit-code semantics).
    }
    process.exit(WORKER_EXIT_RUN_PHASE);
  }
}

/**
 * ADR-0119 ruling 7 / spec yolo-mode EXIT: `--yolo` is reachable only from the
 * TUI entry. When any of the five non-TUI public session commands (chat /
 * serve / ask / oneshot / trace) carries it, parse time has already filled a
 * typed rejection (discriminated union) — here we only read that one value,
 * not re-decide `yolo` at dispatch (single read point, so the two decisions
 * cannot drift). The message is built once in `yolo.ts` (includes the
 * `${kind}: ...` prefix and the command name) and written straight to stderr.
 *
 * Exit code 1, no service / session started, no settings / session file
 * written. The display paths (`-h` / `--help` / `-V` / `--version` and bare
 * `--yolo` → help) already returned before this call — an explicitly declared
 * pass-through (exit 0, no session started). The subagent-worker early arm runs
 * above this call; `__subagent_worker__` is never one of the five non-TUI
 * commands, so it carries no yoloRejection and the ordering is immaterial.
 */
function rejectNonTuiYoloEntry(parsed: ParsedCli): void {
  const rejection = parsed.yoloRejection;
  if (rejection !== undefined) {
    writeErr(rejection.message);
    process.exit(1);
  }
}

/**
 * ADR-0130 §1 / §5: `--eval-state` is refused on every entry but the two headless
 * one-shot faces, and refused outright when combined with `--resume`. The parser
 * has already decided (single read point, same face as the yolo guard above); this
 * only renders it, strictly after `rejectNonTuiYoloEntry` so a request carrying
 * both flags reports the yolo refusal alone.
 *
 * It has to run before any dispatch: `chat --eval-state` must not reach
 * `prepareRuntime`, or the refusal would arrive as a settings error and the
 * session would already have started.
 */
function rejectEvalStateRequest(parsed: ParsedCli): void {
  const rejection = parsed.evalStateRejection;
  if (rejection !== undefined) {
    writeErr(rejection.message);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    argv: process.argv.slice(2),
    interactive: isInteractive(),
  });

  if (parsed.command === "__subagent_worker__") {
    await runSubagentWorkerCommand();
    return;
  }

  if (parsed.versionOnly) {
    process.stdout.write(`${getVersion()}\n`);
    return;
  }

  if (parsed.command === "help") {
    printUsage();
    return;
  }

  rejectNonTuiYoloEntry(parsed);
  rejectEvalStateRequest(parsed);

  if (parsed.command === "chat") {
    await runChat(parsed);
    return;
  }

  if (parsed.command === "serve") {
    await runServe(parsed);
    return;
  }

  if (parsed.command === "trace") {
    await runTrace(parsed);
    return;
  }

  if (parsed.command === "tui") {
    await runTui(parsed);
    return;
  }

  // ask | oneshot
  await runOneShot(parsed);
}

async function runTui(parsed: ParsedCli): Promise<void> {
  // Dynamic import: same lazy path as serve, so chat/ask do not carry the opentui dependency tree.
  // The OpenTUI render entry; runTui returns an exit code (typed errors converge at the single
  // catch point in tui/run.tsx, no try/catch here). Runtime guard: OpenTUI 0.5.1 only works under
  // Bun; Node lacks node:ffi (only Node 26 has it), so tsx+Node running tui inevitably fails FFI.
  if (process.versions.bun === undefined) {
    const cliFile = fileURLToPath(import.meta.url);
    const reexec = await reexecTuiUnderBun(cliFile, process.argv.slice(2));
    if (reexec.kind === "missing") {
      process.stderr.write(tuiNodeInterceptMessage(cliFile));
      process.exitCode = 1;
      return;
    }
    process.exitCode = reexec.code;
    return;
  }
  const { runTui: startTui } = await import("./tui/run.js");
  const exitCode = await startTui({
    sessionId: parsed.sessionId,
    dataDir: parsed.dataDir,
    // ADR-0019: `--workspace-root` passes through to the TUI assembly layer.
    // Gate on `!== undefined` — an empty string passes through to trigger empty_explicit.
    ...(parsed.workspaceRoot !== undefined
      ? { workspaceRoot: parsed.workspaceRoot }
      : {}),
    // traceOut default derivation lives in run.tsx: session pool = explicit
    // `--data-dir`, else `~/.iknow` (same source as runTui's own `dataDir`;
    // both sides resolve to the same pool root).
    traceOut: resolveTraceRoot(
      parsed.traceOut,
      resolveServeDataDir(parsed.dataDir)
    ),
    ...(parsed.autoMode ? { permissionMode: "full_auto" } : {}),
    // ADR-0119 / spec yolo-mode: the start-in-yolo switch — same
    // spread-guard shape as `--auto-mode` (absent = key not present = the
    // non-yolo fail-closed default). Reachable only via the tui command: the
    // other five public entries already filled a typed rejection at parse
    // time, and main() exits non-zero via `rejectNonTuiYoloEntry` before
    // dispatch (nothing started).
    ...(parsed.yolo === true ? { yolo: true } : {}),
  });
  process.exitCode = exitCode;
}

// Bun lives on PATH (a runtime, not an npm dependency). Re-exec this same CLI file under it with
// the cwd untouched, so ADR-0019 workspace-root semantics survive the handoff. No loop guard is
// needed: the child defines process.versions.bun and skips this branch.
type BunReexecResult = { kind: "exit"; code: number } | { kind: "missing" };

async function reexecTuiUnderBun(
  cliFile: string,
  args: string[]
): Promise<BunReexecResult> {
  return new Promise((resolve) => {
    const child = spawn("bun", [cliFile, ...args], { stdio: "inherit" });
    child.once("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        resolve({ kind: "missing" });
        return;
      }
      writeErr(
        `tui: bun 子进程启动失败 / failed to spawn bun: ${err.message}\n`
      );
      resolve({ kind: "exit", code: 1 });
    });
    child.once("close", (code, signal) => {
      // Shell convention: a signal death must map to 128+signum, so callers can tell
      // SIGTERM/SIGKILL apart from the child's own exit 1. code wins when non-null.
      const signum = signal === null ? undefined : osConstants.signals[signal];
      resolve({
        kind: "exit",
        code: code ?? (signum === undefined ? 1 : 128 + signum),
      });
    });
  });
}

async function runServe(parsed: ParsedCli): Promise<void> {
  // ADR-0087: reader-side panel root and writer-side session pool share one source = explicit dataDir, else ~/.iknow.
  const serveDataDir = resolveServeDataDir(parsed.dataDir);
  const tracePath = resolveTraceRoot(parsed.traceOut, serveDataDir);
  const { startSessionServe } = await import("./session-api/serve.js");
  const { createSessionGrants } =
    await import("./harness/permission/session-grants.js");
  // Single shared handle — `.ask` is what the harness consumes; the full
  // handle is also passed so the SPA can list + resolve pending requests
  // and the hub can accumulate "always-allow" rules.
  const askHandle = createServeAskUser();
  const sessionGrants = createSessionGrants();
  try {
    const { listening, hub } = await startSessionServe({
      host: parsed.host,
      port: parsed.port,
      json_mode: parsed.json,
      dataDir: parsed.dataDir,
      // ADR-0019: `--workspace-root` passes through to the serve entry (memory / bind)
      // without changing the session pool root (ADR-0087).
      ...(parsed.workspaceRoot !== undefined
        ? { workspaceRoot: parsed.workspaceRoot }
        : {}),
      traceOut: tracePath,
      askHandle,
      hubOptions: {
        askUser: askHandle.ask,
        sessionGrants,
        // ADR-0127: the SPA ask queue (5s fail-closed) is the serve entry's
        // interactive review route; without askHandle consumers headless
        // builds get no route and deny typed.
        securityReview: securityReviewRouteFromAsk(askHandle.ask),
      },
    });
    writeErr(`iknow serve  http://${listening.host}:${listening.port}/`);
    // ADR-0020: reader side mounts in the same process — the panel serves /trace on this
    // port directly, no separate process needed.
    writeErr(
      `Trace 面板: http://${listening.host}:${listening.port}/trace` +
        (parsed.traceOut ? `（写目录 ${parsed.traceOut}）` : "")
    );
    writeErr("API: /api/v1/health  ·  UI: /  ·  Ctrl+C to stop");
    // serve is a long-running entry — inside hub.ensureDeps, buildHarnessEngine
    // creates its own MCP + subagent manager, and built.shutdown is cached on the
    // hub (order: mcpManager first → subagentManager second). Registering
    // registerShutdown(hub) before process exit triggers the same composed
    // cleanup, leaving no stdio child processes behind.
    registerShutdown(hub);
    await new Promise<void>(() => {
      /* keep process alive until signal */
    });
  } catch (err) {
    printChatError(err);
    process.exitCode = 1;
  }
}

async function runTrace(parsed: ParsedCli): Promise<void> {
  // Reader side shares the writer's root — flag > env > serve writer-side data
  // root. `iknow trace` with defaults probes the same-process `iknow serve`
  // /trace panel, so the default root replicates serve's resolution chain
  // (explicit workspaceRoot > env > ~/.iknow, same shape as runServe). The old
  // single-file fail-fast (`detectLegacyTrace`) is retired; two-level tree
  // discovery is handled by the trace server's session discovery.
  const traceOut = resolveTraceRoot(
    parsed.traceOut,
    resolveServeDataDir(parsed.dataDir)
  );

  // ADR-0020 default mode: no new process — probe iknow serve health, then point
  // at the same-process /trace panel. Probe target host/port come from
  // --host/--port (default 127.0.0.1:8787).
  if (!parsed.separate) {
    const host = parsed.host;
    const port = parsed.port;
    if (await probeServeHealth(host, port)) {
      const url = `http://${host}:${port}/trace`;
      writeErr(`iknow trace  ${url}`);
      writeErr("Trace 检测面板（与 iknow serve 同进程，ADR-0020）");
      // Default: open the browser automatically; --no-open disables it (CI/headless).
      if (!parsed.noOpen) {
        openBrowser(url);
      }
      return;
    }
    writeErr(
      `未检测到 iknow serve（http://${host}:${port}/api/v1/health 不可达）`
    );
    writeErr(
      "请先运行 `iknow serve`，或用 `iknow trace --separate` 起独立检测进程"
    );
    process.exitCode = 1;
    return;
  }

  // ADR-0020: the --separate escape hatch keeps the standalone-process mode.
  const { startTraceServe } = await import("./traceserver/serve.js");
  const serveOpts: TraceServeOptions = {
    traceOut,
    host: parsed.host,
    port: parsed.port,
    ...(parsed.maxBytes !== undefined ? { maxBytes: parsed.maxBytes } : {}),
  };
  try {
    const listening = await startTraceServe(serveOpts);
    const url = `http://${listening.host}:${listening.port}/`;
    writeErr(`iknow trace  ${url}`);
    writeErr(`Trace 检测面板：${traceOut}`);
    writeErr(
      "API: /api/v1/health  ·  /api/v1/traces/sessions  ·  /api/v1/traces  ·  Ctrl+C to stop"
    );
    if (!parsed.noOpen) {
      openBrowser(url);
    }
    await new Promise<void>(() => {
      /* keep process alive until signal */
    });
  } catch (err) {
    printChatError(err);
    process.exitCode = 1;
  }
}

/**
 * ADR-0020: probe `iknow serve` health on host:port. 2s timeout; any network/parse
 * failure counts as "not detected" (probing is a branch signal, not an error path).
 */
async function probeServeHealth(host: string, port: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(`http://${host}:${port}/api/v1/health`, {
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: unknown };
    return body.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Re-export for tests / external tooling
export { parseArgs } from "./cli/parse-args.js";
export type { ParsedCli, CliCommand } from "./cli/parse-args.js";
export { processChatLine, runChatSession } from "./cli/chat-session.js";
export { isInteractive } from "./cli/session-io.js";
export { printUsage, getVersion, usageText } from "./cli/usage.js";
export {
  createTtyAskUser,
  createFailClosedAskUser,
  createNoAskUser,
  createServeAskUser,
} from "./harness/permission/index.js";
export type { AskUser } from "./harness/permission/types.js";

main().catch((err) => {
  printCliError(err);
  process.exit(1);
});
