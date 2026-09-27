import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  findDangerousPattern,
  findDestructiveOnParse,
  commandContainsSensitivePath,
  legacyFindDangerousPattern,
  type DangerousPatternHit,
} from "../../../src/harness/permission/hard-walls.js";
import { parseForSecurity } from "../../../src/harness/permission/shell-parse.js";

// The destructive rules judge argv and declared code operands off the parse, and
// the live wall now consults them for the whole destructive family; the lexical
// `format` gate is the one entry still answered by the text scan, because its
// carrier is the chunk the quote-blind splitter makes and not the command node.
// `astHit` is the parsed rule on its own, `liveHit` is what the wall actually
// renders — every flip and every keep-denied claim below is measured on it,
// because that is where a regression is observable.
function astHit(command: string): DangerousPatternHit | null {
  const parsed = parseForSecurity(command);
  return parsed.kind === "ok" ? findDestructiveOnParse(parsed) : null;
}

function liveHit(command: string): DangerousPatternHit | null {
  return findDangerousPattern(command);
}

function id(hit: DangerousPatternHit | null): string | null {
  return hit === null ? null : hit.id;
}

function desc(hit: DangerousPatternHit | null): string | null {
  return hit === null ? null : hit.pattern;
}

describe("SC-S2-8 destructive roster — one named AST rule per entry", () => {
  const cases: ReadonlyArray<[string, string, string]> = [
    ["rm -rf /", "destructive-rm", "rm -rf"],
    ["rm -fr /tmp/x", "destructive-rm", "rm -fr"],
    ["rm -r /tmp", "destructive-rm", "rm -r "],
    ["rm -f /tmp/x", "destructive-rm", "rm -f "],
    ["rm --recursive /tmp", "destructive-rm", "rm --recursive"],
    ["rmdir /tmp", "destructive-rm", "rmdir"],
    ["Remove-Item C:\\x", "destructive-rm", "remove-item"],
    ["find /tmp -delete", "destructive-rm", " -delete"],
    ["chmod -R 777 /", "destructive-rm", "chmod -r"],
    ["mkfs.ext4 /dev/sda1", "destructive-disk", "mkfs"],
    ["dd if=/dev/zero of=/dev/sda", "destructive-disk", "dd if="],
    ["shutdown -h now", "destructive-disk", "shutdown"],
    ["reboot", "destructive-disk", "reboot"],
    ["del /f important.txt", "destructive-disk", "del /f"],
    ["rd /s /q C:\\path", "destructive-disk", "rd /s"],
  ];
  for (const [command, wantId, wantPattern] of cases) {
    it(`renders ${JSON.stringify(command)} as ${wantId}/${wantPattern}`, () => {
      assert.equal(id(astHit(command)), wantId);
      assert.equal(desc(astHit(command)), wantPattern);
    });
  }

  it("leaves a trailing-backslash shape to the parse verdict, which still denies", () => {
    assert.equal(astHit("rd /s /q C:\\"), null);
    assert.equal(id(liveHit("rd /s /q C:\\")), "unparseable");
  });

  it("keeps `find / -delete` on the root-find fold (precedence unchanged)", () => {
    // The fold reports root-find-walk today and must keep doing so; the
    // command-word rule is consulted only after that fold at the call site.
    assert.equal(id(liveHit("find / -delete")), "root-find-walk");
  });

  it("does not fire on a destructive name that is only a bare command word", () => {
    assert.equal(astHit("rm x"), null);
    assert.equal(astHit("chmod +x run.sh"), null);
  });
});

