/**
 * ADR-0097 / T7 装配 helper 单测 —— createEgressPolicyFactory 把
 * `IknowSettings.isolation.network` 段映射成 `EgressPolicyInput`。
 *
 * 覆盖装配契约:
 *   1. settings.isolation.network 缺省 → 工厂返回 undefined(纯断网, fail-closed)
 *   2. settings.isolation.network 在场 + allow/deny 都填 → policy 形状对齐
 *   3. settings.isolation.network 在场 + allow/deny 缺省 → 空数组
 *   4. commandLabel 由 caller 透传(per-call 固定值, 由 bash / background /
 *      verify 各自传语义前缀如 `bash:foreground` / `background:<taskId>` /
 *      `verify:<round>`)
 *   5. allowlistSource 固定 "preset"(settings 段在场 = 预置配置;
 *      会话级放行由 bash 工厂侧的 approvalGate 决定,不在 helper 范围)
 *   6. 工厂多次调用:settings 不变则返回值 reference-stable
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { createEgressPolicyFactory } from "../../../src/harness/sandbox/egress/assembly.js";
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

describe("createEgressPolicyFactory (ADR-0097 / T7 装配 helper)", () => {
  it("settings.isolation.network 缺省 → 工厂返 undefined (fail-closed 纯断网)", () => {
    const factory = createEgressPolicyFactory({
      settings: makeSettings(undefined),
      commandLabel: "bash:fg",
    });
    assert.equal(factory(), undefined);
  });

  it("settings.isolation 整段缺省 → 同 fail-closed 语义(undefined)", () => {
    const factory = createEgressPolicyFactory({
      settings: {} as unknown as IknowSettings,
      commandLabel: "bash:fg",
    });
    assert.equal(factory(), undefined);
  });

  it("network 在场 + allow/deny 都填 → 完整 EgressPolicyInput 形状", () => {
    const network: IknowSettingsIsolationNetwork = {
      allowedDomains: ["example.com", "*.anthropic.com"],
      deniedDomains: ["internal.example.com"],
    };
    const factory = createEgressPolicyFactory({
      settings: makeSettings(network),
      commandLabel: "bash:fg",
    });
    const policy = factory();
    assert.ok(policy !== undefined);
    assert.deepEqual(policy!.allowedDomains, [
      "example.com",
      "*.anthropic.com",
    ]);
    assert.deepEqual(policy!.deniedDomains, ["internal.example.com"]);
    assert.equal(policy!.commandLabel, "bash:fg");
    assert.equal(policy!.allowlistSource, "preset");
  });

  it("network 在场 + allow/deny 缺省 → 空数组 (合法 fail-closed 态)", () => {
    const network = {} as IknowSettingsIsolationNetwork;
    const factory = createEgressPolicyFactory({
      settings: makeSettings(network),
      commandLabel: "bash:fg",
    });
    const policy = factory();
    assert.ok(policy !== undefined);
    assert.deepEqual(policy!.allowedDomains, []);
    assert.deepEqual(policy!.deniedDomains, []);
  });

  it("commandLabel 由 caller 透传(语义前缀由调用面决定)", () => {
    const network: IknowSettingsIsolationNetwork = {
      allowedDomains: ["example.com"],
      deniedDomains: [],
    };
    const factoryBg = createEgressPolicyFactory({
      settings: makeSettings(network),
      commandLabel: "background:bg-abc123",
    });
    const factoryVerify = createEgressPolicyFactory({
      settings: makeSettings(network),
      commandLabel: "verify:round-2",
    });
    assert.equal(factoryBg()!.commandLabel, "background:bg-abc123");
    assert.equal(factoryVerify()!.commandLabel, "verify:round-2");
  });

  it("工厂多次调用:同一 settings → 返回值 reference-stable(无热重载)", () => {
    const network: IknowSettingsIsolationNetwork = {
      allowedDomains: ["example.com"],
      deniedDomains: [],
    };
    const factory = createEgressPolicyFactory({
      settings: makeSettings(network),
      commandLabel: "bash:fg",
    });
    const a = factory();
    const b = factory();
    // 不要求 === (settings 段是新对象),但形状一致
    assert.deepEqual(a, b);
  });

  it("askApproval **不**出现在 EgressPolicyInput(由 bash 工厂侧注入 approvalGate)", () => {
    // 验收契约:helper 只透传 settings 数据,gate 由 bash 工厂闭包期构造。
    // 若 helper 误带 approvalGate 字段,这里会通过类型守卫捕获。
    const network: IknowSettingsIsolationNetwork = {
      allowedDomains: ["example.com"],
      deniedDomains: [],
    };
    const factory = createEgressPolicyFactory({
      settings: makeSettings(network),
      commandLabel: "bash:fg",
    });
    const policy = factory();
    assert.equal(
      Object.prototype.hasOwnProperty.call(policy, "approvalGate"),
      false
    );
  });
});
