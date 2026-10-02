/**
 * tests/cli/parse-args-eval-state.test.ts
 *
 * ADR-0130 **eval state** — the parse-time entry contract of `--eval-state` on
 * the headless entries. Parsing layer only; the dispatch-time rendering + exit
 * code is certified black-box by `tests/cli/cli-eval-state-non-entry-reject.test.ts`,
 * and the real bare-run face by `tests/cli/cli-eval-state-bare-run.test.ts`.
 *
 * Invariants:
 *   1. `ask` / `oneshot` carrying the flag → `evalState: true`, no refusal, and
 *      the flag never leaks into the query text.
 *   2. Every other session command (`chat` / `serve` / `trace` / `tui`) carrying
 *      it → the typed refusal (discriminated union), nothing else changed.
 *   3. Absent → zero change: the flag-free reading and the flagged reading are
 *      structurally equal once the two eval fields are stripped (no hardcoded
 *      field table — same technique as `parse-args-yolo.test.ts`).
 *   4. Pure display paths (`-h` / `-V` / `help` / a bare flag with no
 *      subcommand) are the declared allowance: no refusal, and a bare
 *      `--eval-state` must not silently start a chat session.
 *   5. `--yolo` keeps refusing on `ask` even when eval state was asked for —
 *      the exception is a separate named face, not a relaxed enumeration
 *      (ADR-0130 §1 / ADR-0119 §ruling 7).
 *   6. Incoherent combinations refuse loudly (`--resume`): the state is
 *      per-invocation and persists nothing.
 *   7. The posture is detected **only in a flag position**. A token sitting in a
 *      value-taking flag's slot never enters (or re-enters) the posture and
 *      refuses loudly instead; a token in the operator's query text never flips
 *      the posture and never leaves the query (a fence-retiring posture must not
 *      be selectable by anything the operator asked the model).
 *   8. The rule has no second site: the tripwire is derived from the source of
 *      `parseArgs` itself, so a value-taking flag added without going through
 *      the shared slot reader fails the suite even if nothing documents it.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "../../src/cli/parse-args.ts";
import { usageText } from "../../src/cli/usage.ts";
import { EVAL_STATE_FLAG } from "../../src/harness/sandbox/eval-state.ts";

/** Commands that must not reach eval state (everything except ask / oneshot). */
const REJECTING_ENTRIES: ReadonlyArray<{
  readonly command: "chat" | "serve" | "trace" | "tui";
  readonly argv: string[];
}> = [
  { command: "chat", argv: ["chat"] },
  { command: "serve", argv: ["serve"] },
  { command: "trace", argv: ["trace"] },
  { command: "tui", argv: ["tui"] },
];

/**
 * Every value-taking flag the CLI parser has, minus `--resume` (which reports
 * its conflict instead of throwing, and has its own case below).
 *
 * One list for both the opaque and the numeric slots, because there is no longer
 * a distinction to test: the rule is structural — every value slot is read
 * through the same reader, so a slot holding a posture spelling fails loudly
 * whether the slot wants a host, a path or an integer. Splitting this list into
 * "opaque" and "numeric" would re-introduce the very distinction the change
 * removed (that a numeric slot happens to be protected as a side effect of its
 * own `Number()` check, while an opaque one needs to be told to refuse).
 *
 * TRIPWIRE — this list is the only enumeration left, so it is where a new
 * value-taking flag must be registered. Two independent guards, one per
 * direction the table could drift:
 *   - **Source-derived (the binding one).** Every arm of `parseArgs`' scan chain
 *     that consumes a value is read out of `src/cli/parse-args.ts` itself and
 *     asserted equal to this table plus `--resume`. A new value-taking flag fails
 *     the suite whether it is written the new way (through `slotValue`) or the
 *     old way (taking the token itself), which is the "second site to forget"
 *     this change exists to remove. The same read asserts the arms' *bodies*:
 *     every value-consuming arm except `--resume` calls `slotValue`.
 *   - **Usage-derived (documentation coverage).** `usageText()` publishes
 *     `--flag <value>` lines; the "published options" case asserts every such
 *     flag is in here, so a newly *documented* value flag cannot be skipped even
 *     before the source-derived guard sees it.
 *
 * `--trace-out`, `--max-turns` and `--resume` are value-taking but are NOT in the
 * published options block, so nothing derives them from usage. The source-derived
 * guard derives them regardless — that is why it, and not the usage one, is the
 * one that binds.
 */
