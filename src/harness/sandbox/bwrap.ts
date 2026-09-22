import { existsSync } from "node:fs";
import { ToolExecutionError } from "../errors.js";
import type { FsPolicy } from "./fs-policy.js";
import {
  OPTIONAL_HOST_RO_PREFIXES,
  READ_ONLY_SYSTEM_PATHS,
} from "./fs-policy.js";
import type { EgressFenceSpec } from "./egress/session.js";

export interface SeccompProfile {
  readonly fd: number;
}

// Defined in fs-policy.ts (single source with the system prefix list);
// re-exported so existing import sites keep working.
export { OPTIONAL_HOST_RO_PREFIXES };

function optionalHostRoBindArgs(): string[] {
  return OPTIONAL_HOST_RO_PREFIXES.flatMap((path) =>
    existsSync(path) ? ["--ro-bind", path, path] : []
  );
}

export interface BwrapFenceOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly fsPolicy: FsPolicy;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  // ADR-0092 cwdReadonly: absent/false = the host root bind
  // already makes cwd writable; true = additionally `--ro-bind cwd cwd` so a
  // validator hole still gets EROFS at the kernel layer.
  readonly cwdReadonly?: boolean;
  readonly seccompProfile?: never;
  /**
   * ADR-0092: workspace-tier home ro-bind source + destination host absolute
   * paths. Consumed **only** in workspace mode; absent / empty string there →
   * typed fail-loud (see `workspaceHomeRoBindArgs`) — never degrades to global mode.
   */
  readonly homeRoot?: string;
  /**
   * ADR-0092: workspace-tier **taskRoot** write-whitelist source + destination
   * host absolute paths. Absent / empty string → the corresponding bind is not
   * emitted. Consumed **only** in workspace mode, sitting in the same mid-segment
   * of the mount order as the home ro-bind.
   *
   * **Naming caution**: the field keeps its historical name `workspaceRoot`, but
   * its meaning is ADR-0092's "live taskRoot" (callers pass `waveRoot` /
   * `opts.cwd`), **not** the ADR-0019 / registry.ts `workspaceRoot` (a per-root
   * state anchor, explicitly not a bind root). Same name, different meaning —
   * this comment is authoritative for this field.
   */
  readonly workspaceRoot?: string;
  /**
   * ADR-0092: workspace-tier session-tmp write whitelist source + destination
   * host absolute paths. In production taken from `fsPolicy.tmpRoot()` (the
   * fs-policy contract root guarantees it is non-empty and exists); absent →
   * this bind is not emitted. Consumed **only** in workspace mode.
   */
  readonly tmpRoot?: string;
  /**
   * Egress proxy seam — optional assembly of host socket → in-sandbox proxy port.
   *
   // (ADR-0097)
   *
   * Absent → no unix socket `--bind` is emitted and no proxy env is injected
   * (`--unshare-net` remains constant; there is no host-net direct branch). At
   * fence assembly time the socket bind and the proxy env
   * (HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY — URL embeds auth
   * userinfo, pointing at the sandbox's **fixed listen port**
   * `SANDBOX_HTTP_PROXY_PORT`=3128, no longer an OS-assigned host port); the
   * sandbox-side half-bridge = `spec.innerBridgeScript` prepended to the command
   * chain (bash.ts foreground wiring; its bundled node relay forwards
   * 127.0.0.1:3128 back to this socket → host proxy),
   * see `src/harness/sandbox/egress/session.ts`.
   *
   * **Mount order**: the socket bind lands after workspaceMounts and before
   * cwdReadonly — same segment as the existing mount block (last-mount-wins).
   * `--setenv` goes through the existing envArgs mechanism (shared with
   * `--clearenv`: clearenv first, setenv after).
   */
  readonly egress?: EgressFenceSpec;
  /**
   * UNBOUND_FENCE: when the worktree isolation gate is ON and the wave root is
   * the main checkout (not bound to a task worktree), the caller supplies the
   * main checkout's absolute path — the fence emits `--ro-bind <mainCheckout>
   * <mainCheckout>`, upgrading "main repo read-only" from prediction-based
   * interception to a physical guarantee. Immediately after, another
   * `--bind <tmpPad> <tmpPad>` re-covers the session tmp pad as writable (ADR
   * ruling: all scratch writes go through the pad).
   *
   * **Mount order**: the whole segment sits after all writable binds and before
   * `--proc`/`--dev-bind` (the tail of last-mount-wins), so even when
   * cwdReadonly / the workspace-tier write whitelists appear first, the ro
   * override always lands above them and the pad rw always above the ro.
   *
   * Absent = no segment emitted at all (bound / gate-OFF sessions stay
   * byte-identical in argv). Empty `mainCheckout` = typed fail-loud — silently
   * skipping would be a loosening direction (main repo becomes writable again
   * with no signal to the caller), same discipline as
   * `workspaceHomeRoBindArgs`.
   */
  readonly unboundFence?: {
    readonly mainCheckout: string;
    readonly tmpPad?: string;
  };
  /**
   * ADR-0119 / specs/yolo-mode.md: yolo no-sandbox switch (the whole fence
   * retires).
   *
   * Strict boolean: only `=== true` hits the yolo branch; absent / false /
   * non-boolean all take today's fence path (illegal input stays fail-closed,
   * keeps the fence, does not throw).
   *
   * The yolo branch argv is bare argv: command + args, no bwrap prefix, no
   * netns, no mount, no clearenv / setenv; cwd and env are handed to spawn by
   * the caller (server/index.ts's req.cwd / req.env).
   *
   * Absent (`undefined`) must stay byte-for-byte identical to today (V1
   * baseline regression contract).
   */
  readonly yolo?: boolean;
}

