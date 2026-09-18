import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "vitest";

import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import {
  lintPatch,
  resolveWithinRoot,
  spawnWithStopSignal,
  truncateByCodePoint,
} from "../../../../src/harness/aci/tools/helpers.ts";
import { waitForPidFile, waitForProcessExit } from "./spawn-test-utils.ts";

const scratchPaths: string[] = [];

async function makeScratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

afterEach(async () => {
  await Promise.all(
    scratchPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("resolveWithinRoot", () => {
  it("resolves an existing file inside the real workspace root", async () => {
    const root = await makeScratch("aci-helper-root-");
    const file = join(root, "src", "index.ts");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "export {};\n");

    assert.equal(await resolveWithinRoot(root, "src/index.ts"), file);
  });

  it("resolves a missing write target through its existing parent chain", async () => {
    const root = await makeScratch("aci-helper-root-");
    await mkdir(join(root, "existing"));

    assert.equal(
      await resolveWithinRoot(root, "existing/new/deep/file.ts"),
      join(root, "existing", "new", "deep", "file.ts")
    );
  });

  it("rejects an absolute path outside the workspace", async () => {
    const root = await makeScratch("aci-helper-root-");
    const outside = await makeScratch("aci-helper-outside-");

    await assert.rejects(
      resolveWithinRoot(root, join(outside, "file.ts")),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("outside workspace")
    );
  });

  it("rejects a relative parent traversal outside the workspace", async () => {
    const parent = await makeScratch("aci-helper-parent-");
    const root = join(parent, "root");
    await mkdir(root);

    await assert.rejects(
      resolveWithinRoot(root, "../outside.ts"),
      ToolExecutionError
    );
  });

  it("rejects a symlink whose real target is outside the workspace", async () => {
    const root = await makeScratch("aci-helper-root-");
    const outside = await makeScratch("aci-helper-outside-");
    await symlink(outside, join(root, "escape"), "dir");

    await assert.rejects(
      resolveWithinRoot(root, "escape/file.ts"),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("outside workspace")
    );
  });

  it("expands a leading ~ to the home directory (not the workspace)", async () => {
    // W4: `~/foo.ts` 必须解析到 $HOME 而非项目根下的字面 `~` 目录
    const root = await makeScratch("aci-helper-root-");
    const home = homedir();
    const expected = join(home, "foo.ts");
    let resolved: string;
    if (await exists(expected)) {
      // 安全路径:home 下已存在该文件 → 直接断言
      resolved = await resolveWithinRoot(root, "~/foo.ts");
    } else {
      // home 下不存在 → resolveWithinRoot 会因 "outside workspace" 抛出。
      // 我们借此断言:它没有把 `~` 当字面目录建到工作区里(即没解析成
      // <root>/~/<user>/foo.ts),而是把 ~ 展开到了 $HOME。
      await assert.rejects(
        resolveWithinRoot(root, "~/foo.ts"),
        ToolExecutionError
      );
      return;
    }
    assert.equal(resolved, expected);
  });

  it("extraWriteRoots: allows write target inside an extra root", async () => {
    const root = await makeScratch("aci-helper-root-");
    const extra = await makeScratch("aci-helper-extra-");
    await mkdir(join(extra, "sub"));
    const target = join(extra, "sub", "new.ts");

    assert.equal(
      await resolveWithinRoot(root, target, undefined, [extra]),
      target
    );
  });

  it("extraWriteRoots: rejects target outside primary AND extra roots", async () => {
    const root = await makeScratch("aci-helper-root-");
    const extra = await makeScratch("aci-helper-extra-");
    const outside = await makeScratch("aci-helper-outside-");

    await assert.rejects(
      resolveWithinRoot(root, join(outside, "file.ts"), undefined, [extra]),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("outside workspace")
    );
  });

  it("extraWriteRoots: rejects a symlink escaping the extra root", async () => {
    const root = await makeScratch("aci-helper-root-");
    const extra = await makeScratch("aci-helper-extra-");
    const outside = await makeScratch("aci-helper-outside-");
    await symlink(outside, join(extra, "escape"), "dir");

    await assert.rejects(
      resolveWithinRoot(root, join(extra, "escape", "file.ts"), undefined, [
        extra,
      ]),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("outside workspace")
    );
  });

  it("sessionTmpRoot: an absolute path inside the session tmp host dir is allowed", async () => {
    const root = await makeScratch("aci-helper-tmp-root-");
    const pad = await makeScratch("aci-helper-tmp-pad-");

    assert.equal(
      await resolveWithinRoot(root, join(pad, "ok.txt"), {
        sessionTmpRoot: pad,
      }),
      join(pad, "ok.txt")
    );
    // 会话 tmp 目录自身也是一个合法的写目标(独立 containment root)。
    assert.equal(
      await resolveWithinRoot(root, pad, { sessionTmpRoot: pad }),
      pad
    );
  });

  it("sessionTmpRoot: a model-supplied guest /tmp/... is typed-rejected (no alias to the pad)", async () => {
    const root = await makeScratch("aci-helper-tmp-neg-root-");
    const pad = await makeScratch("aci-helper-tmp-neg-pad-");

    await assert.rejects(
      resolveWithinRoot(root, "/tmp/ok.txt", { sessionTmpRoot: pad }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("outside workspace")
    );
    await assert.rejects(
      resolveWithinRoot(root, "/tmp/", { sessionTmpRoot: pad }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("outside workspace")
    );
  });

  it("sessionTmpRoot: relative path under taskRoot is not remapped", async () => {
    const root = await makeScratch("aci-helper-tmp-rel-root-");
    const pad = await makeScratch("aci-helper-tmp-rel-pad-");
    await writeFile(join(root, "kept.txt"), "in-root\n");

    assert.equal(
      await resolveWithinRoot(root, "kept.txt", { sessionTmpRoot: pad }),
      join(root, "kept.txt")
    );
  });

  it("sessionTmpRoot: /tmp/../ escape leaving guest /tmp still fails containment", async () => {
    const root = await makeScratch("aci-helper-tmp-esc-root-");
    const pad = await makeScratch("aci-helper-tmp-esc-pad-");

    await assert.rejects(
      resolveWithinRoot(root, "/tmp/../etc/passwd", { sessionTmpRoot: pad }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("outside workspace")
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T3 (plans/891-taskroot-remaining-consumers.md Task 3 / ADR-0037 §4 (e)):
// path-outside 错误文案必须含当前写根，使模型能用相对路径重试。改绑后
// `root` 即活 `taskRoot` (= 写根)，文案必须明示「current write root」以让
// 模型用相对路径重试（现有文字只列「not under <root>」，不带 remap 引导）。
//
// 五类边界自检（empty / negative / overflow / concurrent / exception）：
//   - empty: 文案仍含 root 字符串（不丢信息）；
//   - negative: 相对路径越界（如 `../escape`）同样含 root 字符串；
//   - overflow: 极长 root 完整出现（不被截断）；
//   - concurrent: 多次串行调用，每次文案互不污染；
//   - exception: extraWriteRoots 救不回的越界文案仍含 root 字符串。
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveWithinRoot — T3 path-outside 文案含当前写根 (ADR-0037 §4 (e))", () => {
  it("absolute path outside: 文案含 'current write root: <root>' 引导", async () => {
    const root = await makeScratch("aci-helper-wr-abs-");
    const outside = await makeScratch("aci-helper-wr-out-");
    await assert.rejects(
      resolveWithinRoot(root, join(outside, "file.ts")),
      (error: unknown) => {
        if (!(error instanceof ToolExecutionError)) return false;
        // 文案必须含写根路径本身 + "current write root" 标识
        // (模型据此用相对路径重试)
        return (
          error.message.includes("current write root") &&
          error.message.includes(root)
        );
      }
    );
  });

  it("relative traversal outside: 文案仍含 'current write root: <root>'", async () => {
    const parent = await makeScratch("aci-helper-wr-rel-");
    const root = join(parent, "root");
    await mkdir(root);
    await assert.rejects(
      resolveWithinRoot(root, "../escape.ts"),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("current write root") &&
        error.message.includes(root)
    );
  });

  it("symlink escape: 文案仍含 'current write root: <root>'", async () => {
    const root = await makeScratch("aci-helper-wr-sym-");
    const outside = await makeScratch("aci-helper-wr-sym-out-");
    await symlink(outside, join(root, "escape"), "dir");
    await assert.rejects(
      resolveWithinRoot(root, "escape/file.ts"),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("current write root")
    );
  });

  it("overflow: 极长 root 完整出现在文案中（不被 truncate 截断到无意义）", async () => {
    // overflow 验证目标：文案里 root 字符串完整出现（不被截断到无意义）。
    // 将 root 控制在 OS PATH_MAX 之内,但构造一条足够长的真实目录链
    // （30 层 * 8 字符 = 240 字符的有效路径长度，足以验证"不被截断"语义）。
    const realRoot = await makeScratch("aci-helper-wr-overflow-");
    const longTail = Array.from({ length: 30 }, () => "abcdefgh").join("/");
    const longRoot = join(realRoot, longTail);
    await mkdir(longRoot, { recursive: true });
    const outside = await makeScratch("aci-helper-wr-overflow-out-");
    let captured = "";
    await assert.rejects(
      resolveWithinRoot(longRoot, join(outside, "file.ts")),
      (error: unknown) => {
        if (!(error instanceof ToolExecutionError)) return false;
        captured = error.message;
        return true;
      }
    );
    // 文案必须显式含 'current write root' 标识 + 含 longTail 的尾部（证明
    // 极长 root 没被截断）。
    assert.ok(
      captured.includes("current write root"),
      "极长 root 路径必须含 'current write root' 标识"
    );
    assert.ok(
      captured.includes(longTail),
      "极长 root 路径必须含完整 longTail（不被截断）"
    );
  });

  it("concurrent / 重复调用: 每次文案独立且含 root 字符串", async () => {
    const root = await makeScratch("aci-helper-wr-conc-");
    const outside1 = await makeScratch("aci-helper-wr-conc-1-");
    const outside2 = await makeScratch("aci-helper-wr-conc-2-");
    // 串行两次,各自文案必须含同一 root。
    for (const outside of [outside1, outside2]) {
      await assert.rejects(
        resolveWithinRoot(root, join(outside, "file.ts")),
        (error: unknown) =>
          error instanceof ToolExecutionError &&
          error.message.includes("current write root") &&
          error.message.includes(root)
      );
    }
  });

  it("exception / extraWriteRoots 救不回: 文案仍含 'current write root: <root>'", async () => {
    const root = await makeScratch("aci-helper-wr-exw-");
    const extra = await makeScratch("aci-helper-wr-exw-extra-");
    const outside = await makeScratch("aci-helper-wr-exw-out-");
    await assert.rejects(
      resolveWithinRoot(root, join(outside, "file.ts"), undefined, [extra]),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("current write root") &&
        error.message.includes(root)
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T2 / T3 (plans/session-scratch-path-space.md / 加强版 A / ADR-0092 SC4):
// path-outside 拒绝文案按目标形态劈 EXIT —— 交付越界保持 taskRoot 重试引导
// (ADR-0037 §4 (e))；OS `/tmp` 被拒时改指本身份会话 tmp 的展开 `$TMPDIR`
// 绝对路径、不再要求「相对 taskRoot 重试」（草稿越界不是交付问题）。仅当
// 垫底上 `<sessionScratch>/X` 已存在时补近邻 canonical 路径 —— 仍不 alias：
// 不读不写不重定向，只是文案提示，垫底内容必须不变。
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveWithinRoot — T2 path-outside 文案按目标劈 EXIT (ADR-0092 SC4 / 加强版 A)", () => {
  it("/tmp 被拒且有垫底: 文案含展开的垫底绝对路径，不含 taskRoot 重试引导，文件不落垫底", async () => {
    const root = await makeScratch("aci-helper-t2-tmp-root-");
    const pad = await makeScratch("aci-helper-t2-tmp-pad-");
    const realPad = await realpath(pad);

    await assert.rejects(
      resolveWithinRoot(root, "/tmp/draft.txt", { sessionTmpRoot: pad }),
      (error: unknown) => {
        if (!(error instanceof ToolExecutionError)) return false;
        return (
          error.message.includes("outside workspace") &&
          error.message.includes(realPad) &&
          !error.message.includes("Retry with a path relative to the taskRoot")
        );
      }
    );
    // SC4 不 alias：拒绝本身不得在垫底制造该文件。
    assert.equal(await exists(join(pad, "draft.txt")), false);
  });

  it("非 /tmp 交付越界且有垫底: 文案仍含 current write root + taskRoot 重试引导", async () => {
    const parent = await makeScratch("aci-helper-t2-deliv-");
    const root = join(parent, "root");
    await mkdir(root);
    // 文案嵌入的是 realpath 后的写根 —— 断言用同一 canonical 口径
    // （tmpdir 含 symlink 的宿主上不假失败）。
    const realRoot = await realpath(root);
    const pad = await makeScratch("aci-helper-t2-deliv-pad-");
    // 目标真实存在父目录（/etc）且落在 OS /tmp 与会话 tmp 之外 → 交付越界面。
    const outside = "/etc/iknow-t2-delivery-miss.txt";

    await assert.rejects(
      resolveWithinRoot(root, outside, { sessionTmpRoot: pad }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("current write root") &&
        error.message.includes(realRoot) &&
        error.message.includes("Retry with a path relative to the taskRoot")
    );
  });

  it("无垫底解析结果时 /tmp 拒绝退化为既有交付越界文案（可观察，legacy 调用面不变）", async () => {
    const root = await makeScratch("aci-helper-t2-nopad-root-");

    await assert.rejects(
      resolveWithinRoot(root, "/tmp/draft.txt"),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("current write root") &&
        error.message.includes("Retry with a path relative to the taskRoot")
    );
  });
});

describe("resolveWithinRoot — T3 拒 /tmp/X 且垫底已有 X 时给近邻路径", () => {
  it("垫底有 ok.txt: 文案含垫底上该文件的 canonical 绝对路径，且不动垫底内容", async () => {
    const root = await makeScratch("aci-helper-t3-nm-root-");
    const pad = await makeScratch("aci-helper-t3-nm-pad-");
    const realPad = await realpath(pad);
    await writeFile(join(pad, "ok.txt"), "pad-content\n");

    let captured = "";
    await assert.rejects(
      resolveWithinRoot(root, "/tmp/ok.txt", { sessionTmpRoot: pad }),
      (error: unknown) => {
        if (!(error instanceof ToolExecutionError)) return false;
        captured = error.message;
        return true;
      }
    );
    assert.ok(
      captured.includes(join(realPad, "ok.txt")),
      "近邻提示必须给垫底上该文件的 canonical 宿主绝对路径"
    );
    assert.ok(
      !captured.includes("Retry with a path relative to the taskRoot"),
      "草稿越界不许再引导相对 taskRoot 重试"
    );
    // 只是文案提示：不读不写不重定向，垫底内容逐字节不变。
    assert.equal(await readFile(join(pad, "ok.txt"), "utf8"), "pad-content\n");
  });

  it("垫底无该文件: 只给展开 $TMPDIR，不得把不存在路径写成近邻指引", async () => {
    const root = await makeScratch("aci-helper-t3-abs-root-");
    const pad = await makeScratch("aci-helper-t3-abs-pad-");
    const realPad = await realpath(pad);

    let captured = "";
    await assert.rejects(
      resolveWithinRoot(root, "/tmp/absent.txt", { sessionTmpRoot: pad }),
      (error: unknown) => {
        if (!(error instanceof ToolExecutionError)) return false;
        captured = error.message;
        return true;
      }
    );
    assert.ok(captured.includes(realPad));
    assert.ok(
      !captured.includes(join(realPad, "absent.txt")),
      "垫底不存在的文件不得以路径形式指引模型去读"
    );
    assert.ok(!captured.includes("Retry with a path relative to the taskRoot"));
  });

  it("被拒目标是 /tmp 本身（无 X 段）: 只指垫底根，不出现近邻文件指引", async () => {
    const root = await makeScratch("aci-helper-t3-dir-root-");
    const pad = await makeScratch("aci-helper-t3-dir-pad-");
    const realPad = await realpath(pad);
    await writeFile(join(pad, "ok.txt"), "pad-content\n");

    await assert.rejects(
      resolveWithinRoot(root, "/tmp/", { sessionTmpRoot: pad }),
      (error: unknown) => {
        if (!(error instanceof ToolExecutionError)) return false;
        // 近邻存在性只针对被拒路径自身的相对段；"/tmp/" 无段 → 不得把
        // 垫底里碰巧存在的 ok.txt 当近邻提示出去。
        return (
          error.message.includes(realPad) &&
          !error.message.includes(join(realPad, "ok.txt")) &&
          !error.message.includes("Retry with a path relative to the taskRoot")
        );
      }
    );
    assert.equal(await readFile(join(pad, "ok.txt"), "utf8"), "pad-content\n");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T4 (plans/session-fg-handoff-interrupt.md Locked sentence 4 / ADR-0037 §4):
// 写/读/改/搜 的 workspace 解析相对活 taskRoot。相对路径第一段、或绝对前缀，
// 等于当前树 leaf / 树路径 → 剥掉再解析；已在 taskRoot 下的绝对路径不再 join。
// 判定只在根是 task worktree 形状时生效（主 checkout 逐字节不变），且剥完仍要
// 过既有 containment —— 不为同名套娃留逃生口（树内真有同名目录时同一结果）。
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveWithinRoot — task worktree leaf echo (Locked sentence 4)", () => {
  const LEAF = "ai-news-digest";

  /** 活 taskRoot 形状：`<repo>/.iknow/worktrees/<leaf>`（isTaskWorktreePath SSOT）。 */
  async function makeTree(): Promise<string> {
    const repo = await makeScratch("aci-helper-tree-");
    const tree = join(repo, ".iknow", "worktrees", LEAF);
    await mkdir(tree, { recursive: true });
    return tree;
  }

  it("relative leaf-prefixed path and the bare path resolve to the same tree-root file", async () => {
    const tree = await makeTree();
    await writeFile(join(tree, "index.html"), "tree root\n");
    // 同名套娃目录真的存在（内含不同正文）：leaf 回显仍指树根，无逃生口。
    await mkdir(join(tree, LEAF), { recursive: true });
    await writeFile(join(tree, LEAF, "index.html"), "nested decoy\n");

    assert.equal(
      await resolveWithinRoot(tree, `${LEAF}/index.html`),
      join(tree, "index.html")
    );
    assert.equal(
      await resolveWithinRoot(tree, "index.html"),
      join(tree, "index.html")
    );
  });

  it("the absolute form of a leaf-prefixed path resolves to the same tree-root file", async () => {
    const tree = await makeTree();
    await writeFile(join(tree, "index.html"), "tree root\n");

    // 绝对形态 = 树路径前缀 + leaf 回显（相对剥叶形态的绝对写法）。
    assert.equal(
      await resolveWithinRoot(tree, join(tree, LEAF, "index.html")),
      join(tree, "index.html")
    );
  });

  it("an absolute path already inside the tree is returned unchanged (no re-join, no rewrite)", async () => {
    const tree = await makeTree();
    await mkdir(join(tree, "src"), { recursive: true });
    await writeFile(join(tree, "src", "page.ts"), "export {};\n");
    const kept = join(tree, "src", "page.ts");

    assert.equal(await resolveWithinRoot(tree, kept), kept);
    // 缺失写目标（最近存在祖先 = 树根）同样逐字节不变。
    assert.equal(
      await resolveWithinRoot(tree, join(tree, "assets", "new.css")),
      join(tree, "assets", "new.css")
    );
  });

  it("a ./ prefixed leaf echo is stripped too (no decoy escape hatch)", async () => {
    const tree = await makeTree();
    await writeFile(join(tree, "index.html"), "tree root\n");
    await mkdir(join(tree, LEAF), { recursive: true });
    await writeFile(join(tree, LEAF, "index.html"), "nested decoy\n");

    // 已归一化路径不得因 `./` 前缀绕过剥叶而落进同名套娃目录。
    assert.equal(
      await resolveWithinRoot(tree, `./${LEAF}/index.html`),
      join(tree, "index.html")
    );
  });

  it("a lexically equivalent spelling of the echo is stripped (normalize-then-judge)", async () => {
    const tree = await makeTree();
    await writeFile(join(tree, "index.html"), "tree root\n");
    await mkdir(join(tree, LEAF), { recursive: true });
    await writeFile(join(tree, LEAF, "index.html"), "nested decoy\n");

    // 判据是「词法归一化后第一段等于 leaf」：任何等价写法都不许落回套娃目录，
    // 否则一个字符的前缀就能绕过剥叶。
    assert.equal(
      await resolveWithinRoot(tree, `sub/../${LEAF}/index.html`),
      join(tree, "index.html")
    );
  });

  it("the bare leaf itself is left alone (prefix form only)", async () => {
    const tree = await makeTree();
    // `ai-news-digest` 单独一段不是回显：树内真有同名目录时照旧解析到它，
    // 缺失则按既有规则拼到树根下 —— 两者都不是「剥成空路径」。
    await mkdir(join(tree, LEAF), { recursive: true });
    assert.equal(await resolveWithinRoot(tree, LEAF), join(tree, LEAF));
    assert.equal(
      await resolveWithinRoot(tree, `${LEAF}/new.html`),
      join(tree, "new.html")
    );
  });

  it("an empty path still resolves to the tree root itself", async () => {
    const tree = await makeTree();

    assert.equal(await resolveWithinRoot(tree, ""), tree);
  });

  it("a non-worktree root does not strip a same-named first segment", async () => {
    const repo = await makeScratch("aci-helper-main-");
    // 主 checkout 里同名目录：根不是 task worktree 形状 → 不剥。
    const root = join(repo, LEAF);
    await mkdir(join(root, LEAF), { recursive: true });
    await writeFile(join(root, LEAF, "index.html"), "real subdir\n");

    assert.equal(
      await resolveWithinRoot(root, `${LEAF}/index.html`),
      join(root, LEAF, "index.html")
    );
  });

  it("strip-then-escape is still typed-rejected with the existing outside-root message", async () => {
    const tree = await makeTree();

    await assert.rejects(
      resolveWithinRoot(tree, `${LEAF}/../..`),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("outside workspace") &&
        error.message.includes("current write root")
    );
  });

  it("~/... is still expanded to home, never rewritten into the tree", async () => {
    const tree = await makeTree();

    // $HOME 不在树内 → 无论 ~/foo.ts 是否存在，都必须按既有越界文案拒绝，
    // 不得因剥前缀被改写成树内相对路径。
    await assert.rejects(
      resolveWithinRoot(tree, "~/foo.ts"),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("outside workspace") &&
        error.message.includes("current write root")
    );
  });
});

describe("truncateByCodePoint", () => {
  it("truncates ASCII by character count", () => {
    assert.equal(truncateByCodePoint("abcdef", 3), "abc");
  });

  it("returns the empty string unchanged", () => {
    assert.equal(truncateByCodePoint("", 4), "");
  });

  it("does not truncate at the exact boundary", () => {
    assert.equal(truncateByCodePoint("abcd", 4), "abcd");
  });

  it("never returns half of a surrogate pair", () => {
    assert.equal(truncateByCodePoint("😀😀x", 1), "😀");
    assert.deepEqual(Array.from(truncateByCodePoint("a😀b", 2)), ["a", "😀"]);
  });

  it("rejects a negative maximum", () => {
    assert.throws(() => truncateByCodePoint("abc", -1), RangeError);
  });
});

describe("spawnWithStopSignal", () => {
  it("aborts a detached shell process group including its background child", async () => {
    const root = await makeScratch("aci-helper-process-");
    const pidFile = join(root, "child.pid");
    const controller = new AbortController();
    const { child, done } = spawnWithStopSignal(
      "sh",
      ["-c", `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`],
      { cwd: root, signal: controller.signal, killGraceMs: 50 }
    );

    const childPid = await waitForPidFile(pidFile);
    assert.ok(child.pid);
    assert.doesNotThrow(() => process.kill(childPid, 0));

    controller.abort();
    const result = await done;

    assert.notEqual(result.code, 0);
    await waitForProcessExit(childPid);
  }, 5_000);

  it("escalates from SIGTERM to SIGKILL after the configurable grace period", async () => {
    // 触发 SIGTERM 前必须等 sh 装好 `trap '' TERM`,否则在 spawn→exec 的
    // 启动窗口里,SIGTERM 会先于 trap 装入命中 sh,导致 close 报 SIGTERM(issue #199)。
    // sh 在 trap 后才写自己的 pid 到 marker,waitForPidFile 充当确定性屏障。
    const root = await makeScratch("aci-helper-escalate-");
    const trapReadyFile = join(root, "trap-ready");
    const controller = new AbortController();
    const { child, done } = spawnWithStopSignal(
      "sh",
      [
        "-c",
        `trap '' TERM; echo $$ > ${JSON.stringify(trapReadyFile)}; while :; do sleep 1; done`,
      ],
      { cwd: root, signal: controller.signal, killGraceMs: 25 }
    );
    const pid = child.pid;
    assert.ok(pid);

    await waitForPidFile(trapReadyFile);
    controller.abort();
    const result = await done;

    assert.equal(result.code, null);
    assert.equal(result.signal, "SIGKILL");
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  }, 5_000);

  it("collects stdout, stderr, and a normal exit code", async () => {
    const { done } = spawnWithStopSignal(
      "sh",
      ["-c", "printf out; printf err >&2; exit 7"],
      { cwd: tmpdir() }
    );

    assert.deepEqual(await done, {
      code: 7,
      signal: null,
      stdout: "out",
      stderr: "err",
    });
  });

  it("forwards an explicit env to the child so host secrets don't leak (env leak fix, #225)", async () => {
    const root = await makeScratch("aci-helper-env-");
    const { done } = spawnWithStopSignal(
      "sh",
      [
        "-c",
        'test -z "$HOST_SECRET" && echo "secret-absent" && echo "explicit=$EXPLICIT"',
      ],
      { cwd: root, env: { PATH: process.env.PATH ?? "", EXPLICIT: "yes" } }
    );

    const result = await done;
    assert.equal(result.code, 0);
    assert.match(result.stdout, /secret-absent/);
    assert.match(result.stdout, /explicit=yes/);
  });
});

describe("lintPatch", () => {
  // 以下断言从 tools-mutating.test.ts（已删）迁移而来——lintPatch 从
  // 旧工具文件迁到 helpers.ts（T4），写入类工具单元覆盖由 edit-file.test.ts /
  // bash.test.ts 承接，本组断言保留 lintPatch 单元覆盖（状态机正确性 +
  // Windows 路径字面量）。
  it("accepts balanced parentheses / brackets / braces", () => {
    assert.deepEqual(lintPatch("foo(bar) [baz] {qux}"), { ok: true });
  });

  it("rejects unmatched ')' (more close than open)", () => {
    const r = lintPatch("foo(bar))");
    assert.equal(r.ok, false);
    assert.ok(r.reason?.includes("'"));
  });

  it("rejects unmatched ']' at end", () => {
    const r = lintPatch("foo([bar]");
    assert.equal(r.ok, false);
    assert.ok(r.reason?.includes("unmatched"));
  });

  it("rejects unclosed '{' at end of patch", () => {
    const r = lintPatch("function f() { return 1");
    assert.equal(r.ok, false);
    assert.ok(r.reason?.includes("unclosed"));
  });

  it("rejects mismatched pair (')' for '[')", () => {
    const r = lintPatch("[1, 2)");
    assert.equal(r.ok, false);
    assert.ok(r.reason?.includes("expected"));
  });

  it("rejects unclosed double quote", () => {
    const r = lintPatch(`const x = "hello`);
    assert.equal(r.ok, false);
  });

  it("accepts escaped quotes (\\\" / \\' do not break pairing)", () => {
    // 字符串字面量 "a \\\" b" 内部带 \" 转义,不影响配对
    assert.deepEqual(lintPatch(`"a \\\" b"`), { ok: true });
    assert.deepEqual(lintPatch(`'a \\\' b'`), { ok: true });
  });

  it("accepts balanced single quotes", () => {
    assert.deepEqual(lintPatch(`'hello' + "world"`), { ok: true });
  });

  it("accepts empty string", () => {
    assert.deepEqual(lintPatch(""), { ok: true });
  });

  it('accepts `"it\'s a test"` (双引号字符串内的单引号 = 字面量)', () => {
    const r = lintPatch(`"it's a test"`);
    assert.deepEqual(r, { ok: true });
  });

  it('accepts `"C:\\\\Users\\\\x"` (Windows 路径字面量,含 `\\\\` 转义)', () => {
    const r = lintPatch(`"C:\\Users\\x"`);
    assert.deepEqual(r, { ok: true });
  });

  it("accepts nested string: `\"outer 'inner' outer\"`", () => {
    const r = lintPatch(`"outer 'inner' outer"`);
    assert.deepEqual(r, { ok: true });
  });

  it('accepts `"a\\\\b"` (\\\\ 视为字面量反斜杠,不误闭合)', () => {
    const r = lintPatch(`"a\\b"`);
    assert.deepEqual(r, { ok: true });
  });

  it("rejects unclosed single quote", () => {
    const r = lintPatch(`'unclosed`);
    assert.equal(r.ok, false);
    assert.ok(r.reason?.includes("unclosed"));
  });

  it('rejects genuinely mismatched `"a"b` (单引号后无配对)', () => {
    const r = lintPatch(`"a"b'`);
    assert.equal(r.ok, false);
  });

  it("rejects when `\\\\` at end of string leaves trailing backslash", () => {
    const r = lintPatch(`"abc\\`);
    assert.equal(r.ok, false);
  });
});
