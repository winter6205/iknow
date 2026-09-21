/**
 * Index-entry history persisted with the session (`specs/skill-index-increment.md` / ADR-0098).
 *
 * Invariants pinned here (sources in parentheses):
 *   - entry history = opening frozen-table names ∪ appended deltas
 *     (docs/CONTEXT.md "索引进场史" — "index entry history").
 *   - new session initial value = that session's opening model-index name set;
 *     restoring the same session does not re-append (spec SC3).
 *   - only current model-index names may be written; unknown / invalid names
 *     are ignored (spec Input-contract invalid column; SC7 "envelope ≠ entry"
 *     persistence-side gate).
 *   - append and persist are one beat: persist failure → typed error, caller
 *     **gets no receipt**, in-memory set unchanged (spec Input-contract
 *     exception column / ADR-0098).
 *   - the set does not depend on messages: after compact rewrites messages the
 *     same session's set remains (spec SC4; expressed as "new instance + the
 *     frozen table no longer contains the name").
 *   - storage layout mirrors the todo ledger:
 *     `<projectDir>/<sanitize(conversationId)>/<leaf>` (the session-folder
 *     leaf form of `resolveConversationTodoPath`; sanitization SSOT =
 *     `sanitizeConversationSegment`).
 *
 * Failure injection always uses real IO (turn the leaf path into a directory →
 * EISDIR), no fs mocks: the contract is "no half-written file on atomic-write
 * failure and caller gets no receipt", provable only on a real disk.
 */
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  SKILL_INDEX_LEDGER_FILE,
  SkillIndexLedgerError,
  createSkillIndexLedger,
  type SkillIndexLedger,
} from "../../src/harness/skill/index-ledger.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "skill-index-ledger-"));
  roots.push(dir);
  return dir;
}

/**
 * Current model index (test double for the `catalog.modelIndex()` face). The
 * ledger does not duplicate the "has description and not disabled" predicate
 * (that is `isModelIndexEligible`'s SSOT); it only consumes the caller's
 * current predicate — so a name set suffices here.
 */
const MODEL_INDEX: readonly string[] = ["alpha", "beta", "gamma"];
const isIndexedName = (name: string): boolean => MODEL_INDEX.includes(name);

const CONVERSATION = "conv-abc-123";

function leafPath(projectDir: string, conversationId = CONVERSATION): string {
  return join(projectDir, conversationId, SKILL_INDEX_LEDGER_FILE);
}

async function openLedger(
  projectDir: string,
  opts: {
    readonly initialNames?: readonly string[];
    readonly conversationId?: string;
    readonly isIndexedName?: (name: string) => boolean;
  } = {}
): Promise<SkillIndexLedger> {
  return createSkillIndexLedger({
    projectDir,
    conversationId: opts.conversationId ?? CONVERSATION,
    initialNames: opts.initialNames ?? [],
    isIndexedName: opts.isIndexedName ?? isIndexedName,
  });
}

/**
 * Failure injection (hits the mkdir arm): replace the **directory segment**
 * (`<projectDir>/<conversationId>`) with a plain file — the atomic write's
 * `mkdir(dir, recursive)` necessarily gets ENOTDIR before any tmp is written,
 * so the existing leaf always stays intact.
 *
 * The injection itself removes the directory segment (leaf included), so use
 * it only in "leaf does not exist" cases; cases with a prior successful write
 * use `blockLeafWriteWithPermissions`.
 */
async function blockConversationDir(projectDir: string): Promise<void> {
  await rm(join(projectDir, CONVERSATION), { recursive: true, force: true });
  await writeFile(join(projectDir, CONVERSATION), "blocker", "utf8");
}

/**
 * Failure injection (hits the atomic-write arm **without touching the old
 * file**): make the directory segment read-only — first create the leaf
 * directory inside the segment (stand-in for the old leaf), then `chmod 0o500`
 * the parent: `mkdir` on the existing dir succeeds and `writeFile(tmp)` gets
 * EACCES. Tests must restore permissions (`chmod 0o700`) at the end, or
 * afterEach's rm cannot clean the temp root.
 */
