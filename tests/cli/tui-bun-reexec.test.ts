/**
 * #1076: `iknow tui` 在 Node 下自动用 PATH 上的 Bun 重跑同一 CLI 文件、同一 cwd。
 *
 * 黑盒子进程测试：cli.ts 顶层自跑 main()，spawn 接线只有端到端可证
 * （同 tests/cli/subagent-worker-exit.test.ts 的结论）。
 * 钉住的不变式：
 *   1. PATH 有 bun → 子进程以 `bun <本CLI文件> tui <原argv...>` 启动，argv 作为离散
 *      数组元素透传（含空格的参数不拆分），cwd 不变，子进程 exit code 原样传播；
 *   2. 子进程死于信号 → 按 shell 约定以 128+signum 退出（区别于普通失败 1）；
 *   3. PATH 无 bun → 不进入 TUI，stderr 给拦截文案（含可复制的 `bun <file> tui`），
 *      exit 1。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliTs = join(repoRoot, "src", "cli.ts");

/** 与 tests/cli/subagent-worker-exit.test.ts 同款 tsx 定位。 */
function resolveTsxCli(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "node_modules", "tsx", "dist", "cli.mjs");
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // 继续向上
    }
    const parent = join(dir, "..");
    if (parent === dir) throw new Error("cannot locate tsx/dist/cli.mjs");
    dir = parent;
  }
}

const tsxCli = resolveTsxCli();

let scratch: string;
let workCwd: string;
let binWithBun: string;
let binEmpty: string;
let binSuicide: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "iknow-1076-"));
  workCwd = join(scratch, "other-project");
  mkdirSync(workCwd, { recursive: true });
  binWithBun = join(scratch, "bin-bun");
  binEmpty = join(scratch, "bin-empty");
  binSuicide = join(scratch, "bin-suicide");
  mkdirSync(binWithBun, { recursive: true });
  mkdirSync(binEmpty, { recursive: true });
  mkdirSync(binSuicide, { recursive: true });
  // 假 bun：逐参数打印 argv 与 cwd 后 exit 7，用于验证离散透传与传播。
  const fakeBun = join(binWithBun, "bun");
  writeFileSync(
    fakeBun,
    [
      "#!/bin/sh",
      'for a in "$@"; do echo "ARG:$a"; done',
      'echo "FAKEBUNCWD $PWD"',
      "exit 7",
      "",
    ].join("\n")
  );
  chmodSync(fakeBun, 0o755);
  // 假 bun：自我 SIGTERM，验证父进程按 128+15 传播信号死亡。
  const suicideBun = join(binSuicide, "bun");
  writeFileSync(suicideBun, "#!/bin/sh\nkill -TERM $$\n");
  chmodSync(suicideBun, 0o755);
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function runCliTui(
  pathDir: string,
  tuiArgs: string[] = []
): Promise<{ code: number | null; out: string; err: string }> {
  const child = spawn(process.execPath, [tsxCli, cliTs, "tui", ...tuiArgs], {
    cwd: workCwd,
    env: { ...process.env, PATH: pathDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += String(d)));
  child.stderr.on("data", (d) => (err += String(d)));
  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ code, out, err }));
    child.on("error", () => resolve({ code: null, out, err }));
  });
}

describe("iknow tui Node→Bun re-exec (#1076)", () => {
  it("bun 在 PATH：用 bun 重跑同一 CLI 文件 + argv 离散透传（含空格参数不拆分），cwd 不变，exit code 传播", async () => {
    const { code, out, err } = await runCliTui(binWithBun, [
      "session with space",
      "--auto-mode",
    ]);
    assert.equal(code, 7, `child exit code must propagate; stderr=${err}`);
    const argLines = out.split("\n").filter((l) => l.startsWith("ARG:"));
    assert.deepEqual(argLines, [
      `ARG:${cliTs}`,
      "ARG:tui",
      "ARG:session with space",
      "ARG:--auto-mode",
    ]);
    assert.match(
      out,
      new RegExp(`FAKEBUNCWD ${workCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
    assert.equal(
      err.includes("TUI 需用 Bun"),
      false,
      "with bun on PATH the intercept copy must not appear"
    );
  }, 90_000);

  it("bun 子进程死于 SIGTERM：父进程按 shell 约定以 128+15=143 退出", async () => {
    const { code, err } = await runCliTui(binSuicide, ["--auto-mode"]);
    assert.equal(
      code,
      143,
      `signal death must map to 128+signum; stderr=${err}`
    );
  }, 90_000);

  it("bun 不在 PATH：拦截文案到 stderr + exit 1，且不进入 TUI", async () => {
    const { code, out, err } = await runCliTui(binEmpty);
    assert.equal(code, 1, `expected exit 1; stderr=${err}`);
    assert.match(err, /Bun/);
    assert.match(
      err,
      new RegExp(`bun .*cli\\.ts.* tui|bun "[^"]*cli\\.ts" tui`)
    );
    assert.equal(err.includes("请改用：npm run dev:tui"), false);
    assert.equal(out.includes("FAKEBUN"), false);
  }, 90_000);
});
