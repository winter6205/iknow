/**
 * spec/network-egress-allowlist.md SC12 配置层契约:
 *  - 空 allowedDomains → 全拒（fail-closed），空数组是合法态不是错误
 *  - 非字符串条目 / trim 后为空 / allowed 中裸 `*` → 丢弃该条目 + 警告
 *  - `:port` 越界（0 / >65535 / 非数字 / 空）→ 拒绝该条目 + 警告
 *  - 非法条目不影响同批合法条目（逐条判定）
 *  - deniedDomains 同款纪律，裸 `*` 也丢弃
 *  - 项目层出现 `isolation.network` → 整体不生效（沿用现有
 *    filterProjectSettingsKeys 对整个 isolation 段的丢弃警告，不重复发）
 *  - 解析体冻结 / persist 往返保真
 *  - onWarn 消息以 `[settings] ...` 前缀，对齐既有纪律
 *
 * 只做配置层形态合法判定；`*.x` 通配语义留给 T3。
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadIknowSettings } from "../../src/config/settings.ts";
import { persistThinkingChanges } from "../../src/config/persist-settings.ts";

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "iknow-isolation-network-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function makeSettings(
  user: Record<string, unknown>,
  project: Record<string, unknown>
): Promise<{ home: string; cwd: string; userFile: string }> {
  const seed = Math.random().toString(36).slice(2);
  const home = join(workDir, "home", seed);
  const cwd = join(workDir, "cwd", seed);
  const userFile = join(home, ".iknow", "settings.json");
  await mkdir(join(home, ".iknow"), { recursive: true });
  await mkdir(join(cwd, ".iknow"), { recursive: true });
  if (Object.keys(user).length > 0) {
    await writeFile(userFile, JSON.stringify(user));
  }
  if (Object.keys(project).length > 0) {
    await writeFile(
      join(cwd, ".iknow", "settings.json"),
      JSON.stringify(project)
    );
  }
  return { home, cwd, userFile };
}

describe("settings.isolation.network.allowedDomains — normal path", () => {
  it("单条 hostname → 解析保留", async () => {
    const { home, cwd } = await makeSettings(
      { isolation: { network: { allowedDomains: ["example.com"] } } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }).isolation, {
      network: { allowedDomains: ["example.com"] },
    });
  });

  it("多条混合（含 :port / 子域 / 含点号）→ 全部保留", async () => {
    const { home, cwd } = await makeSettings(
      {
        isolation: {
          network: {
            allowedDomains: [
              "example.com",
              "api.example.com",
              "registry.npmjs.org:443",
              "github.com:22",
            ],
          },
        },
      },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }).isolation, {
      network: {
        allowedDomains: [
          "example.com",
          "api.example.com",
          "registry.npmjs.org:443",
          "github.com:22",
        ],
      },
    });
  });

  it("空数组 → 保留为空数组（fail-closed 合法态，由判定层据此全拒）", async () => {
    const { home, cwd } = await makeSettings(
      { isolation: { network: { allowedDomains: [] } } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }).isolation, {
      network: { allowedDomains: [] },
    });
  });

  it("deniedDomains 与 allowedDomains 同时在场 → 各自独立保留", async () => {
    const { home, cwd } = await makeSettings(
      {
        isolation: {
          network: {
            allowedDomains: ["example.com"],
            deniedDomains: ["ads.example.com"],
          },
        },
      },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }).isolation, {
      network: {
        allowedDomains: ["example.com"],
        deniedDomains: ["ads.example.com"],
      },
    });
  });

  it("trim 后合法 hostname → 保留 trim 结果", async () => {
    const { home, cwd } = await makeSettings(
      { isolation: { network: { allowedDomains: ["  example.com  "] } } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }).isolation, {
      network: { allowedDomains: ["example.com"] },
    });
  });
});

describe("settings.isolation.network — invalid entries dropped with onWarn", () => {
  it("非字符串条目 → 丢弃该条 + 警告（不抛）", async () => {
    const { home, cwd } = await makeSettings(
      {
        isolation: {
          network: {
            allowedDomains: ["example.com", 123, null, { host: "x" }],
          },
        },
      },
      {}
    );
    const warnings: string[] = [];
    assert.deepEqual(
      loadIknowSettings({ home, cwd, onWarn: (m) => warnings.push(m) })
        .isolation,
      { network: { allowedDomains: ["example.com"] } }
    );
    assert.equal(warnings.length, 3);
    for (const w of warnings) {
      assert.match(w, /\[settings\]/);
      assert.match(w, /allowedDomains/);
    }
  });

  it("trim 后为空 → 丢弃该条 + 警告", async () => {
    const { home, cwd } = await makeSettings(
      {
        isolation: { network: { allowedDomains: ["", "   ", "example.com"] } },
      },
      {}
    );
    const warnings: string[] = [];
    assert.deepEqual(
      loadIknowSettings({ home, cwd, onWarn: (m) => warnings.push(m) })
        .isolation,
      { network: { allowedDomains: ["example.com"] } }
    );
    assert.equal(warnings.length, 2);
    for (const w of warnings) {
      assert.match(w, /\[settings\]/);
      assert.match(w, /allowedDomains/);
    }
  });

  it("allowed 中裸 `*` → 丢弃 + 警告", async () => {
    const { home, cwd } = await makeSettings(
      {
        isolation: {
          network: { allowedDomains: ["*", "example.com"] },
        },
      },
      {}
    );
    const warnings: string[] = [];
    assert.deepEqual(
      loadIknowSettings({ home, cwd, onWarn: (m) => warnings.push(m) })
        .isolation,
      { network: { allowedDomains: ["example.com"] } }
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /\[settings\]/);
    assert.match(warnings[0]!, /allowedDomains/);
    assert.match(warnings[0]!, /\*/);
  });

  it("denied 中裸 `*` → 丢弃 + 警告（保守做法：对齐 allowed 同纪律）", async () => {
    const { home, cwd } = await makeSettings(
      {
        isolation: {
          network: { deniedDomains: ["*", "ads.example.com"] },
        },
      },
      {}
    );
    const warnings: string[] = [];
    assert.deepEqual(
      loadIknowSettings({ home, cwd, onWarn: (m) => warnings.push(m) })
        .isolation,
      { network: { deniedDomains: ["ads.example.com"] } }
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /deniedDomains/);
  });

  it(":port 越界 / 非法值 → 拒绝该条目 + 警告（不透传为永不匹配）", async () => {
    // 端口：0 / 65536 / 非数字 / 空 / 负数
    const { home, cwd } = await makeSettings(
      {
        isolation: {
          network: {
            allowedDomains: [
              "example.com:0",
              "example.com:65536",
              "example.com:abc",
              "example.com:",
              "example.com:-1",
              "example.com", // 这条合法
            ],
          },
        },
      },
      {}
    );
    const warnings: string[] = [];
    assert.deepEqual(
      loadIknowSettings({ home, cwd, onWarn: (m) => warnings.push(m) })
        .isolation,
      { network: { allowedDomains: ["example.com"] } }
    );
    assert.equal(warnings.length, 5);
    for (const w of warnings) {
      assert.match(w, /\[settings\]/);
      assert.match(w, /allowedDomains/);
    }
  });

  it("非法条目不影响同批合法条目（逐条判定）", async () => {
    const { home, cwd } = await makeSettings(
      {
        isolation: {
          network: {
            allowedDomains: [
              "good1.example.com",
              "*",
              "good2.example.com:443",
              42,
              "good3.example.com",
            ],
          },
        },
      },
      {}
    );
    const warnings: string[] = [];
    assert.deepEqual(
      loadIknowSettings({ home, cwd, onWarn: (m) => warnings.push(m) })
        .isolation,
      {
        network: {
          allowedDomains: [
            "good1.example.com",
            "good2.example.com:443",
            "good3.example.com",
          ],
        },
      }
    );
    assert.equal(warnings.length, 2);
  });

  it("丢弃后若导致空集 → 保留为空数组事实（fail-closed 信号）", async () => {
    const { home, cwd } = await makeSettings(
      {
        isolation: {
          network: { allowedDomains: ["*", "", 42] },
        },
      },
      {}
    );
    const warnings: string[] = [];
    assert.deepEqual(
      loadIknowSettings({ home, cwd, onWarn: (m) => warnings.push(m) })
        .isolation,
      { network: { allowedDomains: [] } }
    );
    // 三条非法 → 三条警告
    assert.equal(warnings.length, 3);
  });

  it("non-array allowedDomains → 丢弃字段（非数组类型）", async () => {
    const { home, cwd } = await makeSettings(
      { isolation: { network: { allowedDomains: "example.com" } } },
      {}
    );
    const warnings: string[] = [];
    assert.deepEqual(
      loadIknowSettings({ home, cwd, onWarn: (m) => warnings.push(m) })
        .isolation,
      undefined
    );
    assert.equal(warnings.length, 0);
  });

  it("non-object network 段 → 不产出 network 子段，不警告", async () => {
    const { home, cwd } = await makeSettings(
      { isolation: { network: "open" } },
      {}
    );
    const warnings: string[] = [];
    assert.deepEqual(
      loadIknowSettings({ home, cwd, onWarn: (m) => warnings.push(m) })
        .isolation,
      undefined
    );
    assert.equal(warnings.length, 0);
  });

  it("未知 sibling 字段（network 下）→ 丢弃，不影响 allowedDomains", async () => {
    const { home, cwd } = await makeSettings(
      {
        isolation: {
          network: {
            allowedDomains: ["example.com"],
            futureFlag: 1,
          },
        },
      },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }).isolation, {
      network: { allowedDomains: ["example.com"] },
    });
  });
});

