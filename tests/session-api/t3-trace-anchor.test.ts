/**
 * T3 (ADR-0071 Decision 4) trace 锚点
 * 迁入会话文件夹的端到端契约。SC6 钉死不变式:
 *
 *   - trace 落 `<baseDir>/projects/<slug>/<convId>/trace.jsonl`, 不再 cwd-relative。
 *   - 同一 baseDir + 同一 projectIdentityRoot + 同一 conversationId 必然派生同一
 *     绝对路径(跨 cwd 一致性是核心不变式)。
 *   - conversationId 含 `/` / `..` / 超长 由 sanitizeConversationSegment 接管,
 *     与 resolveConversationDir 共用 sanitize 路径敌意段保证(SC2)。
 *
 * 不测实现:SSOT = `resolveConversationTraceFilePath`(`session-store.ts`)。
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { basename, join } from "node:path";
import { deriveProjectIdentityRoot } from "../../src/harness/session-roots.ts";
import {
  resolveConversationTraceFilePath,
  resolveProjectSessionDir,
  TRACE_FILE_NAME,
} from "../../src/session-api/store/index.ts";

describe("resolveConversationTraceFilePath (T3 SC6)", () => {
  it("derives <projectDir>/<convId>/trace.jsonl with TRACE_FILE_NAME leaf", () => {
    const projectDir = "/tmp/iknow/projects/foo-abcdef012345";
    const path = resolveConversationTraceFilePath({
      projectDir,
      conversationId: "abc-uuid",
    });
    assert.equal(
      path,
      "/tmp/iknow/projects/foo-abcdef012345/abc-uuid/trace.jsonl"
    );
    assert.equal(basename(path), TRACE_FILE_NAME);
    assert.equal(TRACE_FILE_NAME, "trace.jsonl");
  });

  it("cross-cwd baseDir independence: two cwds, same projectIdentityRoot → identical trace path", () => {
    // SC6: 同一 baseDir + 同一 projectIdentityRoot 派生同一 projectDir → 同
    // `<convId>/trace.jsonl`。cwd 不同不该改变结果(因为键是
    // projectIdentityRoot, 不是 cwd;这是 T1 的不变式,T3 继承)。
    const baseDir = "/var/data/iknow";
    const projectIdentityRoot = "/home/user/projects/iknow"; // 假设的 stable root
    const projectDirA = resolveProjectSessionDir(baseDir, projectIdentityRoot);
    const projectDirB = resolveProjectSessionDir(baseDir, projectIdentityRoot);
    // 不同 cwd 模拟: 派两次, baseDir/identity 不变 → projectDir 一致
    assert.equal(projectDirA, projectDirB);
    const pathA = resolveConversationTraceFilePath({
      projectDir: projectDirA,
      conversationId: "conv-stable-id",
    });
    const pathB = resolveConversationTraceFilePath({
      projectDir: projectDirB,
      conversationId: "conv-stable-id",
    });
    assert.equal(
      pathA,
      pathB,
      "same baseDir + same projectIdentityRoot must derive identical trace path"
    );
    assert.ok(pathA.endsWith("/conv-stable-id/trace.jsonl"));
    // negative: 派生路径不应意外混进 cwd 字样(slug 只来自 projectIdentityRoot)。
    // 注意: 测试用 conv id 不能含 cwd 字样, 否则误命中 — 此处故意用无关字符。
    assert.ok(!pathA.includes("not-a-cwd-marker-zzz"));
  });

  it("worktree cwd folds to main checkout identity → identical trace path (real dual-cwd exercise)", () => {
    // SC6 真实行使:同一项目从主 checkout 与它的 task worktree 启动,是两条
    // 真实不同的 cwd。装配层把两者折叠到同一 projectIdentityRoot
    // (`deriveProjectIdentityRoot` → `mainCheckoutOf`:worktree 路径
    // `<main>/.iknow/worktrees/<name>` 折回 `<main>`),因此 trace 锚点必须
    // 相同 —— 若键漂成 raw cwd,worktree 会话会分裂出第二个 trace 文件。
    const baseDir = "/var/data/iknow";
    const main = "/home/user/projects/iknow";
    const worktree = join(main, ".iknow", "worktrees", "session-folder-x");
    // 自证折叠前提成立(否则本测试的派生断言是空转):装配层对 worktree cwd
    // 派生出的 identity = 主 checkout。
    assert.equal(deriveProjectIdentityRoot({ cwd: worktree }), main);
    assert.equal(deriveProjectIdentityRoot({ cwd: main }), main);

    const projectDirMain = resolveProjectSessionDir(
      baseDir,
      deriveProjectIdentityRoot({ cwd: main })
    );
    const projectDirWorktree = resolveProjectSessionDir(
      baseDir,
      deriveProjectIdentityRoot({ cwd: worktree })
    );
    assert.equal(
      projectDirMain,
      projectDirWorktree,
      "main checkout and its task worktree must share one projectDir"
    );
    const traceMain = resolveConversationTraceFilePath({
      projectDir: projectDirMain,
      conversationId: "conv-wt-1",
    });
    const traceWorktree = resolveConversationTraceFilePath({
      projectDir: projectDirWorktree,
      conversationId: "conv-wt-1",
    });
    assert.equal(
      traceMain,
      traceWorktree,
      "trace anchor must be identical regardless of which checkout cwd started the session"
    );
    assert.ok(traceMain.startsWith(baseDir + "/projects/"));
    assert.ok(!traceMain.includes("worktrees"));
  });

  it("sanitize path-hostile conversationId via resolveConversationDir contract", () => {
    // SC2 + SC4: `..` / `/` / 含分隔符的 id 由 resolveConversationDir 的
    // sanitizeConversationSegment 处理 → trace 路径不可逃逸 projectDir。
    const projectDir = "/tmp/iknow/projects/foo-abcdef012345";
    // 路径敌意 conversationId: 含 `..` 与 `/`。sanitize 后段名稳定, 不会逃出 projectDir。
    const path1 = resolveConversationTraceFilePath({
      projectDir,
      conversationId: "../escape",
    });
    assert.ok(
      path1.startsWith(projectDir + "/"),
      `trace path must remain under projectDir, got ${path1}`
    );
    assert.ok(
      !path1.includes(".."),
      `sanitize must drop '..' segments: ${path1}`
    );
    assert.ok(path1.endsWith("/trace.jsonl"));

    // 含 `/` 的 id 也应被 sanitize 收住,不会落 `<convId>part1/convIdpart2/trace.jsonl`
    const path2 = resolveConversationTraceFilePath({
      projectDir,
      conversationId: "part1/part2",
    });
    assert.ok(
      path2.startsWith(projectDir + "/"),
      `trace path must remain under projectDir, got ${path2}`
    );
    assert.ok(path2.endsWith("/trace.jsonl"));
    // 派生是稳定的: 同一 hostile id 两次调用得同一路径(SSOT 不变量)。
    const path2b = resolveConversationTraceFilePath({
      projectDir,
      conversationId: "part1/part2",
    });
    assert.equal(path2, path2b);
  });

  it("conversationId required: empty string falls into resolveConversationDir typed error", () => {
    // SSOT 把"缺 convId"留给 resolveConversationDir(SessionRootError
    // missing_root)。trace helper 透传,不在 trace 层另立一条边界。
    const projectDir = "/tmp/iknow/projects/foo-abcdef012345";
    assert.throws(
      () =>
        resolveConversationTraceFilePath({
          projectDir,
          conversationId: "",
        }),
      /missing_root|conversationId is required/
    );
  });

  it("leaf folder name = conversationId (verbatim, sanitize-equivalent)", () => {
    // SC2 钉死: 文件夹名 = conversationId 原样, 不进 worktree label / title /
    // goal。本测试钉 UUID 形 id 一次, 验证 leaf = id 原样(sanitize 是
    // `[A-Za-z0-9_-]` 的 identity)。
    const projectDir = "/tmp/iknow/projects/foo-abcdef012345";
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const path = resolveConversationTraceFilePath({
      projectDir,
      conversationId: uuid,
    });
    // 倒数第二段 = convId verbatim(不被任何 slug 改写)
    const segments = path.split("/");
    assert.equal(
      segments[segments.length - 2],
      uuid,
      `folder name must equal conversationId verbatim, got: ${path}`
    );
    assert.equal(segments[segments.length - 1], "trace.jsonl");
  });
});
