/**
 * ACI Layer 1: write_file — create or replace a complete file.
 *
 * The target is resolved through the shared workspace containment helper before
 * any filesystem mutation. Whole-file content is written verbatim — the
 * patch-level poka-yoke linter is only applied by edit_file, not here, so
 * legitimately-balanced content containing `{`, `]`, or unclosed quotes inside
 * comments/strings is accepted.
 */

import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { ToolExecutionError } from "../../errors.js";
import type { AciToolDef } from "../types.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import {
  asToolExecutionError,
  FENCE_WRITE_GUIDANCE,
  isWithinRoot,
  resolveWithinRoot,
} from "./helpers.js";
import type { LiveTaskRoot } from "../../session-roots.js";
import { resolveSessionFenceTmp } from "../../sandbox/fence-tmp.js";
import type { LastReadLedgerHost } from "../last-read-ledger.js";

/**
 * ADR-0084 / D1 — last-read 闸的 typed 拒绝（模型可读判据，不只是文案）。
 *
 * 与 `ReadonlyViolationError`（bash-readonly.ts）同形：extends
 * `ToolExecutionError`，executor 的 `sanitizeFailure` 只读 `.message`，
 * 模型面回执逐字节不变。
 *
 * `kind` / `path` 是**测试 / host 接缝**，不在执行器的读取面上：判别「这是
 * 写闸拒绝」而不是别的写失败，靠的是 `instanceof LastReadRequiredError`
 * （测试）或 message 文本。加字段不会改变模型所见。
 *
 * 文案内嵌**规范绝对 path**，与成功回执的 `displayPath`（相对 root）口径不同 ——
 * 这是有意的例外：拒绝后模型要拿这个 path 去 `read_file` 解闸，worktree rebind /
 * 子代理多 root 场景下相对路径会指错树；成功回执只是给人看的短形式，无此风险。
 */
export class LastReadRequiredError extends ToolExecutionError {
  readonly kind = "last_read_required" as const;
  readonly path: string;
  constructor(path: string) {
    super(
      `[write_file] refusing to overwrite a non-empty file that was not read in this conversation: ${path} — call read_file on it first (or delete the file if the overwrite is intended).`
    );
    this.path = path;
  }
}

export interface WriteFileOpts {
  /** Explicit host pad (tests / T3 worker pad). */
  readonly tmpDir?: string;
  /** Session project dir; with `ctx.conversationId` → main-session pad. */
  readonly projectDir?: string;
  /**
   * ADR-0084 last-read ledger host. Present → an existing non-empty target
   * must already be on this conversation's ledger, else typed refuse with no
   * bytes written. Absent → legacy caller (demo / direct factory tests) keeps
   * the pre-ledger behavior; the gate is a registry-level wiring decision.
   */
  readonly lastReadLedger?: LastReadLedgerHost;
}

const TOOL_NAME = "write_file";
const ALLOWED_KEYS = new Set(["path", "content", "create_directories"]);

interface WriteFileInput {
  readonly path: string;
  readonly content: string;
  readonly createDirectories: boolean;
}

function parseInput(input: unknown): WriteFileInput {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ToolExecutionError(
      "[write_file] input must be an object with path and content"
    );
  }

  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new ToolExecutionError(`[write_file] unknown field: ${key}`);
    }
  }
  if (typeof raw.path !== "string" || raw.path.length === 0) {
    throw new ToolExecutionError(
      "[write_file] path must be a non-empty string"
    );
  }
  if (typeof raw.content !== "string") {
    throw new ToolExecutionError("[write_file] content must be a string");
  }
  if (
    raw.create_directories !== undefined &&
    typeof raw.create_directories !== "boolean"
  ) {
    throw new ToolExecutionError(
      "[write_file] create_directories must be a boolean"
    );
  }

  return {
    path: raw.path,
    content: raw.content,
    createDirectories: raw.create_directories ?? true,
  };
}

function displayPath(root: string, target: string): string {
  const path = relative(resolve(root), target);
  return path === "" ? "." : path;
}

