/**
 * The smoke's execution guards: credential refusal, the two deliberate argv deviations, the
 * sealed dispatch port, and container inventory.
 *
 * Why these are load-bearing rather than incidental (issue 1219 requirement 3): this is the
 * only path that drives real `docker`, so it is where a model dispatch or an API key could
 * reach the wire. `assertNoCredentials` runs on EVERY docker argv before it executes,
 * `sealedPort` makes `dispatch()` a typed refusal rather than a promise, and
 * `listSmokeContainers` is the inventory the cleanup proof is asserted against.
 *
 * The two argv deviations are deliberate and named: dropping a mount (negative case 1) and
 * forwarding the host proxy env. Mounts are still produced by `sharedMounts`; only what
 * reaches the command line is filtered, so no wiring is reimplemented here.
 *
 * The refusal path is the one place this file writes to a human, so it describes a credential
 * instead of quoting it: the guard's job is to stop the run, and its message travels to stderr
 * and CI logs, where a full key is a leak even though the run never started.
 */
import { defaultExec } from "./docker.js";
import type { ExecFn } from "./docker.js";
import {
  CONTAINER_PREFIX,
  type DispatchLedger,
  type ExecGuards,
} from "./smoke-types.js";
import type { RunnerPort } from "./runner.js";

/** Forwarded verbatim into the container; mirrors what #1212 passed by hand. */
const PROXY_ENV_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
];
/** Any of these reaching a `docker` argument is a hard refusal, not a warning. */
const SECRET_ENV_NAMES = [
  "MINIMAX_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "DEEPSEEK_API_KEY",
];

const PROBE_TIMEOUT_MS = 60_000;

/** Container-path component of a `-v host:container[:ro]` argument. */
function mountContainerPath(arg: string): string {
  return arg.split(":")[1] ?? "";
}

/** Remove whole `-v` pairs for the named container paths, keeping every other mount intact. */
export function dropMountArgs(
  args: ReadonlyArray<string>,
  drops: ReadonlyArray<string>
): string[] {
  const kept: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (
      args[i] === "-v" &&
      i + 1 < args.length &&
      drops.includes(mountContainerPath(args[i + 1] ?? ""))
    ) {
      i += 1;
      continue;
    }
    kept.push(args[i] ?? "");
  }
  return kept;
}

/**
 * The `-e NAME=VALUE` pairs the host proxy env contributes, or `[]` when nothing is set.
 *
 * Shared by `injectProxyEnv` and the report's `proxyEnvInjected`, so the report describes the
 * flags this helper actually produced instead of asserting an injection that never happened.
 */
export function proxyEnvFlags(): string[] {
  return PROXY_ENV_NAMES.flatMap((name) => {
    const value = process.env[name];
    return value === undefined || value === ""
      ? []
      : ["-e", `${name}=${value}`];
  });
}

/** Insert proxy `-e` flags after `-d`, so `docker exec` inherits them for the grader. */
export function injectProxyEnv(args: ReadonlyArray<string>): string[] {
  const at = args.indexOf("-d");
  if (at < 0) return [...args];
  const env = proxyEnvFlags();
  return env.length === 0
    ? [...args]
    : [...args.slice(0, at + 1), ...env, ...args.slice(at + 1)];
}

/**
 * Whether this run injected any proxy variable. Read from the same helper the argv is built
 * from: on a host with no `HTTP_PROXY` the injection is a no-op, and a report that claims it
 * happened is asserting something the run did not do.
 */
export function proxyEnvInjected(): boolean {
  return proxyEnvFlags().length > 0;
}

/** `NAME=value` for a variable name, whatever the value is. */
const SECRET_ASSIGNMENT = /^([A-Z][A-Z0-9_]*)=(.*)$/s;

/**
 * Describe one offending argv entry WITHOUT its secret.
 *
 * A refusal reaches stderr and therefore CI logs, so it may carry the variable NAME and the
 * value's LENGTH — the two facts that let an operator recognise their own fat-fingered flag —
 * and never the value itself, not even a prefix.
 */
function redactArg(arg: string): string {
  const assigned = SECRET_ASSIGNMENT.exec(arg);
  return assigned === null
    ? `<redacted argv token carrying a live credential, ${arg.length} chars>`
    : `${assigned[1]}=<redacted, ${(assigned[2] ?? "").length} chars>`;
}

/** Every offending argv entry, described. Deduped, so one secret is never quoted twice. */
function describeHits(hits: ReadonlyArray<string>): string {
  return [...new Set(hits.map(redactArg))].join("; ");
}

