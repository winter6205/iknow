/**
 * Tests for `egress/ca-store.ts` — the CA persistence layer and the
 * trust-chain assembly face (specs/egress-credential-sentinel.md,
 * Assumptions 4/11).
 *
 * Pinned invariants:
 *   - the persistent CA lands in the injected directory, dir 0700 / key 0600
 *     (Assumption 4);
 *   - permission mismatch / validateCaPair failure / half a pair → refuse +
 *     warning trace + regenerate; after regeneration the session can load
 *     (createMitmCA succeeds);
 *   - trust bundle = CA cert + regular roots concatenated, CERTIFICATE blocks
 *     only, never a PRIVATE KEY block (the PEM-filter lesson from mitm-ca.js);
 *   - the CA private-key path never appears in any bind-table output;
 *   - warning traces carry only modes/filenames, never PEM material;
 *   - the per-client trust-name roster constants are in place (gh/Go →
 *     SSL_CERT_FILE, git → GIT_SSL_CAINFO, curl → CURL_CA_BUNDLE) and each is
 *     a member of the package CA_TRUST_VARS roster.
 *
 * Every case injects a temp directory and never touches the real ~/.config.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLIENT_TRUST_VARS,
  defaultEgressCaDir,
  egressCaBindSources,
  ensurePersistentCa,
  loadEgressCa,
} from "../../../src/harness/sandbox/egress/ca-store.js";
import {
  CA_TRUST_VARS,
  generateCa,
  validateCaPair,
} from "../../../src/harness/sandbox/egress/upstream.js";

const CERT_FILE = "cert.pem";
const KEY_FILE = "key.pem";

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

function certBlocks(pem: string): string[] {
  return (
    pem.match(
      /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g
    ) ?? []
  );
}

let caDir: string;

beforeEach(() => {
  caDir = mkdtempSync(join(tmpdir(), "iknow-ca-store-"));
});

afterEach(() => {
  rmSync(caDir, { recursive: true, force: true });
});

describe("defaultEgressCaDir", () => {
  it("resolves the spec-pinned ~/.config/iknow/egress-mitm-ca under a given home", () => {
    expect(defaultEgressCaDir("/home/tester")).toBe(
      "/home/tester/.config/iknow/egress-mitm-ca"
    );
  });
});

describe("ensurePersistentCa", () => {
  it(
    "generates a fresh CA pair with dir 0700 / key 0600 and a valid pair",
    { timeout: 60_000 },
    () => {
      const state = ensurePersistentCa({ caDir });
      expect(state.action).toBe("generated");
      expect(state.notice).toBeNull();
      expect(state.certPath).toBe(join(caDir, CERT_FILE));
      expect(state.keyPath).toBe(join(caDir, KEY_FILE));
      expect(modeOf(caDir)).toBe(0o700);
      expect(modeOf(state.keyPath)).toBe(0o600);
      const validation = validateCaPair(
        readFileSync(state.certPath, "utf8"),
        readFileSync(state.keyPath, "utf8")
      );
      expect(validation.ok).toBe(true);
    }
  );

  it(
    "loads an existing valid pair untouched on the next call",
    { timeout: 60_000 },
    () => {
      const first = ensurePersistentCa({ caDir });
      const keyBefore = readFileSync(first.keyPath, "utf8");
      const second = ensurePersistentCa({ caDir });
      expect(second.action).toBe("loaded");
      expect(second.notice).toBeNull();
      expect(readFileSync(second.keyPath, "utf8")).toBe(keyBefore);
    }
  );

  it(
    "refuses and regenerates when key file permission is too broad, then reloadable",
    { timeout: 60_000 },
    () => {
      const first = ensurePersistentCa({ caDir });
      const keyBefore = readFileSync(first.keyPath, "utf8");
      chmodSync(first.keyPath, 0o644);

      const second = ensurePersistentCa({ caDir });
      expect(second.action).toBe("regenerated");
      expect(second.notice?.kind).toBe("ca_permissions");
      expect(modeOf(second.keyPath)).toBe(0o600);
      expect(readFileSync(second.keyPath, "utf8")).not.toBe(keyBefore);
      expect(
        validateCaPair(
          readFileSync(second.certPath, "utf8"),
          readFileSync(second.keyPath, "utf8")
        ).ok
      ).toBe(true);
    }
  );

  it(
    "refuses and regenerates when the CA directory mode is too broad",
    { timeout: 60_000 },
    () => {
      const first = ensurePersistentCa({ caDir });
      chmodSync(caDir, 0o755);

      const second = ensurePersistentCa({ caDir });
      expect(second.action).toBe("regenerated");
      expect(second.notice?.kind).toBe("ca_permissions");
      expect(modeOf(caDir)).toBe(0o700);
    }
  );

  it(
    "regenerates on a mismatched cert/key pair and warns with the validation reason",
    { timeout: 60_000 },
    () => {
      const a = generateCa({ cn: "iknow ca-store test A" });
      const b = generateCa({ cn: "iknow ca-store test B" });
      writeFileSync(join(caDir, CERT_FILE), a.certPem, { mode: 0o600 });
      writeFileSync(join(caDir, KEY_FILE), b.keyPem, { mode: 0o600 });

      const state = ensurePersistentCa({ caDir });
      expect(state.action).toBe("regenerated");
      expect(state.notice?.kind).toBe("ca_pair_invalid");
      expect(
        validateCaPair(
          readFileSync(state.certPath, "utf8"),
          readFileSync(state.keyPath, "utf8")
        ).ok
      ).toBe(true);
    }
  );

  it(
    "regenerates on a half-missing pair (key deleted) with an incomplete notice",
    { timeout: 60_000 },
    () => {
      const first = ensurePersistentCa({ caDir });
      unlinkSync(first.keyPath);

      const second = ensurePersistentCa({ caDir });
      expect(second.action).toBe("regenerated");
      expect(second.notice?.kind).toBe("ca_pair_incomplete");
      expect(
        validateCaPair(
          readFileSync(second.certPath, "utf8"),
          readFileSync(second.keyPath, "utf8")
        ).ok
      ).toBe(true);
    }
  );

  it(
    "notices carry only modes/filenames, never PEM or key material",
    { timeout: 60_000 },
    () => {
      const first = ensurePersistentCa({ caDir });
      chmodSync(first.keyPath, 0o666);
      const second = ensurePersistentCa({ caDir });
      const rendered = JSON.stringify(second.notice);
      expect(rendered).not.toContain("BEGIN");
      expect(rendered).not.toContain("PRIVATE KEY");
      expect(rendered).not.toContain(readFileSync(second.keyPath, "utf8"));
    }
  );

  it(
    "creates a nested missing directory with 0700 mode",
    { timeout: 60_000 },
    () => {
      const nested = join(caDir, "deep", "egress-mitm-ca");
      const state = ensurePersistentCa({ caDir: nested });
      expect(state.action).toBe("generated");
      expect(modeOf(nested)).toBe(0o700);
    }
  );
});

describe("loadEgressCa (session装载面)", () => {
  it(
    "after permission-triggered regeneration the session can load the CA",
    { timeout: 60_000 },
    () => {
      const first = ensurePersistentCa({ caDir });
      chmodSync(first.keyPath, 0o644);

      const load = loadEgressCa({ caDir });
      expect(load.state.action).toBe("regenerated");
      expect(load.state.notice?.kind).toBe("ca_permissions");
      expect(load.ca.certPath).toBe(join(caDir, CERT_FILE));
      expect(load.ca.keyPath).toBe(join(caDir, KEY_FILE));
      // loaded from the persistent disk → the package must not treat it as a temp ephemeral CA (dispose won't delete the persistent dir)
      expect(load.ca.ephemeral).toBe(false);
      expect(modeOf(load.ca.keyPath)).toBe(0o600);
      rmSync(load.ca.trustBundlePath, { force: true });
    }
  );
});

describe("trust bundle 内容（每次 createMitmCA 现写）", () => {
  it(
    "bundle contains the proxy CA + regular roots and NO private key blocks",
    { timeout: 60_000 },
    () => {
      const { ca } = loadEgressCa({ caDir });
      const bundle = readFileSync(ca.trustBundlePath, "utf8");
      const caBlocks = certBlocks(ca.certPem);
      expect(caBlocks.length).toBe(1);
      // includes the proxy CA
      expect(bundle).toContain(caBlocks[0]);
      // includes the regular roots (block count strictly greater than proxy-CA alone)
      expect(certBlocks(bundle).length).toBeGreaterThan(caBlocks.length);
      // never a PRIVATE KEY block (prevents copying one into a world-readable bundle)
      expect(bundle).not.toContain("PRIVATE KEY");
      rmSync(ca.trustBundlePath, { force: true });
    }
  );

  it(
    "each createMitmCA call writes a fresh bundle file (per-session 现写)",
    { timeout: 60_000 },
    () => {
      const first = loadEgressCa({ caDir });
      const second = loadEgressCa({ caDir });
      expect(second.ca.trustBundlePath).not.toBe(first.ca.trustBundlePath);
      rmSync(first.ca.trustBundlePath, { force: true });
      rmSync(second.ca.trustBundlePath, { force: true });
    }
  );
});

describe("egressCaBindSources (SC8 测试钉)", () => {
  it(
    "CA private key path never appears in any bind-table source",
    { timeout: 60_000 },
    () => {
      const { ca } = loadEgressCa({ caDir });
      const sources = egressCaBindSources(ca).map((b) => b.src);
      expect(sources).toContain(ca.trustBundlePath);
      expect(sources).not.toContain(ca.keyPath);
      for (const s of sources) {
        expect(s).not.toContain(KEY_FILE);
      }
      rmSync(ca.trustBundlePath, { force: true });
    }
  );
});

describe("CLIENT_TRUST_VARS 名册常量", () => {
  it("pins gh/Go, git and curl to their spec-listed trust vars", () => {
    expect(CLIENT_TRUST_VARS.gh).toBe("SSL_CERT_FILE");
    expect(CLIENT_TRUST_VARS.git).toBe("GIT_SSL_CAINFO");
    expect(CLIENT_TRUST_VARS.curl).toBe("CURL_CA_BUNDLE");
  });

  it("every pinned var is a member of the package CA_TRUST_VARS roster", () => {
    for (const v of Object.values(CLIENT_TRUST_VARS)) {
      expect(CA_TRUST_VARS).toContain(v);
    }
  });
});
