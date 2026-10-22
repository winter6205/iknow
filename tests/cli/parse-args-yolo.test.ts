/**
 * tests/cli/parse-args-yolo.test.ts
 *
 * ADR-0119 / `specs/yolo-mode.md`: the CLI entry parsing contract of `--yolo`
 * (no-sandbox mode).
 *
 * Invariants pinned (`ADR-0119` / `specs/yolo-mode.md`):
 *   1. The five non-TUI **session** commands (chat / serve / ask / oneshot /
 *      trace) carrying `--yolo` -> the parse result carries the typed refusal
 *      (discriminated-union `kind`), never a bare thrown Error.
 *   2. `--yolo` absent -> both fields absent, and the five commands parse
 *      field-for-field unchanged (structural equivalence asserted, no hardcoded
 *      field list: the flagged result with its two yolo fields stripped equals the
 *      unflagged result).
 *   3. `iknow tui --yolo` -> command `tui` + `yolo: true`, no refusal.
 *   4. The `--subagent-worker` early-return path does not pass this gate (spawned
 *      by the parent agent only, not a product entry).
 *   5. Pure display paths are explicitly allowed (`-h` / `--help` / `-V` /
 *      `--version`, and a bare `--yolo` with no subcommand **without a TTY**):
 *      exit 0 display, no session start, no refusal filled. On a TTY the same
 *      bare `--yolo` starts the TUI holding that posture (ADR-0119's legal home
 *      for the flag) instead of falling to a non-TUI session.
 *   6. `--yolo` together with `--auto-mode` does not conflict.
 *
 * Parsing layer only; the dispatch-time rendering in cli.ts (stderr + exit 1) is
 * certified black-box against a real child process by
 * `tests/cli/cli-yolo-non-tui-reject.test.ts`.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { parseArgs } from "../../src/cli/parse-args.ts";
import { usageText } from "../../src/cli/usage.ts";

/** One argv per non-TUI public session entry (`YOLO_TUI_ONLY_REJECTED_COMMANDS`). */
const NON_TUI_ENTRIES: ReadonlyArray<{
  readonly command: "chat" | "serve" | "ask" | "oneshot" | "trace";
  readonly argv: string[];
}> = [
  { command: "chat", argv: ["chat"] },
  { command: "serve", argv: ["serve"] },
  { command: "ask", argv: ["ask", "hi"] },
  { command: "oneshot", argv: ["hi"] },
  { command: "trace", argv: ["trace"] },
];

describe("parseArgs --yolo: typed refusal on non-TUI entries (ADR-0119 ruling 7)", () => {
  it.each(NON_TUI_ENTRIES)(
    "$command --yolo -> yoloRejection.kind=yolo_non_tui_entry, message names the command",
    ({ command, argv }) => {
      const parsed = parseArgs({ argv: [...argv, "--yolo"] });
      // The command itself still parses normally — the refusal is an added
      // reading, not a rewritten command.
      assert.equal(parsed.command, command);
      const rejection = parsed.yoloRejection;
      assert.ok(
        rejection !== undefined,
        `${command} carrying --yolo must land on the typed refusal`
      );
      assert.equal(rejection.kind, "yolo_non_tui_entry");
      assert.equal(rejection.command, command);
      // The message is built at one point in yolo.ts: `${kind}: ...` prefix plus
      // the named command.
      assert.match(rejection.message, /^yolo_non_tui_entry: /);
      assert.ok(
        rejection.message.includes(`'${command}'`),
        `the message must name the command, got: ${rejection.message}`
      );
      assert.ok(
        rejection.message.includes("iknow tui"),
        "the message must point at the single legal entry, iknow tui"
      );
    }
  );

  it("the refusal is not a bare Error — the discriminated union is usable (shape premise forbidding the [object Object] collapse)", () => {
    const parsed = parseArgs({ argv: ["chat", "--yolo"] });
    const rejection = parsed.yoloRejection;
    assert.ok(rejection !== undefined);
    assert.equal(rejection instanceof Error, false);
    // kind / command must be readable top-level fields of the union.
    assert.deepEqual(
      Object.keys(rejection).sort(),
      ["command", "kind", "message"],
      "the typed refusal must be a plain object { kind, command, message }"
    );
  });

  it("read from the raw argv: `--resume --yolo chat` also counts as carried (biased towards refusal)", () => {
    // The handling of this degenerate input is a deliberate choice: when --yolo
    // lands in a value-taking flag's argument slot, misreading the dangerous flag
    // must bias towards refusal, never towards swallowing it silently as a resume id.
    const parsed = parseArgs({ argv: ["--resume", "--yolo", "chat"] });
    assert.equal(parsed.command, "chat");
    assert.equal(parsed.yoloRejection?.kind, "yolo_non_tui_entry");
  });

  it("ask --yolo still parses the query (the refusal touches no other field)", () => {
    const parsed = parseArgs({ argv: ["ask", "hello", "--yolo"] });
    assert.equal(parsed.command, "ask");
    assert.equal(parsed.query, "hello");
    assert.equal(parsed.missingQuery, false);
    assert.equal(parsed.yoloRejection?.kind, "yolo_non_tui_entry");
  });
});