describe("the lexical `format` gate stays on the splitter's segment", () => {
  // ADR-0068's gate fires on a chunk the quote-blind splitter STARTS with the
  // word `format` and nowhere else, so no arm of the parsed rule owns it: the
  // live deny stays destructive-disk/"format", while the tree's own answer is
  // either nothing or, where a LATER chunk carries a roster literal, that
  // literal — which the gate still outranks, being reached first.
  const segmentInitial: ReadonlyArray<[string, string | null, string | null]> =
    [
      ["format C:", null, null],
      ["format c:", null, null],
      ["format C: # comment", null, null],
      ["/usr/bin/format C:", null, null],
      ["fo\\rmat C:", null, null],
      ["echo a\nformat c:", null, null],
      ["for i in 1; do echo x; format C:; done", null, null],
      ["format; rm -rf x", "destructive-rm", "rm -rf"],
      ["format C:; rm -rf x", "destructive-rm", "rm -rf"],
    ];
  for (const [command, wantAstId, wantAstPattern] of segmentInitial) {
    it(`denies ${JSON.stringify(command)} as destructive-disk/format`, () => {
      assert.equal(id(liveHit(command)), "destructive-disk", command);
      assert.equal(desc(liveHit(command)), "format", command);
      assert.equal(id(astHit(command)), wantAstId, command);
      assert.equal(desc(astHit(command)), wantAstPattern, command);
    });
  }

  // A roster literal sharing that same chunk keeps reporting its own id: the
  // gate and the substring roster have always been read over one segment in one
  // loop, the roster first, so the collision only chooses which deny to name.
  // The parsed rule is silent on every row here because no command word in them
  // is on the destructive roster.
  const sameChunkCarriesALiteral: ReadonlyArray<[string, string, string]> = [
    ["format rm -rf /tmp/x", "destructive-rm", "rm -rf"],
    ["echo a; format rm -rf x", "destructive-rm", "rm -rf"],
    ["format mkfs.ext4 /dev/sda", "destructive-disk", "mkfs"],
    ["format dd if=/dev/zero of=/dev/sda", "destructive-disk", "dd if="],
  ];
  for (const [command, wantId, wantPattern] of sameChunkCarriesALiteral) {
    it(`keeps the roster's own id for ${JSON.stringify(command)}`, () => {
      const hit = liveHit(command);
      assert.equal(id(hit), wantId, command);
      assert.equal(desc(hit), wantPattern, command);
      assert.equal(astHit(command), null, command);
    });
  }

  // The same one-loop read also fixes precedence across chunks: an EARLIER
  // chunk the tree answers gets first claim, and `format` speaks only when the
  // tree finds nothing there.
  const deferredToAnEarlierChunk: ReadonlyArray<[string, string, string]> = [
    ["FORMAT=1 rm -rf x; format C:", "destructive-rm", "rm -rf"],
    // The surviving deny is the gate's: the earlier chunk's literal is inert
    // text, so only `format` is left to answer a command that still denies.
    ['echo "rm -rf x"; format C:', "destructive-disk", "format"],
    // The same shape with the literal in a comment instead of a quote.
    ["echo hi # rm -rf /; format C:", "destructive-disk", "format"],
  ];
  for (const [command, wantId, wantPattern] of deferredToAnEarlierChunk) {
    it(`renders ${JSON.stringify(command)} as ${wantId}/${wantPattern}`, () => {
      const hit = liveHit(command);
      assert.equal(id(hit), wantId, command);
      assert.equal(desc(hit), wantPattern, command);
    });
  }

  // Shapes the splitter never starts a chunk with `format` in: the gate never
  // reached them and must not start now, or it has been widened onto argv.
  // Each is an allow that no arm of this migration licenses as a deny.
  const neverASegmentInitial: ReadonlyArray<string> = [
    "if true; then format C:; fi",
    "if format C:; then echo x; fi",
    "while :; do format C:; done",
    "( format C: )",
    "{ format C:; }",
    "echo a && (format C:)",
    "x=1 format C:",
    "FORMAT=1 format C:",
    "! format C:",
    "time format C:",
    "sudo format C:",
    "builtin format C:",
    "env FORMAT=1 format C:",
    "case x in y) format C;; esac",
    "function f() { format C:; }; f",
    "echo 'format C:'",
    "printf 'format %s' C:",
    "git format-patch -1",
    "echo transform",
    "echo 'text-transform: uppercase'",
    "cat format-notes.md",
    "bare format",
  ];
  for (const command of neverASegmentInitial) {
    it(`answers nothing for ${JSON.stringify(command)}`, () => {
      assert.equal(liveHit(command), null, command);
      assert.equal(astHit(command), null, command);
    });
  }
});