describe("settings.isolation.network — project layer discard (SC9)", () => {
  it("project 写 isolation.network → 整体不生效 + 一条 isolation 警告", async () => {
    const { home, cwd } = await makeSettings(
      { isolation: { network: { allowedDomains: ["example.com"] } } },
      { isolation: { network: { allowedDomains: ["evil.com"] } } }
    );
    const warnings: string[] = [];
    const settings = loadIknowSettings({
      home,
      cwd,
      onWarn: (m) => warnings.push(m),
    });
    // user 值胜出
    assert.deepEqual(settings.isolation, {
      network: { allowedDomains: ["example.com"] },
    });
    // 既有 filterProjectSettingsKeys 对整个 isolation key 发一条警告 —— 不重复发 network 级警告
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /"isolation"/);
    assert.doesNotMatch(warnings[0]!, /network/);
  });

  it("project 写 isolation.network + user 无值 → 不生效且不产出 network 段", async () => {
    const { home, cwd } = await makeSettings(
      {},
      { isolation: { network: { allowedDomains: ["evil.com"] } } }
    );
    const warnings: string[] = [];
    const settings = loadIknowSettings({
      home,
      cwd,
      onWarn: (m) => warnings.push(m),
    });
    assert.equal(settings.isolation, undefined);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /"isolation"/);
  });

  it("user 有 fsMode 等其它 isolation 字段，project 写 network → user 字段原样保留", async () => {
    const { home, cwd } = await makeSettings(
      {
        isolation: {
          worktreeOnMutate: true,
          fsMode: "workspace",
          network: { allowedDomains: ["example.com"] },
        },
      },
      {
        isolation: { network: { allowedDomains: ["evil.com"] } },
      }
    );
    const warnings: string[] = [];
    const settings = loadIknowSettings({
      home,
      cwd,
      onWarn: (m) => warnings.push(m),
    });
    assert.deepEqual(settings.isolation, {
      worktreeOnMutate: true,
      fsMode: "workspace",
      network: { allowedDomains: ["example.com"] },
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /"isolation"/);
  });
});