describe("parseArgs --yolo: absent = zero change", () => {
  it.each(NON_TUI_ENTRIES)(
    "$command without --yolo -> both yolo and yoloRejection absent",
    ({ command, argv }) => {
      const parsed = parseArgs({ argv });
      assert.equal(parsed.command, command);
      assert.equal(parsed.yolo, undefined);
      assert.equal("yoloRejection" in parsed, false);
    }
  );

  it.each(NON_TUI_ENTRIES)(
    "$command: adding --yolo changes the yolo axis only, every other field holds",
    ({ argv }) => {
      const stripYolo = (p: ReturnType<typeof parseArgs>) => {
        const { yolo, yoloRejection, ...rest } = p;
        return { rest, yolo, yoloRejection };
      };
      const without = stripYolo(parseArgs({ argv }));
      const withFlag = stripYolo(parseArgs({ argv: [...argv, "--yolo"] }));
      // Both sides have the two yolo fields stripped and must then be
      // structurally equal — the expectation is derived from the SSOT (the
      // flag-free reading itself), leaving no hardcoded field table behind.
      assert.equal(without.yolo, undefined);
      assert.equal(withFlag.yolo, true);
      assert.ok(withFlag.yoloRejection !== undefined);
      assert.deepEqual(withFlag.rest, without.rest);
    }
  );

  it("when absent: the yolo key exists with value undefined (flags are always filled), yoloRejection's whole key is absent", () => {
    const parsed = parseArgs({ argv: ["chat"] });
    assert.equal("yolo" in parsed, true);
    assert.equal(parsed.yolo, undefined);
    assert.equal("yoloRejection" in parsed, false);
  });
});

describe("parseArgs --yolo: the tui entry (the only legal face)", () => {
  it("iknow tui --yolo -> command=tui, yolo=true, no refusal", () => {
    const parsed = parseArgs({ argv: ["tui", "--yolo"], interactive: true });
    assert.equal(parsed.command, "tui");
    assert.equal(parsed.yolo, true);
    assert.equal("yoloRejection" in parsed, false);
  });

  it("iknow tui <session-id> --yolo -> the positional argument is not swallowed", () => {
    const parsed = parseArgs({
      argv: ["tui", "abc-123", "--yolo"],
      interactive: true,
    });
    assert.equal(parsed.command, "tui");
    assert.equal(parsed.sessionId, "abc-123");
    assert.equal(parsed.yolo, true);
    assert.equal(parsed.yoloRejection, undefined);
  });

  it("--yolo with --auto-mode does not conflict (both yield full_auto; tui entry)", () => {
    const parsed = parseArgs({
      argv: ["--auto-mode", "--yolo", "tui"],
      interactive: true,
    });
    assert.equal(parsed.command, "tui");
    assert.equal(parsed.autoMode, true);
    assert.equal(parsed.yolo, true);
    assert.equal(parsed.yoloRejection, undefined);
  });

  it("--yolo + --auto-mode on a non-tui entry: autoMode is still set, the refusal still applies", () => {
    const parsed = parseArgs({ argv: ["chat", "--auto-mode", "--yolo"] });
    assert.equal(parsed.command, "chat");
    assert.equal(parsed.autoMode, true);
    assert.equal(parsed.yoloRejection?.kind, "yolo_non_tui_entry");
  });

  it("tui without --yolo -> yolo absent, no refusal (existing behavior does not regress)", () => {
    const parsed = parseArgs({ argv: ["tui"], interactive: true });
    assert.equal(parsed.command, "tui");
    assert.equal(parsed.yolo, undefined);
    assert.equal("yoloRejection" in parsed, false);
  });
});

describe("parseArgs --yolo: the worker early-return path skips this gate (#356)", () => {
  it("--subagent-worker + --yolo -> command=__subagent_worker__, no refusal, no yolo key", () => {
    const parsed = parseArgs({ argv: ["--subagent-worker", "--yolo"] });
    assert.equal(parsed.command, "__subagent_worker__");
    assert.equal("yoloRejection" in parsed, false);
    // The early return uses all-default fields; the yolo axis means nothing to a
    // worker (the parent passes it through the env wire), hence the whole key is
    // absent rather than undefined.
    assert.equal(Object.prototype.hasOwnProperty.call(parsed, "yolo"), false);
  });
});

