/**
 * Real-pty host harness — the pty half of SC24 (`session-checkpoint-architecture.md`
 * SC24: "exercise a persistent native TUI/session host through the available PTY
 * path under its normal permission fence"), composed with the fresh-process crash
 * harness rather than duplicating it.
 *
 * Division of labour with `crash-harness.ts`, which this file does NOT modify:
 *   - `crash-harness.ts` owns the temp session pool + workspace, the real
 *     on-disk readers (`realLogPath`, `realConversationDir`, `realLogBytes`) and
 *     the fresh-process reopen (`runRoleInFreshProcess`). A pty child is still a
 *     real child, so the non-pty halves of SC24 keep using those readers.
 *   - this file owns what a pty adds: a real controlling terminal for the
 *     persistent host, the loopback provider that lets a real host reach a real
 *     model boundary with no key, and the abnormal exit of that pty child's
 *     process group.
 *
 * The PTY PATH. This repository has no `node-pty` dependency, and adding one is
 * a lockfile change outside this task. The pty path that IS available is the
 * platform's own: Python's `pty.fork()`, which gives the child a real
 * controlling terminal (not just a tty-shaped pipe) — the same primitive the
 * manual SC24 run used. The transport is a small Python relay, written into the
 * temp root at run time so no fixture ever lands in the repository.
 *
 * Why the provider is a real loopback HTTP server and not a stubbed adapter:
 * SC24 must be decided without a model key, and a stubbed adapter would leave
 * the host's model boundary unobserved. A real server the child reaches over
 * TCP gives three things a stub cannot: the request bodies are the host's real
 * effective input, the ARRIVAL of a request is a named boundary the parent can
 * act on, and "the reopen asked the model nothing" becomes an out-of-process
 * observation instead of a patched global.
 *
 * Normal permission fence, stated as a contract of this harness: the child is
 * started with NO `--yolo`, NO `--auto-mode`, NO `--eval-state` and no
 * `IKNOW_PERMISSION_MODE`, so the fence is the product's own default. A mutating
 * tool therefore reaches the real `[ask] … [y/N]:` readline prompt on the pty,
 * and the only way this harness can produce a file write is by answering that
 * prompt the way a human would. A test that needed a bypass to pass would prove
 * nothing about SC24, and `assertNormalFence` fails loudly if a future edit
 * tries to add one.
 *
 * No stray processes, which the spec's "abnormal host exit" clause makes a hard
 * requirement rather than a nicety:
 *   1. the pty child is a session leader, so `SIGKILL` to its process group
 *      reaches every descendant it spawned (the tsx loader, the host, any tool
 *      child);
 *   2. the relay exits — and kills the child's group — when its own stdin
 *      closes, so a dying vitest worker cannot orphan a live host;
 *   3. every host registers in a module-level list that `afterEach`/`afterAll`
 *      drain, and each host also kills itself from its own `finally`;
 *   4. disposal waits for the relay to really be gone before the temp root is
 *      removed.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** tsx loader for the host child — resolved exactly as `crash-harness.ts`
 *  resolves it, so the pty child loads the same source the suite exercises. */
const tsxLoader = createRequire(import.meta.url).resolve("tsx");

/** The real CLI entry, resolved from this file rather than from `process.cwd()`
 *  so a suite run from any directory drives the same host. */
export const CLI_ENTRY = fileURLToPath(
  new URL("../../../src/cli.ts", import.meta.url)
);

/** Python 3 is the pty path this repository has; the harness fails loudly rather
 *  than silently skipping, because a silently skipped SC24 is a false green. */
const PTY_RELAY_PYTHON = "python3";

