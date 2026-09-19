/**
 * src/harness/sandbox/egress/index.ts
 *
 * T4 egress 域 barrel —— `src/harness/sandbox/egress/*` 的对外导出面。
 *
 * 单一职责：仅做 re-export，不做逻辑装配。T5/T6/T7 消费：
 *   - `createEgressSession` + `EgressFenceSpec`：bash handler 接线；
 *   - `EgressViolationSink` / `renderEgressViolations`：bash tool_result 回灌；
 *   - `EgressPolicyInput`：bash handler 从 settings 读后注入；
 *   - `createEgressApprovalGate`：bash tool 工厂闭包期构造一次，跨调用共享。
 *
 * 不暴露 `domain-matcher`（已被既有 `egress-domain-matcher.test.ts` 通过
 * 路径直接 import）—— 该件是 T3 产物，是公共件消费面。
 */

export {
  buildProxyEnv,
  createEgressSession,
  EgressRelayUnavailableError,
  wrapCommandWithInnerBridge,
  type EgressFenceSpec,
  type EgressPolicyInput,
  type EgressSession,
  type EgressSessionOptions,
} from "./session.js";

export {
  egressRelayPathsFor,
  resolveEgressRelay,
  resolveNodeExecutable,
  type EgressRelayPaths,
} from "./relay-assets.js";

export {
  createEgressViolationSink,
  renderEgressViolations,
  renderEgressFailureMessage,
  sshHostKeyFailureGuidance,
  SSH_HOST_KEY_GUIDANCE_LINE,
  type EgressAllowlistSource,
  type EgressViolation,
  type EgressViolationReason,
  type EgressViolationSink,
} from "./violations.js";

export {
  createEgressApprovalGate,
  type AskApproval,
  type CreateEgressApprovalGateOptions,
  type EgressApprovalGate,
} from "./approval.js";
