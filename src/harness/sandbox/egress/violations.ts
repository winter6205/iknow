/**
 * src/harness/sandbox/egress/violations.ts
 *
 * T4 egress 违例记录器（specs/network-egress-allowlist.md §Violation feedback
 * channel 的第 1 跳「记录」）。
 *
 * 单一职责：在 egress proxy 的 filter 回调返回 false 时记录结构化违例；
 * 提供 session 收尾 drain 接口。T5 / T6 接 bash handler 做「回灌」——
 * 把违例文案追加到 tool_result 的 stderr 或 typed failure。
 *
 * 选型说明：typed record（`kind` 判别联合）+ plain class 持有 + readonly 字段。
 * 与既有 ToolExecutionError / McpLifecycleError 的「kind + message + context」
 * 同形态：调用方 catch 后必须先判 kind 再渲染（code-quality.md typed-error
 * catch 契约），禁止 `err instanceof Error ? err.message : String(err)`。
 *
 * 理由（why 这里单立件，不与 policy.ts / bash.ts 混）：
 *   - 域判定拒绝是**边界表态**，与命令执行结果正交，独立承载更清爽；
 *   - spec「失败留痕」要求每条违例带 `command` 字段，bash 装配期注入；
 *   - session 与 drain 的对应：单个 session 一次性 drain，结束后清空。
 */

import { VIOLATION_PREFIXES } from "../../permission/prefixes.js";

/**
 * 允许集来源 —— 装配面（bash handler / T6 用户层 settings reader）注入，
 * 缺省 = 不注明来源（不伪造「会话级 / 已持久化 / 预置配置」三种来源之一）。
 * T6 才填真值；本任务阶段（T5）只透传，不参与判定。
 */
export type EgressAllowlistSource = "session" | "persisted" | "preset";

export type EgressViolationReason =
  /** CONNECT host 未命中允许集（denied 集或 pattern 也算这里 → 重定向）。 */
  | "not-in-allowlist"
  /** CONNECT host 命中 denied 集 / denied pattern（deny 优先）。 */
  | "denied"
  /** 允许集为空（fail-closed 起步）。 */
  | "allowlist-empty"
  /** 允许集条目形态非法（`:65536` 等）。 */
  | "allowlist-malformed"
  /** 地址守卫拒绝（解析后落在 loopback / 私网 / metadata 等）。 */
  | "address-denied"
  /** 非交互入口首见新域名，且未提供 askApproval inlet。 */
  | "no-approval-inlet"
  /** 用户在交互入口明确拒绝批准该域名 —— 与 no-approval-inlet 区分(spec
   *  §三类信号可区分纪律:infra / 用户拒 / 未配置三类信号修复动作不同)。 */
  | "denied-by-user"
  /** 基础设施故障（代理 / 桥进程死 / socat 缺失）—— 非域判定拒绝 */
  | "infra-unavailable"
  /**
   * egress-credential-sentinel T3 / F5（旁路诊断档）：请求体带
   * `Content-Encoding`，包内字节扫描看不穿压缩体 → 体代换跳过，假值原样
   * 到上游（fail-safe 方向 = 401 可诊断，非泄露）。**不是**域判定拒绝，
   * 不给 allowlist 修复指引。
   */
  | "substitution-skipped"
  /**
   * egress-credential-sentinel T3 / F6（旁路诊断档）：域名被
   * `shouldTerminateTLS` 豁免（不终止 TLS → 代换必然无法运行）且该域上
   * 存在配置了注入的凭据条目（`namesInjectableAt` 非空）。豁免本身不是
   * 违例；「豁免 ∧ 有可注入凭据 = 该域凭据不可用」才是本痕要说的。
   */
  | "tls-exempt-injectable";

export interface EgressViolation {
  readonly kind: "egress_violation";
  readonly host: string;
  readonly port: number;
  readonly reason: EgressViolationReason;
  /**
   * 命令上下文（spawn 的原始命令文本或具名入口）。**仅作观测** —— 不参与
   * 判定，不入 host 字段（避免命令字符串污染域名日志）。
   */
  readonly command: string;
}

