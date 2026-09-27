/**
 * src/harness/isolation/worktree-gate.ts
 *
 * ADR-0037 (amended 2026-08-30).
 * Mutate gate at the harness executor seam. Model-provision contract:
 * when the isolation switch is ON and the session is still on the main
 * checkout, the first workspace-mutating tool call is BLOCKED — the gate
 * NEVER provisions. Creating the per-conversation task worktree and rebinding
 * the session root is the model's job via the create-worktree ACI tool — the
 * block message says exactly that. Once the session root moved to
 * its task worktree (host rebuilds the engine at that root), mutates are
 * adjudicated per conversation by the host `provision` seam: the session's
 * own tree is a same-root no-op passthrough, a foreign root fails closed.
 *
 * Module boundary (ACR bounded-context-guardian):
 *   - this module owns ONLY the gate + git layer; it holds no session state
 *     beyond the per-conversation adjudication latch, reads no settings and
 *     imports no session-api code. The host (session-api) supplies the
 *     `provision` callback; the deterministic task-worktree path shape
 *     (`isTaskWorktreePath`) and identity (`taskWorktreeOwnerOf`) live here
 *     because the gate routes on them — session-api re-exports them as the
 *     single SSOT.
 *
 * Failure semantics (ADR-0037 §6, fail-closed):
 *   - every failure exits as a typed `WorktreeIsolationError` (non-empty,
 *     visible message) and the intercepted call NEVER reaches the tool
 *     handler — the main repo gets zero writes;
 *   - the unbound block is side-effect free and idempotent: every mutate
 *     re-blocks with the ACI-tool notice until the model provisions and the
 *     host rebinds. The only outbound edge on that branch is the
 *     host-supplied `onUnboundBlockedCall` notification seam — the gate
 *     itself performs no record IO, the host owns persistence.
 *
 * Switch OFF → `createWorktreeIsolationExecutor` is not wired by the
 * assembly (build-engine), i.e. byte-identical to today's behavior.
 *
 * ADR-0096 (amends ADR-0037): the switch is a live holder. The TUI /config
 * panel flips it in-session and persists it to the user layer; the gate reads
 * it once per wave. Flipping ON does NOT auto-provision — the unbound-mutate
 * block (and its create-worktree hint) is still the only reaction. Flipping
 * OFF restores main-repo writes on the next wave.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { errorMessage } from "../errors.js";
import { VIOLATION_PREFIXES } from "../permission/prefixes.js";
import { FILE_WRITE_TOOL_NAMES } from "../aci/tools/symbol-mutate.js";
import type { LiveTaskRoot } from "../session-roots.js";
import type {
  Executor,
  ToolCall,
  ToolExecutionResult,
} from "../tools/types.js";
import { gateBlockNotice } from "./recoverability.js";

/** Visible message prefix for every gate-produced block (SSOT for tests). */
export const WORKTREE_ISOLATION_PREFIX = "[worktree_isolation]";

/**
 * Hint the gate emits on unbound mutates (model-provision contract): the
 * model must call the create-worktree ACI tool — the gate never
 * auto-creates. The tool name/registration must align with this wording
 * (ADR-0082: the registered name is `create-worktree`).
 */
export const CREATE_WORKTREE_TOOL_HINT = "create-worktree ACI tool";

/**
 * Root-flip lifecycle block notice: a mutate arriving
 * after an enter/exit-worktree call in the SAME wave would be adjudicated
 * on the wave-entry snapshot while its handler would consume the flipped
 * cell — the admit-but-write-other-root window this rule forbids. Fail-closed: the
 * call is not executed; the model re-issues it in the next wave.
 */
export function rootFlipMutateNotice(toolName: string): string {
  return (
    `${WORKTREE_ISOLATION_PREFIX} workspace mutation blocked: ${toolName} in this ` +
    `wave of tool calls changed the session's active root, and this call was ` +
    `adjudicated against the root from before that change. The call was not ` +
    `executed — re-issue it in the next wave of tool calls in this run, which ` +
    `will adjudicate against the new root.`
  );
}

/**
 * Unbound-mutate block notice. Three semantic pieces (spec
 * locked spec semantics, amended):
 *
 *   (a) conditional — "To write, ..." names the condition under which the
 *       named tool applies (this is the piece that the 2026-09-08 amendment
 *       added as a hard semantic assertion; the pre-amendment text only said
 *       "the tool exists", which is why the previous implementation passed
 *       every substring ban while delivering no actionable next step);
 *   (b) re-issue guidance — the model retries THIS SAME call after the
 *       create-worktree flip; the call is the thing that should land
 *       in the new root, not a different call;
 *   (c) effect timing — "the next wave of tool calls in this run" per
 *       ADR-0037 §7.5 wording discipline (binds the re-issue to the wave
 *       after the rebind, never "next turn" — turnCount is per assistant
 *       round, not per run).
 *
 * Plus the three substring bans that survive verbatim: literal
 * `create-worktree`, no `this conversation's task worktree`, and the
 * factual `This call would write` opener. The notice is intentionally one
 * text — it never splits by user question type (one wording for every kind
 * of user question).
 */
export function unboundMutateNotice(): string {
  return (
    `${WORKTREE_ISOLATION_PREFIX} This call would write the workspace, and it was not executed: ` +
    `worktree isolation is ON and this session is not yet bound to a task worktree. ` +
    `The main repo stays read-only. To write, call the ${CREATE_WORKTREE_TOOL_HINT} ` +
    `to put this session on a writable root, then re-issue this same call — it ` +
    `will land in the new root on the next wave of tool calls in this run ` +
    `(no auto-provisioning).`
  );
}

/**
 * issue 1059 — EROFS feedback for the UNBOUND_FENCE state. A bash command
 * that tried to write the (physically read-only) main checkout fails inside
 * the fence with `Read-only file system` in stderr; this builder turns that
 * into one actionable guidance line: the typed `[fs_denied]` prefix
 * (VIOLATION_PREFIXES SSOT), the state explanation, the create-worktree
 * unbind path (same ACI-tool hint as the block notice), re-issue guidance,
 * and the attempted-path clues — the raw stderr lines that carried the
 * EROFS error (capped, so the model sees WHICH paths were hit). When a clue
 * targets git metadata (a `.git` path), the action sentence is the distinct
 * gitdir wording from ADR-0109 (build the tree first, run the git
 * command from the task tree) instead of the plain-file re-issue text — one
 * contract, never a shared vague notice. Returns undefined when stderr shows
 * no EROFS line: the caller then leaves the result byte-identical (never
 * silent, never noisy).
 *
 * The guidance rides in the ok-envelope stderr (F4 ssh-hostkey precedent),
 * NOT a typed failure: `categorizeResult` only counts `execution_failed`
 * kinds, so appending here surfaces the state to the model without opening
 * a new violation-counting tier (DESIGN item 4).
 */
const EROFS_UNBOUND_PATTERN = /Read-only file system/;

/**
 * gitdir path clue: a `.git` path segment bounded on both sides (slash,
 * quote, bracket, whitespace, comma, colon, or a line edge). The trailing
 * boundary keeps `.gitignore` / `.github` from a false hit.
 */
