/**
 * Tests for `egress/ca-store.ts` — T4 CA 持久层与信任链装配面
 * （specs/egress-credential-sentinel.md §T4 + F7 + SC8 + Assumption 4/11）。
 *
 * 钉住的不变式：
 *   - 持久 CA 落注入目录，目录 0700 / key 0600（Assumption 4）；
 *   - 权限不符 / validateCaPair 失败 / 半边 pair → 拒用 + 告警痕 + 重生成（F7），
 *     重生成后 session 可装载（createMitmCA 成功）；
 *   - trust bundle = CA 证书 + 常规根拼接，只含 CERTIFICATE 块，绝无 PRIVATE KEY
 *     （mitm-ca.js:166-175 的 PEM 过滤教训）；
 *   - SC8：CA 私钥路径不出现在任何 bind 表输出；
 *   - 告警痕只带模式/文件名，绝不带 PEM 材料；
 *   - 逐客户端信任名册常量（gh/Go → SSL_CERT_FILE、git → GIT_SSL_CAINFO、
 *     curl → CURL_CA_BUNDLE）就位且 ∈ 包 CA_TRUST_VARS 全集。
 *
 * 全部用例注入临时目录，不触碰真实 ~/.config。
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
      // 从持久盘装载 → 包不认为是 temp ephemeral CA（dispose 不删持久目录）
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
      // 含代理 CA
      expect(bundle).toContain(caBlocks[0]);
      // 含常规根（块数严格大于仅代理 CA）
      expect(certBlocks(bundle).length).toBeGreaterThan(caBlocks.length);
      // 绝无 PRIVATE KEY 块（防拷进 world-readable bundle）
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
