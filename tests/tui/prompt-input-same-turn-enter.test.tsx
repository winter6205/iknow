/** @jsxImportSource @opentui/react */
/**
 * Same-turn Enter submits the live composer buffer.
 *
 * Keystrokes write the native textarea immediately and only then queue
 * React state. Enter that arrives in that same turn — a pasted line ending
 * in CR, or characters and Return in one stdin read — used to submit
 * `props.value`, which was still the previous commit (often ""). The
 * submit then asked to clear a buffer the echo guard refused to touch, so
 * the line stayed on screen and nothing was sent.
 */
import { expect, test } from "bun:test";
import { useState } from "react";
import { testRender } from "@opentui/react/test-utils";
import { PromptInput } from "../../src/tui/prompt-input.js";
import { composerText } from "./_fixtures.js";

test("同一轮键入后立刻 Enter：提交实时缓冲，然后清空输入框", async () => {
  const submitted: string[] = [];
  function Harness() {
    const [value, setValue] = useState("");
    return (
      <PromptInput
        value={value}
        cols={80}
        active
        onChange={setValue}
        onSubmit={(text) => {
          submitted.push(text);
          setValue("");
        }}
      />
    );
  }
  const setup = await testRender(<Harness />, {
    width: 80,
    height: 12,
    exitOnCtrlC: false,
    consoleMode: "disabled",
  });
  try {
    await setup.waitForVisualIdle();
    for (const ch of "你好hi") setup.mockInput.pressKey(ch);
    setup.mockInput.pressEnter();
    expect(submitted).toEqual(["你好hi"]);
    await setup.waitForVisualIdle();
    expect(composerText(setup)).toBe("");
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy();
  }
});
