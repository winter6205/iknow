/**
 * src/harness/sandbox/egress/session.ts
 *
 * T4 egress 会话生命周期件（ADR-0097「代理生命周期 / dispose 契约」前台形态落地）。
 *
 * 单一职责：把「起 HTTP 代理（token 隔离 + filter 回调）→ 起 socat 桥
 * （宿主侧 unix socket ↔ 代理 TCP 端口）→ 暴露给 bwrap fence 装配用的
 * spec → 收尾释放」封装成一个 session 形状，前台 per-call 调用。
 *
 * T1 契约已钉：socket 路径带 per-session 随机 id + 启动前清理 stale socket
 * （详见 docs/adr/0097-*.md §Decision）。spec / spawn 结构参考
 * `node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js`
 * 的 `initializeLinuxNetworkBridge`。
 *
 * 本仓前台形态最小可用面：HTTP 代理 + address guard lookupFor（DNS 解析
 * 守卫先于 dial）。egress-ssh-bridge T1 已把「沙箱内侧半桥」补齐为宿主
 * session 装配期算好的 `innerBridgeScript`（沙箱内 socat TCP-LISTEN:3128 →
 * unix socket 的前导命令，消费面在 bash.ts 前台命令链）；SOCKS5 /
 * git-over-SOCKS 面（1080 段）已被操作员裁定摘出当前分支（plans/
 * egress-ssh-bridge.md 子弹 2），按 mux 形态补时在此追加第二段监听。
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
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { Server } from "node:http";
import { ToolExecutionError } from "../../errors.js";
import {
  createHttpProxyServer,
  createResolvedAddressGuard,
} from "./upstream.js";
import {
  createEgressViolationSink,
  type EgressViolationSink,
} from "./violations.js";
import type { EgressApprovalGate } from "./approval.js";

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
   * T5:允许集来源 —— 透传给 typed failure message 渲染。仅作观测面,
   * 不参与判定。T6 用户层 settings reader 注入真值；T5 阶段缺省 = 不
   * 标注（不伪造「会话级 / 已持久化 / 预置配置」三种来源之一）。
   */
  readonly allowlistSource?: "session" | "persisted" | "preset";
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
}

/**
 * 工厂可选入参。所有 probe / socat / spawn 行为都可注入，便于测试
 * 不依赖宿主真实装 socat / 起真 server（SC2 实测链路由 leader 在
 * 收尾阶段承担，本仓只验代码契约）。
 */
export interface EgressSessionOptions {
  readonly policy: EgressPolicyInput;
  /**
   * socat 可执行路径或命令名。注入便于测试 —— 测试可用假 socat 或
   * skip 桥；生产传 `'socat'` 或绝对路径。
   */
  readonly socatCommand?: string;
  /**
   * socat 是否存在的探测函数。默认 `defaultProbeSocat` —— 暴露为注入
   * 点便于单测伪造缺 socat 场景（SC13 验收）。
   */
  readonly probeSocat?: (cmd: string) => boolean;
  /**
   * spawn 工厂（默认 `node:child_process.spawn`）。test seam：可换成
   * 不真起进程的 fake spawn。
   */
  readonly spawn?: typeof spawn;
  /**
   * unix socket 路径工厂 —— 默认 `join(tmpdir(), iknow-egress-<id>.sock)`，
   * 测试可注入固定路径。
   */
  readonly socketPathFactory?: (id: string) => string;
  /**
   * 监听端口 —— 默认 0 = OS 分配。
   */
  readonly proxyPort?: number;
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
   * 不依赖真 dial 出网 / socat / DNS / proxyAuthToken 协商。注入点
   * 与 `spawn` / `probeSocat` / `socketPathFactory` 同形态(S5
   * complexity 门,纯注入点,不引入逻辑分支)。
   */
  readonly createHttpProxyServer?: (
    opts: Parameters<typeof createHttpProxyServer>[0]
  ) => Server;
}

