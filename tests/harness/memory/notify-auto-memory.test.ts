import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";

import { notifyAutoMemory } from "../../../src/harness/memory/index.ts";

const turn = {
  stopReason: "completed",
  transcript: "user: hello\n\nassistant: hi",
};

describe("notifyAutoMemory", () => {
  it("is a no-op when the host has no hook", () => {
    let reported = false;

    assert.doesNotThrow(() => {
      notifyAutoMemory({
        ...turn,
        onError: () => {
          reported = true;
        },
      });
    });

    assert.equal(reported, false);
  });

  it("swallows hook failures and reports them without failing the caller", () => {
    const failure = new Error("hook exploded");
    let reported: unknown;

    assert.doesNotThrow(() => {
      notifyAutoMemory({
        ...turn,
        hook: {
          onTurnComplete: () => {
            throw failure;
          },
          drain: async () => {},
        },
        onError: (error) => {
          reported = error;
        },
      });
    });

    assert.equal(reported, failure);
  });

  it("forwards memorySaveSucceeded onto the hook turn", () => {
    let seen: boolean | undefined;
    notifyAutoMemory({
      ...turn,
      memorySaveSucceeded: true,
      hook: {
        onTurnComplete: (t) => {
          seen = t.memorySaveSucceeded;
        },
        drain: async () => {},
      },
      onError: () => {},
    });
    assert.equal(seen, true);
  });

  it("is imported and called by chat-session and SessionHub", () => {
    const chatSource = readFileSync(
      join(process.cwd(), "src/cli/chat-session.ts"),
      "utf8"
    );
    const hubSource = readFileSync(
      join(process.cwd(), "src/session-api/hub.ts"),
      "utf8"
    );
    const importPattern =
      /import\s*\{[^}]*\bnotifyAutoMemory\b[^}]*\}\s*from\s*["']\.\.\/harness\/memory\/index\.js["']/s;

    assert.match(chatSource, importPattern);
    assert.match(hubSource, importPattern);
    assert.match(chatSource, /\bnotifyAutoMemory\(\{/);
    assert.match(hubSource, /\bnotifyAutoMemory\(\{/);
    assert.match(chatSource, /\bhasSuccessfulMemorySave\b/);
    assert.match(hubSource, /\bhasSuccessfulMemorySave\b/);
    assert.match(chatSource, /\bmemorySaveSucceeded:/);
    assert.match(hubSource, /\bmemorySaveSucceeded:/);
  });
});