/** Refuse before the process starts if a secret env name or its value reaches the docker line. */
export function assertNoCredentials(args: ReadonlyArray<string>): void {
  const secrets = SECRET_ENV_NAMES.map((name) => process.env[name]).filter(
    (value): value is string => value !== undefined && value !== ""
  );
  const named = args.filter((arg) =>
    SECRET_ENV_NAMES.some((name) => arg.startsWith(`${name}=`))
  );
  const leaked = args.filter((arg) =>
    secrets.some((secret) => arg.includes(secret))
  );
  if (named.length > 0 || leaked.length > 0) {
    throw new Error(
      `smoke refuses to run: a credential would reach docker: ${describeHits([...named, ...leaked])} ` +
        `(variable names and value lengths only; no credential value is printed)`
    );
  }
}

/**
 * Wrap an `ExecFn` with the two deliberate deviations, and nothing else: dropping a named
 * mount (negative case 3) and forwarding proxy env. Mounts are still produced by
 * `sharedMounts`; this only filters what reaches the docker command line.
 */
export function guardedExec(base: ExecFn, guards: ExecGuards): ExecFn {
  return async (file, args, options) => {
    if (file !== "docker") return base(file, args, options);
    assertNoCredentials(args);
    const isRun = args[0] === "run";
    const dropped =
      guards.dropMounts.length > 0
        ? dropMountArgs(args, guards.dropMounts)
        : [...args];
    return base(
      file,
      isRun && guards.injectProxyEnv ? injectProxyEnv(dropped) : dropped,
      options
    );
  };
}

/** A `RunnerPort` whose `dispatch` can never run. Reaching it is a typed refusal, not a stub. */
export function sealedPort(
  port: RunnerPort,
  ledger: DispatchLedger
): RunnerPort {
  const refuse = (): never => {
    ledger.count += 1;
    throw new Error(
      "smoke sealed dispatch(): this run must never dispatch a model"
    );
  };
  return {
    version: port.version,
    provision: (spec) => port.provision(spec),
    grade: (spec, wall) => port.grade(spec, wall),
    reap: (spec) => port.reap(spec),
    dispatch: refuse,
  };
}

/** Container names carrying the smoke prefix, as the docker daemon currently reports them. */
export async function listSmokeContainers(
  exec: ExecFn
): Promise<ReadonlyArray<string>> {
  const args = [
    "ps",
    "-a",
    "--filter",
    `name=${CONTAINER_PREFIX}`,
    "--format",
    "{{.Names}}",
  ];
  const run = await exec("docker", args, { timeoutMs: PROBE_TIMEOUT_MS });
  return run.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .sort();
}

/**
 * The subset of the inventory THIS process created.
 *
 * `docker.ts` names every container `tb21-<task>-<pid>`, while the inventory is filtered on
 * the bare `tb21-` prefix — which also matches a CONCURRENT run. Reaping the whole inventory
 * would delete another run's work, so the pid is what makes a reap this run's own.
 */
export function ownedContainers(
  names: ReadonlyArray<string>
): ReadonlyArray<string> {
  return names.filter((name) => name.endsWith(`-${process.pid}`));
}

/** `docker rm -f` each name. A name the daemon has already forgotten is not an error. */
export async function reapContainers(
  exec: ExecFn,
  names: ReadonlyArray<string>
): Promise<void> {
  for (const name of names)
    await exec("docker", ["rm", "-f", name], { timeoutMs: PROBE_TIMEOUT_MS });
}

const INTERRUPT_SIGNALS = ["SIGINT", "SIGTERM"] as const;

/**
 * Run `onInterrupt` when the run is cut short, then let the signal take its default course.
 *
 * The handler must NOT swallow the signal. An operator who pressed Ctrl-C expects the process
 * to die of the signal, and a run that instead exits 0 teaches CI that interrupting a run is
 * free. So the handler removes itself and re-raises through `process.kill`, which restores the
 * default disposition — the standard way to run cleanup on a signal without hiding it.
 *
 * `onInterrupt` is async because reaping is a docker call, so the re-raise happens once it
 * settles. That is also what keeps the process alive long enough to write the report: a signal
 * handler cannot await, and killing the process first is what previously destroyed the
 * evidence.
 *
 * The returned disposer removes both handlers, so an embedding process — or a test — is never
 * left holding a listener it did not install knowingly.
 */
export function installInterruptHandlers(
  onInterrupt: (signal: NodeJS.Signals) => Promise<void> | void
): () => void {
  const handler = (signal: NodeJS.Signals): void => {
    void Promise.resolve()
      .then(() => onInterrupt(signal))
      .catch((error: unknown) => {
        console.error(`smoke interrupt cleanup failed: ${String(error)}`);
      })
      .finally(() => {
        for (const name of INTERRUPT_SIGNALS)
          process.removeListener(name, handler);
        process.kill(process.pid, signal);
      });
  };
  for (const name of INTERRUPT_SIGNALS) process.on(name, handler);
  return () => {
    for (const name of INTERRUPT_SIGNALS) process.removeListener(name, handler);
  };
}

export { defaultExec };
