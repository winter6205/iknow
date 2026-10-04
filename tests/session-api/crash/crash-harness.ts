/**
 * Fresh-process crash harness — the reusable piece behind every SC1 / SC2 /
 * SC8 / SC15 test in this round (spec
 * `session-checkpoint-architecture.md` SC25: "fresh-process crash tests use
 * real child processes and real filesystem state rather than only
 * reconstructing objects in one process").
 *
 * Two existing tests already prove a real signal and a real abnormal host
 * exit; this harness follows their shape instead of inventing a third one:
 *   - `tests/util/atomic-file-publish.test.ts` — a real child stopped at a
 *     NAMED seam, with a real reader on the other side of the kill;
 *   - `tests/subagent/worker-identity-abnormal-exit.test.ts` — a real host
 *     process that dies with no cleanup path, and a fresh process that
 *     reconciles what it left on disk.
 *
 * What the harness guarantees, and why each rule exists:
 *   1. BOTH the session pool and the workspace live under one temp root, so a
 *      test can never reach this repository's `data/` or a real `~/.iknow`.
 *   2. The crash is a real `SIGKILL` to the child's PROCESS GROUP, sent by
 *      the parent. No exit handler, no flush, no graceful close runs in the
 *      dying process — that is the whole point of the round.
 *   3. A child that dies BEFORE signalling its crash point fails the call with
 *      its own stderr and exit status. It never leaves the suite polling a
 *      marker that will not arrive.
 *   4. Temp roots are removed even when a child was killed, and only after the
 *      process is really gone.
 *
 * The child is a real `node` process running the real source under the `tsx`
 * loader — never a mock, and never a second copy of the code under test. The
 * scenario lives in `crash-host-entry.ts`, which this file drives; the on-disk
 * readers at the bottom exist so a test's assertions read REAL bytes instead of
 * trusting a value the harness handed back.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { SESSION_JSONL_EXT } from "../../../src/session-api/store/jsonl.ts";
import {
  resolveConversationDir,
  resolveProjectSessionDir,
} from "../../../src/session-api/store/session-store.ts";
import type { NativeStateMessage } from "../../../src/shared/native-state-port.ts";

/** tsx loader for the child process — the one the repo's own real-spawn
 *  fixture resolves, so the child loads the same source the test exercises. */
const tsxLoader = createRequire(import.meta.url).resolve("tsx");

/** The single real child entry every role runs under. */
const HOST_ENTRY = fileURLToPath(
  new URL("./crash-host-entry.ts", import.meta.url)
);

/**
 * The NAMED points a host may be killed at. A test names one instead of
 * killing "somewhere", which is the difference between a crash point and a
 * flaky test.
 */
export const CRASH_POINTS = [
  /** Immutable body written, checkpoint record not yet appended (SC1). */
  "after_body_write_before_record_append",
  /** A real record's bytes are partially on disk, unterminated (SC1). */
  "torn_trailing_append",
  /** The first main-loop model request has been handed to the adapter (SC2). */
  "first_model_dispatch",
  /** One graph node settled, another is still running (SC15). */
  "graph_node_in_flight",
  /**
   * A real `tool_use` block and its settled `tool_result` are committed in the
   * REAL log, and the next main-loop model request is in flight (SC2's
   * deliberate-replay control). A distinct point from
   * `first_model_dispatch`: the state on disk here holds a real tool round-trip,
   * which is what the replay leg needs to restore.
   */
  "tool_use_committed_before_kill",
] as const;

export type CrashPoint = (typeof CRASH_POINTS)[number];

/** The child's stdin-equivalent: one JSON file per process, written by the
 *  parent, read by the child. A file rather than argv/env because a plan
 *  carries whole message bodies. */