const VALUE_TAKING_FLAGS = [
  "--host",
  "--trace-out",
  "--data-dir",
  "--workspace-root",
  "--port",
  "--max-bytes",
  "--max-turns",
] as const;

/** The one value-taking flag that reports a posture in its slot instead of throwing. */
const REPORTING_VALUE_FLAG = "--resume";

/**
 * The scan-chain arms of `parseArgs`, as flag literal -> arm body, read out of the
 * source rather than restated here.
 *
 * Reading the file is what makes the tripwire bind: the old guard derived
 * coverage from published *prose*, so an unpublished value flag left the table
 * silently incomplete. Deriving from the only place a token is consumed as a
 * flag closes that direction, and the repo has precedent for source assertions in
 * tests (`tests/tui/yolo-mode-row.test.ts`, `tests/harness/sandbox/secrets-no-leak.test.ts`).
 *
 * An arm is delimited by the `a === "--x"` heads of the chain, so its body is
 * everything up to the next head — enough to see the `++i` that marks an arm as
 * consuming the next token as a value, and the `slotValue(` that marks it as
 * conforming to the shared rule. The last arm is additionally bounded by the
 * loop's closing brace, so the dispatch that follows the chain is not attributed
 * to whichever flag happens to end it (and so the two `argv[++i]` mentions in
 * `splitEvalStateTokens`' doc comment stay outside every arm).
 */
function scanChainArms(): ReadonlyMap<string, string> {
  const src = readFileSync(
    join(import.meta.dirname, "..", "..", "src", "cli", "parse-args.ts"),
    "utf8"
  );
  const heads = [...src.matchAll(/a === "(--[a-z0-9-]+)"/g)];
  const loopEnd = src.indexOf("\n  }\n", heads[heads.length - 1]!.index);
  return new Map(
    heads.map((head, i) => {
      const end = Math.min(heads[i + 1]?.index ?? loopEnd, loopEnd);
      return [head[1]!, src.slice(head.index, end)] as const;
    })
  );
}

/**
 * The three published spellings of the posture flag. All of them are refused by
 * every value slot: the slot rule tests the *spelling*, not the bare literal, so
 * neither `=`-form can slip past as an ordinary value. The old per-call-site
 * guards already caught the `=`-form, so these cases are regression guards for the
 * shared reader rather than a newly closed hole — the `=`-form defect this change
 * fixes lived in the `--resume` slot, which reports instead of throwing (see its
 * own case).
 *
 * `=false` is the named non-posture spelling (ADR-0130 §6), and it is refused in a
 * slot on purpose: it is a spelling *of the flag*, not a value, and accepting it
 * as a data root would make one token mean a posture and a path at once. The
 * "means not-posture" answer is the parser's to give in a flag position; inside a
 * slot the only defensible reading is "you did not give me a value".
 */
const POSTURE_SPELLINGS = [
  EVAL_STATE_FLAG,
  `${EVAL_STATE_FLAG}=true`,
  `${EVAL_STATE_FLAG}=false`,
] as const;

/** The two headless one-shot entries (`runOneShot` in cli.ts). */
const EVAL_ENTRIES: ReadonlyArray<{
  readonly command: "ask" | "oneshot";
  readonly argv: string[];
}> = [
  { command: "ask", argv: ["ask", "curl example.com"] },
  { command: "oneshot", argv: ["curl example.com"] },
];