describe("SC-S2-9 declared-code-operand arm — every code payload stays denied", () => {
  const keepDenied: ReadonlyArray<[string, string]> = [
    ["powershell -c rmdir x", "destructive-rm"],
    ["cmd /c rmdir /s /q C:\\Windows", "destructive-rm"],
    ["cmd /c shutdown", "destructive-disk"],
    ["powershell -c 'shutdown'", "destructive-disk"],
    ["cmd /c 'echo hi & rm -rf /x'", "destructive-rm"],
    ["python3 -c 'rm -rf /'", "destructive-rm"],
    [`python3 -c 'import os; os.system("rm -rf /")'`, "destructive-rm"],
    [
      'node -e \'require("child_process").execSync("rm -rf /")\'',
      "destructive-rm",
    ],
    ["bash -c 'shutdown now'", "destructive-disk"],
    ["perl -e 'rmdir'", "destructive-rm"],
    ["bash -lc 'rm -rf /'", "destructive-rm"],
    ["bash -sc 'shutdown now'", "destructive-disk"],
    ["perl -te 'rmdir /tmp/x'", "destructive-rm"],
    [
      'node --eval \'require("child_process").execSync("rm -rf /")\'',
      "destructive-rm",
    ],
    ["php -r 'unlink(\"/tmp/x\"); rm -rf /tmp/y'", "destructive-rm"],
    ["python3 -c'rm -rf /'", "destructive-rm"],
    ["sh -c'rm -rf /x'", "destructive-rm"],
    ['powershell -Command"del /f x.txt"', "destructive-disk"],
    ["cmd /c echo del /f x.txt", "destructive-disk"],
    ["python -i 'rm -rf /'", "destructive-rm"],
    ["cmd /k echo del /f x.txt", "destructive-disk"],
    ["zsh -lc 'rm -rf /'", "destructive-rm"],
    ["bash -lc'rm -rf /'", "destructive-rm"],
    ["bash -ic'shutdown now'", "destructive-disk"],
    ["zsh -luc rd /s", "destructive-disk"],
    ["bash -ic rm -rf /", "destructive-rm"],
    ["bash -c rm -rf /", "destructive-rm"],
  ];
  for (const [command, wantId] of keepDenied) {
    it(`judges ${JSON.stringify(command)} as code and denies`, () => {
      assert.equal(id(astHit(command)), wantId);
    });
  }

  // A payload of several statements is still one operand judged as one string:
  // the roster name sits in its text, so the record it renders cannot move with
  // the parse. Both halves are pinned because the live wall is the observable.
  const multiStatementPayloads: ReadonlyArray<[string, string, string]> = [
    [
      "powershell -c 'Get-Process; Remove-Item -Recurse -Force C:\\'",
      "destructive-rm",
      "remove-item",
    ],
    [
      "pwsh -Command 'Write-Host hi; del /f x.txt'",
      "destructive-disk",
      "del /f",
    ],
    ["cmd /c 'echo hi & rd /s C:\\'", "destructive-disk", "rd /s"],
    ['cmd /c "del /f x.txt"', "destructive-disk", "del /f"],
    ["powershell -c 'rm -rf /x'", "destructive-rm", "rm -rf"],
  ];
  for (const [command, wantId, wantPattern] of multiStatementPayloads) {
    it(`keeps ${JSON.stringify(command)} at ${wantId}/${wantPattern}`, () => {
      const hit = liveHit(command);
      assert.equal(id(hit), wantId, command);
      assert.equal(desc(hit), wantPattern, command);
      assert.equal(id(astHit(command)), wantId, command);
    });
  }

  // The arm's own no-widening witness: `bash` and `cmd` are both on a
  // code-consuming roster, so their operand IS text-matched — and a benign one
  // still answers nothing.
  it("does not text-match a benign code operand into a deny", () => {
    for (const command of [
      "bash -c 'echo one & echo two'",
      "cmd /c 'echo one & echo two'",
    ]) {
      assert.equal(liveHit(command), null, command);
      assert.equal(astHit(command), null, command);
    }
  });

  it("keeps replay C2.f denying (parses malformed → hard-deny, never a new allow)", () => {
    const cmd = "powershell -c Remove-Item -Recurse -Force C:\\";
    assert.equal(id(liveHit(cmd)), "unparseable");
    assert.notEqual(liveHit(cmd), null);
  });

  it("does not widen the text rule onto a data operand (echo / grep are on neither roster)", () => {
    assert.equal(astHit("grep -c rm -rf f"), null);
    assert.equal(astHit("echo powershell -c rm -rf x"), null);
    assert.equal(astHit(`echo "Remove-Item x"`), null);
  });
});

