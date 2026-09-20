/**
 * src/harness/sandbox/egress/assembly.ts
 *
 * Production assembly helper + builtin preset merge semantics — reads
 *
 // (ADR-0097 ADR-0104)
 * `isolation.network.{allowedDomains,deniedDomains}` from
 * `loadIknowSettings()` and assembles `EgressPolicyInput` together with the
 * code-borne preset (preset-domains.ts, the list's SSOT).
 *
 * Single responsibility: decision-input construction happens only here; all
 * call sites (bash factory / background / verify) share one shape. The
 * egress domain never imports config back (dependency-injection form, same
 * discipline as egress/session.ts).
 *
 * Design points:
 *   - the factory returns `() => EgressPolicyInput | undefined`: the bash
 *     handler pulls the latest settings once per call (fine while settings
 *     are static; hot-reload is decided by loadIknowSettings' read root);
 *     the production assembly path **always returns a policy** (preset is
 *
 // (ADR-0097)
 *     non-empty ⇒ "allowlist non-empty" holds trivially, closing the old
 *
 // (ADR-0104)
 *     gap between the lifecycle table and the implementation); the
 *     `undefined` branch is kept only for callers that explicitly do not
 *     assemble egress (tests / yolo-style exemptions), no longer triggered
 *     by "settings section absent";
 *   - `commandLabel` comes from the caller (bash / background / verify each
 *     have their own semantic context, e.g. `bash:foreground` /
 *     `background:<taskId>` / `verify:<round>`);
 *   - `allowlistSource`: settings section absent = `"builtin"` (only the
 *     factory preset in play); section present = `"persisted"` (user-
 *     persisted settings merged in as an increment);
 *   - `askApproval` is **not** turned into a gate here (`approvalGate` is
 *     built at bash-factory closure time, sharing one session-level set
 *     across calls — see bash.ts); the helper only passes data through, and
 *     the chain `build-engine → registry → createBashTool` connects the gate
 *     inside bash.ts.
 */
import type {
  IknowSettings,
  IknowSettingsIsolationNetwork,
} from "../../../config/settings.js";
import {
  assembleEgressCredentials,
  type EgressCredentialRoster,
} from "./credential-assembly.js";
import type { EgressPolicyInput } from "./session.js";
import { BUILTIN_PRESET_ALLOWED_DOMAINS } from "./preset-domains.js";

/**
 * Factory inputs — injected by the call site (build-engine / assembly layer)
 * as needed.
 *
 * - `settings`: the caller may pre-read settings (avoiding sync I/O inside
 *   the factory; the build-engine main chain already has an injection seam
 *   `opts.settings`);
 * - `commandLabel`: fixed per call site (prefix by form + identifier).
 *
 * Note: the helper does not take `askApproval` — the bash factory side
 * (`effectiveEgressPolicyFactory` in bash.ts) owns constructing the
 * `EgressApprovalGate`; this helper only maps settings → data shape, so the
 * two layers never build two gates.
 */
export interface CreateEgressPolicyFactoryOptions {
  readonly settings: IknowSettings;
  readonly commandLabel: string;
  /**
   * Refuse-to-mint trace channel (warn trace for entries without injectHosts;
   * silence is forbidden). Default = skip silently (when the call site does
   * not care).
   */
  readonly onWarn?: (message: string) => void;
}

/**
 * Build `egressPolicyFactory` — handed to `createBashTool({ egressPolicyFactory })`
 * or `BackgroundSpawnRequest.egressPolicy` and similar call sites.
 *
 * Return shape: `() => EgressPolicyInput | undefined`, reading
 * `settings.isolation.network` once per call (equivalent to a closure constant
 * when settings are immutable). The signature keeps `| undefined` — the
 * background / verify consumer types need zero changes.
 *
 * Merge semantics:
 *
 // (ADR-0104)
 *   - section absent → preset-only policy (`allowlistSource: "builtin"`,
 *     empty deniedDomains) — the session must start, first-seen approval gate
 *     on duty;
 *   - section present → `allowedDomains = dedup(preset ∪ user allowedDomains)`
 *     (preset first, user increment after), `deniedDomains` taken from the
 *     user layer only, `allowlistSource: "persisted"`; deny-wins is unchanged
 *     (the user can cut any preset domain precisely via denied);
 *   - section present but both lists empty → same "present" path (preset
 *     still in play, no tier shrink; `allowlist-empty` is unreachable through
 *     the factory path);
 *   - invalid section shape dropped by the settings layer → `network =
 *     undefined`, back to the "absent" path = preset-only (drop-trace
 *     discipline lives in the settings layer).
 *
 * Separate file (complexity gate): the assembly helper may grow (host reads /
 * validating allow-vs-deny mutual exclusion), and standalone containment
 * keeps changes local.
 */