describe("parseArgs --eval-state: accepted on the headless one-shot entries", () => {
  it.each(EVAL_ENTRIES)(
    "$command --eval-state -> evalState=true, no refusal, query intact",
    ({ command, argv }) => {
      const parsed = parseArgs({ argv: [...argv, "--eval-state"] });
      assert.equal(parsed.command, command);
      assert.equal(parsed.evalState, true);
      assert.equal("evalStateRejection" in parsed, false);
      // The flag is valueless: it must be stripped from the positional stream,
      // or it would reach the model as part of the task text.
      assert.equal(parsed.query.includes("--eval-state"), false);
      assert.ok(parsed.query.length > 0, "the query itself still parses");
    }
  );

  it("the flag before the query parses the same as after it", () => {
    const after = parseArgs({ argv: ["ask", "hi", "--eval-state"] });
    const before = parseArgs({ argv: ["--eval-state", "ask", "hi"] });
    assert.deepEqual(before, after);
  });

  it("--eval-state with --auto-mode does not conflict (both yield full_auto)", () => {
    const parsed = parseArgs({
      argv: ["ask", "hi", "--auto-mode", "--eval-state"],
    });
    assert.equal(parsed.autoMode, true);
    assert.equal(parsed.evalState, true);
    assert.equal("evalStateRejection" in parsed, false);
  });
});

describe("parseArgs --eval-state: typed refusal on every other entry", () => {
  it.each(REJECTING_ENTRIES)(
    "$command --eval-state -> eval_state_unsupported_entry naming the command",
    ({ command, argv }) => {
      const parsed = parseArgs({ argv: [...argv, "--eval-state"] });
      assert.equal(parsed.command, command);
      const refusal = parsed.evalStateRejection;
      assert.ok(
        refusal !== undefined,
        `${command} carrying --eval-state must land on the typed refusal`
      );
      assert.equal(refusal.kind, "eval_state_unsupported_entry");
      assert.equal(refusal.command, command);
      assert.equal(refusal instanceof Error, false);
      assert.match(refusal.message, /^eval_state_unsupported_entry: /);
      assert.ok(refusal.message.includes(`'${command}'`));
      // Points at the named benchmark face rather than at --yolo (the two
      // exceptions must never be conflated).
      assert.ok(refusal.message.includes("iknow ask"));
      assert.equal(refusal.message.includes("--yolo"), false);
    }
  );

  it("the refusal object is a plain { kind, command, message } union", () => {
    const refusal = parseArgs({
      argv: ["chat", "--eval-state"],
    }).evalStateRejection;
    assert.ok(refusal !== undefined);
    assert.deepEqual(Object.keys(refusal).sort(), [
      "command",
      "kind",
      "message",
    ]);
  });
});

describe("parseArgs --eval-state: incoherent requests refuse loudly", () => {
  it("--eval-state + --resume is refused (the state is per-invocation, nothing persisted)", () => {
    const parsed = parseArgs({
      argv: ["ask", "hi", "--eval-state", "--resume", "abc-123"],
    });
    assert.equal(parsed.resumeId, "abc-123");
    const refusal = parsed.evalStateRejection;
    assert.ok(refusal !== undefined, "--eval-state with --resume must refuse");
    assert.equal(refusal.kind, "eval_state_flag_conflict");
    assert.equal(refusal.flag, "--resume");
    assert.match(refusal.message, /^eval_state_flag_conflict: /);
  });

  it("--resume alone (no eval state) still parses (existing behavior unchanged)", () => {
    const parsed = parseArgs({ argv: ["ask", "hi", "--resume", "abc-123"] });
    assert.equal(parsed.resumeId, "abc-123");
    assert.equal(parsed.evalState, undefined);
    assert.equal("evalStateRejection" in parsed, false);
  });

  it("read from the raw argv: `--resume --eval-state ask x` refuses instead of swallowing the flag as a resume id", () => {
    const parsed = parseArgs({
      argv: ["--resume", "--eval-state", "ask", "x"],
    });
    assert.equal(parsed.command, "ask");
    assert.ok(parsed.evalStateRejection !== undefined);
    assert.equal(parsed.evalStateRejection?.kind, "eval_state_flag_conflict");
  });

  it("the unsupported-entry refusal wins over the combination check (chat --eval-state --resume)", () => {
    const parsed = parseArgs({
      argv: ["chat", "--eval-state", "--resume", "abc"],
    });
    assert.equal(
      parsed.evalStateRejection?.kind,
      "eval_state_unsupported_entry"
    );
  });
});

