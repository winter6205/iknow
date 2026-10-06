/**
 * Violation-feedback wiring (specs/effect-boundary-protection.md
 * "Error handling → The refusal message template"): the protected-target
 * boundary refusal reaches the model through the same ok-envelope stderr
 * channel the ADR-0109 unbound guidance rides (no exit-semantics change, no
 * violation counting — `categorizeResult` only knows execution_failed).
 * Unlike the worktree donor the trigger is NOT the unbound state: the
 * protected-target ro-bind is mounted in every fenced state, so a BOUND
 * (gate-OFF) session that hits EROFS at a protected path gets the class-
 * named refusal too.
 *
 * Mocks `runInSandbox` to feed synthetic fence results — the operator's real
 * credential files are never touched; the protected path is only a string
 * resolved from `homedir()`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/harness/sandbox/runner.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/harness/sandbox/runner.js")
    >();
  return {
    ...actual,
    requireBwrap: () => {},
    runInSandbox: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  };
});

const { createBashTool } =
  await import("../../../src/harness/aci/tools/bash.ts");
const { runInSandbox } = await import("../../../src/harness/sandbox/runner.ts");
const { createLiveTaskRoot } =
  await import("../../../src/harness/session-roots.js");

const scratchPaths: string[] = [];
function makeScratch(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

afterAll(() => {
  for (const path of scratchPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

afterEach(() => {
  vi.mocked(runInSandbox).mockReset();
  vi.mocked(runInSandbox).mockResolvedValue({
    exitCode: 0,
    stdout: "",
    stderr: "",
  });
});

function makeTool(root: string) {
  // gate OFF (no worktreeOnMutate holder) → bound/baseline fence state: the
  // unbound donor CANNOT fire here, so any [fs_denied] line is the new
  // protected-target template.
  return createBashTool(root, {
    liveTaskRoot: createLiveTaskRoot(root),
    tmpDir: makeScratch("t10-pad-"),
  });
}

function parseBash(envelope: unknown): {
  code: number;
  stdout: string;
  stderr: string;
} {
  const env = envelope as { output: string };
  return JSON.parse(env.output);
}

const PROTECTED_STDERR = `rm: cannot remove '${join(
  homedir(),
  ".ssh",
  "id_ed25519"
)}': Read-only file system\n`;

describe("protected-target EROFS feedback wired at the bash result seam", () => {
  it("fenced non-zero exit + EROFS on a protected path → class-named boundary refusal appended", async () => {
    vi.mocked(runInSandbox).mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: PROTECTED_STDERR,
    });
    const out = parseBash(
      await makeTool(makeScratch("t10-root-")).handler({
        command: "echo probe",
      })
    );
    expect(out.stderr).toContain("[fs_denied]");
    expect(out.stderr).toContain("an SSH private key");
    expect(out.stderr).toContain("is not an operation this session");
    // the withdrawn receipt mechanism must not be advertised at the seam
    expect(out.stderr).not.toContain("authorization receipt");
    // direction A of the drift pair at the seam: no worktree copy rides here
    expect(out.stderr.toLowerCase()).not.toContain("worktree");
    // the raw fence line is kept, not swallowed
    expect(out.stderr).toContain(PROTECTED_STDERR.trim());
  });

  it("EROFS on a NON-protected path → stderr byte-identical (no fabricated class)", async () => {
    const stderr =
      "touch: cannot touch '/workspace/f.txt': Read-only file system\n";
    vi.mocked(runInSandbox).mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr,
    });
    const out = parseBash(
      await makeTool(makeScratch("t10-root-")).handler({
        command: "echo probe",
      })
    );
    expect(out.stderr).toBe(stderr);
    expect(out.stderr).not.toContain("[fs_denied]");
  });

  it("zero exit with an EROFS-looking stderr → byte-identical (success is never annotated)", async () => {
    vi.mocked(runInSandbox).mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: PROTECTED_STDERR,
    });
    const out = parseBash(
      await makeTool(makeScratch("t10-root-")).handler({
        command: "echo probe",
      })
    );
    expect(out.stderr).toBe(PROTECTED_STDERR);
    expect(out.stderr).not.toContain("[fs_denied]");
  });

  it("yolo (fence retired) → no fence-attributed guidance", async () => {
    vi.mocked(runInSandbox).mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: PROTECTED_STDERR,
    });
    const tool = createBashTool(makeScratch("t10-root-"), {
      liveTaskRoot: createLiveTaskRoot("/tmp"),
      tmpDir: makeScratch("t10-pad-"),
      yolo: { get: () => true, set: () => undefined },
    });
    const out = parseBash(await tool.handler({ command: "echo probe" }));
    expect(out.stderr).not.toContain("an SSH private key");
  });
});

/**
 * The EBUSY arm at the same seam. Unlike the EROFS arm above (which triggers
 * on any protected-path EROFS), this one fires ONLY when the stderr path is a
 * `/dev/null` mask the fence actually emitted — so the mocked stderr has to be
 * matched against a REAL fence assembly: the tool is given a scratch HOME that
 * really contains a `.netrc`, `runInSandbox` is mocked to return the EBUSY
 * line for exactly that path, and the fence's own `exactFileMaskPaths` is the
 * correlation set. No operator credential is read or written — the fixture is
 * a generated sentinel string in a mkdtemp root.
 */