export interface CrashRoleRequest {
  readonly role:
    "publish" | "chat_turn" | "graph_host" | "reopen_chat" | "reopen_graph";
  readonly sessionPoolDir: string;
  readonly workspaceRoot: string;
  readonly conversationId: string;
  /** The identity the reopen reports against; supplied by the caller so no
   *  child has to derive a root identity of its own. */
  readonly liveRootIdentity: string;
  /** Where the child announces the crash point it has reached. */
  readonly crashPointPath: string;
  /** Real store operations to run before the crash point. */
  readonly plan?: ReadonlyArray<PlanOp>;
  /** `publish`: which crash point this arm is walking toward. */
  readonly crashPointHint?: CrashPoint;
  /** `publish`: the publication to attempt against a log made un-appendable,
   *  so its body lands and its record append is refused by the OS. */
  readonly faultedPublish?: {
    readonly anchorEventId: string;
    readonly boundary: "input" | "tool_batch" | "compaction" | "terminal";
    readonly messages: ReadonlyArray<NativeStateMessage>;
  };
  /** `chat_turn`: the accepted user line. */
  readonly line?: string;
  /** `chat_turn`: history the run continues from. */
  readonly priorMessages?: ReadonlyArray<NativeStateMessage>;
  /** `chat_turn`: arm the real proactive compaction gate. */
  readonly compress?: boolean;
  /**
   * `chat_turn`: run the real host to COMPLETION with a real `tool_use` in the
   * scripted model response, instead of to a crash point. This is the Prove-It
   * arm for the tool-dispatch probe: it drives a real production tool through
   * the real loop so the probe is shown reading non-zero where a tool really
   * runs. Additive; absent means the original crash-point `chat_turn`.
   */
  readonly toolUse?: {
    /** The `tool_use` block id the scripted response carries. */
    readonly id: string;
    /**
     * `chat_turn`: die at `tool_use_committed_before_kill` instead of
     * completing — the real tool round-trip is committed, and the host is
     * SIGKILLed while the NEXT main-loop model request is in flight. This is
     * what leaves a real `tool_use` in the persisted context for a reopen to
     * restore, which the deliberate-replay leg then dispatches on purpose.
     */
    readonly killAfterCommit?: boolean;
  };
  /** `reopen_chat`: the transcript seed a real resume would have produced. */
  readonly seedMessages?: ReadonlyArray<NativeStateMessage>;
  /**
   * `reopen_chat`: after recovery, run ONE REAL turn in the same process,
   * starting from the restored context, on the host's own dispatch path.
   *
   * This is the arm that observes the behavior under test rather than a
   * registry the test owns: the turn goes through `processChatLine` and the
   * real loop, so the only thing that can run a tool is the product's own code
   * deciding to run it. The scripted response carries a NEW `tool_use` with a
   * distinct id and a distinct file, which is what makes the run observable at
   * all — a turn whose response asked for nothing would read zero for free.
   */
  readonly continueTurn?: {
    /** The accepted operator line for the new turn. */
    readonly line: string;
    /** The `tool_use` id the scripted response carries. */
    readonly id: string;
  };
  /**
   * `reopen_chat`: after recovery has restored its context, DELIBERATELY
   * dispatch the restored `tool_use` through the same probed production
   * surface — the replay this criterion forbids. The arm snapshots the counter
   * before that dispatch, so the negative window and the replay leg cannot
   * contaminate each other.
   */
  readonly replayRestoredToolUse?: boolean;
  /** `torn_trailing_append`: bytes of the record to leave on disk. */
  readonly tornBytes?: number;
}

/** One real `SessionStore` operation. The child runs these in order against
 *  the store the production host would use. */
export type PlanOp =
  | {
      /** Create the session the way a host does before its first append. */
      readonly op: "create";
      readonly cwd: string;
    }
  | {
      readonly op: "appendEvents";
      readonly messages: ReadonlyArray<NativeStateMessage>;
    }
  | {
      readonly op: "appendNativeState";
      readonly anchorEventId: string;
      readonly boundary: "input" | "tool_batch" | "compaction" | "terminal";
      readonly messages: ReadonlyArray<NativeStateMessage>;
    };

/** What a killed host left behind, as the CRASH POINT describes it. */
export interface CrashReceipt {
  readonly crashPoint: CrashPoint;
  readonly pid: number;
  readonly pgid: number;
  /** Always `SIGKILL` — asserted, never assumed. */
  readonly signal: NodeJS.Signals;
  /** Free-form, role-specific detail the child recorded at the crash point. */
  readonly detail: Readonly<Record<string, unknown>>;
}

