/**
 * src/harness/sandbox/egress/session.ts
 *
 * T4 egress 会话生命周期件（ADR-0097「代理生命周期 / dispose 契约」前台形态落地）。
 *
 * 单一职责：把「解析自带中继依赖 → 起 HTTP 代理（token 隔离 + filter 回调，
 * 直接 listen unix socket）→ 暴露给 bwrap fence 装配用的 spec → 收尾释放」
 * 封装成一个 session 形状，前台 per-call 调用。
 *
 * ADR-0107 换装：**socat 不再是产品依赖，两侧都不是**。宿主侧旧「socat 桥
 * （unix socket ↔ 代理 TCP 端口）」删除 —— `createHttpProxyServer` 返回裸
 * node:http Server，直接 `listen(<unixSocketPath>)`（包内先例：
 * sandbox-runtime dist/sandbox/mux-proxy.js 的 stale unlink + listen(sockPath)）。
 * 围栏内侧半桥换成本仓自带 node 中继资产（relay-assets.ts 解析；
 * `EgressFenceSpec.relayAssetsDir` 供 fence `--ro-bind`）。缺中继依赖
 * （node 运行时 / 自带资产）= fail-closed 抛 `EgressRelayUnavailableError`
 * —— 指引是**本产品依赖**（重装 iknow / 修复安装根），不含任何 socat/apt
 * 装包字样（ADR-0107 §Decision 5）。
 *
 * T1 契约已钉：socket 路径带 per-session 随机 id + 启动前清理 stale socket
 * （详见 docs/adr/0097-*.md §Decision）。SOCKS5 / git-over-SOCKS 面（1080
 * 段）已被操作员裁定摘出当前分支（plans/egress-ssh-bridge.md 子弹 2），
 * 按 mux 形态补时在此追加第二枚 socket。
 *
 * T6：filter 回调与 approvalGate 接线（specs §首次域名批准流 + SC10 +
 * ADR-0097 §批准持久化粒度）—— `decideEgress` 返回 `not-in-allowlist` 且
 * gate 在场 → 调 `gate.askIfUnknown(host)`；批准入 sessions 集后放行；
 * 拒绝则记 `denied-by-user` 违例 + 不放行。gate 缺席 → 记
 * `no-approval-inlet` 违例 + 不放行(spec §Failure paths 「非交互入口
 * 首见新域名」fail-closed)。
 *
 * 不变量（与 ADR-0097 + spec §Ownership / dispose contract 一致）：
 *   - 异常路径与正常路径同一释放通道（finally-safe dispose）。
 *   - dispose 幂等（重复调用不抛、不告警）。
 *   - token 每 session 独立（防宿主其他进程直连代理绕过 filter）。
 *
 * 威胁模型 —— 本地暴露面（end-of-round review 裁定登记）：
 *   - 代理 unix socket 落共享 /tmp，node listen 默认 mode = 0777 & ~umask
 *     （常见 0755）→ listen 成功后立即 chmod 0600（`listenOnUnixSocket`），
 *     使本地他用户即使知道路径也无法 connect。
 *   - **已知残余面**：token 经 fence 的 `bwrap --setenv HTTP_PROXY …`
 *     argv 透传，fence 启动窗口内可被本地他用户经 /proc/<pid>/cmdline
 *     短暂读到（socket 路径同理经内层前导 argv）。本缝不为此改 bwrap env
 *     通道（--setenv 是 env 注入 SSOT，改传递面属 fence 架构变更）；
 *     实际防线 = 上述 socket 0600 —— 拿到 token 但连不上 socket 仍无法
 *     绕 filter。残余风险接受并在此显式登记。
 */

import { chmodSync, existsSync, rmSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingHttpHeaders, Server } from "node:http";
import { ToolExecutionError } from "../../errors.js";
import {
  createHttpProxyServer,
  createResolvedAddressGuard,
  disposeMitmCA,
  matchesDomainPattern,
  type HttpProxyServerOptions,
  type MitmCA,
} from "./upstream.js";
import {
  createEgressViolationSink,
  type EgressAllowlistSource,
  type EgressViolationSink,
} from "./violations.js";
import type { EgressApprovalGate } from "./approval.js";
import {
  mintEgressCredentialLayer,
  type EgressCredentialRoster,
} from "./credential-assembly.js";
import {
  type EgressCredentialMint,
  type EgressFenceBind,
} from "./credential-mint.js";
import { loadEgressCa, type EgressCaLoad } from "./ca-store.js";
import { resolveEgressRelay, type EgressRelayPaths } from "./relay-assets.js";

/**
 * 判定器输入 —— 由 bash handler 从 settings 读出后注入（依赖注入，
 * egress 域不直接读 settings）。
 *
 * why 注入：domain-matcher.ts 已经只吃数据；本层维持同形态，
 * 装配面（bash handler）握 settings 源，避免 egress 域反向 import config。
 */
export interface EgressPolicyInput {
  /** 域名允许集（来自 `isolation.network.allowedDomains`）。 */
  readonly allowedDomains: readonly string[];
  /** 域名拒绝集（来自 `isolation.network.deniedDomains`）。 */
  readonly deniedDomains: readonly string[];
  /**
   * 地址守卫额外 denied 档。省略时 session 内部走
   * `domain-matcher.DEFAULT_PRIVATE_DENIED_RANGES`。
   */
  readonly deniedResolvedAddresses?: readonly string[];
  /**
   * 命令上下文字段 —— 注入到违例记录里，观测 / 回灌用。本仓前台形态
   * 取 `bash.ts:finalCommand`（secret 还原后真值）或原始占位符
   * `command`（取谁由调用面定）；不参与判定。
   */
  readonly commandLabel: string;
  /**
   * 允许集来源 —— 封闭三档（引用 `EgressAllowlistSource`，消 inline union
   * 双处漂移，spec T2 / invariant 4）。透传给 typed failure message 渲染，
   * 仅作观测面，不参与判定。生产者：assembly = builtin / persisted 两档，
   * bash 工厂包装层 fallback = session 档；缺省 = 不注明来源（不伪造）。
   */
  readonly allowlistSource?: EgressAllowlistSource;
  /**
   * T6:首次域名批准门件（specs §首次域名批准流 + SC10）—— 当
   * `decideEgress` 命中 `not-in-allowlist` 且 host 不在
   * `allowedDomains` / `deniedDomains` 内，filter 回调调
   * `gate.askIfUnknown(host)` 走交互入口批准。
   *
   * 缺省 = 无 ask 面（spec §Failure paths「非交互入口首见新域名」fail-
   * closed：违例记 `no-approval-inlet` + 不放行）。bash handler 在场
   * 时该 gate 由 `CreateBashToolOptions.askApproval` 转写而来；build-
   * engine / CLI 装配层把既有 AskUser 转写为 `(host) => ask({...})`。
   *
   * gate 实例由 bash tool 工厂闭包期创建一次、跨调用共享,会话级
   * allowed/denied 集在闭包期内累积。
   */
  readonly approvalGate?: EgressApprovalGate;
  /**
   * egress-credential-sentinel T1/T2：凭据名册（内置 github 两条目 + 用户层
   * `isolation.credentials` 收窄/追加后的全集）—— 纯数据形状注入，由装配层
   * （assembly.ts → credential-assembly.ts）构造。T2 起 session 消费：在场 =
   * 铸造假值进围栏（Step 1.5）；缺席 = 无名册（不铸造、不装载 CA）。
   */
  readonly credentials?: EgressCredentialRoster;
}