const GIT_META_PATH_PATTERN = /(^|[\\/[\s"',(=:])\.git($|[\\/)\]\s"',:])/;

function gitMetadataHit(lines: readonly string[]): boolean {
  return lines.some((line) => GIT_META_PATH_PATTERN.test(line));
}

export function unboundFenceErofsGuidance(stderr: string): string | undefined {
  const lines = stderr
    .split("\n")
    .filter((line) => EROFS_UNBOUND_PATTERN.test(line));
  if (lines.length === 0) return undefined;
  const shown = lines.slice(0, 5);
  const rest = lines.length - shown.length;
  const action = gitMetadataHit(shown)
    ? `This write targets git metadata (a .git path) of the read-only main ` +
      `checkout: call the ${CREATE_WORKTREE_TOOL_HINT} first, then run the same ` +
      `git command from inside the task tree — it will land in that tree's own ` +
      `gitdir on the next wave of tool calls in this run. `
    : `To write, call the ${CREATE_WORKTREE_TOOL_HINT} ` +
      `to put this session on a writable root, then re-issue this same command — it ` +
      `will land in the new root on the next wave of tool calls in this run. `;
  return (
    `${VIOLATION_PREFIXES.fsDenied} the workspace is read-only in this session: ` +
    `worktree isolation is ON and this session is not yet bound to a task worktree, ` +
    `so the main checkout is mounted read-only inside the sandbox fence and the writes ` +
    `above failed at the filesystem layer. ${action}` +
    `Attempted paths (from stderr): ${shown.join(" | ")}` +
    (rest > 0 ? ` (+${rest} more EROFS lines)` : "")
  );
}

/**
 * issue 1059 (review repair M1) — the background spawn carries the same
 * physical ro-bind fence, but a detached task's stderr never reaches the
 * tool result, so the EROFS guidance cannot ride there at runtime. The
 * state is instead disclosed on the spawn receipt (preflight notice,
 * appended only in the UNBOUND_FENCE state; bound / gate-OFF receipts stay
 * byte-identical). A workspace write surfaces verbatim as
 * “Read-only file system” in the task log; the exit is the same
 * create-worktree path.
 */
export function unboundFenceBackgroundNotice(): string {
  return (
    `${VIOLATION_PREFIXES.fsDenied} preflight: the main checkout is mounted ` +
    `read-only for this background command (worktree isolation ON, session ` +
    `unbound); writes to the workspace fail inside the task log with ` +
    `“Read-only file system”. To write, call the ${CREATE_WORKTREE_TOOL_HINT} ` +
    `first and spawn this command again from the task tree.`
  );
}

/** Typed failure kinds (ADR-0037 §6 / plan hard req 6–8). */
export type WorktreeIsolationErrorKind =
  | "not_a_git_repo"
  | "git_unavailable"
  | "branch_exists"
  | "worktree_exists"
  | "worktree_add_failed"
  | "rebind_failed"
  /**
   * Session root is a git worktree that is NOT this conversation's own task
   * worktree (another session's task tree, or an unrelated manual worktree).
   * Fail-closed choice: the isolation contract (ADR-0037) only defines the
   * main repo and the session's own task tree, so a foreign root never gets a
   * nested tree and never sees a write.
   */
  | "foreign_worktree"
  /**
   * Enter-worktree: the requested target task worktree does not
   * exist (no directory at `<repoRoot>/.iknow/worktrees/<conversationId>`).
   * Distinct from `foreign_worktree` so the model can tell "wrong id / tree
   * never created" apart from "tree exists but belongs elsewhere".
   */
  | "worktree_not_found"
  | "ambiguous_worktree"
  | "worktree_list_failed"
  | "worktree_status_failed"
  | "worktree_dirty"
  | "unpublished_commits"
  | "current_worktree"
  | "worktree_remove_failed"
  | "branch_delete_failed"
  /**
   * ADR-0070 — `enter-worktree`
   * Pre-occupancy check: the target tree is already pointed at by
   * **another live session record's** `workspaceRoot`. Claim criterion = the
   * `workspaceRoot` of existing session records (zero new persisted state);
   * release = resume that session and let it `exit-worktree`, or delete that
   * session record (the two explicit ways out). Classified
   * `operator_required` — the model cannot release someone else's claim (the
   * exhaustive table in recoverability.ts guarantees the stop instruction is
   * wired in automatically).
   */
  | "worktree_claimed";

/**
 * Typed, non-empty, visible error for every gate failure. Mirrors the
 * `SubAgentSandboxRootError` convention (readonly name + typed context) and
 * the plain-object discriminant discipline of `WorkspaceRootError` — callers
 * branch on `kind`, never on message parsing.
 */
export class WorktreeIsolationError extends Error {
  override readonly name = "WorktreeIsolationError";
  readonly kind: WorktreeIsolationErrorKind;
  /** Message without the typed prefix — reused verbatim in gate blocks. */
  readonly detail: string;

  constructor(kind: WorktreeIsolationErrorKind, detail: string) {
    super(`WorktreeIsolationError: ${kind} — ${detail}`);
    this.kind = kind;
    this.detail = detail;
  }
}

// -- git layer -----------------------------------------------------------------

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Git runner seam. Implementations return the process result for normal
 * exits; a spawn failure (git binary missing) must THROW so the gate can
 * map it to `git_unavailable` distinctly from "not a repository".
 */
export type GitRunner = (
  args: readonly string[],
  cwd: string
) => Promise<GitResult>;

/**
 * Production runner: `git <args>` in `cwd`. Spawn errors propagate as throws.
 *
 * A runner with its own cwd semantics must strip the GIT_DIR /
 * GIT_WORK_TREE-style env a parent git process injects (e.g. when iknow is
 * started inside a hook subprocess): those variables pin `rev-parse` and
 * friends onto the parent repo regardless of cwd, so the probe would no
 * longer report the repo opts.cwd points at.
 */
export const defaultGitRunner: GitRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_COMMON_DIR",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_PREFIX",
      "GIT_SUPER_PREFIX",
      "GIT_CEILING_DIRECTORIES",
    ]) {
      delete env[key];
    }
    execFile(
      "git",
      [...args],
      { cwd, encoding: "utf8", env },
      (err, stdout, stderr) => {
        if (
          err &&
          (err as NodeJS.ErrnoException).code !== undefined &&
          typeof (err as NodeJS.ErrnoException).code === "number"
        ) {
          // git exited non-zero — a normal result, not a spawn failure
          resolve({
            code: err.code as number,
            stdout: String(stdout),
            stderr: String(stderr),
          });
          return;
        }
        if (err) {
          reject(err);
          return;
        }
        resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
      }
    );
  });

export interface CreateWorktreeOpts {
  /** Repository (or linked worktree) the task worktree branches from. */
  readonly repoRoot: string;
  /** Absolute target path for the new worktree; must not exist. */
  readonly worktreePath: string;
  /** New branch name; must not exist (fail-closed, ADR-0037 §3). */
  readonly branch: string;
  /**
   * Owning conversation. When set, written to the linked worktree gitdir
   * sidecar so labeled name-only leaves can invert identity without encoding
   * the id in the folder name.
   */
  readonly conversationId?: string;
  readonly runGit?: GitRunner;
}

export interface TaskWorktree {
  readonly worktreePath: string;
  readonly branch: string;
}

