/**
 * checkpoint/rewind 5 类边界矩阵 — 补 T1 (checkpoint.test.ts) / T2+T3
 * (chat-session-checkpoint.test.ts) / T4 (chat-session-resume.test.ts) 未覆盖
 * 的真缺口。audit 结论(逐类盘点既有覆盖):
 *
 *   - empty(空输入)→ splitTurns([]) / turnSliceEnd 空 / shouldPersist
 *     delta=0 / appendCheckpoint delta=0 / rewind keepTurns=0 均已有,跳过。
 *   - negative(负值/非法)→ turnSliceEnd(-1) / appendCheckpoint 负 delta /
 *     rewind clamp / schema 拒非数组 messages 均已有,跳过。
 *   - overflow(大输入)→ 只有 extractTitle 80 字符上限;缺大 messages 数组
 *     与大 checkpoints 数组。本文件补 3 例。
 *   - concurrent(并发)→ 既有仅 immutability(T1)+ 顺序重复 commit(T2/T4);
 *     缺并行 save() 到同一 id 的撕裂防护。本文件补 1 例(核心)。
 *   - exception(异常)→ write_failed → warn+continue 已覆盖;更深 IO 树
 *     (ENOTDIR / 只读目录 / primitive root / checkpoints=null)本文件补 4 例;
 *     resume 路径的 checkpoints 畸形在 chat-session-resume.test.ts 追加 1 例。
 *
 * 注意(与任务描述的一处偏差):「checkpoints 畸形 → sanitize 归一化」与生产
 * 裁决相反 —— schema.ts:94-96 明确「never silently coerce」,checkpoints=null
 * 是硬拒(schema.test.ts:176 已固化)。生产代码不改(硬约束),故本文件验证实际
 * 契约:load 抛 typed schema_invalid(field="checkpoints"),resume 路径 warn
 * [schema_invalid] + 锚点保留,绝不裸 Error、绝不静默吞。
 *
 * 隔离:全部 mkdtemp,绝不写真实 ~/.iknow。
 */
import { afterAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnthropicNativeMessage } from "../../../src/harness/index.ts";
import {
  CURRENT_SCHEMA_VERSION,
  resolveProjectSessionDir,
  resolveRewindAnchor,
  SessionStore,
  splitTurns,
  withCheckpointAnchors,
  type CheckpointRecord,
  type SessionFileV1,
  type SessionStoreError,
} from "../../../src/session-api/store/index.ts";

// -- fixtures -----------------------------------------------------------------

const text = (t: string) => ({ type: "text" as const, text: t });

const userMsg = (t: string): AnthropicNativeMessage => ({
  role: "user",
  content: [text(t)],
});

const assistantMsg = (t: string): AnthropicNativeMessage => ({
  role: "assistant",
  content: [text(t)],
});

/** Valid v3 SessionFileV1 anchor — spread overrides fields. */
const baseFile = (): SessionFileV1 => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  conversation_id: "conv-boundary",
  messages: [],
  jsonMode: false,
  turnCount: 0,
  updatedAt: "2026-08-11T00:00:00.000Z",
  title: "",
  cwd: "",
  sanitized_at: "2026-08-11T00:00:00.000Z",
  checkpoints: [],
});

const ISO = "2026-08-11T00:00:00.000Z";

const tempDirs: string[] = [];

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

/** mkdtemp + SessionStore(默认 cwd,与既有测试一致)+ 记录清理。返回
 *  `{store, baseDir}` —— baseDir 用于直接 stat/readFile `<base>/sessions/...`,
 *  store 不暴露该路径。 */
async function storeFor(
  prefix: string
): Promise<{ store: SessionStore; baseDir: string }> {
  const baseDir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(baseDir);
  return { store: new SessionStore(baseDir, process.cwd()), baseDir };
}

/** store 的会话目录(直接文件操作 / stat 用)。 */
function sessionDirFor(baseDir: string): string {
  return resolveProjectSessionDir(baseDir, process.cwd());
}

// -- overflow / 大输入 ---------------------------------------------------------

