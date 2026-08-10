/**
 * T9 seed 迁移冒烟脚本
 *
 * 调用 T2 scanner + catalog 扫描 `.iknow/skills`，断言：
 *   - 索引 9 件
 *   - available() = 8 件（session-handoff + teach = 2 disabled，但 session-handoff 也无 description；teach 有 disable-model-invocation:true 无 description 也可能不出）
 *   - session-handoff disabled
 *   - 名字序
 *
 * 运行：tsx scripts/t9-skill-smoke.ts
 */
import { resolve } from "node:path";
import { createSkillScanner } from "../src/harness/skill/scanner.js";
import { createSkillCatalog } from "../src/harness/skill/catalog.js";
import { homedir } from "node:os";

const REPO = resolve(import.meta.dirname, "..");
const CWD = REPO; // <cwd>/.iknow/skills

async function main() {
  const warns: string[] = [];
  const scanner = createSkillScanner({
    userHome: homedir(),
    cwd: CWD,
    env: {
      // 强制空，避免环境变量引入额外目录
      IKNOW_SKILL_DIRS: "",
    },
    warn: (msg) => warns.push(msg),
  });

  const entries = await scanner.scan();
  const catalog = createSkillCatalog(entries);

  const all = catalog.all();
  const available = catalog.available();
  const disabled = all.filter((e) => e.disabled);
  const noDescription = all.filter((e) => !e.description);

  // 名字序断言
  const sortedByName = [...all].sort((a, b) => a.name.localeCompare(b.name));
  const nameOrderOK = all.every((e, i) => e.name === sortedByName[i].name);

  // session-handoff 必须 disabled
  const sessionHandoff = catalog.get("session-handoff");
  const sessionHandoffDisabled = sessionHandoff?.disabled === true;

  // available 必须按名字序
  const availableIsSorted = available.every(
    (e, i) => i === 0 || e.name.localeCompare(available[i - 1].name) >= 0
  );

  console.log("=== T9 skill smoke ===");
  console.log(`repo:           ${REPO}`);
  console.log(`userHome:       ${homedir()}`);
  console.log(`cwd:            ${CWD}`);
  console.log(
    `scanned roots:  ~/.iknow/skills, <cwd>/.iknow/skills, (IKNOW_SKILL_DIRS empty)`
  );
  console.log("");
  console.log(`indexed total:  ${all.length}`);
  console.log(`available:      ${available.length}`);
  console.log(
    `disabled:       ${disabled.length} ${disabled.map((e) => e.name).join(", ") || "(none)"}`
  );
  console.log(
    `no description: ${noDescription.length} ${noDescription.map((e) => e.name).join(", ") || "(none)"}`
  );
  console.log("");
  console.log("all entries (by index order):");
  for (const entry of all) {
    console.log(
      `  - ${entry.name.padEnd(34)} disabled=${String(entry.disabled).padEnd(5)} ${entry.description ? "has-description" : "NO-DESCRIPTION"}`
    );
  }
  console.log("");
  console.log("available entries (name-sorted):");
  for (const entry of available) {
    console.log(`  - ${entry.name}`);
  }
  console.log("");
  console.log("session-handoff check:");
  console.log(`  exists:         ${Boolean(sessionHandoff)}`);
  console.log(`  disabled:       ${sessionHandoffDisabled}`);
  console.log("");
  console.log("name order check:");
  console.log(`  all-name-sorted:           ${nameOrderOK}`);
  console.log(`  available-name-sorted:     ${availableIsSorted}`);
  console.log("");

  if (warns.length > 0) {
    console.log("warnings:");
    for (const w of warns) console.log(`  ! ${w}`);
  } else {
    console.log("warnings: (none)");
  }
  console.log("");

  // 断言
  const expectedTotal = 9;
  const expectedAvailableSeeds = [
    "systematic-debugging",
    "verification-before-completion",
    "test-driven-development",
  ];
  const expectedAvailableMigrated = [
    "playwright-cli",
    "prototype",
    "review-report-repair",
    "test-driven-development",
    "v-code-review",
  ];
  const fail: string[] = [];

  if (all.length !== expectedTotal) {
    fail.push(`expected ${expectedTotal} entries, got ${all.length}`);
  }
  if (!sessionHandoffDisabled) {
    fail.push(`session-handoff should be disabled=true`);
  }
  if (!nameOrderOK) {
    fail.push(`all entries not name-sorted`);
  }
  if (!availableIsSorted) {
    fail.push(`available entries not name-sorted`);
  }
  for (const seed of expectedAvailableSeeds) {
    const entry = catalog.get(seed);
    if (!entry) fail.push(`seed skill missing: ${seed}`);
    else if (entry.disabled)
      fail.push(`seed skill should not be disabled: ${seed}`);
    else if (!entry.description)
      fail.push(`seed skill has no description: ${seed}`);
    if (!available.find((e) => e.name === seed)) {
      fail.push(`seed skill not in available(): ${seed}`);
    }
  }
  for (const mig of expectedAvailableMigrated) {
    if (!available.find((e) => e.name === mig)) {
      fail.push(`migrated skill not in available(): ${mig}`);
    }
  }
  if (available.find((e) => e.name === "session-handoff")) {
    fail.push(`session-handoff leaked into available() (should be disabled)`);
  }

  console.log("=== assertions ===");
  if (fail.length === 0) {
    console.log("PASS");
    process.exit(0);
  } else {
    console.log("FAIL");
    for (const f of fail) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("smoke script failed:", err);
  process.exit(2);
});