describe("the `builtin` fold reaches the destructive arms only", () => {
  it("judges the argv of a destructive command behind `builtin`", () => {
    const command = "builtin rm -rf /tmp/x";
    const hit = liveHit(command);
    assert.equal(id(hit), "destructive-rm", command);
    assert.equal(desc(hit), "rm -rf", command);
    assert.equal(id(astHit(command)), "destructive-rm", command);
  });

  // The fold is shared by both destructive arms, so a code operand behind
  // `builtin` is still declared code and still text-matched.
  it("judges the code operand of a shell behind `builtin`", () => {
    const command = "builtin bash -c 'rm -rf /x'";
    const hit = liveHit(command);
    assert.equal(id(hit), "destructive-rm", command);
    assert.equal(desc(hit), "rm -rf", command);
    assert.equal(id(astHit(command)), "destructive-rm", command);
  });

  it("reports the roster literal, not the walk, for a find behind builtin", () => {
    const command = "builtin find . -delete";
    const hit = liveHit(command);
    assert.notEqual(id(hit), "root-find-walk", command);
    assert.equal(id(hit), "destructive-rm", command);
    assert.equal(desc(hit), " -delete", command);
  });

  // The root-shaped twin: `builtin` is not in the walk's own wrapper set, so
  // this pair is what the base says and what must keep being said — the fold
  // reaches the destructive arms without moving who reports a root walk.
  it("keeps the walk's own wrapper set when the root find sits behind builtin", () => {
    const wrapped = "builtin find / -delete";
    const hit = liveHit(wrapped);
    assert.equal(id(hit), "destructive-rm", wrapped);
    assert.equal(desc(hit), " -delete", wrapped);
    assert.equal(id(astHit(wrapped)), "destructive-rm", wrapped);
    assert.equal(id(liveHit("find / -delete")), "root-find-walk");
  });

  // The walk keeps its own wrapper set, so folding `builtin` here must not
  // newly deny a root walk it never named — the unfused twin still denies.
  it("keeps a root walk behind `builtin` out of the walk arm", () => {
    assert.equal(liveHit("cd / && builtin find ."), null);
    assert.equal(id(liveHit("cd / && find .")), "root-find-walk");
  });
});

describe("SC-S2-8 fork bomb — structural rule renders destructive-disk", () => {
  it("is a function definition the parse reports as ok", () => {
    const parsed = parseForSecurity(":(){ :|:& };:");
    assert.equal(parsed.kind, "ok");
    if (parsed.kind !== "ok") return;
    assert.ok((parsed.nodeTypes["function_definition"] ?? 0) > 0);
  });

  it("hands the live answer to the structural rule, not to the bare metachars", () => {
    assert.equal(id(liveHit(":(){ :|:& };:")), "destructive-disk");
    assert.equal(desc(liveHit(":(){ :|:& };:")), ":(){ :|:& };:");
  });

  it("renders the same pair for the spellings of that one shape", () => {
    for (const command of [":(){:|:&};:", ": () { :|:& }; :"]) {
      assert.equal(id(liveHit(command)), "destructive-disk");
      assert.equal(desc(liveHit(command)), ":(){ :|:& };:");
    }
  });

  it("re-describes a deny and never creates one", () => {
    // The bomb behind a command word was allowed while the scan was quote-blind
    // (`x=1` is a command word, so the bare branch never fired), and Stage 2
    // newly denies nothing: the structural arm answers only inside the branch
    // the text path already denied.
    assert.equal(liveHit("x=1; :(){ :|:& };:"), null);
    assert.equal(liveHit("echo hi && :(){ :|:& };:"), null);
    assert.equal(liveHit("cat /tmp/x; :(){ :|:& };:"), null);
  });

  // The literal is not in the roster the parse-armed rules read, because the
  // quote-blind scan never denied it in a code operand or an interpreter body
  // either: the splitter broke the spelling at its own `;` and `|` before the
  // substring could line up. A bomb-shaped string there answers nothing, while
  // the one shape the structural rule owns keeps its rendered pair.
  it("keeps the bomb literal out of the roster the parse arms read", () => {
    for (const command of [
      "bash -c ':(){ :|:& };:'",
      "eval ':(){ :|:& };:'",
      "python3 <<'EOF'\n:(){ :|:& };:\nEOF\n",
    ]) {
      assert.equal(liveHit(command), null, command);
      assert.equal(astHit(command), null, command);
    }
    const bare = liveHit(":(){ :|:& };:");
    assert.equal(id(bare), "destructive-disk");
    assert.equal(desc(bare), ":(){ :|:& };:");
  });
});