/** One temp-rooted session: the pool the store writes and the workspace the
 *  session is bound to. Both are inside `root`, and both are removed together. */
export interface CrashHost {
  readonly root: string;
  readonly sessionPoolDir: string;
  readonly workspaceRoot: string;
  readonly projectDir: string;
  readonly conversationId: string;
  readonly liveRootIdentity: string;
  readonly crashPointPath: string;
  readonly inputPath: string;
  /**
   * The child entry this host spawns. Defaults to the entry beside this
   * harness; a mutation-control arm points it at a MUTANT COPY of the tree, so
   * a deliberately defective build of the product is what runs without any
   * other test in the suite ever seeing the mutated source.
   */
  readonly hostEntryPath: string;
}

const openHosts: CrashHost[] = [];
/** Every process group this harness forked and has not yet reaped. */
const liveGroups: number[] = [];

/**
 * Create the temp root for one crash test: a session pool, a workspace, and a
 * conversation id. Both roots are fresh temp directories, never the repo's
 * `data/` and never a user pool.
 */
export async function createCrashHost(opts: {
  readonly prefix: string;
  readonly conversationId: string;
  /** Any absolute path; recovery only compares it, it never touches it. */
  readonly liveRootIdentity?: string;
  /** Spawn this entry instead of the one beside this harness. */
  readonly hostEntryPath?: string;
}): Promise<CrashHost> {
  const root = await mkdtemp(join(tmpdir(), opts.prefix));
  const sessionPoolDir = join(root, "sessions");
  const workspaceRoot = join(root, "workspace");
  await mkdir(sessionPoolDir, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  const host: CrashHost = {
    root,
    sessionPoolDir,
    workspaceRoot,
    // The production resolver, so a test reads the log without re-deriving it.
    projectDir: resolveProjectSessionDir(sessionPoolDir, workspaceRoot),
    conversationId: opts.conversationId,
    liveRootIdentity: opts.liveRootIdentity ?? join(root, "live-root-identity"),
    crashPointPath: join(root, "crash-point.json"),
    inputPath: join(root, "host-input.json"),
    hostEntryPath: opts.hostEntryPath ?? HOST_ENTRY,
  };
  openHosts.push(host);
  return host;
}

/**
 * Remove every temp root this harness created. Safe to call twice, safe after
 * a kill: the group is signalled, waited for, and only then are the files
 * removed.
 */
export async function disposeAllCrashHosts(): Promise<void> {
  await killLiveGroups();
  await Promise.all(
    openHosts.splice(0).map((host) =>
      rm(host.root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      })
    )
  );
}

