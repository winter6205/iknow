/**
 * specs/egress-credential-sentinel.md — assembly unit tests for the
 * egress-domain credential roster.
 *
 * Pinned invariants:
 *  - the two built-in github roster entries verbatim (SSOT single file): a
 *    `GH_TOKEN` env entry + a `~/.config/gh/hosts.yml` file entry (structured
 *    extract mask form), injectHosts = `github.com` / `*.github.com` /
 *    `*.githubusercontent.com` (verbatim from the spec roster table,
 *    Assumption 6 static pin);
 *  - the user section only narrows/appends: a user entry with the same name
 *    (envVars) or path (files) replaces the builtin entry (narrowing), the
 *    rest are appended; user edits never expand a builtin entry's
 *    injectHosts;
 *  - an entry without injectHosts → no minting + warn trace (Assumption 6:
 *    does not silently consume the package allowedDomains default; this
 *    repo's adapter layer explicitly refuses to mint and leaves a trace);
 *  - invariant 3 data-shape pin: newly approved domains from the approval
 *    gate enter no entry's injectHosts — the roster comes only from "builtin
 *    constants + settings section", and the assembly function takes no
 *    allowedDomains / approval-set parameter (the signature is the defense);
 *  - EgressPolicyInput.credentials wiring: production assembly always
 *    produces a policy (preset spec invariant 3: absent section = builtin
 *    preset-only, session must start); credentials never decides start/stop,
 *    it only rides the policy data shape (the egress domain never imports
 *    config in reverse).
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  assembleEgressCredentials,
  BUILTIN_GITHUB_CREDENTIAL_ROSTER,
} from "../../../src/harness/sandbox/egress/credential-assembly.js";
import { createEgressPolicyFactory } from "../../../src/harness/sandbox/egress/assembly.js";
import { BUILTIN_PRESET_ALLOWED_DOMAINS } from "../../../src/harness/sandbox/egress/preset-domains.js";
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

  it("network 缺席 → builtin preset policy（credentials 不开 session，只随 policy 数据形状走）", () => {
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
    // preset spec invariant 3: an absent section no longer returns undefined —
    // the builtin narrow-set session must start; credentials still never decides
    // start/stop, it rides the policy injection.
    const policy = factory();
    assert.ok(policy !== undefined);
    assert.equal(policy!.allowlistSource, "builtin");
    assert.deepEqual(policy!.allowedDomains, [
      ...BUILTIN_PRESET_ALLOWED_DOMAINS,
    ]);
    assert.equal(policy!.credentials?.envVars.length, 2);
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
    // section present = dedup(preset ∪ user additions), preset kept in front (spec merge semantics).
    assert.deepEqual(policy!.allowedDomains, [
      ...BUILTIN_PRESET_ALLOWED_DOMAINS,
      "example.com",
    ]);
    assert.deepEqual(policy!.deniedDomains, []);
    assert.equal(policy!.commandLabel, "bash:fg");
    assert.equal(policy!.allowlistSource, "persisted");
  });
});