const FIXTURE_HOME = makeScratch("t11-ebusy-home-");
const FIXTURE_NETRC = join(FIXTURE_HOME, ".netrc");
writeFileSync(FIXTURE_NETRC, "machine gh login tok password fixture-only\n", {
  mode: 0o600,
});

const NETRC_EBUSY = `rm: cannot remove '${FIXTURE_NETRC}': Device or resource busy\n`;
const UNRELATED_EBUSY = "umount: /mnt/cdrom: Device or resource busy\n";

function makeFixtureHomeTool() {
  return createBashTool(makeScratch("t11-root-"), {
    liveTaskRoot: createLiveTaskRoot(makeScratch("t11-task-")),
    tmpDir: makeScratch("t11-pad-"),
    // The inventory resolves against this homeRoot, so the fixture `.netrc`
    // is a real protected target AND a real emitted mask for this assembly.
    homeRoot: FIXTURE_HOME,
  });
}

describe("protected-target EBUSY feedback wired at the bash result seam", () => {
  it("an EBUSY on a mask this fence emitted → class-named EBUSY refusal appended", async () => {
    vi.mocked(runInSandbox).mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: NETRC_EBUSY,
    });
    const out = parseBash(
      await makeFixtureHomeTool().handler({ command: "echo probe" })
    );
    expect(out.stderr).toContain("[fs_denied]");
    expect(out.stderr).toContain("Device or resource busy");
    expect(out.stderr).toContain("cannot remove");
    // the raw fence line is kept, not swallowed
    expect(out.stderr).toContain(NETRC_EBUSY.trim());
  });

  it("a genuinely unrelated EBUSY → stderr byte-identical (advisory never relabels)", async () => {
    vi.mocked(runInSandbox).mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: UNRELATED_EBUSY,
    });
    const out = parseBash(
      await makeFixtureHomeTool().handler({ command: "echo probe" })
    );
    expect(out.stderr).toBe(UNRELATED_EBUSY);
    expect(out.stderr).not.toContain("[fs_denied]");
  });

  it("yolo (fence retired, no masks emitted) → EBUSY guidance cannot fire", async () => {
    vi.mocked(runInSandbox).mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: NETRC_EBUSY,
    });
    const tool = createBashTool(makeScratch("t11-root-"), {
      liveTaskRoot: createLiveTaskRoot("/tmp"),
      tmpDir: makeScratch("t11-pad-"),
      yolo: { get: () => true, set: () => undefined },
    });
    const out = parseBash(await tool.handler({ command: "echo probe" }));
    expect(out.stderr).toBe(NETRC_EBUSY);
  });

  it("zero exit with an EBUSY-looking stderr → byte-identical (success is never annotated)", async () => {
    vi.mocked(runInSandbox).mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: NETRC_EBUSY,
    });
    const out = parseBash(
      await makeFixtureHomeTool().handler({ command: "echo probe" })
    );
    expect(out.stderr).toBe(NETRC_EBUSY);
    expect(out.stderr).not.toContain("[fs_denied]");
  });
});

/**
 * The fs-MODE boundary arm at the same seam (ADR-0140). Before this, an EROFS
 * that resolved to no protected class produced NOTHING — the model got a bare
 * kernel line with no boundary attribution. The observation is deliberately
 * narrow: it fires only for a non-protected path inside the tier's read-only
 * root and outside both writable roots, i.e. a positively identified crossing.
 * Everything else keeps today's byte-identical result.
 */
