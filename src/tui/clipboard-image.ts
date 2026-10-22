/**
 * src/tui/clipboard-image.ts
 *
 * Clipboard image *reader* — the producer behind the composer's `[image#N]`
 * label: it turns "the user put a bitmap on the OS clipboard and pressed the
 * image chord" into real image bytes plus a policy media_type. The sibling
 * `clipboard.ts` is the writer direction only; nothing here touches text.
 *
 * The gesture is recorded as measured and is the only one implemented: on
 * WSL2, `powershell.exe -STA -NoProfile -ExecutionPolicy Bypass` runs
 * `Get-Clipboard -Format Image` and `Bitmap.Save(<temp>.png,
 * ImageFormat.Png)`, and this module reads that temp file in-process. An
 * Explorer copy of an image file has no bitmap — it is one file drop — so
 * when the bitmap is absent and the drop list holds exactly one file, that
 * file's bytes take the same classifier. A host without that bridge is a
 * typed `error`, never a silent hang or a guess.
 *
 * Two hazards from that measurement drive the design:
 *  - WSL -> Windows interop is intermittently unavailable, so every spawn is
 *    bounded by a timeout and lands in the typed failure arm.
 *  - interop stdout is not byte-safe (non-ASCII came back mojibake), so image
 *    bytes travel ONLY through the temp file; stdout is drained and dropped,
 *    stderr is read as text and reduced to a sanitized, capped tail.
 *
 * Media types and magic bytes come from `aci/tools/image-format.ts`, the same
 * classifier `read_image` uses. `read_image` keeps its 1 MiB file gate
 * (`MAX_IMAGE_BYTES`). A clipboard image is reduced before it is stored: long
 * edge at most 2000 px, raw bytes at most the wire budget whose base64 form
 * is 5 MiB. A signature that module does not recognize is `unsupported` on
 * the bitmap path and `empty` on a file drop.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  IMAGE_SIGNATURE_BYTES,
  MAX_IMAGE_LONG_EDGE_PX,
  MAX_IMAGE_WIRE_BYTES,
  detectImageMediaType,
  type ImageMediaType,
} from "../harness/aci/tools/image-format.js";

export type { ImageMediaType };

/**
 * Every outcome the chord handler needs to say something different about:
 *  - `ok`          — real image bytes, base64, media_type from magic bytes.
 *  - `empty`       — the clipboard holds no image (or the host wrote nothing).
 *  - `too-large`   — over the wire raw budget, refused before base64. A file
 *                    drop reports the original byte length.
 *  - `unsupported` — bytes are not one of the four formats, i.e. also the
 *                    format/MIME mismatch arm (magic wins over any extension).
 *  - `cancelled`   — the caller gave up; a late result is discarded here.
 *  - `error`       — the host bridge itself failed (absent, timed out, crashed).
 */
export type ClipboardImageResult =
  | {
      readonly kind: "ok";
      readonly mediaType: ImageMediaType;
      readonly data: string;
    }
  | { readonly kind: "empty" }
  | { readonly kind: "too-large"; readonly bytes: number }
  | { readonly kind: "unsupported" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "error"; readonly message: string };

/** Cold `powershell.exe` start plus a clipboard round trip; past this the
 *  interop bridge is treated as wedged rather than slow. */
export const DEFAULT_CLIPBOARD_IMAGE_TIMEOUT_MS = 5000;

/** Paste-probe budget. A single-line paste asks the clipboard snapshot whether
 *  the copy it just inserted was an image, and a substitution lands on the bytes
 *  that paste wrote, or on a matching tail at the end of the buffer — so nothing
 *  the user is holding waits on the answer.
 *  Cold start is about 1.4–1.8s. Scaling a 2800×900 PNG down to 2000×643 in
 *  this same process measured 2105 ms and 2634 ms, both over a 2000 ms budget,
 *  so that budget drops the result and the pasted path stays. 4000 ms covers
 *  that fit. The explicit chord still has the full 5000 ms budget. */
export const PASTE_IMAGE_PROBE_TIMEOUT_MS = 4000;

const HOST_BINARY = "powershell.exe";
const TEMP_DIR_PREFIX = "iknow-clipboard-";
const OUTPUT_FILE_NAME = "clipboard.png";
const STDERR_LIMIT = 2048;
const MESSAGE_LIMIT = 160;

