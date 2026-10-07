/**
 * E2E: first-run bootstrap completes implicitly via file removal.
 *
 * Full chain (isolated HOME, no real user data; calls the lowest-level
 * wiring functions directly to avoid uncommitted build-engine changes):
 * 1. initializeIknowWorkspace first run -> seeds user.md + state.json(bs=true)
 *    + ~/.iknow/BOOTSTRAP.md
 * 2. assembleIdentityContext(bootstrapActive=true) -> system contains "First Contact"
 * 3. Simulate the agent finishing the bootstrap chat: filesystem ops stand in
 *    for bash (bwrap --binds the whole home into the sandbox, so bash can
 *    freely write ~/.iknow/). Writes ~/.iknow/user.md + rm ~/.iknow/BOOTSTRAP.md
 * 4. Second assembleIdentityContext -> no "First Contact" (BOOTSTRAP.md
 *    missing -> not injected -> bootstrap done)
 * 5. user.md content takes effect per turn
 *
 * Asserted:
 *  - first system contains "First Contact" / "Goals"
 *  - user.md content takes effect per turn
 *  - after deleting BOOTSTRAP.md, second system has no bootstrap section
 *  - state.json bootstrap_seeded=true (flag flips at seed time, auditable)
 *  - ask surface (bootstrapActive=false) never injects, even if the file exists
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  rm,
  readFile,
  writeFile,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeIknowWorkspace,
  readIknowState,
  assembleIdentityContext,
} from "../../src/harness/identity/index.js";

let origHome: string | undefined;
let fakeHome: string;
let fakeIknow: string;

beforeAll(async () => {
  origHome = process.env.HOME;
  fakeHome = await mkdtemp(join(tmpdir(), "iknow-bootstrap-e2e-"));
  fakeIknow = join(fakeHome, ".iknow");
  await mkdir(fakeIknow, { recursive: true });
  process.env.HOME = fakeHome;
});

afterAll(async () => {
  process.env.HOME = origHome;
  await rm(fakeHome, { recursive: true, force: true });
});

describe("#196 T12 E2E: bootstrap 文件驱动隐式完成", () => {
  it("首次 init → system 注入 BOOTSTRAP;写 user.md + rm BOOTSTRAP.md → 二次不注入", async () => {
    // 1. First init: seeds user.md + state (bs=true) + BOOTSTRAP.md
    const init = await initializeIknowWorkspace({ workspace: fakeIknow });
    expect(init.state.bootstrap_seeded).toBe(true);
    const bootstrapContent = await readFile(
      join(fakeIknow, "BOOTSTRAP.md"),
      "utf8"
    );
    expect(bootstrapContent).toContain("First Contact");

    // 2. First assembly -> system includes the bootstrap section
    const firstSystem =
      (await assembleIdentityContext({
        cwd: fakeHome,
        // ADR-0037: the "Project path" segment renders from
        // projectIdentityRoot, not cwd — pin it to the same fake home so the
        // assembled text stays identical to the pre-ADR-0037 behaviour.
        projectIdentityRoot: fakeHome,
        userHome: fakeHome,
        bootstrapActive: true,
        memoryEnabled: false,
      })) ?? "";
    expect(firstSystem).toContain("First Contact");
    expect(firstSystem).toContain("Goals");
    expect(firstSystem).toContain("User Profile");

    // 3. Simulate the agent finishing bootstrap: bwrap --binds the whole home
    //    into the sandbox, so bash can freely read/write ~/.iknow/ (the hard
    //    wall does not block .iknow paths; non-allowlisted commands go to the
    //    ask tier). Filesystem ops stand in for bash execution here.
    const userProfile = join(fakeIknow, "user.md");
    await writeFile(
      userProfile,
      "# Profile\n- Name: E2E\n- Goal: test bootstrap\n",
      "utf8"
    );
    await unlink(join(fakeIknow, "BOOTSTRAP.md"));

    // 4. Second assembly -> user.md content live + bootstrap section gone
    const secondSystem =
      (await assembleIdentityContext({
        cwd: fakeHome,
        // ADR-0037: the "Project path" segment renders from
        // projectIdentityRoot, not cwd — pin it to the same fake home so the
        // assembled text stays identical to the pre-ADR-0037 behaviour.
        projectIdentityRoot: fakeHome,
        userHome: fakeHome,
        bootstrapActive: true,
        memoryEnabled: false,
      })) ?? "";
    expect(secondSystem).toContain("- Name: E2E");
    expect(secondSystem).toContain("- Goal: test bootstrap");
    expect(secondSystem).not.toContain("First Contact");

    // 5. State audit: bs=true (flag flips at seed time, auditable)
    const state = await readIknowState(fakeIknow);
    expect(state.bootstrap_seeded).toBe(true);
  });

  it("ask surface (bootstrapActive=false): 即使 BOOTSTRAP.md 存在也不注入", async () => {
    // Recreate BOOTSTRAP.md (simulates first run not yet finished)
    await writeFile(
      join(fakeIknow, "BOOTSTRAP.md"),
      "# BOOTSTRAP.md - First Contact\n\nnot done yet\n",
      "utf8"
    );
    const askSystem =
      (await assembleIdentityContext({
        cwd: fakeHome,
        // ADR-0037: the "Project path" segment renders from
        // projectIdentityRoot, not cwd — pin it to the same fake home so the
        // assembled text stays identical to the pre-ADR-0037 behaviour.
        projectIdentityRoot: fakeHome,
        userHome: fakeHome,
        bootstrapActive: false,
        memoryEnabled: false,
      })) ?? "";
    expect(askSystem).not.toContain("First Contact");
    // Clean up so other tests see a pristine state
    await unlink(join(fakeIknow, "BOOTSTRAP.md")).catch(() => {});
  });
});