/**
 * 工厂可选入参。中继解析 / socket 路径 / server 工厂 / 违例 sink 全部可
 * 注入，便于测试不依赖宿主 node 布局与真资产落位（ADR-0107：无任何宿主
 * 装包面可探测）。
 */
export interface EgressSessionOptions {
  readonly policy: EgressPolicyInput;
  /**
   * egress-ssh-bridge T6 凭据可用性分支（默认**关**，assumption 5）：
   * 宿主 SSH agent socket 绝对路径。显式传入 = 开态 —— session 把它经
   * `EgressFenceSpec.sshAuthSockPath` 交 fence 做同段 `--bind` 并在
   * `spec.env` 注入 `SSH_AUTH_SOCK`；缺省 = 关态，两者都不出现（宿主
   * agent 值恒不进围栏）。路径缺失 / stale 到不存在 → fail-closed 抛
   * `SshAgentUnavailableError`（infra 归类，含 F5 指引；不起中继不留半开
   * 形态）。agent socket 非 session 所有 —— dispose 不删该路径。
   */
  readonly sshAuthSockPath?: string;
  /**
   * 中继依赖解析器（默认 `resolveEgressRelay` 生产实现）。test seam：
   * 注入固定假路径集让单测不依赖宿主 node 布局 / 资产落位；注入
   * `() => undefined` 伪造「本产品依赖缺失」fail-closed 路径
   * （SC13 验收 / probe 边界分支）。
   */
  readonly relayResolver?: () => EgressRelayPaths | undefined;
  /**
   * unix socket 路径工厂 —— 默认 `join(tmpdir(), iknow-egress-<id>.sock)`，
   * 测试可注入固定路径。代理 server 直接 listen 该路径（宿主侧无 TCP、
   * 无桥进程）。
   */
  readonly socketPathFactory?: (id: string) => string;
  /**
   * 当前命令违例记录器 —— 缺省 = session 内部创建一个。
   * bash handler 可注入共享 sink（多 session 合并观察）。
   */
  readonly violationSink?: EgressViolationSink;
  /**
   * T6 测试 seam:注入 `createHttpProxyServer` 工厂,让单测捕获
   * `filter` 回调并直接驱动(gate.askIfUnknown → filter 行为)而不必
   * 真起 HTTP 代理 server + 走真实 CONNECT 协议 + 处理 auth token。
   * 生产装配**不传**(走默认 `createHttpProxyServer`)。
   *
   * why 需要:T6 首次域名批准流的判定侧测试想验证「filter 在
   * not-in-allowlist 时调 gate + 批准/拒绝分支 → sink 记对应 reason」,
   * 不依赖真 dial 出网 / DNS / proxyAuthToken 协商。注入点与
   * `relayResolver` / `socketPathFactory` 同形态（S5 complexity 门，
   * 纯注入点，不引入逻辑分支）。
   */
  readonly createHttpProxyServer?: (
    opts: Parameters<typeof createHttpProxyServer>[0]
  ) => Server;
  /**
   * egress-credential-sentinel T2 测试 seam：注入持久 CA 装载
   * （默认 `ca-store.loadEgressCa` —— RSA-2048 生成在冷路径，单测
   * 不真造 CA）。`policy.credentials` 缺席时不会被调用。
   */
  readonly loadEgressCa?: (opts?: {
    readonly caDir?: string;
    readonly onWarn?: (message: string) => void;
  }) => EgressCaLoad;
  /** 持久 CA 目录（测试注入点，透传给 loadEgressCa）。缺省 = 宿主默认。 */
  readonly caDir?: string;
  /**
   * 铸造读真值用的宿主 env 源（默认 `process.env`）—— 测试 seam：
   * 假凭据 fixture 从此注入，真值 / `.env*` 不经测试面。
   */
  readonly hostEnv?: Record<string, string | undefined>;
  /**
   * egress-credential-sentinel T3 / F6（OQ2 留形的操作员退出口 seam）：
   * 免除 TLS 终止的域 pattern 集（`shouldTerminateTLS` 豁免钩子的输入）。
   * 缺省空 = 全放行域终止（Assumption 5）。豁免域上若存在配置了注入的
   * 凭据条目 → 记 `tls-exempt-injectable` 诊断痕（代换在该域必然失效，
   * 方向 fail-safe）。settings 化与否归 OQ2，本弹只留注入点。
   */
  readonly tlsExemptHosts?: readonly string[];
  /**
   * egress-credential-sentinel T3 测试 seam：铸造成功后观测 session 私有
   * 的 registry / masked store / CA（dispose 三资源释放判据用）。生产
   * 装配不传。
   */
  readonly onCredentialMint?: (cred: EgressCredentialResources) => void;
}

/**
 * 装配给 bwrap fence 的 spec —— fence 拿到这个 shape 后挂 socket bind +
 * 中继资产 ro-bind + 注入代理环境变量（详见 `createBwrapFence` 的
 * `egress` 字段）。
 *
 * last-mount-wins 顺序纪律（bwrap.ts:152-185 注释）：
 *  socket / 中继 bind 落位 = workspaceMounts 之后、cwdReadonly 之前。
 *  --setenv 三键走 fence env 注入（bwrap.ts:188-190 `--setenv`）。
 */