/**
 * Create a task worktree on a NEW branch, deterministically and fail-closed:
 *
 *   1. `rev-parse --git-common-dir` (usable-gitdir probe, ADR-0037 §6
 *      amendment 2026-09-07) — no usable gitdir → `not_a_git_repo`; git
 *      binary missing → `git_unavailable`. A bare gitdir or a
 *      `core.bare=true` checkout with working files IS a usable repo (the
 *      criterion is the ability to `worktree add`, not working files on the
 *      root); only directories without a gitdir fail here.
 *   2. branch already exists → `branch_exists` (never repointed/overwritten;
 *      never checked out into another worktree's place — hard req ①/②).
 *   3. worktree path exists → `worktree_exists`.
 *   4. `worktree add -b <branch> <path>` — failure → `worktree_add_failed`
 *      with git's stderr in the message (e.g. a bare gitdir with no commits
 *      has no HEAD to branch from).
 *
 * The source repo's HEAD and current branch are never moved: `-b` creates the
 * branch at HEAD and checks it out only in the new worktree. Every failure
 * happens before any path is created (zero side effects on the main root).
 */
export async function createTaskWorktree(
  opts: CreateWorktreeOpts
): Promise<TaskWorktree> {
  const runGit = opts.runGit ?? defaultGitRunner;
  const { repoRoot, worktreePath, branch } = opts;

  let probe: GitResult;
  try {
    probe = await runGit(["rev-parse", "--git-common-dir"], repoRoot);
  } catch (err) {
    throw new WorktreeIsolationError(
      "git_unavailable",
      `git is not available (spawn failed): ${errorMessage(err)}`
    );
  }
  if (probe.code !== 0 || probe.stdout.trim().length === 0) {
    throw new WorktreeIsolationError(
      "not_a_git_repo",
      `not a usable git repository (no gitdir found; worktree isolation requires one): ${repoRoot}${
        probe.stderr.trim().length > 0 ? ` — ${probe.stderr.trim()}` : ""
      }`
    );
  }

  let branchProbe: GitResult;
  try {
    branchProbe = await runGit(
      ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
      repoRoot
    );
  } catch (err) {
    throw new WorktreeIsolationError(
      "git_unavailable",
      `git is not available (spawn failed): ${errorMessage(err)}`
    );
  }
  if (branchProbe.code === 0) {
    // `branch_exists` detail must be
    // unique (one actionable next step per receipt). Two sub-cases by
    // whether the target directory is on disk:
    //   - directory EXISTS (e.g. previous worktree remove left a branch behind
    //     — `remove-worktree` defaults to NOT deleting the branch) → defer
    //     to the same three-arm logic as `worktree_exists`; the branch is
    //     bound to a real directory, so `enter-worktree` is reachable;
    //   - directory MISSING → the branch is orphaned (no linked worktree); an
    //     `enter-worktree` would unconditionally hit `worktree_not_found`
    //     and produce a second empty turn. Detail MUST NOT mention
    //     `enter-worktree` here; only "pick a different label" or "ask
    //     the operator to delete the branch" are reachable next moves.
    throw new WorktreeIsolationError(
      "branch_exists",
      existsSync(worktreePath)
        ? `task branch '${branch}' already exists and is bound to ${worktreePath}; ` +
            worktreeGuidance(worktreePath, opts.conversationId)
        : `task branch '${branch}' already exists with no linked worktree; pick a different label, or ask the operator to delete the branch (no silent overwrite)`
    );
  }

  if (existsSync(worktreePath)) {
    throw new WorktreeIsolationError(
      "worktree_exists",
      `task worktree path already exists: ${worktreePath}; ` +
        worktreeGuidance(worktreePath, opts.conversationId)
    );
  }

  let add: GitResult;
  try {
    add = await runGit(
      ["worktree", "add", "-b", branch, worktreePath],
      repoRoot
    );
  } catch (err) {
    throw new WorktreeIsolationError(
      "git_unavailable",
      `git is not available (spawn failed): ${errorMessage(err)}`
    );
  }
  if (add.code !== 0) {
    throw new WorktreeIsolationError(
      "worktree_add_failed",
      `git worktree add failed for ${worktreePath} (branch ${branch}): ${
        add.stderr.trim().length > 0 ? add.stderr.trim() : `exit ${add.code}`
      }`
    );
  }
  const conversationId = opts.conversationId;
  if (conversationId !== undefined && conversationId.length > 0) {
    writeOwnerSidecar(worktreePath, conversationId);
  }
  return { worktreePath, branch };
}

// -- mutate classification -------------------------------------------------------

export type MutateClass = "mutate" | "read" | "root_flip";

/**
 * Root-flip lifecycle tools (enter / exit). They do not write workspace
 * files, but their handlers resolve the withLiveTaskRootWrite-wrapped host
 * enter/exit seams, which FLIP the live `taskRoot` cell mid-wave. A mutate
 * later in the same wave would otherwise be adjudicated on the wave-entry
 * snapshot while its handler consumes the flipped cell — the
 * admit-but-write-other-root window this rule forbids. The gate therefore tracks
 * these calls and fail-closes every subsequent mutate in the wave.
 */
const ROOT_FLIP_TOOLS: ReadonlySet<string> = new Set([
  "enter-worktree",
  "exit-worktree",
]);

/**
 * Workspace-mutation classifier SSOT.
 * Single source of truth for "does this tool write to the workspace":
 *
 *   - the canonical list of workspace-writing tool names comes from
 *     `FILE_WRITE_TOOL_NAMES` (symbol-mutate.ts), which is the SAME frozen
 *     list the worker deny-list (catalog.ts) uses and the same set the
 *     registry's Gate-3 append-only check enforces — one name → one
 *     classification, no shadow copies;
 *   - bash is adjudicated by issue 1059's physical-guarantee flip: in the
 *     unbound state bash commands are NO LONGER prediction-blocked — the
 *     main checkout is mounted read-only inside the bwrap fence, so the
 *     filesystem itself answers the write question. Every string command
 *     classifies `read`; only a non-string / blank command fails closed to
 *     `mutate` (it cannot be reasoned about at all). `validateReadonlyCommand`
 *     remains untouched as the SSOT for `bashMode === "readonly"` (bash.ts);
 *   - read-only tools (read_file / grep / glob / web_fetch / memory_recall /
 *     etc.) and control / lifecycle tools (create-worktree /
 *     spawn_subagent / todo_write / …) do not write workspace files and
 *     default to `read`;
 *   - the enter/exit lifecycle tools (enter-worktree / exit-worktree)
 *     are classified `root_flip`: they do not write workspace files, but their
 *     handlers flip the live `taskRoot` cell mid-wave (via the wrapped host
 *     seams), so the gate latches the flip and fail-closes later mutates in
 *     the same wave. create-worktree is NOT in that set: its
 *     wrapped-provision flip only happens on a wave that started at the main
 *     repo, where every mutate is already blocked by the unbound branch.
 *
 * Before this classifier the gate used a hardcoded 2-name set (`ALWAYS_MUTATE_TOOLS`),
 * which left the 5 symbol-mutate tools (`rename_symbol` etc.) unclassified
 * → they passed the gate and edited the main repo directly (fail-open).
 * The classifier closes that hole by routing on `FILE_WRITE_TOOL_NAMES`, the same SSOT
 * already used by the worker deny-list (catalog.ts) — one name → one
 * classification, no shadow copies.
 *
 * Note on `spawn_subagent`: this default treats it as `read`, but the gate
 * installed by `build-engine.ts:849-872` (`classifyWithSubagentIsolation`)
 * overrides that with a role-aware decision (ADR-0040). That override
 * belongs to the build-engine seam, not the SSOT classifier — it composes
 * with this function via the `classify` opt.
 */
