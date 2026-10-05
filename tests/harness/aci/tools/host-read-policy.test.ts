import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import {
  decideRead,
  matchProtectedPath,
  READ_PROTECTED_PATHS,
  type ReadPolicyFsMode,
  type ReadPolicyVerdict,
} from "../../../../src/harness/aci/read-policy.ts";
import {
  commandContainsSensitivePath,
  SENSITIVE_PATH_FRAGMENTS,
} from "../../../../src/harness/permission/hard-walls.ts";
import {
  createGlobTool,
  type GlobToolDeps,
} from "../../../../src/harness/aci/tools/glob.ts";
import { createGrepTool } from "../../../../src/harness/aci/tools/grep.ts";
import { createReadFileTool } from "../../../../src/harness/aci/tools/read-file.ts";
import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import { createFsModeContext } from "../../../../src/harness/sandbox/fs-mode.ts";

// Module-level pins for the canonical host-read policy (specs/host-read-policy.md
// SC8-SC13 + the EXIT fail-closed section). No tool consumes the policy yet;
// every call here goes directly to the module with nothing but a plain roots
// object — the SC12 "callable with no tool/ctx/session state" half of the pin.

const scratchPaths: string[] = [];

async function makeScratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

const MODES: readonly ReadPolicyFsMode[] = ["global", "workspace"];

function denyWith(
  verdict: ReadPolicyVerdict,
  reason: string,
  context?: string
): void {
  assert.equal(
    verdict.outcome,
    "deny",
    `expected deny(${reason})${context ? ` for ${context}` : ""}, got ${JSON.stringify(verdict)}`
  );
  assert.equal((verdict as { reason: string }).reason, reason);
}

function allow(verdict: ReadPolicyVerdict): void {
  assert.equal(
    verdict.outcome,
    "allow",
    `expected allow, got ${JSON.stringify(verdict)}`
  );
}

afterEach(async () => {
  for (const path of scratchPaths.splice(0)) {
    // Restore traversal bits before removal so chmod-000 fixtures never block cleanup.
    await chmod(path, 0o755).catch(() => undefined);
    await rm(path, { recursive: true, force: true, maxRetries: 3 }).catch(
      () => undefined
    );
  }
});

describe("read-policy roster — the match shapes (SC9 ownership)", () => {
  it("declares the spec-enumerated patterns across the shapes", () => {
    const byShape = (shape: string): string[] =>
      READ_PROTECTED_PATHS.filter((entry) => entry.shape === shape).map(
        (entry) => entry.pattern
      );
    assert.deepEqual(byShape("path-glob"), [
      ".ssh/",
      ".aws/",
      ".gnupg/",
      ".config/gh/",
      ".kube/",
      ".docker/config.json",
    ]);
    assert.deepEqual(byShape("extension-glob"), ["*.pem", "*.key", "*.p12"]);
    assert.deepEqual(byShape("dotfile-glob"), [".env", ".env.*"]);
    // The shell roster's `$`-anchored regex fragments (`\.env$`, `\.ssh$`,
    // `\.aws$`, `\.gnupg$`, `\.config/gh$`, `\.kube$`, `\.pem$`, `\.key$`,
    // `\.p12$`) deny a credential whose name merely ENDS with the token —
    // `app.env`, `backup.ssh`, `old.aws` — which no pre-fix shape reached.
    // `suffix-glob` is the shape that closes that floor gap. It also carries
    // the three tokens the shell roster holds UNANCHORED (`id_rsa`,
    // `id_ed25519`, `.netrc`): `exact-basename` matched only the whole final
    // segment, so `app.id_rsa` and `id_rsax.ts` were shell-DENY / read-ALLOW.
    assert.deepEqual(byShape("suffix-glob"), [
      "id_rsa",
      "id_ed25519",
      ".netrc",
      ".env",
      ".ssh",
      ".aws",
      ".gnupg",
      ".config/gh",
      ".kube",
      ".pem",
      ".key",
      ".p12",
    ]);
    // The shell roster's one non-`$` regex (`\.env\.`) denies a mid-name
    // `.env.` token (`foo.env.bar`). `inner-glob` covers exactly that shape.
    assert.deepEqual(byShape("inner-glob"), [".env"]);
    assert.deepEqual(byShape("absolute-prefix"), [
      "/etc/passwd",
      "/etc/shadow",
      "/proc/self/environ",
    ]);
  });

  it("is a frozen constant owned by this module (a new list, not an import)", () => {
    assert.ok(Object.isFrozen(READ_PROTECTED_PATHS));
    for (const entry of READ_PROTECTED_PATHS) assert.ok(Object.isFrozen(entry));
  });

  it("matches each shape positively and ordinary paths negatively", () => {
    for (const protectedPath of [
      "/home/u/.ssh/id_ecdsa",
      "/home/u/.aws/credentials",
      "/home/u/.gnupg/secring.gpg",
      "/home/u/.config/gh/hosts.yml",
      "/home/u/.kube/config",
      "/home/u/.docker/config.json",
      "/proj/certs/server.pem",
      "/proj/certs/server.key",
      "/proj/bundle/p12/app.p12",
      "/home/u/.ssh/id_rsa",
      "/home/u/.ssh/id_ed25519",
      "/home/u/.netrc",
      "/proj/.env",
      "/proj/.env.production",
      "/etc/passwd",
      "/etc/shadow",
      "/proc/self/environ",
    ]) {
      assert.notEqual(
        matchProtectedPath(protectedPath),
        null,
        `expected match: ${protectedPath}`
      );
    }
    for (const ordinaryPath of [
      "/proj/src/main.ts",
      "/proj/notes.txt",
      "/home/u/code/a.go",
      "/tmp/scratch/readme.md",
      "/proj/src/keyring.go",
      "/proj/environments/stage.cfg",
    ]) {
      assert.equal(
        matchProtectedPath(ordinaryPath),
        null,
        `expected no match: ${ordinaryPath}`
      );
    }
  });

  it("never throws on hostile matcher input (SC10: matcher itself does not throw)", () => {
    for (const hostile of [
      "",
      " ",
      "///",
      ".ssh/" + "a".repeat(9000),
      "a".repeat(9000),
      "\u0000",
      "~",
      "\\",
    ]) {
      assert.doesNotThrow(() => matchProtectedPath(hostile));
    }
  });
});