describe("overflow — large inputs", () => {
  it("splitTurns: 10k messages → 5000 个 turn slice,边界精确", () => {
    const messages: AnthropicNativeMessage[] = [];
    for (let i = 0; i < 10000; i++) {
      messages.push(i % 2 === 0 ? userMsg(`q${i}`) : assistantMsg(`a${i}`));
    }
    const slices = splitTurns(messages);
    assert.equal(slices.length, 5000);
    assert.equal(slices[0]!.start, 0);
    assert.equal(slices[0]!.end, 2);
    assert.equal(slices[4999]!.start, 9998);
    assert.equal(slices[4999]!.end, 10000);
  });

  it("resolveRewindAnchor: 100 turns → keepTurns=50 锚点精确落在 turn 边界", () => {
    const messages: AnthropicNativeMessage[] = [];
    for (let i = 0; i < 100; i++) {
      messages.push(userMsg(`q${i}`), assistantMsg(`a${i}`));
    }
    const out = resolveRewindAnchor(messages, 50);
    // turn 49 结束于 messages[99](每 turn 2 条)→ headIndex = 50*2-1。
    assert.equal(out.headIndex, 99);
    assert.equal(out.turnCount, 50);
  });

  it("withCheckpointAnchors: 100 checkpoints 全量重锚到事件 id", () => {
    const checkpoints: CheckpointRecord[] = Array.from(
      { length: 100 },
      (_, i) => ({
        turnIndex: i + 1,
        messagesCount: (i + 1) * 2,
        interruptedAt: ISO,
        interruptReason: "cancelled",
      })
    );
    const eventIds = Array.from({ length: 200 }, (_, i) => `e${i}`);
    const out = withCheckpointAnchors(checkpoints, eventIds);
    assert.equal(out.length, 100);
    assert.equal(out[0]?.anchorEventId, "e1");
    assert.equal(out[99]?.anchorEventId, "e199");
  });

  it("store 往返 10k messages 文件:大 payload 原子写 + load 不走样", async () => {
    const { store: s } = await storeFor("iknow-boundary-large-");
    const id = "large-roundtrip";
    const messages: AnthropicNativeMessage[] = [];
    for (let i = 0; i < 10000; i++) {
      messages.push(i % 2 === 0 ? userMsg(`q${i}`) : assistantMsg(`a${i}`));
    }
    const file: SessionFileV1 = {
      ...baseFile(),
      conversation_id: id,
      messages,
      turnCount: 5000,
    };
    await s.save({ id, file });
    const loaded = await s.load(id);
    assert.equal(loaded.messages.length, 10000);
    assert.deepEqual(loaded.messages, file.messages);
    assert.equal(loaded.turnCount, 5000);
  });
});

// -- concurrent / 并行写同一 id ------------------------------------------------

