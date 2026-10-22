/**
 * tests/cli/parse-args-bare-route.test.ts
 *
 * The bare-invocation route: no subcommand head and no query text. This is the
 * one place the parser decides between the display path, the chat route and the
 * TUI, so every row of the launch contract is pinned here at the parser.
 *
 * Invariants:
 *   1. A bare TTY invocation starts the TUI in default mode — nothing about the
 *      posture is inferred, and the launch carries no session request.
 *   2. A bare TTY invocation with a TUI-only posture (`--yolo` / `--auto-mode`)
 *      starts the TUI holding that posture; the two axes stay independent
 *      (ADR-0119: yolo is the fence axis, it never writes the permission axis).
 *   3. `--json` and `--resume <id>` are chat's own anchors: on a TTY they keep the
 *      chat route and its observable behavior.
 *   4. A chat anchor plus a TUI-only posture is refused as a typed conflict
 *      instead of silently discarding one of the two requests.
 *   5. A display path starts nothing: non-TTY bare invocations, and a bare
 *      `--eval-state` on either TTY state, keep printing usage (ADR-0130:
 *      displaying the flag is not an eval-state execution).
 *   6. `implicitTuiLaunch` marks only the ordinary bare TTY launch, because only
 *      that launch may fall back to chat when Bun is missing.
 *
 * The TTY half is proven at the parser (`interactive: true`); process-level tests
 * spawn the CLI with pipes, so they always see the non-TTY half —
 * `tests/cli/cli-yolo-non-tui-reject.test.ts` certifies that face against a real
 * child, and the missing-Bun branch selection against the source of `cli.ts` in
 * `tests/cli/tui-launch-fallback.test.ts`.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { parseArgs } from "../../src/cli/parse-args.ts";

describe("parseArgs bare route: a TTY starts the TUI in default mode", () => {
  it("bare invocation + TTY -> tui, no posture, no session request", () => {
    const parsed = parseArgs({ argv: [], interactive: true });
    assert.equal(parsed.command, "tui");
    assert.equal(parsed.query, "");
    assert.equal(parsed.missingQuery, false);
    assert.equal(parsed.sessionId, undefined);
    assert.equal(parsed.yolo, undefined);
    assert.equal(parsed.autoMode, false);
    assert.equal(parsed.json, false);
    assert.equal(parsed.resumeId, undefined);
    assert.equal("yoloRejection" in parsed, false);
    assert.equal("evalStateRejection" in parsed, false);
    assert.equal("tuiEntryRejection" in parsed, false);
  });

  it("the plain TTY launch is marked implicit, so a missing Bun may fall back", () => {
    assert.equal(
      parseArgs({ argv: [], interactive: true }).implicitTuiLaunch,
      true
    );
  });

  it("options the TUI consumes still pass through the bare route", () => {
    const parsed = parseArgs({
      argv: ["--data-dir", "/tmp/pool", "--workspace-root", "/tmp/repo"],
      interactive: true,
    });
    assert.equal(parsed.command, "tui");
    assert.equal(parsed.dataDir, "/tmp/pool");
    assert.equal(parsed.workspaceRoot, "/tmp/repo");
    assert.equal(parsed.implicitTuiLaunch, true);
  });

  it("bare --max-turns is parsed, not swallowed (the TUI seam stays open)", () => {
    // The bare route's TUI launch carries the parsed cap to the engine assembly,
    // so a request that is not dropped here is one the operator sees honored; the
    // pass-through is asserted instead of dropping it.
    const parsed = parseArgs({
      argv: ["--max-turns", "5"],
      interactive: true,
    });
    assert.equal(parsed.command, "tui");
    assert.equal(parsed.maxTurns, 5);
    assert.equal(parsed.implicitTuiLaunch, true);
  });
});

describe("parseArgs bare route: a TUI-only posture is carried into the TUI", () => {
  it("bare --yolo + TTY -> tui holding yolo, and no non-TUI refusal", () => {
    const parsed = parseArgs({ argv: ["--yolo"], interactive: true });
    assert.equal(parsed.command, "tui");
    assert.equal(parsed.yolo, true);
    assert.equal("yoloRejection" in parsed, false);
    assert.equal(parsed.autoMode, false);
  });

  it("bare --auto-mode + TTY -> tui holding full_auto", () => {
    const parsed = parseArgs({ argv: ["--auto-mode"], interactive: true });
    assert.equal(parsed.command, "tui");
    assert.equal(parsed.autoMode, true);
    assert.equal(parsed.yolo, undefined);
  });

  it("bare --yolo --auto-mode keeps both axes independently (ADR-0139)", () => {
    // yolo is the fence axis only: carrying it must not erase the permission
    // request, and vice versa.
    const parsed = parseArgs({
      argv: ["--yolo", "--auto-mode"],
      interactive: true,
    });
    assert.equal(parsed.command, "tui");
    assert.equal(parsed.yolo, true);
    assert.equal(parsed.autoMode, true);
    assert.equal("yoloRejection" in parsed, false);
  });

  it.each(["--yolo", "--auto-mode"])(
    "a posture launch is not implicit: a missing Bun must fail loudly for %s",
    (flag) => {
      const parsed = parseArgs({ argv: [flag], interactive: true });
      assert.equal(parsed.command, "tui");
      assert.equal(parsed.implicitTuiLaunch, false);
    }
  );
});

describe("parseArgs bare route: --json and --resume keep the chat route on a TTY", () => {
  it("bare --json + TTY -> chat with JSON on", () => {
    const parsed = parseArgs({ argv: ["--json"], interactive: true });
    assert.equal(parsed.command, "chat");
    assert.equal(parsed.json, true);
    assert.equal(parsed.implicitTuiLaunch, false);
    assert.equal("yoloRejection" in parsed, false);
  });

  it("bare --resume <id> + TTY -> chat anchored to that conversation", () => {
    const parsed = parseArgs({
      argv: ["--resume", "abc-123"],
      interactive: true,
    });
    assert.equal(parsed.command, "chat");
    assert.equal(parsed.resumeId, "abc-123");
    assert.equal(parsed.implicitTuiLaunch, false);
  });

  it("bare --json --yolo + TTY -> the chat route's own yolo refusal", () => {
    const parsed = parseArgs({
      argv: ["--json", "--yolo"],
      interactive: true,
    });
    assert.equal(parsed.command, "chat");
    assert.equal(parsed.yoloRejection?.kind, "yolo_non_tui_entry");
    assert.equal(parsed.yoloRejection?.command, "chat");
    assert.match(parsed.yoloRejection?.message ?? "", /^yolo_non_tui_entry: /);
  });

  it("bare --resume <id> --yolo + TTY -> the same refusal, not a dropped flag", () => {
    const parsed = parseArgs({
      argv: ["--resume", "abc-123", "--yolo"],
      interactive: true,
    });
    assert.equal(parsed.command, "chat");
    assert.equal(parsed.resumeId, "abc-123");
    assert.equal(parsed.yoloRejection?.kind, "yolo_non_tui_entry");
  });
});

describe("parseArgs bare route: a chat anchor plus a TUI-only posture conflicts", () => {
  it("bare --json --auto-mode + TTY -> typed tui_posture_conflict on chat", () => {
    const parsed = parseArgs({
      argv: ["--json", "--auto-mode"],
      interactive: true,
    });
    assert.equal(parsed.command, "chat");
    const refusal = parsed.tuiEntryRejection;
    assert.ok(
      refusal !== undefined,
      "--json with --auto-mode must refuse instead of dropping one request"
    );
    assert.equal(refusal.kind, "tui_posture_conflict");
    assert.equal(refusal.command, "chat");
    assert.equal(refusal.flag, "--auto-mode");
    assert.match(refusal.message, /^tui_posture_conflict: /);
    assert.ok(refusal.message.includes("--auto-mode"));
    assert.ok(refusal.message.includes("--json"));
    // Actionable: names the supported form of each request.
    assert.ok(refusal.message.includes("iknow tui --auto-mode"));
    assert.ok(refusal.message.includes("iknow chat --json"));
  });

  it("bare --resume <id> --auto-mode + TTY -> the refusal names the resume form", () => {
    const parsed = parseArgs({
      argv: ["--resume", "abc-123", "--auto-mode"],
      interactive: true,
    });
    assert.equal(parsed.command, "chat");
    assert.equal(parsed.resumeId, "abc-123");
    const refusal = parsed.tuiEntryRejection;
    assert.ok(refusal !== undefined);
    assert.equal(refusal.kind, "tui_posture_conflict");
    assert.equal(refusal.flag, "--auto-mode");
    assert.ok(refusal.message.includes("--resume"));
    // The actionable form names the conversation the operator asked to resume.
    assert.ok(refusal.message.includes("iknow chat --resume abc-123"));
  });

  it("the conflict refusal is a plain { kind, command, flag, message } union", () => {
    const refusal = parseArgs({
      argv: ["--json", "--auto-mode"],
      interactive: true,
    }).tuiEntryRejection;
    assert.ok(refusal !== undefined);
    assert.equal(refusal instanceof Error, false);
    assert.deepEqual(Object.keys(refusal).sort(), [
      "command",
      "flag",
      "kind",
      "message",
    ]);
  });

  it("one refusal wins for --json --yolo --auto-mode: --yolo outranks the posture conflict", () => {
    // Precedence is the parser's decision, applied once in `baseParsed`, so the
    // result carries a single refusal and the host's read order cannot change
    // which exception the operator sees.
    const parsed = parseArgs({
      argv: ["--json", "--yolo", "--auto-mode"],
      interactive: true,
    });
    assert.equal(parsed.command, "chat");
    assert.equal(parsed.yoloRejection?.kind, "yolo_non_tui_entry");
    assert.equal("tuiEntryRejection" in parsed, false);
  });

  it("an explicit chat head is untouched: chat --auto-mode stays chat", () => {
    // The conflict exists only where the route was inferred from flags; a head the
    // operator typed names the entry, so nothing about it contradicts a posture.
    const parsed = parseArgs({
      argv: ["chat", "--auto-mode"],
      interactive: true,
    });
    assert.equal(parsed.command, "chat");
    assert.equal(parsed.autoMode, true);
    assert.equal("tuiEntryRejection" in parsed, false);
  });

  it.each([
    "--json",
    "--auto-mode",
    "--json --auto-mode",
    "--yolo",
    "--json --yolo",
    "--resume s1 --auto-mode",
  ])(
    "bare %s without a TTY stays the display path (no refusal, nothing started)",
    (argv) => {
      const parsed = parseArgs({
        argv: argv.split(" "),
        interactive: false,
      });
      assert.equal(parsed.command, "help");
      assert.equal(parsed.versionOnly, false);
      assert.equal("tuiEntryRejection" in parsed, false);
      assert.equal("yoloRejection" in parsed, false);
    }
  );
});

describe("parseArgs bare route: display paths start nothing", () => {
  it("bare invocation without a TTY -> usage, no session request", () => {
    const parsed = parseArgs({ argv: [], interactive: false });
    assert.equal(parsed.command, "help");
    assert.equal(parsed.implicitTuiLaunch, false);
  });

  it("bare --eval-state + TTY -> usage, not a TUI or chat session", () => {
    // ADR-0130: a bare invocation carrying the fence-retiring posture must never
    // open a session on a TTY; displaying it is not an eval-state execution.
    const parsed = parseArgs({ argv: ["--eval-state"], interactive: true });
    assert.equal(parsed.command, "help");
    assert.equal(parsed.evalState, true);
    assert.equal("evalStateRejection" in parsed, false);
    assert.equal(parsed.implicitTuiLaunch, false);
  });

  it("bare --json --eval-state + TTY keeps the display path's precedence", () => {
    const parsed = parseArgs({
      argv: ["--json", "--eval-state"],
      interactive: true,
    });
    assert.equal(parsed.command, "help");
    assert.equal("evalStateRejection" in parsed, false);
  });

  it("a quoted posture spelling is one word of the operator's query", () => {
    const parsed = parseArgs({
      argv: ["grep --auto-mode in src"],
      interactive: true,
    });
    assert.equal(parsed.command, "oneshot");
    assert.equal(parsed.query, "grep --auto-mode in src");
    assert.equal(parsed.autoMode, false);
  });
});

describe("parseArgs implicitTuiLaunch: only the bare TTY launch is implicit", () => {
  it.each([
    { argv: ["tui"], interactive: true },
    { argv: ["tui", "--yolo"], interactive: true },
    { argv: ["tui", "--auto-mode"], interactive: true },
    { argv: ["chat"], interactive: true },
    { argv: ["ask", "hi"], interactive: true },
    { argv: ["hello world"], interactive: true },
    { argv: ["serve"], interactive: true },
    { argv: ["-h"], interactive: true },
    { argv: ["--version"], interactive: true },
    { argv: ["--subagent-worker"], interactive: true },
    { argv: [], interactive: false },
    { argv: ["--yolo"], interactive: false },
  ])("$argv -> false", ({ argv, interactive }) => {
    assert.equal(parseArgs({ argv, interactive }).implicitTuiLaunch, false);
  });

  it("the key is always present, so a host never has to guess a missing field", () => {
    for (const argv of [["chat"], ["tui"], ["ask", "hi"], ["-h"], []]) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(
          parseArgs({ argv, interactive: true }),
          "implicitTuiLaunch"
        ),
        true,
        `${JSON.stringify(argv)} must carry the launch origin explicitly`
      );
    }
  });
});