/**
 * The pty relay. Reads the host command from argv, `pty.fork()`s it so the child
 * gets a real controlling terminal, then multiplexes:
 *   - argv child pid  -> the relay's stdout, as a `CHILDPID <pid>` first line,
 *     so the parent knows which process group to signal;
 *   - the pty master   -> the relay's stdout, verbatim;
 *   - stdin            -> the pty master, verbatim, except the line `KILL`,
 *     which SIGKILLs the child's whole process group and stops relaying.
 * On stdin EOF (the vitest worker died) it kills the group and exits, so a
 * crashed parent can never leave a live host behind.
 *
 * Written as a `%`-formatted source string rather than a repository file: the
 * fixture must live in a temp dir, and this keeps the pty transport reviewable
 * next to the assertions that depend on it.
 */
const PTY_RELAY_SOURCE = [
  "import fcntl",
  "import os",
  "import pty",
  "import select",
  "import signal",
  "import struct",
  "import sys",
  "import termios",
  "",
  "cwd = sys.argv[1]",
  "cmd = sys.argv[2:]",
  "pid, fd = pty.fork()",
  "if pid == 0:",
  "    os.chdir(cwd)",
  "    os.execvp(cmd[0], cmd)",
  "",
  "done = False",
  "",
  "def reap() -> None:",
  "    global done",
  "    done = True",
  "    try:",
  "        os.killpg(pid, signal.SIGKILL)",
  "    except OSError:",
  "        pass",
  "",
  "for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):",
  "    signal.signal(sig, lambda *_: (reap(), sys.exit(0)))",
  "",
  "try:",
  "    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))",
  "except OSError:",
  "    pass",
  "",
  "out = sys.stdout.buffer",
  "out.write(('CHILDPID %d\\n' % pid).encode())",
  "out.flush()",
  "",
  "stdin_fd = sys.stdin.fileno()",
  "stdin_open = True",
  "",
  "while not done:",
  "    watch = [] if done else [fd]",
  "    if stdin_open:",
  "        watch.append(stdin_fd)",
  "    if not watch:",
  "        break",
  "    try:",
  "        ready, _, _ = select.select(watch, [], [], 0.25)",
  "    except (OSError, ValueError):",
  "        break",
  "    for handle in ready:",
  "        if handle == fd:",
  "            try:",
  "                chunk = os.read(fd, 65536)",
  "            except OSError:",
  "                chunk = b''",
  "            if not chunk:",
  "                reap()",
  "                break",
  "            out.write(chunk)",
  "            out.flush()",
  "        else:",
  "            try:",
  "                data = os.read(stdin_fd, 65536)",
  "            except OSError:",
  "                data = b''",
  "            if not data:",
  "                # The parent is gone: never leave the host running.",
  "                reap()",
  "                break",
  "            if data.strip() == b'KILL':",
  "                reap()",
  "                break",
  "            try:",
  "                os.write(fd, data)",
  "            except OSError:",
  "                reap()",
  "                break",
  "",
  "reap()",
  "sys.exit(0)",
  "",
].join("\n");

/** One real request the loopback provider received, in the shape the assertions
 *  read: what the host actually put on the wire, not what the test intended. */
export interface ProviderRequest {
  /** 1-based arrival order. */
  readonly n: number;
  readonly tools: ReadonlyArray<string>;
  /** Every content block of every message, flattened to `type:detail` strings. */
  readonly blocks: ReadonlyArray<string>;
  readonly system: string;
  /** True when any message carries a `tool_result` — i.e. a tool already ran. */
  readonly hasToolResult: boolean;
  /** True when any message carries a `tool_use` block. */
  readonly hasToolUse: boolean;
  /** The serialized request messages, for substring assertions. */
  readonly flat: string;
}

