/**
 * src/harness/sandbox/egress/relay-assets.ts
 *
 * ADR-0107 换装：出口中继 = 本仓自带件（`<installRoot>/vendor/egress-relay/`
 * 两枚纯 node .mjs 资产），**socat 不是产品依赖**（ADR-0107 §Decision 5）。
 *
 * 单一职责：解析「中继依赖三件套」= node 绝对路径 + 两枚资产绝对路径（+资产
 * 目录供 fence `--ro-bind`）。路径解析照 vendor/ripgrep 先例锚
 * `resolveInstallRoot()`（`import.meta.url` 上溯 package.json，dev `src/…`
 * 与打包 `dist/…` 同落包根；绝不回退 `process.cwd()`）。
 *
 * node 解析：产品可能跑在 bun 下，`process.execPath` 不保证是 node ——
 * execPath basename 为 `node` 且存在才用，否则 `which node`。两档围栏内
 * 均可执行（global 档 `--bind / /`；workspace 档 home 子树 `--ro-bind`
 * 保留执行位）。解析不到 / 资产缺失 → `undefined`，由 session 层
 * fail-closed（`EgressRelayUnavailableError`）。
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { resolveInstallRoot } from "../../session-roots.js";

/** 资产目录（相对安装根）。fence 把该目录整段 `--ro-bind` 进围栏。 */
export const EGRESS_RELAY_DIR_REL = "vendor/egress-relay";
/** 围栏内 TCP→unix 中继（半桥换装件）。 */
export const EGRESS_TCP_RELAY_FILE = "egress-tcp-relay.mjs";
/** ProxyCommand 用 HTTP CONNECT 隧道件。 */
export const EGRESS_HTTP_CONNECT_FILE = "egress-http-connect.mjs";

/** session / fence 装配消费的中继路径三件套（全部宿主绝对路径）。 */
export interface EgressRelayPaths {
  /** 宿主解析到的 node 绝对路径（命令链前导与 ProxyCommand 共用）。 */
  readonly nodePath: string;
  /** 资产目录（`--ro-bind` 目标，src=dest 同值）。 */
  readonly relayDir: string;
  /** 半桥中继脚本绝对路径。 */
  readonly bridgeScriptPath: string;
  /** CONNECT 隧道脚本绝对路径（进 GIT_SSH_COMMAND argv，token 不进串）。 */
  readonly connectScriptPath: string;
}

/** 给定安装根算资产路径（不查存在性；测试 / 装配层复用形态）。 */
export function egressRelayPathsFor(installRoot: string): {
  relayDir: string;
  bridgeScriptPath: string;
  connectScriptPath: string;
} {
  return {
    relayDir: join(installRoot, EGRESS_RELAY_DIR_REL),
    bridgeScriptPath: join(
      installRoot,
      EGRESS_RELAY_DIR_REL,
      EGRESS_TCP_RELAY_FILE
    ),
    connectScriptPath: join(
      installRoot,
      EGRESS_RELAY_DIR_REL,
      EGRESS_HTTP_CONNECT_FILE
    ),
  };
}

/**
 * node 可执行解析：execPath 是 node（basename 精确匹配，bun 下不成立）且
 * 存在 → 直接用；否则 `which node`。失败 → `undefined`。
 */
export function resolveNodeExecutable(): string | undefined {
  const execPath = process.execPath;
  if (
    typeof execPath === "string" &&
    execPath.length > 0 &&
    basename(execPath) === "node" &&
    existsSync(execPath)
  ) {
    return execPath;
  }
  const probe = spawnSync("which", ["node"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1000,
  });
  const found =
    probe.status === 0 && typeof probe.stdout === "string"
      ? probe.stdout.trim()
      : "";
  return found.length > 0 && existsSync(found) ? found : undefined;
}

/**
 * 生产解析入口。deps 全为测试/探针注入面（存在性、node 解析、安装根），
 * 省略即走宿主真值。任一环节不成立 → `undefined`（调用方 fail-closed）。
 * `resolveInstallRoot()` 抛错（裸环境）同样收敛为 `undefined` —— 本产品
 * 依赖缺失语义。
 */
export function resolveEgressRelay(
  deps: {
    readonly installRoot?: string;
    readonly resolveNode?: () => string | undefined;
    readonly exists?: (path: string) => boolean;
  } = {}
): EgressRelayPaths | undefined {
  const nodePath = (deps.resolveNode ?? resolveNodeExecutable)();
  if (nodePath === undefined) return undefined;
  let installRoot: string;
  try {
    installRoot = deps.installRoot ?? resolveInstallRoot();
  } catch {
    return undefined;
  }
  const paths = egressRelayPathsFor(installRoot);
  const exists = deps.exists ?? existsSync;
  if (!exists(paths.bridgeScriptPath) || !exists(paths.connectScriptPath)) {
    return undefined;
  }
  return { nodePath, ...paths };
}