/** Dispose one host (and forget it). */
export async function disposeCrashHost(host: CrashHost): Promise<void> {
  const at = openHosts.findIndex((h) => h.root === host.root);
  if (at >= 0) openHosts.splice(at, 1);
  await killLiveGroups();
  await rm(host.root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
}

/**
 * Fork a real host process, run it to `crashPoint`, then SIGKILL its process
 * group and assert the OS reported that signal.
 *
 * The child is its own process group leader (`detached`), so the kill reaches
 * every descendant it spawned — an in-flight graph node's child dies with the
 * host, which is the abnormal-exit case the spec describes.
 */
export async function runHostToCrashPoint(opts: {
  readonly host: CrashHost;
  readonly request: Omit<
    CrashRoleRequest,
    | "sessionPoolDir"
    | "workspaceRoot"
    | "conversationId"
    | "liveRootIdentity"
    | "crashPointPath"
  >;
  readonly crashPoint: CrashPoint;
  /** Cap for reaching the crash point. Generous: each child pays ~1s of
   *  module loading, and a child that dies early must not sit out the wait. */
  readonly timeoutMs?: number;
}): Promise<CrashReceipt> {
  const { host, crashPoint } = opts;
  await rm(host.crashPointPath, { force: true });
  const child = await startChild(host, opts.request);
  const reached = await waitForCrashPoint(
    child,
    host,
    crashPoint,
    opts.timeoutMs
  );
  // The real kill: negative pid = the whole process group. No handler in the
  // child can intercept SIGKILL, so nothing flushes and nothing unwinds.
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (err) {
    await child.exited;
    throw new Error(
      `could not SIGKILL the host process group ${child.pid}: ${String(err)}`
    );
  }
  const exit = await child.exited;
  const at = liveGroups.indexOf(child.pid);
  if (at >= 0) liveGroups.splice(at, 1);
  assert.equal(
    exit.signal,
    "SIGKILL",
    `the host must die by SIGKILL, got status=${String(exit.code)} ` +
      `signal=${String(exit.signal)}\nstderr:\n${child.stderr()}`
  );
  return {
    crashPoint,
    pid: child.pid,
    pgid: child.pid,
    signal: exit.signal,
    detail: reached.detail,
  };
}

/**
 * Run a role in a SECOND real process and return what it printed. Used for the
 * reopen: a fresh process with a fresh store and nothing in memory.
 */
export async function runRoleInFreshProcess<T>(opts: {
  readonly host: CrashHost;
  readonly request: Omit<
    CrashRoleRequest,
    | "sessionPoolDir"
    | "workspaceRoot"
    | "conversationId"
    | "liveRootIdentity"
    | "crashPointPath"
  >;
  readonly timeoutMs?: number;
}): Promise<T> {
  const { stdout } = await awaitChild(opts, "reopen process");
  return parseResultLine<T>(stdout, opts.request.role);
}

/**
 * Run a role in a real process that is expected to finish on its own — the
 * seeding pass before a crash, so the log a later crash lands on was itself
 * written by a real host process rather than by the test.
 */
export async function runHostToCompletion(opts: {
  readonly host: CrashHost;
  readonly request: Omit<
    CrashRoleRequest,
    | "sessionPoolDir"
    | "workspaceRoot"
    | "conversationId"
    | "liveRootIdentity"
    | "crashPointPath"
  >;
  readonly timeoutMs?: number;
}): Promise<void> {
  await awaitChild(opts, "host process");
}

type RoleRequest = Omit<
  CrashRoleRequest,
  | "sessionPoolDir"
  | "workspaceRoot"
  | "conversationId"
  | "liveRootIdentity"
  | "crashPointPath"
>;

async function awaitChild(
  opts: {
    readonly host: CrashHost;
    readonly request: RoleRequest;
    readonly timeoutMs?: number;
  },
  what: string
): Promise<{ readonly stdout: string }> {
  const child = await startChild(opts.host, opts.request);
  const exit = await withTimeout(
    child.exited,
    opts.timeoutMs ?? 120_000,
    `${what} (${opts.request.role})`
  );
  const at = liveGroups.indexOf(child.pid);
  if (at >= 0) liveGroups.splice(at, 1);
  assert.equal(
    exit.code,
    0,
    `${what} must succeed, got status=${String(exit.code)} ` +
      `signal=${String(exit.signal)}\nstderr:\n${child.stderr()}`
  );
  return { stdout: child.stdout() };
}

// -- the real on-disk reads ---------------------------------------------------

/** The session log's real path under this host's temp pool. */
export function realLogPath(host: CrashHost): string {
  return join(
    resolveConversationDir({
      projectDir: host.projectDir,
      conversationId: host.conversationId,
    }),
    `${host.conversationId}${SESSION_JSONL_EXT}`
  );
}

/** The session folder under this host's temp pool. */
export function realConversationDir(host: CrashHost): string {
  return resolveConversationDir({
    projectDir: host.projectDir,
    conversationId: host.conversationId,
  });
}

/** Every immutable native body the pool really holds, by content address. */
export async function realNativeBodies(host: CrashHost): Promise<string[]> {
  const dir = join(realConversationDir(host), "blobs", "native");
  if (!existsSync(dir)) return [];
  return (await readdir(dir)).sort();
}

/** The raw log bytes, so a test can assert on a torn tail itself. */
export async function realLogBytes(host: CrashHost): Promise<string> {
  return readFile(realLogPath(host), "utf8");
}

/**
 * A fingerprint of EVERYTHING under the session folder — path, size and content
 * hash of each file. Taken before and after a reopen, this is the real evidence
 * that the second process read the session and wrote none of it.
 */
export async function realSessionFingerprint(host: CrashHost): Promise<string> {
  const root = realConversationDir(host);
  const entries = (await readdir(root, { recursive: true })).map(String).sort();
  const parts: string[] = [];
  for (const rel of entries) {
    const abs = join(root, rel);
    if (!statSync(abs).isFile()) {
      parts.push(`dir ${rel}`);
      continue;
    }
    parts.push(
      `file ${rel} ${createHash("sha256").update(readFileSync(abs)).digest("hex")}`
    );
  }
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

// -- internals ----------------------------------------------------------------

interface Child {
  readonly pid: number;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly exited: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>;
}

async function startChild(
  host: CrashHost,
  request: Omit<
    CrashRoleRequest,
    | "sessionPoolDir"
    | "workspaceRoot"
    | "conversationId"
    | "liveRootIdentity"
    | "crashPointPath"
  >
): Promise<Child> {
  const input: CrashRoleRequest = {
    ...request,
    sessionPoolDir: host.sessionPoolDir,
    workspaceRoot: host.workspaceRoot,
    conversationId: host.conversationId,
    liveRootIdentity: host.liveRootIdentity,
    crashPointPath: host.crashPointPath,
  };
  // The child reads its own plan from this file, so it must be complete before
  // the process exists.
  await writeFile(host.inputPath, JSON.stringify(input), "utf8");
  const child = spawn(
    process.execPath,
    ["--import", tsxLoader, host.hostEntryPath, host.inputPath],
    { detached: true, stdio: ["ignore", "pipe", "pipe"] }
  );
  const pid = child.pid ?? -1;
  liveGroups.push(pid);
  let out = "";
  let err = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    err += chunk.toString("utf8");
  });
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("error", (spawnErr) => {
      err += `\nspawn error: ${String(spawnErr)}`;
      resolve({ code: null, signal: null });
    });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { pid, stdout: () => out, stderr: () => err, exited };
}