export interface LoopbackProvider {
  /** Origin the host's provider must point at. */
  readonly origin: string;
  readonly requests: ReadonlyArray<ProviderRequest>;
  /** Requests that replayed settled work: a `tool_result` in context, or a
   *  `tool_use` the harness did not ask for. Zero on a clean reopen. */
  readonly replayRequests: ReadonlyArray<ProviderRequest>;
  /** Count of requests carrying a `tool_use` block. */
  readonly toolUseCount: number;
  /** Wait until at least `n` requests have arrived (deadline-bounded). */
  waitForRequests(n: number, ms: number, what: string): Promise<void>;
  /**
   * Wait for the NAMED crash boundary: a tools-bearing request whose context
   * already contains a `tool_result`, i.e. the host has the settled tool result
   * in hand and is asking the model again. The provider deliberately leaves that
   * request unanswered, so the host is blocked inside its model call when the
   * parent's SIGKILL lands.
   */
  waitForPostToolDispatch(ms: number, what: string): Promise<ProviderRequest>;
  close(): Promise<void>;
}

/**
 * Start the scripted loopback provider.
 *
 * `writeInstruction` is the marker that makes the script deterministic: a
 * request whose context contains it is answered with a real `write_file`
 * `tool_use`; every other request is answered with a short text. The decision is
 * cached by context signature, so a host that re-dispatches an identical
 * context gets an identical answer instead of a second, diverging script.
 */
