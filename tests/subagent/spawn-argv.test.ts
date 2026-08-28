import { describe, expect, it } from "vitest";

import {
  resolveSubagentWorkerSpawnArgs,
  SubagentWorkerSpawnArgsError,
} from "../../src/harness/subagent/spawn.ts";

describe("resolveSubagentWorkerSpawnArgs", () => {
  it("adds the tsx loader for a TypeScript entry under Node", () => {
    expect(
      resolveSubagentWorkerSpawnArgs({
        execPath: "/usr/bin/node",
        argv1: "/workspace/src/cli.ts",
      })
    ).toEqual([
      "--import",
      "tsx",
      "/workspace/src/cli.ts",
      "--subagent-worker",
    ]);
  });

  it.each(["cli.mts", "cli.tsx", "cli.cts"])(
    "recognizes .%s as a TypeScript entry",
    (entry) => {
      expect(
        resolveSubagentWorkerSpawnArgs({
          execPath: "node",
          argv1: `/workspace/src/${entry}`,
        })
      ).toEqual([
        "--import",
        "tsx",
        `/workspace/src/${entry}`,
        "--subagent-worker",
      ]);
    }
  );

  it("keeps a TypeScript entry unchanged under Bun", () => {
    expect(
      resolveSubagentWorkerSpawnArgs({
        execPath: "/usr/local/bin/bun",
        argv1: "/workspace/src/cli.ts",
      })
    ).toEqual(["/workspace/src/cli.ts", "--subagent-worker"]);
  });

  it.each(["cli.js", "cli.mjs", "cli.cjs"])(
    "keeps a product entry unchanged for .%s",
    (entry) => {
      expect(
        resolveSubagentWorkerSpawnArgs({
          execPath: "/usr/bin/node",
          argv1: `/workspace/dist/${entry}`,
        })
      ).toEqual([`/workspace/dist/${entry}`, "--subagent-worker"]);
    }
  );

  it.each([undefined, ""])("rejects a missing argv1 (%s)", (argv1) => {
    expect(() =>
      resolveSubagentWorkerSpawnArgs({
        execPath: "/usr/bin/node",
        argv1,
      })
    ).toThrow(SubagentWorkerSpawnArgsError);
  });
});
