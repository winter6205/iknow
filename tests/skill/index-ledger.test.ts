/**
 * T4 (`specs/skill-index-increment.md` / ADR-0098) — 索引进场史跟 session 落盘。
 *
 * 本文件钉住的不变式（出处见括号）：
 *   - 进场史 = 开场冻表 name ∪ 已追加增量（docs/CONTEXT.md「索引进场史」）。
 *   - 新 session 初值 = 该 session 开场模型索引名集；恢复同一 session 不
 *     重复追加（spec SC3）。
 *   - 只有现行模型索引名能写入；未知 / 非法 name 写入被忽略（spec
 *     Input-contract invalid 列；SC7「信封 ≠ 进场」的落盘侧闸）。
 *   - 追加与落盘同一拍：落盘失败 → typed 错误，调用方**拿不到 receipt**，
 *     内存集不变（spec Input-contract exception 列 / ADR-0098）。
 *   - 集合不依赖 messages：compact 重写 messages 后同一 session 的集仍在
 *     （spec SC4；用「新建实例 + 冻表已不含该名」表达）。
 *   - 落点与 todo ledger 同构：`<projectDir>/<sanitize(conversationId)>/<leaf>`
 *     （`resolveConversationTodoPath` 的会话文件夹叶子形态，净化 SSOT =
 *     `sanitizeConversationSegment`）。
 *
 * 失败注入一律走真实 IO（把叶子路径做成目录 → EISDIR），不 mock fs：
 * 契约是「原子写失败时盘上不留半成品、调用方拿不到 receipt」，只有真盘子
 * 能证明。
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
 * 现行模型索引（`catalog.modelIndex()` 面的测试替身）。ledger 不复制
 * 「有 description 且未 disable」判据（那是 `isModelIndexEligible` 的
 * SSOT），只消费调用方给的现行谓词 —— 故这里只需给出名字集合。
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
 * 失败注入（压 mkdir 臂）：把**目录段**（`<projectDir>/<conversationId>`）
 * 占成一个普通文件 —— 原子写的 `mkdir(dir, recursive)` 必然 ENOTDIR，
 * tmp 还没写出，现有叶子一定保持完整。
 *
 * 注入本身会移走目录段（连带叶子），故只在「叶子不存在」的用例里用；
 * 已有成功写入的用例用 `blockLeafWriteWithPermissions`。
 */
async function blockConversationDir(projectDir: string): Promise<void> {
  await rm(join(projectDir, CONVERSATION), { recursive: true, force: true });
  await writeFile(join(projectDir, CONVERSATION), "blocker", "utf8");
}

/**
 * 失败注入（压原子写臂，**不动旧文件**）：目录段只读 —— 同目录段内
 * 先建叶子目录（旧叶子的替身）再对父目录 `chmod 0o500`，`mkdir` 命中
 * 既有目录返回成功，`writeFile(tmp)` 才 EACCES。用例尾部必须把权限
 * 还原（`chmod 0o700`），否则 afterEach 的 rm 清不掉临时根。
 */
async function blockLeafWriteWithPermissions(
  projectDir: string
): Promise<void> {
  await chmod(join(projectDir, CONVERSATION), 0o500);
}

/**
 * 失败注入（读侧）：叶子路径被占成**目录** —— `readFile(leaf)` 必然 EISDIR。
 * 目录段还不存在时由 `mkdir(recursive)` 一并建出，注入自带前置条件。
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

    // 同一 session、同一冻表：恢复后仍含该名，重复 add 不再追加（SC3）。
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

    // 恢复时冻表（开场模型索引）已含 beta —— 与落盘史重叠也不重复入集。
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

    // "undocumented" / "frozen" 这类人侧可加载技能名（无 description /
    // disable）不在模型索引面 —— slash 信封灌过也不算进场（SC7）。
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
      // @ts-expect-error 运行期非法输入（hand-edited 调用点 / 未类型化 JSON）
      null,
      // @ts-expect-error 同上
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
    // 「同一拍」的调用方侧保证：拿不到 receipt = 不得把 messages 追加当成已进场。
    expect((err as SkillIndexLedgerError).conversationId).toBe(CONVERSATION);
    // 失败不改内存集 —— 下一次 diff 仍会把它当新建，不会静默丢名。
    // （此臂下盘上读不回旧史，实现若在失败路径重读来复原会拿到 ENOTDIR，
    //  故这条同时钉住「失败状态不依赖读盘」。）
    expect(ledger.has("beta")).toBe(false);
    expect(ledger.snapshot()).toEqual(["alpha"]);
    // 失败路径不碰盘：占位符原样，没有 tmp / 叶子被创建。
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
    await chmod(join(projectDir, CONVERSATION), 0o700); // 还原，供 afterEach 清理

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

    // compact 只重写 messages（增量那条 user 消息消失），会话文件夹不动。
    // 用「新建实例 + 空冻表」表达「messages 里增量不见了」：集必须还在，
    // 否则下一轮会把 beta 当新建再贴一次 listing。
    const afterCompact = await openLedger(projectDir, { initialNames: [] });

    expect(afterCompact.has("beta")).toBe(true);
    expect(afterCompact.snapshot()).toEqual(["alpha", "beta"]);
    expect((await afterCompact.addMany(["beta"])).added).toEqual([]);
  });

  it("下架 / disable 不对齐本会话：冻表名不因现行索引不再含它而被清", async () => {
    const projectDir = await makeRoot();
    const ledger = await openLedger(projectDir, {
      initialNames: ["alpha"],
      isIndexedName: () => false, // alpha 本会话中被下架
    });

    const receipt = await ledger.addMany(["alpha"]);

    expect(receipt.added).toEqual([]); // 不再重复贴
    expect(ledger.has("alpha")).toBe(true); // 但也没有被清出进场史
  });

  it("会话重冻（/reset 或新 conversationId）：新 id 的初值 = 新冻表，不带旧 id 的史", async () => {
    const projectDir = await makeRoot();
    const before = await openLedger(projectDir);
    await before.addMany(["alpha"]);

    // /reset 后宿主给新 conversationId + 新冻表：新会话从零起算，旧史不迁移。
    const after = await openLedger(projectDir, {
      conversationId: "conv-reset-456",
      initialNames: ["beta"],
    });

    expect(after.snapshot()).toEqual(["beta"]);
    expect(after.has("alpha")).toBe(false);
    // 旧会话自己的史不受影响（两个 id 各自一个叶子）。
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
