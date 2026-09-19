/**
 * egress-ssh-bridge 子弹 7 / spec assumption 9 + SC7：真 `git push --dry-run`
 * （SSH remote）经出口中继 e2e。
 *
 * 纪律（对齐 `archive/tests-real-llm/` 的「缺条件 → 显式 skip + Not run」）：
 *   - **默认 skip**：显式设 `IKNOW_EGRESS_REAL_PUSH_E2E=1` 才执行；
 *   - 仅对**操作员自有远端 + 非破坏性 ref**：默认目标 = 本仓 origin
 *     （必须匹配 `git@github.com:` SSH remote），动作固定 `--dry-run`
 *     （不落任何远端 ref）；可用 `IKNOW_EGRESS_PUSH_REMOTE` 显式覆盖
 *     （同样只接受 github.com SSH 形态）；
 *   - 不进 CI 默认面（`vitest.config.ts` 不收集 `archive/`）；经
 *     `vitest.real-llm.config.ts` include 收集，默认环境显式 skip。
 *
 * 装配与生产 bash.ts 前台同款（invariant 4 注入面 SSOT）：
 * `createEgressSession`（github 放行集）→ `createBwrapFence`（egress spec：
 * unix socket bind + 代理 env + `GIT_SSH_COMMAND` 注入 + 中继资产 ro-bind）
 * → 命令链前导内层中继。凭据姿态 = ADR-0105 §Decision 5「出口域限制兜底」：
 * global fs 档下操作员真实 `~/.ssh` key 在围栏内可读，key 唯一出网路径被
 * 域判定卡住。本测试不注入也不输出任何 token / 私钥内容（断言面只匹配
 * 失败类别字样，不打印凭据行）。
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  BASE_ENV_WHITELIST,
  createBwrapFence,
  createEnvIsolation,
  createFsPolicy,
} from "../../src/harness/sandbox/index.js";
import { createEgressSession } from "../../src/harness/sandbox/egress/session.js";

const ENABLED = process.env.IKNOW_EGRESS_REAL_PUSH_E2E === "1";
if (!ENABLED) {
  console.log(
    "[SKIP] IKNOW_EGRESS_REAL_PUSH_E2E != 1; real git push e2e Not run"
  );
}

const runOrSkip = ENABLED ? describe : describe.skip;

/** 本仓根（archive/tests-real-llm/ 上溯两级）。 */
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** 操作员自有远端门：origin（或显式覆盖）只接受 github.com SSH 形态。 */
function sshRemoteHost(remote: string): string | undefined {
  const m = /^(?:ssh:\/\/)?git@([^/:]+)/.exec(remote);
  return m ? m[1].toLowerCase() : undefined;
}

runOrSkip("egress real git push --dry-run e2e (SSH remote, egress fence)", () => {
  const pads: string[] = [];

  afterAll(async () => {
    await Promise.all(
      pads.splice(0).map((p) => rm(p, { recursive: true, force: true }))
    );
  });

  it(
    "git push --dry-run 经放行域 :22 隧道走通到认证层（非破坏性 ref）",
    async () => {
      const override = process.env.IKNOW_EGRESS_PUSH_REMOTE?.trim();
      let remote = override ?? "";
      if (remote === "") {
        const r = await new Promise<string>((resolve) => {
          const child = spawn(
            "git",
            ["-C", REPO_ROOT, "remote", "get-url", "origin"],
            { stdio: ["ignore", "pipe", "ignore"] }
          );
          let so = "";
          child.stdout.on("data", (c: Buffer) => (so += c.toString("utf8")));
          child.on("close", (code) =>
            resolve(code === 0 ? so.trim() : "")
          );
          child.on("error", () => resolve(""));
        });
        remote = r;
      }
      const host = sshRemoteHost(remote);
      expect(
        host,
        `operator-owned github.com SSH remote required (got "${remote}")`
      ).toBe("github.com");

      const pad = await mkdtemp(join(tmpdir(), "iknow-push-e2e-pad-"));
      pads.push(pad);
      const session = await createEgressSession({
        policy: {
          allowedDomains: [host, `*.${host}`],
          deniedDomains: [],
          commandLabel: "e2e: git push --dry-run origin HEAD",
        },
      });
      try {
        // 与 bash.ts 前台同款：`bash -c "<内层中继前导>\n<用户命令>"`。
        // 就绪轮询同款（中继启动竞态，probe 实测结论：/dev/tcp 探测
        // 127.0.0.1:3128 后 git 才发起 ssh ProxyCommand CONNECT）。
        const readyProbe = [
          "for i in $(seq 1 40); do",
          "  (exec 3<>/dev/tcp/127.0.0.1/3128) 2>/dev/null && break",
          "  sleep 0.25",
          "done",
          '(exec 3<>/dev/tcp/127.0.0.1/3128) 2>/dev/null || { echo "inner-relay-not-ready" >&2; exit 9; }',
        ].join("\n");
        const pushCommand = "git push --dry-run origin HEAD";
        const fence = createBwrapFence({
          command: "bash",
          args: [
            "-c",
            `${session.spec.innerBridgeScript}\n${readyProbe}\n${pushCommand}`,
          ],
          fsPolicy: createFsPolicy({ tmpDir: pad, mode: "global" }),
          env: {
            ...createEnvIsolation({ allowEnv: BASE_ENV_WHITELIST }).filter(
              process.env
            ),
            TMPDIR: pad,
          },
          cwd: REPO_ROOT,
          egress: session.spec,
        });
        const { code, stdout, stderr } = await new Promise<{
          code: number | null;
          stdout: string;
          stderr: string;
        }>((resolve) => {
          const child = spawn(fence.argv[0], fence.argv.slice(1), {
            cwd: REPO_ROOT,
            env: {
              ...createEnvIsolation({ allowEnv: BASE_ENV_WHITELIST }).filter(
                process.env
              ),
              TMPDIR: pad,
            },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let so = "";
          let se = "";
          child.stdout.on("data", (c: Buffer) => (so += c.toString("utf8")));
          child.stderr.on("data", (c: Buffer) => (se += c.toString("utf8")));
          child.on("error", () => resolve({ code: null, stdout: so, stderr: se }));
          child.on("close", (code) =>
            resolve({ code, stdout: so, stderr: se })
          );
        });
        const violations = session.violationSink.drain();
        const out = `${stdout}\n${stderr}`;
        // 网络面必须干净：无域拒绝回灌、无 DNS / 连接失败文案。
        expect(out).not.toMatch(/network_denied/);
        expect(out).not.toMatch(
          /Could not resolve host|Connection timed out|Network is unreachable|kex_exchange_identification/
        );
        expect(violations).toHaveLength(0);
        // 开启前提 = 操作员有可用凭据：判据从严 = exit 0（认证层走通）。
        // 输出截断到 400 字符做失败归因，不整段回显（防凭据 / 敏感行外溢）。
        expect(
          code,
          `git push --dry-run exit; output tail: ${out.slice(-400)}`
        ).toBe(0);
      } finally {
        await session.dispose().catch(() => undefined);
      }
    },
    180_000
  );
});
