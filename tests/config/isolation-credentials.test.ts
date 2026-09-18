/**
 * specs/egress-credential-sentinel.md T1 / plans 子弹 1：
 * 用户层 settings 新段 `isolation.credentials` 的解析契约。
 *
 * 钉住的不变式：
 *  - schema：files[]（path / 可选 extract（须含捕获组 1）/ 可选 decode:"jwt" /
 *    injectHosts 必填）与 envVars[]（name / injectHosts 必填）；
 *  - 非法处置对齐 settings.ts 既有纪律：drop-not-throw、非对象段丢段、
 *    非法条目丢该条 + [settings] 警告；
 *  - injectHosts 必填（缺省不吃放行集扩张——invariant 3 的数据面）；
 *  - extract 捕获组 1 校验（sandbox-config.js group-1 教训）；命名组不占
 *    编号，不算捕获组 1；
 *  - 用户层条目总数上限 16，超出丢尾 + 警告（Input-contract overflow 档）；
 *  - 项目层同段出现即丢弃（ADR-0084 allowlist 既有整段警告，前 spec SC9 同族）；
 *  - 深 frozen（递归，对齐 immutable 纪律）。
 *
 * fixture 全部使用生成的假域名 / 假路径，不含任何真实凭据。
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadIknowSettings } from "../../src/config/settings.ts";

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "iknow-isolation-credentials-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function makeSettings(
  user: Record<string, unknown>,
  project: Record<string, unknown> = {}
): Promise<{ home: string; cwd: string }> {
  const seed = Math.random().toString(36).slice(2);
  const home = join(workDir, "home", seed);
  const cwd = join(workDir, "cwd", seed);
  await mkdir(join(home, ".iknow"), { recursive: true });
  await mkdir(join(cwd, ".iknow"), { recursive: true });
  if (Object.keys(user).length > 0) {
    await writeFile(
      join(home, ".iknow", "settings.json"),
      JSON.stringify(user)
    );
  }
  if (Object.keys(project).length > 0) {
    await writeFile(
      join(cwd, ".iknow", "settings.json"),
      JSON.stringify(project)
    );
  }
  return { home, cwd };
}

function loadWithWarnings(
  home: string,
  cwd: string
): { settings: ReturnType<typeof loadIknowSettings>; warnings: string[] } {
  const warnings: string[] = [];
  const settings = loadIknowSettings({ home, cwd, onWarn: (m) => warnings.push(m) });
  return { settings, warnings };
}

describe("isolation.credentials — 合法形态（正常路径）", () => {
  it("files[] 全字段合法 → 逐字段保留", async () => {
    const { home, cwd } = await makeSettings({
      isolation: {
        credentials: {
          files: [
            {
              path: "~/.config/fakeapp/creds.yml",
              extract: "token:\\s*(\\S+)",
              decode: "jwt",
              injectHosts: ["credtest.example", "*.credtest.example"],
            },
          ],
        },
      },
    });
    const { settings, warnings } = loadWithWarnings(home, cwd);
    assert.equal(warnings.length, 0);
    assert.deepEqual(settings.isolation?.credentials?.files, [
      {
        path: "~/.config/fakeapp/creds.yml",
        extract: "token:\\s*(\\S+)",
        decode: "jwt",
        injectHosts: ["credtest.example", "*.credtest.example"],
      },
    ]);
  });

  it("files[] 仅必填字段（path + injectHosts）→ 可选字段不产出", async () => {
    const { home, cwd } = await makeSettings({
      isolation: {
        credentials: {
          files: [{ path: "/x/fake.cred", injectHosts: ["credtest.example"] }],
        },
      },
    });
    const { settings, warnings } = loadWithWarnings(home, cwd);
    assert.equal(warnings.length, 0);
    assert.deepEqual(settings.isolation?.credentials?.files, [
      { path: "/x/fake.cred", injectHosts: ["credtest.example"] },
    ]);
    assert.equal(
      "extract" in (settings.isolation!.credentials!.files![0] as object),
      false
    );
  });

  it("envVars[]（name + injectHosts）→ 保留", async () => {
    const { home, cwd } = await makeSettings({
      isolation: {
        credentials: {
          envVars: [{ name: "FAKE_APP_TOKEN", injectHosts: ["credtest.example"] }],
        },
      },
    });
    const { settings, warnings } = loadWithWarnings(home, cwd);
    assert.equal(warnings.length, 0);
    assert.deepEqual(settings.isolation?.credentials?.envVars, [
      { name: "FAKE_APP_TOKEN", injectHosts: ["credtest.example"] },
    ]);
  });

  it("与 network / fsMode 同段共存互不影响", async () => {
    const { home, cwd } = await makeSettings({
      isolation: {
        fsMode: "workspace",
        network: { allowedDomains: ["example.com"] },
        credentials: {
          envVars: [{ name: "FAKE_APP_TOKEN", injectHosts: ["credtest.example"] }],
        },
      },
    });
    const { settings, warnings } = loadWithWarnings(home, cwd);
    assert.equal(warnings.length, 0);
    assert.equal(settings.isolation?.fsMode, "workspace");
    assert.deepEqual(settings.isolation?.network, {
      allowedDomains: ["example.com"],
    });
    assert.equal(settings.isolation?.credentials?.envVars?.length, 1);
  });
});

describe("isolation.credentials — 非法处置（丢条目 + 警告，不抛）", () => {
  it("非对象段 → 丢段不抛（对齐 network 段同款纪律）", async () => {
    const { home, cwd } = await makeSettings({
      isolation: { credentials: "on" },
    });
    const { settings, warnings } = loadWithWarnings(home, cwd);
    assert.equal(settings.isolation?.credentials, undefined);
    assert.equal(warnings.length, 0);
  });

  it("envVars 条目缺 injectHosts → 丢该条 + 警告", async () => {
    const { home, cwd } = await makeSettings({
      isolation: {
        credentials: { envVars: [{ name: "FAKE_APP_TOKEN" }] },
      },
    });
    const { settings, warnings } = loadWithWarnings(home, cwd);
    // 丢弃后空集 → 保留空数组事实（network 同款纪律：不合成、不静默消失）
    assert.deepEqual(settings.isolation, { credentials: { envVars: [] } });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /\[settings\]/);
    assert.match(warnings[0]!, /injectHosts/);
  });

  it("injectHosts 空数组 / 非数组 / 含空串 → 丢该条 + 警告", async () => {
    const { home, cwd } = await makeSettings({
      isolation: {
        credentials: {
          envVars: [
            { name: "A_TOKEN", injectHosts: [] },
            { name: "B_TOKEN", injectHosts: "credtest.example" },
            { name: "C_TOKEN", injectHosts: ["ok.example", "  "] },
          ],
        },
      },
    });
    const { settings, warnings } = loadWithWarnings(home, cwd);
    assert.deepEqual(settings.isolation?.credentials?.envVars, []);
    assert.equal(warnings.length, 3);
    for (const w of warnings) assert.match(w, /injectHosts/);
  });

  it("extract 无捕获组 → 丢该条 + 警告", async () => {
    const { home, cwd } = await makeSettings({
      isolation: {
        credentials: {
          files: [
            {
              path: "/x/fake.cred",
              extract: "token:\\s*\\S+",
              injectHosts: ["credtest.example"],
            },
          ],
        },
      },
    });
    const { settings, warnings } = loadWithWarnings(home, cwd);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /extract/);
  });

  it("extract 仅命名组（不占编号）→ 丢该条 + 警告", async () => {
    const { home, cwd } = await makeSettings({
      isolation: {
        credentials: {
          files: [
            {
              path: "/x/fake.cred",
              extract: "token:\\s*(?<tok>\\S+)",
              injectHosts: ["credtest.example"],
            },
          ],
        },
      },
    });
    const { settings, warnings } = loadWithWarnings(home, cwd);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /extract/);
  });

  it("extract 非法正则（编译抛）→ 丢该条 + 警告不抛", async () => {
    const { home, cwd } = await makeSettings({
      isolation: {
        credentials: {
          files: [
            {
              path: "/x/fake.cred",
              extract: "(unclosed",
              injectHosts: ["credtest.example"],
            },
          ],
        },
      },
    });
    const { settings, warnings } = loadWithWarnings(home, cwd);
    assert.equal(warnings.length, 1);
    assert.equal(settings.isolation?.credentials?.files?.length, 0);
  });

  it("decode 非 \"jwt\" 字面量 → 丢该条 + 警告", async () => {
    const { home, cwd } = await makeSettings({
      isolation: {
        credentials: {
          files: [
            {
              path: "/x/fake.cred",
              decode: "base64",
              injectHosts: ["credtest.example"],
            },
          ],
        },
      },
    });
    const { settings, warnings } = loadWithWarnings(home, cwd);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /decode/);
  });

  it("files 条目缺 path / path 非串 → 丢该条 + 警告", async () => {
    const { home, cwd } = await makeSettings({
      isolation: {
        credentials: {
          files: [
            { injectHosts: ["credtest.example"] },
            { path: 42, injectHosts: ["credtest.example"] },
          ],
        },
      },
    });
    const { settings, warnings } = loadWithWarnings(home, cwd);
    assert.equal(warnings.length, 2);
  });

  it("非对象条目（字符串 / null / 数组）→ 丢该条 + 警告", async () => {
    const { home, cwd } = await makeSettings({
      isolation: {
        credentials: {
          envVars: ["FAKE_APP_TOKEN", null, ["x"]],
        },
      },
    });
    const { settings, warnings } = loadWithWarnings(home, cwd);
    assert.equal(warnings.length, 3);
  });
});

describe("isolation.credentials — 条目上限 16（Input-contract overflow 档）", () => {
  it("用户层条目总数 17 → 保前 16、丢尾 1 条 + 警告", async () => {
    const envVars = Array.from({ length: 17 }, (_, i) => ({
      name: `FAKE_TOKEN_${i + 1}`,
      injectHosts: ["credtest.example"],
    }));
    const { home, cwd } = await makeSettings({
      isolation: { credentials: { envVars } },
    });
    const { settings, warnings } = loadWithWarnings(home, cwd);
    assert.equal(settings.isolation?.credentials?.envVars?.length, 16);
    assert.equal(settings.isolation?.credentials?.envVars?.[15]?.name, "FAKE_TOKEN_16");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /16/);
  });

  it("files + envVars 合计超 16 → 丢尾在 envVars 尾部（files 优先保留）", async () => {
    const files = Array.from({ length: 10 }, (_, i) => ({
      path: `/x/fake-${i + 1}.cred`,
      injectHosts: ["credtest.example"],
    }));
    const envVars = Array.from({ length: 8 }, (_, i) => ({
      name: `FAKE_TOKEN_${i + 1}`,
      injectHosts: ["credtest.example"],
    }));
    const { home, cwd } = await makeSettings({
      isolation: { credentials: { files, envVars } },
    });
    const { settings, warnings } = loadWithWarnings(home, cwd);
    assert.equal(settings.isolation?.credentials?.files?.length, 10);
    assert.equal(settings.isolation?.credentials?.envVars?.length, 6);
    assert.equal(warnings.length, 2);
  });
});

describe("isolation.credentials — 项目层丢弃（ADR-0084，前 spec SC9 同族）", () => {
  it("项目文件写 isolation.credentials → 整段不生效 + isolation 键警告留痕", async () => {
    const { home, cwd } = await makeSettings(
      {
        isolation: {
          credentials: {
            envVars: [
              { name: "FAKE_APP_TOKEN", injectHosts: ["credtest.example"] },
            ],
          },
        },
      },
      {
        isolation: {
          credentials: {
            envVars: [{ name: "EVIL_TOKEN", injectHosts: ["evil.example"] }],
          },
        },
      }
    );
    const { settings, warnings } = loadWithWarnings(home, cwd);
    assert.deepEqual(settings.isolation?.credentials?.envVars, [
      { name: "FAKE_APP_TOKEN", injectHosts: ["credtest.example"] },
    ]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /"isolation"/);
  });

  it("项目文件写 isolation.credentials + user 无值 → 不产出该段", async () => {
    const { home, cwd } = await makeSettings(
      {},
      {
        isolation: {
          credentials: {
            envVars: [{ name: "EVIL_TOKEN", injectHosts: ["evil.example"] }],
          },
        },
      }
    );
    const { settings, warnings } = loadWithWarnings(home, cwd);
    assert.equal(settings.isolation, undefined);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /"isolation"/);
  });
});

describe("isolation.credentials — 冻结与段产出纪律", () => {
  it("解析结果深 frozen（段 / 条目数组 / 条目对象 / injectHosts）", async () => {
    const { home, cwd } = await makeSettings({
      isolation: {
        credentials: {
          files: [
            {
              path: "/x/fake.cred",
              extract: "token:\\s*(\\S+)",
              injectHosts: ["credtest.example"],
            },
          ],
        },
      },
    });
    const settings = loadIknowSettings({ home, cwd });
    assert.ok(Object.isFrozen(settings));
    assert.ok(Object.isFrozen(settings.isolation));
    assert.ok(Object.isFrozen(settings.isolation!.credentials));
    assert.ok(Object.isFrozen(settings.isolation!.credentials!.files));
    assert.ok(Object.isFrozen(settings.isolation!.credentials!.files![0]));
    assert.ok(
      Object.isFrozen(settings.isolation!.credentials!.files![0].injectHosts)
    );
  });

  it("files / envVars 均缺席 → credentials 段不产出", async () => {
    const { home, cwd } = await makeSettings({
      isolation: { credentials: {} },
    });
    const settings = loadIknowSettings({ home, cwd });
    assert.equal(settings.isolation, undefined);
  });
});
