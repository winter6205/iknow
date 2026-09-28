import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  createProtectedTargetInventory,
  protectedTargetRoBindArgs,
} from "../../../src/harness/sandbox/protected-targets.js";
import type { ProtectedTargetInventory } from "../../../src/harness/sandbox/protected-targets.js";
import {
  OPTIONAL_HOST_RO_PREFIXES,
  READ_ONLY_SYSTEM_PATHS,
} from "../../../src/harness/sandbox/fs-policy.js";
import { SENSITIVE_PATH_FRAGMENTS } from "../../../src/harness/permission/hard-walls.js";
import { ToolExecutionError } from "../../../src/harness/errors.js";

// SC7(a) inventory surface: one resolved-path SSOT structure answering
// "is this path a protected target, of which class" for both downstream
// consumers (the mount layer and the read-side control), with the credential
// arm distinguishable inside the same entries array. Fixture homes are
// mkdtemp-only; the operator's real home and credentials are never touched,
// and membership is pure resolved-path data so no fixture file needs to exist.

const HOME = mkdtempSync(join(tmpdir(), "protected-targets-home-"));

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

function fixture(): ProtectedTargetInventory {
  return createProtectedTargetInventory({ home: HOME, scanRoot: HOME });
}

describe("inventory membership — one structure answers per class", () => {
  const inv = () => createProtectedTargetInventory({ home: HOME, scanRoot: HOME });

  it("resolves a home credential to its target class and credential arm", () => {
    const entry = inv().protectedTargetFor(join(HOME, ".ssh", "id_ed25519"));
    assert.ok(entry);
    assert.equal(entry.targetClass, "ssh_key_material");
    assert.equal(entry.arm, "credential");
  });

  it("resolves a cloud credential file", () => {
    const entry = inv().protectedTargetFor(join(HOME, ".aws", "credentials"));
    assert.ok(entry);
    assert.equal(entry.targetClass, "cloud_credential");
    assert.equal(entry.arm, "credential");
  });

  it("answers the more specific class when exact and subtree overlap", () => {
    // /etc is a read-only system subtree, but /etc/passwd is its own class.
    const entry = inv().protectedTargetFor("/etc/passwd");
    assert.ok(entry);
    assert.equal(entry.targetClass, "system_identity_file");
    assert.equal(entry.arm, "filesystem");
  });

  it("answers the system read-only class for a binary below /usr", () => {
    const entry = inv().protectedTargetFor("/usr/bin/ls");
    assert.ok(entry);
    assert.equal(entry.targetClass, "system_readonly_tree");
    assert.equal(entry.arm, "filesystem");
  });

  it("protects the dotted stem family and extension families under home", () => {
    for (const path of [
      join(HOME, ".env"),
      join(HOME, ".env.local"),
      join(HOME, "config", "app.env"),
    ]) {
      const entry = inv().protectedTargetFor(path);
      assert.ok(entry, `${path} must be protected`);
      assert.equal(entry.targetClass, "dotenv_file");
    }
    for (const path of [
      join(HOME, "certs", "server.pem"),
      join(HOME, "secrets", "tls.key"),
      join(HOME, "store", "bundle.p12"),
    ]) {
      assert.equal(
        inv().protectedTargetFor(path)?.targetClass,
        "tls_key_material"
      );
    }
  });

  it("protects bare key basenames anywhere under the resolved home", () => {
    assert.equal(
      inv().protectedTargetFor(join(HOME, "id_rsa"))?.targetClass,
      "ssh_key_material"
    );
    assert.equal(
      inv().protectedTargetFor(join(HOME, ".ssh", "id_ed25519"))?.targetClass,
      "ssh_key_material"
    );
  });

  it("protects the process environ credential", () => {
    const entry = inv().protectedTargetFor("/proc/self/environ");
    assert.ok(entry);
    assert.equal(entry.targetClass, "process_environ");
    assert.equal(entry.arm, "credential");
  });

  it("leaves ordinary paths and the home root itself unprotected", () => {
    assert.equal(inv().isProtected(join(HOME, "src", "app.ts")), false);
    assert.equal(inv().isProtected(HOME), false);
    assert.equal(inv().isProtected(join(HOME + "-sibling", ".ssh")), false);
  });

  it("compares on resolved targets: ~, $HOME and trailing slashes agree", () => {
    const invInstance = inv();
    assert.equal(invInstance.isProtected("~/.ssh/config"), true);
    assert.equal(invInstance.isProtected("$HOME/.netrc"), true);
    assert.equal(invInstance.isProtected(join(HOME, ".kube") + "/"), true);
    assert.equal(invInstance.isProtected(join(HOME, "x..", ".aws")), false);
  });
});