describe("parseArgs --eval-state: --yolo is not widened by the new face", () => {
  it("ask --eval-state --yolo still produces the typed yolo refusal", () => {
    const parsed = parseArgs({ argv: ["ask", "hi", "--eval-state", "--yolo"] });
    assert.equal(parsed.yoloRejection?.kind, "yolo_non_tui_entry");
    assert.equal(parsed.yoloRejection?.command, "ask");
  });

  // Not REJECTING_ENTRIES: `tui` rejects --eval-state but is the one entry that
  // legally takes --yolo (ADR-0119 §ruling 7), so it has no yolo refusal here.
  it.each(REJECTING_ENTRIES.filter(({ command }) => command !== "tui"))(
    "$command --yolo still produces the yolo refusal when --eval-state is present too",
    ({ argv }) => {
      const parsed = parseArgs({ argv: [...argv, "--eval-state", "--yolo"] });
      assert.equal(parsed.yoloRejection?.kind, "yolo_non_tui_entry");
    }
  );

  it("tui --eval-state --yolo keeps its legal --yolo and still refuses the new flag", () => {
    const parsed = parseArgs({
      argv: ["tui", "--eval-state", "--yolo"],
      interactive: true,
    });

    assert.equal(parsed.yolo, true);
    assert.equal("yoloRejection" in parsed, false);
    assert.equal(
      parsed.evalStateRejection?.kind,
      "eval_state_unsupported_entry"
    );
  });

  it("tui --yolo is untouched by the eval-state face", () => {
    const parsed = parseArgs({ argv: ["tui", "--yolo"], interactive: true });
    assert.equal(parsed.command, "tui");
    assert.equal(parsed.yolo, true);
    assert.equal("yoloRejection" in parsed, false);
    assert.equal(parsed.evalState, undefined);
  });
});

describe("parseArgs --eval-state: absent = zero change", () => {
  it.each([...EVAL_ENTRIES, ...REJECTING_ENTRIES])(
    "$command without the flag -> evalState key present but undefined, no refusal",
    ({ argv }) => {
      const parsed = parseArgs({ argv });
      assert.equal("evalState" in parsed, true);
      assert.equal(parsed.evalState, undefined);
      assert.equal("evalStateRejection" in parsed, false);
    }
  );

  it.each([...EVAL_ENTRIES, ...REJECTING_ENTRIES])(
    "$command: adding the flag changes the eval axis only",
    ({ argv }) => {
      const strip = (p: ReturnType<typeof parseArgs>) => {
        const { evalState, evalStateRejection, ...rest } = p;
        return { rest, evalState, evalStateRejection };
      };
      const without = strip(parseArgs({ argv }));
      const withFlag = strip(parseArgs({ argv: [...argv, "--eval-state"] }));
      assert.equal(without.evalState, undefined);
      assert.equal(withFlag.evalState, true);
      // Stripped of the two eval fields the two readings must be identical —
      // the expectation derives from the flag-free reading itself.
      assert.deepEqual(withFlag.rest, without.rest);
    }
  );
});