const MODE_HOME = makeScratch("t12-mode-home-");
mkdirSync(join(MODE_HOME, "task"), { recursive: true });
const OUT_OF_TIER = `touch: cannot touch '${join(MODE_HOME, "notes.txt")}': Read-only file system\n`;
const IN_WRITABLE_ROOT = `touch: cannot touch '${join(MODE_HOME, "task", "f.txt")}': Read-only file system\n`;

function makeWorkspaceTierTool() {
  return createBashTool(makeScratch("t12-root-"), {
    liveTaskRoot: createLiveTaskRoot(join(MODE_HOME, "task")),
    tmpDir: makeScratch("t12-pad-"),
    homeRoot: MODE_HOME,
    fsMode: { get: () => "workspace", set: () => undefined },
  });
}

describe("fs-mode boundary EROFS feedback wired at the bash result seam", () => {
  it("a write outside the tier's writable roots → the mode-boundary refusal, not the protected-target one", async () => {
    vi.mocked(runInSandbox).mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: OUT_OF_TIER,
    });
    const out = parseBash(
      await makeWorkspaceTierTool().handler({ command: "echo probe" })
    );
    expect(out.stderr).toContain("[fs_denied]");
    expect(out.stderr).toContain(
      "left what this session's filesystem isolation tier permits"
    );
    // the protected-target sentences must NOT ride this refusal
    expect(out.stderr).not.toContain(
      "is not an operation this session can perform"
    );
    expect(out.stderr).not.toContain("an SSH private key");
    // the raw fence line is kept, not swallowed
    expect(out.stderr).toContain(OUT_OF_TIER.trim());
  });

  it("an EROFS on a path INSIDE a writable root → byte-identical (not a crossing)", async () => {
    vi.mocked(runInSandbox).mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: IN_WRITABLE_ROOT,
    });
    const out = parseBash(
      await makeWorkspaceTierTool().handler({ command: "echo probe" })
    );
    expect(out.stderr).toBe(IN_WRITABLE_ROOT);
    expect(out.stderr).not.toContain("[fs_denied]");
  });

  it("a GLOBAL tier has no mode boundary → byte-identical (a host read-only path is not a session decision)", async () => {
    vi.mocked(runInSandbox).mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: OUT_OF_TIER,
    });
    const out = parseBash(
      await makeTool(makeScratch("t12-root-")).handler({
        command: "echo probe",
      })
    );
    expect(out.stderr).toBe(OUT_OF_TIER);
    expect(out.stderr).not.toContain("[fs_denied]");
  });

  it("zero exit with a mode-boundary-looking stderr → byte-identical (success is never annotated)", async () => {
    vi.mocked(runInSandbox).mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: OUT_OF_TIER,
    });
    const out = parseBash(
      await makeWorkspaceTierTool().handler({ command: "echo probe" })
    );
    expect(out.stderr).toBe(OUT_OF_TIER);
    expect(out.stderr).not.toContain("[fs_denied]");
  });

  it("yolo (fence retired) → the mode-boundary arm cannot fire either", async () => {
    vi.mocked(runInSandbox).mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: OUT_OF_TIER,
    });
    const tool = createBashTool(makeScratch("t12-root-"), {
      liveTaskRoot: createLiveTaskRoot("/tmp"),
      tmpDir: makeScratch("t12-pad-"),
      homeRoot: MODE_HOME,
      fsMode: { get: () => "workspace", set: () => undefined },
      yolo: { get: () => true, set: () => undefined },
    });
    const out = parseBash(await tool.handler({ command: "echo probe" }));
    expect(out.stderr).toBe(OUT_OF_TIER);
    expect(out.stderr).not.toContain("[fs_denied]");
  });

  it("an unrelated non-zero exit → byte-identical (the arm never relabels a failure)", async () => {
    const stderr =
      "python3: can't open file '/tmp/nope.py': No such file or directory\n";
    vi.mocked(runInSandbox).mockResolvedValue({
      exitCode: 2,
      stdout: "",
      stderr,
    });
    const out = parseBash(
      await makeWorkspaceTierTool().handler({ command: "echo probe" })
    );
    expect(out.stderr).toBe(stderr);
    expect(out.stderr).not.toContain("[fs_denied]");
  });
});