export async function startLoopbackProvider(opts: {
  readonly writeInstruction: string;
  readonly writePath: string;
  readonly writeContent: string;
  /** Tool name the host really exposes for creating a file. */
  readonly writeToolName?: string;
}): Promise<LoopbackProvider> {
  const writeToolName = opts.writeToolName ?? "write_file";
  const requests: ProviderRequest[] = [];
  const answers = new Map<string, "tool" | "text">();
  const arrivalWaiters: Array<{ at: number; resolve: () => void }> = [];
  let resolveBoundary: ((r: ProviderRequest) => void) | null = null;
  let closed = false;

  const settleArrivals = (): void => {
    for (const w of [...arrivalWaiters]) {
      if (w.at <= requests.length) {
        arrivalWaiters.splice(arrivalWaiters.indexOf(w), 1);
        w.resolve();
      }
    }
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> = {};
      try {
        body = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
      } catch {
        body = {};
      }
      const messages = Array.isArray(body.messages)
        ? (body.messages as ReadonlyArray<Record<string, unknown>>)
        : [];
      const blocks: string[] = [];
      for (const m of messages) {
        const content = m.content;
        if (!Array.isArray(content)) {
          blocks.push(`text:${String(content ?? "").slice(0, 200)}`);
          continue;
        }
        for (const c of content as ReadonlyArray<Record<string, unknown>>) {
          const type = String(c.type ?? "");
          const detail = c.text ?? c.name ?? c.content ?? "";
          blocks.push(`${type}:${String(detail).slice(0, 200)}`);
        }
      }
      const toolDefs = Array.isArray(body.tools)
        ? (body.tools as ReadonlyArray<Record<string, unknown>>)
        : [];
      const flat = JSON.stringify(messages);
      const record: ProviderRequest = {
        n: requests.length + 1,
        tools: toolDefs.map((t) => String(t.name)),
        blocks,
        system: typeof body.system === "string" ? body.system : "",
        hasToolResult: blocks.some((b) => b.startsWith("tool_result")),
        hasToolUse: blocks.some((b) => b.startsWith("tool_use")),
        flat,
      };
      requests.push(record);
      settleArrivals();

      if (record.tools.length > 0 && record.hasToolResult) {
        // The named crash boundary. Answering would let the turn finish; staying
        // silent holds the host inside its model call, which is the state the
        // abnormal exit has to catch.
        resolveBoundary?.(record);
        return;
      }
      const signature = `${record.tools.length > 0}|${flat}`;
      if (!answers.has(signature)) {
        answers.set(
          signature,
          flat.includes(opts.writeInstruction) ? "tool" : "text"
        );
      }
      const kind = answers.get(signature) ?? "text";
      const content =
        kind === "tool"
          ? [
              {
                type: "tool_use",
                id: `toolu_pty_${record.n}`,
                name: writeToolName,
                input: { path: opts.writePath, content: opts.writeContent },
              },
            ]
          : [{ type: "text", text: "acknowledged" }];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `msg_pty_${record.n}`,
          type: "message",
          role: "assistant",
          model: "pty-acceptance-model",
          content,
          stop_reason: kind === "tool" ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      );
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  const address = server.address();
  assert.ok(
    address !== null && typeof address === "object",
    "the loopback provider must bind a kernel-assigned port"
  );

  const provider: LoopbackProvider = {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    replayRequests: requests.filter((r) => r.hasToolResult || r.hasToolUse),
    get toolUseCount(): number {
      return requests.filter((r) => r.hasToolUse).length;
    },
    waitForRequests(n, ms, what) {
      if (requests.length >= n) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const waiter = { at: n, resolve };
        arrivalWaiters.push(waiter);
        const timer = setTimeout(() => {
          const at = arrivalWaiters.indexOf(waiter);
          if (at >= 0) arrivalWaiters.splice(at, 1);
          reject(
            new Error(
              `${what}: only ${requests.length} of ${n} provider requests arrived ` +
                `within ${ms}ms`
            )
          );
        }, ms);
        void timer.unref?.();
      });
    },
    waitForPostToolDispatch(ms, what) {
      const existing = requests.find(
        (r) => r.tools.length > 0 && r.hasToolResult
      );
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise<ProviderRequest>((resolve, reject) => {
        const timer = setTimeout(() => {
          resolveBoundary = null;
          reject(
            new Error(`${what}: no post-tool model dispatch within ${ms}ms`)
          );
        }, ms);
        void timer.unref?.();
        resolveBoundary = (r) => {
          clearTimeout(timer);
          resolveBoundary = null;
          resolve(r);
        };
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      resolveBoundary = null;
      arrivalWaiters.length = 0;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return provider;
}

/**
 * Write a hermetic `$HOME` for one host.
 *
 * The provider registry is a USER-layer settings key — the project-layer
 * allowlist is only `verify` / `secrets` / `permissions` — so a host can only be
 * pointed at a loopback provider through `<home>/.iknow/settings.json`. The home
 * is therefore a temp directory, passed to the child as `HOME`, which is how
 * `os.homedir()` resolves inside it. Nothing here reads, writes or requires a
 * real `~/.iknow`, and the api key is a literal placeholder the test owns.
 */
export async function writeHermeticHome(opts: {
  readonly home: string;
  readonly providerOrigin: string;
  /** Env var name the provider reads its key from. */
  readonly apiKeyEnv: string;
  readonly modelRoute?: string;
  readonly maxTokens?: number;
}): Promise<void> {
  const settings = {
    llm: {
      model: opts.modelRoute ?? "pty-provider/pty-model",
      providers: [
        {
          id: "pty-provider",
          baseUrl: opts.providerOrigin,
          apiKeyEnv: opts.apiKeyEnv,
          // A bounded budget keeps the non-streaming SDK arm legal (the SDK
          // refuses a non-stream request whose budget exceeds ten minutes) and
          // touches nothing about the permission fence.
          models: [{ id: "pty-model", maxTokens: opts.maxTokens ?? 4096 }],
        },
      ],
    },
  };
  await writeFile(
    join(opts.home, ".iknow", "settings.json"),
    JSON.stringify(settings, null, 2),
    "utf8"
  );
}

/** A pty-hosted real `iknow chat` process under the normal permission fence. */
export interface PtyChatHost {
  readonly label: string;
  /** Rolling pty output. Every wait below reads this, so a failed wait can
   *  report the host's real screen instead of a guess. */
  readonly output: () => string;
  readonly childPid: number;
  readonly relayPid: number;
  readonly exited: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>;
  /** Event-driven wait on the pty output, bounded by a real deadline. */
  waitFor(pattern: RegExp, ms: number, what: string): Promise<string>;
  /** Type one line into the host's real readline, as a user would. */
  send(line: string): void;
  /** SIGKILL the whole pty process group and wait for the relay to be gone. */
  killGroup(): Promise<void>;
  /** Belt and braces for a failed assertion: kill, then confirm nothing is left. */
  dispose(): Promise<void>;
}

const openHosts: PtyChatHost[] = [];

/** Drain every pty host this module started. Safe to call repeatedly. */
export async function disposeAllPtyHosts(): Promise<void> {
  await Promise.all(openHosts.splice(0).map((h) => h.dispose()));
}

export async function createPtyChatHost(opts: {
  readonly label: string;
  /** Temp dir the child runs in; also the identity root its store is keyed by. */
  readonly cwd: string;
  /** Session pool root — the same pool `crash-harness.ts` reads from. */
  readonly dataDir: string;
  readonly home: string;
  readonly apiKeyEnv: string;
  readonly apiKey: string;
  /** Extra CLI arguments. Empty for a new session; `["--resume", id]` to reopen. */
  readonly extraArgs?: ReadonlyArray<string>;
}): Promise<PtyChatHost> {
  const relayDir = await mkdtemp(join(tmpdir(), "iknow-pty-relay-"));
  const relayPath = join(relayDir, "pty_relay.py");
  await writeFile(relayPath, PTY_RELAY_SOURCE, "utf8");

  const relay = spawn(
    PTY_RELAY_PYTHON,
    [
      relayPath,
      opts.cwd,
      process.execPath,
      "--import",
      tsxLoader,
      CLI_ENTRY,
      "chat",
      "--data-dir",
      opts.dataDir,
      ...(opts.extraArgs ?? []),
    ],
    {
      // Its own process group: disposal signals the relay without touching the
      // vitest worker, and the pty child lives in a different group again.
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: opts.cwd,
      env: hermeticChildEnv(opts),
    }
  );
  const relayPid = relay.pid ?? -1;
  let childPid = -1;
  let out = "";
  let err = "";
  let disposed = false;
  const waiters: Array<{ pattern: RegExp; resolve: (s: string) => void }> = [];

  relay.stdout?.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
    if (childPid < 0) {
      const nl = out.indexOf("\n");
      if (nl >= 0 && out.startsWith("CHILDPID ")) {
        childPid = Number(out.slice("CHILDPID ".length, nl));
        out = out.slice(nl + 1);
      }
    }
    // Release every waiter whose pattern the new bytes satisfy. This is the
    // event-driven half: a host that never prints the expected text fails on
    // the deadline instead of being papered over by a sleep.
    for (const w of [...waiters]) {
      if (w.pattern.test(out)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(out);
      }
    }
  });
  relay.stderr?.on("data", (chunk: Buffer) => {
    err += chunk.toString("utf8");
  });
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    relay.once("error", (e) => {
      err += `\nrelay spawn error: ${String(e)}`;
      resolve({ code: null, signal: null });
    });
    relay.once("close", (code, signal) => resolve({ code, signal }));
  });

  const host: PtyChatHost = {
    label: opts.label,
    output: () =>
      out + (err === "" ? "" : `\n--- ${opts.label} stderr ---\n${err}`),
    get childPid() {
      return childPid;
    },
    relayPid,
    exited,
    waitFor(pattern, ms, what) {
      if (pattern.test(out)) return Promise.resolve(out);
      return new Promise<string>((resolve, reject) => {
        const waiter = { pattern, resolve };
        waiters.push(waiter);
        const timer = setTimeout(() => {
          const at = waiters.indexOf(waiter);
          if (at >= 0) waiters.splice(at, 1);
          reject(
            new Error(
              `${opts.label}: timed out after ${ms}ms waiting for ${what}\n` +
                `--- pty output ---\n${host.output()}`
            )
          );
        }, ms);
        void timer.unref?.();
      });
    },
    send(line) {
      relay.stdin?.write(line);
    },
    async killGroup() {
      if (childPid > 0) {
        // The real abnormal exit: SIGKILL to the pty child's process group.
        // Nothing in the dying host can intercept it, so no cleanup handler, no
        // flush and no graceful close runs — which is the point.
        try {
          process.kill(-childPid, "SIGKILL");
        } catch {
          // EXIT: the group is already gone, which is the outcome under test.
        }
      }
      await withDeadline(exited, 10_000, `${opts.label} relay exit`);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      const at = openHosts.indexOf(host);
      if (at >= 0) openHosts.splice(at, 1);
      waiters.length = 0;
      try {
        relay.stdin?.write("KILL\n");
      } catch {
        // EXIT: the relay is already gone.
      }
      if (childPid > 0) signalGroupQuietly(childPid);
      const settled = await settlesWithin(exited, 4000);
      if (!settled) signalQuietly(relayPid);
      await settlesWithin(exited, 4000);
      signalQuietly(relayPid);
      await rm(relayDir, { recursive: true, force: true, maxRetries: 5 });
    },
  };
  // Fail loudly rather than hang: a relay that cannot report its child pid can
  // never be killed by group, so the harness must not pretend it started.
  await withDeadline(
    waitForChildPid(),
    20_000,
    `${opts.label} pty child pid`
  ).catch((e: Error) => {
    void host.dispose();
    throw e;
  });
  openHosts.push(host);
  return host;

  async function waitForChildPid(): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (childPid > 0) return;
      if (err.includes("relay spawn error") || err.includes("Traceback")) {
        throw new Error(
          `${opts.label}: the pty relay could not start\n${err}\n` +
            `SC24 needs a real pty. This repository has no node-pty dependency; ` +
            `the available pty path is Python's pty.fork(), so ${PTY_RELAY_PYTHON} ` +
            `must be on PATH.`
        );
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`${opts.label}: the pty relay never reported a child pid`);
  }
}