describe("SC9 — no-weaker-than-shell pin: every shell fragment denies", () => {
  // The shell roster is imported read-only (#1164 exported it); this spec never
  // edits it. The floor assertion is applied the way `matchSensitivePath` and
  // `commandContainsSensitivePath` apply it: `\\`-prefixed fragments are regex
  // sources, the rest are literals.
  function shellWallsDeny(fragment: string, path: string): boolean {
    return fragment.startsWith("\\")
      ? new RegExp(fragment).test(path)
      : path.includes(fragment);
  }

  // SC9 is about PATHS, not about the roster's own spelling. The `\\`-prefixed
  // fragments are regex *sources* (`\\.ssh$`), never path text; feeding one to
  // the matcher as a path asserted nothing real and only passed through a raw
  // substring arm. Every fragment is therefore pinned by concrete paths the
  // shell wall itself denies, so a future read-roster edit that drops a shape
  // goes red here.
  const SHELL_DENIED_PATHS: readonly string[] = [
    "/home/u/.ssh",
    "/home/u/.ssh\\\\config",
    "/home/u/.ssh/id_rsa",
    "/home/u/.ssh/id_ed25519",
    "/home/u/.aws",
    "/home/u/.aws/credentials",
    "/home/u/.gnupg",
    "/home/u/.gnupg/secring.gpg",
    "/home/u/.config/gh",
    "/home/u/.config/gh/hosts.yml",
    "/home/u/.kube",
    "/home/u/.kube/config",
    "/home/u/.docker/config.json",
    "/home/u/.netrc",
    "/proj/.env",
    "/proj/.env.production",
    "/proj/key.pem",
    "/proj/x.key",
    "/proj/c.p12",
    "/etc/passwd",
    "/etc/shadow",
    "/proc/self/environ",
    // The `$`-anchored regex arms: a credential whose name merely ENDS with the
    // token, with no leading-dot or extension-position requirement. These were
    // the SC9 hole — shell DENY, read ALLOW, so `bash cat app.env` was walled
    // while `read_file app.env` succeeded.
    "/proj/app.env",
    "/proj/foo.env.bar",
    "/proj/re.env.json",
    "/proj/backup.ssh",
    "/proj/old.aws",
    "/proj/x.kube",
    "/proj/.pem",
    "/proj/notes.key",
    "/proj/bundle.p12",
    // The token as a MIDDLE path component (the shell's literal `/`-arms and
    // the `$`-regexes both reach these).
    "/proj/backup.ssh/config",
    "/proj/old.aws/credentials",
    // `.config/gh` spans TWO segments, so a matcher that compares one segment
    // at a time can never fire it — these are the witnesses that keep the
    // entry from being permanently dead code.
    "/proj/app.config/gh",
    "/proj/app.config/gh/hosts.yml",
    // `id_rsa` / `id_ed25519` / `.netrc` are UNANCHORED in the shell roster (a
    // bare `includes`), so they match inside a longer name and at any depth.
    "/proj/app.id_rsa",
    "/proj/keys/id_rsa",
    "/proj/id_rsax.ts",
    "/proj/app.id_ed25519x.ts",
    "/proj/app..netrc",
    "/proj/.netrcx.ts",
  ];

  it("imports the real shell roster and denies every fragment's own witnesses", () => {
    assert.ok(
      Object.isFrozen(SENSITIVE_PATH_FRAGMENTS),
      "the shell roster must stay a frozen constant the read policy only reads"
    );
    assert.ok(
      SENSITIVE_PATH_FRAGMENTS.length >= 20,
      `expected the full shell roster, got ${SENSITIVE_PATH_FRAGMENTS.length}`
    );
  });

  it("pins every shell fragment to concrete paths it denies, and the read matcher denies too", () => {
    for (const fragment of SENSITIVE_PATH_FRAGMENTS) {
      const witnesses = SHELL_DENIED_PATHS.filter((path) =>
        shellWallsDeny(fragment, path)
      );
      assert.notEqual(
        witnesses.length,
        0,
        `no corpus path matches shell fragment ${JSON.stringify(fragment)} — extend SHELL_DENIED_PATHS`
      );
      for (const witness of witnesses) {
        assert.notEqual(
          matchProtectedPath(witness),
          null,
          `matcher missed ${witness}, which shell fragment ${JSON.stringify(fragment)} denies`
        );
      }
    }
  });

  it("drives every shell-denied path through the full decision and asserts a protected_path deny", async () => {
    const scratch = await makeScratch("hrp-shellfloor-");
    let driven = 0;
    for (const path of SHELL_DENIED_PATHS) {
      const shellDenies = SENSITIVE_PATH_FRAGMENTS.some((fragment) =>
        shellWallsDeny(fragment, path)
      );
      assert.ok(shellDenies, `corpus path ${path} is not shell-denied`);
      driven++;
      const verdict = await decideRead(path, { taskRoot: scratch });
      denyWith(verdict, "protected_path");
      assert.match(
        verdict.outcome === "deny" ? verdict.message : "",
        /protected-path/
      );
    }
    assert.equal(driven, SHELL_DENIED_PATHS.length);
  });

  it("the shell command wall itself denies every corpus path (the pin's real binary)", () => {
    // The SC9 floor is about the SHELL channel: assert it against the wall's
    // own exported command scanner, not only against a local re-spelling of
    // its fragment semantics. If `hard-walls.ts` ever narrows, this goes red.
    for (const path of SHELL_DENIED_PATHS) {
      assert.ok(
        commandContainsSensitivePath(`cat ${path}`),
        `the shell command wall no longer denies ${path}`
      );
    }
  });

  it("matches a Windows-separated protected path the shell roster's `\\\\` arm denies", () => {
    // The roster's `.ssh\\\\` fragment arm had no path witness before this
    // corpus; without one SC9 covered only the POSIX spelling.
    assert.notEqual(matchProtectedPath("C:\\Users\\u\\.ssh\\config"), null);
  });

  it("no cross-channel hole: every path the shell wall denies the read tools deny too", async () => {
    // The finding this pins: `bash cat app.env` was hard-walled while
    // `read_file app.env` succeeded, because the read roster had no arm for a
    // credential whose name merely ENDS with the token. Asserted through the
    // two REAL entry points — the shell wall's exported command scanner and the
    // policy's own decision — so neither channel's re-spelling can drift.
    const scratch = await makeScratch("hrp-crosschannel-");
    for (const path of [
      "/proj/app.env",
      "/proj/foo.env.bar",
      "/proj/backup.ssh",
      "/proj/old.aws",
      "/proj/x.kube",
      "/proj/.pem",
    ]) {
      assert.ok(
        commandContainsSensitivePath(`cat ${path}`),
        `shell wall no longer denies ${path}`
      );
      denyWith(
        await decideRead(path, { taskRoot: scratch }),
        "protected_path",
        `read policy must not be weaker than the shell wall on ${path}`
      );
    }
  });
});

