/**
 * tests/tui/clipboard-image.test.ts
 *
 * The clipboard image reader. Host interop is stubbed at its boundary — a fake
 * command runner stands in for `powershell.exe`, which this machine cannot
 * reach from a test — while everything under test stays production code on a
 * real temporary filesystem: the mkdtemp temp dir, the size gate, the
 * magic-byte classification, the base64, and the cleanup.
 *
 * Failure classes are asserted as observable data (result kind, exact bytes,
 * which files still exist), not call counts.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  PASTE_IMAGE_PROBE_TIMEOUT_MS,
  readClipboardImage,
  runClipboardCommand,
  toClipboardHostPath,
  type ClipboardCommand,
  type ClipboardImageResult,
  type CommandResult,
  type CommandRunner,
  type ReadClipboardImageOptions,
  type TempFilesystem,
} from "../../src/tui/clipboard-image.ts";
import {
  IMAGE_MEDIA_TYPES,
  IMAGE_SIGNATURE_BYTES,
  MAX_IMAGE_BYTES,
} from "../../src/harness/aci/tools/image-format.ts";

// A private bin dir so the PATH probe finds a host binary without touching the
// real PATH (parallel workers must not cross-talk), and a private scratch dir
// so the reader's temp files land outside the repository.
const BIN_DIR = mkdtempSync(join(tmpdir(), "iknow-clip-bin-"));
const SCRATCH = mkdtempSync(join(tmpdir(), "iknow-clip-scratch-"));
writeFileSync(join(BIN_DIR, "powershell.exe"), "");

afterAll(async () => {
  await rm(BIN_DIR, { recursive: true, force: true });
  await rm(SCRATCH, { recursive: true, force: true });
});

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
const FILLER = Buffer.alloc(64, 0x5a);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  FILLER,
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...FILLER]);
const GIF = Buffer.concat([Buffer.from("GIF89a", "ascii"), FILLER]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0x08, 0x00, 0x00, 0x00]),
  Buffer.from("WEBP", "ascii"),
  FILLER,
]);
const BMP = Buffer.concat([Buffer.from("BM", "ascii"), FILLER]);
const NOT_AN_IMAGE = Buffer.from("just clipboard text, no signature at all");

const EXIT_OK: CommandResult = { ok: true, code: 0, stderr: "" };
/** Largest raw size whose base64 form is 5 MiB. Binary MiB, not decimal MB. */
const WIRE_RAW_BYTES = 3_932_160;
const PNG_HEADER = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(8, 0x41)]);

function pngOfSize(size: number, fill = 0x41): Buffer {
  return Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(size - 8, fill)]);
}

const PNG_OVER_CAP = pngOfSize(WIRE_RAW_BYTES + 1, 0x43);

/** Stands in for the host script: writes the bytes it "saved", then reports. */
function hostWriting(
  bytes: Buffer | null,
  result: CommandResult = EXIT_OK
): { runner: CommandRunner; commands: ClipboardCommand[] } {
  const commands: ClipboardCommand[] = [];
  const runner: CommandRunner = async (command) => {
    commands.push(command);
    if (bytes !== null) await writeFile(command.outputPath, bytes);
    return result;
  };
  return { runner, commands };
}

/** A host that answers only when the test lets it — for late results. */
function hostHolding(): {
  runner: CommandRunner;
  commands: ClipboardCommand[];
  finish: (bytes: Buffer | null, result: CommandResult) => Promise<void>;
} {
  const commands: ClipboardCommand[] = [];
  let release!: (result: CommandResult) => void;
  const runner: CommandRunner = (command) => {
    commands.push(command);
    return new Promise<CommandResult>((resolve) => {
      release = resolve;
    });
  };
  return {
    runner,
    commands,
    async finish(bytes, result) {
      const command = commands[commands.length - 1];
      if (bytes !== null && command) {
        await writeFile(command.outputPath, bytes);
      }
      release(result);
    },
  };
}

function optionsFor(
  run: CommandRunner,
  extra: Partial<ReadClipboardImageOptions> = {}
): ReadClipboardImageOptions {
  return {
    platform: "linux",
    env: { PATH: BIN_DIR },
    tempRoots: [SCRATCH],
    run,
    ...extra,
  };
}