async function blockLeafWriteWithPermissions(
  projectDir: string
): Promise<void> {
  await chmod(join(projectDir, CONVERSATION), 0o500);
}

/**
 * Failure injection (read side): leaf path occupied by a **directory** —
 * `readFile(leaf)` necessarily gets EISDIR. When the directory segment does
 * not exist yet, `mkdir(recursive)` creates it as part of the injection.
 */
async function blockLeafAsDirectory(projectDir: string): Promise<void> {
  await rm(leafPath(projectDir), { recursive: true, force: true });
  await mkdir(leafPath(projectDir), { recursive: true });
}

async function tmpLeftovers(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((entry) => entry.endsWith(".tmp"));
}

describe("索引进场史：初值 / 恢复（SC3）", () => {
  it("empty：无冻表名、无落盘 → 空集，且不因读失败而抛", async () => {
    const projectDir = await makeRoot();
    const ledger = await openLedger(projectDir);

    expect(ledger.snapshot()).toEqual([]);
    expect(ledger.has("alpha")).toBe(false);
  });

  it("新 session 初值 = 给定冻表 name 集（去重、name 升序）", async () => {
    const projectDir = await makeRoot();
    const ledger = await openLedger(projectDir, {
      initialNames: ["gamma", "alpha", "gamma"],
    });

    expect(ledger.snapshot()).toEqual(["alpha", "gamma"]);
    expect(ledger.has("alpha")).toBe(true);
    expect(ledger.has("beta")).toBe(false);
  });

  it("addMany 落盘可被同一 conversationId 的新实例读回（进程重启 / 恢复）", async () => {
    const projectDir = await makeRoot();
    const first = await openLedger(projectDir);
    const receipt = await first.addMany(["alpha"]);

    expect(receipt.added).toEqual(["alpha"]);

    // Same session, same frozen table: after restore the name is still there and re-adding does not append (SC3).
    const restored = await openLedger(projectDir, { initialNames: ["gamma"] });
    expect(restored.snapshot()).toEqual(["alpha", "gamma"]);
    expect(restored.has("alpha")).toBe(true);

    const replay = await restored.addMany(["alpha", "gamma"]);
    expect(replay.added).toEqual([]);
  });

  it("冻表名不重复落盘也不丢：冻表 ∪ 落盘史的并集是唯一权威", async () => {
    const projectDir = await makeRoot();
    const first = await openLedger(projectDir, { initialNames: ["alpha"] });
    await first.addMany(["beta"]);

    // On restore the frozen table (opening model index) already contains beta — overlap with the on-disk history does not double-enter the set.
    const restored = await openLedger(projectDir, {
      initialNames: ["alpha", "beta"],
    });
    expect(restored.snapshot()).toEqual(["alpha", "beta"]);
  });
});