describe("inventory arms — credential sources are one arm of one structure", () => {
  const inv = fixture;

  it("carries both arms in the single entries array", () => {
    const arms = new Set(inv().entries.map((e) => e.arm));
    assert.ok(arms.has("credential"));
    assert.ok(arms.has("filesystem"));
  });

  it("answers the credential arm through the same query as every target", () => {
    const hit = inv().protectedTargetFor(
      join(HOME, ".config", "gh", "hosts.yml")
    );
    assert.equal(hit?.arm, "credential");
    assert.equal(hit?.targetClass, "github_cli_credential");
    const miss = inv().protectedTargetFor("/usr/share/doc/readme");
    assert.equal(miss?.arm, "filesystem");
  });
});

describe("inventory seeding — covers what the product already protects by name", () => {
  // The shell roster is a command-text fragment list; each arm here is the
  // resolved-path equivalent of that fragment, asserted protected by the
  // inventory. Keys are the exact fragment strings from hard-walls.ts.
  const rosterEquivalent = new Map<string, (home: string) => string>([
    [".ssh/", (h) => join(h, ".ssh", "config")],
    [".ssh\\\\", (h) => join(h, ".ssh", "known_hosts")],
    ["\\.ssh$", (h) => join(h, ".ssh")],
    [".aws/", (h) => join(h, ".aws", "credentials")],
    ["\\.aws$", (h) => join(h, ".aws")],
    [".gnupg/", (h) => join(h, ".gnupg", "private-keys-v1.d", "k.key")],
    ["\\.gnupg$", (h) => join(h, ".gnupg")],
    [".config/gh/", (h) => join(h, ".config", "gh", "hosts.yml")],
    ["\\.config/gh$", (h) => join(h, ".config", "gh")],
    ["\\.kube/", (h) => join(h, ".kube", "config")],
    ["\\.kube$", (h) => join(h, ".kube")],
    [".docker/config.json", (h) => join(h, ".docker", "config.json")],
    [".netrc", (h) => join(h, ".netrc")],
    ["\\.env$", (h) => join(h, ".env")],
    ["\\.env\\.", (h) => join(h, "secrets", ".env.production")],
    ["\\.pem$", (h) => join(h, "certs", "server.pem")],
    ["\\.key$", (h) => join(h, "secrets", "tls.key")],
    ["\\.p12$", (h) => join(h, "store", "bundle.p12")],
    ["id_rsa", (h) => join(h, ".ssh", "id_rsa")],
    ["id_ed25519", (h) => join(h, ".ssh", "id_ed25519")],
    ["/etc/passwd", () => "/etc/passwd"],
    ["/etc/shadow", () => "/etc/shadow"],
    ["/proc/self/environ", () => "/proc/self/environ"],
  ]);

  it("pins every roster fragment to a resolved-path equivalent (no silent gaps)", () => {
    for (const fragment of SENSITIVE_PATH_FRAGMENTS) {
      assert.ok(
        rosterEquivalent.has(fragment),
        `roster fragment ${JSON.stringify(fragment)} has no resolved-path equivalent pinned`
      );
    }
    assert.equal(rosterEquivalent.size, SENSITIVE_PATH_FRAGMENTS.length);
  });

  it("denies membership for every roster-equivalent resolved path", () => {
    const inv = createProtectedTargetInventory({ home: HOME, scanRoot: HOME });
    for (const [fragment, build] of rosterEquivalent) {
      assert.equal(
        inv.isProtected(build(HOME)),
        true,
        `roster fragment ${JSON.stringify(fragment)} must have a protected resolved target`
      );
    }
  });

  it("denies membership for every system read-only prefix and its children", () => {
    const inv = createProtectedTargetInventory({ home: HOME, scanRoot: HOME });
    for (const prefix of [
      ...READ_ONLY_SYSTEM_PATHS,
      ...OPTIONAL_HOST_RO_PREFIXES,
    ]) {
      assert.equal(
        inv.isProtected(prefix),
        true,
        `${prefix} must be protected`
      );
      assert.equal(inv.isProtected(join(prefix, "sub", "file")), true);
    }
  });
});