/**
 * Task 4 (plans/session-scratch-path-space.md) — 成功回执的路径口径。
 *
 * 交付写（target 在 taskRoot 下）保持既有的相对 taskRoot 短形式，逐字节
 * 不回退。写在会话 tmp 垫底（taskRoot 之外）时，displayPath 会得到 `../`
 * 链、模型抄回 read_file/edit_file 时指错路径 → 改用 canonical 绝对宿主
 * 路径（= resolveWithinRoot 的返回值本身，与 last-read 拒绝内嵌的绝对
 * path 同口径）。垫底比较用 realpath，与 resolveWithinRoot 内部把
 * tmpWriteRoot realpath 后再做 containment 的口径一致；realpath 失败
 * （垫底异常态）→ 退回既有相对形态，不在回执面制造新故障。
 */
async function receiptDisplayPath(
  root: string,
  pad: string | undefined,
  target: string
): Promise<string> {
  if (!isWithinRoot(resolve(root), target) && pad !== undefined) {
    try {
      if (isWithinRoot(await realpath(resolve(pad)), target)) return target;
    } catch {
      // EXIT: 垫底不可 realpath（未知态）→ 不改回执形态。
    }
  }
  return displayPath(root, target);
}

/**
 * Snapshot the live root at handler invocation time. Accepts either a literal
 * path (legacy / forward-compat shape — tests and other one-shot callers pass
 * `string`) or a `LiveTaskRoot` cell (T5: registry threads the cell so that
 * `worktree rebind` in the same run reaches this handler). The returned
 * `string` is the snapshot value — D2 forbids reading the cell more than once
 * per handler call, so callers must reuse the snapshot for both resolve and
 * write.
 */
function readRoot(root: string | LiveTaskRoot): string {
  return typeof root === "string" ? root : root.read();
}

/**
 * Create or wholly overwrite a file below `root`.
 *
 * `create_directories` defaults to true and only controls parent-directory
 * creation; it never changes the whole-file replacement semantics.
 *
 * T5 (plans/worktree-live-task-root.md §6): `root` may be a `LiveTaskRoot`
 * cell; the handler reads the snapshot at call time, so `worktree rebind`
 * in the same run lands new writes in the rebound tree. `string` callers
 * (legacy tests, one-shot consumers) keep byte-identical behavior.
 */
export function createWriteFileTool(
  root: string | LiveTaskRoot,
  opts?: WriteFileOpts
): AciToolDef {
  const handler = async (
    input: unknown,
    ctx?: ToolExecutionContext
  ): Promise<unknown> => {
    const params = parseInput(input);
    // T5 D2: per-call snapshot. resolve 与写入必须共用同一个根值。
    const rootAtCall = readRoot(root);
    const tmpWriteRoot = resolveSessionFenceTmp({
      tmpDir: opts?.tmpDir,
      projectDir: opts?.projectDir,
      conversationId: ctx?.conversationId,
    });

    let target: string;
    try {
      target = await resolveWithinRoot(rootAtCall, params.path, {
        tmpWriteRoot,
      });
    } catch (error) {
      throw asToolExecutionError("[write_file] cannot resolve path", error);
    }

    const parent = dirname(target);
    if (params.createDirectories) {
      try {
        await mkdir(parent, { recursive: true });
      } catch (error) {
        throw asToolExecutionError(
          `[write_file] cannot create parent directory ${parent}`,
          error
        );
      }
    } else {
      let parentInfo: Awaited<ReturnType<typeof stat>>;
      try {
        parentInfo = await stat(parent);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          throw new ToolExecutionError(
            `[write_file] parent directory does not exist: ${parent}`
          );
        }
        throw asToolExecutionError(
          `[write_file] cannot inspect parent directory ${parent}`,
          error
        );
      }
      if (!parentInfo.isDirectory()) {
        throw new ToolExecutionError(
          `[write_file] parent path is not a directory: ${parent}`
        );
      }
    }

    // T4 #298 side-channel:写盘前读旧内容(oldContent);文件不存在 → 空串。
    // 读失败不阻断写入(写盘才是主路径),仅降级 oldContent 为空,保证既有
    // 拒绝语义(父目录缺失 / symlink 逃逸)不受影响 — 此刻 containment 已通过。
    let oldContent = "";
    try {
      oldContent = await readFile(target, "utf8");
    } catch {
      oldContent = "";
    }

    // ADR-0084 last-read 闸:目标已存在且 size>0、本 conversation 账上没有
    // → typed 拒绝、不写盘。新建与空文件免检(D1「非空 write 才查表」)。
    // 判据用 stat 的字节数,不用 oldContent —— oldContent 的读取失败会被
    // best-effort 降级成空串,拿它判「空」会把不可读的非空文件误放行。
    await assertLastRead(opts, ctx, target);

    return commitWrite(target, params, {
      rootAtCall,
      oldContent,
      tmpWriteRoot,
    });
  };

  return Object.freeze({
    name: TOOL_NAME,
    description:
      "Create a new file, or fully overwrite an existing one after read_file has shown its current contents in this conversation; prefer edit_file for surgical changes to an existing file. Overwriting a non-empty existing file requires a prior successful read_file (or a single-file read-only bash such as `cat path`) in the same conversation — an empty or brand-new file needs no prior read. Writes verbatim UTF-8 (no template processing); parent directories auto-created unless create_directories=false. Writes outside the workspace root are out of scope. " +
      FENCE_WRITE_GUIDANCE,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        create_directories: { type: "boolean", default: true },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    handler,
    aci: {
      category: "write" as const,
      isConcurrencySafe: false,
      interruptBehavior: "block" as const,
      timeoutTier: "default" as const,
    },
  });
}