/** Wraps the real filesystem so tests can see which steps actually ran. */
function countingFilesystem(seen: string[]): TempFilesystem {
  return {
    mkdtemp: (prefix) => {
      seen.push("mkdtemp");
      return mkdtemp(prefix);
    },
    statSize: async (path) => {
      seen.push("stat");
      return (await stat(path)).size;
    },
    readBytes: async (path) => {
      seen.push("read");
      return readFile(path);
    },
    remove: async (path) => {
      seen.push("remove");
      await rm(path, { recursive: true, force: true });
    },
  };
}

describe("readClipboardImage — accepted image", () => {
  test("returns png bytes as exact base64 with the SSOT media_type", async () => {
    const { runner } = hostWriting(PNG);
    const result = await readClipboardImage(optionsFor(runner));
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.mediaType).toBe("image/png");
    expect(IMAGE_MEDIA_TYPES).toContain(result.mediaType);
    expect(result.data).toBe(PNG.toString("base64"));
    expect(Buffer.from(result.data, "base64").equals(PNG)).toBe(true);
  });

  for (const [expected, bytes] of [
    ["image/jpeg", JPEG],
    ["image/gif", GIF],
    ["image/webp", WEBP],
  ] as const) {
    test(`classifies ${expected} from its signature alone`, async () => {
      const { runner } = hostWriting(bytes);
      const result = await readClipboardImage(optionsFor(runner));
      expect(result).toEqual({
        kind: "ok",
        mediaType: expected,
        data: bytes.toString("base64"),
      });
    });
  }

  test("magic bytes win over the extension the host happens to write", async () => {
    const { runner, commands } = hostWriting(JPEG);
    const result = await readClipboardImage(optionsFor(runner));
    expect(commands[0]?.outputPath.endsWith(".png")).toBe(true);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.mediaType).toBe("image/jpeg");
  });

  test("a png between the read_image gate and the wire budget still attaches", async () => {
    const bytes = pngOfSize(2_000_000);
    expect(bytes.length).toBeGreaterThan(MAX_IMAGE_BYTES);
    expect(bytes.length).toBeLessThan(WIRE_RAW_BYTES);
    const { runner } = hostWriting(bytes);
    const result = await readClipboardImage(optionsFor(runner));
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.mediaType).toBe("image/png");
    expect(result.data).toBe(bytes.toString("base64"));
  });

  test("a bitmap at exactly the wire budget still attaches", async () => {
    const atCap = pngOfSize(WIRE_RAW_BYTES);
    expect(atCap.length).toBe(WIRE_RAW_BYTES);
    const { runner } = hostWriting(atCap);
    const result = await readClipboardImage(optionsFor(runner));
    expect(result).toEqual({
      kind: "ok",
      mediaType: "image/png",
      data: atCap.toString("base64"),
    });
  });

  test("the path handed to the host addresses one and the same file", async () => {
    const written: Buffer[] = [];
    const runner: CommandRunner = async (command) => {
      await writeFile(command.outputPath, GIF);
      written.push(await readFile(command.outputPath));
      return EXIT_OK;
    };
    const result = await readClipboardImage(optionsFor(runner));
    expect(written).toEqual([GIF]);
    expect(result).toEqual({
      kind: "ok",
      mediaType: "image/gif",
      data: GIF.toString("base64"),
    });
  });
});

/** A file drop writes the captured bytes plus a sibling length file. */
function fileDropWriting(
  bytes: Buffer,
  declared: number | string,
  code = 203
): { runner: CommandRunner; commands: ClipboardCommand[] } {
  const commands: ClipboardCommand[] = [];
  const runner: CommandRunner = async (command) => {
    commands.push(command);
    await writeFile(command.outputPath, bytes);
    await writeFile(
      join(dirname(command.outputPath), "clipboard.size"),
      String(declared)
    );
    return { ok: true, code, stderr: "" };
  };
  return { runner, commands };
}