export function classifyCall(call: ToolCall): MutateClass {
  if (ROOT_FLIP_TOOLS.has(call.name)) return "root_flip";
  if ((FILE_WRITE_TOOL_NAMES as ReadonlyArray<string>).includes(call.name)) {
    return "mutate";
  }
  if (call.name === "bash") {
    const command = (call.input as { command?: unknown } | null)?.command;
    // issue 1059: prediction is replaced by the physical ro-bind fence, so
    // any parseable command is a `read` as far as this gate cares. A blank
    // or non-string command carries no provable intent and stays mutate.
    if (typeof command !== "string") return "mutate";
    return command.trim().length === 0 ? "mutate" : "read";
  }
  return "read";
}

// -- task worktree naming and path shape -----------------------------------------

/**
 * Human-facing task-worktree labels are deliberately narrower than
 * conversation ids. The `--` separator is banned in new labels so it can
 * still invert historical `<slug>--<conversationId>` leaves; new labeled
 * leaves do not encode identity in the folder name.
 */
export const SAFE_WORKTREE_SLUG_RE =
  /^(?=.{2,40}$)(?!.*--)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export interface TaskWorktreeLabelResolution {
  readonly label: string | undefined;
  readonly reason?: string;
}

/**
 * Resolve a model-supplied label once for all path/branch consumers.
 * Invalid values intentionally fall back to the historical UUID-only shape.
 */
export function resolveTaskWorktreeLabel(
  name: unknown
): TaskWorktreeLabelResolution {
  if (name === undefined) return { label: undefined };
  if (typeof name !== "string") {
    return {
      label: undefined,
      reason: "name must be a string",
    };
  }
  if (name.length > 40) {
    return {
      label: undefined,
      reason: "name exceeds the maximum length of 40 characters",
    };
  }
  if (!SAFE_WORKTREE_SLUG_RE.test(name)) {
    return {
      label: undefined,
      reason:
        "name must be lowercase kebab-case, 2-40 characters, with alphanumeric edges and no consecutive hyphens",
    };
  }
  return { label: name };
}

/**
 * Build the task-worktree path. This is the naming SSOT shared by the
 * provisioner, enter/list/remove consumers, and the isolation gate's
 * ownership inversion.
 *
 * A valid label is the leaf (`<slug>`). conversationId is not encoded in
 * the folder name; identity is the gitdir sidecar (and the historical
 * `<slug>--<conversationId>` / UUID-only leaves still invert from the path).
 * Duplicate labels collide on this path and fail closed at `worktree_exists`.
 */
export function taskWorktreePath(
  repoRoot: string,
  conversationId: string,
  label?: string
): string {
  const resolved = resolveTaskWorktreeLabel(label);
  const leaf = resolved.label === undefined ? conversationId : resolved.label;
  return join(repoRoot, ".iknow", "worktrees", leaf);
}

/** Build the task branch name from the same validated label decision. */
export function taskWorktreeBranch(
  conversationId: string,
  label?: string
): string {
  const resolved = resolveTaskWorktreeLabel(label);
  return resolved.label === undefined
    ? `iknow/task-${conversationId}`
    : `iknow/task/${resolved.label}-${conversationId.slice(0, 8)}`;
}

const OWNER_SIDECAR_NAME = "iknow-conversation-id";

/**
 * True when `root` is shaped as `<any>/.iknow/worktrees/<leaf>`.
 * Shape only — not identity. Labeled name-only leaves still match.
 */
export function isTaskWorktreePath(root: string): boolean {
  if (root.length === 0) return false;
  return (
    basename(dirname(root)) === "worktrees" &&
    basename(dirname(dirname(root))) === ".iknow"
  );
}

function parseGitdirPointer(gitMeta: string): string | undefined {
  const match = /^gitdir:\s*(.+)$/m.exec(gitMeta);
  const gitdir = match?.[1]?.trim();
  return gitdir !== undefined && gitdir.length > 0 ? gitdir : undefined;
}

function writeOwnerSidecar(worktreePath: string, conversationId: string): void {
  const gitFile = join(worktreePath, ".git");
  let gitMeta: string;
  try {
    gitMeta = readFileSync(gitFile, "utf8");
  } catch (err) {
    throw new WorktreeIsolationError(
      "worktree_add_failed",
      `task worktree ${worktreePath} has no readable .git pointer after add: ${errorMessage(err)}`
    );
  }
  const gitdir = parseGitdirPointer(gitMeta);
  if (gitdir === undefined) {
    throw new WorktreeIsolationError(
      "worktree_add_failed",
      `task worktree ${worktreePath} .git pointer is not a gitdir file; cannot record conversation ownership`
    );
  }
  try {
    writeFileSync(join(gitdir, OWNER_SIDECAR_NAME), `${conversationId}\n`, {
      encoding: "utf8",
    });
  } catch (err) {
    throw new WorktreeIsolationError(
      "worktree_add_failed",
      `cannot write ownership sidecar for ${worktreePath}: ${errorMessage(err)}`
    );
  }
}

function ownerFromGitdirSidecar(root: string): string | undefined {
  const gitFile = join(root, ".git");
  if (!existsSync(gitFile)) return undefined;
  let gitMeta: string;
  try {
    gitMeta = readFileSync(gitFile, "utf8");
  } catch {
    // EXIT: .git pointer unreadable — fall through to path inversion
    return undefined;
  }
  const gitdir = parseGitdirPointer(gitMeta);
  if (gitdir === undefined) return undefined;
  const sidecar = join(gitdir, OWNER_SIDECAR_NAME);
  if (!existsSync(sidecar)) return undefined;
  try {
    const id = readFileSync(sidecar, "utf8").trim();
    return SAFE_CONVERSATION_ID_RE.test(id) ? id : undefined;
  } catch {
    // EXIT: sidecar unreadable — fall through to path inversion
    return undefined;
  }
}

/** Return the decorative label from a task-worktree leaf, if present. */
export function taskWorktreeLabelOf(root: string): string | undefined {
  if (!isTaskWorktreePath(root)) return undefined;
  const leaf = basename(root);
  const separator = leaf.lastIndexOf("--");
  if (separator > 0) {
    const label = leaf.slice(0, separator);
    const owner = leaf.slice(separator + 2);
    return SAFE_CONVERSATION_ID_RE.test(owner) &&
      resolveTaskWorktreeLabel(label).label === label
      ? label
      : undefined;
  }
  const sidecarOwner = ownerFromGitdirSidecar(root);
  if (
    sidecarOwner !== undefined &&
    sidecarOwner !== leaf &&
    resolveTaskWorktreeLabel(leaf).label === leaf
  ) {
    return leaf;
  }
  return undefined;
}

/**
 * Ownership anchor for task-worktree naming.
 *
 * Identity sources, first match wins:
 *   1. gitdir sidecar `iknow-conversation-id` (name-only labeled leaves);
 *   2. historical `<slug>--<conversationId>` suffix;
 *   3. UUID-only / unlabeled leaf (the whole basename).
 */
export function taskWorktreeOwnerOf(root: string): string | undefined {
  if (!isTaskWorktreePath(root)) return undefined;
  const sidecar = ownerFromGitdirSidecar(root);
  if (sidecar !== undefined) return sidecar;
  const leaf = basename(root);
  const separator = leaf.lastIndexOf("--");
  const owner = separator === -1 ? leaf : leaf.slice(separator + 2);
  return SAFE_CONVERSATION_ID_RE.test(owner) ? owner : undefined;
}

