/**
 * specs/effect-boundary-protection.md "Error handling → The refusal message
 * template" — the protected-target boundary refusal beside the
 * worktree-unbind donor (`unboundFenceErofsGuidance`). The reuse is the
 * SHAPE (typed `[fs_denied]` prefix, EROFS-stderr trigger, cap-and-count
 * rendering of attempted-path clues, `undefined` on a stderr with no EROFS
 * line), never the string: the two templates share no sentence, and the
 * worktree-only wording must never appear on a protected-target refusal.
 *
 * The direction pair: (a) the new template carries none of the
 * worktree-only substrings, (b) the worktree guidance stays byte-identical
 * (golden strings measured against the pre-spec code, pinned here from the
 * other direction).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  CREATE_WORKTREE_TOOL_HINT,
  unboundFenceErofsGuidance,
} from "../../../src/harness/isolation/worktree-gate.js";
import { VIOLATION_PREFIXES } from "../../../src/harness/permission/prefixes.js";
import {
  describeProtectedTargetClass,
  protectedTargetErofsGuidance,
  protectedTargetFenceGuidance,
} from "../../../src/harness/sandbox/protected-target-feedback.js";
import { createProtectedTargetInventory } from "../../../src/harness/sandbox/protected-targets.js";
import { categorizeResult } from "../../../src/harness/sandbox/violation-handling.js";

const SSH_RM_LINE =
  "rm: cannot remove '/home/u/.ssh/id_ed25519': Read-only file system";

/**
 * The scan scope must be a REAL directory: the inventory refuses an absent or
 * non-directory scan root at assembly (a zero-match "all clear" fence is the
 * failure this closes). The fictional `/home/u` home below is still the right
 * input for pure path classification, so the scan scope is a scratch dir that
 * is never consulted by these cases.
 */
const SCAN_ROOT = mkdtempSync(join(tmpdir(), "iknow-erofs-scan-"));
afterAll(() => rmSync(SCAN_ROOT, { recursive: true, force: true }));

/** The three worktree-only substrings the spec names as banned, plus the
 *  word itself — the new copy never mentions the worktree boundary. */
const WORKTREE_ONLY = [
  "create_worktree",
  CREATE_WORKTREE_TOOL_HINT,
  "worktree isolation is ON",
  "not yet bound to a task worktree",
];