describe("parseArgs --eval-state: the posture is detected in a flag position only", () => {
  it("the literal in a value-taking flag's slot never becomes that flag's value", () => {
    assert.throws(
      () => parseArgs({ argv: ["ask", "--data-dir", EVAL_STATE_FLAG, "hi"] }),
      new RegExp(`Invalid --data-dir: ${EVAL_STATE_FLAG}`),
      "a value slot must fail loudly, never silently become a data root"
    );
  });

  it.each(
    VALUE_TAKING_FLAGS.flatMap((flag) =>
      POSTURE_SPELLINGS.map((raw) => [flag, raw] as const)
    )
  )(
    "%s %s fails loudly instead of taking the posture spelling as a value",
    (flag, raw) => {
      assert.throws(
        () => parseArgs({ argv: ["ask", flag, raw, "hi"] }),
        new RegExp(`Invalid ${flag}: ${raw}`)
      );
    }
  );

  it.each(POSTURE_SPELLINGS)(
    "a resume-id slot holding %s refuses with the typed posture conflict",
    (raw) => {
      const parsed = parseArgs({
        argv: ["ask", "--resume", raw, "hi"],
      });
      assert.equal(
        parsed.resumeId,
        undefined,
        "the posture spelling is not a conversation id"
      );
      assert.equal(
        parsed.evalState,
        undefined,
        "a token consumed as a flag value cannot open the posture"
      );
      assert.equal(parsed.evalStateRejection?.kind, "eval_state_flag_conflict");
      assert.equal(parsed.evalStateRejection?.flag, "--resume");
      // Regression guard: `readResumeSlot` used to match only the bare literal, so
      // the `=`-form fell through as a plain id and `ask --resume
      // --eval-state=true hi` silently resumed a session named "--eval-state=true"
      // — no posture entered, and nothing refused. Asserting the exact shape
      // above already implies it, but the id is the value that actually escaped.
      assert.notEqual(parsed.resumeId, raw);
    }
  );

  it("a literal in the query text does not flip the posture and survives intact", () => {
    const words = ["ask", "grep", EVAL_STATE_FLAG, "in", "src/config"];
    const parsed = parseArgs({ argv: [...words] });
    assert.equal(parsed.command, "ask");
    assert.equal(
      parsed.evalState,
      undefined,
      "operator query text must never open the fence-retiring posture"
    );
    assert.equal("evalStateRejection" in parsed, false);
    assert.equal(
      parsed.query,
      words.slice(1).join(" "),
      "the query the operator typed must reach the model unchanged"
    );
  });

  it("a quoted literal is untouched (one token carrying the flag stays query text)", () => {
    const parsed = parseArgs({
      argv: ["ask", `grep ${EVAL_STATE_FLAG} in src/config`],
    });
    assert.equal(parsed.evalState, undefined);
    assert.equal(parsed.query, `grep ${EVAL_STATE_FLAG} in src/config`);
  });

  it.each(REJECTING_ENTRIES)(
    "$command with the literal in its query text is not refused (it never asked for eval state)",
    ({ command, argv }) => {
      const parsed = parseArgs({
        argv: [...argv, "grep", EVAL_STATE_FLAG, "in", "src"],
      });
      assert.equal(parsed.command, command);
      assert.equal(parsed.evalState, undefined);
      assert.equal("evalStateRejection" in parsed, false);
    }
  );

  it(`${EVAL_STATE_FLAG}=true is recognized, not garbage folded into the query`, () => {
    const parsed = parseArgs({
      argv: ["ask", "hi", `${EVAL_STATE_FLAG}=true`],
    });
    // An unrecognized spelling used to fall into the query: fenced run, prompt
    // carrying the flag as task text. Recognizing it makes the two agree.
    assert.equal(parsed.evalState, true);
    assert.equal(
      parsed.query,
      "hi",
      `${EVAL_STATE_FLAG}=true must not land in the operator's query`
    );
    assert.equal(parsed.query.includes(EVAL_STATE_FLAG), false);
    assert.equal("evalStateRejection" in parsed, false);
  });

  it(`${EVAL_STATE_FLAG}=true inside the query text is still the operator's word`, () => {
    const parsed = parseArgs({
      argv: ["ask", "grep", `${EVAL_STATE_FLAG}=true`, "in", "src"],
    });
    assert.equal(parsed.evalState, undefined);
    assert.equal(parsed.query, `grep ${EVAL_STATE_FLAG}=true in src`);
  });

  it(`${EVAL_STATE_FLAG}=false is the named non-posture spelling, still fenced`, () => {
    const parsed = parseArgs({
      argv: ["ask", "hi", `${EVAL_STATE_FLAG}=false`],
    });
    assert.equal(parsed.evalState, undefined);
    assert.equal(parsed.query, "hi");
  });

  it("the =true spelling goes through the same entry gate as the bare flag", () => {
    const refused = parseArgs({ argv: ["tui", `${EVAL_STATE_FLAG}=true`] });
    assert.equal(
      refused.evalStateRejection?.kind,
      "eval_state_unsupported_entry"
    );
    // Trailing option position after the query: still a request, and honored.
    const trailing = parseArgs({
      argv: ["ask", "explain", `${EVAL_STATE_FLAG}=true`],
    });
    assert.equal(trailing.evalState, true);
    assert.equal(trailing.query, "explain");
    // Between the operator's own words it is one of their words, so nothing
    // refuses and nothing is stripped.
    const queried = parseArgs({
      argv: ["ask", "explain", `${EVAL_STATE_FLAG}=true`, "to me"],
    });
    assert.equal("evalStateRejection" in queried, false);
    assert.equal(queried.evalState, undefined);
    assert.equal(queried.query, `explain ${EVAL_STATE_FLAG}=true to me`);
  });

  it("the bare invocation with the literal as a positional query stays fenced and keeps the text", () => {
    const parsed = parseArgs({
      argv: ["grep", EVAL_STATE_FLAG, "in", "src/config"],
      interactive: true,
    });
    assert.equal(parsed.command, "oneshot");
    assert.equal(parsed.evalState, undefined);
    assert.equal(parsed.query, `grep ${EVAL_STATE_FLAG} in src/config`);
  });

  it("the published spelling keeps working on both sides of the query (flag region, not query region)", () => {
    // `iknow ask --eval-state "<task>"` — flag before the query text.
    const before = parseArgs({ argv: ["ask", EVAL_STATE_FLAG, "do the task"] });
    assert.equal(before.evalState, true);
    assert.equal(before.query, "do the task");
    assert.equal(before.query.includes(EVAL_STATE_FLAG), false);
    // The same flag after the query text (the post-query shape).
    const after = parseArgs({ argv: ["ask", "do the task", EVAL_STATE_FLAG] });
    assert.equal(after.evalState, true);
    assert.equal(after.query, "do the task");
    assert.deepEqual(after, before);
  });

  it("a valueless flag that is not the posture flag is consumed as a flag even mid-query (pre-existing, out of scope)", () => {
    // PRE-EXISTING ASYMMETRY, deliberately pinned rather than fixed here: the
    // posture flag is position-checked (its own `splitEvalStateTokens` span rule
    // keeps a spelling between the operator's words in the query), while every
    // other valueless flag is consumed wherever it sits. So `ask grep --json in
    // src` loses the operator's `--json` from the task text. That wart is
    // tracked separately; this change deletes the registry of valueless flag
    // literals and must not shift this behavior in either direction.
    const parsed = parseArgs({ argv: ["ask", "grep", "--json", "in", "src"] });
    assert.equal(parsed.json, true);
    assert.equal(parsed.query, "grep in src");
    // The posture flag's own mid-query case, side by side, stays as it was: the
    // same position, the opposite treatment.
    const posture = parseArgs({
      argv: ["ask", "grep", EVAL_STATE_FLAG, "in", "src"],
    });
    assert.equal(posture.evalState, undefined);
    assert.equal(posture.query, `grep ${EVAL_STATE_FLAG} in src`);
  });
});

