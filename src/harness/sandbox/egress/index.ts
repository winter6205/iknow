/**
 * src/harness/sandbox/egress/index.ts
 *
 * Egress domain barrel — the public export surface of `src/harness/sandbox/egress/*`.
 *
 * Single responsibility: re-exports only, no logic assembly. Consumers:
 *   - `createEgressSession` + `EgressFenceSpec`: bash handler wiring;
 *   - `EgressViolationSink` / `renderEgressViolations`: bash tool_result feed-back;
 *   - `EgressPolicyInput`: injected by the bash handler after reading settings;
 *   - `createEgressApprovalGate`: built once at bash-tool factory closure
 *     time, shared across calls.
 *
 * `domain-matcher` is deliberately not exported — it is an internal piece
 * whose tests import it directly by path.
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

export {
  assembleEgressCredentials,
  BUILTIN_GITHUB_CREDENTIAL_ROSTER,
  type EgressCredentialEnvVarEntry,
  type EgressCredentialFileEntry,
  type EgressCredentialRoster,
  type UserCredentialSection,
} from "./credential-assembly.js";

export {
  assertInjectedEnvInFakeSpace,
  assertSentinelSubstringContract,
  EgressCredentialMintError,
  mintEgressCredentials,
  type CredentialDenyTrace,
  type EgressCredentialMint,
  type EgressCredentialMintErrorKind,
  type EgressFenceBind,
  type MintEgressCredentialsArgs,
} from "./credential-mint.js";
