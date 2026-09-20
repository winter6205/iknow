/**
 * Manifest for the bundled search engine.
 *
 * Contract: install/release downloads the pinned version + checksum per
 * platform into the install root; at runtime only that path is exec'd, and an
 * `rg` on PATH is never the main path.
 *
 * This module is **pure data + pure queries**: no network, no fs, so it is
 * testable offline. `scripts/install-search-engine.ts` consumes the same
 * manifest for download/unpack — URLs, checksums, and in-archive binary paths
 * have exactly one source of truth, so the installer and runtime resolution
 * cannot drift apart.
 */

/** Pinned engine version. On upgrade, regenerate `type-table.ts` (`rg --type-list`). */
export const RIPGREP_VERSION = "15.1.0";

export interface EngineAsset {
  /** Release asset filename. */
  readonly asset: string;
  /** SHA-256 of this asset (taken from the release's own `.sha256`). */
  readonly sha256: string;
  /** Archive format; decides the unpack command. */
  readonly archive: "tar.gz" | "zip";
  /** Binary path relative to the archive root. */
  readonly binaryInArchive: string;
}

/**
 * `${process.platform}-${process.arch}` → asset.
 *
 * Only assets that actually exist in the release are registered
 * (`aarch64-unknown-linux-musl` and `i686-unknown-linux-musl` are not
 * published upstream, so they are absent; missing platforms use the Node
 * engine — a legal downgrade, not an error).
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

/** Platform key (`${platform}-${arch}`); single source of the manifest's key space. */
export function platformKey(platform: string, arch: string): string {
  return `${platform}-${arch}`;
}

/** Does this platform have a pinned asset; no → no bundled engine, go straight to the Node engine. */
export function engineAsset(
  platform: string,
  arch: string
): EngineAsset | undefined {
  return ASSETS[platformKey(platform, arch)];
}

/** All registered platform keys (consumed by the installer and tests). */
export function enginePlatformKeys(): ReadonlyArray<string> {
  return Object.keys(ASSETS);
}

/** Download URL. */
export function engineDownloadUrl(asset: EngineAsset): string {
  return `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/${asset.asset}`;
}

/**
 * Runtime execution path:
 * `<installRoot>/vendor/ripgrep/<version>/<platform>-<arch>/rg`.
 *
 * No asset for the platform → `undefined` (the caller then uses the Node
 * engine instead of searching PATH).
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

/** Landing directory (the installer's unpack target). */
export function engineInstallDir(
  installRoot: string,
  platform: string,
  arch: string
): string {
  return `${installRoot}/vendor/ripgrep/${RIPGREP_VERSION}/${platformKey(platform, arch)}`;
}