describe("text roster keeps first claim on a body with no command word", () => {
  // A dangerous literal glued to a redirect names no command anywhere, so every
  // argv rule abstains and the segment scan is the only arm that can speak. The
  // bare-operator branch used to answer these shapes first, which moved the
  // reported pair without moving the verdict.
  const cases: ReadonlyArray<[string, string, string]> = [
    [">rm -rf /", "destructive-rm", "rm -rf"],
    ["<rm -rf /", "destructive-rm", "rm -rf"],
    [">>rm -rf /", "destructive-rm", "rm -rf"],
    ["2>&1mkfs", "destructive-disk", "mkfs"],
    ["> shutdown now", "destructive-disk", "shutdown"],
    ["> find / -delete", "destructive-rm", " -delete"],
  ];
  for (const [command, expectedId, expectedDesc] of cases) {
    it(`answers ${expectedId}/${JSON.stringify(expectedDesc)} for ${JSON.stringify(
      command
    )}`, () => {
      assert.equal(id(liveHit(command)), expectedId);
      assert.equal(desc(liveHit(command)), expectedDesc);
    });
  }
});

describe("the live wall judges the rm family off the parse", () => {
  // Every one of these denied while the scan was quote-blind — `destructive-rm`
  // for the rm family, `destructive-disk` for the two inert shutdown names.
  // None of them names a destructive program: the literal sits in a quoted
  // operand, a comment, a data heredoc body, or the operands of a command word
  // that is not itself destructive.
  const flipped: ReadonlyArray<string> = [
    'echo "rm -rf /"',
    "echo 'rm -rf /'",
    "printf 'rm -rf /'",
    "cat <<'EOF'\nrm -rf /\nEOF\n",
    "echo hi # rm -rf /",
    "echo rm -rf",
    "grep rm -rf /tmp/x",
    "echo rmdir",
    'echo "shutdown"',
    "echo 'reboot'",
    // The same three relaxation classes, in shapes the list above does not
    // repeat: a quoted operand behind a redirect, and an operand-scope hit on a
    // name that is on neither code-eating roster.
    "echo 'rm -rf /' > /tmp/x",
    "printf '%s' rm -rf",
    "grep -c rm -rf f",
    "echo powershell -c rm -rf x",
    'echo "Remove-Item x"',
  ];
  for (const command of flipped) {
    it(`answers nothing for ${JSON.stringify(command)}`, () => {
      assert.equal(liveHit(command), null);
      assert.equal(astHit(command), null);
    });
  }

  // The keep-denied side, each with the exact record it carried before the move:
  // a real destructive argv, a wrapped one, an escaped one, a live second
  // command node, a substituted inner, and a declared code operand.
  const keepDenied: ReadonlyArray<[string, string, string]> = [
    ["sudo rm -rf /home", "destructive-rm", "rm -rf"],
    ["r\\m -rf /tmp/x", "destructive-rm", "rm -rf"],
    // The escape is not at the command word here, so argv alone would call this
    // a print; a word that joins to a roster name through bash's own escape is
    // judged over its node's text.
    ["echo r\\m -rf /tmp/x", "destructive-rm", "rm -rf"],
    ["echo a && rm -rf /", "destructive-rm", "rm -rf"],
    ["echo a; rm -rf /", "destructive-rm", "rm -rf"],
    ["echo a\nrm -rf /", "destructive-rm", "rm -rf"],
    [
      "echo $(rm -rf /)",
      "command-substitution",
      "subst=dollar-paren→destructive-rm",
    ],
    [
      "python3 -c \"import os; os.system('rm -rf /tmp/z')\"",
      "destructive-rm",
      "rm -rf",
    ],
    ["find /tmp -delete", "destructive-rm", " -delete"],
    // The fold keeps first claim over the command-word rule, so the reporter of
    // a root walk does not move with this wall.
    ["find / -delete", "root-find-walk", "find"],
  ];
  for (const [command, wantId, wantPattern] of keepDenied) {
    it(`still denies ${JSON.stringify(command)} as ${wantId}/${wantPattern}`, () => {
      const hit = liveHit(command);
      assert.equal(id(hit), wantId);
      assert.equal(desc(hit), wantPattern);
    });
  }

  // One payload, every word that puts it in front of `rm`: the transparent
  // wrappers, which the fold walks past to reach the destructive name, and the
  // execution carriers, which run the operand they are handed. Both routes must
  // land on the same record — the wall has no notion of a word whose operand is
  // neither data nor its own argv, so no row here is an exception.
  const onePayloadEveryRunner: ReadonlyArray<string> = [
    "timeout 5 rm -rf /tmp/x",
    "stdbuf -oL rm -rf /tmp/x",
    "nohup rm -rf /tmp/x",
    "nice -n 5 rm -rf /tmp/x",
    "time rm -rf /tmp/x",
    "builtin rm -rf /tmp/x",
    "command rm -rf /tmp/x",
    "sudo rm -rf /tmp/x",
    "ssh host rm -rf /tmp/x",
    "su root -c 'rm -rf /tmp/x'",
    "docker exec c rm -rf /tmp/x",
    "podman exec c rm -rf /tmp/x",
    "kubectl exec c -- rm -rf /tmp/x",
    "watch -n 1 rm -rf /tmp/x",
    "parallel rm -rf {} ::: /tmp/x",
    "xargs rm -rf /tmp/x",
  ];
  it("denies one payload identically behind every wrapper and carrier", () => {
    const pairs = onePayloadEveryRunner.map((command) => {
      const hit = liveHit(command);
      assert.notEqual(hit, null, command);
      return `${String(id(hit))}/${String(desc(hit))}`;
    });
    for (let i = 1; i < pairs.length; i += 1) {
      assert.equal(pairs[i], pairs[0], onePayloadEveryRunner[i]!);
    }
    assert.equal(pairs[0], "destructive-rm/rm -rf");
  });

  // What does not move, in both directions: a real destructive argv keeps the
  // id it always reported, the lexical `format` gate keeps denying off the
  // text, and a `format` that is only a name inside data answers nothing.
  const unchangedDiskRows: ReadonlyArray<[string, string | null]> = [
    ["mkfs.ext4 /dev/sda1", "destructive-disk"],
    ["format C:", "destructive-disk"],
    ["echo 'git format-patch -1'", null],
    ["cat format-notes.md", null],
  ];
  for (const [command, wantId] of unchangedDiskRows) {
    it(`keeps the live answer of ${JSON.stringify(command)} at ${wantId}`, () => {
      assert.equal(id(liveHit(command)), wantId);
    });
  }
});