/**
 * 装配给 bwrap fence 的 spec —— fence 拿到这个 shape 后挂 socket bind
 * + 注入代理环境变量（详见 `createBwrapFence` 的 `egress` 字段）。
 *
 * last-mount-wins 顺序纪律（bwrap.ts:152-185 注释）：
 *  socket bind 落位 = workspaceMounts 之后、cwdReadonly 之前。
 *  --setenv 三键走 fence env 注入（bwrap.ts:188-190 `--setenv`）。
 */
export interface EgressFenceSpec {
  /** 宿主 socket 绝对路径（fence 用作 `--bind src dest`，dest = 同值）。 */
  readonly unixSocketPath: string;
  /**
   * **沙箱内固定监听号**（= `SANDBOX_HTTP_PROXY_PORT`）。egress-ssh-bridge
   * T1 起语义从「与宿主代理 TCP 端口同号」改为固定值 —— 宿主/沙箱同号是
   * 巧合式耦合（O3），固定端口让 env 与后续 `GIT_SSH_COMMAND` 可预先拼装
   * （specs/egress-ssh-bridge.md assumption 3）。fence 注入
   * `HTTP_PROXY=http://<user>:<token>@127.0.0.1:<port>` 等 env。
   */
  readonly sandboxLocalPort: number;
  /** 已含代理三键（嵌 auth userinfo，O1）+ NO_PROXY 族 + `GIT_SSH_COMMAND`（T3）的 env 增量 —— fence 拼到自己的 envArgs。 */
  readonly env: Readonly<Record<string, string>>;
  /**
   * 沙箱内侧半桥的前导脚本（session 装配期算好）：沙箱内 socat 把
   * `127.0.0.1:<sandboxLocalPort>` 转到 `unixSocketPath` + trap 收尾。
   * 消费面 = bash.ts 前台命令链（`bash -c "<script>\n<command>"`）；
   * background / verify 两形态的接线归子弹 5。
   */
  readonly innerBridgeScript: string;
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
   * 收尾：kill 代理进程 + socat 进程 + 删 socket。**幂等**，可重复
   * 调用（finally-safe）；任何错误吞掉（不污染调用方 finally）。
   */
  dispose(): Promise<void>;
}

/**
 * socat 缺失 / 不可执行 的 typed 错误 —— 携带补装指引文案。
 *
 * SC13 验收点：bash 装配层收到此错误时按「本次调用无 egress 缝」处理，
 * 不静默降级为「有缝但不可用」。
 */
