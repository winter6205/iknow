/**
 * Review round 4 — `src/tui/deps.ts` 与 `src/cli/runtime.ts` 一样是**按字段
 * 转发**的 wrapper：宿主钉了根、wrapper 没接，编译与全量测试都是绿的，只有
 * 真跑才发现（round 3 在 chat 宿主上实测到这一幕）。chat 那一跳有
 * `tests/cli/runtime-forwards-roots.test.ts` 守着，TUI 这一跳原先没有。
 *
 * 本文件不 mock 装配层：钉一个和启动 cwd 不同的身份根，然后看装配出来的
 * 系统提示词里到不到那个项目的 `AGENTS.md` —— 转发断了就读不到。
 *
 * bun:test（tests/tui 由 bun 驱动，D2 裁决）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTuiDeps } from "../../src/tui/deps.js";
import { createNoAskUser } from "../../src/harness/permission/ask-user.js";
import type { RuntimeBundle } from "../../src/cli/runtime.js";
import type { IknowEnv } from "../../src/config/env.js";

/** 最小合法 RuntimeBundle（与 deps-isolation.test.ts 同形；只读 env 字段）。 */
function makeBundle(): RuntimeBundle {
  const env: IknowEnv = {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      fallback: [],
      apiKey: "sk-test-sentinel-tui-identity",
      maxOutputTokens: 1024,
      timeoutMs: 60_000,
      temperature: 0,
      thinking: "off",
      thinkingEffort: "",
      stream: "on",
    },
    chat: { showThinking: false },
    web: { searchUrl: undefined, proxy: undefined },
    compress: { contextWindow: 200_000, thresholdTokens: undefined },
    mcp: { connectTimeoutMs: 60_000 },
    subagent: { taskTimeoutMs: undefined },
  };
  return { env } as unknown as RuntimeBundle;
}

describe("buildTuiDeps forwards the pinned identity root", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))
    );
  });

  test("项目身份从宿主钉的根来，而不是从 cwd / workspaceRoot 来", async () => {
    const anchor = await mkdtemp(join(tmpdir(), "iknow-tui-id-anchor-"));
    const userHome = await mkdtemp(join(tmpdir(), "iknow-tui-id-home-"));
    roots.push(anchor, userHome);

    // 用户层 `~/.iknow/rules` 缺席同样会让整个 resolver ENOENT 退场。
    await mkdir(join(userHome, ".iknow", "rules"), { recursive: true });

    const project = join(anchor, "the-project");
    // `.iknow/rules` 缺席会让整个 memory_layer resolver ENOENT 退场（连
    // AGENTS.md 一起），所以身份树按真实形态铺全。
    await mkdir(join(project, ".iknow", "rules"), { recursive: true });
    await writeFile(
      join(project, "AGENTS.md"),
      "PROJECT-AGENTS-BODY\n",
      "utf8"
    );
    await writeFile(
      join(project, ".iknow", "rules", "project-rule.md"),
      "PROJECT-RULE-BODY\n",
      "utf8"
    );
    // 诱饵：转发断了就会读到锚上的这份。
    await mkdir(join(anchor, ".iknow", "rules"), { recursive: true });
    await writeFile(join(anchor, "AGENTS.md"), "ANCHOR-AGENTS-BODY\n", "utf8");
    await writeFile(
      join(anchor, ".iknow", "rules", "anchor-rule.md"),
      "ANCHOR-RULE-BODY\n",
      "utf8"
    );

    const deps = await buildTuiDeps(makeBundle(), {
      askUser: createNoAskUser(),
      userHome,
      cwd: anchor,
      workspaceRoot: anchor,
      productRoot: anchor,
      projectIdentityRoot: project,
    });

    const prompt = (await deps.system?.()) ?? "";
    expect(prompt).toContain("PROJECT-AGENTS-BODY");
    expect(prompt).toContain(join(project, ".iknow", "rules"));
    expect(prompt).not.toContain("ANCHOR-AGENTS-BODY");
    expect(prompt).not.toContain(join(anchor, ".iknow", "rules"));
  });

  test.each(["projectIdentityRoot", "productRoot", "workspaceRoot"] as const)(
    "显式传空的 %s 透下去触 fail-closed，不在 wrapper 里被吞",
    async (field) => {
      const anchor = await mkdtemp(join(tmpdir(), "iknow-tui-id-empty-"));
      const userHome = await mkdtemp(join(tmpdir(), "iknow-tui-id-eh-"));
      roots.push(anchor, userHome);

      await expect(
        buildTuiDeps(makeBundle(), {
          askUser: createNoAskUser(),
          userHome,
          cwd: anchor,
          [field]: "",
        } as Parameters<typeof buildTuiDeps>[1])
      ).rejects.toThrow();
    }
  );
});