/**
 * Single actionable guidance tail for the `worktree_exists` kind (and the directory-present
 * sub-case of `branch_exists`). Returns ONLY the next-step phrase so each
 * caller can compose its own opener (`worktree_path_already_exists` /
 * `branch_already_exists_and_is_bound_to_<path>`). The kind stays
 * machine-readable through `gateBlockNotice`, so this helper is the
 * human-facing half — one phrase, one move.
 *
 * Three arms by `taskWorktreeOwnerOf(worktreePath)`:
 *   - owner === `selfConversationId` (this session's own tree) → point at
 *     `enter-worktree` (single, unambiguous move);
 *   - owner !== `selfConversationId` (a real, known other session owns the
 *     tree) → either `enter-worktree` (explicit adoption) or use a
 *     different label;
 *   - owner undefined (no sidecar / off-shape directory / labeled leaf with
 *     no recorded owner) → point at `list-worktrees` to discover who
 *     owns it.
 *
 * A labeled-only leaf (`<slug>` with no `<slug>--<convId>` separator and no
 * sidecar) is treated as "owner unknown" — the leaf itself can be a valid
 * kebab-case label (matching `SAFE_CONVERSATION_ID_RE` by accident), so
 * `taskWorktreeOwnerOf` cannot prove ownership from the leaf alone. Such a
 * directory is a foreign object (e.g. an orphan left behind by some prior
 * session or operator action); `enter-worktree` would then race against
 * a missing durable owner record, so the receipt must send the model to
 * `list-worktrees` first.
 *
 * Sidecar I/O failures (non-ENOENT) fall through `ownerFromGitdirSidecar`
 * returning undefined; this helper then takes the third arm without
 * throwing — fail-closed-to-discovery rather than fail-closed-to-error.
 */
export function worktreeGuidance(
  worktreePath: string,
  selfConversationId: string | undefined
): string {
  let owner: string | undefined;
  try {
    owner = taskWorktreeOwnerOf(worktreePath);
  } catch {
    // EXIT: defensive — `taskWorktreeOwnerOf` is designed never to throw,
    // but if a future refactor changes that, we degrade to discovery rather
    // than letting a typed error double-fire on top of the existing kind.
    owner = undefined;
  }
  // Labeled-only leaf with no sidecar: owner === leaf is just the label
  // string matching `SAFE_CONVERSATION_ID_RE` by accident, not a real
  // conversation id. Treat as unknown — point at list-worktrees so
  // the model can pick the right move (own / foreign / nothing).
  const leaf = basename(worktreePath);
  const isHistoricalLeaf = leaf.lastIndexOf("--") > 0;
  const sidecar = (() => {
    try {
      return ownerFromGitdirSidecar(worktreePath);
    } catch {
      return undefined;
    }
  })();
  const ownerIsLabelOnly =
    owner !== undefined && !isHistoricalLeaf && sidecar === undefined;
  const effectiveOwner = ownerIsLabelOnly ? undefined : owner;
  if (effectiveOwner !== undefined && effectiveOwner === selfConversationId) {
    return `this worktree belongs to this session (owner ${effectiveOwner}); use enter-worktree to bind this session to it`;
  }
  if (effectiveOwner !== undefined) {
    return `this worktree is owned by another session (${effectiveOwner}); either call enter-worktree to explicitly adopt it, or pick a different label`;
  }
  return `owner is unknown (no sidecar or off-shape worktree); run list-worktrees to discover who owns it before retrying`;
}

/**
 * ADR-0037 §4: the stable main checkout
 * that owns `root` — `root` itself when it is not task-worktree-shaped,
 * otherwise the repo three levels up (`<main>/.iknow/worktrees/<leaf>`).
 *
 * This is the `productRoot` derivation hosts need when they hold **only** a
 * session root: after a rebind (and after a restart that resumes a session
 * already anchored on a tree) the session root is the tree, and identity /
 * per-root state must still resolve to the main checkout. Same naming SSOT as
 * `isTaskWorktreePath`, so it is a pure path derivation — no git call, no
 * `process.cwd()` fallback.
 */
export function mainCheckoutOf(root: string): string {
  return isTaskWorktreePath(root) ? dirname(dirname(dirname(root))) : root;
}

/**
 * issue 1059 — UNBOUND_FENCE decision helper: the exact condition under
 * which a bash fence must physically `--ro-bind` the main checkout (gate ON
 * and the live wave root is the main checkout, i.e. NOT a task worktree).
 * Returns the main checkout path to bind read-only, or undefined when the
 * session is bound (or the gate is off) and the fence shape stays byte-
 * identical to before. One predicate, three consumers (foreground bash,
 * background spawn, verify run) so the assembly seams can never diverge
 * from the gate's own unbound-state notion (G3 set-equality discipline).
 */
export function unboundFenceMainCheckout(args: {
  gateOn: boolean;
  root: string;
}): string | undefined {
  if (!args.gateOn) return undefined;
  if (isTaskWorktreePath(args.root)) return undefined;
  return args.root;
}

// -- gate executor ----------------------------------------------------------------

/**
 * Segment-safety gate for conversation ids that reach a worktree path or
 * branch name (SSOT; session-api worktree-rebind re-exports it). Contract:
 * first char alphanumeric; remainder alphanumeric / `_` / `-` — rejects path
 * traversal (`..`, `a/b`), leading dashes/dots, whitespace / shell
 * metacharacters, and empty strings. The enter-worktree tool runs
 * this against its model-supplied `conversationId` BEFORE any host call.
 */
export const SAFE_CONVERSATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface WorktreeProvisionContext {
  /** Owning conversation (from the executor call chain); undefined = anonymous. */
  readonly conversationId?: string;
  /** This engine's root (the session's current root when the turn started). */
  readonly root: string;
  /**
   * Optional model-supplied task label. The provisioner validates it against
   * `SAFE_WORKTREE_SLUG_RE`; invalid labels are deliberately discarded rather
   * than turning a recoverable tool call into a protocol failure.
   */
  readonly name?: unknown;
  /**
   * Layer 1 (specs/subagent-layers-worktree-deps.md items 2–3) — optional
   * result channel for side effects that happen WHILE provisioning but must
   * reach the model-facing tool result.
   *
   * Why a callback instead of a wider return type: the provision seam
   * resolves with a plain root string, and its result is consumed as a root
   * by the gate (`gateMutate`), the live-taskRoot wrapper, the hub dirty-root
   * protocol, and ~50 test doubles across 8 files (counted: 52
   * `provision:`-shaped fixtures). Widening the resolved value would ripple
   * through all of them for a line that only ONE caller (the `create-worktree`
   * tool) can even display. The hosting tool supplies this callback; the
   * provisioner calls it at most once with a human-readable line. Absence is
   * the normal case for every other caller and must change nothing.
   */
  readonly report?: (line: string) => void;
}

/**
 * Host provision seam shape (SSOT): resolves with the rebound session root
 * (the task worktree path); rejects with typed `WorktreeIsolationError`.
 * Shared by the gate's host opts, the `create-worktree` ACI tool deps,
 * and the session-api provisioner — no per-module structural copies.
 */
export type WorktreeProvisionFn = (
  ctx: WorktreeProvisionContext
) => Promise<string>;

/**
 * Explicit-enter seam context: a session (conversationId) anchored at the
 * main repo (root) adopts the EXISTING task worktree owned by
 * `targetConversationId`. The target path is resolved from the repository's
 * task-worktree listing, using either the owner's id or a unique label; the
 * tool takes a selector, never a free-form path.
 */