describe("substring containment is not protection — ordinary paths stay readable", () => {
  // The removed arm denied any path merely CONTAINING a pattern's core
  // (`.ssh/`→`.ssh`, `*.key`→`.key`, `.env.*`→`.env`). It matched no credential
  // the per-shape matchers do not already catch, and it over-denied.
  // The suffix-glob / inner-glob arms added for the SC9 floor are anchored
  // (end-of-name, or a `.`/segment boundary around the token), so every one of
  // these collision spellings still reads.
  for (const ordinary of [
    "/proj/.keyboard.md",
    "/proj/docs/.keyboard.md",
    "/proj/.sshfoo/x",
    "/proj/docs/monkey.md",
    "/proj/src/keyring.go",
    "/proj/a.pemx",
    "/proj/.environment",
    "/proj/environments/stage.cfg",
    // NOT an allow witness: the shell roster carries `id_rsa` UNANCHORED, so
    // `id_rsa_notes.md` is refused there too and the read channel must match.
    // suffix-glob must anchor at a name boundary, not a raw substring.
    // (`id_rsa` itself is unanchored on BOTH sides — see UNANCHORED_SHELL_TOKENS.)
    "/proj/envoy",
    "/proj/pemfile",
    "/proj/applepenny",
    "/proj/sshkeys",
    "/proj/awson",
    "/proj/kubelet",
    "/proj/mid.envy",
    "/proj/gnup",
    // A directory whose name merely ENDS with a protected token is ordinary:
    // the shell wall denies none of these (it has no `X/` fragment for `.key`,
    // `.pem`, `.p12` or `.env`), so the `/`-continuation must not reach them.
    "/proj/src/router.key/handler.ts",
    "/proj/src/certs.pem/README.md",
    "/proj/config/app.env/notes.md",
    "/proj/benchmarks.env/README",
    "/proj/foo.p12/b.txt",
    "/proj/data/my.key/row.ts",
    // The shell roster's `absolute-prefix` / `path-glob` fragments are bare
    // substrings there, so a NESTED spelling (`/srv/etc/passwd`,
    // `/app.docker/config.json`) matches on that side and not here. Those are
    // incidental collisions rather than credentials — a real passwd is at
    // `/etc/passwd` — and the shapes that would reach them are the same ones
    // that over-denied `.keyboard.md`. Pinned deliberately: the trade-off is a
    // contract, not an accident, so narrowing or widening it has to be
    // deliberate too.
    "/srv/etc/passwd",
    "/chroot/etc/shadow",
    "/app.docker/config.json",
  ]) {
    it(`allows ${ordinary}`, () => {
      assert.equal(matchProtectedPath(ordinary), null);
    });
  }

  it("allows a `.ssh`-prefixed directory and a `.key`-substring filename through the full decision", async () => {
    const scratch = await makeScratch("hrp-substring-");
    await mkdir(join(scratch, ".sshfoo"), { recursive: true });
    await writeFile(join(scratch, ".sshfoo", "x"), "x");
    await writeFile(join(scratch, ".keyboard.md"), "x");
    for (const name of [".sshfoo/x", ".keyboard.md"]) {
      allow(await decideRead(name, { taskRoot: scratch }));
    }
  });

  it("still denies the roster at any depth — the removed arm protected nothing", () => {
    for (const protectedPath of [
      "/proj/.ssh/config",
      "/home/u/.ssh/anything",
      "/home/u/proj/.ssh/x",
      "/proj/id_rsa",
      "/proj/keys/id_rsa",
      "/proj/id_ed25519",
      "/proj/certs/key.pem",
      "/proj/certs/x.key",
      "/proj/bundle/c.p12",
      "/proj/.env",
      "/proj/a/.env.production",
      "/etc/passwd",
      "/etc/shadow",
      "/proc/self/environ",
    ]) {
      assert.notEqual(
        matchProtectedPath(protectedPath),
        null,
        `lost protection on ${protectedPath}`
      );
    }
  });

  it("denies a `.key` file under a decoy directory, which the substring arm allowed", async () => {
    const scratch = await makeScratch("hrp-decoy-");
    await mkdir(join(scratch, "certs"), { recursive: true });
    await writeFile(join(scratch, "certs", "server.key"), "secret");
    denyWith(
      await decideRead("certs/server.key", { taskRoot: scratch }),
      "protected_path"
    );
  });
});

describe("SC10 — empty / whitespace / separator-only inputs deny, fail-closed", () => {
  for (const unusable of [
    "",
    " ",
    "\t",
    "  \n ",
    "/",
    "//",
    "\\",
    "///",
    "/ /",
    "\\\\",
  ]) {
    it(`denies ${JSON.stringify(unusable)} with a resolution-failure, no throw`, async () => {
      const verdict = await decideRead(unusable, { taskRoot: "/tmp" });
      denyWith(verdict, "resolution_failure");
      assert.match(
        verdict.outcome === "deny" ? verdict.message : "",
        /unusable input|empty/
      );
    });
  }

  it("carries a message distinguishable from protected-path and out-of-reach", async () => {
    const empty = await decideRead("", { taskRoot: "/tmp" });
    const protectedPath = await decideRead("/home/u/.ssh/id_rsa", {
      taskRoot: "/tmp",
    });
    const unreachable = await decideRead("relative/path.txt", {});
    assert.equal(empty.outcome, "deny");
    assert.equal(protectedPath.outcome, "deny");
    assert.equal(unreachable.outcome, "deny");
    const reasons = new Set([
      (empty as { reason: string }).reason,
      (protectedPath as { reason: string }).reason,
      (unreachable as { reason: string }).reason,
    ]);
    assert.equal(
      reasons.size,
      3,
      "the three deny reasons must be distinguishable"
    );
    assert.equal((unreachable as { reason: string }).reason, "out_of_reach");
  });
});