export interface BwrapFence {
  readonly argv: readonly string[];
  readonly sealed: true;
}

/**
 * One `--bind path path` triple; path absent / empty string → not emitted.
 *
 * Used **only** by the two workspace-tier write whitelists (`workspaceRoot` /
 * `tmpRoot`): absence at those layers is a tightening direction (one less
 * writable location = fail-closed), so silent skipping is fine. The home
 * ro-bind layer does not go through this function — its absence is a loosening
 * direction and must fail loud (see `workspaceHomeRoBindArgs`), and its shape
 * differs (`--ro-bind`), so this function takes no flag parameter (YAGNI: the
 * only call site's value is always `--bind`; keeping a union would add one
 * unreachable branch).
 */
function bindArgs(path: string | undefined): string[] {
  return path === undefined || path.length === 0 ? [] : ["--bind", path, path];
}

/**
 * The workspace-tier home ro-bind layer (ADR-0092): this is the tier's defining
 * semantic — home visible but read-only, and this layer is what makes it real.
 *
 * Absent / empty string → **typed fail-loud**, never silent skipping. The
 * distinction from the other two layers:
 *   - skipping `--bind <workspaceRoot>` / `--bind <tmpRoot>` is a **tightening**
 *     direction: one less writable location = fail-closed, no hole;
 *   - skipping `--ro-bind <home>` is a **loosening** direction: the argv
 *     degrades into the global-mode shape, home becomes writable again, and the
 *     caller gets no signal — "home read-only" is the entire reason this tier
 *     exists, so silent degradation swaps a security tier for the default one.
 *
 * Placement rationale: the guard lives in this argv constructor rather than at
 * each call site (`bash.ts` / `sandbox-run.ts` / `background/manager.ts`),
 * because `mode` and `homeRoot` are both parameters here — every call site's
 * mistake funnels through this point. Duplicating the guard at call sites
 * would mean N copies of one policy, with the next new call site reopening the
 * hole (which is exactly the shape this guard fixes). Same discipline as the
 * fs-policy.ts contract root (blank / missing → typed, no spawn).
 */
function workspaceHomeRoBindArgs(
  homeRoot: string | undefined
): readonly string[] {
  if (homeRoot === undefined || homeRoot.length === 0) {
    throw new ToolExecutionError(
      "bwrap: workspace fs mode requires homeRoot; refusing to build a fence that would silently degrade to global mode (home writable)"
    );
  }
  return ["--ro-bind", homeRoot, homeRoot];
}

/**
 * The workspace tier's three mounts (ADR-0092), strictly following
 * last-mount-wins order: `--ro-bind <homeRoot> <homeRoot>` (home visible but
 * read-only) first, then `--bind <workspaceRoot>` + `--bind <tmpRoot>` (the two
 * write whitelists re-covered as writable).
 *
 * Non-workspace mode → no layer is emitted (and no homeRoot guard — the global
 * tier never emits the home ro-bind, so absence is not a degradation there).
 * Home layer absent → typed fail-loud (see `workspaceHomeRoBindArgs`); each
 * write whitelist absent / empty → only that layer is skipped.
 */
