/**
 * specs/egress-credential-sentinel.md T1 —— egress 域凭据名册装配单测。
 *
 * 钉住的不变式：
 *  - 内置 github 名册两条目逐字（SSOT 单文件）：`GH_TOKEN` env 条目 +
 *    `~/.config/gh/hosts.yml` 文件条目（structured extract 掩码形态），
 *    injectHosts = `github.com` / `*.github.com` / `*.githubusercontent.com`
 *    （spec 凭据名册表逐字，Assumption 6 静态钉）；
 *  - 用户段只做收窄/追加：同名（envVars）/ 同路径（files）用户条目替换
 *    内置条目（收窄），其余追加；内置条目 injectHosts 永不因用户段扩张；
 *  - 无 injectHosts 条目 → 不铸造 + warn 痕（Assumption 6：不吃包的
 *    allowedDomains 缺省；本仓适配层显式拒铸并留痕）；
 *  - invariant 3 数据形状钉：批准门新批域不进任何条目 injectHosts ——
 *    名册只来自「内置常量 + settings 段」两源，装配函数无 allowedDomains
 *    / 批准集入参（签名面即防线）；
 *  - EgressPolicyInput.credentials 接线：network 在场才产 policy（fail-closed
 *    语义不变），credentials 为纯数据注入（egress 域不反向 import config）。
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  assembleEgressCredentials,
  BUILTIN_GITHUB_CREDENTIAL_ROSTER,
} from "../../../src/harness/sandbox/egress/credential-assembly.js";
import { createEgressPolicyFactory } from "../../../src/harness/sandbox/egress/assembly.js";
import type { IknowSettings } from "../../../src/config/settings.js";

const GITHUB_INJECT_HOSTS = [
  "github.com",
  "*.github.com",
  "*.githubusercontent.com",
] as const;

describe("内置 github 名册（SSOT 逐字钉）", () => {
  it("两条目逐字：GH_TOKEN env + hosts.yml 文件条目，injectHosts 三域", () => {
    assert.deepEqual(BUILTIN_GITHUB_CREDENTIAL_ROSTER, {
      files: [
        {
          path: "~/.config/gh/hosts.yml",
          extract: "oauth_token:\\s*(\\S+)",
          injectHosts: [...GITHUB_INJECT_HOSTS],
        },
      ],
      envVars: [
        {
          name: "GH_TOKEN",
          injectHosts: [...GITHUB_INJECT_HOSTS],
        },
      ],
    });
  });

  it("名册常量深 frozen（跨 session 只读共享）", () => {
    assert.ok(Object.isFrozen(BUILTIN_GITHUB_CREDENTIAL_ROSTER));
    assert.ok(Object.isFrozen(BUILTIN_GITHUB_CREDENTIAL_ROSTER.files));
    assert.ok(Object.isFrozen(BUILTIN_GITHUB_CREDENTIAL_ROSTER.files[0]));
    assert.ok(
      Object.isFrozen(BUILTIN_GITHUB_CREDENTIAL_ROSTER.files[0].injectHosts)
    );
    assert.ok(Object.isFrozen(BUILTIN_GITHUB_CREDENTIAL_ROSTER.envVars[0]));
  });

  it("hosts.yml extract 模式含捕获组 1 且能抓 YAML oauth_token 行", () => {
    const re = new RegExp(BUILTIN_GITHUB_CREDENTIAL_ROSTER.files[0].extract!);
    const m = re.exec("  oauth_token: ghs_FAKEforTEST0000000000000000000000\n");
    assert.ok(m !== null);
    assert.equal(m[1], "ghs_FAKEforTEST0000000000000000000000");
  });
});

describe("assembleEgressCredentials — 收窄 / 追加", () => {
  it("用户段缺席 → 名册 = 内置两条目", () => {
    const roster = assembleEgressCredentials(undefined);
    assert.deepEqual(roster, BUILTIN_GITHUB_CREDENTIAL_ROSTER);
  });

  it("同名 env 条目 → 替换内置（收窄 injectHosts），不并存两份", () => {
    const roster = assembleEgressCredentials({
      envVars: [{ name: "GH_TOKEN", injectHosts: ["github.com"] }],
    });
    assert.equal(roster.envVars.length, 1);
    assert.deepEqual(roster.envVars[0], {
      name: "GH_TOKEN",
      injectHosts: ["github.com"],
    });
  });

  it("同路径 file 条目 → 替换内置条目", () => {
    const roster = assembleEgressCredentials({
      files: [
        {
          path: "~/.config/gh/hosts.yml",
          extract: "oauth_token:\\s*(\\S+)",
          injectHosts: ["*.github.dev"],
        },
      ],
    });
    assert.equal(roster.files.length, 1);
    assert.deepEqual(roster.files[0]?.injectHosts, ["*.github.dev"]);
  });

  it("新条目 → 追加，内置条目原样保留", () => {
    const roster = assembleEgressCredentials({
      envVars: [{ name: "FAKE_APP_TOKEN", injectHosts: ["credtest.example"] }],
    });
    assert.equal(roster.envVars.length, 2);
    assert.equal(roster.envVars[0]?.name, "GH_TOKEN");
    assert.equal(roster.envVars[1]?.name, "FAKE_APP_TOKEN");
  });

  it("产物深 frozen", () => {
    const roster = assembleEgressCredentials({
      envVars: [{ name: "FAKE_APP_TOKEN", injectHosts: ["credtest.example"] }],
    });
    assert.ok(Object.isFrozen(roster));
    assert.ok(Object.isFrozen(roster.envVars));
    assert.ok(Object.isFrozen(roster.envVars[1]));
  });
});

describe("assembleEgressCredentials — 无 injectHosts 拒铸 + warn 痕", () => {
  it("缺 injectHosts 的条目被拒铸 + warn（不吃放行集缺省）", () => {
    const warnings: string[] = [];
    const roster = assembleEgressCredentials(
      {
        envVars: [
          { name: "GH_TOKEN", injectHosts: ["github.com"] },
          { name: "BAD_NO_HOSTS" },
        ],
      } as never,
      (m) => warnings.push(m)
    );
    assert.equal(
      warnings.length,
      1,
      "拒铸必须留 warn 痕（invariant 7 禁静默）"
    );
    assert.match(warnings[0]!, /BAD_NO_HOSTS/);
    assert.match(warnings[0]!, /injectHosts/);
    assert.equal(roster.envVars.length, 1);
    assert.equal(roster.envVars[0]?.name, "GH_TOKEN");
  });

  it("空 injectHosts 数组同样拒铸 + warn", () => {
    const warnings: string[] = [];
    assembleEgressCredentials(
      { files: [{ path: "/x/fake.cred", injectHosts: [] }] } as never,
      (m) => warnings.push(m)
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /fake\.cred/);
  });
});

describe("createEgressPolicyFactory — credentials 接线", () => {
  const network = { allowedDomains: ["example.com"], deniedDomains: [] };

  function settingsWith(
    credentials: unknown,
    net: unknown = network
  ): IknowSettings {
    return {
      isolation: { network: net, credentials },
    } as unknown as IknowSettings;
  }

  it("network 在场 → policy.credentials 含内置名册（数据形状注入）", () => {
    const factory = createEgressPolicyFactory({
      settings: settingsWith(undefined),
      commandLabel: "bash:fg",
    });
    const policy = factory();
    assert.ok(policy !== undefined);
    assert.deepEqual(policy!.credentials, BUILTIN_GITHUB_CREDENTIAL_ROSTER);
  });

  it("network 缺席 → 工厂仍返 undefined（credentials 不开 session，fail-closed 不变）", () => {
    const factory = createEgressPolicyFactory({
      settings: {
        isolation: {
          credentials: {
            envVars: [
              { name: "FAKE_APP_TOKEN", injectHosts: ["credtest.example"] },
            ],
          },
        },
      } as unknown as IknowSettings,
      commandLabel: "bash:fg",
    });
    assert.equal(factory(), undefined);
  });

  it("用户段追加条目进入 policy.credentials（收窄/追加语义透传）", () => {
    const factory = createEgressPolicyFactory({
      settings: settingsWith({
        envVars: [
          { name: "FAKE_APP_TOKEN", injectHosts: ["credtest.example"] },
        ],
      }),
      commandLabel: "bash:fg",
    });
    const policy = factory();
    assert.equal(policy!.credentials?.envVars.length, 2);
  });

  it("既有字段形状零回归（allowedDomains/deniedDomains/commandLabel/allowlistSource）", () => {
    const factory = createEgressPolicyFactory({
      settings: settingsWith(undefined),
      commandLabel: "bash:fg",
    });
    const policy = factory();
    assert.deepEqual(policy!.allowedDomains, ["example.com"]);
    assert.deepEqual(policy!.deniedDomains, []);
    assert.equal(policy!.commandLabel, "bash:fg");
    assert.equal(policy!.allowlistSource, "preset");
  });
});