export interface EgressViolationSink {
  /** filter 回调里调用一次；纯 append，零异步。 */
  record(v: EgressViolation): void;
  /**
   * session 收尾 drain —— 调用方（bash handler）拿走后清空容器。
   * 返回的快照只读；二次 drain 返回空数组。
   */
  drain(): readonly EgressViolation[];
  /**
   * 当前已记录条数（测试 / 诊断用）。
   */
  size(): number;
}

/**
 * 工厂 —— 单 session 持有违例数组；`drain()` 出快照后清空（slice 不共享
 * 引用，避免后续 record 干扰已 drain 的副本）。
 *
 * 非并发件：本仓 egress 域内不假设多线程访问 filter；node 单线程事件循环
 * 下 append / drain 顺序即可。生产场景下「同一 session 并发多个请求」由
 * 上游代理进程串行化（HTTP server 端）。
 */
export function createEgressViolationSink(): EgressViolationSink {
  let buffer: EgressViolation[] = [];
  return Object.freeze({
    record(v: EgressViolation) {
      // 防御性：host 空串 / port 非数字 → 不入缓冲（防 log 注入与下游
      // 假设破灭）。调用方应已在判定层把空 host 拦掉，此处兜底。
      if (typeof v.host !== "string" || v.host.length === 0) return;
      if (!Number.isInteger(v.port) || v.port < 0) return;
      buffer.push(Object.freeze({ ...v }));
    },
    drain() {
      const out = buffer.slice();
      buffer = [];
      return Object.freeze(out);
    },
    size() {
      return buffer.length;
    },
  });
}

/**
 * 把违例快照翻译成人类可读的多行文本（每条一行；尾部换行可选）。
 *
 * - not-in-allowlist：含被拒域名 + 建议配置键。
 * - denied：含被拒域名 + 命中 denied 规则字面量。
 * - allowlist-empty：含当前 allowedDomains 来源缺失事实。
 * - allowlist-malformed：含非法形态条目（命令级表述）。
 * - address-denied：含被拒域名 + 解析到的地址 + 命中档（loopback / 私网 等）。
 * - no-approval-inlet：含被拒域名 + 非交互入口事实。
 * - denied-by-user：含被拒域名 + 用户明确拒绝事实 + 配置键指引。
 * - infra-unavailable：基础设施故障 —— **不得**与域判定拒绝混排同一段
 *   （修复动作完全不同：infra = 修机器 / 装 socat；域 = 改配置）。
 *   本函数只负责逐行渲染；infra/域混排拒绝逻辑在 `renderEgressFailureMessage`。
 *
 * 故意不渲染 secret / token / 命令全文 —— 命令截断到 80 字符。
 */
export function renderEgressViolations(
  violations: readonly EgressViolation[]
): string {
  if (violations.length === 0) return "";
  const lines: string[] = [];
  for (const v of violations) {
    lines.push(renderSingleViolation(v));
  }
  return lines.join("\n");
}

/**
 * T3 旁路诊断档（credential-sentinel F5/F6）：与域判定拒绝 / infra 故障
 * 分前缀（`[egress_diagnostic]`），四类信号互不混淆 —— 修复动作是
 * 「让体可扫描 / 复核豁免名单」，与 allowlist 无关。
 */
type EgressDiagnosticReason = "substitution-skipped" | "tls-exempt-injectable";

/** 判定 / infra 档 reason（诊断档之外全集，穷尽性由编译器保证）。 */
type EgressDomainReason = Exclude<
  EgressViolationReason,
  EgressDiagnosticReason
>;

const DIAGNOSTIC_RENDERERS: Record<
  EgressDiagnosticReason,
  (target: string, cmd: string) => string
> = {
  "substitution-skipped": (target, cmd) =>
    `[egress_diagnostic] ${target} request body carried Content-Encoding; masked-credential substitution skipped and the fake value reaches upstream unchanged (fail-safe direction: auth fails, no secret leaks; not a domain decision) (command: ${cmd})`,
  "tls-exempt-injectable": (target, cmd) =>
    `[egress_diagnostic] ${target} is exempted from TLS termination while masked credentials are configured for injection there — substitution cannot run on exempted hosts, so those credentials are unusable at this host (fail-safe; not a domain decision) (command: ${cmd})`,
};