describe("the destructive path reads a heredoc body by its receiver", () => {
  const codeBodies: ReadonlyArray<[string, string, string]> = [
    // bash expands an unquoted body, so it is live for any receiver — including
    // a plain `cat`, whose argv says nothing about the text it is handed.
    ["cat <<EOF\nrm -rf /\nEOF\n", "destructive-rm", "rm -rf"],
    // An interpreter eats its body whatever the delimiter's quoting.
    [
      "python3 <<'EOF'\nos.system('rm -rf /tmp/z')\nEOF\n",
      "destructive-rm",
      "rm -rf",
    ],
    // A Windows shell's script body is code for this wall too, so the roster's
    // receiver test runs over the unioned names even though the substitution
    // walk's roster stays the frozen twelve.
    ["powershell <<'EOF'\nrmdir x\nEOF\n", "destructive-rm", "rmdir"],
    ["cmd <<'EOF'\ndel /f x\nEOF\n", "destructive-disk", "del /f"],
  ];
  for (const [command, wantId, wantPattern] of codeBodies) {
    it(`denies the body of ${JSON.stringify(command)} as ${wantId}/${wantPattern}`, () => {
      const hit = liveHit(command);
      assert.equal(id(hit), wantId);
      assert.equal(desc(hit), wantPattern);
    });
  }

  // The quoted body of a text receiver is the one body that is data, and the
  // only one of these four shapes that flips.
  for (const command of [
    "cat <<'EOF'\nrm -rf /\nEOF\n",
    "echo hi <<'EOF'\nrm -rf /tmp/x\nEOF\n",
    "tee /tmp/keep <<'EOF'\nrm -rf /y\nEOF\n",
  ]) {
    it(`leaves the quoted data body of ${JSON.stringify(command)} alone`, () => {
      assert.equal(liveHit(command), null);
      assert.equal(astHit(command), null);
    });
  }

  // "Is this body code?" is one question with one owner, so the two walls that
  // ask it answer it alike. One body carries both a sensitive path and a
  // destructive literal; the destructive wall's record and the sensitive path's
  // verdict are then two readings of the same call, and any row where one is
  // live while the other is data is that question answered twice.
  const oneBodyTwoWalls: ReadonlyArray<[string, boolean]> = [
    ["docker exec -i c sh <<'EOF'\n", true],
    ["python3 <<'EOF'\n", true],
    ["cat <<'EOF'\n", false],
    ["tee /tmp/k <<'EOF'\n", false],
  ];
  for (const [receiver, bodyIsCode] of oneBodyTwoWalls) {
    it(`calls the body behind ${JSON.stringify(
      receiver
    )} ${bodyIsCode ? "code" : "data"} in both walls`, () => {
      const command = `${receiver}cat ~/.ssh/id_rsa; rm -rf /tmp/x\nEOF\n`;
      const destructive = liveHit(command);
      assert.equal(
        destructive !== null,
        commandContainsSensitivePath(command),
        command
      );
      assert.equal(destructive !== null, bodyIsCode, command);
    });
  }
});

