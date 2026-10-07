/**
 * tests/harness/sandbox/egress-bwrap-binds.test.ts
 *
 * specs/egress-credential-sentinel.md, invariant 9 — bwrap argv snapshot
 * pin: all credential-fence binds (masked store directory, trust bundle,
 * masked files over real paths, `/dev/null` overlays for denied entries)
 * land in the egressBind segment, ordered after workspaceMounts and before
 * cwdReadonly (last-mount-wins so they override the real paths under the
 * home ro-bind / root bind).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { createBwrapFence } from "../../../src/harness/sandbox/bwrap.js";
import { createFsPolicy } from "../../../src/harness/sandbox/fs-policy.js";
import type { EgressFenceSpec } from "../../../src/harness/sandbox/egress/session.js";
import type { EgressFenceBind } from "../../../src/harness/sandbox/egress/credential-mint.js";

const FIX_ROOT = mkdtempSync(join(homedir(), ".iknow-egress-binds-"));
const TASK = join(FIX_ROOT, "task");
const HOME = join(FIX_ROOT, "home");
const TMP = mkdtempSync(join(tmpdir(), "egress-binds-tmp-"));

beforeAll(() => {
  mkdirSync(TASK, { recursive: true });
  mkdirSync(HOME, { recursive: true });
});

afterAll(() => {
  rmSync(FIX_ROOT, { recursive: true, force: true });
  rmSync(TMP, { recursive: true, force: true });
});

const SOCKET = join(TMP, "iknow-egress-abc.sock");
const STORE_DIR = join(TMP, "srt-credmask-xyz");
const FAKE_FILE = join(STORE_DIR, "0.fake");
const BUNDLE = join(TMP, "srt-mitm-trust-bundle.pem");
const REAL_HOSTS = join(HOME, ".config", "gh", "hosts.yml");
const DENIED = join(HOME, ".config", "binary.cred");

function binds(): readonly EgressFenceBind[] {
  return [
    { src: FAKE_FILE, dest: REAL_HOSTS, readonly: true },
    { src: STORE_DIR, dest: STORE_DIR, readonly: true },
    { src: BUNDLE, dest: BUNDLE, readonly: true },
    { src: "/dev/null", dest: DENIED, readonly: true },
  ];
}

function fenceArgv(egress?: EgressFenceSpec): readonly string[] {
  return createBwrapFence({
    command: "bash",
    args: ["-c", "true"],
    fsPolicy: createFsPolicy({ tmpDir: TMP, mode: "workspace" }),
    env: { PATH: "/bin" },
    cwd: TASK,
    cwdReadonly: true,
    homeRoot: HOME,
    workspaceRoot: TASK,
    tmpRoot: TMP,
    ...(egress !== undefined ? { egress } : {}),
  }).argv;
}

/** Start index of the `--ro-bind src dest` triple. */
function findRoBind(
  argv: readonly string[],
  src: string,
  dest: string
): number {
  for (let i = 0; i + 2 < argv.length; i++) {
    if (argv[i] === "--ro-bind" && argv[i + 1] === src && argv[i + 2] === dest)
      return i;
  }
  return -1;
}

describe("createBwrapFence — 凭据 bind 段落位（invariant 9 / SC7 后半）", () => {
  it("binds 在场 → 四条 --ro-bind 全发射且落 egressBind 段位序", () => {
    const argv = fenceArgv({
      unixSocketPath: SOCKET,
      sandboxLocalPort: 3128,
      env: { HTTP_PROXY: "http://127.0.0.1:3128" },
      binds: binds(),
      innerBridgeScript: "",
      relayAssetsDir: "",
    });
    const masked = findRoBind(argv, FAKE_FILE, REAL_HOSTS);
    const store = findRoBind(argv, STORE_DIR, STORE_DIR);
    const bundle = findRoBind(argv, BUNDLE, BUNDLE);
    const deny = findRoBind(argv, "/dev/null", DENIED);
    for (const [label, idx] of [
      ["masked 盖行", masked],
      ["store 目录", store],
      ["trust bundle", bundle],
      ["deny /dev/null 盖行", deny],
    ] as const) {
      assert.ok(idx >= 0, `${label} 应发射 --ro-bind`);
    }
    // placement: after workspaceMounts (home ro-bind / task / tmp binds).
    const homeRo = findRoBind(argv, HOME, HOME);
    const socketSrcIdx = argv.indexOf(SOCKET);
    assert.ok(
      socketSrcIdx > 0 && argv[socketSrcIdx - 1] === "--bind",
      "socket --bind 在场"
    );
    assert.ok(homeRo >= 0, "workspace 档 home ro-bind 在场");
    // the whole masked-bind segment lands after the socket bind (socket leads within the segment).
    assert.ok(
      masked > socketSrcIdx && store > socketSrcIdx && bundle > socketSrcIdx
    );
    // the cwdReadonly `--ro-bind <cwd> <cwd>` lands after all egress binds (last in mount order).
    const cwdRo = findRoBind(argv, TASK, TASK);
    assert.ok(
      cwdRo > masked && cwdRo > store && cwdRo > bundle && cwdRo > deny
    );
  });

  it("binds 缺席 → argv 与既有基线一致（socket bind 照发，无额外 --ro-bind）", () => {
    const withBinds = fenceArgv({
      unixSocketPath: SOCKET,
      sandboxLocalPort: 3128,
      env: {},
      binds: binds(),
      innerBridgeScript: "",
      relayAssetsDir: "",
    });
    const without = fenceArgv({
      unixSocketPath: SOCKET,
      sandboxLocalPort: 3128,
      env: {},
      innerBridgeScript: "",
      relayAssetsDir: "",
    });
    assert.ok(without.includes("--bind"));
    assert.equal(without.includes(FAKE_FILE), false);
    assert.equal(without.includes(BUNDLE), false);
    assert.ok(withBinds.length > without.length, "binds 扩段只增不减");
  });
});