function renderSingleViolation(v: EgressViolation): string {
  const cmd =
    v.command.length > 80 ? `${v.command.slice(0, 77)}...` : v.command;
  const target = `${v.host}:${v.port}`;
  // default 分支里 TS 把 reason 收窄为诊断档之外的全集（穷尽性编译器钉）。
  switch (v.reason) {
    case "substitution-skipped":
    case "tls-exempt-injectable":
      return DIAGNOSTIC_RENDERERS[v.reason](target, cmd);
    default:
      return renderDomainViolation(v.reason, target, cmd);
  }
}

function renderDomainViolation(
  reason: EgressDomainReason,
  target: string,
  cmd: string
): string {
  switch (reason) {
    case "not-in-allowlist":
      return `[network_denied] ${target} not in allowed domains (command: ${cmd}); configure isolation.network.allowedDomains or approve this domain interactively`;
    case "denied":
      return `[network_denied] ${target} matched a deny rule (command: ${cmd})`;
    case "allowlist-empty":
      return `[network_denied] ${target} rejected: allowed domains list is empty (configure isolation.network.allowedDomains or approve interactively) (command: ${cmd})`;
    case "allowlist-malformed":
      return `[network_denied] ${target} rejected: allowed domains list contains only malformed entries (command: ${cmd})`;
    case "address-denied":
      return `[network_denied] ${target} resolved to a denied address (command: ${cmd}); an allowed hostname must not resolve into loopback / private / metadata IP space`;
    case "no-approval-inlet":
      return `[network_denied] ${target} seen for the first time and no interactive approval inlet is available (command: ${cmd}); pre-add it to isolation.network.allowedDomains for non-interactive runs`;
    case "denied-by-user":
      return `[network_denied] ${target} denied by user for this session (command: ${cmd}); to allow this host pre-add it to isolation.network.allowedDomains or approve it interactively`;
    case "infra-unavailable":
      return `[network_denied] ${target} egress seam unavailable (command: ${cmd}); infrastructure fault, not a domain allowlist decision`;
  }
}

/**
 * 是否归类为「基础设施故障」—— 与域判定拒绝区分（spec §三类信号 + §Failure
 * paths）：infra = 修机器 / 装 socat / 起桥，**不得**给配置键指引；域判定
 * 拒绝 = 改配置 / 走交互批准入口。
 */
function isInfraViolation(v: EgressViolation): boolean {
  return v.reason === "infra-unavailable";
}

/**
 * shared remediation 尾注 —— 多违例合并时复用（不逐行重复）。两种语义分
 * 两份：域判定拒绝给配置键 + 批准入口；infra 给基础设施修复提示。
 *
 * 中文说明留给 caller 自己渲染：注释只解释「为什么分两段」—— 修动作不同。
 */
const REMEDIATION_DOMAIN = `Remediation: add the host to isolation.network.allowedDomains in user settings, or approve it interactively through the permission prompt; the command itself ran to completion inside the sandbox — exit code still reflects the command, not this denial.`;
const REMEDIATION_INFRA = `Remediation: this is an infrastructure fault, not a domain decision — check the egress bridge / socat installation, not the allowlist; the command itself ran to completion inside the sandbox — exit code still reflects the command, not this denial.`;
const SOURCE_LABEL: Record<EgressAllowlistSource, string> = {
  session: "session-level allowlist",
  persisted: "user-settings persisted allowlist",
  preset: "preset allowlist",
};