function workspaceMountArgs(
  fsPolicy: FsPolicy,
  homeRoot: string | undefined,
  workspaceRoot: string | undefined,
  tmpRoot: string | undefined
): string[] {
  if (fsPolicy.mode !== "workspace") return [];
  return [
    ...workspaceHomeRoBindArgs(homeRoot),
    ...bindArgs(workspaceRoot),
    ...bindArgs(tmpRoot),
  ];
}

/**
 * UNBOUND_FENCE argv segment: `--ro-bind <mainCheckout>` immediately followed
 * by `--bind <tmpPad>` (pad absent/empty → the pad segment is not emitted, a
 * tightening direction: scratch writes hit the read-only main checkout and are
 * refused with EROFS — signalled, no silent hole).
 */
function unboundFenceArgs(
  unboundFence: BwrapFenceOptions["unboundFence"]
): string[] {
  if (unboundFence === undefined) return [];
  const { mainCheckout, tmpPad } = unboundFence;
  if (mainCheckout.length === 0) {
    throw new ToolExecutionError(
      "bwrap: unbound fence requires mainCheckout; refusing to build a fence that would silently leave the main checkout writable"
    );
  }
  return ["--ro-bind", mainCheckout, mainCheckout, ...bindArgs(tmpPad)];
}

/**
 * Global-mode argv (ADR-0092): bind the host root `/` first (real paths
 * visible and writable), then re-bind the system prefixes read-only, then the
 * read-only cwd override, then proc/dev.
 *
 * `--unshare-net` is constant — no input can strip it any more. The `network`
 *
 // (ADR-0097)
 * option has retired from `BwrapFenceOptions`; egress is served by the
 * `egress` unix-socket proxy seam, so the sandbox netns is always isolated.
 * Settled invariant #1 is nailed down at the fence assembly layer.
 *
 * bwrap's last-mount-wins semantics drive the ordering contract:
 *  - `--bind / /` is the base token; every later `--ro-bind` is a narrower
 *    mount that reclaims only its own subtree;
 *  - system prefixes (`/usr /bin /lib /lib64 /etc` plus on-disk `/opt`
 *    `/snap`) are re-bound read-only after the `/` bind;
 *  - `--ro-bind <cwd> <cwd>` (cwdReadonly) must come AFTER the `/` bind;
 *  - the workspace-mode block (`workspaceMounts`) sits between the system
 *    block and the cwd override — see `workspaceMountArgs` for its order;
 *  - the egress socket bind (`--bind <unixSocket> <unixSocket>`) sits
 *    between workspaceMounts and cwdReadonly/proc/dev — it is the last
 *    writable mount of the pre-cwd block;
 *
 // (ADR-0097)
 *  - the unbound fence block (`--ro-bind <mainCheckout>` then
 *    `--bind <tmpPad>`) sits at the very end of the mount chain, after
 *    cwdReadonly and before proc/dev — the read-only main checkout is the
 *    physical guarantee that replaces prediction-based bash blocking, and
 *    the session tmp pad re-binds writable on top of it;
 *  - there is no session-tmp bind at guest `/tmp` and no per-root writable
 *    bind list — the session tmp keeps its host path (ADR-0092).
 */