/** Exit codes the capture script owns; anything else nonzero is a failure. */
const EMPTY_CLIPBOARD_EXIT = 200;
const CLIPBOARD_UNREADABLE_EXIT = 201;
const SAVE_FAILED_EXIT = 202;
/** One dropped file was copied (possibly only its head) and its real length
 *  was written beside it. Not an image until magic bytes say so. */
const FILE_DROP_EXIT = 203;
/** An admitted image could not be fitted inside the long edge and the wire
 *  budget. The size file is the original length; the bytes are only a head.
 *  This is a refusal, not a truncated copy. */
const FIT_REFUSED_EXIT = 204;
const SIZE_FILE_NAME = "clipboard.size";
/** Bytes kept when a dropped file is over the source ceiling or cannot be
 *  fitted. Must cover the longest signature in image-format.ts (WebP, 12
 *  bytes) so magic can still reject a non-image. */
const FILE_DROP_HEADER_BYTES = 16;

/** `$name[offset] -eq byte` for every byte of one signature. The bytes come
 *  from `IMAGE_SIGNATURE_BYTES`, the same table `detectImageMediaType` uses. */
function powershellByteEquals(
  name: string,
  signature: readonly number[],
  offset = 0
): string {
  return signature
    .map((byte, index) => `$${name}[${offset + index}] -eq ${byte}`)
    .join(" -and ");
}

export interface ClipboardCommand {
  readonly cmd: string;
  readonly args: ReadonlyArray<string>;
  readonly timeoutMs: number;
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  /** Where this app reads the bytes back, in local filesystem syntax. */
  readonly outputPath: string;
  /** The very same file as the host process has to name it. */
  readonly windowsOutputPath: string;
}

export interface CommandOk {
  readonly ok: true;
  readonly code: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly stderr: string;
}

export interface CommandFailure {
  readonly ok: false;
  readonly reason: "timeout" | "aborted" | "spawn-failed";
  readonly message: string;
}

/** No `stdout` by design: the interop text channels are not a payload path. */
export type CommandResult = CommandOk | CommandFailure;

export type CommandRunner = (
  command: ClipboardCommand
) => Promise<CommandResult>;

/** The filesystem slice the reader needs, injectable so tests can watch the
 *  stat-before-encode order while still running against a real temp dir. */
export interface TempFilesystem {
  mkdtemp(prefix: string): Promise<string>;
  statSize(path: string): Promise<number>;
  readBytes(path: string): Promise<Buffer>;
  remove(path: string): Promise<void>;
}

export interface ReadClipboardImageOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly run?: CommandRunner;
  readonly fs?: TempFilesystem;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  /** Parent dirs to `mkdtemp` under, tried in order. Defaults to locations both
   *  this app and the host process can address. */
  readonly tempRoots?: readonly string[];
}

const defaultFs: TempFilesystem = {
  mkdtemp: (prefix) => mkdtemp(prefix),
  statSize: async (path) => (await stat(path)).size,
  readBytes: (path) => readFile(path),
  remove: (path) => rm(path, { recursive: true, force: true }),
};

const noop = (): void => {};

/** Only the WSL2 gesture was measured, so only the platforms that can reach it
 *  get a bridge; absence surfaces as the `error` arm (local vision admission)
 *  instead of a misleading `empty`. */
function hostBridge(platform: NodeJS.Platform): string | null {
  return platform === "linux" || platform === "win32" ? HOST_BINARY : null;
}

/**
 * Locations writable by BOTH sides: this app creates the temp dir through the
 * Linux view and the host writes the same bytes through its own. They are
 * ordered by likelihood and validated by actually creating one, never by
 * trusting that a path exists — and none of them is ever the repository.
 */
function tempRootsFor(platform: NodeJS.Platform): readonly string[] {
  if (platform === "win32") return [tmpdir()];
  if (platform !== "linux") return [];
  return ["/mnt/c/Users/Public", "/mnt/c/Windows/Temp"];
}

/** Checked on PATH before spawning: a failed interop launch is common enough on
 *  this host that probing beats leaking the spawn's stderr noise. */
function which(binary: string, envPath: string, platform: NodeJS.Platform) {
  const separator = platform === "win32" ? ";" : ":";
  return envPath
    .split(separator)
    .some((dir) => dir.length > 0 && existsSync(join(dir, binary)));
}