describe("readClipboardImage — one dropped image file", () => {
  test("an admitted image file is the image, with no bitmap on the clipboard", async () => {
    const { runner } = fileDropWriting(PNG, PNG.length);
    const result = await readClipboardImage(optionsFor(runner));
    expect(result).toEqual({
      kind: "ok",
      mediaType: "image/png",
      data: PNG.toString("base64"),
    });
  });

  test("a dropped file that is not an admitted image is an empty clipboard", async () => {
    const { runner } = fileDropWriting(NOT_AN_IMAGE, NOT_AN_IMAGE.length);
    expect(await readClipboardImage(optionsFor(runner))).toEqual({
      kind: "empty",
    });
  });

  test("a non-image over the wire budget is empty, not a size refusal", async () => {
    const { runner } = fileDropWriting(NOT_AN_IMAGE, WIRE_RAW_BYTES + 1);
    expect(await readClipboardImage(optionsFor(runner))).toEqual({
      kind: "empty",
    });
  });

  test("a dropped png between the read_image gate and the wire budget still attaches", async () => {
    const bytes = pngOfSize(2_000_000);
    const { runner } = fileDropWriting(bytes, bytes.length);
    const result = await readClipboardImage(optionsFor(runner));
    expect(result).toEqual({
      kind: "ok",
      mediaType: "image/png",
      data: bytes.toString("base64"),
    });
  });

  test("an admitted image at exactly the wire budget still attaches", async () => {
    const atCap = pngOfSize(WIRE_RAW_BYTES);
    const { runner } = fileDropWriting(atCap, atCap.length);
    const result = await readClipboardImage(optionsFor(runner));
    expect(result).toEqual({
      kind: "ok",
      mediaType: "image/png",
      data: atCap.toString("base64"),
    });
  });

  test("an admitted image over the wire budget reports the declared length", async () => {
    const declared = WIRE_RAW_BYTES + 1;
    const { runner } = fileDropWriting(PNG_HEADER, declared);
    expect(PNG_HEADER.length).toBe(16);
    expect(await readClipboardImage(optionsFor(runner))).toEqual({
      kind: "too-large",
      bytes: declared,
    });
  });

  test("a fit refusal reports the original length even when it is under the wire budget", async () => {
    const declared = 2_000_000;
    const { runner } = fileDropWriting(PNG_HEADER, declared, 204);
    expect(await readClipboardImage(optionsFor(runner))).toEqual({
      kind: "too-large",
      bytes: declared,
    });
  });

  test("a fit refusal of a non-image is an empty clipboard", async () => {
    const { runner } = fileDropWriting(NOT_AN_IMAGE, 2_000_000, 204);
    expect(await readClipboardImage(optionsFor(runner))).toEqual({
      kind: "empty",
    });
  });

  test("a short header whose declared length is under the wire budget is a length mismatch", async () => {
    const declared = 2_743_472;
    expect(declared).toBeLessThan(WIRE_RAW_BYTES);
    expect(PNG_HEADER.length).toBe(16);
    const { runner } = fileDropWriting(PNG_HEADER, declared);
    expect(await readClipboardImage(optionsFor(runner))).toEqual({
      kind: "error",
      message: "clipboard file drop length did not match the bytes read",
    });
  });

  test("a length that is not a decimal integer is an error", async () => {
    const { runner } = fileDropWriting(PNG, "12abc");
    expect(await readClipboardImage(optionsFor(runner))).toEqual({
      kind: "error",
      message: "clipboard file drop length is not a decimal integer",
    });
  });

  test("a file drop that names no length is an error", async () => {
    const { runner, commands } = hostWriting(PNG, {
      ok: true,
      code: 203,
      stderr: "",
    });
    const result = await readClipboardImage(optionsFor(runner));
    expect(commands.length).toBe(1);
    expect(result).toEqual({
      kind: "error",
      message: "clipboard file drop reported no length",
    });
  });
});

