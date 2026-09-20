/**
 * tests/harness/sandbox/egress-credential-mint.test.ts
 *
 * specs/egress-credential-sentinel.md — startup-time credential minting unit tests.
 *
 * Pinned invariants:
 *   - registry idempotence / long-value padding (package credential-sentinel.js:
 *     re-registering the same name is idempotent; when the real value is
 *     longer, the sentinel is padded to equal byte length);
 *     MaskedFileStore.write is idempotent per key (no new file leaked on
 *     every call);
 *   - GH_TOKEN whole-value: env fake value = `fake_value_<uuid4>` inside the
 *     registry's fake space; the real literal ∉ (fence env ∪ bind src
 *     contents) (invariant 1);
 *   - hosts.yml structured extract: the fake file keeps all other YAML bytes,
 *     only the captured segment is swapped;
 *   - JWT isomorph fake value (decode:"jwt" → registerWithSentinel
 *     caller-minted, package credential-decode.js);
 *   - env value absent / empty string → skip entry + debug trace, never
 *     inject an empty fake value;
 *   - credential file absent / is a directory → skip + trace, no hard error;
 *   - Assumption 8: non-UTF-8 binary, or extract miss → always degrade to
 *     deny: `/dev/null` overlay bind + a typed violation trace carrying fix
 *     guidance; the criterion = deny overlay present in the bind table and no
 *     masked overlay, i.e. the assembly-layer equivalent of "this path is
 *     unreadable inside the fence";
 *   - invariant 6: sentinel substring-contract violation = typed
 *     EgressCredentialMintError;
 *   - Assumption 11: the env delta includes all CA_TRUST_VARS with value =
 *     trust bundle path;
 *   - bind content sources come only from the fake side (fake files / store
 *     dir / trust bundle / /dev/null); the CA key path never enters the
 *     table.
 *
 * All fixtures are generated fake credentials; host real values / .env* enter
 * no input and no assertion.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  assertInjectedEnvInFakeSpace,
  assertSentinelSubstringContract,
  EgressCredentialMintError,
  mintEgressCredentials,
  type EgressCredentialMint,
} from "../../../src/harness/sandbox/egress/credential-mint.js";
import type { EgressCredentialRoster } from "../../../src/harness/sandbox/egress/credential-assembly.js";
import {
  CA_TRUST_VARS,
  generateCa,
  MaskedFileStore,
  SentinelRegistry,
  type MitmCA,
} from "../../../src/harness/sandbox/egress/upstream.js";
import {
  CLIENT_TRUST_VARS,
  loadEgressCa,
} from "../../../src/harness/sandbox/egress/ca-store.js";

const scratch: string[] = [];
const mints: EgressCredentialMint[] = [];

function scratchDir(): string {
  const d = mkdtempSync(join(tmpdir(), "iknow-cred-mint-test-"));
  scratch.push(d);
  return d;
}

/** Mint and register (one shared dispose in afterEach keeps fake store dirs from littering /tmp). */
function mintTracked(
  args: Parameters<typeof mintEgressCredentials>[0]
): EgressCredentialMint {
  const m = mintEgressCredentials(args);
  mints.push(m);
  return m;
}

afterEach(() => {
  for (const m of mints.splice(0)) m.store.dispose();
  for (const p of scratch.splice(0))
    rmSync(p, { recursive: true, force: true });
});

/** A generated fake credential (never a real value). */
function fakeToken(): string {
  return `gho_FAKE${randomBytes(16).toString("hex")}`;
}

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