/**
 * The recorded gesture, kept as measured. `$b` is the clipboard Bitmap.
 * The script's exit code is its only report, because stdout cannot carry
 * data. A null bitmap is not an empty clipboard: Explorer's copy of an image
 * file is a single file drop and no bitmap. An admitted image already within
 * the long-edge and raw-byte bounds is copied unchanged. Otherwise this same
 * process scales the long edge to 2000 px and, when the bytes are still over
 * the wire budget, re-encodes JPEG down the quality ladder. A result that
 * cannot fit exits 204 with the 16-byte head and the original
 * length, so the refusal is not mistaken for a truncated copy. The
 * clipboard path is never interpolated; both output names are mkdtemp paths.
 */
function captureScript(windowsPath: string, windowsSizePath: string): string {
  const output = quotePowerShellText(windowsPath);
  const size = quotePowerShellText(windowsSizePath);
  const wire = MAX_IMAGE_WIRE_BYTES;
  const edge = MAX_IMAGE_LONG_EDGE_PX;
  const header = FILE_DROP_HEADER_BYTES;
  const png = powershellByteEquals("head", IMAGE_SIGNATURE_BYTES.png);
  const jpeg = powershellByteEquals("head", IMAGE_SIGNATURE_BYTES.jpeg);
  const gif87 = powershellByteEquals("head", IMAGE_SIGNATURE_BYTES.gif87a);
  const gif89 = powershellByteEquals("head", IMAGE_SIGNATURE_BYTES.gif89a);
  const riff = powershellByteEquals("head", IMAGE_SIGNATURE_BYTES.riff);
  const webp = powershellByteEquals("head", IMAGE_SIGNATURE_BYTES.webp, 8);
  const kindClause = [
    `if ($got -ge 8 -and ${png}) { $kind = 'png' }`,
    `elseif ($got -ge 3 -and ${jpeg}) { $kind = 'jpeg' }`,
    `elseif ($got -ge 6 -and ((${gif87}) -or (${gif89}))) { $kind = 'gif' }`,
    `elseif ($got -ge 12 -and ${riff} -and ${webp}) { $kind = 'webp' };`,
  ].join(" ");
  return [
    "$ErrorActionPreference='Stop';",
    "Add-Type -AssemblyName System.Windows.Forms;",
    "Add-Type -AssemblyName System.Drawing;",
    `$out='${output}';`,
    `$sizeFile='${size}';`,
    `$wire=${wire};`,
    `$edge=${edge};`,
    `$headerN=${header};`,
    "function New-ScaledBitmap($src, [int]$maxEdge) {",
    "  $w = [int]$src.Width;",
    "  $h = [int]$src.Height;",
    "  $long = $w;",
    "  if ($h -gt $long) { $long = $h };",
    "  $nw = $w;",
    "  $nh = $h;",
    "  if ($long -gt $maxEdge) {",
    "    if ($w -ge $h) {",
    "      $nw = $maxEdge;",
    "      $nh = [int][Math]::Round((([double]$h * [double]$maxEdge) / [double]$w));",
    "    } else {",
    "      $nh = $maxEdge;",
    "      $nw = [int][Math]::Round((([double]$w * [double]$maxEdge) / [double]$h));",
    "    };",
    "    if ($nw -lt 1) { $nw = 1 };",
    "    if ($nh -lt 1) { $nh = 1 };",
    "  };",
    "  $bmp = New-Object -TypeName System.Drawing.Bitmap -ArgumentList $nw, $nh;",
    "  $g = [System.Drawing.Graphics]::FromImage($bmp);",
    "  try {",
    "    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic;",
    "    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality;",
    "    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality;",
    "    $rect = New-Object -TypeName System.Drawing.Rectangle -ArgumentList 0, 0, $nw, $nh;",
    "    [void]$g.DrawImage($src, $rect);",
    "  } finally { [void]$g.Dispose() };",
    "  return $bmp;",
    "};",
    "function Save-JpegQuality($image, [string]$dest, [int]$quality) {",
    "  $codec = $null;",
    "  foreach ($c in [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()) {",
    "    if ($c.MimeType -eq 'image/jpeg') { $codec = $c; break };",
    "  };",
    "  if ($null -eq $codec) { throw 'jpeg codec missing' };",
    "  $ep = New-Object -TypeName System.Drawing.Imaging.EncoderParameters -ArgumentList 1;",
    "  try {",
    "    $q = [long]$quality;",
    "    $encoder = [System.Drawing.Imaging.Encoder]::Quality;",
    "    $ep.Param[0] = New-Object -TypeName System.Drawing.Imaging.EncoderParameter -ArgumentList $encoder, $q;",
    "    $image.Save($dest, $codec, $ep);",
    "  } finally { [void]$ep.Dispose() };",
    "};",
    "function Save-WithinBudget($work, [string]$prefer) {",
    "  if ($prefer -eq 'png' -or $prefer -eq 'gif') {",
    "    try {",
    "      if ($prefer -eq 'gif') { $work.Save($out, [System.Drawing.Imaging.ImageFormat]::Gif) } else { $work.Save($out, [System.Drawing.Imaging.ImageFormat]::Png) };",
    "      $n = (New-Object -TypeName System.IO.FileInfo -ArgumentList $out).Length;",
    "      if ($n -gt 0 -and $n -le $wire) { return $true };",
    "    } catch { $n = 0 };",
    "  };",
    "  foreach ($q in 85,70,50,30) {",
    "    try {",
    "      Save-JpegQuality $work $out ([int]$q);",
    "      $n = (New-Object -TypeName System.IO.FileInfo -ArgumentList $out).Length;",
    "      if ($n -gt 0 -and $n -le $wire) { return $true };",
    "    } catch { $n = 0 };",
    "  };",
    "  return $false;",
    "};",
    "function Write-Refused([byte[]]$headBytes, [int64]$originalLen) {",
    "  [System.IO.File]::WriteAllBytes($out, $headBytes);",
    "  [System.IO.File]::WriteAllText($sizeFile, ([string]$originalLen));",
    `  exit ${FIT_REFUSED_EXIT};`,
    "};",
    "function Set-EdgeGuess([string]$p, [string]$kind) {",
    "  $script:edgeGuess = -1;",
    "  $in = [System.IO.File]::Open($p, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite);",
    "  try {",
    "    $b = New-Object -TypeName byte[] -ArgumentList 30;",
    "    $n = 0;",
    "    while ($n -lt 30) {",
    "      $r = $in.Read($b, $n, (30 - $n));",
    "      if ($r -le 0) { break };",
    "      $n = $n + $r;",
    "    };",
    "    $w = [int64]0;",
    "    $h = [int64]0;",
    "    if ($kind -eq 'gif' -and $n -ge 10) {",
    "      $w = ([int64]$b[6]) + (([int64]$b[7]) * 256);",
    "      $h = ([int64]$b[8]) + (([int64]$b[9]) * 256);",
    "    } elseif ($kind -eq 'png' -and $n -ge 24 -and $b[12] -eq 73 -and $b[13] -eq 72 -and $b[14] -eq 68 -and $b[15] -eq 82) {",
    "      $w = (([int64]$b[16]) * 16777216) + (([int64]$b[17]) * 65536) + (([int64]$b[18]) * 256) + ([int64]$b[19]);",
    "      $h = (([int64]$b[20]) * 16777216) + (([int64]$b[21]) * 65536) + (([int64]$b[22]) * 256) + ([int64]$b[23]);",
    "    } elseif ($kind -eq 'webp' -and $n -ge 30) {",
    "      $tag = [System.Text.Encoding]::ASCII.GetString($b, 12, 4);",
    "      if ($tag -eq 'VP8X') {",
    "        $w = ([int64]$b[24]) + (([int64]$b[25]) * 256) + (([int64]$b[26]) * 65536) + 1;",
    "        $h = ([int64]$b[27]) + (([int64]$b[28]) * 256) + (([int64]$b[29]) * 65536) + 1;",
    "      } elseif ($tag -eq 'VP8 ' -and $b[23] -eq 157 -and $b[24] -eq 1 -and $b[25] -eq 42) {",
    "        $w = ((([int64]$b[26]) + (([int64]$b[27]) * 256)) -band 16383);",
    "        $h = ((([int64]$b[28]) + (([int64]$b[29]) * 256)) -band 16383);",
    "      } elseif ($tag -eq 'VP8L' -and $b[20] -eq 47) {",
    "        $bits = ([int64]$b[21]) + (([int64]$b[22]) * 256) + (([int64]$b[23]) * 65536) + (([int64]$b[24]) * 16777216);",
    "        $w = (($bits -band 16383) + 1);",
    "        $h = ((($bits -shr 14) -band 16383) + 1);",
    "      };",
    "    };",
    "    if ($w -gt 0 -and $h -gt 0) {",
    "      $script:edgeGuess = $w;",
    "      if ($h -gt $script:edgeGuess) { $script:edgeGuess = $h };",
    "    };",
    "  } finally { [void]$in.Dispose() };",
    "};",
    "function Save-ClipboardBitmap($b) {",
    "  $scaled = $null;",
    "  try {",
    "    $work = $b;",
    "    $w = [int]$b.Width;",
    "    $h = [int]$b.Height;",
    "    $long = $w;",
    "    if ($h -gt $long) { $long = $h };",
    "    if ($long -gt $edge) {",
    "      $scaled = New-ScaledBitmap $b ([int]$edge);",
    "      $work = $scaled;",
    "    };",
    "    $fitted = Save-WithinBudget $work 'png';",
    "    if ($fitted) { return };",
    "    $pixels = [int64]$b.Width * [int64]$b.Height * 4;",
    "    $pngHead = New-Object -TypeName byte[] -ArgumentList 8;",
    ...IMAGE_SIGNATURE_BYTES.png.map(
      (byte, index) => `    $pngHead[${index}] = ${byte};`
    ),
    "    Write-Refused $pngHead $pixels;",
    "  } finally { if ($null -ne $scaled) { [void]$scaled.Dispose() } };",
    "};",
    "function Save-DroppedFile([string]$path) {",
    "  $info = New-Object -TypeName System.IO.FileInfo -ArgumentList $path;",
    "  $len = $info.Length;",
    `  if ($len -le 0) { exit ${EMPTY_CLIPBOARD_EXIT} };`,
    "  $head = New-Object -TypeName byte[] -ArgumentList $headerN;",
    "  $in = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite);",
    "  $got = 0;",
    "  try {",
    "    while ($got -lt $headerN) {",
    "      $r = $in.Read($head, $got, ($headerN - $got));",
    "      if ($r -le 0) { break };",
    "      $got = $got + $r;",
    "    };",
    "  } finally { [void]$in.Dispose() };",
    "  $kind = '';",
    `  ${kindClause}`,
    `  if ($kind -eq '') { exit ${EMPTY_CLIPBOARD_EXIT} };`,
    "  $script:edgeGuess = -1;",
    "  if (($kind -eq 'png' -or $kind -eq 'gif' -or $kind -eq 'webp') -and $len -le $wire) {",
    "    Set-EdgeGuess $path $kind;",
    "    if ($script:edgeGuess -gt 0 -and $script:edgeGuess -le $edge) {",
    "      [System.IO.File]::Copy($path, $out, $true);",
    "      [System.IO.File]::WriteAllText($sizeFile, ([string]$len));",
    "      return;",
    "    };",
    "  };",
    "  $img = $null;",
    "  $scaled = $null;",
    "  try {",
    "    try { $img = [System.Drawing.Image]::FromFile($path) } catch { Write-Refused $head $len };",
    "    $w = [int]$img.Width;",
    "    $h = [int]$img.Height;",
    "    $long = $w;",
    "    if ($h -gt $long) { $long = $h };",
    "    if ($long -le $edge -and $len -le $wire) {",
    "      [void]$img.Dispose();",
    "      $img = $null;",
    "      [System.IO.File]::Copy($path, $out, $true);",
    "      [System.IO.File]::WriteAllText($sizeFile, ([string]$len));",
    "      return;",
    "    };",
    "    $work = $img;",
    "    if ($long -gt $edge) {",
    "      $scaled = New-ScaledBitmap $img ([int]$edge);",
    "      $work = $scaled;",
    "    };",
    // Host encoders write png, gif, and jpeg. A webp that must be scaled is png, then jpeg.
    "    $prefer = 'jpeg';",
    "    if ($long -gt $edge -and $kind -eq 'gif') { $prefer = 'gif' }",
    "    elseif ($long -gt $edge -and $kind -ne 'jpeg') { $prefer = 'png' };",
    "    $fitted = Save-WithinBudget $work $prefer;",
    "    if (-not $fitted) { Write-Refused $head $len };",
    "    $outLen = (New-Object -TypeName System.IO.FileInfo -ArgumentList $out).Length;",
    "    [System.IO.File]::WriteAllText($sizeFile, ([string]$outLen));",
    "  } finally {",
    "    if ($null -ne $scaled) { [void]$scaled.Dispose() };",
    "    if ($null -ne $img) { [void]$img.Dispose() };",
    "  };",
    "};",
    `try { $hasImage = [System.Windows.Forms.Clipboard]::ContainsImage() } catch { exit ${CLIPBOARD_UNREADABLE_EXIT} };`,
    `if ($hasImage) { try { $b = Get-Clipboard -Format Image } catch { exit ${CLIPBOARD_UNREADABLE_EXIT} }; if ($null -ne $b) { try { Save-ClipboardBitmap $b; exit 0 } catch { exit ${SAVE_FAILED_EXIT} } finally { [void]$b.Dispose() } } };`,
    `try { $files = [System.Windows.Forms.Clipboard]::GetFileDropList() } catch { exit ${CLIPBOARD_UNREADABLE_EXIT} };`,
    `if ($null -eq $files -or $files.Count -ne 1) { exit ${EMPTY_CLIPBOARD_EXIT} };`,
    "$path = $files[0];",
    `if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { exit ${EMPTY_CLIPBOARD_EXIT} };`,
    `try { Save-DroppedFile $path; exit ${FILE_DROP_EXIT} } catch { exit ${SAVE_FAILED_EXIT} };`,
  ].join(" ");
}