describe("readClipboardImage — typed rejections", () => {
  test("no image on the clipboard is empty, not an error", async () => {
    const { runner } = hostWriting(null, { ok: true, code: 200, stderr: "" });
    expect(await readClipboardImage(optionsFor(runner))).toEqual({
      kind: "empty",
    });
  });

  test("a host that exits clean without writing a file is empty", async () => {
    const { runner } = hostWriting(null, EXIT_OK);
    expect(await readClipboardImage(optionsFor(runner))).toEqual({
      kind: "empty",
    });
  });

  test("a zero-byte capture is empty", async () => {
    const { runner } = hostWriting(Buffer.alloc(0));
    expect(await readClipboardImage(optionsFor(runner))).toEqual({
      kind: "empty",
    });
  });

  test("over the wire budget is rejected before any encoding happens", async () => {
    const seen: string[] = [];
    const { runner } = hostWriting(PNG_OVER_CAP);
    const result = await readClipboardImage(
      optionsFor(runner, { fs: countingFilesystem(seen) })
    );
    expect(result).toEqual({ kind: "too-large", bytes: WIRE_RAW_BYTES + 1 });
    expect(seen).not.toContain("read");
    expect(seen).toContain("remove");
  });

  test("bytes that are not one of the four formats are unsupported", async () => {
    for (const bytes of [BMP, NOT_AN_IMAGE]) {
      const { runner } = hostWriting(bytes);
      expect(await readClipboardImage(optionsFor(runner))).toEqual({
        kind: "unsupported",
      });
    }
  });

  test("a failed interop launch is an error, not a hang", async () => {
    const { runner } = hostWriting(null, {
      ok: false,
      reason: "spawn-failed",
      message: "ENOENT powershell.exe",
    });
    const result = await readClipboardImage(optionsFor(runner));
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toContain("ENOENT");
  });

  test("the timeout reaches the caller as the typed error arm", async () => {
    const { runner } = hostWriting(null, {
      ok: false,
      reason: "timeout",
      message: "timed out after 15ms",
    });
    const result = await readClipboardImage(optionsFor(runner));
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toContain("timed out");
  });

  test("a nonzero host exit is an error carrying the exit code", async () => {
    const { runner } = hostWriting(null, {
      ok: true,
      code: 202,
      stderr: "Save failed: generic GDI+ error",
    });
    const result = await readClipboardImage(optionsFor(runner));
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toContain("202");
    expect(result.message).toContain("GDI+");
  });

  test("a missing host binary is refused before spawning anything", async () => {
    const { runner, commands } = hostWriting(PNG);
    const result = await readClipboardImage(
      optionsFor(runner, { env: { PATH: "/nonexistent-path" } })
    );
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toContain("PATH");
    expect(commands.length).toBe(0);
  });

  test("a platform with no measured bridge reports the gap", async () => {
    const { runner, commands } = hostWriting(PNG);
    const result = await readClipboardImage(
      optionsFor(runner, { platform: "darwin" })
    );
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toContain("darwin");
    expect(commands.length).toBe(0);
  });

  test("no writable temp location is an error", async () => {
    const { runner, commands } = hostWriting(PNG);
    const result = await readClipboardImage(
      optionsFor(runner, { tempRoots: [join(SCRATCH, "missing-parent")] })
    );
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toContain("temp");
    expect(commands.length).toBe(0);
  });

  test("host stderr never carries the payload into the message", async () => {
    const leaked = PNG.toString("base64") + PNG.toString("base64");
    const { runner } = hostWriting(null, {
      ok: true,
      code: 202,
      stderr: `buffer was ${leaked} end`,
    });
    const result = await readClipboardImage(optionsFor(runner));
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).not.toContain(PNG.toString("base64"));
    expect(result.message.length).toBeLessThanOrEqual(160);
  });

  test("non-ASCII host stderr cannot corrupt the message", async () => {
    const { runner } = hostWriting(null, {
      ok: true,
      code: 1,
      stderr: "𐀁𐀂 illegal characters 𐀃",
    });
    const result = await readClipboardImage(optionsFor(runner));
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toBe("powershell.exe exited 1: illegal characters");
  });
});