describe("SC11 — overflow inputs have a defined typed deny, never a crash", () => {
  it("denies a PATH_MAX-length absolute path as a resolution failure", async () => {
    const long = "/tmp/" + "a".repeat(5000);
    const verdict = await decideRead(long, { taskRoot: "/tmp" });
    denyWith(verdict, "resolution_failure");
    assert.match(
      verdict.outcome === "deny" ? verdict.message : "",
      /too long|deeply nested/
    );
  });

  it("denies an extreme deep-nesting path (many segments)", async () => {
    const deep =
      "/tmp/" + Array.from({ length: 800 }, (_, i) => `seg${i}`).join("/");
    const verdict = await decideRead(deep, { taskRoot: "/tmp" });
    denyWith(verdict, "resolution_failure");
  });

  it("denies a single over-long segment without touching the filesystem", async () => {
    const wideName = "b".repeat(300);
    const verdict = await decideRead(`/tmp/${wideName}`, { taskRoot: "/tmp" });
    denyWith(verdict, "resolution_failure");
    assert.match(
      verdict.outcome === "deny" ? verdict.message : "",
      /too long|deeply nested/
    );
  });

  it("denies a NUL byte in the path without throwing", async () => {
    const verdict = await decideRead("/tmp/ab\u0000cd.txt", {
      taskRoot: "/tmp",
    });
    denyWith(verdict, "resolution_failure");
  });
});

describe("SC8 — positive protection under a fully reachable root, both modes", () => {
  it("allows an ordinary temp file and denies a protected path under the same root in both modes", async () => {
    const scratch = await makeScratch("hrp-scope-");
    await writeFile(join(scratch, "ordinary.txt"), "plain content");
    await mkdir(join(scratch, ".ssh"), { recursive: true });
    await writeFile(join(scratch, ".ssh", "id_rsa"), "protected content");
    for (const mode of MODES) {
      const roots = { taskRoot: scratch };
      allow(await decideRead(join(scratch, "ordinary.txt"), roots, mode));
      const denied = await decideRead(
        join(scratch, ".ssh", "id_rsa"),
        roots,
        mode
      );
      denyWith(denied, "protected_path");
    }
  });

  it("gives identical verdicts in both modes (the read axis does not fork on mode)", async () => {
    const scratch = await makeScratch("hrp-mode-");
    await writeFile(join(scratch, "notes.txt"), "x");
    for (const candidate of [
      join(scratch, "notes.txt"),
      join(scratch, ".env"),
      "",
      "/proc/self/environ",
    ]) {
      const [g, w] = await Promise.all([
        decideRead(candidate, { taskRoot: scratch }, "global"),
        decideRead(candidate, { taskRoot: scratch }, "workspace"),
      ]);
      assert.deepEqual(g.outcome, w.outcome);
      if (g.outcome === "deny" && w.outcome === "deny")
        assert.equal(g.reason, w.reason);
    }
  });
});

describe("SC3 module half — symlink rules judged on realpath AND pre-resolution path", () => {
  it("allows an ordinary file reached through an ordinary symlink chain", async () => {
    const scratch = await makeScratch("hrp-linkok-");
    const realDir = join(scratch, "realdir");
    await mkdir(realDir);
    await writeFile(join(realDir, "notes.txt"), "benign");
    const dirLink = join(scratch, "dirlink");
    await symlink(realDir, dirLink);
    const fileLink = join(scratch, "filelink.txt");
    await symlink(join(realDir, "notes.txt"), fileLink);
    const roots = { taskRoot: scratch };
    allow(await decideRead(fileLink, roots));
    allow(await decideRead(join(dirLink, "notes.txt"), roots));
  });

  it("denies a symlink alias of a protected target by the protected-path rule", async () => {
    const scratch = await makeScratch("hrp-linkdeny-");
    const vault = join(scratch, ".ssh");
    await mkdir(vault);
    const secret = join(vault, "id_rsa");
    await writeFile(secret, "protected bytes");
    const alias = join(scratch, "innocuous-name.txt");
    await symlink(secret, alias);
    const roots = { taskRoot: scratch };
    denyWith(await decideRead(alias, roots), "protected_path");
  });

  it("denies a link pointing INTO a protected directory", async () => {
    const scratch = await makeScratch("hrp-linkinto-");
    const vault = join(scratch, ".ssh");
    await mkdir(vault);
    await writeFile(join(vault, "id_ed25519"), "k");
    const intoVault = join(scratch, "window");
    await symlink(vault, intoVault);
    denyWith(
      await decideRead(join(intoVault, "id_ed25519"), { taskRoot: scratch }),
      "protected_path"
    );
  });

  it("denies a protected file whose symlink lives at a pre-resolution protected name", async () => {
    const scratch = await makeScratch("hrp-linkpre-");
    const target = join(scratch, "elsewhere.txt");
    await writeFile(target, "x");
    // The link's own name sits inside a protected directory shape.
    const aws = join(scratch, ".aws");
    await mkdir(aws);
    const link = join(aws, "credentials");
    await symlink(target, link);
    denyWith(await decideRead(link, { taskRoot: scratch }), "protected_path");
  });
});

