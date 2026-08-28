import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  resolveSubagentWorkerSpawnArgs,
  SubagentWorkerSpawnArgsError,
} from "../../src/harness/subagent/spawn.ts";

const spawnDir = dirname(
  fileURLToPath(new URL("../../src/harness/subagent/spawn.ts", import.meta.url))
);
const tsxLoader = createRequire(join(spawnDir, "spawn.ts")).resolve("tsx");

describe("resolveSubagentWorkerSpawnArgs", () => {
  it("adds the module-relative tsx loader for a TypeScript entry under Node", () => {
    expect(
      resolveSubagentWorkerSpawnArgs({
        execPath: "/usr/bin/node",
        argv1: "/workspace/src/cli.ts",
      })
    ).toEqual([
      "--import",
      tsxLoader,
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
        tsxLoader,
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

  it("pins dist/cli.js argv byte-for-byte", () => {
    expect(
      resolveSubagentWorkerSpawnArgs({
        execPath: "/usr/bin/node",
        argv1: "/workspace/dist/cli.js",
      })
    ).toEqual(["/workspace/dist/cli.js", "--subagent-worker"]);
  });

  it.each([undefined, ""])("rejects a missing argv1 (%s)", (argv1) => {
    expect(() =>
      resolveSubagentWorkerSpawnArgs({
        execPath: "/usr/bin/node",
        argv1,
      })
    ).toThrow(SubagentWorkerSpawnArgsError);
  });

  it("throws a typed error when the tsx loader cannot be resolved", () => {
    expect(() =>
      resolveSubagentWorkerSpawnArgs({
        execPath: "/usr/bin/node",
        argv1: "/workspace/src/cli.ts",
        resolveTsxLoader: () => {
          throw new Error("Cannot find package 'tsx'");
        },
      })
    ).toThrow(SubagentWorkerSpawnArgsError);
  });
});
