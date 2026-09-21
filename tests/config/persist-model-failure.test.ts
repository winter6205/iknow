/**
 * persistModelFailure: the /model write-to-disk stage and the reload stage must be distinguished.
 *
 * When the write already succeeded but reload throws the typed plain object
 * provider_api_key_missing, the failure must not be labeled "write" anymore
 * (otherwise the TUI falsely reports "failed to write settings.json").
 */
import { describe, expect, it } from "vitest";
import {
  persistModelFailNotice,
  persistModelFailure,
} from "../../src/tui/persist-model-failure.js";

describe("persistModelFailure", () => {
  it("wrote=false → stage write，reason 为 Error.message", () => {
    const res = persistModelFailure(false, new Error("EACCES: 只读文件系统"));
    expect(res).toEqual({
      ok: false,
      stage: "write",
      reason: "EACCES: 只读文件系统",
    });
  });

  it("wrote=true + provider_api_key_missing → stage reload，reason 走 typed 文案", () => {
    const res = persistModelFailure(true, {
      kind: "provider_api_key_missing",
      providerId: "volcengine-ark",
      apiKeyEnv: "VOLCENGINE_ARK_API_KEY",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.stage).toBe("reload");
    expect(res.reason).toBe(
      "provider_api_key_missing: volcengine-ark (env VOLCENGINE_ARK_API_KEY unset)"
    );
    expect(res.reason.includes("[object Object]")).toBe(false);
  });

  it("reload notice is English and does not claim a write failure", () => {
    expect(
      persistModelFailNotice(
        "reload",
        "provider_api_key_missing: volcengine-ark (env VOLCENGINE_ARK_API_KEY unset)"
      )
    ).toBe(
      "Model switched (this session), but failed to reload runtime: provider_api_key_missing: volcengine-ark (env VOLCENGINE_ARK_API_KEY unset)"
    );
    expect(persistModelFailNotice("write", "EACCES")).toBe(
      "Model switched (this session), but failed to write settings.json: EACCES"
    );
  });
});