describe("SC13 — canonicalization failures deny as resolution failures", () => {
  it("denies a dangling symlink (realpath ENOENT) without leaking the raw code", async () => {
    const scratch = await makeScratch("hrp-dangling-");
    const gone = join(scratch, "target.bin");
    await writeFile(gone, "y");
    const link = join(scratch, "alias.bin");
    await symlink(gone, link);
    await unlink(gone);
    const verdict = await decideRead(link, { taskRoot: scratch });
    denyWith(verdict, "resolution_failure");
    assert.doesNotMatch(
      verdict.outcome === "deny" ? verdict.message : "",
      /ENOENT/
    );
  });

  it("denies a path with a dangling symlink in a middle component", async () => {
    const scratch = await makeScratch("hrp-danglingmid-");
    const mid = join(scratch, "mid");
    await symlink(join(scratch, "not-there"), mid);
    const verdict = await decideRead(join(mid, "nested", "file.txt"), {
      taskRoot: scratch,
    });
    denyWith(verdict, "resolution_failure");
  });

  it("denies a symlink loop (ELOOP)", async () => {
    const scratch = await makeScratch("hrp-loop-");
    const loop = join(scratch, "ouroboros");
    await symlink(loop, loop);
    const verdict = await decideRead(loop, { taskRoot: scratch });
    denyWith(verdict, "resolution_failure");
    assert.match(verdict.outcome === "deny" ? verdict.message : "", /loop/);
    assert.doesNotMatch(
      verdict.outcome === "deny" ? verdict.message : "",
      /ELOOP/
    );
  });

  const runningAsRoot =
    typeof process.getuid === "function" && process.getuid() === 0;
  const maybeIt = runningAsRoot ? it.skip : it;
  maybeIt(
    "denies a path through an unreadable component (EACCES)",
    async () => {
      const scratch = await makeScratch("hrp-eacces-");
      const locked = join(scratch, "locked");
      await mkdir(locked);
      const secretPath = join(locked, "notes.txt");
      await writeFile(secretPath, "n");
      await chmod(locked, 0o000);
      try {
        const verdict = await decideRead(secretPath, { taskRoot: scratch });
        denyWith(verdict, "resolution_failure");
        assert.match(
          verdict.outcome === "deny" ? verdict.message : "",
          /unreadable/
        );
        assert.doesNotMatch(
          verdict.outcome === "deny" ? verdict.message : "",
          /EACCES/
        );
      } finally {
        await chmod(locked, 0o755);
      }
    }
  );

  it("never rejects the promise regardless of input (no exception escapes as an allow)", async () => {
    const oddities = [
      "~",
      "~root",
      join("\u0000"),
      "/".repeat(50),
      "/proc/self/root",
      "/dev/null",
    ];
    for (const oddity of oddities) {
      const verdict = await decideRead(oddity, {});
      assert.ok(
        verdict.outcome === "allow" || verdict.outcome === "deny",
        `bad verdict for ${oddity}`
      );
    }
  });
});

describe("SC12 — pure surface: no state, concurrency-safe, mode/roots are the only inputs", () => {
  it("returns identical verdicts for repeated and concurrent calls on the same path", async () => {
    const scratch = await makeScratch("hrp-pure-");
    await writeFile(join(scratch, "a.txt"), "a");
    await mkdir(join(scratch, ".gnupg"));
    await writeFile(join(scratch, ".gnupg", "secring"), "s");
    const roots = { taskRoot: scratch };
    const inputs = [
      join(scratch, "a.txt"),
      join(scratch, ".gnupg", "secring"),
      "",
      join(scratch, "missing-ordinary.txt"),
    ];
    const sequential: ReadPolicyVerdict[] = [];
    for (const input of inputs) sequential.push(await decideRead(input, roots));
    const concurrent = await Promise.all(
      [...inputs, ...inputs].map((input, i) =>
        decideRead(input, roots, i % 2 === 0 ? "global" : "workspace")
      )
    );
    // Compare against the sequential verdicts (canonicalPath is stable for existing paths).
    for (let i = 0; i < inputs.length; i++) {
      const seq = sequential[i];
      const par = concurrent[i];
      assert.equal(par.outcome, seq.outcome);
      if (seq.outcome === "deny" && par.outcome === "deny") {
        assert.equal(par.reason, seq.reason);
      }
    }
    // Repeated calls on the same existing path produce the same canonical path.
    const again = await decideRead(join(scratch, "a.txt"), roots);
    assert.equal(
      (again as { canonicalPath?: string }).canonicalPath,
      (sequential[0] as { canonicalPath?: string }).canonicalPath
    );
  });

  it("expands ~ against the supplied home root and denies ~ without one (purity: identity comes from roots)", async () => {
    const scratch = await makeScratch("hrp-home-");
    await writeFile(join(scratch, "notes.txt"), "n");
    const roots = { homeRoot: scratch };
    const expanded = await decideRead("~/notes.txt", roots);
    allow(expanded);
    // The remainder after `~/` must not override the home anchor (a `resolve`
    // would treat `~//x` as absolute and drop homeRoot entirely).
    assert.equal(
      (expanded as { canonicalPath: string }).canonicalPath,
      join(await realpath(scratch), "notes.txt")
    );
    const bare = await decideRead("~", roots);
    allow(bare);
    assert.equal(
      (bare as { canonicalPath: string }).canonicalPath,
      await realpath(scratch)
    );
    denyWith(await decideRead("~/.ssh/id_rsa", roots), "protected_path");
    const noHome = await decideRead("~/notes.txt", {});
    denyWith(noHome, "resolution_failure");
  });

  it("canonicalizes through symlinks for the reported path (realpath discipline, composes with helpers)", async () => {
    const scratch = await realpath(await makeScratch("hrp-canonical-"));
    const realDir = join(scratch, "actual");
    await mkdir(realDir);
    await writeFile(join(realDir, "ok.txt"), "o");
    const link = join(scratch, "shortcut");
    await symlink(realDir, link);
    const verdict = await decideRead(join(link, "ok.txt"), {
      taskRoot: scratch,
    });
    allow(verdict);
    assert.equal(
      (verdict as { canonicalPath: string }).canonicalPath,
      join(realDir, "ok.txt")
    );
  });

  // Post-widening (T4) half: the same purity claim over the **real tool
  // handlers** — mixed in-root / outside-root, ordinary / protected paths all
  // in one concurrent batch. Reach now comes from the per-call verdict, so a
  // concurrent call must not be able to alter another call's answer: each
  // concurrent outcome equals the single-threaded baseline for its path.
  it("concurrent handler calls on mixed in-root/outside-root paths keep single-threaded verdicts (SC12, widened reach)", async () => {
    const tree = await makeToolTree("hrp-sc12-tools-");
    const outside = await realpath(await makeScratch("hrp-sc12-out-"));
    await writeFile(join(outside, "plain.txt"), "outside-plain\n");
    await mkdir(join(outside, ".aws"), { recursive: true });
    await writeFile(
      join(outside, ".aws", "credentials"),
      `aws ${SECRET_BYTES}\n`
    );

    const read = readFileTool(tree.root, "global");
    const inputs = [
      join(tree.root, "notes.txt"),
      join(outside, "plain.txt"),
      join(outside, ".aws", "credentials"),
      "notes.txt",
    ];
    const settle = async (path: string): Promise<string> => {
      try {
        return `allow:${String(await read.handler({ path }))}`;
      } catch (error) {
        return `deny:${(error as Error).message.slice(0, 60)}`;
      }
    };
    const sequential: string[] = [];
    for (const path of inputs) sequential.push(await settle(path));
    const concurrent = await Promise.all(
      [...inputs, ...inputs].map((path) => settle(path))
    );
    for (let i = 0; i < inputs.length; i++) {
      const base = sequential[i]!;
      assert.equal(
        concurrent[i],
        base,
        `concurrent vs single-thread mismatch at ${inputs[i]}`
      );
      assert.equal(
        concurrent[inputs.length + i],
        base,
        `repeat-call verdict drifted at ${inputs[i]}`
      );
    }
    // Shape sanity: the ordinary in-root/outside-root reads allowed, the
    // protected outside path is refused by the roster (never by reach).
    assert.ok(sequential[1]!.startsWith("allow:"));
    assert.match(sequential[2]!, /deny:.*protected-path roster/);
  });
});

