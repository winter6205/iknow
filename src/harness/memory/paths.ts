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
 * 两个参数是**两个决策**,调用方分开推(ADR-0037 §4 amended 2026-08-31):
 *  - `namespaceRoot`(第一参)决定**目录名** `<basename>-<sha1>` —— 项目身份,
 *    今日 = 项目 cwd;会话改绑后仍是启动时钉下的那个身份,不跟 task worktree。
 *  - `anchorRoot`(第二参)决定**落哪个根** —— 今日 = workspaceRoot(`--workspace-root`
 *    重定向由此生效);仅当它自身已是 task worktree 时由装配层退到 productRoot。
 * `~` tilde 仍指向 `homedir()`(全局),与 anchorRoot 解耦(ADR-0019 Quiddity)。
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
  namespaceRoot: string,
  anchorRoot?: string,
  env?: Readonly<Record<string, string | undefined>>
): string {
  const normalized = resolve(namespaceRoot);
  const hash = createHash("sha1").update(normalized).digest("hex").slice(0, 12);
  const root = anchorRoot ?? resolveWorkspaceRoot({ cwd: normalized, env });
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