describe("parseArgs --eval-state: display paths still read the posture without the literal registry", () => {
  // The valueless-flag registry that used to exist was consulted by the
  // display-path reading too. These cases pin the reading that replaced it: on a
  // display path the operator typed no task text, so no token is an operator
  // word and the whole argv is option positions. The order that matters is the
  // flag *after* the posture flag — that is the ordering a name table was
  // covering for, and the ordering that reads `undefined` if the span rule is
  // applied to a stream that has no span.
  it.each([
    { argv: ["-h", EVAL_STATE_FLAG], why: "flag after the help flag" },
    { argv: [EVAL_STATE_FLAG, "-V"], why: "flag before the version flag" },
    {
      argv: ["--json", "-h", EVAL_STATE_FLAG],
      why: "a valueless flag before the help flag must not close the option span",
    },
    {
      argv: ["-h", "--color", EVAL_STATE_FLAG],
      why: "an unknown token before the posture flag must not close the option span either",
    },
    {
      argv: ["-h", "hello", EVAL_STATE_FLAG],
      why: "a word typed alongside a display flag is still not query text",
    },
  ])("$why -> help, evalState=true, no refusal", ({ argv }) => {
    const parsed = parseArgs({ argv });
    assert.equal(parsed.command, "help");
    assert.equal(parsed.evalState, true);
    assert.equal("evalStateRejection" in parsed, false);
  });

  // A display path has no query, so every token is an option position and a
  // valueless flag sitting *after* the posture flag cannot become an operator
  // word that swallows it. These are the orderings the removed name table used
  // to make true; the wordless reading has to keep them true on its own.
  it.each(["--json", "--no-open", "--separate", "--auto-mode", "--yolo"])(
    "-h --eval-state %s -> help, evalState=true",
    (flag) => {
      const parsed = parseArgs({ argv: ["-h", EVAL_STATE_FLAG, flag] });
      assert.equal(parsed.command, "help");
      assert.equal(parsed.evalState, true);
      assert.equal("evalStateRejection" in parsed, false);
    }
  );

  it.each([
    { argv: ["--json", EVAL_STATE_FLAG, "-h"], versionOnly: false },
    { argv: ["-V", EVAL_STATE_FLAG, "--json"], versionOnly: true },
  ])(
    "$argv -> help (versionOnly=$versionOnly), evalState=true",
    ({ argv, versionOnly }) => {
      const parsed = parseArgs({ argv });
      assert.equal(parsed.command, "help");
      assert.equal(parsed.versionOnly, versionOnly);
      assert.equal(parsed.evalState, true);
      assert.equal("evalStateRejection" in parsed, false);
    }
  );

  it("the wordless reading is not 'any --eval-state-shaped token counts'", () => {
    // No posture spelling in option position: `=false` is the named
    // non-posture spelling, and must keep reading as "not in eval state".
    assert.equal(
      parseArgs({ argv: ["--eval-state=false", "-h"] }).evalState,
      undefined
    );
    assert.equal(parseArgs({ argv: ["-h"] }).evalState, undefined);
    assert.equal(parseArgs({ argv: ["-V"] }).evalState, undefined);
    assert.equal(parseArgs({ argv: ["-h", "--json"] }).evalState, undefined);
  });
});