describe("索引进场史：写入闸（未知 / 非法输入忽略）", () => {
  it("非现行模型索引的 name 被忽略：不抛、不入集、不落盘", async () => {
    const projectDir = await makeRoot();
    const ledger = await openLedger(projectDir);

    // Names like "undocumented" / "frozen" are human-side loadable skills (no description /
    // disabled) outside the model-index face — passing a slash envelope does not count as entry (SC7).
    const receipt = await ledger.addMany(["undocumented", "frozen"]);

    expect(receipt.added).toEqual([]);
    expect(ledger.snapshot()).toEqual([]);
    await expect(readFile(leafPath(projectDir), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("合法与非法混批：只收现行模型索引名", async () => {
    const projectDir = await makeRoot();
    const ledger = await openLedger(projectDir);

    const receipt = await ledger.addMany(["undocumented", "beta"]);

    expect(receipt.added).toEqual(["beta"]);
    expect(ledger.snapshot()).toEqual(["beta"]);
  });

  it("边界：空串 / 非字符串 name 忽略（不抛、不入集）", async () => {
    const projectDir = await makeRoot();
    const ledger = await openLedger(projectDir);

    const receipt = await ledger.addMany([
      "",
      // @ts-expect-error runtime-invalid input (hand-edited call site / untyped JSON)
      null,
      // @ts-expect-error same as above
      42,
      "alpha",
    ]);

    expect(receipt.added).toEqual(["alpha"]);
    expect(ledger.snapshot()).toEqual(["alpha"]);
    expect(ledger.has("")).toBe(false);
  });

  it("批量空输入：不写盘、集不变", async () => {
    const projectDir = await makeRoot();
    const ledger = await openLedger(projectDir, { initialNames: ["alpha"] });

    const receipt = await ledger.addMany([]);

    expect(receipt.added).toEqual([]);
    expect(receipt.snapshot).toEqual(["alpha"]);
    await expect(readFile(leafPath(projectDir), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("索引进场史：追加与落盘同一拍（exception 列）", () => {
  it("落盘失败（mkdir 臂）→ typed write_failed；内存集不变、无 receipt、无盘上残留", async () => {
    const projectDir = await makeRoot();
    const ledger = await openLedger(projectDir, { initialNames: ["alpha"] });
    await blockConversationDir(projectDir);

    const err = await ledger.addMany(["beta"]).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SkillIndexLedgerError);
    expect((err as SkillIndexLedgerError).kind).toBe("write_failed");
    // Caller-side guarantee of "one beat": no receipt = appending to messages must not count as entered.
    expect((err as SkillIndexLedgerError).conversationId).toBe(CONVERSATION);
    // Failure leaves the in-memory set unchanged — the next diff still treats it as new, never silently dropping the name.
    // (On-disk history cannot be read back on this arm; re-reading to restore state on the failure path would hit ENOTDIR,
    //  so this also pins "failure state does not depend on disk reads".)
    expect(ledger.has("beta")).toBe(false);
    expect(ledger.snapshot()).toEqual(["alpha"]);
    // The failure path never touches disk: the blocker stays as-is, no tmp / leaf created.
    expect(await readFile(join(projectDir, CONVERSATION), "utf8")).toBe(
      "blocker"
    );
    expect(await readdir(projectDir)).toEqual([CONVERSATION]);
  });

  it("落盘失败（原子写臂）：tmp 被清、旧叶子字节不变", async () => {
    const projectDir = await makeRoot();
    const ledger = await openLedger(projectDir);
    await ledger.addMany(["alpha"]);
    const before = await readFile(leafPath(projectDir), "utf8");
    await blockLeafWriteWithPermissions(projectDir);

    const err = await ledger.addMany(["beta"]).catch((e: unknown) => e);
    await chmod(join(projectDir, CONVERSATION), 0o700); // restore, so afterEach can clean up

    expect((err as SkillIndexLedgerError).kind).toBe("write_failed");
    expect(ledger.snapshot()).toEqual(["alpha"]);
    expect(await readFile(leafPath(projectDir), "utf8")).toBe(before);
    expect(await tmpLeftovers(join(projectDir, CONVERSATION))).toEqual([]);
  });

  it("落盘失败后修好盘：重试成功，先前被拒的名仍算新建", async () => {
    const projectDir = await makeRoot();
    const ledger = await openLedger(projectDir);
    await blockConversationDir(projectDir);
    await ledger.addMany(["alpha"]).catch(() => undefined);

    await rm(join(projectDir, CONVERSATION), { force: true });
    const receipt = await ledger.addMany(["alpha"]);

    expect(receipt.added).toEqual(["alpha"]);
    expect(ledger.snapshot()).toEqual(["alpha"]);
    const restored = await openLedger(projectDir);
    expect(restored.has("alpha")).toBe(true);
  });

  it("批内全或无：一次落盘写整批，失败时整批都不进集", async () => {
    const projectDir = await makeRoot();
    const ledger = await openLedger(projectDir);
    await blockConversationDir(projectDir);

    const err = await ledger
      .addMany(["alpha", "beta"])
      .catch((e: unknown) => e);

    expect((err as SkillIndexLedgerError).kind).toBe("write_failed");
    expect(ledger.snapshot()).toEqual([]);
  });

  it("读失败（叶子被占成目录）→ typed read_failed，不静默当空集重建", async () => {
    const projectDir = await makeRoot();
    await blockLeafAsDirectory(projectDir);

    const err = await openLedger(projectDir).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SkillIndexLedgerError);
    expect((err as SkillIndexLedgerError).kind).toBe("read_failed");
  });

  it("落盘损坏 / 版本不符 / 形状不符 → typed read_failed（不静默丢史）", async () => {
    const cases: readonly string[] = [
      "{ not json",
      JSON.stringify({ version: 2, names: ["alpha"] }),
      JSON.stringify({ version: 1, names: ["alpha", 7] }),
      JSON.stringify({ version: 1, names: ["alpha", ""] }),
      JSON.stringify({ names: ["alpha"] }),
      JSON.stringify(["alpha"]),
    ];
    for (const raw of cases) {
      const projectDir = await makeRoot();
      await mkdir(join(projectDir, CONVERSATION), { recursive: true });
      await writeFile(leafPath(projectDir), raw, "utf8");

      const err = await openLedger(projectDir).catch((e: unknown) => e);

      expect(err, raw).toBeInstanceOf(SkillIndexLedgerError);
      expect((err as SkillIndexLedgerError).kind, raw).toBe("read_failed");
    }
  });
});

describe("索引进场史：compact 不删集（SC4）/ 下架不对齐（Assumption 3）", () => {
  it("compact 语义：集不依赖 messages —— 新实例即便冻表已不含该名仍在", async () => {
    const projectDir = await makeRoot();
    const first = await openLedger(projectDir, { initialNames: ["alpha"] });
    await first.addMany(["beta"]);

    // Compact only rewrites messages (the delta's user message disappears); the session folder is untouched.
    // "New instance + empty frozen table" expresses "the delta vanished from messages": the set must survive,
    // otherwise the next round would treat beta as new and re-post the listing.
    const afterCompact = await openLedger(projectDir, { initialNames: [] });

    expect(afterCompact.has("beta")).toBe(true);
    expect(afterCompact.snapshot()).toEqual(["alpha", "beta"]);
    expect((await afterCompact.addMany(["beta"])).added).toEqual([]);
  });

  it("下架 / disable 不对齐本会话：冻表名不因现行索引不再含它而被清", async () => {
    const projectDir = await makeRoot();
    const ledger = await openLedger(projectDir, {
      initialNames: ["alpha"],
      isIndexedName: () => false, // alpha was withdrawn in this session
    });

    const receipt = await ledger.addMany(["alpha"]);

    expect(receipt.added).toEqual([]); // no re-post
    expect(ledger.has("alpha")).toBe(true); // but also not evicted from entry history
  });

  it("会话重冻（/reset 或新 conversationId）：新 id 的初值 = 新冻表，不带旧 id 的史", async () => {
    const projectDir = await makeRoot();
    const before = await openLedger(projectDir);
    await before.addMany(["alpha"]);

    // After /reset the host gives a new conversationId + new frozen table: the new session counts from zero, old history does not migrate.
    const after = await openLedger(projectDir, {
      conversationId: "conv-reset-456",
      initialNames: ["beta"],
    });

    expect(after.snapshot()).toEqual(["beta"]);
    expect(after.has("alpha")).toBe(false);
    // The old session's own history is unaffected (each id has its own leaf).
    expect((await openLedger(projectDir)).has("alpha")).toBe(true);
  });
});

describe("索引进场史：幂等 / 并发 / 落盘形态", () => {
  it("重复 add 幂等：集不变大，且不依赖盘可写（存量不重写盘）", async () => {
    const projectDir = await makeRoot();
    const ledger = await openLedger(projectDir);
    await ledger.addMany(["alpha"]);

    await blockLeafAsDirectory(projectDir);

    const receipt = await ledger.addMany(["alpha"]);

    expect(receipt.added).toEqual([]);
    expect(receipt.snapshot).toEqual(["alpha"]);
  });

  it("并发 addMany 同名：串行落盘，恰一个 receipt 认领，集不变大", async () => {
    const projectDir = await makeRoot();
    const ledger = await openLedger(projectDir);

    const [a, b] = await Promise.all([
      ledger.addMany(["alpha"]),
      ledger.addMany(["alpha"]),
    ]);

    const claimants = [a, b].filter((r) => r.added.includes("alpha"));
    expect(claimants).toHaveLength(1);
    expect(ledger.snapshot()).toEqual(["alpha"]);

    const restored = await openLedger(projectDir);
    expect(restored.snapshot()).toEqual(["alpha"]);
  });

  it("并发 addMany 异名：两条都进集，落盘史是两者的并集", async () => {
    const projectDir = await makeRoot();
    const ledger = await openLedger(projectDir);

    const receipts = await Promise.all([
      ledger.addMany(["alpha"]),
      ledger.addMany(["beta"]),
    ]);

    expect(ledger.snapshot()).toEqual(["alpha", "beta"]);
    expect(new Set(receipts.flatMap((r) => r.added))).toEqual(
      new Set(["alpha", "beta"])
    );
  });

  it("落盘形态：<projectDir>/<conversationId>/skill-index.json，JSON {version,names} name 升序", async () => {
    const projectDir = await makeRoot();
    const ledger = await openLedger(projectDir);
    await ledger.addMany(["gamma", "alpha"]);

    const raw = await readFile(
      join(projectDir, CONVERSATION, SKILL_INDEX_LEDGER_FILE),
      "utf8"
    );

    expect(JSON.parse(raw)).toEqual({ version: 1, names: ["alpha", "gamma"] });
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("敌意 conversationId 不逃逸 projectDir（净化复用 sanitizeConversationSegment）", async () => {
    const projectDir = await makeRoot();
    const ledger = await openLedger(projectDir, {
      conversationId: "../evil",
    });
    await ledger.addMany(["alpha"]);

    expect(await readdir(projectDir)).toEqual(["___evil"]);
    await expect(
      readFile(join(projectDir, "..", "evil", SKILL_INDEX_LEDGER_FILE), "utf8")
    ).rejects.toBeTruthy();
  });

  it("空 conversationId → typed invalid_conversation_id，不落盘", async () => {
    const projectDir = await makeRoot();
    const err = await openLedger(projectDir, { conversationId: "" }).catch(
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(SkillIndexLedgerError);
    expect((err as SkillIndexLedgerError).kind).toBe("invalid_conversation_id");
    expect(await readdir(projectDir)).toEqual([]);
  });

  it("API 面：唯一 mutator 是 addMany（slash 信封无写入通道，SC7）", async () => {
    const projectDir = await makeRoot();
    const ledger = await openLedger(projectDir);

    expect(Object.keys(ledger).sort()).toEqual(["addMany", "has", "snapshot"]);
  });

  it("snapshot 是快照：调用方改写返回值不污染内部集", async () => {
    const projectDir = await makeRoot();
    const ledger = await openLedger(projectDir, { initialNames: ["alpha"] });

    const snapshot = ledger.snapshot() as string[];
    snapshot.push("beta");

    expect(ledger.snapshot()).toEqual(["alpha"]);
    expect(ledger.has("beta")).toBe(false);
  });
});
