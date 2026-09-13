/**
 * 自带搜引擎清单（D6 / SC9）。
 *
 * 契约：安装/发版按平台下载钉死版本 + 校验和，落到安装根；运行只 exec
 * 该路径，PATH 上的 `rg` 不当主路径。
 *
 * 本模块是**纯数据 + 纯查询**：不碰网络、不碰 fs，因此离线可测。下载/解包
 * 由 `scripts/install-search-engine.ts` 消费同一份清单 —— URL、校验和、
 * 归档内二进制位置只有这一处真值，安装脚本与运行期解析不会走偏。
 */

/** 钉死的引擎版本。升级时同步重生 `type-table.ts`（`rg --type-list`）。 */
export const RIPGREP_VERSION = "15.1.0";

export interface EngineAsset {
  /** release 资产文件名。 */
  readonly asset: string;
  /** 该资产的 SHA-256（取自 release 自带的 `.sha256`）。 */
  readonly sha256: string;
  /** 归档格式，决定解包命令。 */
  readonly archive: "tar.gz" | "zip";
  /** 归档内二进制相对路径。 */
  readonly binaryInArchive: string;
}

/**
 * `${process.platform}-${process.arch}` → 资产。
 *
 * 只登记 release 实际存在的资产（`aarch64-unknown-linux-musl` 与
 * `i686-unknown-linux-musl` 上游没有发布，故不登记；缺席平台走 Node 引擎，
 * 这是 D6 的合法降级而不是错误）。
 */
const ASSETS: Readonly<Record<string, EngineAsset>> = Object.freeze({
  "linux-x64": {
    asset: `ripgrep-${RIPGREP_VERSION}-x86_64-unknown-linux-musl.tar.gz`,
    sha256: "1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599",
    archive: "tar.gz",
    binaryInArchive: `ripgrep-${RIPGREP_VERSION}-x86_64-unknown-linux-musl/rg`,
  },
  "linux-arm64": {
    asset: `ripgrep-${RIPGREP_VERSION}-aarch64-unknown-linux-gnu.tar.gz`,
    sha256: "2b661c6ef508e902f388e9098d9c4c5aca72c87b55922d94abdba830b4dc885e",
    archive: "tar.gz",
    binaryInArchive: `ripgrep-${RIPGREP_VERSION}-aarch64-unknown-linux-gnu/rg`,
  },
  "darwin-x64": {
    asset: `ripgrep-${RIPGREP_VERSION}-x86_64-apple-darwin.tar.gz`,
    sha256: "64811cb24e77cac3057d6c40b63ac9becf9082eedd54ca411b475b755d334882",
    archive: "tar.gz",
    binaryInArchive: `ripgrep-${RIPGREP_VERSION}-x86_64-apple-darwin/rg`,
  },
  "darwin-arm64": {
    asset: `ripgrep-${RIPGREP_VERSION}-aarch64-apple-darwin.tar.gz`,
    sha256: "378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715",
    archive: "tar.gz",
    binaryInArchive: `ripgrep-${RIPGREP_VERSION}-aarch64-apple-darwin/rg`,
  },
  "win32-x64": {
    asset: `ripgrep-${RIPGREP_VERSION}-x86_64-pc-windows-msvc.zip`,
    sha256: "124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a",
    archive: "zip",
    binaryInArchive: `ripgrep-${RIPGREP_VERSION}-x86_64-pc-windows-msvc/rg.exe`,
  },
  "win32-arm64": {
    asset: `ripgrep-${RIPGREP_VERSION}-aarch64-pc-windows-msvc.zip`,
    sha256: "00d931fb5237c9696ca49308818edb76d8eb6fc132761cb2a1bd616b2df02f8e",
    archive: "zip",
    binaryInArchive: `ripgrep-${RIPGREP_VERSION}-aarch64-pc-windows-msvc/rg.exe`,
  },
});

/** 平台键（`${platform}-${arch}`）；清单的键空间单一来源。 */
export function platformKey(platform: string, arch: string): string {
  return `${platform}-${arch}`;
}

/** 该平台是否有钉死资产；没有 → 无自带引擎，直接走 Node 引擎。 */
export function engineAsset(
  platform: string,
  arch: string
): EngineAsset | undefined {
  return ASSETS[platformKey(platform, arch)];
}

/** 全部已登记平台键（安装脚本与测试消费）。 */
export function enginePlatformKeys(): ReadonlyArray<string> {
  return Object.keys(ASSETS);
}

/** 下载 URL。 */
export function engineDownloadUrl(asset: EngineAsset): string {
  return `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/${asset.asset}`;
}

/**
 * 运行期执行路径：`<installRoot>/vendor/ripgrep/<version>/<platform>-<arch>/rg`。
 *
 * 平台无资产 → `undefined`（调用方据此走 Node 引擎，而不是去找 PATH）。
 */
export function engineBinaryPath(
  installRoot: string,
  platform: string,
  arch: string
): string | undefined {
  const asset = engineAsset(platform, arch);
  if (asset === undefined) return undefined;
  const binaryName = asset.binaryInArchive.split("/").pop()!;
  return `${installRoot}/vendor/ripgrep/${RIPGREP_VERSION}/${platformKey(platform, arch)}/${binaryName}`;
}

/** 落地目录（安装脚本的解包目标）。 */
export function engineInstallDir(
  installRoot: string,
  platform: string,
  arch: string
): string {
  return `${installRoot}/vendor/ripgrep/${RIPGREP_VERSION}/${platformKey(platform, arch)}`;
}
