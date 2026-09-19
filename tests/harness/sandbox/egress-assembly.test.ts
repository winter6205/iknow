/**
 * egress-preset-allowlist T1 装配单测 —— spec `specs/egress-preset-allowlist.md`
 * T1 / SC1 / SC2 / SC3 / F1 / F3 + ADR-0104 §Decision 1-2。
 *
 * 覆盖装配契约:
 *   1. 段缺席 → 工厂恒返 preset-only policy(allowlistSource "builtin"),
 *      不再返 undefined(ADR-0104 闭合 0097 生命周期表落差;undefined 分支
 *      仅留给调用方显式不装配的测试 / yolo 豁免路径)。
 *   2. 段在场 → allowedDomains = 去重(preset ∪ 用户增量),preset 前置次序;
 *      deniedDomains 只取用户层;allowlistSource "persisted"。
 *   3. 段在场但两列表皆空 → 不缩档(preset 仍在场)。
 *   4. F1:用户 deny `*.github.com` 砍掉 preset 子域后 apex 仍在(deny 优先
 *      与 `*.x` 不含 apex 的不对称)。
 *   5. F3:settings 段 shape 非法被 parse 层丢弃 → preset-only(builtin)。
 *   6. preset 清单逐字 = ADR-0107 §Decision 2 十四条目(源自 ADR-0104 §Decision 1
 *      六条目扩表; SSOT 单文件 frozen), 且不含已知模型供应商域 / 容器镜像仓库 /
 *      GitLab·Bitbucket(§Decision 3 反向断言)。
 *   7. 工厂返回类型保持 `() => EgressPolicyInput | undefined` 不缩
 *      (background / verify 消费面类型零改动)。
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
    assert.deepEqual([...BUILTIN_PRESET_ALLOWED_DOMAINS], [
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
    ]);
  });

  it("不含已知模型供应商域 / 容器镜像仓库 / GitLab·Bitbucket (ADR-0107 §Decision 2 不进档反向断言, SC2)", () => {
    // 围栏内有 provider key,预放行 = secret 直传通道 —— 显式不入档;
    // 容器镜像仓库与 GitLab/Bitbucket 走用户增量或批准门,同样不入档。
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
    assert.deepEqual([...policy!.allowedDomains], [
      ...BUILTIN_PRESET_ALLOWED_DOMAINS,
    ]);
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
    assert.deepEqual([...policy!.allowedDomains], [
      ...BUILTIN_PRESET_ALLOWED_DOMAINS,
    ]);
  });

  it("F3: settings 段 shape 非法被 parse 层丢弃 → preset-only builtin (旧行为是无 session)", () => {
    // 非法段经 settings 层 parseIsolationNetwork 丢弃留痕后为 undefined,
    // 工厂路径必须退到 preset-only 而非无 session。
    const discarded = parseIsolationNetwork("not-an-object");
    assert.equal(discarded, undefined);
    const factory = createEgressPolicyFactory({
      settings: { isolation: { network: discarded } } as unknown as IknowSettings,
      commandLabel: "bash:fg",
    });
    const policy = factory();
    assert.ok(policy !== undefined);
    assert.equal(policy!.allowlistSource, "builtin");
    assert.deepEqual([...policy!.allowedDomains], [
      ...BUILTIN_PRESET_ALLOWED_DOMAINS,
    ]);
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
    assert.deepEqual([...policy!.allowedDomains], [
      ...BUILTIN_PRESET_ALLOWED_DOMAINS,
      "example.com",
    ]);
    // deniedDomains 只取用户层, preset 不贡献 deny
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
    assert.deepEqual([...policy!.allowedDomains], [
      ...BUILTIN_PRESET_ALLOWED_DOMAINS,
    ]);
    assert.deepEqual([...policy!.deniedDomains], []);
    assert.equal(policy!.allowlistSource, "persisted");
    // 经工厂路径 allowlist-empty 不可达
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
    // deny 只取用户层; preset 的 *.github.com 仍在 allowed, 但 deny 优先
    assert.equal(policy.allowlistSource, "persisted");
    const sub = decideEgress({
      host: "api.github.com",
      port: 443,
      allowedDomains: policy.allowedDomains,
      deniedDomains: policy.deniedDomains,
    });
    assert.deepEqual(sub, { outcome: "deny", reason: "denied" });
    // `*.x` 不含 apex (0097 实测语义): apex 未被砍, 不对称钉死
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
    // 类型钉子: 消费面(bash.ts:135 / background / verify)声明的宽签名
    // 必须继续兼容; 若本函数签名收窄, 该行赋值虽仍编译, 但 undefined
    // 分支的调用方豁免路径(测试/yolo)由显式 `undefined` 常量保持可用。
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
    // 清单只列 proxy./sum. 两个 golang 子域与 pypi.org apex 本身:
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