describe("the measured gesture", () => {
  test("spawns the recorded PowerShell argv with a bounded timeout", async () => {
    const { runner, commands } = hostWriting(PNG);
    await readClipboardImage(optionsFor(runner));
    const command = commands[0];
    expect(command?.cmd).toBe("powershell.exe");
    expect(command?.args.slice(0, 5)).toEqual([
      "-STA",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
    ]);
    // Exactly one -Command payload: the script never gets spliced across argv,
    // so nothing can be re-read by a shell.
    expect(command?.args.length).toBe(6);
    const script = command?.args[5] ?? "";
    const containsAt = script.indexOf("ContainsImage()");
    const imageAt = script.indexOf("Get-Clipboard -Format Image");
    // A large file drop makes Get-Clipboard -Format Image fail to return.
    // The bitmap read stays behind ContainsImage(), inside if ($hasImage).
    expect(containsAt).toBeGreaterThanOrEqual(0);
    expect(imageAt).toBeGreaterThan(containsAt);
    expect(script.slice(containsAt, imageAt + 1)).toContain("if ($hasImage)");
    expect(script).toContain("Get-Clipboard -Format Image");
    // The host scales before it writes. Long edge 2000, raw budget whose
    // base64 form is 5 MiB, then JPEG quality if the scaled bytes still miss.
    expect(script).toContain("2000");
    expect(script).toContain("3932160");
    expect(script).toContain("image/jpeg");
    expect(script).toContain("Encoder]::Quality");
    expect(script).toContain("85,70,50,30");
    expect(script).toContain("HighQualityBicubic");
    expect(script).toContain("New-ScaledBitmap");
    expect(script).toContain("FromFile");
    expect(script).toContain("[int64]$b.Width * [int64]$b.Height * 4");
    expect(script).not.toContain("33554432");
    expect(script).not.toContain("$ceiling");
    const byteClause = (name: string, bytes: readonly number[], offset = 0) =>
      bytes
        .map((byte, index) => `$${name}[${offset + index}] -eq ${byte}`)
        .join(" -and ");
    expect(script).toContain(byteClause("head", IMAGE_SIGNATURE_BYTES.png));
    expect(script).toContain(byteClause("head", IMAGE_SIGNATURE_BYTES.jpeg));
    expect(script).toContain(byteClause("head", IMAGE_SIGNATURE_BYTES.gif87a));
    expect(script).toContain(byteClause("head", IMAGE_SIGNATURE_BYTES.gif89a));
    expect(script).toContain(byteClause("head", IMAGE_SIGNATURE_BYTES.riff));
    expect(script).toContain(byteClause("head", IMAGE_SIGNATURE_BYTES.webp, 8));
    expect(PASTE_IMAGE_PROBE_TIMEOUT_MS).toBe(4000);
    // A copied image file has no bitmap. The script must ask the drop list,
    // keep a single file, and report that path with its own exit.
    expect(script).toContain("GetFileDropList");
    expect(script).toContain("Count -ne 1");
    expect(script).toContain("exit 203");
    expect(script).toContain("exit 204");
    expect(script.length).toBeLessThan(30_000);
    expect(script).toContain("clipboard.size");
    expect(script).toContain("ImageFormat]::Png");
    expect(command?.windowsOutputPath).toBeDefined();
    expect(script).toContain(
      `'${command?.windowsOutputPath.replace(/'/g, "''")}'`
    );
    expect(command?.timeoutMs).toBeGreaterThan(0);
    const dir = command ? dirname(command.outputPath) : "";
    // Bytes wait in a fresh mkdtemp dir under the shared root, never loose in
    // the root itself and never inside the repository.
    expect(dir.startsWith(join(SCRATCH, "iknow-clipboard-"))).toBe(true);
    expect(basename(command?.outputPath ?? "")).toBe("clipboard.png");
  });

  test("honours a caller-supplied timeout", async () => {
    const { runner, commands } = hostWriting(PNG);
    await readClipboardImage(optionsFor(runner, { timeoutMs: 15 }));
    expect(commands[0]?.timeoutMs).toBe(15);
  });

  test("maps a mounted temp path to the syntax the host process needs", () => {
    expect(
      toClipboardHostPath("/mnt/c/Users/Public/clip-1/clipboard.png")
    ).toBe("C:\\Users\\Public\\clip-1\\clipboard.png");
    // A native Windows temp dir is already in host syntax; a Linux-only temp
    // dir has no host view and is passed through untouched.
    expect(toClipboardHostPath("C:\\Temp\\clipboard.png")).toBe(
      "C:\\Temp\\clipboard.png"
    );
    expect(toClipboardHostPath("/tmp/clip-1/clipboard.png")).toBe(
      "/tmp/clip-1/clipboard.png"
    );
  });
});

describe("readClipboardImage — temp file lifecycle", () => {
  const scenarios: ReadonlyArray<{
    readonly name: string;
    readonly kind: ClipboardImageResult["kind"];
    readonly bytes: Buffer | null;
    readonly result: CommandResult;
  }> = [
    { name: "ok", kind: "ok", bytes: PNG, result: EXIT_OK },
    { name: "empty", kind: "empty", bytes: null, result: EXIT_OK },
    {
      name: "no-image exit",
      kind: "empty",
      bytes: null,
      result: { ok: true, code: 200, stderr: "" },
    },
    {
      name: "too-large",
      kind: "too-large",
      bytes: PNG_OVER_CAP,
      result: EXIT_OK,
    },
    { name: "unsupported", kind: "unsupported", bytes: BMP, result: EXIT_OK },
    {
      name: "host failure",
      kind: "error",
      bytes: null,
      result: { ok: false, reason: "timeout", message: "timed out after 1ms" },
    },
  ];

  for (const scenario of scenarios) {
    test(`${scenario.name} leaves no temp dir behind`, async () => {
      const { runner } = hostWriting(scenario.bytes, scenario.result);
      const result = await readClipboardImage(optionsFor(runner));
      expect(result.kind).toBe(scenario.kind);
      if (result.kind === "ok") expect(result.data.length).toBeGreaterThan(0);
      expect(readdirSync(SCRATCH)).toEqual([]);
    });
  }
});