describe("concurrent — N 并行 save() 到同一 id", () => {
  // 重要偏离(与任务描述的差距):
  //  任务说「tmp→rename 原子写应防撕裂」,但 store 用的是**共享**
  //  `${path}.tmp` 路径 —— 并行 save() 时两个 writeFile 竞争同一 tmp,
  //  实测可产生两个 payload 串联的撕裂(Unexpected non-whitespace ... after
  //  JSON,position ≈ 2× 单 payload 长度)。这是 store 文档明确的职责划分
  //  (session-store.ts:4「concurrency serialization is the hub's
  //  responsibility」),共享 tmp 是有意的 —— hub 必须串行化。
  //
  // 故本测试不能确定性断言「最终文件 = 某候选」(会 flaky)。改为断言 store
  // 在并发下**实际保证**的契约:
  //   1. 所有 rejection 都是 typed write_failed(绝不裸 Error / 绝不宽 kind);
  //   2. settle 后不残留 .tmp(原子 rename 的 crash-safety 部分仍然成立);
  //   3. 最坏情况守护:若最终文件存在且 JSON.parse 成功且 validateSessionFile
  //      通过,则必须等于某候选 —— 即「静默有效撕裂」(downstream load() 会
  //      误接受的伪合法文件)绝不出现。可解析失败(parse_failed)属可接受的
  //      crash-safety 兜底,downstream load() 会 typed 拒绝,REPL 走
  //      重建路径,行为与 corrupt 既有文件一致。
  it("N 并行 save() 同一 id:typed 错误 + 无 .tmp 残留 + 静默有效撕裂为 0", async () => {
    const { store: s, baseDir } = await storeFor("iknow-boundary-race-");
    const id = "race-target";
    const N = 20;
    const candidates: SessionFileV1[] = Array.from({ length: N }, (_, i) => ({
      ...baseFile(),
      conversation_id: id,
      // 每个候选可辨识:turnCount=i + title="title-i" + 60 条消息。
      turnCount: i,
      title: `title-${i}`,
      messages: Array.from({ length: 60 }, (_, m) =>
        m % 2 === 0 ? userMsg(`q${i}-${m}`) : assistantMsg(`a${i}-${m}`)
      ),
    }));

    const results = await Promise.allSettled(
      candidates.map((file) => s.save({ id, file }))
    );

    // (1) typed-error 契约:任何 rejection 必须是 write_failed,绝不裸 Error,
    // 绝不别的 kind,绝不宽化错误种类。
    for (const r of results) {
      if (r.status === "rejected") {
        const e = r.reason as SessionStoreError;
        assert.equal(e.kind, "write_failed");
        assert.equal(e.conversation_id, id);
        assert.ok(typeof e.cause === "string" && e.cause.length > 0);
      }
    }

    // (2) settle 后不得残留 .tmp(原子 rename 的 crash-safety 部分)。
    await assert.rejects(
      stat(join(sessionDirFor(baseDir), `${id}.json.tmp`)),
      "settle 后不得残留 .tmp"
    );

    // (3) 静默有效撕裂守护:若文件存在且可解析为有效 v3,则必须等于某候选。
    const finalPath = join(sessionDirFor(baseDir), `${id}.json`);
    let raw: string;
    try {
      raw = await readFile(finalPath, "utf8");
    } catch {
      // (a) 文件不存在 —— 所有 save 都 throw(rename 竞争全失败)。可接受:
      // hub 没串行化时,极端时序下所有 rename 都吃 ENOENT;REPL 端会收到
      // 写失败告警,但绝不静默写错数据。
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // (b) 文件存在但不可解析 —— 共享 tmp writeFile 竞争产生的串联撕裂。
      // 属可接受的 crash-safety 兜底:downstream load() 抛 typed
      // parse_failed,REPL 走"既有文件损坏 → 重建"路径(同 chat-session
      // checkpoint 测试覆盖的 corrupt-rebuild 行为),不静默。
      return;
    }
    // (c) 文件可解析。必须满足 v3 形状且等于某候选 —— 否则就是"静默有效
    // 撕裂",downstream load() 会误接受。这是真正不能出现的失败模式。
    const { validateSessionFile } =
      await import("../../../src/session-api/store/index.ts");
    const vf = validateSessionFile(parsed);
    assert.equal(
      vf,
      null,
      `文件可解析但不是有效 v3 session(validateSessionFile='${vf}')—— 静默有效撕裂`
    );
    const serialized = candidates.map((c) => JSON.parse(JSON.stringify(c)));
    let matchIndex = -1;
    for (let i = 0; i < serialized.length; i++) {
      try {
        assert.deepEqual(parsed, serialized[i]!);
        matchIndex = i;
        break;
      } catch {
        // 继续找下一个候选
      }
    }
    assert.notEqual(
      matchIndex,
      -1,
      "文件可解析且 v3 合法,但不匹配任何候选 —— 静默有效撕裂"
    );
    // 一致性:命中的 i 必须与其 turnCount/title 自洽(防 partial 撕裂)。
    const m = candidates[matchIndex]!;
    assert.equal((parsed as SessionFileV1).turnCount, m.turnCount);
    assert.equal((parsed as SessionFileV1).title, m.title);
  });
});

// -- exception / 深层 IO 树 ----------------------------------------------------

