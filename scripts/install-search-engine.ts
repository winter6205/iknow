/**
 * 安装自带搜引擎（D6）—— 按平台下载钉死版本 + 校验和，解到安装根。
 *
 * 用法：
 *   npx tsx scripts/install-search-engine.ts            # 当前平台
 *   npx tsx scripts/install-search-engine.ts --platform linux-x64
 *   npx tsx scripts/install-search-engine.ts --force    # 已存在也重装
 *
 * 契约（D6）：
 *   - 版本 / URL / 校验和 / 归档内路径全部来自 `engine-manifest.ts`（单一真值），
 *     本脚本不另存一份映射。
 *   - 下载产物落到 `<installRoot>/vendor/ripgrep/...`，该目录已 gitignore，
 *     **不得 commit**。
 *   - 校验和不符 → 删掉临时文件并 fail（不落一个来路不明的二进制）。
 *   - 平台无登记资产 → 明确说「该平台走 Node 引擎」，退出码 0（这不是错误，
 *     是 D6 允许的降级）。
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  engineAsset,
  engineDownloadUrl,
  engineInstallDir,
  enginePlatformKeys,
  platformKey,
  RIPGREP_VERSION,
  type EngineAsset,
} from "../src/harness/aci/search/engine-manifest.js";
import { resolveInstallRoot } from "../src/harness/session-roots.js";

interface Args {
  readonly platform: string;
  readonly arch: string;
  readonly force: boolean;
}

function parseArgs(argv: ReadonlyArray<string>): Args {
  let platform = process.platform;
  let arch = process.arch;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--platform") {
      const value = argv[i + 1];
      if (value === undefined) fail("--platform requires a value");
      const dash = value.lastIndexOf("-");
      if (dash === -1)
        fail(`--platform must look like linux-x64, got ${value}`);
      platform = value.slice(0, dash);
      arch = value.slice(dash + 1);
      i += 1;
    }
  }
  return { platform, arch, force };
}

function fail(message: string): never {
  process.stderr.write(`install-search-engine: ${message}\n`);
  process.exit(1);
}

async function download(url: string): Promise<Buffer> {
  // 用 Node 自己的 fetch（>=18）——不引第三个依赖，也不依赖 curl 在不在。
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    fail(`download failed: ${String(response.status)} ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const key = platformKey(args.platform, args.arch);
  const asset = engineAsset(args.platform, args.arch);
  if (asset === undefined) {
    process.stdout.write(
      `no pinned engine asset for ${key}; this platform uses the built-in Node scan ` +
        `(known: ${enginePlatformKeys().join(", ")})\n`
    );
    return;
  }

  const installRoot = resolveInstallRoot();
  const targetDir = engineInstallDir(installRoot, args.platform, args.arch);
  const binaryName = asset.binaryInArchive.split("/").pop()!;
  const targetBinary = join(targetDir, binaryName);

  if (existsSync(targetBinary) && !args.force) {
    process.stdout.write(`already installed: ${targetBinary}\n`);
    return;
  }

  const url = engineDownloadUrl(asset);
  process.stdout.write(
    `downloading ripgrep ${RIPGREP_VERSION} for ${key}\n  ${url}\n`
  );
  const archive = await download(url);

  const actual = sha256(archive);
  if (actual !== asset.sha256) {
    fail(
      `checksum mismatch for ${asset.asset}\n  want ${asset.sha256}\n  got  ${actual}`
    );
  }
  process.stdout.write(`checksum ok: ${actual}\n`);

  const scratch = await mkdtemp(join(tmpdir(), "iknow-rg-"));
  try {
    const archivePath = join(scratch, asset.asset);
    await writeFile(archivePath, archive);
    await unpack(asset, archivePath, scratch);
    const extracted = join(scratch, asset.binaryInArchive);
    if (!existsSync(extracted)) {
      fail(`archive did not contain ${asset.binaryInArchive}`);
    }
    await mkdir(targetDir, { recursive: true });
    await writeFile(targetBinary, await readFile(extracted));
    await chmod(targetBinary, 0o755);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  process.stdout.write(`installed: ${targetBinary}\n`);
}

function unpack(asset: EngineAsset, archivePath: string, into: string): void {
  const [command, args] =
    asset.archive === "zip"
      ? ["unzip", ["-o", "-q", archivePath, "-d", into]]
      : ["tar", ["xzf", archivePath, "-C", into]];
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    fail(`${command} failed with code ${String(result.status)}`);
  }
}

void main();