export interface WorktreeEnterContext {
  /** Calling conversation (the session that moves onto the target tree). */
  readonly conversationId?: string;
  /** The caller's current engine root — the main repo (path SSOT base). */
  readonly root: string;
  /** Owner conversation id whose task worktree to enter. */
  readonly targetConversationId: string;
}

/**
 * Host enter seam shape (SSOT): resolves with the entered task worktree
 * path; rejects with typed `WorktreeIsolationError`
 * (worktree_not_found / foreign_worktree / rebind_failed / git_unavailable).
 * Shared by the host opts, the `enter-worktree` ACI tool deps, and the
 * session-api provisioner — no per-module structural copies.
 */
export type WorktreeEnterFn = (
  ctx: WorktreeEnterContext
) => Promise<WorktreeEnterResult>;

/**
 * The enter seam returns the rebound
 * root AND the composed success receipt. `path` is what the live taskRoot
 * cell and the durable rebind record consume; `receipt` is the model-facing
 * success text, composed by the host seam (session-api) — it appends the
 * creator disclosure only when the tree's owner sidecar yields an owner, and
 * omits the sentence otherwise. Disclosure is constant-on and reads no
 * setting (specs/worktree-exclusive-lock.md).
 */
export interface WorktreeEnterResult {
  /** The entered (rebound) task worktree root. */
  readonly path: string;
  /** Composed model-facing success receipt (includes the disclosure when known). */
  readonly receipt: string;
}

/**
 * Symmetric-exit seam context: the session (conversationId) currently
 * executing on `root` returns to the main repo root. No target input — the
 * tree is identified by the engine root / the session's durable rebind
 * record; the main repo root is derived from the tree itself.
 */
export interface WorktreeExitContext {
  /** Calling conversation (the session that leaves the task worktree). */
  readonly conversationId?: string;
  /** The caller's current engine root (the task worktree being exited). */
  readonly root: string;
}

/**
 * Host exit seam shape (SSOT): resolves with the session's main repo
 * root; rejects with typed `WorktreeIsolationError` (rebind_failed /
 * git_unavailable). The tree is preserved (orphan cleanup is a plan
 * non-goal). Shared by the host opts, the `exit-worktree` ACI tool
 * deps, and the session-api provisioner — no per-module structural copies.
 */
export type WorktreeExitFn = (ctx: WorktreeExitContext) => Promise<string>;

/** A read-only projection of one task worktree or stale task branch. */
export interface TaskWorktreeInfo {
  /** Human-facing label; absent for legacy UUID-only leaves. */
  readonly label: string | undefined;
  /** Conversation identity recovered from the leaf or branch name. */
  readonly conversationId: string;
  /** Linked checkout path; empty for a branch with no active worktree. */
  readonly path: string;
  /** Local task branch name. */
  readonly branch: string;
  /** HEAD commit at inspection time. */
  readonly head: string;
  /** Whether the linked checkout has visible working-tree changes. */
  readonly dirty: boolean;
  /** Present only when the entry came from an orphaned task branch. */
  readonly stale?: true;
}

export interface WorktreeListContext {
  /** Current engine root; task roots are mapped back to their main checkout. */
  readonly root: string;
  readonly includeStale?: boolean;
}

/** Host seam for the read-only task-worktree listing tool. */
export type WorktreeListFn = (
  ctx: WorktreeListContext
) => Promise<ReadonlyArray<TaskWorktreeInfo>>;

export interface WorktreeRemoval {
  readonly label: string | undefined;
  readonly conversationId: string;
  readonly path: string;
  readonly branch: string;
  readonly head: string;
  readonly branchDeleted: boolean;
}

export interface WorktreeRemoveContext {
  /** Current session root, used to reject removing the caller's active tree. */
  readonly root: string;
  /** Caller conversation id, for audit/context only. */
  readonly conversationId?: string;
  /** A conversation id or a task-worktree label. */
  readonly targetConversationId: string;
  readonly deleteBranch?: boolean;
}

/** Host seam for explicit task-worktree removal. */
export type WorktreeRemoveFn = (
  ctx: WorktreeRemoveContext
) => Promise<WorktreeRemoval>;

/**
 * Host-facing options the assembly (build-engine) threads through: the
 * switch itself is read once at the startup load point
 * (`resolveWorktreeOnMutate(settings)`), the host supplies only the provision
 * seam. Passthrough for a session already on its task worktree is anchored
 * PER CONVERSATION inside `provision` — the host must not blanket-mark
 * an engine "bound" when several conversations can share a root.
 */
export interface WorktreeIsolationHostOpts {
  readonly provision: WorktreeProvisionFn;
  /**
   * Explicit-enter seam (session-api hub / CLI provisioner). Present → the
   * `enter-worktree` ACI tool enters the registry (alongside
   * `create-worktree`); absent (worker assembly, hub-less inlets) →
   * excluded via the Gate 3 mirror filter. The gate itself never calls it —
   * enter is a model-invoked tool, and its durable rebind record is what the
   * `provision` adjudication later adopts.
   */
  readonly worktreeEnter?: WorktreeEnterFn;
  /**
   * Symmetric-exit seam (session-api hub / CLI provisioner). Present →
   * the `exit-worktree` ACI tool enters the registry; absent (worker
   * assembly, hub-less inlets) → excluded via the Gate 3 mirror filter. The
   * gate itself never calls it — exit is a model-invoked tool whose durable
   * rebind record puts the session back under the unbound gate on the main
   * repo.
   */
  readonly worktreeExit?: WorktreeExitFn;
  /**
   * Read-only task-tree discovery. It is intentionally independent from the
   * mutate gate and is registered only when this host supplies the seam.
   */
  readonly worktreeList?: WorktreeListFn;
  /**
   * Explicit task-tree removal. The host performs dirty/unpublished/current
   * root checks before invoking git worktree remove.
   */
  readonly worktreeRemove?: WorktreeRemoveFn;
}

/**
 * ADR-0096 — the `isolation.worktreeOnMutate` switch as a live cell.
 *
 * Mirrors `FsModeContext` / `SubagentCapacityHolder`: the assembly seeds it
 * once from `resolveWorktreeOnMutate(settings)` (hard req 9 — settings are
 * still read exactly once at startup) and the TUI /config panel flips the
 * SAME instance in-session. Consumers read `get()` at their own decision
 * boundary; the gate reads it once per wave.
 *
 * Flipping this holder updates the mutate gate, git-work system segment,
 * worker writeSituation, and spawn isolation classification on the next
 * read. Registry membership of worktree ACI tools stays keyed on host-seam
 * presence, not this switch.
 */
export interface WorktreeOnMutateHolder {
  readonly get: () => boolean;
  readonly set: (on: boolean) => void;
}

/**
 * Read-only consumer view of the `isolation.worktreeOnMutate` switch cell:
 * the get()-only half of `WorktreeOnMutateHolder`. Every downstream seam
 * (bash fence assembly, worker spawn, verify run, hub, TUI panel) declares
 * this instead of re-spelling the structural type (issue 1059 review M3,
 * DRY / single source of truth).
 */
export interface WorktreeGateReader {
  readonly get: () => boolean;
}

/**
 * Construct the switch holder. `initial` is the startup read; non-boolean
 * input falls back to `false` (fail-closed = today's default), and `set`
 * ignores non-boolean input so no caller can push the gate into a
 * non-boolean "armed" state.
 */