export class SocatUnavailableError extends ToolExecutionError {
  override readonly name: string = "SocatUnavailableError";
  readonly socatCommand: string;
  readonly installHint: string;
  constructor(socatCommand: string, installHint: string, cause?: unknown) {
    super(
      `egress: socat binary "${socatCommand}" not found or not executable. ${installHint}`
    );
    this.socatCommand = socatCommand;
    this.installHint = installHint;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/**
 * 通用：探测 socat 可执行性 —— 用 `which` 调用，与 upstream
 * linux-sandbox-utils.js:437 的语义对齐（`whichSync('socat')`）。
 *
 * 暴露成 named export 便于测试注入 —— 单测不希望真起 `which`。
 */
export function defaultProbeSocat(cmd: string): boolean {
  const probe = spawnSync("which", [cmd], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1000,
  });
  return (
    probe.status === 0 &&
    typeof probe.stdout === "string" &&
    probe.stdout.trim().length > 0
  );
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
 * assumption 3；依赖包同款：linux-sandbox-utils.js `buildSandboxCommand`
 * 的 TCP-LISTEN:3128）。宿主侧代理 TCP 端口维持 OS 分配，由宿主 socat
 * 桥完成 <固定内端口> → <宿主随机端口> 的转接。
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
 * 进 `bash -c` 的双引号 payload，宿主 socket 路径 / socat 命令名必须
 * 经此 escape 才不破坏命令链（上游 `quote()` 同款语义）。
 */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * 构造沙箱内侧半桥前导脚本（O3 清偿：此前全仓无 TCP-LISTEN/UNIX-CONNECT
 * 装配，注释引用的 `buildSandboxInnerCommand` 不存在，端到端从未闭合）。
 *
 * 形态 = 依赖包 `linux-sandbox-utils.js` `buildSandboxCommand` 的**单桥
 * 裁剪版**：1080/SOCKS 段已被操作员裁定摘出当前分支（plans 子弹 2），
 * 只留 3128 → unix socket 一段监听 + trap kill EXIT 收尾。前导与用户
 * 命令以 `\n` 拼接进同一 `bash -c` payload（消费面 bash.ts；background /
 * verify 接线归子弹 5）。
 */
export function buildInnerBridgeScript(
  socatCommand: string,
  socketPath: string,
  sandboxPort: number = SANDBOX_HTTP_PROXY_PORT
): string {
  const socat = shellSingleQuote(socatCommand);
  const unix = shellSingleQuote(socketPath);
  return [
    `${socat} TCP-LISTEN:${sandboxPort},fork,reuseaddr UNIX-CONNECT:${unix} >/dev/null 2>&1 &`,
    `trap "kill %1 2>/dev/null; exit" EXIT`,
  ].join("\n");
}

/**
 * 构造 fence env 增量 —— HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY
 * （含小写别名，覆盖 curl / wget / npm 等工具读取差异）+ GIT_SSH_COMMAND
 * （egress-ssh-bridge T3，见下方形态说明）。
 *
 * - 三键统一指向 `http://<PROXY_AUTH_USER>:<token>@127.0.0.1:<sandboxLocalPort>`：
 *   沙箱内 socat 监听该端口并把流量转回 unix socket → 宿主代理；URL 嵌
 *   auth userinfo 是 O1（407 死路）的清偿 —— 宿主代理配了 proxyAuthToken
 *   后无条件校验 Proxy-Authorization，无凭据的 URL 让全部出网请求 407。
 *   token 是 hex，URL-safe，无需 percent-encode。
 * - NO_PROXY 默认包含 `127.0.0.1,localhost`（代理自指回环不应绕自己），
 *   不覆盖用户既有 NO_PROXY —— 调用方可自行扩，本仓只设最低限。
 *   代价（O2）：目标是 loopback 字面的请求会绕代理直连（沙箱 netns 内
 *   必败）—— 出口可达性探针的正样本因此必须用**非 loopback** 可寻址
 *   fixture（scripts/sandbox-probe.ts present 分支注释）。
 * - T3：同处注入 `GIT_SSH_COMMAND`（invariant 4 注入面 SSOT 单点 —— 与
 *   代理三键共享同一 session token，bash / background / verify 三消费面
 *   零复制）。形态逐字冻结于 specs/egress-ssh-bridge.md §T3：ssh 经沙箱
 *   内 3128 半桥走 HTTP CONNECT 隧道（`socat - PROXY:` 是依赖包
 *   sandbox-utils.js:536-540 的 Linux 跨版本可移植选型）；`-F /dev/null`
 *   依 assumption 4（围栏内 /etc/ssh/ssh_config.d/* 报 Bad owner or
 *   permissions）；ControlMaster/ControlPath=none 中和 mux（沙箱内用户
 *   ControlPath 不可 bind，auth 后即退）。ProxyCommand 单引号对内无
 *   quoting 风险：token 是内部生成的 hex（randomBytes，同 URL userinfo
 *   纪律）。围栏内用户命令**显式内联** `GIT_SSH_COMMAND=... git ...` 时
 *   后者胜 —— POSIX env 前缀赋值优先于继承值（shell 语义，按 spec T3
 *   合并策略不加防御）。
 */
export function buildProxyEnv(
  sandboxLocalPort: number,
  proxyAuthToken: string,
  extraNoProxy: readonly string[] = []
): Record<string, string> {
  const proxyUrl = `http://${PROXY_AUTH_USER}:${proxyAuthToken}@127.0.0.1:${sandboxLocalPort}`;
  const noProxy = ["127.0.0.1", "localhost", ...extraNoProxy].join(",");
  const gitSshCommand =
    `ssh -F /dev/null -o ControlMaster=no -o ControlPath=none ` +
    `-o ProxyCommand='socat - PROXY:127.0.0.1:%h:%p,` +
    `proxyport=${sandboxLocalPort},proxyauth=${PROXY_AUTH_USER}:${proxyAuthToken}'`;
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
 * Step 2:起 HTTP 代理 server（filter = decideEgress 域判定;lookupFor =
 * 上游 ResolvedAddressGuard 做 DNS 解析守卫）。
 *
 * 抽离以控制 `createEgressSession` 复杂度（S5 门）。返回 server 实例
 * 供 caller 调 `listenOnFreePort` 拿端口，再传给 socat 桥。
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

  return decideDeps.createHttpProxy({
    filter: createFilterCallback(
      policyInput,
      decideDeps.defaultDeniedRanges,
      sink,
      decideDeps.decideEgress
    ),
    proxyAuthToken: token,
    lookupFor: (port: number) => guard.lookupFor(port),
  });
}

/**
 * Step 3:起 socat 桥（unix socket → 127.0.0.1:proxyPort）。
 *
 * 抽离以控制 `createEgressSession` 复杂度（S5 门）。spawn 失败（无 pid）
 * 时 caller 负责关闭已起 server + 抛 typed 错误；本函数不抛。
 */
function startSocatBridgeStep(
  socatCommand: string,
  socketPath: string,
  httpPort: number,
  spawnFn: typeof spawn
): ChildProcess {
  const socatArgs = [
    `UNIX-LISTEN:${socketPath},fork,reuseaddr`,
    `TCP:127.0.0.1:${httpPort},keepalive`,
  ];
  const socatProc = spawnFn(socatCommand, socatArgs, { stdio: "ignore" });

  // 错误 / 退出 监听 —— spec §Failure paths 「stale socket」防线需要。
  socatProc.on("error", () => {
    // 兜底：spawn 期错误由 !pid 检查捕获；运行期 error 留观测通道。
  });
  return socatProc;
}

/**
 * Step 4:装配 bwrap fence spec。
 *
 * 抽离以控制 `createEgressSession` 复杂度（S5 门）。沙箱内监听号 = 固定
 * `SANDBOX_HTTP_PROXY_PORT`（宿主 OS 分配端口不出现在 spec —— 它只活在
 * 宿主 socat 桥的 `TCP:127.0.0.1:<hostPort>` 一端，同号耦合已解除）；
 * 沙箱内侧半桥由 `innerBridgeScript` 前导承载（消费面 bash.ts 命令链）。
 */
function assembleFenceSpec(
  socketPath: string,
  socatCommand: string,
  token: string
): EgressFenceSpec {
  return {
    unixSocketPath: socketPath,
    sandboxLocalPort: SANDBOX_HTTP_PROXY_PORT,
    env: buildProxyEnv(SANDBOX_HTTP_PROXY_PORT, token),
    innerBridgeScript: buildInnerBridgeScript(socatCommand, socketPath),
  };
}

/**
 * 主入口：建一个 per-call egress session。
 *
 * 步骤（异常路径与正常路径同一释放通道）：
 *   1) 探测 socat（注入探测函数决定成败）；
 *   2) 启动 HTTP 代理 server（filter = decideEgress 域判定；
 *      lookupFor = 上游 ResolvedAddressGuard 做 DNS 解析守卫）；
 *   3) 起 socat 桥（unix socket → 127.0.0.1:proxyPort）；
 *   4) 构造 fence spec 并返回。
 *
 * 任意步骤失败 → 清理已起资源 + 抛 typed 错误（不静默）。
 */
export async function createEgressSession(
  opts: EgressSessionOptions
): Promise<EgressSession> {
  const socatCommand = opts.socatCommand ?? "socat";
  const probeSocat = opts.probeSocat ?? defaultProbeSocat;
  const spawnFn = opts.spawn ?? spawn;
  const socketPathFactory =
    opts.socketPathFactory ??
    ((id) => join(tmpdir(), `iknow-egress-${id}.sock`));
  const sink = opts.violationSink ?? createEgressViolationSink();

  // Step 1: socat 探测（注入可让测试伪造「缺 socat」）。
  if (!probeSocat(socatCommand)) {
    throw new SocatUnavailableError(
      socatCommand,
      "Install socat (Debian/Ubuntu: `sudo apt install socat`; Fedora/RHEL: `sudo dnf install socat`; macOS: `brew install socat`) and retry."
    );
  }

  const id = newSessionId();
  const socketPath = socketPathFactory(id);

  // Stale socket 清理（spec §Failure paths：socket 路径带 per-session 随机 id
  // + 启动前清理）。任意残留 socket = 来自前次未释放会话，删掉避免误连。
  removeSocketFile(socketPath);

  // 共享 token —— 防宿主其他进程直连代理绕过 filter（ADR-0097 §Decision）。
  const token = randomBytes(32).toString("hex");

  // 动态 import domain-matcher（避免循环；egress 域内件单向引用）。
  const { decideEgress, DEFAULT_PRIVATE_DENIED_RANGES } =
    await import("./domain-matcher.js");

  // Step 2: 起 HTTP 代理 server。T6 测试 seam:createHttpProxyServer 注入
  // 让单测捕获 filter 回调直接驱动;生产走默认 createHttpProxyServer。
  const httpServer = startHttpProxyStep(opts.policy, token, sink, {
    defaultDeniedRanges: DEFAULT_PRIVATE_DENIED_RANGES,
    decideEgress,
    createHttpProxy: opts.createHttpProxyServer ?? createHttpProxyServer,
  });

  // 监听端口（0 = OS 分配）。
  const httpListen = await listenOnFreePort(httpServer, "127.0.0.1");

  // Step 3: socat 桥。
  const socatProc = startSocatBridgeStep(
    socatCommand,
    socketPath,
    httpListen.port,
    spawnFn
  );

  if (!socatProc.pid) {
    // spawn 失败：清理 server。
    closeServerQuietly(httpServer);
    throw new SocatUnavailableError(
      socatCommand,
      "Failed to spawn socat. Verify socat is installed and executable."
    );
  }

  // Step 4: 构造 fence spec（沙箱内固定端口 + auth env + 内层桥前导）。
  const spec = assembleFenceSpec(socketPath, socatCommand, token);

  let disposed = false;
  const dispose = async (): Promise<void> => {
    // 幂等：重复 dispose 不抛、不报错。
    if (disposed) return;
    disposed = true;
    await teardownSocat(socatProc);
    closeServerQuietly(httpServer);
    removeSocketFile(socketPath);
  };

  return Object.freeze({ id, spec, violationSink: sink, dispose });
}

/**
 * socat 进程收尾 —— kill(SIGTERM) → 2s grace → kill(SIGKILL)。逐段
 * best-effort：dispose 不得因单步失败而抛（T1 契约「异常路径同一释放
 * 通道」，finally 语义）。独立成函数（S5 complexity 门）。
 */
async function teardownSocat(proc: ChildProcess): Promise<void> {
  if (proc.pid === undefined || proc.killed) return;
  try {
    proc.kill("SIGTERM");
  } catch {
    // best-effort
  }
  await waitForExit(proc, 2000);
  if (!proc.killed) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // best-effort
    }
  }
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
 * 内部辅助 —— 让 server.listen(0, ...) 拿到实际端口。
 */
function listenOnFreePort(
  server: Server,
  host: string
): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off("error", onError);
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("egress: server address unavailable"));
        return;
      }
      resolve({ port: addr.port });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, host);
  });
}

function closeServerQuietly(server: Server): void {
  try {
    server.close();
  } catch {
    // best-effort
  }
}

function waitForExit(proc: ChildProcess, ms: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    proc.once("exit", finish);
    const timer = setTimeout(finish, ms);
  });
}
