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
    // `~/foo.ts` must resolve to $HOME, not to a literal `~` directory under the project root
    const root = await makeScratch("aci-helper-root-");
    const home = homedir();
    const expected = join(home, "foo.ts");
    let resolved: string;
    if (await exists(expected)) {
      // safe path: the file already exists under home → assert directly
      resolved = await resolveWithinRoot(root, "~/foo.ts");
    } else {
      // not under home → resolveWithinRoot throws "outside workspace".
      // We use that to assert it did not treat `~` as a literal directory inside the
      // workspace (i.e. did not resolve to <root>/~/<user>/foo.ts) but expanded ~ to $HOME.
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
    // The session tmp dir itself is also a legal write target (an independent containment root).
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
// (ADR-0037) path-outside error text must name the current write root so the
// model can retry with a relative path. After rebinding, `root` IS the live
// `taskRoot` (= write root), so the text must state "current write root"
// (the old wording only listed "not under <root>" with no retry guidance).
//
// Five boundary classes self-checked:
//   - empty: text still contains the root string (no information lost);
//   - negative: relative traversal (e.g. `../escape`) also contains the root string;
//   - overflow: a very long root appears in full (not truncated);
//   - concurrent: repeated serial calls never contaminate each other's text;
//   - exception: traversal that extraWriteRoots cannot rescue still contains the root string.
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveWithinRoot — T3 path-outside 文案含当前写根 (ADR-0037 §4 (e))", () => {
  it("absolute path outside: 文案含 'current write root: <root>' 引导", async () => {
    const root = await makeScratch("aci-helper-wr-abs-");
    const outside = await makeScratch("aci-helper-wr-out-");
    await assert.rejects(
      resolveWithinRoot(root, join(outside, "file.ts")),
      (error: unknown) => {
        if (!(error instanceof ToolExecutionError)) return false;
        // the text must contain the write-root path itself + the "current write root" marker
        // (so the model can retry with a relative path)
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
    // overflow target: the root string appears in full in the text (never truncated to meaninglessness).
    // Keep root within the OS PATH_MAX but build a genuinely long directory chain
    // (30 levels * 8 chars = 240-char effective path, enough to verify the "not truncated" semantics).
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
    // The text must explicitly contain the 'current write root' marker + the longTail (proving
    // the very long root was not truncated).
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
    // Two serial calls; each text must contain the same root.
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
// (ADR-0092, hardened variant) path-outside rejection text splits by target
// shape — delivery traversal keeps the taskRoot retry guidance (ADR-0037);
// when OS `/tmp` is rejected, point instead at the expanded `$TMPDIR` absolute
// path of this identity's session tmp dir and drop the "retry relative to
// taskRoot" hint (a draft escape is not a delivery problem). Only when
// `<sessionScratch>/X` already exists on the pad, add the neighbor canonical
// path — still no aliasing: no read, no write, no redirect, just a text hint;
// pad content must stay unchanged.
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
    // no aliasing: the rejection itself must not create the file on the pad.
    assert.equal(await exists(join(pad, "draft.txt")), false);
  });

  it("非 /tmp 交付越界且有垫底: 文案仍含 current write root + taskRoot 重试引导", async () => {
    const parent = await makeScratch("aci-helper-t2-deliv-");
    const root = join(parent, "root");
    await mkdir(root);
    // The text embeds the realpath-resolved write root — assert with the same canonical
    // form (so hosts where tmpdir contains symlinks don't false-fail).
    const realRoot = await realpath(root);
    const pad = await makeScratch("aci-helper-t2-deliv-pad-");
    // The target's real parent exists (/etc) and sits outside OS /tmp and the session tmp dir → the delivery-escape face.
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
    // Just a text hint: no read, no write, no redirect — pad content stays byte-identical.
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
        // Neighbor existence only considers relative segments of the rejected path itself;
        // "/tmp/" has none → must not surface the pad's coincidental ok.txt as a neighbor hint.
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
// Write/read/edit/search workspace resolution is relative to the live taskRoot.
// When the first segment of a relative path, or an absolute prefix, equals the
// current tree leaf / tree path → strip it before resolving; absolute paths
// already under taskRoot are not re-joined. The rule only applies when the root
// is a task-worktree shape (main checkout behavior byte-identical), and after
// stripping the result must still pass existing containment — no escape hatch
// for same-name nesting (when a same-named dir truly exists in the tree, same result).
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveWithinRoot — task worktree leaf echo (Locked sentence 4)", () => {
  const LEAF = "ai-news-digest";

  /** Live taskRoot shape: `<repo>/.iknow/worktrees/<leaf>` (isTaskWorktreePath SSOT). */
  async function makeTree(): Promise<string> {
    const repo = await makeScratch("aci-helper-tree-");
    const tree = join(repo, ".iknow", "worktrees", LEAF);
    await mkdir(tree, { recursive: true });
    return tree;
  }

  it("relative leaf-prefixed path and the bare path resolve to the same tree-root file", async () => {
    const tree = await makeTree();
    await writeFile(join(tree, "index.html"), "tree root\n");
    // A same-named nested dir really exists (with different content): the leaf echo still points at the tree root, no escape hatch.
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

    // Absolute form = tree-path prefix + leaf echo (the absolute spelling of the relative strip-leaf form).
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
    // A missing write target (nearest existing ancestor = tree root) is likewise returned byte-identical.
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

    // A normalized path must not bypass leaf-stripping via the `./` prefix and land in the same-named nested dir.
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

    // The criterion is "after lexical normalization the first segment equals the leaf": no
    // equivalent spelling may fall back into the nested dir, otherwise a one-char prefix would bypass leaf-stripping.
    assert.equal(
      await resolveWithinRoot(tree, `sub/../${LEAF}/index.html`),
      join(tree, "index.html")
    );
  });

  it("the bare leaf itself is left alone (prefix form only)", async () => {
    const tree = await makeTree();
    // A lone `ai-news-digest` segment is not an echo: when a same-named dir really exists in the
    // tree, resolve to it as before; when missing, join under the tree root by the existing rule — neither is "stripped to empty".
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
    // Same-named dir in the main checkout: root is not a task-worktree shape → no stripping.
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

    // $HOME is not inside the tree → whether or not ~/foo.ts exists, it must be rejected with
    // the existing outside-root text; prefix stripping must never rewrite it into a tree-relative path.
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
    // Before firing SIGTERM we must wait for sh to install `trap '' TERM`, otherwise during the
    // spawn→exec startup window SIGTERM hits sh before the trap is in place and close reports SIGTERM.
    // sh writes its own pid to the marker only after the trap, so waitForPidFile acts as the determinism barrier.
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

    // The exact result, including the cleanup evidence: a natural exit never
    // requested a teardown, so it must not claim one.
    assert.deepEqual(await done, {
      code: 7,
      signal: null,
      stdout: "out",
      stderr: "err",
      cleanup: { state: "not_started" },
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
  // These assertions migrated from tools-mutating.test.ts (deleted) when lintPatch moved from
  // the old tool files to helpers.ts; write-tool unit coverage is carried by edit-file.test.ts /
  // bash.test.ts, and this group keeps the lintPatch unit coverage (state-machine correctness +
  // Windows path literals).
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
    // string literal "a \\\" b" carries an inner \" escape that must not break pairing
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