function baseArgs(
  cwd: string,
  cwdReadonly: boolean,
  workspaceMounts: readonly string[],
  egressBind: readonly string[],
  unboundBind: readonly string[]
): string[] {
  return [
    "--unshare-user-try",
    // `--unshare-net` is constant. No conditional, no escape
    // (ADR-0097)
    // hatch. The only path to the host network is the egress unix socket
    // seam — netns isolation is the sole fence-layer control axis.
    "--unshare-net",
    "--die-with-parent",
    // Host root: real paths visible and writable.
    "--bind",
    "/",
    "/",
    // System block: fixed prefixes from fs-policy's single source + optional
    // host prefixes existence-skipped. Re-binds the toolchain read-only over
    // the writable `/` base.
    ...READ_ONLY_SYSTEM_PATHS.flatMap((path) => ["--ro-bind", path, path]),
    ...optionalHostRoBindArgs(),
    // The workspace tier's three layers are computed by the caller and spliced
    // in as one block: after the system block, before cwdReadonly and
    // proc/dev (mount order: the last writable binds sit here).
    ...workspaceMounts,
    // Egress seam: proxy unix socket `--bind`, bundled relay assets ro-bind
    // (ADR-0097)
    // (ADR-0107), credential-fence binds (masked store / trust bundle /
    // masked-file over the real path / deny covers over /dev/null) and the
    // conditional SSH agent socket bind — all after workspaceMounts and before
    // cwdReadonly; the socket segment uses src=dest (host path → same path in
    // the sandbox).
    // The sandbox-side half-bridge (the bundled node relay prepended to the
    // command chain, TCP-LISTEN:3128 → unix socket CONNECT, see
    // egress/session.ts buildInnerBridgeScript) connects to that socket and
    // forwards 127.0.0.1:3128 traffic back to the host proxy (ADR-0107: no socat).
    ...egressBind,
    // cwdReadonly: EROFS override after the `/` bind (orthogonal to the
    // workspace tier's three layers; when the unbound segment is present it
    // sits in the final segment between this line and proc/dev).
    ...(cwdReadonly ? ["--ro-bind", cwd, cwd] : []),
    // UNBOUND_FENCE: main-checkout ro override + session tmp pad rw re-cover,
    // always at the very end of the mount chain (after all writable binds,
    // before --proc/--dev-bind).
    ...unboundBind,
    "--proc",
    "/proc",
    "--dev-bind",
    "/dev",
    "/dev",
  ];
}

/**
 * Egress seam argv block: the unix socket `--bind`, the ADR-0107 bundled relay
 *
 // (ADR-0097)
 * assets ro-bind, the credential-fence bind table (masked-file covers, masked
 * store directory, trust bundle, F3 deny's `/dev/null` covers) and the
 * conditional SSH agent socket bind — all live here, positions unchanged:
 * after workspaceMounts, before cwdReadonly, last-mount-wins covering the real
 * paths under the root bind / home ro-bind.
 *
 * Empty / absent `unixSocketPath` → the socket triple is not emitted
 * (`--unshare-net` stays constant; there is no host-net direct branch).
 * Absent / empty `binds` → no extra binds are emitted. The triple shape
 * `--bind <src> <dest>` has `src=dest=unixSocketPath`, the same form as the
 * workspace-tier write whitelists (`bindArgs`), but deliberately not folded
 * into it (that helper's semantics are "omission of a workspace write
 * whitelist is a tightening direction"; here omission is fail-closed but
 * **never** falls back to host-net — the two must not mix). Credential binds
 * are always `--ro-bind` (read-only: the store directory INVARIANT = not
 * writable from inside the fence).
 *
 * ADR-0107 bundled relay assets: when `spec.relayAssetsDir` is present (always
 * present — sessions carry it) a `--ro-bind <dir> <dir>` follows the egress
 * socket bind (read-only — relay script paths resolve inside the fence, but
 * assets cannot be rewritten by fenced commands).
 *
 * Conditional SSH seam: only when `spec.sshAuthSockPath` is present (open
 * state) does this same egress bind segment **append** a final
 * `--bind <agentSocket> <agentSocket>` (src=dest, in-sandbox path unchanged,
 * matching the same-value `SSH_AUTH_SOCK` reference in `spec.env`); closed
 * state leaves the field absent → this segment is byte-identical to the
 * no-SSH shape (apart from the relay ro-bind segment). All binds stay after
 * workspaceMounts and before cwdReadonly — relative order within the segment =
 * egress socket first, relay assets second, credential-fence binds third,
 * agent socket last (the observer's read order is the assembly causal order:
 * the seam is the body, the relay is its built-in part, credential binds are
 * the data plane on the seam, the agent socket is the conditional credential
 * seam).
 */