describe("protectedTargetErofsGuidance — the four ordered parts", () => {
  it("synthetic EROFS stderr → prefix, class, fence attribution, unconditional refusal — in order", () => {
    const guidance = protectedTargetErofsGuidance(
      SSH_RM_LINE,
      "ssh_key_material"
    );
    expect(guidance).toBeDefined();
    const text = guidance!;
    // (1) typed prefix from the VIOLATION_PREFIXES SSOT, never a drifted literal
    expect(text.startsWith(`${VIOLATION_PREFIXES.fsDenied} `)).toBe(true);
    // (2) the protected target CLASS named from the inventory, right after the prefix
    const classIdx = text.indexOf(
      describeProtectedTargetClass("ssh_key_material")
    );
    expect(classIdx).toBeGreaterThan(VIOLATION_PREFIXES.fsDenied.length);
    // (3) fence-layer attribution: kernel EROFS at the filesystem layer,
    const erofsIdx = text.indexOf(
      "kernel (EROFS) refused the write at the filesystem layer"
    );
    expect(erofsIdx).toBeGreaterThan(classIdx);
    const notSyntaxIdx = text.indexOf("not a command-syntax judgment");
    expect(notSyntaxIdx).toBeGreaterThan(erofsIdx);
    const respellIdx = text.indexOf("re-spelling the command will not help");
    expect(respellIdx).toBeGreaterThan(notSyntaxIdx);
    // (4) no route is offered at all: the receipt mechanism was withdrawn
    // (issue #1159), so the copy must state the refusal unconditionally
    // rather than promise a conditional one.
    for (const withdrawn of [
      "authorization receipt",
      "cleanup window",
      "authorized route",
    ]) {
      expect(text).not.toContain(withdrawn);
    }
    const unconditionalIdx = text.indexOf("is not an operation this session");
    expect(unconditionalIdx).toBeGreaterThan(respellIdx);
    expect(text).toContain("no\n    spelling, flag, or ordering".replace("\n    ", " "));
  });

  it("carries NONE of the worktree-only substrings (direction A of the pair)", () => {
    const guidance = protectedTargetErofsGuidance(
      SSH_RM_LINE,
      "ssh_key_material"
    )!;
    for (const banned of WORKTREE_ONLY) {
      expect(guidance).not.toContain(banned);
    }
    expect(guidance.toLowerCase()).not.toContain("worktree");
  });

  it("a stderr with no EROFS line yields undefined (caller keeps the result byte-identical)", () => {
    expect(
      protectedTargetErofsGuidance(
        "bash: line 1: frobnicate: not found\n",
        "ssh_key_material"
      )
    ).toBeUndefined();
    expect(
      protectedTargetErofsGuidance("", "ssh_key_material")
    ).toBeUndefined();
  });

  it("reuses the ADR-0109 cap-and-count rendering: first 5 lines, then (+N more EROFS lines)", () => {
    const lines = Array.from(
      { length: 7 },
      (_, i) => `rm: cannot remove '/home/u/.ssh/k${i}': Read-only file system`
    );
    const guidance = protectedTargetErofsGuidance(
      lines.join("\n"),
      "ssh_key_material"
    )!;
    expect(guidance).toContain("k4");
    expect(guidance).not.toContain("k5");
    expect(guidance).not.toContain("k6");
    expect(guidance).toContain("(+2 more EROFS lines)");
    // no remainder marker when nothing was cut
    const five = lines.slice(0, 5).join("\n");
    expect(
      protectedTargetErofsGuidance(five, "ssh_key_material")
    ).not.toContain("more EROFS lines");
  });

  it("non-EROFS lines in mixed stderr are not echoed as attempted paths", () => {
    const guidance = protectedTargetErofsGuidance(
      `some unrelated noise\nls: cannot open '/home/u/x': Permission denied\n${SSH_RM_LINE}`,
      "ssh_key_material"
    )!;
    expect(guidance).toContain("/home/u/.ssh/id_ed25519");
    expect(guidance).not.toContain("Permission denied");
    expect(guidance).not.toContain("unrelated noise");
  });

  it("parameterized by the inventory target class — distinct phrase per class", () => {
    const cases: ReadonlyArray<[string, string]> = [
      ["ssh_key_material", "an SSH private key"],
      ["cloud_credential", "a cloud credential file"],
      ["dotenv_file", "an environment file"],
      ["tls_key_material", "a TLS key material file"],
    ];
    for (const [classId, phrase] of cases) {
      const guidance = protectedTargetErofsGuidance(SSH_RM_LINE, classId)!;
      expect(guidance).toContain(phrase);
    }
    // unknown (extra-target) class ids fall back to a named-class phrase,
    // never a bare id and never an empty string
    const extra = protectedTargetErofsGuidance(SSH_RM_LINE, "vault_dir")!;
    expect(extra).toContain('a protected target (class "vault_dir")');
  });
});

describe("worktree guidance unchanged — direction B of the pair", () => {
  // Byte-identical strings measured against the pre-spec implementation
  // (tsx probe on the current implementation), pinned so the protected-
  // target copy can never drift INTO the worktree template either.
  const GOLDEN_PLAIN =
    "[fs_denied] the workspace is read-only in this session: worktree isolation is ON" +
    " and this session is not yet bound to a task worktree, so the main checkout is" +
    " mounted read-only inside the sandbox fence and the writes above failed at the" +
    " filesystem layer. To write, call the create-worktree ACI tool to put this" +
    " session on a writable root, then re-issue this same command — it will land in" +
    " the new root on the next wave of tool calls in this run. Attempted paths" +
    " (from stderr): touch: cannot touch '/repo/f.txt': Read-only file system";
  const GOLDEN_GIT_META =
    "[fs_denied] the workspace is read-only in this session: worktree isolation is ON" +
    " and this session is not yet bound to a task worktree, so the main checkout is" +
    " mounted read-only inside the sandbox fence and the writes above failed at the" +
    " filesystem layer. This write targets git metadata (a .git path) of the read-only" +
    " main checkout: call the create-worktree ACI tool first, then run the same git" +
    " command from inside the task tree — it will land in that tree's own gitdir on" +
    " the next wave of tool calls in this run. Attempted paths (from stderr): fatal:" +
    " Unable to create '/repo/.git/index.lock': Read-only file system";

  it("unboundFenceErofsGuidance (plain-file arm) stays byte-identical", () => {
    expect(
      unboundFenceErofsGuidance(
        "touch: cannot touch '/repo/f.txt': Read-only file system\n"
      )
    ).toBe(GOLDEN_PLAIN);
  });

  it("unboundFenceErofsGuidance (git-metadata arm) stays byte-identical", () => {
    expect(
      unboundFenceErofsGuidance(
        "fatal: Unable to create '/repo/.git/index.lock': Read-only file system\n"
      )
    ).toBe(GOLDEN_GIT_META);
  });

  it("the donor's undefined-on-no-EROFS contract still holds byte-identically", () => {
    expect(unboundFenceErofsGuidance("plain failure\n")).toBeUndefined();
  });
});