/**
 * T5 typed failure message —— 拼成一条同时含：
 *   - `[network_denied]` 前缀（让既有 `categorizeResult` 落到 mid tier，
 *     走通 violation-handling.ts:139 的 networkDenied → mid 分支，不改
 *     该文件）；
 *   - 每条违例一行（被拒域名 + 命中 reason 的可读短文案）；
 *   - 共享补配指引尾注（不逐行重复）；
 *   - 允许集来源（缺省 = 不标注，**不伪造**）；
 *   - 「命令已跑完但出网被拒」语义（避免模型误判为进程崩溃）。
 *
 * infra / 域判定拒绝**绝不混排**同一段：两类信号修复动作完全不同（spec
 * §Failure paths + §三类信号），混排会让模型误读。纯 infra → 不列域名；
 * 纯域判定 → 不说「infra」。
 *
 * `infraHint`：基础设施故障的可选补装/修复片段（bash 装配层在 socat 缺失
 * 等 typed-error 上注入，typed-error catch 契约 code-quality.md）。仅在
 * infra-only 路径插入一行（位于 REMEDIATION_INFRA 之前），让模型/TUI
 * 看见「是哪个二进制 + 怎么装」；缺省不插入（避免无信息时的重复说明）。
 */
export function renderEgressFailureMessage(args: {
  readonly violations: readonly EgressViolation[];
  readonly allowlistSource?: EgressAllowlistSource;
  readonly infraHint?: string;
}): string {
  const { violations, allowlistSource, infraHint } = args;
  if (violations.length === 0) return "";

  const infraOnly = violations.every(isInfraViolation);
  const domainOnly = violations.every((v) => !isInfraViolation(v));
  // 防御性：infra + 域判定混合（理论上 T4 filter 不可能产生；保留该
  // 路径以应对未来 reason 集合扩展）。此时**只渲染域判定**部分，infra
  // 文案单立一段 —— 避免「infra 是 domain allowlist 决定」误导。
  const domainViolations = violations.filter((v) => !isInfraViolation(v));
  const infraViolations = violations.filter(isInfraViolation);

  const lines: string[] = [];
  lines.push(
    `${VIOLATION_PREFIXES.networkDenied} command ran to completion inside the sandbox; egress connection was denied at the network boundary.`
  );
  if (domainOnly) {
    appendDomainPortion(lines, domainViolations, allowlistSource);
  } else if (infraOnly) {
    appendInfraPortion(lines, infraViolations, infraHint);
  } else {
    // 混合：分两段（spec §三类信号可区分 + §Failure paths「infra ≠ 域判定拒绝」）。
    lines.push("Domain-deny portion:");
    appendDomainPortion(lines, domainViolations, allowlistSource);
    lines.push("Infrastructure-fault portion:");
    appendInfraPortion(lines, infraViolations, infraHint);
  }
  return lines.join("\n");
}

/**
 * 「域判定拒绝」段落拼接 —— 公用从 violations 列表渲染每条 + 共享
 * REMEDIATION_DOMAIN 尾注（不逐行重复）。抽出以控制
 * `renderEgressFailureMessage` 复杂度（S5 门）。
 */
function appendDomainPortion(
  lines: string[],
  domainViolations: readonly EgressViolation[],
  allowlistSource: EgressAllowlistSource | undefined
): void {
  if (allowlistSource !== undefined) {
    lines.push(`Current allowlist source: ${SOURCE_LABEL[allowlistSource]}.`);
  }
  for (const v of domainViolations) {
    lines.push(renderSingleViolation(v));
  }
  lines.push(REMEDIATION_DOMAIN);
}

/**
 * 「基础设施故障」段落拼接 —— 公用从 violations 列表渲染每条 + 可选
 * infraHint（typed-error catch 契约落地：SocatUnavailableError 携带的
 * socatCommand + installHint 拼成;让模型/TUI 直接看到「装哪个 + 怎么装」,
 * 不再让 typed-error 信息被 [object Object] 吞掉）+ REMEDIATION_INFRA
 * 尾注。抽出以控制 `renderEgressFailureMessage` 复杂度（S5 门）。
 */
function appendInfraPortion(
  lines: string[],
  infraViolations: readonly EgressViolation[],
  infraHint: string | undefined
): void {
  for (const v of infraViolations) {
    lines.push(renderSingleViolation(v));
  }
  if (infraHint !== undefined && infraHint.length > 0) {
    lines.push(infraHint);
  }
  lines.push(REMEDIATION_INFRA);
}