describe("parseArgs: the value-slot tripwire is derived from the parser's own source", () => {
  it("the value-consuming arms of the scan chain are exactly the slot table plus --resume", () => {
    // The binding half of the tripwire. Advancing `i` past a token is the loop's
    // only way of taking a flag's value, so the arms that do it ARE the
    // value-taking flags — read from the source, not from prose. A flag added
    // here fails the suite even if nothing documents it.
    const arms = scanChainArms();
    assert.ok(arms.size > 0, "the scan chain arms were found in the source");
    const fromSource = [...arms]
      .filter(([, body]) => body.includes("++i"))
      .map(([flag]) => flag)
      .sort();
    assert.deepEqual(
      fromSource,
      [...VALUE_TAKING_FLAGS, REPORTING_VALUE_FLAG].sort()
    );
  });

  it("every value-consuming arm except --resume reads its slot through slotValue", () => {
    // The rule the ADR claims has no second site. Asserting it from the source is
    // what makes the claim checkable: a value flag written the old way (taking
    // the token itself and applying its own check) fails here, which is exactly
    // the site ADR-0130 §7 says can no longer be forgotten.
    const offenders = [...scanChainArms()]
      .filter(
        ([flag, body]) =>
          flag !== REPORTING_VALUE_FLAG &&
          body.includes("++i") &&
          !body.includes("slotValue(")
      )
      .map(([flag]) => flag);
    assert.deepEqual(
      offenders,
      [],
      "value slots must be read through slotValue; --resume is the one declared " +
        "exception (it reports the posture through evalStateRejection instead)"
    );
  });

  it("the arms found are the whole scan chain (the extraction sees every flag head)", () => {
    // Guards the extraction itself: if the source is restructured so the heads no
    // longer match, the two cases above would vacuously pass on a wrong or empty
    // set. Every head is named here, so a chain that grows or loses one is a
    // visible edit to this list rather than a silently different tripwire.
    assert.deepEqual([...scanChainArms().keys()].sort(), [
      "--auto-mode",
      "--data-dir",
      "--help",
      "--host",
      "--json",
      "--max-bytes",
      "--max-turns",
      "--no-open",
      "--port",
      "--resume",
      "--separate",
      "--subagent-worker",
      "--trace-out",
      "--version",
      "--workspace-root",
    ]);
  });
});