/** Generated isomorph fake-JWT fixture (HS256 header + junk signature, passes verifyJwt structural checks). */
function fixtureJwt(sub: string): string {
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub, exp: 9999999999 })}.${b64url("fixture-signature")}`;
}

/** Test MitmCA stand-in: mint consumes only trustBundlePath / egressCaBindSources. */
function fakeCa(): MitmCA {
  const dir = scratchDir();
  const bundlePath = join(dir, "trust-bundle.pem");
  writeFileSync(
    bundlePath,
    "-----BEGIN CERTIFICATE-----\nZmFrZQo=\n-----END CERTIFICATE-----\n"
  );
  return {
    trustBundlePath: bundlePath,
    keyPath: join(dir, "ca-key-should-never-bind.pem"),
    certPath: join(dir, "cert.pem"),
  } as unknown as MitmCA;
}

function rosterOf(
  partial: Partial<EgressCredentialRoster>
): EgressCredentialRoster {
  return { files: [], envVars: [], ...partial };
}

const HOSTS = ["github.com", "*.github.com"] as const;

describe("包件原语（经 upstream 收口）：铸造幂等 / 长值配平", () => {
  it("register 同名幂等：二次调用返回同一 sentinel", () => {
    const registry = new SentinelRegistry();
    const s1 = registry.register("GH_TOKEN", fakeToken(), [...HOSTS]);
    const s2 = registry.register("GH_TOKEN", fakeToken(), [...HOSTS]);
    assert.equal(s1, s2);
    assert.equal(registry.size, 1);
  });

  it("长值配平：真值更长时 sentinel 补 pad 到等字节长；短值保持 47 基长", () => {
    const registry = new SentinelRegistry();
    const long = fakeToken().repeat(4); // > 47 bytes
    const sentinel = registry.register("LONG", long, [...HOSTS]);
    assert.equal(Buffer.byteLength(sentinel), Buffer.byteLength(long));
    assert.ok(sentinel.startsWith("fake_value_"));
    const shortRegistry = new SentinelRegistry();
    const base = shortRegistry.register("SHORT", "abc", [...HOSTS]);
    assert.equal(base.length, "fake_value_".length + 36);
  });

  it("MaskedFileStore.write 同 key 幂等：同一路径、内容重写", () => {
    const store = new MaskedFileStore();
    try {
      const p1 = store.write("file:/x", "fake_value_a");
      const p2 = store.write("file:/x", "fake_value_b");
      assert.equal(p1, p2);
      assert.equal(readFileSync(p2, "utf8"), "fake_value_b");
    } finally {
      store.dispose();
    }
  });
});

describe("env 条目铸造（whole-value，F1 / invariant 1）", () => {
  it("GH_TOKEN 在场 → 假值 = fake_value_<uuid4> ∈ registry；真值 ∉ envVars", () => {
    const real = fakeToken();
    const mint = mintTracked({
      roster: rosterOf({
        envVars: [{ name: "GH_TOKEN", injectHosts: [...HOSTS] }],
      }),
      ca: fakeCa(),
      env: { GH_TOKEN: real },
    });
    const fake = mint.envVars.GH_TOKEN;
    assert.match(fake ?? "", /^fake_value_[0-9a-f-]{36}$/);
    const pairs = [...mint.registry.entries()];
    assert.equal(pairs.length, 1);
    assert.deepEqual(pairs[0], [fake, real]);
    // env half of the real-value-absence pin: the real literal enters no injected env value.
    for (const v of Object.values(mint.envVars)) assert.ok(!v.includes(real));
  });

  it("F1：真值 env 缺席 / 空串 → 跳过条目 + debug 痕，不注入空假值", () => {
    for (const env of [{}, { GH_TOKEN: "" }]) {
      const traces: string[] = [];
      const mint = mintTracked({
        roster: rosterOf({
          envVars: [{ name: "GH_TOKEN", injectHosts: [...HOSTS] }],
        }),
        ca: fakeCa(),
        env,
        onDebug: (m) => traces.push(m),
      });
      assert.equal(mint.envVars.GH_TOKEN, undefined);
      assert.equal(mint.registry.size, 0);
      assert.ok(
        traces.some((t) => t.includes("GH_TOKEN") && t.includes("skipped"))
      );
    }
  });

  it("Assumption 11：CA_TRUST_VARS 全量注入且值 = trust bundle；三臂常量 ⊆ 名册", () => {
    const ca = fakeCa();
    const mint = mintTracked({ roster: rosterOf({}), ca, env: {} });
    for (const name of CA_TRUST_VARS) {
      assert.equal(mint.envVars[name], ca.trustBundlePath);
    }
    for (const arm of Object.values(CLIENT_TRUST_VARS)) {
      assert.ok((CA_TRUST_VARS as readonly string[]).includes(arm));
    }
  });
});

describe("文件条目铸造（structured / JWT / F2 / F3）", () => {
  it("hosts.yml structured extract：假文件只换捕获段、其余字节保留", () => {
    const dir = scratchDir();
    const real = fakeToken();
    const hostsPath = join(dir, "hosts.yml");
    writeFileSync(
      hostsPath,
      `github.com:\n  oauth_token: ${real}\n  git_protocol: https\n`
    );
    const mint = mintTracked({
      roster: rosterOf({
        files: [
          {
            path: hostsPath,
            extract: "oauth_token:\\s*(\\S+)",
            injectHosts: [...HOSTS],
          },
        ],
      }),
      ca: fakeCa(),
      env: {},
    });
    const bind = mint.binds.find((b) => b.dest === hostsPath);
    assert.ok(bind, "masked bind（dest=真路径）在场");
    assert.notEqual(bind.src, hostsPath, "bind src = fake 文件而非真值文件");
    assert.ok(bind.src.startsWith(`${mint.store.dirPath}/`));
    const fakeBody = readFileSync(bind.src, "utf8");
    assert.match(fakeBody, /oauth_token: fake_value_[0-9a-f-]{36}/);
    assert.ok(fakeBody.includes("git_protocol: https"), "其余字节逐字保留");
    assert.ok(!fakeBody.includes(real), "真值不进 fake 文件（SC1）");
    // sentinel key = file:<resolved>#0 → the registry holds the fake→real one-way map.
    const pairs = new Map(mint.registry.entries());
    assert.equal([...pairs.values()][0], real);
  });

  it("JWT decode 条目 → 同形假值（三段 eyJ… 结构、payload 携带 fake 身份）", () => {
    const dir = scratchDir();
    const real = fixtureJwt("real-user-998877");
    const tokenPath = join(dir, "token.jwt");
    writeFileSync(tokenPath, `bearer ${real}\n`);
    const mint = mintTracked({
      roster: rosterOf({
        files: [{ path: tokenPath, decode: "jwt", injectHosts: [...HOSTS] }],
      }),
      ca: fakeCa(),
      env: {},
    });
    const bind = mint.binds.find((b) => b.dest === tokenPath);
    assert.ok(bind);
    const fakeBody = readFileSync(bind.src, "utf8");
    const fakeTokenMatch = fakeBody.match(
      /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/
    );
    assert.ok(fakeTokenMatch, "假文件仍是 JWT 形态（客户端解析不炸）");
    assert.notEqual(fakeTokenMatch[0], real);
    assert.ok(!fakeBody.includes(real), "真 JWT ∉ 假文件（SC1）");
    const payload = JSON.parse(
      Buffer.from(fakeTokenMatch[0].split(".")[1], "base64url").toString("utf8")
    ) as { sub?: string };
    assert.match(
      payload.sub ?? "",
      /^fake_value_/,
      "sentinel 身份嵌在假 JWT 内"
    );
    // the registry stores the caller-minted isomorph fake → real JWT pair (fake→real, one way).
    assert.equal(mint.registry.lookupReal(fakeTokenMatch[0]), real);
  });

  it("F2：文件不存在 / 是目录 → 跳过条目 + debug 痕，不硬错、不 deny", () => {
    const dir = scratchDir();
    const missing = join(dir, "absent.yml");
    const traces: string[] = [];
    const mint = mintTracked({
      roster: rosterOf({
        files: [
          {
            path: missing,
            extract: "oauth_token:\\s*(\\S+)",
            injectHosts: [...HOSTS],
          },
          {
            path: dir,
            extract: "oauth_token:\\s*(\\S+)",
            injectHosts: [...HOSTS],
          },
        ],
      }),
      ca: fakeCa(),
      env: {},
      onDebug: (m) => traces.push(m),
    });
    assert.equal(mint.denyTraces.length, 0, "F2 是不可达不是违例，不 deny");
    assert.ok(traces.some((t) => t.includes(missing)));
    assert.ok(traces.some((t) => t.includes(dir)));
    assert.equal(
      mint.binds.find((b) => b.dest === missing),
      undefined
    );
  });

  it("F3（Assumption 8）：非 UTF-8 二进制 → 降级 deny + typed 痕含修复指引，不 fail-open", () => {
    const dir = scratchDir();
    const binPath = join(dir, "blob.cred");
    writeFileSync(binPath, Buffer.from([0xff, 0xfe, 0x01, 0x80, 0x41]));
    const warns: string[] = [];
    const mint = mintTracked({
      roster: rosterOf({ files: [{ path: binPath, injectHosts: [...HOSTS] }] }),
      ca: fakeCa(),
      env: {},
      onWarn: (m) => warns.push(m),
    });
    const trace = mint.denyTraces.find((t) => t.path === binPath);
    assert.ok(trace, "typed 违例痕在场");
    assert.equal(trace.kind, "credential_mask_denied");
    assert.match(trace.reason, /non-UTF-8[\s\S]*Fix:/, "含修复指引");
    assert.ok(warns.length > 0, "禁静默（invariant 7）");
    // criterion = bind table: deny overlay present + no masked overlay (the assembly-layer equivalent of "unreadable inside the fence").
    assert.deepEqual(
      mint.binds.find((b) => b.dest === binPath),
      {
        src: "/dev/null",
        dest: binPath,
        readonly: true,
      }
    );
    assert.equal(mint.registry.size, 0, "包 fail-open 路径未被吃到");
  });

  it("F3（Assumption 8）：extract 未命中 → 降级 deny + typed 痕，不吃包 warn-and-include", () => {
    const dir = scratchDir();
    const noMatch = join(dir, "hosts.yml");
    writeFileSync(noMatch, "github.com:\n  git_protocol: https\n");
    const mint = mintTracked({
      roster: rosterOf({
        files: [
          {
            path: noMatch,
            extract: "oauth_token:\\s*(\\S+)",
            injectHosts: [...HOSTS],
          },
        ],
      }),
      ca: fakeCa(),
      env: {},
      onWarn: () => {},
    });
    const trace = mint.denyTraces.find((t) => t.path === noMatch);
    assert.ok(trace);
    assert.match(trace.reason, /extract[\s\S]*Fix:/);
    assert.deepEqual(
      mint.binds.find((b) => b.dest === noMatch),
      {
        src: "/dev/null",
        dest: noMatch,
        readonly: true,
      }
    );
  });

  it("SC1/SC8 全集：真值字面 ∉（fence env ∪ bind src 内容）；bind src 只来自 fake 侧", () => {
    const dir = scratchDir();
    const realEnv = fakeToken();
    const realFile = fakeToken();
    const hostsPath = join(dir, "hosts.yml");
    writeFileSync(hostsPath, `github.com:\n  oauth_token: ${realFile}\n`);
    const ca = fakeCa();
    const mint = mintTracked({
      roster: rosterOf({
        envVars: [{ name: "GH_TOKEN", injectHosts: [...HOSTS] }],
        files: [
          {
            path: hostsPath,
            extract: "oauth_token:\\s*(\\S+)",
            injectHosts: [...HOSTS],
          },
        ],
      }),
      ca,
      env: { GH_TOKEN: realEnv },
    });
    const storeDir = mint.store.dirPath;
    assert.ok(storeDir);
    const visible = [
      ...Object.values(mint.envVars),
      ...mint.binds.map((b) => {
        try {
          return readFileSync(b.src, "utf8");
        } catch {
          return "";
        }
      }),
    ];
    for (const secret of [realEnv, realFile]) {
      for (const surface of visible)
        assert.ok(!surface.includes(secret), "真值字面不进围栏可见面（SC1）");
    }
    for (const b of mint.binds) {
      assert.ok(
        b.src === "/dev/null" ||
          b.src === storeDir ||
          b.src === ca.trustBundlePath ||
          b.src.startsWith(`${storeDir}/`),
        `bind src 落 fake 侧：${b.src}`
      );
      // The CA key path never appears in any bind (consumer-side surface).
      assert.notEqual(b.src, ca.keyPath);
      assert.notEqual(b.dest, ca.keyPath);
    }
  });
});

describe("装配期防线（F4 / invariant 1）", () => {
  it("子串契约：嵌套假值 → typed EgressCredentialMintError（不起部分代换 session）", () => {
    const registry = new SentinelRegistry();
    registry.registerWithSentinel("A", "fake_value_aaa", "real-a", [...HOSTS]);
    registry.registerWithSentinel("B", "pre_fake_value_aaa_post", "real-b", [
      ...HOSTS,
    ]);
    let err: unknown;
    try {
      assertSentinelSubstringContract(registry);
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof EgressCredentialMintError);
    assert.equal(err.kind, "sentinel_substring_contract");
    assert.match(err.message, /F4/);
  });

  it("子串契约：正常铸造不误报", () => {
    const registry = new SentinelRegistry();
    registry.register("A", fakeToken(), [...HOSTS]);
    registry.register("B", fakeToken().repeat(3), [...HOSTS]);
    assert.doesNotThrow(() => assertSentinelSubstringContract(registry));
  });

  it("invariant 1：注入 env 值 ∉ 假值空间（=真值直达）→ typed 失败", () => {
    const registry = new SentinelRegistry();
    const sentinel = registry.register("GH_TOKEN", "super-secret-real", [
      ...HOSTS,
    ]);
    assert.doesNotThrow(() =>
      assertInjectedEnvInFakeSpace({ GH_TOKEN: sentinel }, registry)
    );
    // structured form: a synthetic interpolated value containing the sentinel is likewise inside the fake space.
    assert.doesNotThrow(() =>
      assertInjectedEnvInFakeSpace(
        { URL: `postgres://${sentinel}@db` },
        registry
      )
    );
    let err: unknown;
    try {
      assertInjectedEnvInFakeSpace({ GH_TOKEN: "super-secret-real" }, registry);
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof EgressCredentialMintError);
    assert.equal(err.kind, "env_fake_space_contract");
    assert.ok(!err.message.includes("super-secret-real"), "错误信息不回显真值");
  });
});

describe("T4 持久层消费面（真装载）", () => {
  it("loadEgressCa 产物 → mint 出 trust bundle 自 bind + env 指向；key 不出表", () => {
    // The only case that really generates a CA (generateCa is a pure generator;
    // this checks the assembly shape; the permission/self-heal matrix belongs to
    // egress-ca-store.test.ts and is not repeated). Temp dir injected.
    const dir = scratchDir();
    const pair = generateCa({ cn: "mint-test ca" });
    writeFileSync(join(dir, "cert.pem"), pair.certPem, { mode: 0o600 });
    writeFileSync(join(dir, "key.pem"), pair.keyPem, { mode: 0o600 });
    const { ca } = loadEgressCa({ caDir: dir });
    const mint = mintTracked({ roster: rosterOf({}), ca, env: {} });
    assert.ok(
      mint.binds.some(
        (b) => b.src === ca.trustBundlePath && b.dest === ca.trustBundlePath
      )
    );
    assert.ok(
      !mint.binds.some((b) => b.src === ca.keyPath || b.dest === ca.keyPath),
      "CA key 路径不进 bind 表（SC8）"
    );
    assert.equal(mint.envVars.SSL_CERT_FILE, ca.trustBundlePath);
  });
});