function egressBindArgs(spec: EgressFenceSpec | undefined): string[] {
  if (spec === undefined) return [];
  const { unixSocketPath, relayAssetsDir, sshAuthSockPath, binds } = spec;
  const out: string[] = [];
  if (typeof unixSocketPath === "string" && unixSocketPath.length > 0) {
    out.push("--bind", unixSocketPath, unixSocketPath);
  }
  // ADR-0107 bundled relay assets: `--ro-bind <dir> <dir>` (src=dest,
  // separate argv items). The script paths referenced by the in-fence
  // `innerBridgeScript` / ProxyCommand resolve through this — no dependence
  // on the install root happening to sit in the default-visible subtree.
  // Read-only: fenced commands can never rewrite the in-fence relay assets.
  if (typeof relayAssetsDir === "string" && relayAssetsDir.length > 0) {
    out.push("--ro-bind", relayAssetsDir, relayAssetsDir);
  }
  // Credential-fence binds (masked store / trust bundle / masked-file over the
  // real path / deny covers over /dev/null), always `--ro-bind`, each emitted
  // as its own argv items.
  for (const bind of binds ?? []) {
    out.push("--ro-bind", bind.src, bind.dest);
  }
  if (typeof sshAuthSockPath === "string" && sshAuthSockPath.length > 0) {
    out.push("--bind", sshAuthSockPath, sshAuthSockPath);
  }
  return out;
}

export function createBwrapFence(opts: BwrapFenceOptions): BwrapFence {
  // ADR-0119 / specs/yolo-mode.md: yolo branch — the whole fence retires.
  //
  // Strict `=== true` check (illegal input stays fail-closed, keeps the fence,
  // does not throw). All four routes (foreground bash / background spawn /
  // verify sandbox-run / subagent worker) go through this factory, so retiring
  // the fence here is automatically transparent to all four — no re-check at
  // each call site.
  //
  // bare argv: no bwrap prefix / netns / mount / clearenv / setenv emitted.
  // cwd and env are handed to spawn by the caller (server/index.ts's req.cwd /
  // req.env). The egress seam is skipped wholesale under yolo (no socket bind,
  // no proxy env) — no fence means no netns, so the domain allowlist does not
  // intervene (ADR-0119 ruling 3).
  //
  // This early return also precedes the ADR-0109 `unboundFence` ro-bind: since
  // the entire fence is gone, its physical main-checkout guarantee is inside the
  // yolo exemption by construction (bare argv wins over ro-bind; see the
  // ADR-0119 Amendment).
  if (opts.yolo === true) {
    return Object.freeze({
      argv: Object.freeze([opts.command, ...opts.args]),
      sealed: true as const,
    });
  }
  // Egress env injection: spec.env is the session-computed proxy
  // (ADR-0097)
  // keys + NO_PROXY; the fence splices them into its own envArgs (same form as
  // the whitelisted env), and `--clearenv` still precedes every setenv.
  const mergedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.env)) {
    if (typeof v === "string") mergedEnv[k] = v;
  }
  if (opts.egress !== undefined) {
    for (const [k, v] of Object.entries(opts.egress.env)) {
      if (typeof v === "string") mergedEnv[k] = v;
    }
  }
  const envArgs = Object.entries(mergedEnv).flatMap(([name, value]) =>
    value === undefined ? [] : ["--setenv", name, value]
  );
  const argv = [
    "bwrap",
    ...baseArgs(
      opts.cwd,
      opts.cwdReadonly === true,
      // The workspace-tier session tmp bind source is passed explicitly by the
      // caller (opts.tmpRoot). `fsPolicy.tmpRoot()` does not fall back
      // implicitly at the bwrap layer — otherwise the "absent" boundary of
      // opts.tmpRoot === undefined could not be distinguished from "equal to
      // fsPolicy's value". The bash handler / defaultBackgroundSpawn /
      // makeDefaultRunVerify compute the session tmp absolute path via
      // fsPolicy.tmpRoot() before assembling the fence and pass it in.
      workspaceMountArgs(
        opts.fsPolicy,
        opts.homeRoot,
        opts.workspaceRoot,
        opts.tmpRoot
      ),
      egressBindArgs(opts.egress),
      // UNBOUND_FENCE segment (tail of the mount chain, before proc/dev).
      unboundFenceArgs(opts.unboundFence)
    ),
    // --clearenv must precede every --setenv so the sandbox inherits only the
    // whitelisted entries, never the host env (bwrap otherwise copies the whole
    // environment of the process that launches it).
    "--clearenv",
    ...envArgs,
    "--chdir",
    opts.cwd,
    "--",
    opts.command,
    ...opts.args,
  ];
  // `--unshare-net` is constant and this layer keeps no parameter surface that
  // (ADR-0097)
  // could strip it (the retired network-policy argument was the old fence's
  // only removal dependency); egress is served by the `egress` unix socket
  // proxy seam (ownership / dispose contract).
  return Object.freeze({ argv: Object.freeze(argv), sealed: true as const });
}

export type { BwrapFence as BwrapFencePolicy };
