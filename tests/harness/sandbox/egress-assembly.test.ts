/**
 * Assembly unit tests for the egress preset allowlist
 * (specs/egress-preset-allowlist.md, ADR-0104 Decision 1-2).
 *
 * Assembly contracts covered:
 *   1. Section absent → the factory always returns a preset-only policy
 *      (allowlistSource "builtin"), never undefined (ADR-0104 closes the
 *      ADR-0097 lifecycle-table gap; the undefined branch is reserved for
 *      callers that explicitly opt out of assembly — tests / yolo paths).
 *   2. Section present → allowedDomains = dedup(preset ∪ user additions)
 *      with the preset kept in front order; deniedDomains taken from the
 *      user layer only; allowlistSource "persisted".
 *   3. Section present but both lists empty → the profile does not shrink
 *      (the preset is still in effect).
 *   4. Deny asymmetry: a user deny of `*.github.com` cuts preset subdomains
 *      while the apex remains (deny precedence vs "`*.x` not matching apex").
 *   5. A settings section with an invalid shape is dropped by the parse
 *      layer → preset-only (builtin).
 *   6. The preset list verbatim = the 14 entries of ADR-0107 Decision 2
 *      (extended from ADR-0104 Decision 1's six entries; SSOT single frozen
 *      file), and covers no known model-provider domain / container image
 *      registry / GitLab·Bitbucket (negative assertion, Decision 3).
 *   7. The factory return type stays `() => EgressPolicyInput | undefined`,
 *      never narrowed (zero type churn on background / verify consumers).
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { createEgressPolicyFactory } from "../../../src/harness/sandbox/egress/assembly.js";
import { BUILTIN_PRESET_ALLOWED_DOMAINS } from "../../../src/harness/sandbox/egress/preset-domains.js";
import { decideEgress } from "../../../src/harness/sandbox/egress/domain-matcher.js";
import type { EgressPolicyInput } from "../../../src/harness/sandbox/egress/session.js";
import { parseIsolationNetwork } from "../../../src/config/isolation-network.js";
import type {
  IknowSettings,
  IknowSettingsIsolationNetwork,
} from "../../../src/config/settings.js";

function makeSettings(
  network: IknowSettingsIsolationNetwork | undefined
): IknowSettings {
  return {
    isolation: network === undefined ? undefined : { network },
  } as unknown as IknowSettings;
}

describe("BUILTIN_PRESET_ALLOWED_DOMAINS (ADR-0107 §Decision 2 清单 SSOT)", () => {
  it("frozen 数组,14 条目逐字 = ADR-0107 §Decision 2 清单", () => {
    assert.ok(Object.isFrozen(BUILTIN_PRESET_ALLOWED_DOMAINS));
    assert.deepEqual(
      [...BUILTIN_PRESET_ALLOWED_DOMAINS],
      [
        "github.com",
        "*.github.com",
        "*.githubusercontent.com",
        "registry.npmjs.org",
        "registry.yarnpkg.com",
        "pypi.org",
        "files.pythonhosted.org",
        "crates.io",
        "static.crates.io",
        "index.crates.io",
        "proxy.golang.org",
        "sum.golang.org",
        "playwright.download.prss.microsoft.com",
        "cdn.playwright.dev",
      ]
    );
  });

  it("不含已知模型供应商域 / 容器镜像仓库 / GitLab·Bitbucket (ADR-0107 §Decision 2 不进档反向断言, SC2)", () => {
    // A provider key lives inside the fence, so pre-allowing = a direct
    // secret channel — explicitly kept out of the profile; container image
    // registries and GitLab/Bitbucket go through user additions or the
    // approval gate, likewise out of the preset.
    const providerDomains = [
      "anthropic.com",
      "openai.com",
      "generativelanguage.googleapis.com",
      "api.x.ai",
      "api.deepseek.com",
    ];
    const outOfScopeDomains = [
      "docker.io",
      "registry-1.docker.io",
      "ghcr.io",
      "quay.io",
      "mcr.microsoft.com",
      "gitlab.com",
      "bitbucket.org",
    ];
    for (const entry of BUILTIN_PRESET_ALLOWED_DOMAINS) {
      const host = entry.replace(/^\*\./, "");
      for (const provider of [...providerDomains, ...outOfScopeDomains]) {
        assert.notEqual(host, provider);
        assert.ok(
          !host.endsWith(`.${provider}`),
          `preset entry ${JSON.stringify(entry)} must not cover provider ${provider}`
        );
      }
    }
  });
});

describe("createEgressPolicyFactory (T1 合并装配)", () => {
  it("段缺席 → preset-only policy, allowlistSource builtin (断言反转: 旧行为 undefined)", () => {
    const factory = createEgressPolicyFactory({
      settings: makeSettings(undefined),
      commandLabel: "bash:fg",
    });
    const policy = factory();
    assert.ok(policy !== undefined);
    assert.deepEqual(
      [...policy!.allowedDomains],
      [...BUILTIN_PRESET_ALLOWED_DOMAINS]
    );
    assert.deepEqual([...policy!.deniedDomains], []);
    assert.equal(policy!.commandLabel, "bash:fg");
    assert.equal(policy!.allowlistSource, "builtin");
  });

  it("isolation 整段缺席 → 同样 preset-only builtin 档 (session 必起)", () => {
    const factory = createEgressPolicyFactory({
      settings: {} as unknown as IknowSettings,
      commandLabel: "bash:fg",
    });
    const policy = factory();
    assert.ok(policy !== undefined);
    assert.equal(policy!.allowlistSource, "builtin");
    assert.deepEqual(
      [...policy!.allowedDomains],
      [...BUILTIN_PRESET_ALLOWED_DOMAINS]
    );
  });

  it("F3: settings 段 shape 非法被 parse 层丢弃 → preset-only builtin (旧行为是无 session)", () => {
    // An invalid section is dropped (with a trace) by parseIsolationNetwork at
    // the settings layer, leaving undefined; the factory path must degrade to
    // preset-only, not to "no session".
    const discarded = parseIsolationNetwork("not-an-object");
    assert.equal(discarded, undefined);
    const factory = createEgressPolicyFactory({
      settings: {
        isolation: { network: discarded },
      } as unknown as IknowSettings,
      commandLabel: "bash:fg",
    });
    const policy = factory();
    assert.ok(policy !== undefined);
    assert.equal(policy!.allowlistSource, "builtin");
    assert.deepEqual(
      [...policy!.allowedDomains],
      [...BUILTIN_PRESET_ALLOWED_DOMAINS]
    );
  });

  it("段在场 → 去重(preset ∪ 用户增量), preset 前置次序, source persisted", () => {
    const network: IknowSettingsIsolationNetwork = {
      allowedDomains: ["example.com", "github.com"],
      deniedDomains: ["internal.example.com"],
    };
    const factory = createEgressPolicyFactory({
      settings: makeSettings(network),
      commandLabel: "bash:fg",
    });
    const policy = factory();
    assert.ok(policy !== undefined);
    assert.deepEqual(
      [...policy!.allowedDomains],
      [...BUILTIN_PRESET_ALLOWED_DOMAINS, "example.com"]
    );
    // deniedDomains comes from the user layer only; the preset contributes no denies
    assert.deepEqual([...policy!.deniedDomains], ["internal.example.com"]);
    assert.equal(policy!.allowlistSource, "persisted");
  });

  it("段在场但两列表皆空 → 不缩档: allowed 仍是 preset, source persisted (SC3 / F2)", () => {
    const network = {
      allowedDomains: [],
      deniedDomains: [],
    } as IknowSettingsIsolationNetwork;
    const factory = createEgressPolicyFactory({
      settings: makeSettings(network),
      commandLabel: "verify:round-1",
    });
    const policy = factory();
    assert.ok(policy !== undefined);
    assert.deepEqual(
      [...policy!.allowedDomains],
      [...BUILTIN_PRESET_ALLOWED_DOMAINS]
    );
    assert.deepEqual([...policy!.deniedDomains], []);
    assert.equal(policy!.allowlistSource, "persisted");
    // via the factory path an empty allowlist is unreachable
    const decision = decideEgress({
      host: "example.com",
      port: 443,
      allowedDomains: policy!.allowedDomains,
      deniedDomains: policy!.deniedDomains,
    });
    assert.equal(decision.reason, "not-in-allowlist");
  });

  it("F1 不对称: 用户 deny *.github.com 砍子域后 github.com apex 仍在", () => {
    const network: IknowSettingsIsolationNetwork = {
      allowedDomains: [],
      deniedDomains: ["*.github.com"],
    };
    const factory = createEgressPolicyFactory({
      settings: makeSettings(network),
      commandLabel: "bash:fg",
    });
    const policy = factory()!;
    // Deny comes from the user layer only; the preset's *.github.com stays in allowed, but deny wins
    assert.equal(policy.allowlistSource, "persisted");
    const sub = decideEgress({
      host: "api.github.com",
      port: 443,
      allowedDomains: policy.allowedDomains,
      deniedDomains: policy.deniedDomains,
    });
    assert.deepEqual(sub, { outcome: "deny", reason: "denied" });
    // `*.x` does not cover apex (ADR-0097 observed semantics): apex is not cut, the asymmetry is pinned
    const apex = decideEgress({
      host: "github.com",
      port: 443,
      allowedDomains: policy.allowedDomains,
      deniedDomains: policy.deniedDomains,
    });
    assert.deepEqual(apex, { outcome: "allow" });
  });

  it("commandLabel 由 caller 透传(background / verify 消费面语义前缀)", () => {
    const network: IknowSettingsIsolationNetwork = {
      allowedDomains: ["example.com"],
      deniedDomains: [],
    };
    const factoryBg = createEgressPolicyFactory({
      settings: makeSettings(network),
      commandLabel: "background:bg-abc123",
    });
    const factoryVerify = createEgressPolicyFactory({
      settings: makeSettings(undefined),
      commandLabel: "verify:round-2",
    });
    assert.equal(factoryBg()!.commandLabel, "background:bg-abc123");
    assert.equal(factoryVerify()!.commandLabel, "verify:round-2");
  });

  it("工厂多次调用:同一 settings → 返回值形状稳定(无热重载)", () => {
    const network: IknowSettingsIsolationNetwork = {
      allowedDomains: ["example.com"],
      deniedDomains: [],
    };
    const factory = createEgressPolicyFactory({
      settings: makeSettings(network),
      commandLabel: "bash:fg",
    });
    assert.deepEqual(factory(), factory());
  });

  it("askApproval 不出现在 EgressPolicyInput (gate 由 bash 工厂侧注入)", () => {
    const factory = createEgressPolicyFactory({
      settings: makeSettings(undefined),
      commandLabel: "bash:fg",
    });
    const policy = factory()!;
    assert.equal(
      Object.prototype.hasOwnProperty.call(policy, "approvalGate"),
      false
    );
  });

  it("工厂返回类型保持 () => EgressPolicyInput | undefined 不缩", () => {
    // Type pin: the widened signature declared by consumers (bash.ts /
    // background / verify) must stay compatible; if this factory's signature
    // narrowed, the assignment would still compile, but the undefined-branch
    // caller exemption paths (tests / yolo) stay available via an explicit
    // `undefined` constant.
    const factory: () => EgressPolicyInput | undefined =
      createEgressPolicyFactory({
        settings: makeSettings(undefined),
        commandLabel: "bash:fg",
      });
    const widened: () => EgressPolicyInput | undefined = () => undefined;
    assert.equal(factory() === undefined, false);
    assert.equal(widened(), undefined);
  });
});

describe("decideEgress 直喂合并结果 (T1 判定层钉子)", () => {
  const presetPolicy = createEgressPolicyFactory({
    settings: makeSettings(undefined),
    commandLabel: "bash:fg",
  })()!;

  function decide(host: string) {
    return decideEgress({
      host,
      port: 443,
      allowedDomains: presetPolicy.allowedDomains,
      deniedDomains: presetPolicy.deniedDomains,
    });
  }

  it("github.com apex 与 *.github.com 子域双命中 (apex+通配并列写)", () => {
    assert.deepEqual(decide("github.com"), { outcome: "allow" });
    assert.deepEqual(decide("api.github.com"), { outcome: "allow" });
    assert.deepEqual(decide("raw.githubusercontent.com"), {
      outcome: "allow",
    });
  });

  it("registry.npmjs.org 命中而 npmjs.org apex 不命中 (清单只写 registry 子域, 钉住不误扩)", () => {
    assert.deepEqual(decide("registry.npmjs.org"), { outcome: "allow" });
    assert.deepEqual(decide("npmjs.org"), {
      outcome: "deny",
      reason: "not-in-allowlist",
    });
  });

  it("ADR-0107 扩表命中: pypi / crates / golang 主路径域 allow", () => {
    assert.deepEqual(decide("pypi.org"), { outcome: "allow" });
    assert.deepEqual(decide("files.pythonhosted.org"), { outcome: "allow" });
    assert.deepEqual(decide("crates.io"), { outcome: "allow" });
    assert.deepEqual(decide("static.crates.io"), { outcome: "allow" });
    assert.deepEqual(decide("index.crates.io"), { outcome: "allow" });
    assert.deepEqual(decide("proxy.golang.org"), { outcome: "allow" });
    assert.deepEqual(decide("sum.golang.org"), { outcome: "allow" });
    assert.deepEqual(decide("registry.yarnpkg.com"), { outcome: "allow" });
  });

  it("ADR-0107 扩表 apex/子域不对称: golang.org apex 与 pypi 子域不命中 (只写登记面, 不误扩整域)", () => {
    // The list registers only the proxy./sum. golang subdomains and the pypi.org apex itself:
    assert.deepEqual(decide("golang.org"), {
      outcome: "deny",
      reason: "not-in-allowlist",
    });
    assert.deepEqual(decide("test.pypi.org"), {
      outcome: "deny",
      reason: "not-in-allowlist",
    });
  });

  it("evil-github.com / github.com.evil.io 不命中 (后缀锚定回归)", () => {
    assert.deepEqual(decide("evil-github.com"), {
      outcome: "deny",
      reason: "not-in-allowlist",
    });
    assert.deepEqual(decide("github.com.evil.io"), {
      outcome: "deny",
      reason: "not-in-allowlist",
    });
  });
});