describe("inventory assembly — empty / blank targets fail loud (SC7a)", () => {
  it("rejects a blank or empty home as a typed error", () => {
    for (const home of ["", "   ", "\t"]) {
      assert.throws(
        () => createProtectedTargetInventory({ home }),
        (err: unknown) =>
          err instanceof ToolExecutionError &&
          /home is blank/.test(err.message),
        `home ${JSON.stringify(home)} must throw typed`
      );
    }
  });

  it("rejects an empty or blank extra target as a typed error, never a drop", () => {
    for (const path of ["", "  ", "\n"]) {
      assert.throws(
        () =>
          createProtectedTargetInventory({
            home: HOME,
            extraTargets: [
              { targetClass: "operator_backup", arm: "credential", path },
            ],
          }),
        (err: unknown) =>
          err instanceof ToolExecutionError &&
          /protected-targets:/.test(err.message),
        `extra target ${JSON.stringify(path)} must throw typed`
      );
    }
  });

  it("rejects a blank membership query instead of answering unprotected", () => {
    const inv = fixture();
    for (const path of ["", "  "]) {
      assert.throws(
        () => inv.protectedTargetFor(path),
        ToolExecutionError,
        `blank query ${JSON.stringify(path)} must throw typed`
      );
    }
  });

  it("a rejected assembly builds nothing — no half-formed inventory survives", () => {
    assert.throws(
      () =>
        createProtectedTargetInventory({
          home: HOME,
          scanRoot: HOME,
          extraTargets: [{ targetClass: "x", arm: "filesystem", path: "" }],
        }),
      ToolExecutionError
    );
    // A clean rebuild after the fault is unaffected (no shared mutable state).
    const inv = createProtectedTargetInventory({ home: HOME, scanRoot: HOME });
    assert.equal(inv.isProtected(join(HOME, ".ssh", "id_rsa")), true);
  });
});

describe("resolved ro-bind token builder — never a half-formed pair", () => {
  it("emits only complete --ro-bind triples with non-empty resolved paths", () => {
    const tokens = protectedTargetRoBindArgs(fixture());
    assert.ok(tokens.length > 0);
    assert.equal(tokens.length % 3, 0);
    for (let i = 0; i < tokens.length; i += 3) {
      assert.equal(tokens[i], "--ro-bind");
      assert.ok((tokens[i + 1] ?? "").trim().length > 0);
      assert.equal(tokens[i + 1], tokens[i + 2]);
    }
    assert.ok(!tokens.includes(""));
  });

  it("binds subtree and exact targets; name-pattern arms carry no bind path", () => {
    const tokens = protectedTargetRoBindArgs(fixture());
    assert.ok(tokens.includes(join(HOME, ".ssh")));
    assert.ok(tokens.includes(join(HOME, ".docker", "config.json")));
    assert.ok(tokens.includes("/etc"));
    // suffix/basename arms cannot be a single mount source — the mount layer
    // must not see a fabricated one.
    assert.ok(!tokens.some((t) => t.endsWith("id_rsa") || t.endsWith(".pem")));
  });
});
