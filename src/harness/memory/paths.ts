/**
 * #121 T2 + ADR-0019 (T2): memory dir path resolvers (Paths bounded context).
 *
 * Spec: specs/121-memory-injection.md (Project Structure paths.ts, SC 6,
 * Boundaries Always — user-level root decoupled from --data-dir).
 *
 * Naming rule reuses session-store.ts:42-45
 * `<basename(cwd)>-<sha1(cwd)[:12]>` and lives under
 * `<workspaceRoot>/.iknow/memory/` (per-root, ADR-0019 D1.4 follow-on).
 * Pure: no IO. Both resolvers accept an explicit `workspaceRoot`; when
 * omitted they fall back to `resolveWorkspaceRoot()` (T1 SSOT) which
 * defaults to `process.cwd()`.
 *
 * T2 在保留 `cwd` 作为 hash 输入的同时把磁盘根切到 workspaceRoot,实现
 * "per-root memory" 决策(ADR-0019 plan T2 列项)。`~` tilde 仍指向
 * `homedir()`(全局),与 workspaceRoot 解耦(ADR-0019 Quiddity)。
 */
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { resolveWorkspaceRoot } from "../../config/workspace-root.js";

/**
 * Project namespace under the per-root memory root. Normalize cwd first
 * (path.resolve) so `foo` and `./foo` collapse to the same hash, and so the
 * digest is stable across calls. `workspaceRoot` defaults to the resolver's
 * default (priority chain `[explicit, env, cwd]`).
 *
 * review-fix (H1/H2): 接受可选 env 透传给 resolver —— 当调用方没有
 * 显式 workspaceRoot 时,仍能读 env SSOT(IknowEnv.workspaceRoot)而非
 * 裸 process.env(否则 .env / .env.local 加载的 IKNOW_WORKSPACE_ROOT
 * 会被丢掉,与 env SSOT fidelity 契约冲突)。
 */
export function resolveProjectMemoryDir(
  cwd: string,
  workspaceRoot?: string,
  env?: Readonly<Record<string, string | undefined>>
): string {
  const normalized = resolve(cwd);
  const hash = createHash("sha1").update(normalized).digest("hex").slice(0, 12);
  const root = workspaceRoot ?? resolveWorkspaceRoot({ cwd: normalized, env });
  return join(root, ".iknow", "memory", `${basename(normalized)}-${hash}`);
}

/**
 * Per-root user-level memory root (`<workspaceRoot>/.iknow/memory`).
 * Independent of cwd and --data-dir.
 *
 * review-fix (H1/H2): 接受可选 env 透传(与 resolveProjectMemoryDir 同形态)。
 */
export function resolveUserMemoryDir(
  workspaceRoot?: string,
  env?: Readonly<Record<string, string | undefined>>
): string {
  const root = workspaceRoot ?? resolveWorkspaceRoot({ env });
  return join(root, ".iknow", "memory");
}
