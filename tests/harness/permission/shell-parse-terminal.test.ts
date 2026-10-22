/**
 * Terminal-state pins for `shell-parse.ts`: the `parser-unavailable` arm and
 * every case that installs a throwing loader. A load failure is
 * process-terminal with no retry, so such a case would destroy the READY
 * verdicts in any test file it shares — which is what forces this separate
 * file, run in its own process.
 */

import { describe, it, expect, afterEach } from "vitest";

import {
  cacheEntryCountForTest,
  parseForSecurity,
  parseFoundationState,
  parserConstructionCountForTest,
  scanWithLegacyDegrade,
  setBindingLoaderForTest,
} from "../../../src/harness/permission/shell-parse.js";
import type {
  ParseBindingLoader,
  ParseFoundationState,
  SecurityParseResult,
  SecurityParseVetoed,
} from "../../../src/harness/permission/shell-parse.js";

/** Named so the escape spellings below read as shapes rather than byte soup. */
const LF = String.fromCharCode(0x0a);

/**
 * #1188 admitted a set of ordinary escaped-space and line-continuation
 * spellings, but the admission is gated on an available parse foundation. On a
 * machine whose binding never loaded there is nothing to settle the sites
 * against, so these rows must keep the hard denial at the PARSE arm — including
 * the harmless ones, which are exactly the rows the gate exists for. The same
 * file is the right home because it is the one guaranteed to run in a fresh
 * process: the terminal state is unrecoverable, so the case has to observe the
 * first UNINITIALIZED-to-UNAVAILABLE call and the terminal call after it.
 */
const ADMITTED_WHEN_READY: readonly { readonly command: string; readonly note: string }[] =
  [
    {
      command: "ls -lt --time-style=+%m-%d\\ %H:%M docs/evidence",
      note: "harmless incident spelling 1",
    },
    {
      command: `gh issue view 1188 --json number,title \\${LF} -q '.title'`,
      note: "harmless incident spelling 2",
    },
    { command: "echo a\\ b", note: "harmless escaped space" },
    { command: `a \\${LF} b`, note: "harmless continuation" },
  ];

function expectBackslashVeto(
  result: SecurityParseResult,
  label: string
): SecurityParseVetoed {
  expect(result.kind, label).toBe("vetoed");
  if (result.kind !== "vetoed") {
    throw new Error(`expected vetoed, got ${result.kind}`);
  }
  expect(result.class, label).toBe("backslash-whitespace");
  return result;
}

afterEach(() => {
  setBindingLoaderForTest(null);
});

describe("a load that never succeeded is terminal", () => {
  it("answers parser-unavailable, enters no parser, and never retries the load", () => {
    expect(parseFoundationState()).toEqual<ParseFoundationState>(
      "UNINITIALIZED"
    );
    let loadAttempts = 0;
    const failingLoader: ParseBindingLoader = () => {
      loadAttempts += 1;
      throw new Error("no prebuild for this host");
    };
    setBindingLoaderForTest(failingLoader);

    const before = parserConstructionCountForTest();
    const first: SecurityParseResult = parseForSecurity("echo terminal-probe");
    expect(parserConstructionCountForTest() - before).toBe(0);
    expect(first.kind).toBe("parser-unavailable");
    expect(parseFoundationState()).toEqual<ParseFoundationState>("UNAVAILABLE");
    expect(loadAttempts).toBe(1);

    const second = parseForSecurity("echo terminal-probe");
    expect(second.kind).toBe("parser-unavailable");
    expect(loadAttempts).toBe(1);

    // The arm reports process state, never a per-string fact: nothing is
    // stored, so repeated calls cannot grow the cache.
    const entriesBefore = cacheEntryCountForTest();
    parseForSecurity("echo terminal-probe");
    parseForSecurity("echo terminal-probe");
    expect(cacheEntryCountForTest()).toBe(entriesBefore);
  });

  it("stays terminal after the seam is restored to the production path", () => {
    setBindingLoaderForTest(null);
    const result = parseForSecurity("echo post-terminal");
    expect(result.kind).toBe("parser-unavailable");
    expect(parseFoundationState()).toEqual<ParseFoundationState>("UNAVAILABLE");
  });

  it("keeps the #1188 exemption gate closed: the admitted spellings stay vetoed, on the terminal call too", () => {
    // The previous case already drove UNINITIALIZED -> UNAVAILABLE, so this is
    // the terminal-state call the criterion names, and it runs in the same
    // fresh process as the first one.
    expect(parseFoundationState()).toEqual<ParseFoundationState>("UNAVAILABLE");
    for (const row of ADMITTED_WHEN_READY) {
      const first = expectBackslashVeto(
        parseForSecurity(row.command),
        `${row.note} (terminal)`
      );
      const second = expectBackslashVeto(
        parseForSecurity(row.command),
        `${row.note} (terminal repeat)`
      );
      // The reason is the class-bearing one, not the parser-unavailable arm,
      // so the gate is a refusal and not a silent fallthrough.
      expect(second.reason).toBe(first.reason);
      expect(first.reason).toContain("backslash-whitespace");
    }
  });

  it("hands the degrade seam the `parsed` arm carrying the veto, so the legacy scan is not what denies them", () => {
    for (const row of ADMITTED_WHEN_READY) {
      const outcome = scanWithLegacyDegrade(row.command, () => null);
      expect(outcome.kind, row.note).toBe("parsed");
      expect(outcome.degraded, row.note).toBe(false);
      if (outcome.kind !== "parsed") {
        throw new Error(`expected parsed, got ${outcome.kind}`);
      }
      expectBackslashVeto(outcome.result, `${row.note} (seam)`);
    }
  });

  it("keeps the legacy route available for a command outside the exemption surface", () => {
    const command = "echo iknow-1188-ordinary";
    expect(parseForSecurity(command).kind).toBe("parser-unavailable");

    const clean = scanWithLegacyDegrade(command, () => null);
    expect(clean.kind).toBe("legacy-clean");
    expect(clean.degraded).toBe(true);

    const hit = scanWithLegacyDegrade("rm -rf /", () => ({
      id: "destructive-rm",
      pattern: "rm -rf",
    }));
    expect(hit.kind).toBe("legacy-hit");
  });

  it("memoizes nothing across the gated rows, terminal or not", () => {
    const before = cacheEntryCountForTest();
    for (const row of ADMITTED_WHEN_READY) {
      parseForSecurity(row.command);
      parseForSecurity(row.command);
    }
    expect(cacheEntryCountForTest()).toBe(before);
    expect(parserConstructionCountForTest()).toBe(0);
  });
});
