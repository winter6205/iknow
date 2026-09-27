import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { commandContainsSensitivePath } from "../../../src/harness/permission/hard-walls.js";

// SC-S2-7 pins the command-level sensitive-path wall across the one change
// Stage 2 makes to it: the frozen `SENSITIVE_PATH_FRAGMENTS` roster keeps
// running as a single substring/regex pass over the command text, and exactly
// two kinds of span are blanked out first — (a) comment text and (b) a
// quoted-delimiter heredoc body whose receiver is not an interpreter. Blanking
// writes spaces of the same byte count, so nothing is trimmed, nothing is
// rejoined, and the roster's `$`-anchored arms keep matching end-of-command-text
// and only there. The roster itself, `matchSensitivePath` and the deny reason
// sentence are untouched by this stage.
//
// Every "today" value named in the comments below was measured by calling this
// exported function from this worktree's source under `npx tsx`, not read off
// the spec's prose; `findDangerousPattern` was called on the same strings to
// confirm which of them this wall alone denies.
//
// After the excision the wall answers as follows: the two flip rows are `false`
// (the sensitive name sat wholly in a comment or in a text receiver's quoted
// body, so neither span is judged); the eight newly-pinned denies and the two
// asymmetry pins are `true` because every one of them is an operand, a redirect
// target, or interpreter code — none of which excision reaches. The three
// no-widening rows and the `.env` non-goal stay `false`: a same-byte blank can
// never re-anchor a word to end-of-text. The five existing command-level
// assertions are not re-pinned here: they live in
// `tests/harness/aci/permission.test.ts`, which SC-S2-3 keeps green and forbids
// editing. This file adds the assertions SC-S2-7's binary names, the two
// asymmetry assertions from its keep-denied line, and the wrapper-fold pin an
// interpreter reached through `sudo` still owes the body.
function verdict(command: string): boolean {
  return commandContainsSensitivePath(command);
}

describe("SC-S2-7 flips — sensitive names in inert text stop denying", () => {
  // Both are `true` before the excision and `false` after it, and
  // `findDangerousPattern` answers `null` for both, so today this wall is the
  // only thing denying them; after Stage 2 neither span is judged at all.
  // Neither is an `argv` operand or a redirect target, so none of the
  // criterion's four exclusions reaches them.
  it("leaves the quoted data body of a text receiver alone", () => {
    // `cat` is on no interpreter roster and the delimiter is quoted, so the body
    // is data — excision (b).
    assert.equal(verdict("cat <<'EOF'\nid_rsa\nEOF\n"), false);
  });

  it("leaves comment text alone", () => {
    // `id_rsa` sits wholly in the comment node — excision (a).
    assert.equal(verdict("cat notes.txt # id_rsa here"), false);
  });
});

describe("SC-S2-7 newly-pinned denies — the excision must not reach these", () => {
  // Each entry is `verdict(...) === true` measured today while
  // `findDangerousPattern(...)` returns `null` — this wall is that command's only
  // denial, so excising any of these spans is a security regression, not a
  // migration. The reason column names the exclusion that owns each shape.
  const denied: ReadonlyArray<[string, string]> = [
    [
      "cp '/home/u/.ssh/id_rsa' /tmp/x",
      "argv operand: here the quotes are shell hygiene around a real path, so single quotes buy this wall nothing",
    ],
    [
      "cat '/etc/shadow'",
      "argv operand of a text-consuming command — still an operand",
    ],
    [
      'mv "$HOME/.aws/credentials" /tmp',
      "double-quoted operand: expanded, therefore judged",
    ],
    [
      "echo a > '/etc/passwd'",
      "redirect target: judged whole, in whatever quote state it carries — quoting decides expansion, never whether the write is judged",
    ],
    [
      "sh -c 'cat /etc/passwd'",
      "declared code operand of a shell name: an interpreter's payload is never inert for this wall",
    ],
    [
      "FOO='id_rsa' printenv",
      "a quoted variable_assignment value counts as an operand",
    ],
    [
      "sudo python3 <<'EOF'\nopen('/etc/passwd').read()\nEOF\n",
      "wrapper fold: reading only `argv[0]` names `sudo`, which is on no interpreter roster, so the body would be blanked and a real interpreter code payload turned into a silent allow — folding makes `python3` the receiver and keeps the deny",
    ],
    [
      'test -r "$HOME/.ssh/id_ed25519"',
      "double-quoted operand: expanded, therefore judged — SC-S2-7's keep-denied line names this shape",
    ],
  ];
  for (const [command, why] of denied) {
    it(`judges ${JSON.stringify(command)} — ${why}`, () => {
      assert.equal(verdict(command), true);
    });
  }
});

describe("SC-S2-7 no-widening — blanking cannot extend a word to end-of-text", () => {
  // All three are `false` today and must stay `false`: an anchored arm needs its
  // literal at the end of the scanned text, and a same-byte-count blank cannot
  // create that boundary. The first row is also the witness against per-word
  // re-anchoring, which would newly deny it.
  const notDenied: ReadonlyArray<[string, string]> = [
    [
      "echo a > /tmp/x.pem && notify",
      "`\\.pem$` stays end-of-command-text, so a redirect target mid-line is no deny",
    ],
    [
      "cp app.key '.bak'",
      "`.key` ends neither the text nor, under this stage, any word of it",
    ],
    [
      "cp app.key # backup",
      "excision (a) blanks the comment to spaces, so `.key` is followed by spaces rather than by end-of-text",
    ],
  ];
  for (const [command, why] of notDenied) {
    it(`answers nothing for ${JSON.stringify(command)} — ${why}`, () => {
      assert.equal(verdict(command), false);
    });
  }
});

describe("SC-S2-7 named non-goal — the anchored miss is retained policy", () => {
  // `false` today, verified. Stage 2 keeps the miss on purpose: re-anchoring
  // `\\.env$` (and its siblings) per word would turn today-allow rows into new
  // denies, which is new policy rather than migration. This assertion exists so
  // that widening is a decision someone has to take, not a side effect.
  it("keeps `cat .env | head` unanswered", () => {
    assert.equal(verdict("cat .env | head"), false);
  });
});

describe("SC-S2-7 keep-denied asymmetry — expansion and interpreter code stay judged", () => {
  // Pinned so nobody "fixes" the asymmetry by flipping these with the two rows
  // above. Both measure `true` today and are asserted `true` after Stage 2.
  it("judges a double-quoted operand, which is expanded rather than inert", () => {
    // Double quotes are inert for _argv_ naming only; expansion still happens, so
    // `~/.ssh/id_rsa` inside them is a real path operand, not comment or body text.
    assert.equal(verdict('echo "cat ~/.ssh/id_rsa"'), true);
  });

  it("judges an interpreter heredoc body whatever the delimiter's quoting", () => {
    // `python3` is the receiver, so excision (b) does not apply to its body. Note
    // the asymmetry in the reporting seam: this command's `findDangerousPattern`
    // is not `null` like the six above — it answers `unparseable` /
    // `verdict=malformed` (the body's own sub-parse is not shell), so today the
    // dangerous-pattern wall reports it first. The sensitive-path verdict is
    // nonetheless `true` on its own terms, which is what SC-S2-7 pins.
    assert.equal(
      verdict("python3 <<'EOF'\nopen('/etc/passwd').read()\nEOF\n"),
      true
    );
  });
});