describe("readClipboardImage — the caller giving up", () => {
  test("an already-aborted signal never reaches the host", async () => {
    const controller = new AbortController();
    controller.abort();
    const { runner, commands } = hostWriting(PNG);
    const result = await readClipboardImage(
      optionsFor(runner, { signal: controller.signal })
    );
    expect(result).toEqual({ kind: "cancelled" });
    expect(commands.length).toBe(0);
  });

  test("aborting mid-read returns cancelled while the host is still running", async () => {
    const host = hostHolding();
    const controller = new AbortController();
    const pending = readClipboardImage(
      optionsFor(host.runner, { signal: controller.signal })
    );
    await tick(5);
    controller.abort();
    expect(await pending).toEqual({ kind: "cancelled" });
    await host.finish(PNG, EXIT_OK);
    await tick();
    expect(readdirSync(SCRATCH)).toEqual([]);
  });

  test("a result that lands after the caller gave up reaches nobody", async () => {
    const host = hostHolding();
    const controller = new AbortController();
    const resolutions: string[] = [];
    const pending = readClipboardImage(
      optionsFor(host.runner, { signal: controller.signal })
    ).then((result) => {
      resolutions.push(result.kind);
      return result;
    });
    await tick(5);
    controller.abort();
    expect(await pending).toEqual({ kind: "cancelled" });
    // The late completion is the payload the caller refused: it must stay
    // unobservable, and the temp file it wrote must still be cleaned up.
    await host.finish(PNG, EXIT_OK);
    await tick();
    expect(resolutions).toEqual(["cancelled"]);
    expect(readdirSync(SCRATCH)).toEqual([]);
  });

  test("the host command is handed the signal so it can be killed", async () => {
    const host = hostHolding();
    const controller = new AbortController();
    const pending = readClipboardImage(
      optionsFor(host.runner, { signal: controller.signal })
    );
    await tick(5);
    controller.abort();
    expect(await pending).toEqual({ kind: "cancelled" });
    expect(host.commands[0]?.signal).toBe(controller.signal);
    await host.finish(null, {
      ok: false,
      reason: "aborted",
      message: "cancelled",
    });
    await tick();
    expect(readdirSync(SCRATCH)).toEqual([]);
  });
});

describe("runClipboardCommand — the real bounded host runner", () => {
  function request(
    args: ReadonlyArray<string>,
    extra: Partial<ClipboardCommand> = {}
  ): ClipboardCommand {
    return {
      cmd: process.execPath,
      args,
      timeoutMs: 4000,
      env: process.env,
      outputPath: join(SCRATCH, "unused.png"),
      windowsOutputPath: "C:\\unused.png",
      ...extra,
    };
  }

  test("reports the exit code and stderr of a real host process", async () => {
    const result = await runClipboardCommand(
      request(["-e", "console.error('GDI+ wedged'); process.exit(200)"])
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.code).toBe(200);
    expect(result.stderr).toContain("GDI+ wedged");
  });

  test("bounds a wedged command with a typed timeout", async () => {
    const started = Date.now();
    const result = await runClipboardCommand(
      request(["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 20 })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("timeout");
    expect(result.message).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("stops the child when the caller aborts", async () => {
    const controller = new AbortController();
    const pending = runClipboardCommand(
      request(["-e", "setTimeout(() => {}, 60000)"], {
        signal: controller.signal,
      })
    );
    await tick(20);
    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("aborted");
  });

  test("a binary that cannot start is a typed failure, fast", async () => {
    const started = Date.now();
    const result = await runClipboardCommand(
      request(["-e", "0"], { cmd: join(BIN_DIR, "no-such-binary.exe") })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("spawn-failed");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("stdout never reaches the caller — bytes travel only via the temp file", async () => {
    const payload = PNG.toString("base64");
    const result = await runClipboardCommand(
      request(["-e", `console.log('${payload}'); process.exit(1)`])
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("stdout" in result).toBe(false);
    expect(JSON.stringify(result)).not.toContain(payload.slice(0, 40));
  });
});