// ─── Tool enforcement (SC2 / SC3 tool half) ───────────────────────────────
// The three read-capable tools consult decideRead on the canonicalized path
// before any bytes/lines/paths enter a result. Engine matrix note: the Node
// degrade variants are driven here by pointing `engineBinaryPath` at a
// nonexistent file (no fake spawn); the real-rg engine is pinned with the
// same fixtures inside grep.test.ts / glob.test.ts, which already hard-gate
// on the provisioned binary.

const SECRET_BYTES = "HRP-SECRET-BYTES-4f1a";

interface ToolTree {
  readonly root: string;
  readonly fakeHome: string;
  /** Protected roster fixtures reachable by plain containment (they sit under the live root). */
  readonly protectedRels: readonly string[];
}

async function makeToolTree(prefix: string): Promise<ToolTree> {
  const root = await makeScratch(prefix);
  const fakeHome = join(root, "fakehome");
  await mkdir(join(fakeHome, ".ssh"), { recursive: true });
  await mkdir(join(fakeHome, ".aws"), { recursive: true });
  await mkdir(join(root, "certs"), { recursive: true });
  await writeFile(join(fakeHome, ".ssh", "id_rsa"), `ssh ${SECRET_BYTES}\n`);
  await writeFile(
    join(fakeHome, ".aws", "credentials"),
    `aws ${SECRET_BYTES}\n`
  );
  await writeFile(join(root, ".env"), `env ${SECRET_BYTES}\n`);
  await writeFile(join(root, "certs", "server.pem"), `pem ${SECRET_BYTES}\n`);
  await writeFile(join(root, "notes.txt"), "benign-note\n");
  // Symlink alias of a protected target + a benign ordinary link chain (SC3).
  await symlink(join(fakeHome, ".ssh", "id_rsa"), join(root, "innocuous.txt"));
  await mkdir(join(root, "realdir"));
  await writeFile(join(root, "realdir", "ok.txt"), "chain-note\n");
  await symlink(join(root, "realdir"), join(root, "dirlink"));
  return {
    root,
    fakeHome,
    protectedRels: [
      "fakehome/.ssh/id_rsa",
      "fakehome/.aws/credentials",
      ".env",
      "certs/server.pem",
    ],
  };
}

function readFileTool(root: string, mode: ReadPolicyFsMode) {
  return createReadFileTool(root, { fsMode: createFsModeContext(mode) });
}

// Node degrade shape for grep: nonexistent pinned binary → unavailable → nodeScan.
function grepTool(root: string, mode: ReadPolicyFsMode) {
  return createGrepTool(root, {
    fsMode: createFsModeContext(mode),
    engineBinaryPath: join(root, "__no_such_engine__", "rg"),
  });
}

// Node walker shape for glob: the pinned path does not exist → ENOENT → walkAndMatch.
function globTool(root: string, mode: ReadPolicyFsMode, deps?: GlobToolDeps) {
  return createGlobTool(root, {
    fsMode: createFsModeContext(mode),
    engineBinaryPath: join(root, "__no_such_engine__", "rg"),
    ...deps,
  });
}

async function assertRefusedByRoster(
  call: () => Promise<unknown>
): Promise<void> {
  await assert.rejects(call, (error: unknown) => {
    assert.ok(
      error instanceof ToolExecutionError,
      `expected ToolExecutionError, got ${String(error)}`
    );
    const message = (error as Error).message;
    assert.match(
      message,
      /protected-path roster/,
      `refusal must name the protected-path rule: ${message}`
    );
    // Refusal-never-masking: a protected denial never wears a mode-restriction
    // or file-absence costume, and never carries the secret bytes.
    assert.doesNotMatch(
      message,
      /file not found|not a file|is a directory|outside workspace|mode/
    );
    assert.ok(
      !message.includes(SECRET_BYTES),
      "denied read must leak no bytes"
    );
    return true;
  });
}

describe("SC2 tool half — read_file refuses the roster under an otherwise-allowed root, both modes", () => {
  for (const mode of MODES) {
    it(`refuses every protected fixture path (fsMode=${mode})`, async () => {
      const tree = await makeToolTree(`hrp-tool-read-${mode}-`);
      const tool = readFileTool(tree.root, mode);
      for (const rel of tree.protectedRels) {
        await assertRefusedByRoster(() =>
          tool.handler({ path: join(tree.root, rel) })
        );
      }
    });

    it(
      "still reads an ordinary file under the same root (fsMode=" + mode + ")",
      async () => {
        const tree = await makeToolTree(`hrp-tool-read-ok-${mode}-`);
        const tool = readFileTool(tree.root, mode);
        const out = String(await tool.handler({ path: "notes.txt" }));
        assert.ok(out.includes("benign-note"));
      }
    );
  }
});