describe("the parsed path stays inside the quote-blind floor", () => {
  // Floor: no arm of the parse may newly allow a real operand access, and the
  // argv join may newly deny nothing the quote-blind text scan allowed.

  // Shapes that reach a real destructive operand — a here-string body, a word
  // run behind a flag-looking word, an execute-or-store name, a wrapper-named
  // heredoc receiver. Each denied while the scan was quote-blind and may never
  // flip; the pattern is the roster literal the payload carries.
  const realOperands: ReadonlyArray<[string, string, string]> = [
    ['bash <<< "rm -rf /tmp/x"', "destructive-rm", "rm -rf"],
    ["sh <<< rm -rf /tmp/x", "destructive-rm", "rm -rf"],
    ['bash - <<< "rm -rf /tmp/x"', "destructive-rm", "rm -rf"],
    ['python3 <<< "rm -rf /tmp/x"', "destructive-rm", "rm -rf"],
    ["cat <<< 'rm -rf /x'", "destructive-rm", "rm -rf"],
    ['bash --login -c "rm -rf /tmp/x"', "destructive-rm", "rm -rf"],
    ['bash --rcfile /tmp/rc -c "rm -rf /tmp/x"', "destructive-rm", "rm -rf"],
    [`perl -MPOSIX -e 'system "rm -rf /tmp/x"'`, "destructive-rm", "rm -rf"],
    ["perl -te 'rmdir /tmp/x'", "destructive-rm", "rmdir"],
    [
      'pwsh -noninteractive -Command "rm -rf /tmp/x"',
      "destructive-rm",
      "rm -rf",
    ],
    ['sh myscript -c "rm -rf /tmp/x"', "destructive-rm", "rm -rf"],
    ['python3 script.py -c "rm -rf /tmp/x"', "destructive-rm", "rm -rf"],
    ['bash build.sh -c "rm -rf /tmp/x"', "destructive-rm", "rm -rf"],
    [
      'node --expose-gc -e \'require("child_process").execSync("rm -rf /tmp/x")\'',
      "destructive-rm",
      "rm -rf",
    ],
    ['eval "rm -rf /tmp/x"', "destructive-rm", "rm -rf"],
    ["eval rm -rf /tmp/x", "destructive-rm", "rm -rf"],
    ['env -S "rm -rf /tmp/x"', "destructive-rm", "rm -rf"],
    ['trap "rm -rf /tmp/x" EXIT', "destructive-rm", "rm -rf"],
    ["alias nuke='rm -rf /tmp/x'; nuke", "destructive-rm", "rm -rf"],
    ['. /dev/stdin <<< "rm -rf /tmp/x"', "destructive-rm", "rm -rf"],
    ["sudo bash <<'EOF'\nrm -rf /tmp/x\nEOF\n", "destructive-rm", "rm -rf"],
    ["nohup sh <<'EOF'\nrm -rf /tmp/x\nEOF\n", "destructive-rm", "rm -rf"],
    [
      "sudo python3 <<'PY'\nimport os\nos.system('rm -rf /tmp/x')\nPY\n",
      "destructive-rm",
      "rm -rf",
    ],
    // A word that runs what it is handed somewhere else than in this shell:
    // each pair below is the record the pre-migration quote-blind scan gave
    // this exact shape, so a row that goes quiet here is a new allow over a
    // real operand and not a relaxation.
    ["watch -n 1 rm -rf /tmp/x", "destructive-rm", "rm -rf"],
    ["ssh host rm -rf /tmp/x", "destructive-rm", "rm -rf"],
    ["docker exec c rm -rf /tmp/x", "destructive-rm", "rm -rf"],
    ["podman exec c rm -rf /tmp/x", "destructive-rm", "rm -rf"],
    ["kubectl exec c -- rm -rf /x", "destructive-rm", "rm -rf"],
    ["parallel rm -rf {} ::: /tmp/x", "destructive-rm", "rm -rf"],
    ["su root -c 'rm -rf /x'", "destructive-rm", "rm -rf"],
    ["xargs rm -rf /tmp/x", "destructive-rm", "rm -rf"],
    // Quoting the operand of such a word moves it into no relaxation class:
    // the words still reach a shell, on the far side or on this one.
    ["ssh host 'rm -rf /tmp/x'", "destructive-rm", "rm -rf"],
    ["docker exec c sh -c 'rm -rf /tmp/x'", "destructive-rm", "rm -rf"],
    ["parallel 'rm -rf {}' ::: /tmp/x", "destructive-rm", "rm -rf"],
  ];
  for (const [command, wantId, wantPattern] of realOperands) {
    it(`denies the real operand ${JSON.stringify(command)} as ${wantId}/${wantPattern}`, () => {
      const hit = liveHit(command);
      assert.equal(id(hit), wantId);
      assert.equal(desc(hit), wantPattern);
    });
  }

  // One carrier per name that runs what it is handed, judged by the parsed arm
  // on its own: the text roster is unreachable for a body that names a command
  // word, so the tree is the only thing in the wall that can answer these, and
  // a name missing from it goes silent rather than falling back to the scan.
  const oneRowPerCarrierName: ReadonlyArray<string> = [
    "ssh host rm -rf /tmp/x",
    "su root -c 'rm -rf /x'",
    "docker exec c rm -rf /tmp/x",
    "podman exec c rm -rf /tmp/x",
    "kubectl exec c -- rm -rf /x",
    "watch -n 1 rm -rf /tmp/x",
    "parallel rm -rf {} ::: /tmp/x",
    "xargs rm -rf /tmp/x",
  ];
  it("denies each carrier's operand from the tree, not from the scan", () => {
    for (const command of oneRowPerCarrierName) {
      const hit = astHit(command);
      assert.equal(id(hit), "destructive-rm", command);
      assert.equal(desc(hit), "rm -rf", command);
      assert.deepEqual(liveHit(command), hit, command);
    }
  });

  // The twins of those operands for a word that neither runs nor stores them:
  // the same literal in a discarded argv word, a quoted data operand, a quoted
  // body of a text receiver and a comment. Every one of these denied under the
  // quote-blind scan and is licensed to be quiet now — a deny appearing on any
  // row here is the carrier question being answered too broadly.
  it("leaves the same literal to the operand, quote, body and comment classes", () => {
    for (const command of [
      "grep rm -rf /tmp/x",
      "echo 'rm -rf /x'",
      "cat <<'EOF'\nrm -rf /x\nEOF\n",
      "echo hi # rm -rf /x",
    ]) {
      assert.equal(liveHit(command), null, command);
      assert.equal(astHit(command), null, command);
    }
  });

  // A quote or a newline inside the words is text the quote-blind scan never
  // joined; reading raw word source, the parsed path must stay silent on every
  // one of these too.
  const joinReachesTooFar: ReadonlyArray<string> = [
    'rm "-rf" /tmp/x',
    "rm '-rf' /tmp/x",
    "rm $'-rf' /tmp/x",
    "chmod '-R' /tmp/x",
    "find . '-delete'",
    "rm '--recursive' /tmp/x",
    "rm '-f' /tmp/x",
    "rm '-r' /tmp/x",
    "rm '-fr' /tmp/x",
    "bash -c 'rm' '-rf' /tmp",
    "bash -c 'rm' -rf /tmp",
    'ksh -c "rm" "-rf /tmp"',
    'bash -c "rm -r\nf /tmp"',
  ];
  for (const command of joinReachesTooFar) {
    it(`answers nothing on the parse for ${JSON.stringify(command)}`, () => {
      assert.equal(astHit(command), null);
    });
  }

  // The floor's own witness: legacy silent AND wall silent, row by row — the
  // pair is the guarantee, either half alone proves nothing.
  for (const command of joinReachesTooFar) {
    it(`holds the floor for ${JSON.stringify(command)}: text scan silent, wall silent`, () => {
      assert.equal(legacyFindDangerousPattern(command), null);
      assert.equal(liveHit(command), null);
    });
  }
});
