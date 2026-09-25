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
  setBindingLoaderForTest,
} from "../../../src/harness/permission/shell-parse.js";
import type {
  ParseBindingLoader,
  ParseFoundationState,
  SecurityParseResult,
} from "../../../src/harness/permission/shell-parse.js";

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
});