/**
 * The child environment. Every entry is deliberate: `HOME` is the hermetic temp
 * home, the api key is a literal the test owns (no real credential is read or
 * required), the non-streaming arm keeps the loopback answer a plain JSON
 * document, and no permission override appears anywhere — that absence IS the
 * normal fence.
 */
function hermeticChildEnv(opts: {
  readonly home: string;
  readonly apiKeyEnv: string;
  readonly apiKey: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: opts.home,
    [opts.apiKeyEnv]: opts.apiKey,
    IKNOW_LLM_STREAM: "off",
    NO_COLOR: "1",
  };
  for (const forbidden of [
    "IKNOW_PERMISSION_MODE",
    "IKNOW_EVAL_STATE",
    "IKNOW_YOLO",
  ]) {
    delete env[forbidden];
  }
  return env;
}

/**
 * Assert the host really ran under the normal fence. A test that needed
 * `--yolo` or eval state to pass would be worthless as SC24 evidence, so the
 * harness states the fence as an invariant instead of trusting the flag list.
 */
export function assertNormalFence(args: ReadonlyArray<string>): void {
  for (const forbidden of ["--yolo", "--auto-mode", "--eval-state"]) {
    assert.ok(
      !args.includes(forbidden),
      `SC24 evidence must not use ${forbidden}; the host must run under its ` +
        `normal permission fence`
    );
  }
}

/** True while a pid is still signallable — used only for post-run leak checks. */
export function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Poll a real on-disk fact to a deadline. Never a fixed sleep. */
export async function waitForOnDisk(
  predicate: () => boolean,
  ms: number,
  what: string
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}`);
}

function signalGroupQuietly(pgid: number): void {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    signalQuietly(pgid);
  }
}

function signalQuietly(pid: number): void {
  if (pid <= 0) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // EXIT: already gone.
  }
}

async function settlesWithin(
  promise: Promise<unknown>,
  ms: number
): Promise<boolean> {
  const pending = Symbol("pending");
  const winner = await Promise.race([
    promise.then(() => "settled" as const),
    new Promise<typeof pending>((r) => setTimeout(() => r(pending), ms)),
  ]);
  return winner === "settled";
}

async function withDeadline<T>(
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
