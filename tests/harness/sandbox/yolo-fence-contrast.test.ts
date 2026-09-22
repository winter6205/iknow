/**
 * ADR-0119 — physical contrast for the yolo probe parity: the **non-yolo**
 * route really goes through bwrap.
 *
 * Ported from the archived `scripts/sandbox-probe.ts` yolo category check 6
 * ("contrast — non-yolo verify route does go through bwrap"). Without this
 * arm, the parity file's "parent is not bwrap" assertion could be a false
 * green from asserting the wrong thing (e.g. /proc/$PPID/comm always
 * empty). Two arms run the same shape and differ only in the yolo reading:
 * non-yolo → parent is `bwrap` and the netns differs from the host's;
 * yolo → see tests/harness/sandbox/yolo-probe-parity.test.ts.
 *
 * Guard: real bwrap execution (same shape as ssh-key-fs-modes.test.ts's
 * `hasBwrap()`), registered in `vitest.ci-excludes.ts` — the CI test-full
 * runner installs bwrap but disallows user namespaces, so only local
 * WSL-style hosts certify this face physically.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { createBwrapFence } from "../../../src/harness/sandbox/bwrap.ts";
import { createFsPolicy } from "../../../src/harness/sandbox/fs-policy.ts";

function hasBwrap(): boolean {
  return spawnSync("bwrap", ["--version"], { stdio: "ignore" }).status === 0;
}

const CAN_EXEC =
  hasBwrap() && process.platform === "linux" && existsSync("/proc/self/ns/net");

const FIX_CWD = mkdtempSync(join(tmpdir(), "yolo-fence-contrast-cwd-"));
const FIX_TMP = mkdtempSync(join(tmpdir(), "yolo-fence-contrast-tmp-"));
const FIX_HOME = mkdtempSync(join(tmpdir(), "yolo-fence-contrast-home-"));

afterAll(() => {
  rmSync(FIX_CWD, { recursive: true, force: true });
  rmSync(FIX_TMP, { recursive: true, force: true });
  rmSync(FIX_HOME, { recursive: true, force: true });
});

describe("fence-present contrast (archived probe yolo check 6, physical)", () => {
  it.skipIf(!CAN_EXEC)(
    "non-yolo bare-fence shape: same command through the real fence gets parent=bwrap and a foreign netns",
    () => {
      const argv = createBwrapFence({
        command: "bash",
        args: ["-c", "readlink /proc/self/ns/net; cat /proc/$PPID/comm"],
        fsPolicy: createFsPolicy({ tmpDir: FIX_TMP, mode: "global" }),
        env: { PATH: "/usr/bin:/bin", HOME: FIX_HOME },
        cwd: FIX_CWD,
      }).argv;
      expect(argv[0]).toBe("bwrap");
      const r = spawnSync(argv[0], argv.slice(1), {
        cwd: FIX_CWD,
        env: { PATH: "/usr/bin:/bin", HOME: FIX_HOME },
        encoding: "utf8",
      });
      expect(r.status, r.stderr).toBe(0);
      const [netnsLine = "", ppidComm = ""] = r.stdout.split("\n");
      const hostNetns = readlinkSync("/proc/self/ns/net");
      // Both discriminators at once: the fence prefix exists (parent is
      // bwrap) and `--unshare-net` took effect (netns differs).
      expect(ppidComm.trim()).toBe("bwrap");
      expect(netnsLine.trim()).not.toBe(hostNetns);
    }
  );
});