/** Single-quoted PowerShell string literal (doubling is the escape). The value
 *  is a mkdtemp path, never user input, and the argv array keeps no shell
 *  between us and the binary. */
function quotePowerShellText(value: string): string {
  return value.replaceAll("'", "''");
}

/** A `/mnt/<drive>/...` temp dir is the same file the Windows process names
 *  `<DRIVE>:\...`; anything else is already in the host's own syntax. */
export function toClipboardHostPath(localPath: string): string {
  const mounted = /^\/mnt\/([a-z])\/(.*)$/.exec(localPath);
  if (!mounted) return localPath;
  return `${mounted[1].toUpperCase()}:\\${mounted[2].replaceAll("/", "\\")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Message hygiene: host stderr is text that is neither byte-safe nor
 * payload-free. It is flattened to printable ASCII, any long base64-shaped run
 * — the exact shape an image's bytes have — is dropped so no payload can reach
 * a notice or a log, and the tail is capped.
 */
function safeMessage(raw: string): string {
  const flat = raw
    .replace(/[^\x20-\x7e]+/g, " ")
    .replace(/[A-Za-z0-9+/]{24,}={0,2}/g, "[payload]")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length <= MESSAGE_LIMIT ? flat : flat.slice(-MESSAGE_LIMIT);
}

type TempDir =
  | { readonly ok: true; readonly dir: string }
  | { readonly ok: false; readonly message: string };

async function makeTempDir(
  port: TempFilesystem,
  roots: readonly string[]
): Promise<TempDir> {
  let reason = "no candidate temp root";
  for (const root of roots) {
    try {
      return { ok: true, dir: await port.mkdtemp(join(root, TEMP_DIR_PREFIX)) };
    } catch (error) {
      reason = `${root} (${errorMessage(error)})`;
    }
  }
  return {
    ok: false,
    message: `cannot create a Windows-writable clipboard temp dir: ${reason}`,
  };
}

async function captureSize(
  port: TempFilesystem,
  path: string
): Promise<number> {
  try {
    return await port.statSize(path);
  } catch (error) {
    // Exit code said there was an image but no file is there: that is an empty
    // clipboard from the user's point of view, not a bridge failure.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return -1;
    throw error;
  }
}

/** The length file is decimal digits only. Anything else is a broken host
 *  report, not an empty clipboard. */
async function readDeclaredLength(
  port: TempFilesystem,
  sizePath: string
): Promise<{ ok: true; length: number } | { ok: false; message: string }> {
  let raw: string;
  try {
    raw = (await port.readBytes(sizePath)).toString("utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, message: "clipboard file drop reported no length" };
    }
    throw error;
  }
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    return {
      ok: false,
      message: "clipboard file drop length is not a decimal integer",
    };
  }
  return { ok: true, length: Number(raw) };
}

/** Magic first, then the wire budget. A non-image is empty, not too-large.
 *  A short head whose declared length is still within the budget is a length
 *  mismatch, not a stored image. Over the budget, the declared length — not
 *  the head we hold — is the size. */
async function classifyFileDrop(
  port: TempFilesystem,
  outputPath: string,
  sizePath: string
): Promise<ClipboardImageResult> {
  const declared = await readDeclaredLength(port, sizePath);
  if (!declared.ok) return { kind: "error", message: declared.message };
  let bytes: Buffer;
  try {
    bytes = await port.readBytes(outputPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "error", message: "clipboard file drop wrote no bytes" };
    }
    throw error;
  }
  const mediaType = detectImageMediaType(bytes);
  if (mediaType === undefined) return { kind: "empty" };
  if (declared.length > MAX_IMAGE_WIRE_BYTES) {
    return { kind: "too-large", bytes: declared.length };
  }
  if (bytes.length !== declared.length) {
    return {
      kind: "error",
      message: "clipboard file drop length did not match the bytes read",
    };
  }
  return { kind: "ok", mediaType, data: bytes.toString("base64") };
}

/** The host refused to store this image. The declared length is the original
 *  file, which may sit under the wire budget when the long edge could not be
 *  brought down. A head that is not an admitted image is empty. */
async function classifyFitRefused(
  port: TempFilesystem,
  outputPath: string,
  sizePath: string
): Promise<ClipboardImageResult> {
  const declared = await readDeclaredLength(port, sizePath);
  if (!declared.ok) return { kind: "error", message: declared.message };
  let bytes: Buffer;
  try {
    bytes = await port.readBytes(outputPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "error", message: "clipboard file drop wrote no bytes" };
    }
    throw error;
  }
  if (detectImageMediaType(bytes) === undefined) return { kind: "empty" };
  return { kind: "too-large", bytes: declared.length };
}

/** stat → wire-budget gate (before base64) → magic bytes → base64.
 *  Pixel bounds are enforced by the capture script; this side does not decode. */
async function classifyCapture(
  port: TempFilesystem,
  path: string
): Promise<ClipboardImageResult> {
  const size = await captureSize(port, path);
  if (size <= 0) return { kind: "empty" };
  if (size > MAX_IMAGE_WIRE_BYTES) return { kind: "too-large", bytes: size };
  const bytes = await port.readBytes(path);
  const mediaType = detectImageMediaType(bytes);
  if (mediaType === undefined) return { kind: "unsupported" };
  return { kind: "ok", mediaType, data: bytes.toString("base64") };
}

function describeHostExit(
  bridge: string,
  result: CommandOk
): ClipboardImageResult {
  const why =
    result.code === null
      ? `terminated by ${result.signal ?? "unknown signal"}`
      : `exited ${result.code}`;
  return {
    kind: "error",
    message: `${bridge} ${why}: ${safeMessage(result.stderr)}`,
  };
}

async function readCapture(
  deps: ResolvedDeps,
  bridge: string,
  dir: string
): Promise<ClipboardImageResult> {
  const outputPath = join(dir, OUTPUT_FILE_NAME);
  const sizePath = join(dir, SIZE_FILE_NAME);
  const windowsOutputPath = toClipboardHostPath(outputPath);
  const windowsSizePath = toClipboardHostPath(sizePath);
  const result = await deps.run({
    cmd: bridge,
    args: [
      "-STA",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      captureScript(windowsOutputPath, windowsSizePath),
    ],
    timeoutMs: deps.timeoutMs,
    env: deps.env,
    signal: deps.signal,
    outputPath,
    windowsOutputPath,
  });
  if (!result.ok) {
    return {
      kind: "error",
      message: `clipboard image host ${result.reason}: ${safeMessage(result.message)}`,
    };
  }
  if (result.code === EMPTY_CLIPBOARD_EXIT) return { kind: "empty" };
  if (result.code === FIT_REFUSED_EXIT) {
    return classifyFitRefused(deps.fs, outputPath, sizePath);
  }
  if (result.code === FILE_DROP_EXIT) {
    return classifyFileDrop(deps.fs, outputPath, sizePath);
  }
  if (result.code !== 0) return describeHostExit(bridge, result);
  return classifyCapture(deps.fs, outputPath);
}

interface ResolvedDeps {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly fs: TempFilesystem;
  readonly run: CommandRunner;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly tempRoots: readonly string[];
}

function resolveDeps(options: ReadClipboardImageOptions): ResolvedDeps {
  const platform = options.platform ?? process.platform;
  return {
    platform,
    env: options.env ?? process.env,
    fs: options.fs ?? defaultFs,
    run: options.run ?? runClipboardCommand,
    timeoutMs: options.timeoutMs ?? DEFAULT_CLIPBOARD_IMAGE_TIMEOUT_MS,
    signal: options.signal,
    tempRoots: options.tempRoots ?? tempRootsFor(platform),
  };
}

async function removeQuietly(port: TempFilesystem, dir: string) {
  try {
    await port.remove(dir);
  } catch {
    // Disposable temp bytes must never replace an already-decided result.
  }
}

/** The whole read, total: it resolves to a typed arm and always cleans its
 *  temp dir, including when the caller has already been answered. */
async function captureOnce(
  options: ReadClipboardImageOptions
): Promise<ClipboardImageResult> {
  const deps = resolveDeps(options);
  const bridge = hostBridge(deps.platform);
  if (bridge === null) {
    return {
      kind: "error",
      message: `no clipboard image reader for ${deps.platform} (only the measured WSL2 gesture is implemented)`,
    };
  }
  if (!which(bridge, deps.env.PATH ?? "", deps.platform)) {
    return {
      kind: "error",
      message: `${bridge} is not on PATH (Windows interop unavailable)`,
    };
  }
  const temp = await makeTempDir(deps.fs, deps.tempRoots);
  if (!temp.ok) return { kind: "error", message: temp.message };
  try {
    return await readCapture(deps, bridge, temp.dir);
  } catch (error) {
    return { kind: "error", message: safeMessage(errorMessage(error)) };
  } finally {
    await removeQuietly(deps.fs, temp.dir);
  }
}

/**
 * Read one image off the OS clipboard. Never rejects: every failure class is a
 * typed arm, and an aborted caller is answered immediately with `cancelled`
 * while the read runs on to delete its own temp file.
 */
export async function readClipboardImage(
  options: ReadClipboardImageOptions = {}
): Promise<ClipboardImageResult> {
  const cancelled: ClipboardImageResult = { kind: "cancelled" };
  const signal = options.signal;
  if (signal?.aborted) return cancelled;
  // Started before the race, so whoever loses it still reaches its cleanup.
  const pipeline = captureOnce(options);
  if (!signal) return pipeline;
  return raceWithAbort(pipeline, signal, cancelled);
}

async function raceWithAbort(
  pipeline: Promise<ClipboardImageResult>,
  signal: AbortSignal,
  cancelled: ClipboardImageResult
): Promise<ClipboardImageResult> {
  let onAbort: () => void = noop;
  const aborted = new Promise<ClipboardImageResult>((resolve) => {
    onAbort = () => resolve(cancelled);
  });
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([pipeline, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function boundedStderr(): {
  push: (chunk: unknown) => void;
  value: () => string;
} {
  let text = "";
  return {
    push: (chunk) => {
      if (text.length < STDERR_LIMIT) text += String(chunk);
    },
    value: () => text,
  };
}

/**
 * The real host runner: one bounded spawn of the capture script. Both the
 * timeout and the caller's abort kill the child, and both report a typed
 * failure rather than a hang.
 */
export async function runClipboardCommand(
  command: ClipboardCommand
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    let settled = false;
    let onAbort: () => void = noop;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      command.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const child = spawn(command.cmd, [...command.args], {
      stdio: ["ignore", "pipe", "pipe"],
      // No console window flashing on the host; harmless on Linux.
      windowsHide: true,
      env: command.env,
    });
    const kill = (): void => {
      try {
        child.kill();
      } catch {
        // already exited on its own
      }
    };
    // unref: a wedged interop bridge must not hold the event loop and keep the
    // TUI from exiting (same reason as the writer in clipboard.ts).
    child.unref();
    onAbort = () => {
      kill();
      finish({
        ok: false,
        reason: "aborted",
        message: "cancelled before the host answered",
      });
    };
    command.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      kill();
      finish({
        ok: false,
        reason: "timeout",
        message: `timed out after ${command.timeoutMs}ms`,
      });
    }, command.timeoutMs);
    const stderr = boundedStderr();
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    child.stderr?.on("error", noop);
    // Drained and dropped: interop stdout is not byte-safe and is never the
    // payload channel, but an unread pipe would block the host.
    child.stdout?.on("data", noop);
    child.stdout?.on("error", noop);
    child.on("error", (error) =>
      finish({
        ok: false,
        reason: "spawn-failed",
        message: errorMessage(error),
      })
    );
    child.on("close", (code, signal) =>
      finish({ ok: true, code, signal, stderr: stderr.value() })
    );
  });
}
