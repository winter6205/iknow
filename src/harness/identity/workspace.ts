/**
 * Workspace initialization + state.json state machine.
 *
 * Responsibility: eager + idempotent init of the `~/.iknow/` directory; seed
 * user.md (USER_TEMPLATE, from `./user-template.ts`); seed state.json
 * (bootstrap_seeded:false); seed BOOTSTRAP.md (BOOTSTRAP_TEMPLATE, when
 * bs=false, aligned with ohmo initialize_workspace); read / write state.json
 * (single-field PATCH + atomic write). On the read path, JSON corruption /
 * schema mismatch → skip + warn, never blocking assembly.
 *
 * Locked constraint: never create identity.md / soul.md files (the cognitive
 * and persona layers are code constants, see `identity.ts` / `soul.ts`);
 * user.md is user-editable and never overwritten after seeding.
 */

import path from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";

import {
  resolveWorkspaceRoot,
  type ResolveWorkspaceRootOpts,
} from "../../config/workspace-root.js";
import { USER_TEMPLATE } from "./user-template.js";
import { BOOTSTRAP_TEMPLATE } from "./bootstrap.js";

/**
 * Per-root `.iknow` under `resolveWorkspaceRoot()` (`[explicit, env, cwd]`,
 * default `process.cwd()`). Kept for memory / sessions / settings callers.
 * Persona seed (user.md / BOOTSTRAP.md / identity state.json) does **not**
 * use this helper — those files live at `userHome/.iknow`.
 */
export function iknowWorkspaceRoot(opts?: ResolveWorkspaceRootOpts): string {
  return path.join(resolveWorkspaceRoot(opts), ".iknow");
}

/** Schema-versioned state.json (schema migrations reserved). */
export interface IknowStateV1 {
  readonly schema_version: 1;
  readonly bootstrap_seeded: boolean;
}

/** Assembly error taxonomy (degradation contract). */
export type IknowIdentityError =
  | { kind: "state_parse_failed"; path: string; reason: string }
  | { kind: "state_schema_invalid"; path: string; field: string }
  | { kind: "write_failed"; path: string; cause: string }
  | { kind: "io_error"; path: string; cause: string };

/** Default state returned on read-path degradation (no field confirmed). */
function defaultState(): IknowStateV1 {
  return {
    schema_version: 1,
    bootstrap_seeded: false,
  };
}

function stateFilePath(workspace: string): string {
  return path.join(workspace, "state.json");
}

function userFilePath(workspace: string): string {
  return path.join(workspace, "user.md");
}

/** BOOTSTRAP.md path (aligned with ohmo `get_bootstrap_path`).
 *  Read-only after seeding; completion = the file is deleted, no host hook. */
export function bootstrapFilePath(workspace: string): string {
  return path.join(workspace, "BOOTSTRAP.md");
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

/** Schema field validation: any violation → warn + return undefined. */
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
  return {
    schema_version: 1,
    bootstrap_seeded: obj.bootstrap_seeded,
  };
}

/** Parse disk content into state; JSON corruption / schema mismatch → warn + default state. */
function parseStateOrDefault(content: string, p: string): IknowStateV1 {
  return tryParseState(content, p) ?? defaultState();
}

/** Parse failure / schema mismatch → undefined (lets the write path decide on self-heal). */
function tryParseState(content: string, p: string): IknowStateV1 | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    const e = err as Error;
    console.warn(
      `[iknow-identity] state.json parse failed (${p}): ${e.message}`
    );
    return undefined;
  }
  if (raw === null || typeof raw !== "object") {
    console.warn(`[iknow-identity] state.json schema invalid (${p}): root`);
    return undefined;
  }
  return validateStateFields(raw as Record<string, unknown>, p);
}

/** Read state.json; missing / JSON corruption / schema mismatch → default state. */
export async function readIknowState(
  workspace?: string
): Promise<IknowStateV1> {
  const ws = workspace ?? path.join(homedir(), ".iknow");
  const p = stateFilePath(ws);
  const content = await readIfExists(p);
  if (content === undefined) return defaultState();
  return parseStateOrDefault(content, p);
}

/** Atomic write: temp + rename, preventing half-written JSON corruption. */
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
      /* tmp may already be gone; ignore */
    }
    throw {
      kind: "write_failed",
      path: p,
      cause: e.message ?? String(err),
    } satisfies IknowIdentityError;
  }
}