describe("usageText: the published value-taking options are all covered by the slot table", () => {
  it("every `--flag <value>` line in the options block has a slot case (tripwire on the table)", () => {
    // The documentation-coverage half of the tripwire: a value-taking flag the
    // help text publishes has a slot case whether or not the source-derived guard
    // in the previous block has been updated. It cannot see an *undocumented*
    // flag, which is why it is not the binding guard.
    const published = [
      ...usageText().matchAll(/^ {2}(--[a-z][a-z0-9-]*) <[a-z]+>/gm),
    ].map((m) => m[1]!);
    assert.ok(
      published.length > 0,
      "the options block still publishes value flags"
    );
    const covered = new Set<string>([
      ...VALUE_TAKING_FLAGS,
      REPORTING_VALUE_FLAG,
    ]);
    for (const flag of published) {
      assert.ok(
        covered.has(flag),
        `${flag} is published as a value-taking flag but has no slot case; ` +
          `add it to VALUE_TAKING_FLAGS (or to the resume case)`
      );
    }
    // `--trace-out`, `--max-turns` and `--resume` take values but are not in the
    // options block, so nothing derives them from usage. Naming them here is what
    // keeps the gap a stated exception rather than a silent hole; the
    // source-derived guard is what actually covers them.
    const unpublished = ["--trace-out", "--max-turns", "--resume"].filter(
      (flag) => !published.includes(flag)
    );
    assert.deepEqual(unpublished.sort(), [
      "--max-turns",
      "--resume",
      "--trace-out",
    ]);
  });
});

describe("parseArgs --eval-state: pure display paths are the declared allowance", () => {
  it.each(["-h", "--help"])(
    "%s with --eval-state -> help, no refusal",
    (flag) => {
      const parsed = parseArgs({ argv: [flag, "--eval-state"] });
      assert.equal(parsed.command, "help");
      assert.equal("evalStateRejection" in parsed, false);
    }
  );

  it.each(["-V", "--version"])(
    "%s with --eval-state -> versionOnly, no refusal",
    (flag) => {
      const parsed = parseArgs({ argv: ["--eval-state", flag] });
      assert.equal(parsed.command, "help");
      assert.equal(parsed.versionOnly, true);
      assert.equal("evalStateRejection" in parsed, false);
    }
  );

  it.each([true, false])(
    "bare --eval-state (no subcommand, interactive=%s) -> help, not a silent chat session",
    (interactive) => {
      const parsed = parseArgs({ argv: ["--eval-state"], interactive });
      assert.equal(parsed.command, "help");
      assert.notEqual(parsed.command, "chat");
      assert.equal("evalStateRejection" in parsed, false);
    }
  );

  it("iknow help --eval-state -> help (positional subcommand, same display path)", () => {
    const parsed = parseArgs({ argv: ["help", "--eval-state"] });
    assert.equal(parsed.command, "help");
    assert.equal("evalStateRejection" in parsed, false);
  });
});

describe("parseArgs --eval-state: the worker early-return path skips the gate", () => {
  it("--subagent-worker + --eval-state -> worker command, no refusal, no evalState key", () => {
    const parsed = parseArgs({ argv: ["--subagent-worker", "--eval-state"] });
    assert.equal(parsed.command, "__subagent_worker__");
    assert.equal("evalStateRejection" in parsed, false);
    assert.equal(
      Object.prototype.hasOwnProperty.call(parsed, "evalState"),
      false
    );
  });
});

describe("usageText: --eval-state is published", () => {
  it("carries the flag line and names the accepting entries and the refusals", () => {
    const t = usageText();
    assert.match(t, /--eval-state/);
    assert.match(t, /ADR-0130/);
    assert.match(t, /ask \/ oneshot/);
    assert.match(t, /chat \/ serve \/ trace \/ tui/);
    assert.match(t, /非零退出|non-zero exit/i);
  });

  it("publishes that the flag is neither yolo nor a persisted setting", () => {
    const t = usageText();
    const line = t
      .split("\n")
      .filter((l) => l.includes("--eval-state"))
      .join("\n");
    assert.match(line, /不落盘|not persisted/i);
    assert.match(line, /围栏|fence/i);
  });

  it("the --yolo face keeps its published TUI-only wording (unchanged)", () => {
    const t = usageText();
    assert.match(t, /仅 tui|tui only/i);
    assert.match(t, /chat \/ serve \/ ask \/ oneshot \/ trace/);
  });
});