describe("settings.isolation.network — freeze + persist round-trip", () => {
  it("freeze：解析后整个 isolation 段含 network 子段均深 frozen", async () => {
    const { home, cwd } = await makeSettings(
      {
        isolation: {
          network: { allowedDomains: ["example.com"], deniedDomains: [] },
        },
      },
      {}
    );
    const settings = loadIknowSettings({ home, cwd });
    assert.ok(Object.isFrozen(settings));
    assert.ok(Object.isFrozen(settings.isolation));
    assert.ok(Object.isFrozen(settings.isolation!.network));
    assert.ok(Object.isFrozen(settings.isolation!.network!.allowedDomains));
  });

  it("persist 往返：network 段在 user 文件保真（与 worktreeOnMutate 同款）", async () => {
    const { home, cwd, userFile } = await makeSettings(
      {
        isolation: { network: { allowedDomains: ["example.com"] } },
        llm: { model: "claude-sonnet" },
      },
      {}
    );
    await persistThinkingChanges(userFile, { thinking: "adaptive" });
    const settings = loadIknowSettings({ home, cwd });
    assert.deepEqual(settings.isolation, {
      network: { allowedDomains: ["example.com"] },
    });
    assert.equal(settings.llm?.thinking, "adaptive");
  });
});

describe("settings.isolation.network — interaction with other isolation fields", () => {
  it("worktreeOnMutate / worktreeExclusive / fsMode / network 同段共存", async () => {
    const { home, cwd } = await makeSettings(
      {
        isolation: {
          worktreeOnMutate: true,
          worktreeExclusive: false,
          fsMode: "workspace",
          network: { allowedDomains: ["example.com"] },
        },
      },
      {}
    );
    const settings = loadIknowSettings({ home, cwd });
    assert.deepEqual(settings.isolation, {
      worktreeOnMutate: true,
      worktreeExclusive: false,
      fsMode: "workspace",
      network: { allowedDomains: ["example.com"] },
    });
  });

  it("network 字段非法值不影响其它 isolation 字段", async () => {
    const { home, cwd } = await makeSettings(
      {
        isolation: {
          worktreeOnMutate: true,
          fsMode: "workspace",
          network: { allowedDomains: ["*", "", 42, "example.com"] },
        },
      },
      {}
    );
    const warnings: string[] = [];
    assert.deepEqual(
      loadIknowSettings({ home, cwd, onWarn: (m) => warnings.push(m) })
        .isolation,
      {
        worktreeOnMutate: true,
        fsMode: "workspace",
        network: { allowedDomains: ["example.com"] },
      }
    );
    assert.equal(warnings.length, 3);
  });

  it("顶层 network（非 isolation.network）→ 完全不识别", async () => {
    const { home, cwd } = await makeSettings(
      { network: { allowedDomains: ["example.com"] } },
      {}
    );
    const settings = loadIknowSettings({ home, cwd });
    assert.equal(settings.isolation, undefined);
  });

  it("字段增删不影响 isolation 段缺席的「全空 → undefined」判定", async () => {
    // per-field 独立：所有 isolation 子段字段非法 → isolation 段不产。
    const { home, cwd } = await makeSettings(
      {
        isolation: {
          network: { allowedDomains: ["*"] }, // 整条丢掉 → allowedDomains 为空 → 仍保留 network 段
        },
      },
      {}
    );
    const warnings: string[] = [];
    const settings = loadIknowSettings({
      home,
      cwd,
      onWarn: (m) => warnings.push(m),
    });
    // allowedDomains 全部丢 → 段保留为空数组事实（合法 fail-closed 态）
    assert.deepEqual(settings.isolation, { network: { allowedDomains: [] } });
    assert.equal(warnings.length, 1);
  });
});