/** Write state.json: single-field PATCH + atomic write. */
export async function writeIknowState(
  patch: Partial<Omit<IknowStateV1, "schema_version">>,
  workspace?: string
): Promise<IknowStateV1> {
  const ws = workspace ?? path.join(homedir(), ".iknow");
  const p = stateFilePath(ws);
  const current = await readIknowState(ws);
  const next: IknowStateV1 = {
    schema_version: 1,
    bootstrap_seeded: patch.bootstrap_seeded ?? current.bootstrap_seeded,
  };
  await atomicWriteJson(p, JSON.stringify(next, null, 2));
  return next;
}

/** Workspace init: eager + idempotent.
 *  - mkdir -p `~/.iknow/` (idempotent)
 *  - write user.md (only when absent; never overwrite user edits)
 *  - write state.json (only when absent; bs=false)
 *  - never create / write identity.ts / soul.ts / bootstrap.ts / BOOTSTRAP.md
 *    (these are code constants)
 *  - never create an identity.md file (merged into soul, no standalone file)
 *
 * Degradation surface: `initIknowWorkspaceSafe()` wraps try/catch + warn; the
 * 4 entry points (chat / serve / tui / ask) call it directly — failure logs
 * and never blocks assembly (user-level file IO failure must not stop the
 * agent from ever running).
 */
export async function initIknowWorkspaceSafe(opts?: {
  workspace?: string;
}): Promise<void> {
  try {
    await initializeIknowWorkspace(opts);
  } catch (err) {
    // IknowIdentityError is a discriminated union: console.warn uniformly and continue.
    console.warn(
      `[iknow-identity] workspace init failed: ${JSON.stringify(err)}`
    );
  }
}

/** Workspace init: eager + idempotent. */
export async function initializeIknowWorkspace(opts?: {
  workspace?: string;
}): Promise<{ root: string; state: IknowStateV1 }> {
  // `opts.workspace` is a fake-home test / isolation seam (the `.iknow`
  // directory itself), **not** workspaceRoot. Default = `<homedir>/.iknow`.
  const root = opts?.workspace ?? path.join(homedir(), ".iknow");
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
    // First init: seed state (bs=false) + seed BOOTSTRAP.md, then flip the
    // flag to true (aligned with ohmo initialize_workspace: flip the flag at
    // the same decision point that writes BOOTSTRAP.md, so later builds never
    // re-seed an already-deleted file).
    const seed: IknowStateV1 = {
      schema_version: 1,
      bootstrap_seeded: false,
    };
    await atomicWriteJson(sp, JSON.stringify(seed, null, 2));
    await seedBootstrapFile(root);
    const complete: IknowStateV1 = { ...seed, bootstrap_seeded: true };
    await atomicWriteJson(sp, JSON.stringify(complete, null, 2));
    return { root, state: complete };
  }

  // File exists but JSON is corrupt / schema mismatch → self-heal:
  // back the original up to .corrupt.<random>, write a fresh valid seed,
  // return the seed. A valid file stays untouched (idempotent; never wipe
  // already-seeded state).
  const parsed = tryParseState(stateExisting, sp);
  if (parsed === undefined) {
    console.warn(
      `[iknow-identity] state.json invalid, backing up and re-seeding (${sp})`
    );
    const backup = `${sp}.corrupt.${randomBytes(6).toString("hex")}`;
    try {
      await fs.rename(sp, backup);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      throw {
        kind: "io_error",
        path: sp,
        cause: e.message ?? String(err),
      } satisfies IknowIdentityError;
    }
    const seed: IknowStateV1 = {
      schema_version: 1,
      bootstrap_seeded: false,
    };
    await atomicWriteJson(sp, JSON.stringify(seed, null, 2));
    await seedBootstrapFile(root);
    const complete: IknowStateV1 = { ...seed, bootstrap_seeded: true };
    await atomicWriteJson(sp, JSON.stringify(complete, null, 2));
    return { root, state: complete };
  }

  // Valid state stays untouched (idempotent). bs=true is the archive marker
  // that seeding completed (aligned with ohmo); after seeding we never
  // re-create files — completion is driven by BOOTSTRAP.md's absence (the
  // assembly layer reads the file), not by re-seeding.
  return { root, state: parsed };
}

/** Seed BOOTSTRAP.md (write only when the file is absent; idempotent, never
 *  overwrite user edits). Aligned with ohmo initialize_workspace: write the
 *  guidance file on first start; after the guidance conversation the agent
 *  rm's it itself. The caller flips bs to true at the same decision point. */
async function seedBootstrapFile(root: string): Promise<void> {
  const bp = bootstrapFilePath(root);
  const existing = await readIfExists(bp);
  if (existing !== undefined) return;
  await atomicWriteJson(bp, BOOTSTRAP_TEMPLATE);
}