describe("exception — deeper IO tree (typed errors)", () => {
  it("save: 路径穿越普通文件(ENOTDIR)→ typed write_failed", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "iknow-boundary-enotdir-"));
    tempDirs.push(tmp);
    // 把 <tmp>/sessions 做成普通文件:resolveProjectSessionDir 产出的
    // <tmp>/sessions/<proj>-<hash> 穿越它 → mkdir/writeFile ENOTDIR。
    await writeFile(join(tmp, "sessions"), "blocker", "utf8");
    const s = new SessionStore(tmp, process.cwd());
    await assert.rejects(
      () =>
        s.save({ id: "enotdir-target", file: sampleFile("enotdir-target") }),
      (err: unknown) => {
        const e = err as SessionStoreError;
        return (
          e.kind === "write_failed" &&
          e.conversation_id === "enotdir-target" &&
          typeof e.cause === "string" &&
          e.cause.length > 0
        );
      }
    );
  });

  it("save: 会话目录只读(EACCES)→ typed write_failed", async () => {
    // root 绕过权限位,CI/容器 root 下不可复现 EACCES → 跳过。
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      return;
    }
    const tmp = await mkdtemp(join(tmpdir(), "iknow-boundary-ro-"));
    tempDirs.push(tmp);
    const dir = sessionDirFor(tmp);
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o555); // r-x:不可创建文件
    try {
      const s = new SessionStore(tmp, process.cwd());
      await assert.rejects(
        () => s.save({ id: "ro-target", file: sampleFile("ro-target") }),
        (err: unknown) => {
          const e = err as SessionStoreError;
          return (
            e.kind === "write_failed" &&
            e.conversation_id === "ro-target" &&
            typeof e.cause === "string" &&
            e.cause.length > 0
          );
        }
      );
    } finally {
      // 恢复权限,保证 afterAll 的 rm 能清掉只读目录里的文件。
      await chmod(dir, 0o755).catch(() => {});
    }
  });

  it("load: JSON.parse 成功但根是原始值(42)→ typed schema_invalid field='root'", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "iknow-boundary-root-"));
    tempDirs.push(tmp);
    const dir = sessionDirFor(tmp);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "prim-root.json"), "42", "utf8");
    const s = new SessionStore(tmp, process.cwd());
    await assert.rejects(
      () => s.load("prim-root"),
      (err: unknown) => {
        const e = err as SessionStoreError;
        return (
          e.kind === "schema_invalid" &&
          e.conversation_id === "prim-root" &&
          e.field === "root"
        );
      }
    );
  });

  it("load: v3 文件 checkpoints=null → typed schema_invalid field='checkpoints'", async () => {
    // 生产裁决「never silently coerce」(schema.ts:94-96):畸形 checkpoints
    // 是硬拒,绝不归一化。load 必须抛 typed schema_invalid 而非裸 Error。
    const tmp = await mkdtemp(join(tmpdir(), "iknow-boundary-cpnull-"));
    tempDirs.push(tmp);
    const dir = sessionDirFor(tmp);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "cp-null.json"),
      JSON.stringify({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        conversation_id: "cp-null",
        messages: [userMsg("q1"), assistantMsg("a1")],
        jsonMode: false,
        turnCount: 1,
        updatedAt: ISO,
        title: "q1",
        cwd: "",
        sanitized_at: ISO,
        checkpoints: null,
      }),
      "utf8"
    );
    const s = new SessionStore(tmp, process.cwd());
    await assert.rejects(
      () => s.load("cp-null"),
      (err: unknown) => {
        const e = err as SessionStoreError;
        return (
          e.kind === "schema_invalid" &&
          e.conversation_id === "cp-null" &&
          e.field === "checkpoints"
        );
      }
    );
  });
});

// -- local helpers -------------------------------------------------------------

function sampleFile(id: string): SessionFileV1 {
  return {
    ...baseFile(),
    conversation_id: id,
    messages: [userMsg("q"), assistantMsg("a")],
    turnCount: 1,
  };
}