describe("protectedTargetFenceGuidance — class resolution from the stderr paths", () => {
  const inventory = createProtectedTargetInventory({ home: "/home/u", scanRoot: SCAN_ROOT });

  it("GNU-coreutils shape (quoted path before the marker) resolves the entry's class", () => {
    const guidance = protectedTargetFenceGuidance(SSH_RM_LINE, inventory)!;
    expect(guidance).toContain("an SSH private key");
  });

  it("python OSError shape (quoted path after the marker) resolves the class", () => {
    const guidance = protectedTargetFenceGuidance(
      "OSError: [Errno 30] Read-only file system: '/home/u/.aws/credentials'",
      inventory
    )!;
    expect(guidance).toContain("a cloud credential file");
  });

  it("unquoted absolute path (tee shape) resolves the class", () => {
    const guidance = protectedTargetFenceGuidance(
      "tee: /home/u/.netrc: Read-only file system",
      inventory
    )!;
    expect(guidance).toContain("a netrc credential file");
  });

  it("an EROFS line on a NON-protected path → undefined (no fabricated class; the worktree donor owns workspace wording)", () => {
    expect(
      protectedTargetFenceGuidance(
        "touch: cannot touch '/workspace/f.txt': Read-only file system",
        inventory
      )
    ).toBeUndefined();
    expect(protectedTargetFenceGuidance("", inventory)).toBeUndefined();
    expect(
      protectedTargetFenceGuidance(
        "no erofs here: /home/u/.ssh/id_rsa",
        inventory
      )
    ).toBeUndefined();
  });

  it("two protected classes in one stderr → one [fs_denied] message per class", () => {
    const guidance = protectedTargetFenceGuidance(
      [
        SSH_RM_LINE,
        "OSError: [Errno 30] Read-only file system: '/home/u/.kube/config'",
      ].join("\n"),
      inventory
    )!;
    const messages = guidance.split("\n");
    expect(messages).toHaveLength(2);
    for (const m of messages) {
      expect(m.startsWith(`${VIOLATION_PREFIXES.fsDenied} `)).toBe(true);
      expect(m.toLowerCase()).not.toContain("worktree");
    }
    expect(guidance).toContain("an SSH private key");
    expect(guidance).toContain("a Kubernetes config file");
  });
});

describe("a boundary refusal is never labelled a hard-wall deny (categorizer path)", () => {
  const guidance = protectedTargetErofsGuidance(
    SSH_RM_LINE,
    "ssh_key_material"
  )!;

  it("categorizeResult reads the [fs_denied]-prefixed refusal as the fs_denied mid tier, never via the hard-wall arm", () => {
    const cat = categorizeResult({
      name: "bash",
      input: { command: "rm -f /home/u/.ssh/id_ed25519" },
      kind: "execution_failed",
      message: guidance,
    });
    expect(cat.tier).toBe("mid");
    expect(cat.detail).toBe(guidance);
    // the hard-wall arm's regex must not fire on boundary-refusal copy
    expect(guidance).not.toMatch(/\[hard_wall\]\s+(dangerous|sensitive)/);
    // and the copy never dresses the fence refusal up with the hard_wall prefix at all
    expect(guidance).not.toContain(VIOLATION_PREFIXES.hardWall);
  });

  it("the guidance rides the ok-envelope stderr — it is not a counted violation (ADR-0109 precedent)", () => {
    const cat = categorizeResult({
      name: "bash",
      input: { command: "rm -f /home/u/.ssh/id_ed25519" },
      kind: "ok",
      message: guidance,
    });
    expect(cat.tier).toBeUndefined();
  });
});
