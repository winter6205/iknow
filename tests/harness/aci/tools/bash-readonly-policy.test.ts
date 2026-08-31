import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  ReadonlyViolationError,
  validateReadonlyCommand,
} from "../../../../src/harness/aci/tools/bash-readonly.ts";

describe("validateReadonlyCommand — find file-output flags", () => {
  it("rejects find output flags that write or append to a file", () => {
    for (const command of [
      "find . -fprint package.json",
      "find . -fprint0 package.json",
      "find . -fprintf package.json %p",
      "find . -fls package.json",
    ]) {
      assert.throws(
        () => validateReadonlyCommand(command),
        (error: unknown) =>
          error instanceof ReadonlyViolationError &&
          error.message.includes("find flag"),
        `expected readonly rejection for ${command}`
      );
    }
  });
});

describe("validateReadonlyCommand — other file-writing routes", () => {
  it("rejects common writers and writer-producing shell compositions", () => {
    for (const command of [
      "tee output.txt",
      "dd of=output.txt",
      "sed -i s/old/new/ input.txt",
      "awk '{ print $0 }' input.txt",
      "xargs touch",
    ]) {
      assert.throws(
        () => validateReadonlyCommand(command),
        (error: unknown) => error instanceof ReadonlyViolationError,
        `expected readonly rejection for ${command}`
      );
    }
  });

  it("rejects sort temporary-directory and compressor execution flags", () => {
    for (const command of [
      "sort -o output.txt input.txt",
      "sort --output output.txt input.txt",
      "sort --output=output.txt input.txt",
      "sort -T . input.txt",
      "sort -T. input.txt",
      "sort --temporary-directory . input.txt",
      "sort --temporary-directory=. input.txt",
      "sort --compress-program touch input.txt",
      "sort --compress-program=touch input.txt",
    ]) {
      assert.throws(
        () => validateReadonlyCommand(command),
        (error: unknown) =>
          error instanceof ReadonlyViolationError &&
          error.message.includes("sort flag"),
        `expected readonly rejection for ${command}`
      );
    }
  });

  it("rejects git subcommands and actions that mutate repository state", () => {
    for (const command of [
      "git remote add origin https://example.invalid/repo.git",
      "git remote set-url origin https://example.invalid/repo.git",
      "git reflog expire --all",
      "git reflog delete HEAD@{0}",
      "git reflog write HEAD 0000000000000000000000000000000000000000 0000000000000000000000000000000000000000 message",
      "git fsck --lost-found",
    ]) {
      assert.throws(
        () => validateReadonlyCommand(command),
        (error: unknown) => error instanceof ReadonlyViolationError,
        `expected readonly rejection for ${command}`
      );
    }
  });

  it("allows git read-only variants guarded by the mutation checks", () => {
    for (const command of [
      "git remote",
      "git remote -v",
      "git remote show origin",
      "git remote get-url origin",
      "git reflog",
      "git reflog show HEAD",
      "git fsck",
    ]) {
      assert.doesNotThrow(
        () => validateReadonlyCommand(command),
        `expected readonly git command to remain allowed: ${command}`
      );
    }
  });
});