export interface EgressFenceSpec {
  /** 宿主 socket 绝对路径（fence 用作 `--bind src dest`，dest = 同值）。代理 server 直接 listen 于此。 */
  readonly unixSocketPath: string;
  /**
   * **沙箱内固定监听号**（= `SANDBOX_HTTP_PROXY_PORT`）。egress-ssh-bridge
   * T1 起语义从「与宿主代理 TCP 端口同号」改为固定值 —— 宿主/沙箱同号是
   * 巧合式耦合（O3），固定端口让 env 与后续 `GIT_SSH_COMMAND` 可预先拼装
   * （specs/egress-ssh-bridge.md assumption 3）。fence 注入
   * `HTTP_PROXY=http://<user>:<token>@127.0.0.1:<port>` 等 env。
   */
  readonly sandboxLocalPort: number;
  /**
   * 已含代理三键（嵌 auth userinfo，O1）+ NO_PROXY 族 + `GIT_SSH_COMMAND`
   * （ssh 桥 T3）的 env 增量（credential-sentinel T2 起并含凭据假值 env 与
   * `CA_TRUST_VARS`）—— fence 拼到自己的 envArgs。
   */
  readonly env: Readonly<Record<string, string>>;
  /**
   * egress-credential-sentinel T2 / invariant 9：masked-file 盖 bind +
   * masked store 目录 ro-bind + trust bundle ro-bind + F3 deny 的
   * `/dev/null` 盖 bind。fence 全部发射进 egressBind 段（workspaceMounts
   * 之后、cwdReadonly 之前）；缺席 / 空 = 不发射额外 bind。约束真实来源：
   * 本 fence 不发 `--tmpfs /tmp`（ADR-0092 全局档，resource-limits.ts:16-18），
   * masked store / socket 所在的宿主 tmpdir 靠「显式逐路径 ro-bind +
   * last-mount-wins 盖过根 bind 下真路径」进围栏（F8）—— 漏发射即围栏
   * 内不可达。
   */
  readonly binds?: readonly EgressFenceBind[];
  /**
   * 沙箱内侧半桥的前导脚本（session 装配期算好）：自带 node 中继把
   * `127.0.0.1:<sandboxLocalPort>` 转到 `unixSocketPath` + trap 收尾
   * （ADR-0107 换装：`<node绝对路径> <中继脚本绝对路径> <sock> <port> &`）。
   * 消费面 = bash.ts 前台命令链（`bash -c "<script>\n<command>"`）；
   * background / verify 两形态的接线归子弹 5。
   */
  readonly innerBridgeScript: string;
  /**
   * ADR-0107 自带中继资产目录（宿主绝对路径）。fence 在既有 egress bind
   * 段对此发 `--ro-bind <dir> <dir>`（src=dest 同值），使围栏内
   * `innerBridgeScript` / `GIT_SSH_COMMAND` 引用的脚本路径可解析 ——
   * 不依赖安装根恰好落在某档默认可见子树内。
   */
  readonly relayAssetsDir: string;
  /**
   * egress-ssh-bridge T6 条件形态（缺省 = 关态，字段缺席）：宿主 SSH
   * agent socket 绝对路径。在场时 fence 在既有 egress bind 段追加
   * `--bind <path> <path>`（src=dest 同值，位置纪律与 `unixSocketPath`
   * bind 同段：workspaceMounts 之后、cwdReadonly 之前），且 `spec.env`
   * 含 `SSH_AUTH_SOCK`（值 = 同一路径 —— bind 后沙箱内路径不变）。
   * 该路径非 session 所有，dispose 通道只收 server 与自有 socket，不删它。
   */
  readonly sshAuthSockPath?: string;
}

/**
 * egress-credential-sentinel T2/T3：session 私有凭据资源包 —— T2 铸造产物
 * （`EgressCredentialMint`）+ 其消费的 `MitmCA`（CA 引用需存活到 T3 代理
 * options 接线与 dispose 的 bundle 清理）。
 */
export interface EgressCredentialResources {
  readonly mint: EgressCredentialMint;
  readonly ca: MitmCA;
}

/**
 * session 形态 —— 暴露给调用方（bash handler）消费；`spec` 用于 fence
 * 装配，`dispose()` 在 finally 调。
 */
export interface EgressSession {
  readonly id: string;
  readonly spec: EgressFenceSpec;
  readonly violationSink: EgressViolationSink;
  /**
   * 收尾：关代理 server + 删 socket。**幂等**，可重复调用
   * （finally-safe）；任何错误吞掉（不污染调用方 finally）。
   */
  dispose(): Promise<void>;
}

/**
 * 本产品依赖缺失的 typed 错误（ADR-0107 §Decision 5「缺中继 = 出网
 * fail-closed，提示本产品依赖而非 socat」）：node 运行时或随仓中继资产
 * 解析不到。**消息禁含 socat / apt 装包字样**（测试反向钉死）。
 *
 * SC13 验收点：bash 装配层收到此错误时按「本次调用无 egress 缝」处理，
 * 不静默降级为「有缝但不可用」。
 */