describe("SC2 tool half — grep refuses protected search roots and filters protected hits out of every result, both modes", () => {
  for (const mode of MODES) {
    it(`a protected path argument is a typed refusal (fsMode=${mode})`, async () => {
      const tree = await makeToolTree(`hrp-tool-grep-root-${mode}-`);
      const tool = grepTool(tree.root, mode);
      await assertRefusedByRoster(() =>
        tool.handler({ pattern: "x", path: join(tree.root, ".env") })
      );
      await assertRefusedByRoster(() =>
        tool.handler({ pattern: "x", path: "fakehome/.ssh" })
      );
      await assertRefusedByRoster(() =>
        tool.handler({
          pattern: "x",
          path: join(tree.fakeHome, ".aws", "credentials"),
        })
      );
    });

    it(`protected hits under an allowed root never appear — no path, no bytes (fsMode=${mode})`, async () => {
      const tree = await makeToolTree(`hrp-tool-grep-leak-${mode}-`);
      const tool = grepTool(tree.root, mode);
      const secret = String(
        await tool.handler({ pattern: SECRET_BYTES, output: "content" })
      );
      for (const leak of [
        SECRET_BYTES,
        "id_rsa",
        "credentials",
        "server.pem",
        ".env",
      ]) {
        assert.ok(!secret.includes(leak), `result leaked ${leak}: ${secret}`);
      }
      // Positive control: the same tool/root still answers ordinary content.
      const benign = String(
        await tool.handler({ pattern: "benign-note", output: "content" })
      );
      assert.ok(
        benign.includes("notes.txt"),
        `ordinary hit must survive the filter: ${benign}`
      );
    });
  }
});

describe("SC2 tool half — glob never emits protected paths, both modes and both collection engines", () => {
  for (const mode of MODES) {
    it(`walker form filters and refuses (fsMode=${mode})`, async () => {
      const tree = await makeToolTree(`hrp-tool-glob-walk-${mode}-`);
      const tool = globTool(tree.root, mode);
      const listing = String(await tool.handler({ pattern: "**" }));
      for (const leak of ["id_rsa", "credentials", "server.pem", ".env"]) {
        assert.ok(
          !listing.includes(leak),
          `listing leaked ${leak}: ${listing}`
        );
      }
      assert.ok(
        listing.includes("notes.txt"),
        `ordinary file must still list: ${listing}`
      );
      await assertRefusedByRoster(() =>
        tool.handler({
          pattern: "**",
          path: join(tree.root, "certs", "server.pem"),
        })
      );
      await assertRefusedByRoster(() =>
        tool.handler({ pattern: "**", path: "fakehome/.ssh" })
      );
    });

    it(`rg-output form filters canned engine emissions (fsMode=${mode})`, async () => {
      const tree = await makeToolTree(`hrp-tool-glob-rg-${mode}-`);
      const canned =
        ["notes.txt", "fakehome/.ssh/id_rsa", ".env", "certs/server.pem"].join(
          "\n"
        ) + "\n";
      const tool = globTool(tree.root, mode, {
        spawnRg: async () => ({ stdout: canned, stderr: "" }),
      });
      const listing = String(await tool.handler({ pattern: "**" }));
      assert.equal(listing, "notes.txt");
    });
  }
});

describe("SC3 tool half — symlink alias refuses by the same rule, benign chains still read, all three tools both modes", () => {
  for (const mode of MODES) {
    it(`alias of a protected target is refused by the protected-path rule (fsMode=${mode})`, async () => {
      const tree = await makeToolTree(`hrp-tool-link-deny-${mode}-`);
      await assertRefusedByRoster(() =>
        readFileTool(tree.root, mode).handler({ path: "innocuous.txt" })
      );
      await assertRefusedByRoster(() =>
        grepTool(tree.root, mode).handler({
          pattern: "x",
          path: "innocuous.txt",
        })
      );
      await assertRefusedByRoster(() =>
        globTool(tree.root, mode).handler({
          pattern: "*",
          path: "innocuous.txt",
        })
      );
    });

    it(`an ordinary file through an ordinary link chain still reads (fsMode=${mode})`, async () => {
      const tree = await makeToolTree(`hrp-tool-link-ok-${mode}-`);
      const out = String(
        await readFileTool(tree.root, mode).handler({ path: "dirlink/ok.txt" })
      );
      assert.ok(out.includes("chain-note"), `benign chain read: ${out}`);
    });
  }
});