export function createWorktreeOnMutateHolder(
  initial: boolean = false
): WorktreeOnMutateHolder {
  let current = initial === true;
  return Object.freeze({
    get: () => current,
    set: (on: boolean) => {
      if (typeof on === "boolean") current = on;
    },
  });
}

export interface WorktreeIsolationGateOpts {
  /**
   * Startup read (hard req 9): assembly passes `resolveWorktreeOnMutate(settings)`.
   *
   * ADR-0096 — this is now a HOLDER (`get()`), not a frozen boolean. The
   * assembly injects the session's live switch cell (the same instance the
   * TUI /config panel flips); the gate reads it ONCE per wave (snapshot
   * discipline — one wave, one switch value), so a panel flip takes effect on
   * the NEXT wave of tool calls, never mid-wave. The gate still NEVER
   * auto-provisions: flipping ON only re-arms the block on unbound mutates
   * (ADR-0037 §1 preserved verbatim).
   *
   * Typed as a read-only view (not `WorktreeOnMutateHolder`): the gate is a
   * consumer, never the setter — the panel / assembly own the write side.
   */
  readonly enabled: WorktreeGateReader;
  /**
   * Live `taskRoot` cell (SSOT). The gate snapshots `cell.read()` ONCE at `executeAll`
   * entry; the whole wave shares that snapshot. Why snapshot, not per-call:
   *
   *   - Batch snapshot: one wave of tool calls may have only one root —
   *     otherwise a create-worktree flipping mid-wave would split a single
   *     logical change across two trees, violating least astonishment. The
   *     rebind therefore takes effect for the **next wave** of tool calls,
   *     not the same wave.
   *   - Ordering invariant: the root used for gate adjudication must equal
   *     the root the consumer uses. Within one wave the cell can be flipped
   *     by lifecycle tools — create-worktree is already blocked by the
   *     pre-gate unbound branch (later mutates in a main-repo wave are
   *     blocked anyway), while enter/exit go straight to inner under the
   *     `root_flip` class and flip the cell through the
   *     `withLiveTaskRootWrite` seam; for mutates after either, the gate
   *     fail-closes on the `rootFlipped` latch (`rootFlipMutateNotice`), so
   *     every admitted mutate's handler reads exactly the snapshot value the
   *     gate adjudicated with — no admit-but-write-other-root window.
   *
   * Writes still go through the single-point host `provision` / `enter` /
   * `exit` wrapped by the `withLiveTaskRootWrite` seam (SSOT) — this field
   * is the **read-side** entry.
   */
  readonly liveTaskRoot: LiveTaskRoot;
  /**
   * Host seam (session-api). Model-provision contract: the gate calls this
   * ONLY for engines rooted at a task-worktree-shaped path (post-rebind), as
   * the per-conversation passthrough adjudicator — the session's own tree
   * resolves to the same root (zero-side-effect no-op), a foreign root
   * rejects with typed `foreign_worktree`. The creation path of the
   * underlying host provisioner is reserved for the create-worktree ACI
   * tool: the gate NEVER routes main-repo traffic here, so no
   * `git worktree add` is ever triggered by a blocked mutate. MUST be
   * idempotent per conversation — the gate coalesces concurrent callers onto
   * one invocation.
   */
  readonly provision: WorktreeProvisionFn;
  /**
   * Engine built on a root that already is a task worktree (rebound engine).
   * Harness-level prior for embeddings that serve EXACTLY the conversation
   * owning this root (e.g. a single-session CLI engine). Multi-conversation
   * hosts (session-api hub) must NOT set it — per-conversation passthrough is
   * adjudicated by `provision` (own task tree → same-root no-op; foreign
   * root → typed `foreign_worktree`).
   *
   * The bound-root is initialised to the wave-entry snapshot of
   * `liveTaskRoot`, so a pre-rebound CLI engine whose cell starts at the
   * task worktree path goes straight to passthrough.
   */
  readonly initiallyBound?: boolean;
  readonly classify?: (call: ToolCall) => MutateClass;
  /** Failure observability (typed error instance; the model still gets the block). */
  readonly onError?: (err: WorktreeIsolationError) => void;
  /**
   * T3 forensic notification — invoked ONLY from the unbound-block branch,
   * once per blocked call, with the call identity and the verbatim block
   * text so the host can persist the interception into its own records.
   * Notification only: the gate stays IO-free, and the block receipt is
   * byte-identical whether or not the seam is supplied.
   */
  readonly onUnboundBlockedCall?: (info: UnboundBlockedCallInfo) => void;
}

interface GateSessionState {
  readonly status: "open" | "pending" | "bound";
  readonly pending?: Promise<string>;
  readonly boundRoot?: string;
}

/**
 * Identity + text handed to the host's `onUnboundBlockedCall` seam when the
 * unbound branch blocks a call. `message` is the verbatim block receipt the
 * model sees, so a forensic record joins back to the conversation turn
 * without re-deriving any text.
 */
export interface UnboundBlockedCallInfo {
  readonly toolName: string;
  readonly toolUseId: string;
  readonly conversationId: string | undefined;
  readonly turnId: string | undefined;
  readonly input: unknown;
  readonly message: string;
}

/**
 * Wrap an executor with the mutate gate (model-provision contract, ADR-0037
 * amendment). Read calls and switch-OFF traffic pass through untouched. For
 * mutates:
 *
 *   - unbound session on a NON-task-worktree root (main repo) → blocked with
 *     the create-worktree ACI-tool notice; `provision` is never called,
 *     so no `git worktree add` runs and the main repo sees zero writes. The
 *     block is side-effect free and idempotent — every mutate re-blocks until
 *     the model provisions via create-worktree and the host rebinds the session root;
 *   - engine rooted at a task-worktree-shaped path → per-conversation
 *     adjudication via `provision`, coalesced onto a single invocation per
 *     conversation (boundary c idempotency):
 *
 *       - provision resolved to this engine's root → passthrough (mutates
 *         land in the worktree the engine is rooted at);
 *       - provision resolved elsewhere → the call is blocked with a visible
 *         rebind notice (stale-root tools must not write the old root);
 *       - provision failed → blocked with the typed `kind=<kind>` message;
 *         state resets so the next mutate retries (still fail-closed).
 */