/**
 * ADR-0084 / D1 — 写盘落尾段：写文件、拼回执。抽出来只为让 handler 的
 * 判定链长度回到闸引入之前的形态（S5 ratchet）；顺序与文案形态不变
 * （Task 4 起垫底写的路径口径见 receiptDisplayPath）。
 */
async function commitWrite(
  target: string,
  params: WriteFileInput,
  ctx: {
    readonly rootAtCall: string;
    readonly oldContent: string;
    readonly tmpWriteRoot: string | undefined;
  }
): Promise<unknown> {
  try {
    await writeFile(target, params.content, "utf8");
  } catch (error) {
    throw asToolExecutionError(`[write_file] cannot write ${target}`, error);
  }
  const pathForMessage = await receiptDisplayPath(
    ctx.rootAtCall,
    ctx.tmpWriteRoot,
    target
  );
  return {
    output: `[write_file] wrote ${Buffer.byteLength(params.content, "utf8")} bytes to ${pathForMessage}`,
    meta: { oldContent: ctx.oldContent, newContent: params.content },
  };
}

/**
 * ADR-0084 / D1 — last-read 闸。`target` 已是 containment 通过后的规范绝对
 * path,直接当账本键(与 read_file / 白名单 bash 的入账口径同源:同一个
 * `resolveWithinRoot` 解析结果)。
 *
 * 四条 EXIT:
 *   - **host 缺席**(工厂未接账本:demo / 直接调工厂的测试)→ 不查表,行为与
 *     ADR-0084 之前逐字节一致。闸是否生效是装配层决策,不是工厂的。
 *   - host 在场但 conversationId 缺席 → 已存在且 size>0 一律拒(fail-closed,
 *     spec:无 id 的非空覆写拒绝;禁止隐式进程级全局表)。
 *   - target 不存在 / size==0 → 免检放行。
 *   - 账上有该 path → 放行。
 *
 * stat 失败(EACCES / ELOOP 等)→ 不阻断:只在确知「已存在且非空」时才拒,
 * 未知态交回既有的写路径报错,不在这里制造新的拒绝面。
 */
async function assertLastRead(
  opts: WriteFileOpts | undefined,
  ctx: ToolExecutionContext | undefined,
  target: string
): Promise<void> {
  // EXIT: host 缺席（工厂未接账本，demo / 直接调工厂的测试）→ 闸整体不生效。
  // 与「host 在场但 conversationId 缺席」是两回事 —— 后者 fail-closed。
  const host = opts?.lastReadLedger;
  if (host === undefined) return;
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(target);
  } catch {
    // EXIT: stat 失败（EACCES / ELOOP 等）→ 未知态不在这里制造新拒绝面，
    // 交回既有写路径报错。
    return;
  }
  // EXIT: 新建 / 非普通文件 / 空文件（size==0）→ 免检放行（D1「非空 write 才查表」）。
  if (!info.isFile() || info.size === 0) return;
  // EXIT: 账上有该 path（本 conversation 已读过）→ 放行。
  if (host.ledgerFor(ctx?.conversationId)?.has(target)) return;
  // EXIT: 已存在且非空、账上无读 → typed last_read_required。模型只看到
  // `.message`（executor 只回传 message）；`kind` 供测试 / host 按 `instanceof`
  // 判别，不构成模型面判据。
  throw new LastReadRequiredError(target);
}
