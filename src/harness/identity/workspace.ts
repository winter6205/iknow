/**
 * IKNOW-196 Workspace 初始化 + state.json 状态机
 * (spec `specs/196-identity-assembly.md` spec.md:197-236 + spec.md:300-326)。
 *
 * 模块责任:eager + idempotent 初始化 `~/.iknow/` 目录;seed user.md
 * (USER_TEMPLATE,来自 `./user-template.ts`);seed state.json
 * (bootstrap_seeded:false);读 / 写 state.json (PATCH 单字段 +
 * atomic write)。读路径 JSON 损坏 / schema 不匹配 → skip + warn,
 * 不阻塞装配。
 *
 * 锁定约束:不创建 identity.md / soul.md / bootstrap.md 文件
 * (这些是代码常量,见 `identity.ts` / `soul.ts` / `bootstrap.ts`);
 * user.md 是用户可改文件,seed 后不再覆盖。
 */

import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";

import { USER_TEMPLATE } from "./user-template.js";

/** IKNOW-196 workspace 根:复用 #121 homeDir 模式。 */
export function iknowWorkspaceRoot(): string {
  return path.join(os.homedir(), ".iknow");
}

/** Schema-versioned state.json(预留 schema 迁移)。 */
export interface IknowStateV1 {
  readonly schema_version: 1;
  readonly bootstrap_seeded: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

/** IKNOW-196 装配错误分类(降级契约 spec.md:300-326)。 */
export type IknowIdentityError =
  | { kind: "state_parse_failed"; path: string; reason: string }
  | { kind: "state_schema_invalid"; path: string; field: string }
  | { kind: "write_failed"; path: string; cause: string }
  | { kind: "io_error"; path: string; cause: string };

/** 读路径降级返回的默认 state(无任何字段已确认)。 */
function defaultState(): IknowStateV1 {
  return {
    schema_version: 1,
    bootstrap_seeded: false,
    created_at: "",
    updated_at: "",
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function stateFilePath(workspace: string): string {
  return path.join(workspace, "state.json");
}

function userFilePath(workspace: string): string {
  return path.join(workspace, "user.md");
}

async function readIfExists(p: string): Promise<string | undefined> {
  try {
    return await fs.readFile(p, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return undefined;
    throw {
      kind: "io_error",
      path: p,
      cause: e.message ?? String(err),
    } satisfies IknowIdentityError;
  }
}

/** schema 字段校验:任一非法 → warn + 返回 undefined。 */
function validateStateFields(
  obj: Record<string, unknown>,
  p: string
): IknowStateV1 | undefined {
  if (obj.schema_version !== 1) {
    console.warn(
      `[iknow-identity] state.json schema invalid (${p}): schema_version=${String(obj.schema_version)}`
    );
    return undefined;
  }
  if (typeof obj.bootstrap_seeded !== "boolean") {
    console.warn(
      `[iknow-identity] state.json schema invalid (${p}): bootstrap_seeded`
    );
    return undefined;
  }
  if (typeof obj.created_at !== "string") {
    console.warn(
      `[iknow-identity] state.json schema invalid (${p}): created_at`
    );
    return undefined;
  }
  if (typeof obj.updated_at !== "string") {
    console.warn(
      `[iknow-identity] state.json schema invalid (${p}): updated_at`
    );
    return undefined;
  }
  return {
    schema_version: 1,
    bootstrap_seeded: obj.bootstrap_seeded,
    created_at: obj.created_at,
    updated_at: obj.updated_at,
  };
}

/** 把磁盘内容解析成 state;JSON 损坏 / schema 不匹配 → warn + 默认 state。 */
function parseStateOrDefault(content: string, p: string): IknowStateV1 {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    const e = err as Error;
    console.warn(
      `[iknow-identity] state.json parse failed (${p}): ${e.message}`
    );
    return defaultState();
  }
  if (raw === null || typeof raw !== "object") {
    console.warn(`[iknow-identity] state.json schema invalid (${p}): root`);
    return defaultState();
  }
  return (
    validateStateFields(raw as Record<string, unknown>, p) ?? defaultState()
  );
}

/** 读取 state.json;不存在 / JSON 损坏 / schema 不匹配 → 默认 state。 */
export async function readIknowState(
  workspace?: string
): Promise<IknowStateV1> {
  const ws = workspace ?? iknowWorkspaceRoot();
  const p = stateFilePath(ws);
  const content = await readIfExists(p);
  if (content === undefined) return defaultState();
  return parseStateOrDefault(content, p);
}

/** Atomic write:temp + rename,防半写 JSON 损坏(spec Boundaries Always)。 */
async function atomicWriteJson(p: string, data: string): Promise<void> {
  const tmp = `${p}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(tmp, data, "utf8");
    await fs.rename(tmp, p);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    try {
      await fs.unlink(tmp);
    } catch {
      /* tmp 可能已不存在,忽略 */
    }
    throw {
      kind: "write_failed",
      path: p,
      cause: e.message ?? String(err),
    } satisfies IknowIdentityError;
  }
}

/** 写 state.json:PATCH 单字段 + updated_at 自动同步;atomic write。 */
export async function writeIknowState(
  patch: Partial<
    Omit<IknowStateV1, "schema_version" | "created_at" | "updated_at">
  >,
  workspace?: string
): Promise<IknowStateV1> {
  const ws = workspace ?? iknowWorkspaceRoot();
  const p = stateFilePath(ws);
  const current = await readIknowState(ws);
  const ts = nowIso();
  const next: IknowStateV1 = {
    schema_version: 1,
    bootstrap_seeded: patch.bootstrap_seeded ?? current.bootstrap_seeded,
    created_at: current.created_at || ts,
    updated_at: ts,
  };
  await atomicWriteJson(p, JSON.stringify(next, null, 2));
  return next;
}

/** IKNOW-196 初始化:eager + idempotent。
 *  - mkdir -p `~/.iknow/`(幂等)
 *  - 写 user.md(仅当不存在;不覆盖用户已改)
 *  - 写 state.json(仅当不存在;bs=false)
 *  - 不创建 / 不写 identity.ts / soul.ts / bootstrap.ts / BOOTSTRAP.md(这些是代码常量)
 *  - 不创建 identity.md 文件(已合并到 soul,不单独存在)
 *
 * 失败降级面:`initIknowWorkspaceSafe()` 封装 try/catch+warn,
 * 4 入口 (chat / serve / tui / ask) 直接调,失败 log + 不阻塞装配
 * (spec Boundaries Always — 用户级文件 IO 失败不应让 agent 永远跑不起来)。
 */
export async function initIknowWorkspaceSafe(): Promise<void> {
  try {
    await initializeIknowWorkspace();
  } catch (err) {
    // IknowIdentityError 是 discriminated union,统一 console.warn + 继续。
    console.warn(
      `[iknow-identity] workspace init failed: ${JSON.stringify(err)}`
    );
  }
}

/** IKNOW-196 初始化:eager + idempotent。 */
export async function initializeIknowWorkspace(opts?: {
  workspace?: string;
}): Promise<{ root: string; state: IknowStateV1 }> {
  const root = opts?.workspace ?? iknowWorkspaceRoot();
  try {
    await fs.mkdir(root, { recursive: true });
  } catch (err) {
    const e = err as Error;
    throw {
      kind: "write_failed",
      path: root,
      cause: e.message ?? String(err),
    } satisfies IknowIdentityError;
  }

  const up = userFilePath(root);
  const userExisting = await readIfExists(up);
  if (userExisting === undefined) {
    await atomicWriteJson(up, USER_TEMPLATE);
  }

  const sp = stateFilePath(root);
  const stateExisting = await readIfExists(sp);
  if (stateExisting === undefined) {
    const ts = nowIso();
    const seed: IknowStateV1 = {
      schema_version: 1,
      bootstrap_seeded: false,
      created_at: ts,
      updated_at: ts,
    };
    await atomicWriteJson(sp, JSON.stringify(seed, null, 2));
    return { root, state: seed };
  }

  const state = parseStateOrDefault(stateExisting, sp);
  return { root, state };
}