export function createWorktreeIsolationExecutor(
  opts: WorktreeIsolationGateOpts & { readonly inner: Executor }
): Executor {
  const { enabled, liveTaskRoot, provision, initiallyBound, inner } = opts;
  // ADR-0096: `enabled` is a holder — every read goes through `.get()` at
  // the wave boundary (below); the gate never mutates it (the config panel /
  // assembly own the setter).
  const classify = opts.classify ?? classifyCall;
  const states = new Map<string, GateSessionState>();

  const stateFor = (
    conversationId: string | undefined,
    snapshotRoot: string
  ): GateSessionState => {
    const key = conversationId ?? "";
    const hit = states.get(key);
    if (hit) return hit;
    const fresh: GateSessionState = initiallyBound
      ? { status: "bound", boundRoot: snapshotRoot }
      : { status: "open" };
    states.set(key, fresh);
    return fresh;
  };

  const setState = (
    conversationId: string | undefined,
    next: GateSessionState
  ): void => {
    states.set(conversationId ?? "", next);
  };

  const block = (toolUseId: string, message: string): ToolExecutionResult => ({
    kind: "execution_failed",
    toolUseId,
    message,
  });

  // Host notification for the unbound-block branch only (kept out of
  // gateMutate: the seam is notify-only, so the block decision path stays
  // as branchless as before).
  const notifyUnboundBlocked = (
    call: ToolCall,
    conversationId: string | undefined,
    turnId: string | undefined,
    message: string
  ): void => {
    opts.onUnboundBlockedCall?.({
      toolName: call.name,
      toolUseId: call.id,
      conversationId,
      turnId,
      input: call.input,
      message,
    });
  };

  const reboundMessage = (boundRoot: string): string =>
    `${WORKTREE_ISOLATION_PREFIX} session workspace rebound to task worktree ${boundRoot}; ` +
    `this call was not executed — the previous root stays read-only. The next wave of tool calls ` +
    `in this run will land in the new root, re-issue the write then.`;

  async function gateMutate(
    call: ToolCall,
    conversationId: string | undefined,
    snapshotRoot: string,
    turnId: string | undefined
  ): Promise<ToolExecutionResult | undefined> {
    let state = stateFor(conversationId, snapshotRoot);
    if (state.status === "bound" && state.boundRoot === snapshotRoot) {
      return undefined; // passthrough
    }
    // Model-provision contract: a session on a non-task-worktree root
    // (main repo) can never be bound — block with the ACI-tool notice and
    // NEVER provision (no `git worktree add` on the execution path). The
    // block is side-effect free; state stays open so later mutates re-block.
    // The host seam below only notifies — persistence is the host's, and
    // the block receipt itself is unchanged with or without a subscriber.
    //
    // `root` here is the **wave snapshot** of `liveTaskRoot` taken at
    // executeAll entry. mid-wave flips (create-worktree) do not
    // change this snapshot — rebind takes effect on the NEXT wave.
    if (state.status === "open" && !isTaskWorktreePath(snapshotRoot)) {
      const message = unboundMutateNotice();
      notifyUnboundBlocked(call, conversationId, turnId, message);
      return block(call.id, message);
    }
    if (state.status === "open") {
      const pending = provision({ conversationId, root: snapshotRoot });
      setState(conversationId, { status: "pending", pending });
      state = { status: "pending", pending };
    }
    if (state.status === "pending") {
      let boundRoot: string;
      try {
        boundRoot = await state.pending!;
      } catch (err) {
        const typed =
          err instanceof WorktreeIsolationError
            ? err
            : new WorktreeIsolationError("rebind_failed", errorMessage(err));
        opts.onError?.(typed);
        setState(conversationId, { status: "open" }); // retry allowed, still fail-closed
        // Route through the single seam that carries the Recoverability
        // policy (`operator_required` stop-directive vs not). See
        // isolation/recoverability.ts.
        return block(call.id, gateBlockNotice(typed.kind, typed.detail));
      }
      setState(conversationId, { status: "bound", boundRoot });
      if (boundRoot === snapshotRoot) return undefined; // already home
      return block(call.id, reboundMessage(boundRoot));
    }
    // bound elsewhere (defensive: host rebound the session away from this root)
    return block(call.id, reboundMessage(state.boundRoot ?? snapshotRoot));
  }

  const runAll = async (
    calls: ReadonlyArray<ToolCall>,
    signal?: AbortSignal,
    timeoutMs?: number,
    conversationId?: string,
    onSettled?: (
      result: ToolExecutionResult,
      index: number
    ) => void | Promise<void>,
    turnId?: string,
    onStream?: (event: import("../stream.js").HarnessStreamEvent) => void,
    messages?: import("../tools/types.js").ToolExecutionContext["messages"],
    parentThinking?: import("../tools/types.js").ToolExecutionContext["parentThinking"]
  ): Promise<ReadonlyArray<ToolExecutionResult>> => {
    // ADR-0096 — wave snapshot for the SWITCH as well: read the holder
    // ONCE at wave entry. A panel flip (ON→OFF / OFF→ON) therefore applies to
    // the next wave, never mid-wave — same one-wave-one-value rule the live
    // taskRoot snapshot below follows.
    if (!enabled.get()) {
      return inner.executeAll(
        calls,
        signal,
        timeoutMs,
        conversationId,
        onSettled,
        turnId,
        onStream,
        messages,
        parentThinking
      );
    }
    // Snapshot live taskRoot ONCE at executeAll entry. The whole wave
    // shares this value so:
    //   (a) mid-wave flips (create-worktree) cannot split the wave
    //     between two roots — one wave = one root (least astonishment);
    //   (b) gate adjudication root == consumer handler root (invariant:
    //     gate admits → consumer writes to the same root). Within a single
    //     wave the cell can be flipped by the lifecycle tools (create- /
    //     enter- / exit-worktree) whose handlers resolve the wrapped
    //     host seams. Those calls go through inner directly (classified
    //     "read" / "root_flip", not "mutate"), and mutates AFTER a
    //     enter/exit flip are fail-closed blocked below (rootFlipped latch),
    //     so a handler's `cell.read()` at call time observes the same root
    //     the gate adjudicated for that call.
    const snapshotRoot = liveTaskRoot.read();
    let anyMutate = false;
    for (const call of calls) {
      if (classify(call) === "mutate") {
        anyMutate = true;
        break;
      }
    }
    if (!anyMutate) {
      return inner.executeAll(
        calls,
        signal,
        timeoutMs,
        conversationId,
        onSettled,
        turnId,
        onStream,
        messages,
        parentThinking
      );
    }
    // mixed / mutating batch: per-call gating (read calls still batched one
    // by one so onSettled keeps the input index alignment)
    const out: ToolExecutionResult[] = [];
    // Enter/exit-worktree are classified `root_flip`
    // — they pass through to inner but their handlers flip the live cell
    // mid-wave via the withLiveTaskRootWrite-wrapped host seams. A mutate
    // AFTER such a call would be adjudicated on the wave-entry snapshot
    // while its handler consumes the flipped cell (admit-but-write-other-
    // root window). Fail-closed: the mutate is blocked and re-issued in the
    // next wave. Mutates BEFORE the flip keep the snapshot==cell match.
    let rootFlipped = false;
    let rootFlipTool: string | undefined;
    for (const [index, call] of calls.entries()) {
      let result: ToolExecutionResult;
      const cls = classify(call);
      if (cls === "root_flip") {
        [result] = await inner.executeAll(
          [call],
          signal,
          timeoutMs,
          conversationId,
          undefined,
          turnId,
          onStream,
          messages,
          parentThinking
        );
        rootFlipped = true;
        rootFlipTool = call.name;
      } else if (cls === "read") {
        [result] = await inner.executeAll(
          [call],
          signal,
          timeoutMs,
          conversationId,
          undefined,
          turnId,
          onStream,
          messages,
          parentThinking
        );
      } else if (rootFlipped) {
        result = block(
          call.id,
          rootFlipMutateNotice(rootFlipTool ?? "a root-flip lifecycle tool")
        );
      } else {
        const blocked = await gateMutate(
          call,
          conversationId,
          snapshotRoot,
          turnId
        );
        result =
          blocked ??
          (
            await inner.executeAll(
              [call],
              signal,
              timeoutMs,
              conversationId,
              undefined,
              turnId,
              onStream,
              messages,
              parentThinking
            )
          )[0]!;
      }
      await onSettled?.(result, index);
      out.push(result);
    }
    return out;
  };

  return Object.freeze({
    executeAll: runAll,
  });
}