describe("parseArgs --yolo: pure display paths explicitly allowed (exit 0, no session start)", () => {
  it.each(["-h", "--help"])(
    "%s with --yolo -> help, no refusal filled",
    (flag) => {
      const parsed = parseArgs({ argv: [flag, "--yolo"] });
      assert.equal(parsed.command, "help");
      assert.equal(parsed.versionOnly, false);
      assert.equal("yoloRejection" in parsed, false);
    }
  );

  it.each(["-V", "--version"])(
    "%s with --yolo -> versionOnly=true, no refusal filled",
    (flag) => {
      const parsed = parseArgs({ argv: ["--yolo", flag] });
      assert.equal(parsed.command, "help");
      assert.equal(parsed.versionOnly, true);
      assert.equal("yoloRejection" in parsed, false);
    }
  );

  it("bare --yolo without a TTY -> help, no refusal filled", () => {
    const parsed = parseArgs({ argv: ["--yolo"], interactive: false });
    assert.equal(parsed.command, "help");
    assert.equal(parsed.versionOnly, false);
    assert.equal("yoloRejection" in parsed, false);
  });

  it("iknow help --yolo -> help (positional subcommand, same display path)", () => {
    const parsed = parseArgs({ argv: ["help", "--yolo"] });
    assert.equal(parsed.command, "help");
    assert.equal("yoloRejection" in parsed, false);
  });
});

describe("usageText: publishing --yolo", () => {
  // The usage text is one English-only data table, so each assertion pins the
  // exact published wording rather than accepting a translation face.
  it("carries a --yolo line and publishes TUI-only / no-sandbox / not persisted / in-session confirmation", () => {
    const t = usageText();
    assert.match(t, /--yolo/);
    assert.match(t, /tui only/i);
    assert.match(t, /no-sandbox/i);
    assert.match(t, /not persisted/i);
    assert.match(t, /confirmation/i);
  });

  it("publishes that the five non-TUI commands refuse it when carried (trace included)", () => {
    const t = usageText();
    assert.match(t, /chat \/ serve \/ ask \/ oneshot \/ trace/);
    assert.match(t, /non-zero exit/i);
  });

  it("the trace line publishes the same --yolo constraint", () => {
    const t = usageText();
    assert.match(t, /trace is a session command: --yolo is incompatible/);
  });

  it("the tui usage line publishes --yolo", () => {
    const t = usageText();
    assert.match(t, /iknow tui \[session-id\] \[--auto-mode\] \[--yolo\]/);
  });
});

// ADR-0141: `--no-sandbox` is a second NAMED preset entry, so it inherits the
// same exhaustive non-TUI refusal. The enumeration is the defense line — a new
// entry added to the rejected-command list without a matching flag arm would
// leave the gap this group exists to close.
describe("parseArgs --no-sandbox: the same typed refusal on the same five entries", () => {
  it.each(NON_TUI_ENTRIES)(
    "$command --no-sandbox -> yoloRejection.kind=yolo_non_tui_entry, message names the FLAG typed",
    ({ command, argv }) => {
      const parsed = parseArgs({ argv: [...argv, "--no-sandbox"] });
      assert.equal(parsed.command, command);
      const rejection = parsed.yoloRejection;
      assert.ok(
        rejection !== undefined,
        `${command} carrying --no-sandbox must land on the typed refusal`
      );
      assert.equal(rejection.kind, "yolo_non_tui_entry");
      assert.equal(rejection.command, command);
      // The message names the flag actually typed — telling someone who typed
      // --no-sandbox to "drop --yolo" would point at the wrong token.
      assert.ok(
        rejection.message.includes("--no-sandbox"),
        `the message must name --no-sandbox, got: ${rejection.message}`
      );
      assert.ok(
        !rejection.message.includes("Drop --yolo"),
        "the advice must match the flag typed"
      );
      assert.ok(rejection.message.includes(`'${command}'`));
    }
  );

  it("iknow tui --no-sandbox -> command=tui, noSandbox=true, no refusal", () => {
    const parsed = parseArgs({ argv: ["tui", "--no-sandbox"] });
    assert.equal(parsed.command, "tui");
    assert.equal(parsed.noSandbox, true);
    assert.equal(parsed.yoloRejection, undefined);
  });

  it("the two flags are independent: --no-sandbox alone leaves yolo unset", () => {
    const parsed = parseArgs({ argv: ["tui", "--no-sandbox"] });
    assert.equal(parsed.yolo, undefined);
    const both = parseArgs({ argv: ["tui", "--no-sandbox", "--yolo"] });
    assert.equal(both.noSandbox, true);
    assert.equal(both.yolo, true);
  });

  it("--no-sandbox is stripped, never reaching the positional stream", () => {
    const parsed = parseArgs({ argv: ["tui", "sess-1", "--no-sandbox"] });
    assert.equal(parsed.command, "tui");
    assert.ok(
      !JSON.stringify(parsed).includes("--no-sandbox\",") ,
      "the flag must not survive into the query/positional output"
    );
  });

  it("bare --no-sandbox off a TTY -> help, no refusal (display path allowance)", () => {
    const parsed = parseArgs({ argv: ["--no-sandbox"], interactive: false });
    assert.equal(parsed.command, "help");
    assert.equal(parsed.yoloRejection, undefined);
  });

  it("absent: noSandbox is undefined and no refusal key exists", () => {
    const parsed = parseArgs({ argv: ["tui"] });
    assert.equal(parsed.noSandbox, undefined);
    assert.equal(parsed.yoloRejection, undefined);
  });
});