export function createEgressPolicyFactory(
  opts: CreateEgressPolicyFactoryOptions
): () => EgressPolicyInput | undefined {
  const { settings, commandLabel, onWarn } = opts;
  // Read settings once (on the build-engine main chain settings is a frozen
  // object resolved at module load, safe across calls; hot-reload = caller
  // rebuilds the factory). Section absent / dropped by the parse layer →
  // preset-only, no longer returning undefined (preset non-empty ⇒ the
  // production assembly path always starts an egress session) (ADR-0104).
  const network = settings.isolation?.network;
  // Credential roster assembly (two builtin github entries + user-section
  // narrowing/appending). The credentials section itself never decides
  // session start/stop — the non-empty preset makes production assembly
  // (ADR-0104 ADR-0107)
  // always start the session; credentials only travel with the policy data shape.
  const credentials = assembleEgressCredentials(
    settings.isolation?.credentials,
    onWarn
  );

  if (network === undefined) {
    // Section absent → preset-only policy (no undefined return).
    // Fence in play (narrow preset set); credential minting follows the
    // session's fenced tier; the no-fence trace belongs only to yolo /
    // isolation-OFF wiring (credential-assembly posture branch), not this
    // branch.
    return (): EgressPolicyInput => ({
      allowedDomains: [...BUILTIN_PRESET_ALLOWED_DOMAINS],
      deniedDomains: [],
      commandLabel,
      allowlistSource: "builtin",
      credentials,
    });
  }

  // Build the policy — dispatching directly on the frozen settings section
  // (settings.ts deep-freezes sections, reference safe). Leave
  // `deniedResolvedAddresses` undefined so session.ts falls back to
  // `DEFAULT_PRIVATE_DENIED_RANGES`, the default private-network deny set.
  return (): EgressPolicyInput =>
    buildEgressPolicy(network, commandLabel, credentials);
}

/**
 * Map an `IknowSettingsIsolationNetwork` section into `EgressPolicyInput`
 * (the "section present" path).
 *
 * Separate function (complexity gate): with the settings section present,
 * policy-shape construction converges here, leaving only the "no config =
 * preset-only" branch in the factory body.
 *
 * `allowlistSource = "persisted"` (user-persisted settings merged as an
 * increment). The bash factory side rewrites it to `"session"` after an
 * approval (bash.ts).
 */
function buildEgressPolicy(
  network: IknowSettingsIsolationNetwork,
  commandLabel: string,
  credentials: EgressCredentialRoster
): EgressPolicyInput {
  return {
    allowedDomains: mergeWithPreset(network.allowedDomains ?? []),
    // deny comes only from the user layer — the preset contributes no deny;
    // deny-wins is the user's escape hatch for cutting preset domains (the
    // dual of "users cannot disable the whole tier via config").
    deniedDomains: network.deniedDomains ?? [],
    commandLabel,
    allowlistSource: "persisted",
    // Data-shape injection only; minting consumption happens downstream,
    // this layer does not decide.
    credentials,
  };
}

/**
 * Dedup merge: preset first, user increment after (human-readable; order is
 *
 // (ADR-0104)
 * semantics). Exact-literal dedup — the settings layer already trims and
 * sanitizes shapes, so no case normalization here (decideEgress normalizes
 * the host at decision time; entry form stays verbatim).
 */
function mergeWithPreset(userAllowed: readonly string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const entry of [...BUILTIN_PRESET_ALLOWED_DOMAINS, ...userAllowed]) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    merged.push(entry);
  }
  return merged;
}