describe("protection is positive and refusal is never masking — deny reasons stay distinguishable", () => {
  it("a protected path OUTSIDE the tool's containment roots is refused by the roster, not as an escape", async () => {
    const tree = await makeToolTree("hrp-tool-positive-");
    const outside = await makeScratch("hrp-tool-outside-");
    await mkdir(join(outside, ".ssh"), { recursive: true });
    await writeFile(join(outside, ".ssh", "id_rsa"), `ssh ${SECRET_BYTES}\n`);
    await writeFile(join(outside, "plain.txt"), "ordinary\n");
    const absProtected = join(outside, ".ssh", "id_rsa");
    const read = readFileTool(tree.root, "global");
    await assertRefusedByRoster(() => read.handler({ path: absProtected }));
    await assertRefusedByRoster(() =>
      grepTool(tree.root, "global").handler({
        pattern: "x",
        path: absProtected,
      })
    );
    await assertRefusedByRoster(() =>
      globTool(tree.root, "global").handler({
        pattern: "*",
        path: absProtected,
      })
    );
    // Reach IS widened (T4): the ordinary file outside every containment root
    // reads through the policy's allow arm — and the protected path directly
    // above it, under this same otherwise-fully-reachable directory, stays
    // refused by the roster (SC8: the rule cannot be satisfied by scoping the
    // reachable set, so no unguarded root is involved).
    const out = String(
      await read.handler({ path: join(outside, "plain.txt") })
    );
    assert.ok(out.includes("ordinary"), `widened read: ${out}`);
  });

  it("resolution-failure denials name the resolution failure, never the roster or a raw errno", async () => {
    const tree = await makeToolTree("hrp-tool-dangling-");
    const gone = join(tree.root, "target.bin");
    await writeFile(gone, "y");
    await symlink(gone, join(tree.root, "alias.bin"));
    await unlink(gone);
    await assert.rejects(
      () => readFileTool(tree.root, "global").handler({ path: "alias.bin" }),
      (error: unknown) => {
        const message = (error as Error).message;
        assert.ok(error instanceof ToolExecutionError);
        assert.match(message, /resolution failure/);
        assert.doesNotMatch(
          message,
          /protected-path roster|ENOENT|not a file|file not found/
        );
        return true;
      }
    );
    await assert.rejects(
      () => readFileTool(tree.root, "global").handler({ path: "   " }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        /resolution failure/i.test(error.message)
    );
  });

  it("an ordinary missing file keeps the untouched file-not-found answer (refusal never masks, and protection never impersonates)", async () => {
    const tree = await makeToolTree("hrp-tool-notfound-");
    await assert.rejects(
      () => readFileTool(tree.root, "global").handler({ path: "nope.txt" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("file not found") &&
        !error.message.includes("protected-path roster")
    );
  });
});

// ─── SC1 tool half — ordinary host file, all three tools, both modes ──────
// Real temp files unrelated to the live task root, driven through the real
// handlers (Node degrade engine here; the pinned-rg / real-rg halves of the
// engine matrix are pinned per engine in grep.test.ts / glob.test.ts).

describe("SC1 tool half — ordinary host paths outside the task root are reachable, both modes", () => {
  const SIGNAL = "outside-signal-9e2c";

  for (const mode of MODES) {
    it(`read_file / grep / glob reach an ordinary temp path (fsMode=${mode})`, async () => {
      const taskRoot = await makeScratch(`hrp-sc1-task-${mode}-`);
      await writeFile(join(taskRoot, "inside.txt"), "inside\n");
      const outside = await realpath(await makeScratch(`hrp-sc1-out-${mode}-`));
      await writeFile(join(outside, "host-notes.txt"), `${SIGNAL}\n`);

      const readOut = String(
        await readFileTool(taskRoot, mode).handler({
          path: join(outside, "host-notes.txt"),
        })
      );
      assert.ok(readOut.includes(SIGNAL), `read_file widened: ${readOut}`);

      const grepOut = String(
        await grepTool(taskRoot, mode).handler({
          pattern: SIGNAL,
          path: outside,
          output: "content",
        })
      );
      assert.ok(grepOut.includes("host-notes.txt"), `grep widened: ${grepOut}`);

      const globOut = String(
        await globTool(taskRoot, mode).handler({
          pattern: "*.txt",
          path: outside,
        })
      );
      assert.ok(globOut.includes("host-notes.txt"), `glob widened: ${globOut}`);
    });
  }
});

// Arm-switch roots discipline (review follow-up, High 1-3 remediation): the
// containment switch in `resolveReadReach` compares the policy's
// realpath-canonical path against the containment roots **realpath'ed**
// (the `resolveWithinRoot` discipline from `tools/helpers.ts`). A task root
// reached through a symlinked parent (root alias ≠ root canonical) must
// therefore keep its targets on the containment arm — where the relative
// name's identity-root fallback runs — and must never be misrouted to the
// widened arm just because the *string* of the raw root prefix doesn't match
// the canonical path.
describe("arm switch — a symlinked task-root parent keeps targets on the containment arm", () => {
  it("a relative name missing in the linked root still falls back to the identity root", async () => {
    const scratch = await makeScratch("hrp-linked-root-");
    const realRoot = join(scratch, "realroot");
    await mkdir(realRoot);
    const linkedRoot = join(scratch, "linkedroot");
    await symlink(realRoot, linkedRoot);
    const identity = join(scratch, "identity");
    await mkdir(identity);
    await writeFile(join(identity, "shared.txt"), "linked-arm-note\n");

    // Key not threaded → the identity root passes ungated (legacy tri-state).
    const tool = createReadFileTool(linkedRoot, {
      projectIdentityRoot: identity,
    });
    const body = String(await tool.handler({ path: "shared.txt" }));
    assert.match(
      body,
      /linked-arm-note/,
      "the switch must see policyPath under the canonicalized root"
    );
  });
});

describe("SC8 widened — protected entries under an otherwise fully reachable OUTSIDE root stay refused", () => {
  for (const mode of MODES) {
    it(`positive protection survives the widening (fsMode=${mode})`, async () => {
      const taskRoot = await makeScratch(`hrp-sc8w-task-${mode}-`);
      const outside = await realpath(
        await makeScratch(`hrp-sc8w-out-${mode}-`)
      );
      await mkdir(join(outside, ".ssh"), { recursive: true });
      await writeFile(join(outside, ".ssh", "id_rsa"), `ssh ${SECRET_BYTES}\n`);
      await writeFile(join(outside, "readme.md"), "outside-benign\n");

      await assertRefusedByRoster(() =>
        readFileTool(taskRoot, mode).handler({
          path: join(outside, ".ssh", "id_rsa"),
        })
      );
      await assertRefusedByRoster(() =>
        grepTool(taskRoot, mode).handler({
          pattern: "x",
          path: join(outside, ".ssh"),
        })
      );
      await assertRefusedByRoster(() =>
        globTool(taskRoot, mode).handler({
          pattern: "*",
          path: join(outside, ".ssh", "id_rsa"),
        })
      );

      // The widened root itself: ordinary file discoverable, protected file
      // never emitted by either collection path.
      const grepSecret = String(
        await grepTool(taskRoot, mode).handler({
          pattern: SECRET_BYTES,
          path: outside,
          output: "content",
        })
      );
      assert.ok(
        !grepSecret.includes(SECRET_BYTES),
        `grep leaked protected bytes under widened root: ${grepSecret}`
      );
      const globOut = String(
        await globTool(taskRoot, mode).handler({ pattern: "**", path: outside })
      );
      assert.ok(
        !globOut.includes("id_rsa"),
        `glob emitted protected path: ${globOut}`
      );
      assert.ok(
        globOut.includes("readme.md"),
        `widened glob lost ordinary file: ${globOut}`
      );
      const benign = String(
        await grepTool(taskRoot, mode).handler({
          pattern: "outside-benign",
          path: outside,
          output: "content",
        })
      );
      assert.ok(
        benign.includes("readme.md"),
        `widened grep lost ordinary hit: ${benign}`
      );
    });
  }
});