/**
 * Poll for the child's crash-point announcement, racing the child's own exit
 * so a host that dies early reports its failure instead of hanging the suite.
 */
async function waitForCrashPoint(
  child: Child,
  host: CrashHost,
  crashPoint: CrashPoint,
  timeoutMs = 120_000
): Promise<{ readonly detail: Readonly<Record<string, unknown>> }> {
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  void child.exited.then(() => {
    exited = true;
  });
  while (Date.now() < deadline) {
    if (existsSync(host.crashPointPath)) {
      const announced = JSON.parse(
        await readFile(host.crashPointPath, "utf8")
      ) as { point?: string; detail?: Record<string, unknown> };
      assert.equal(
        announced.point,
        crashPoint,
        `the host announced a different crash point than the test asked for`
      );
      return { detail: announced.detail ?? {} };
    }
    if (exited) {
      const exit = await child.exited;
      throw new Error(
        `the host died before reaching ${crashPoint} ` +
          `(status=${String(exit.code)}, signal=${String(exit.signal)})\n` +
          `stderr:\n${child.stderr()}`
      );
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  killGroupQuietly(child.pid);
  throw new Error(
    `the host never reached ${crashPoint} within ${timeoutMs}ms\n` +
      `stderr:\n${child.stderr()}`
  );
}

const RESULT_PREFIX = "IKNOW-CRASH-RESULT ";

function parseResultLine<T>(out: string, role: string): T {
  const line = out.split("\n").find((l) => l.startsWith(RESULT_PREFIX));
  assert.ok(
    line !== undefined,
    `the ${role} process printed no result line\nstdout:\n${out}`
  );
  return JSON.parse(line.slice(RESULT_PREFIX.length)) as T;
}

async function killLiveGroups(): Promise<void> {
  const groups = liveGroups.splice(0);
  for (const pgid of groups) killGroupQuietly(pgid);
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && groups.some(isAlive)) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

function killGroupQuietly(pgid: number): void {
  if (pgid <= 0) return;
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    try {
      process.kill(pgid, "SIGKILL");
    } catch {
      // EXIT: already gone — the kill under test did its job.
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  what: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const cap = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} exceeded ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, cap]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