export class EgressRelayUnavailableError extends ToolExecutionError {
  override readonly name: string = "EgressRelayUnavailableError";
  /** 缺什么（node 运行时 / 随仓中继资产），观测面字段。 */
  readonly detail: string;
  /** 本产品依赖指引（重装 iknow / 修复安装根），非系统装包文案。 */
  readonly remediationHint: string;
  constructor(detail: string, remediationHint: string, cause?: unknown) {
    super(`egress relay unavailable: ${detail}. ${remediationHint}`);
    this.detail = detail;
    this.remediationHint = remediationHint;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/**
 * egress-ssh-bridge T6 / F5：开态但宿主 agent socket 不可用（缺失 /
 * 路径不存在）的 typed 错误 —— **infra 归类，非域拒绝**（F8 同款：
 * agent 连不上不记 egress 违例、不走 filter）。消息带 F5 钉死的指引一
 * 行：passphrase 私钥 + 无 agent = 围栏内 ssh 提示口令而 fence 无 tty
 * 必败；本 spec 不做口令回传面，修复只有一条路 = 宿主侧把 key 交给
 * agent（`ssh-add`）或换无口令 key。
 */
export class SshAgentUnavailableError extends ToolExecutionError {
  override readonly name: string = "SshAgentUnavailableError";
  readonly sshAuthSockPath: string;
  constructor(sshAuthSockPath: string) {
    super(
      `egress: SSH agent socket "${sshAuthSockPath}" not found (agent absent or stale path; infra failure, not a domain denial). ` +
        "指引：宿主侧 `ssh-add` 或无口令 key（passphrase 私钥 + 无 agent 在围栏内必败——fence 无 tty 可输口令）。"
    );
    this.sshAuthSockPath = sshAuthSockPath;
  }
}

/**
 * 生成每 session 随机 id（16 hex chars，64 bit entropy）。
 *
 * why not crypto.randomUUID：socket 文件名要短且无连字符 / 路径分隔符。
 */
function newSessionId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * 沙箱内代理固定监听号（HTTP 面）。why 固定：沙箱 netns 号段私有，固定
 * 端口使代理 env 与后续 `GIT_SSH_COMMAND` 能在装配期预拼装，解除
 * 「宿主/沙箱同号」的巧合式耦合（specs/egress-ssh-bridge.md T1 /
 * assumption 3）。ADR-0107 换装后宿主侧无 TCP 监听 —— server 直接
 * listen unix socket，固定内端口由自带中继转接到该 socket。
 */
export const SANDBOX_HTTP_PROXY_PORT = 3128;

/**
 * 代理 auth 用户名 —— 纯 label，credential 是 token（密码位）。上游
 * `checkAuth`（http-proxy.js）只校验密码 == proxyAuthToken 且用户名非空。
 * 依赖包同款形态是 `PROXY_AUTH_USER = 'srt'`（+可选 encodedCommand 后缀
 * 做归因）；本仓归因已有 `commandLabel` sink 通道，故取不带后缀的固定名。
 */
export const PROXY_AUTH_USER = "iknow";

/**
 * POSIX 单引号包裹 —— 内嵌 `'` 以 `'\''` 断开重开。内层前导脚本会整段
 * 进 `bash -c` 的双引号 payload，node / 中继脚本 / 宿主 socket 路径必须
 * 经此 escape 才不破坏命令链（上游 `quote()` 同款语义）。
 */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * 构造沙箱内侧半桥前导脚本（ADR-0107 换装：中继 = 自带 node 件）。
 *
 * 形态 = 旧依赖包 `buildSandboxCommand` 单桥裁剪版的换装对应物：
 * `<node> <egress-tcp-relay.mjs> <sock> <port> >/dev/null 2>&1 &` +
 * `trap kill EXIT`（中继 = TCP-LISTEN <port> → UNIX-CONNECT <sock> 双向
 * pipe，多连接并发由 net.Server 天然支持）。1080/SOCKS 段已被操作员裁定
 * 摘出当前分支（plans 子弹 2）。前导与用户命令以 `\n` 拼接进同一
 * `bash -c` payload（消费面 bash.ts；background / verify 接线归子弹 5）。
 */
export function buildInnerBridgeScript(
  nodePath: string,
  relayScriptPath: string,
  socketPath: string,
  sandboxPort: number = SANDBOX_HTTP_PROXY_PORT
): string {
  const parts = [nodePath, relayScriptPath, socketPath].map(shellSingleQuote);
  return [
    `${parts[0]} ${parts[1]} ${parts[2]} ${sandboxPort} >/dev/null 2>&1 &`,
    `trap "kill %1 2>/dev/null; exit" EXIT`,
  ].join("\n");
}

/**
 * 内层前导拼接的单点 helper（review Medium：三消费面 + probe 同款复制的
 * 收敛点）。语义 = egress-ssh-bridge invariant 3 的 argv 面：
 *   - spec 在场 → `<spec.innerBridgeScript>\n<command>`（沙箱内侧半桥是
 *     缝的后半场，缺前导则整条缝只有宿主半场，O3）；
 *   - spec 缺席（undefined，任何无缝原因）→ **byte-identical 返回原命令**
 *     （「无缝 = 无桥」回归基线，不注入任何残留）。
 * 消费面：bash.ts 前台 / background manager spawn / verify sandbox-run /
 * sandbox-probe —— 拼接形态只在此处定义一次。
 */
export function wrapCommandWithInnerBridge(
  spec: EgressFenceSpec | undefined,
  command: string
): string {
  return spec === undefined ? command : `${spec.innerBridgeScript}\n${command}`;
}

/**
 * 构造 fence env 增量 —— HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY
 * （含小写别名，覆盖 curl / wget / npm 等工具读取差异）+ GIT_SSH_COMMAND
 * （egress-ssh-bridge T3，见下方形态说明）。
 *
 * - 三键统一指向 `http://<PROXY_AUTH_USER>:<token>@127.0.0.1:<sandboxLocalPort>`：
 *   沙箱内自带中继监听该端口并把流量转回 unix socket → 宿主代理；URL 嵌
 *   auth userinfo 是 O1（407 死路）的清偿 —— 宿主代理配了 proxyAuthToken
 *   后无条件校验 Proxy-Authorization，无凭据的 URL 让全部出网请求 407。
 *   token 是 hex，URL-safe，无需 percent-encode。
 * - NO_PROXY 默认包含 `127.0.0.1,localhost`（代理自指回环不应绕自己），
 *   不覆盖用户既有 NO_PROXY —— 调用方可自行扩，本仓只设最低限。
 *   代价（O2）：目标是 loopback 字面的请求会绕代理直连（沙箱 netns 内
 *   必败）—— 出口可达性探针的正样本因此必须用**非 loopback** 可寻址
 *   fixture（scripts/sandbox-probe.ts egress 端到端注释）。
 * - T3（ADR-0107 换装）：同处注入 `GIT_SSH_COMMAND`（invariant 4 注入面
 *   SSOT 单点 —— 与代理三键共享同一 session 的代理 env，bash /
 *   background / verify 三消费面零复制）。新冻结形态 =
 *   `ssh -F /dev/null -o ControlMaster=no -o ControlPath=none ` +
 *   `-o ProxyCommand='<node绝对路径> <egress-http-connect.mjs绝对路径> %h %p'`：
 *   ssh 经沙箱内 3128 中继走 HTTP CONNECT 隧道；认证材料**不进 argv**，
 *   隧道件从继承的 `HTTP_PROXY` env 读 userinfo（token 不外泄于 ps）。
 *   `-F /dev/null` 依 assumption 4（围栏内 /etc/ssh/ssh_config.d/* 报
 *   Bad owner or permissions）；ControlMaster/ControlPath=none 中和 mux
 *   （沙箱内用户 ControlPath 不可 bind，auth 后即退）。ProxyCommand 路径
 *   引号策略与 `buildInnerBridgeScript` 统一（review Low 裁定）：node /
 *   脚本路径逐一走 `shellSingleQuote`，外层双引号由 git `split_cmdline`
 *   剥除，内层单引号交 ssh ProxyCommand 的 /bin/sh 处理 —— 含空格 / 引号
 *   的安装根路径不再拆碎。token 仍不在 argv（同 URL userinfo 纪律）。围栏
 *   内用户命令**显式内联** `GIT_SSH_COMMAND=... git ...` 时后者胜 ——
 *   POSIX env 前缀赋值优先于继承值（shell 语义，按 spec T3 合并策略不加
 *   防御）。
 */
export function buildProxyEnv(
  sandboxLocalPort: number,
  proxyAuthToken: string,
  relay: EgressRelayPaths,
  extraNoProxy: readonly string[] = []
): Record<string, string> {
  const proxyUrl = `http://${PROXY_AUTH_USER}:${proxyAuthToken}@127.0.0.1:${sandboxLocalPort}`;
  const noProxy = ["127.0.0.1", "localhost", ...extraNoProxy].join(",");
  const gitSshCommand =
    `ssh -F /dev/null -o ControlMaster=no -o ControlPath=none ` +
    `-o ProxyCommand="${shellSingleQuote(relay.nodePath)} ${shellSingleQuote(relay.connectScriptPath)} %h %p"`;
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    NO_PROXY: noProxy,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    all_proxy: proxyUrl,
    no_proxy: noProxy,
    GIT_SSH_COMMAND: gitSshCommand,
  };
}

/**
 * 解析后的「生效 denied 地址档」—— 缺省时退到 caller 上送的
 * `defaultDeniedRanges`。policyInput.deniedResolvedAddresses 在两个消
 * 费点（address guard / filter callback）复现，抽函数统一来源（DRY）：
 * 调用方负责保证 defaultDeniedRanges = domain-matcher 的
 * DEFAULT_PRIVATE_DENIED_RANGES（动态 import 后传入）。
 */
function effectiveDeniedRanges(
  policyInput: EgressPolicyInput,
  defaultDeniedRanges: readonly string[]
): readonly string[] {
  return policyInput.deniedResolvedAddresses ?? defaultDeniedRanges;
}

/**
 * 工厂：构造 filter 回调 —— decideEgress 域判定 + 违例留痕 + 可选
 * 首次域名批准 gate（specs §首次域名批准流 + SC10）。
 *
 * 抽离以控制 `createEgressSession` 复杂度（S5 门）+ 让测试可以独立驱动
 * filter 而不必真起 HTTP 代理（通过 `createHttpProxyServer` 注入 seam）。
 *
 * 返回 `Promise<boolean>` 与上游 `http-proxy.js:234` 的 `await options.filter(...)`
 * 签名一致。同步拒绝（denied / allowlist-empty / allowlist-malformed /
 * address-denied）保持同步；`not-in-allowlist` + gate 在场时是异步。
 */
function createFilterCallback(
  policyInput: EgressPolicyInput,
  defaultDeniedRanges: readonly string[],
  sink: EgressViolationSink,
  decideEgress: typeof import("./domain-matcher.js").decideEgress
): (port: number, host: string) => Promise<boolean> {
  const commandLabel = policyInput.commandLabel;
  const deniedRanges = effectiveDeniedRanges(policyInput, defaultDeniedRanges);
  return async (port: number, host: string): Promise<boolean> => {
    // 域判定 —— 仅按 host:port 决定是否放行到解析层。
    // 已解析路径在下层 `lookupFor` 命中后被拒（address-denied），
    // 那里没有回调记录违例，本回调既承担域判定也承担违例留痕。
    const result = decideEgress({
      host,
      port,
      allowedDomains: policyInput.allowedDomains,
      deniedDomains: policyInput.deniedDomains,
      deniedResolvedAddresses: deniedRanges,
    });
    if (result.outcome === "allow") return true;

    // 拒绝路径 —— `reason` 非空（decideEgress 拒绝路径恒带 reason）。
    // T6 首次域名批准流：仅 `not-in-allowlist`（即 host 完全没在
    // allowed/denied 集里）时尝试走 gate；其它 reason（denied /
    // allowlist-empty / allowlist-malformed / address-denied）保持
    // 原语义 —— 不该拿「询问用户批准」绕开 deny 优先或配置层错误。
    if (result.reason === "not-in-allowlist") {
      if (policyInput.approvalGate === undefined) {
        // spec §Failure paths「非交互入口首见新域名」fail-closed —— 无
        // ask 面可用,首次见到即拒,reason = `no-approval-inlet`。
        sink.record({
          kind: "egress_violation",
          host,
          port,
          reason: "no-approval-inlet",
          command: commandLabel,
        });
        return false;
      }
      const approved = await policyInput.approvalGate.askIfUnknown(host);
      if (approved) {
        // 批准 = 会话级放行(spec + ADR-0097「批准 = 会话级放行必成」),
        // 本次 filter 调用返回 true；后续同 host 在 allowed 集合内不再
        // 走 ask。allowlistSource 在「批准成功」时恒为 session(允许集
        // 来源由 policyInput.allowlistSource 透传,缺省时 `session`
        // 字面意义保留——bash 装配层在批准后写 policyInput.allowlistSource
        // = "session")。
        return true;
      }
      // 用户拒绝(或 askApproval 抛 → fail-closed)→ 记违例 + 不放行。
      // reason 区分:gate 在场但决策失败 → `denied-by-user`(用户决策);
      // 无 gate → 上一支已记 `no-approval-inlet`。
      sink.record({
        kind: "egress_violation",
        host,
        port,
        reason: "denied-by-user",
        command: commandLabel,
      });
      return false;
    }

    sink.record({
      kind: "egress_violation",
      host,
      port,
      // reason 非空（decideEgress 拒绝路径恒带 reason），判别联合收敛。
      reason: result.reason ?? "not-in-allowlist",
      command: commandLabel,
    });
    return false;
  };
}

/**
 * T3 凭据代换接线（spec §T3：接线形状 = 包 manager 现成闭包的
 * `sandbox-manager.js:282/:293/:389-394` 本仓等价自装配）。返回的 partial
 * options 仅在凭据资源在场时并入代理：
 *   - `mitmCA`：session 装载的持久 CA（invariant 7：CA 缺席时凭据层在
 *     Step 1.5 已 typed 失败，走不到这里）；
 *   - `shouldTerminateTLS`：缺省全终止（Assumption 5）；`tlsExemptHosts`
 *     命中 → 落 opaque tunnel，且该域有可注入凭据时记
 *     `tls-exempt-injectable`（F6，经本仓 violationSink，不用包私有
 *     logger —— Assumption 13）；
 *   - `mutateHeaders` = `registry.substituteInHeaders`（per-sentinel
 *     injectHosts 门在 registry 内部，invariant 2/3）；调用前先按包内
 *     skip 判据镜像记 F5 痕（Content-Encoding ∧ 声明体 ∧ 该域有注入对）；
 *   - `getBodySubstitutions` = `registry.sentinelsForHost`。
 *
 * 刻意不配（invariant 5 / Assumption 7）：`mutateHeadersPlaintext` /
 * `getBodySubstitutionsPlaintext`（明文臂 `allowPlaintextInject` 永假）、
 * `planSigv4`（远期）、`getMitmSocketPath`（CONNECT 非 TLS 字节 →
 * opaque tunnel 臂不动 —— ssh-bridge 并行 spec 的依赖声明）。
 * host→port 映射借 `shouldTerminateTLS`（包内每 CONNECT 先于转发腿调用，
 * 次序 = http-proxy.js:234-302 → tls-terminate-proxy.js:304）为 F5 痕
 * 携带真实端口，查不到落 0（不伪造）。
 */
function buildCredentialProxyOptions(
  cred: EgressCredentialResources,
  sink: EgressViolationSink,
  commandLabel: string,
  tlsExemptHosts: readonly string[]
): Partial<HttpProxyServerOptions> {
  const { registry } = cred.mint;
  const portByHost = new Map<string, number>();
  return {
    mitmCA: cred.ca,
    shouldTerminateTLS: (hostname: string, port: number): boolean => {
      portByHost.set(hostname, port);
      const exempt = tlsExemptHosts.some((pattern) =>
        matchesDomainPattern(hostname, pattern)
      );
      // F6 痕 = 「豁免 ∧ 该域有配置了注入的凭据」——豁免本身不是违例。
      if (
        exempt &&
        registry.namesInjectableAt(hostname, matchesDomainPattern).length > 0
      ) {
        sink.record({
          kind: "egress_violation",
          host: hostname,
          port,
          reason: "tls-exempt-injectable",
          command: commandLabel,
        });
      }
      return !exempt;
    },
    mutateHeaders: (headers: IncomingHttpHeaders, destHost: string): void => {
      // F5 诊断（包内 body-substitution.js:40-58 的 skip 判据镜像：声明体
      // ∧ Content-Encoding ∧ 该域有注入对 → 体代换被跳，假值原样到上游）。
      if (
        headers["content-encoding"] !== undefined &&
        (headers["content-length"] !== undefined ||
          headers["transfer-encoding"] !== undefined) &&
        registry.sentinelsForHost(destHost, matchesDomainPattern).length > 0
      ) {
        sink.record({
          kind: "egress_violation",
          host: destHost,
          port: portByHost.get(destHost) ?? 0,
          reason: "substitution-skipped",
          command: commandLabel,
        });
      }
      registry.substituteInHeaders(headers, destHost, matchesDomainPattern);
    },
    getBodySubstitutions: (destHost: string) =>
      registry.sentinelsForHost(destHost, matchesDomainPattern),
  };
}

/**
 * Step 2:起 HTTP 代理 server（filter = decideEgress 域判定;lookupFor =
 * 上游 ResolvedAddressGuard 做 DNS 解析守卫）。
 *
 * 抽离以控制 `createEgressSession` 复杂度（S5 门）。返回 server 实例
 * 供 caller 直接 `listenOnUnixSocket`（ADR-0107：宿主无 TCP、无桥进程）。
 *
 * credential-sentinel T3：凭据资源在场时并入代换接线 options（filter
 * 回调不动 —— 0097 违例所有权；代换只发生在放行之后的转发腿）。
 */
function startHttpProxyStep(
  policyInput: EgressPolicyInput,
  token: string,
  sink: EgressViolationSink,
  decideDeps: {
    readonly defaultDeniedRanges: readonly string[];
    readonly decideEgress: typeof import("./domain-matcher.js").decideEgress;
    readonly createHttpProxy: (
      proxyOpts: Parameters<typeof createHttpProxyServer>[0]
    ) => Server;
    readonly credential?: EgressCredentialResources;
    readonly tlsExemptHosts?: readonly string[];
  }
): Server {
  // 地址守卫（DNS 解析 + 拒 loopback / 私网 / metadata 等）。
  // 通过代理的 `lookupFor` option 注入；解析阶段地址落在 deniedResolvedAddresses
  // 即抛 `ResolvedAddressDeniedError`，由代理进程翻译成 403。
  const guard = createResolvedAddressGuard({
    allowedDomains: policyInput.allowedDomains,
    deniedDomains: policyInput.deniedDomains,
    deniedResolvedAddresses: effectiveDeniedRanges(
      policyInput,
      decideDeps.defaultDeniedRanges
    ),
    // 本机接口地址留空（spec §SC4 不要求把「本机 NIC 地址」当私网档；
    // 仅 DEFAULT_PRIVATE_DENIED_RANGES + 上游默认 DENIED_CLASSES 已足够）。
    localAddresses: () => [],
  });

  const credentialOptions =
    decideDeps.credential !== undefined
      ? buildCredentialProxyOptions(
          decideDeps.credential,
          sink,
          policyInput.commandLabel,
          decideDeps.tlsExemptHosts ?? []
        )
      : {};

  return decideDeps.createHttpProxy({
    filter: createFilterCallback(
      policyInput,
      decideDeps.defaultDeniedRanges,
      sink,
      decideDeps.decideEgress
    ),
    proxyAuthToken: token,
    lookupFor: (port: number) => guard.lookupFor(port),
    ...credentialOptions,
  });
}

/**
 * Step 4:装配 bwrap fence spec。
 *
 * 抽离以控制 `createEgressSession` 复杂度（S5 门）。沙箱内监听号 = 固定
 * `SANDBOX_HTTP_PROXY_PORT`（宿主不再有 TCP 端口 —— 代理 server 直接
 * listen unix socket，同号耦合随 ADR-0107 一并消失）；沙箱内侧半桥由
 * `innerBridgeScript` 前导承载（消费面 bash.ts 命令链）；中继资产目录经
 * `relayAssetsDir` 交 fence ro-bind。
 *
 * T6：`sshAuthSockPath` 在场（开态）才加 `SSH_AUTH_SOCK` env 与 spec
 * 字段 —— env 注入仍走 `assembleFenceSpec` 单点（invariant 4：代理 env
 * 与凭据 env 同一构造处，三消费面零复制）；bind 发射面在 bwrap.ts 的
 * `egressBindArgs`（同段落位）。缺省 = 关态，两处都不出现。
 *
 * credential-sentinel T2：env 增量 = `buildProxyEnv` 之上追加凭据假值与
 * `CA_TRUST_VARS`（mint.envVars）；binds = masked store / trust bundle /
 * masked-file 盖 bind / deny 盖 bind（fence 侧落 egressBind 段，invariant 9）。
 */
function assembleFenceSpec(
  socketPath: string,
  relay: EgressRelayPaths,
  token: string,
  sshAuthSockPath: string | undefined,
  credential: EgressCredentialResources | undefined
): EgressFenceSpec {
  const mint = credential?.mint;
  const env = {
    ...buildProxyEnv(SANDBOX_HTTP_PROXY_PORT, token, relay),
    ...(mint?.envVars ?? {}),
  };
  const innerBridgeScript = buildInnerBridgeScript(
    relay.nodePath,
    relay.bridgeScriptPath,
    socketPath
  );
  const spec: EgressFenceSpec = {
    unixSocketPath: socketPath,
    sandboxLocalPort: SANDBOX_HTTP_PROXY_PORT,
    env,
    innerBridgeScript,
    relayAssetsDir: relay.relayDir,
    ...(mint !== undefined && mint.binds.length > 0
      ? { binds: mint.binds }
      : {}),
  };
  if (sshAuthSockPath === undefined) {
    return spec;
  }
  return {
    ...spec,
    env: { ...env, SSH_AUTH_SOCK: sshAuthSockPath },
    sshAuthSockPath,
  };
}

/**
 * Step 1.5 (credential-sentinel T2/T6): 启动期铸造 —— 抽离以控制
 * `createEgressSession` 复杂度（S5 门）。名册在场 → 装载持久 CA（T4）+
 * 经凭据装配入口 `mintEgressCredentialLayer`（T6）以 `fenced` 档铸造假值
 * （registry / masked store / bind 表 / env 增量）；session 在场 ⇔ 围栏
 * 在场，故姿态恒 `fenced`（yolo / isolation OFF 无 session，skipped 痕
 * 归装配入口的 `no-fence` 档）。名册缺席 → undefined（不装载、不铸造）。
 * 装配期防线（invariant 1 / F4）失败 = typed 错误向上抛，调用方在此步
 * 之后不得起代理（「不起带部分代换的 session」）。
 * T3 起返回 CA 引用（代理 mitmCA 接线 + dispose bundle 清理消费）。
 */
function mintCredentialsStep(
  opts: EgressSessionOptions
): EgressCredentialResources | undefined {
  if (opts.policy.credentials === undefined) return undefined;
  const loadCa = opts.loadEgressCa ?? loadEgressCa;
  const caLoad = loadCa({ caDir: opts.caDir });
  const mint = mintEgressCredentialLayer({
    posture: "fenced",
    roster: opts.policy.credentials,
    ca: caLoad.ca,
    env: opts.hostEnv ?? process.env,
  });
  const resources: EgressCredentialResources = { mint, ca: caLoad.ca };
  // T3 观测 seam（仅测试）：铸造成功即上报，spawn 失败路径同样经此观测
  // 三资源释放。
  opts.onCredentialMint?.(resources);
  return resources;
}

/**
 * T3 dispose 凭据段（0097 生命周期表「正常 / 异常同一释放通道」逐字沿用）：
 * `registry.clear()` + `MaskedFileStore.dispose()` + trust bundle 临时件
 * 清理（`disposeMitmCA`：bundle 目录恒删，持久 CA 非 ephemeral 不受影响，
 * Assumption 4）。逐步 best-effort 吞异常 —— 释放通道不得抛污染调用方
 * finally / 不得因单步失败跳过后续资源。
 */
async function releaseCredentialResources(
  cred: EgressCredentialResources | undefined
): Promise<void> {
  if (cred === undefined) return;
  try {
    cred.mint.registry.clear();
  } catch {
    // best-effort
  }
  try {
    cred.mint.store.dispose();
  } catch {
    // best-effort
  }
  try {
    await disposeMitmCA(cred.ca);
  } catch {
    // best-effort
  }
}

/**
 * 主入口：建一个 per-call egress session。
 *
 * 步骤（异常路径与正常路径同一释放通道）：
 *   1) 解析自带中继依赖（node + vendor/egress-relay 资产；resolver 可注入）；
 *   1.5) credential-sentinel T2：名册在场 → 装载持久 CA + 铸造假值
 *        （registry / masked store / bind 表 / env 增量）；装配期防线
 *        （invariant 1 / F4）失败 = 不起代理直接 throw；
 *   2) 启动 HTTP 代理 server（filter = decideEgress 域判定；
 *      lookupFor = 上游 ResolvedAddressGuard 做 DNS 解析守卫）；
 *   3) server 直接 listen unix socket（ADR-0107：宿主无 socat 桥）；
 *   4) 构造 fence spec 并返回。
 *
 * 任意步骤失败 → 清理已起资源 + 抛 typed 错误（不静默）。
 */
export async function createEgressSession(
  opts: EgressSessionOptions
): Promise<EgressSession> {
  const relayResolver = opts.relayResolver ?? resolveEgressRelay;
  const socketPathFactory =
    opts.socketPathFactory ??
    ((id) => join(tmpdir(), `iknow-egress-${id}.sock`));
  const sink = opts.violationSink ?? createEgressViolationSink();

  // Step 1: 中继依赖解析（注入可让测试伪造「本产品依赖缺失」）。
  // fail-closed：解析不到 = 无缝可用，抛产品语义 typed 错误（ADR-0107）。
  const relay = relayResolver();
  if (relay === undefined) {
    throw new EgressRelayUnavailableError(
      "this install cannot resolve its bundled egress relay (a Node runtime plus vendor/egress-relay assets)",
      "The relay ships with iknow; repair or reinstall the iknow install root (npm) so vendor/egress-relay and a Node >=20 runtime are present — no extra system package is part of this product."
    );
  }

  // T6 凭据可用性分支（默认关）：开态先验 agent socket 存在性 ——
  // 缺失 = fail-closed 抛 infra 类错误（F5/F8），且发生在起 server / listen
  // 之前（不留「有 bind 无缝」半开形态）。
  // stale-but-present（文件在、agent 亡）无法低成本探测，留给围栏内 ssh
  // 报 agent refused —— 归类 infra，本缝不经 filter，不产域拒绝记录。
  const sshAuthSockPath = opts.sshAuthSockPath;
  if (sshAuthSockPath !== undefined && !existsSync(sshAuthSockPath)) {
    throw new SshAgentUnavailableError(sshAuthSockPath);
  }

  const id = newSessionId();
  const socketPath = socketPathFactory(id);

  // Stale socket 清理（spec §Failure paths：socket 路径带 per-session 随机 id
  // + 启动前清理）。任意残留 socket = 来自前次未释放会话，删掉避免误连
  // （listen 前 unlink 同款语义，包内 mux-proxy.js 先例）。
  removeSocketFile(socketPath);

  // 共享 token —— 防宿主其他进程直连代理绕过 filter（ADR-0097 §Decision）。
  const token = randomBytes(32).toString("hex");

  // 动态 import domain-matcher（避免循环；egress 域内件单向引用）。
  const { decideEgress, DEFAULT_PRIVATE_DENIED_RANGES } =
    await import("./domain-matcher.js");

  // Step 1.5 (credential-sentinel T2): 启动期铸造 —— 必须在起代理（Step 2）
  // 之前：F4 子串契约 / invariant 1 假值空间 assert 失败 = typed 错误直接
  // throw，代理未起、session 不存在（「不起带部分代换的 session」）。
  const credentialResources = mintCredentialsStep(opts);

  // Step 2: 起 HTTP 代理 server。T6 测试 seam:createHttpProxyServer 注入
  // 让单测捕获 filter 回调直接驱动;生产走默认 createHttpProxyServer。
  // T3：凭据资源在场时代理并入代换接线（mitmCA + 转发腿钩子）。
  const httpServer = startHttpProxyStep(opts.policy, token, sink, {
    defaultDeniedRanges: DEFAULT_PRIVATE_DENIED_RANGES,
    decideEgress,
    createHttpProxy: opts.createHttpProxyServer ?? createHttpProxyServer,
    credential: credentialResources,
    tlsExemptHosts: opts.tlsExemptHosts,
  });

  // Step 3: server 直接 listen unix socket（失败 = 清理不留半资源 ——
  // credential-sentinel T3「异常路径同一释放通道」：registry / masked
  // store / trust bundle 三资源同步释放，不留 stale）。
  try {
    await listenOnUnixSocket(httpServer, socketPath);
  } catch (err) {
    closeServerQuietly(httpServer);
    removeSocketFile(socketPath);
    await releaseCredentialResources(credentialResources);
    throw err;
  }

  // Step 4: 构造 fence spec（沙箱内固定端口 + auth env + 内层中继前导 +
  // 资产 ro-bind 目录 + T6 条件凭据缝（sshAuthSockPath 缺席即关态）+
  // 凭据 binds / env 增量（credential-sentinel T2））。
  const spec = assembleFenceSpec(
    socketPath,
    relay,
    token,
    sshAuthSockPath,
    credentialResources
  );

  let disposed = false;
  const dispose = async (): Promise<void> => {
    // 幂等：重复 dispose 不抛、不报错。
    if (disposed) return;
    disposed = true;
    closeServerQuietly(httpServer);
    removeSocketFile(socketPath);
    // T3：凭据层同一通道释放（registry.clear + store.dispose + bundle 清理）。
    await releaseCredentialResources(credentialResources);
  };

  return Object.freeze({ id, spec, violationSink: sink, dispose });
}

/**
 * socket 文件清理 —— unlink + rmSync 双保险（stale socket 防线的收尾
 * 一侧）。独立成函数（S5 complexity 门）。
 */
function removeSocketFile(socketPath: string): void {
  try {
    if (existsSync(socketPath)) unlinkSync(socketPath);
  } catch {
    // best-effort
  }
  try {
    rmSync(socketPath, { force: true });
  } catch {
    // best-effort
  }
}

/**
 * 内部辅助 —— 让裸 node:http server 直接 listen unix socket 路径
 * （ADR-0107：宿主侧去 socat 桥；包内先例 mux-proxy.js listenHttpBackend）。
 *
 * listen 成功后立即 chmod 0600：共享 /tmp 下 node 默认 socket mode
 * （0777 & ~umask）对本地其他用户可 connect，配合「token 经 --setenv
 * argv 短暂可见」的残余面就是 filter 旁路洞（见文件头威胁模型登记）。
 * chmod 失败 = listen 失败对待（reject → 调用方同一清理通道），不裸奔。
 */
function listenOnUnixSocket(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off("error", onError);
      try {
        chmodSync(socketPath, 0o600);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

function closeServerQuietly(server: Server): void {
  try {
    server.close();
  } catch {
    // best-effort
  }
}
