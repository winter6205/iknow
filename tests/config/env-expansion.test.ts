/**
 * `expandPlaceholders` 边界单测（settings-model-extension #164 第二阶段）。
 *
 * 纯函数测试：不接 LLM、不读真实 settings.json；只覆盖字面 / 占位符 /
 * fileMap 兜底 / 非法形态 / "yes" 过滤等分支。
 *
 * 与 settings.ts `isApiKeyOrPlaceholder` 守卫对齐：
 *   - `${}` / `${1VAR}` / `${VAR` 未闭合 → undefined（settings 也会丢弃这些）；
 *   - `${VAR}` / `$VAR` 形态由 expandPlaceholders 解析；
 *   - 字面密钥原样返回。
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { expandPlaceholders } from "../../src/config/env.ts";

/** helper：每个用例独立隔离，避免 process.env 污染影响其它用例。 */
function withCleanEnv<T>(fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("IKNOW_TEST_PLACEHOLDER_")) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe("expandPlaceholders — 字面值原样返回（无 `$`）", () => {
  it("无占位符字面 → trim 后原样", () => {
    assert.equal(expandPlaceholders("sk-abc-123", {}), "sk-abc-123");
  });

  it("带前后空白字面 → trim 后原样", () => {
    assert.equal(expandPlaceholders("  sk-abc  ", {}), "sk-abc");
  });

  it("无 `$` 但有特殊字符 → 字面原样", () => {
    assert.equal(expandPlaceholders("sk-x.y_z-1=2", {}), "sk-x.y_z-1=2");
  });

  it("undefined → undefined", () => {
    assert.equal(expandPlaceholders(undefined, {}), undefined);
  });

  it("空白 / 空串 → undefined", () => {
    assert.equal(expandPlaceholders("", {}), undefined);
    assert.equal(expandPlaceholders("   ", {}), undefined);
  });
});

describe("expandPlaceholders — `${VAR}` / `$VAR` 占位符解析", () => {
  it("${VAR} 从 process.env 展开", () => {
    withCleanEnv(() => {
      process.env.IKNOW_TEST_PLACEHOLDER_A = "value-from-env";
      assert.equal(
        expandPlaceholders("${IKNOW_TEST_PLACEHOLDER_A}", {}),
        "value-from-env"
      );
    });
  });

  it("$VAR 从 process.env 展开（裸形态）", () => {
    withCleanEnv(() => {
      process.env.IKNOW_TEST_PLACEHOLDER_B = "bare-value";
      assert.equal(
        expandPlaceholders("$IKNOW_TEST_PLACEHOLDER_B", {}),
        "bare-value"
      );
    });
  });

  it("process.env 缺失 → fileMap 兜底", () => {
    withCleanEnv(() => {
      assert.equal(
        expandPlaceholders("${IKNOW_TEST_PLACEHOLDER_C}", {
          IKNOW_TEST_PLACEHOLDER_C: "from-file",
        }),
        "from-file"
      );
    });
  });

  it("两者都缺 → undefined（消费点守卫触发）", () => {
    withCleanEnv(() => {
      assert.equal(
        expandPlaceholders("${IKNOW_TEST_PLACEHOLDER_MISSING}", {}),
        undefined
      );
    });
  });

  it("${VAR} 解析到空串 → undefined", () => {
    withCleanEnv(() => {
      process.env.IKNOW_TEST_PLACEHOLDER_D = "";
      assert.equal(
        expandPlaceholders("${IKNOW_TEST_PLACEHOLDER_D}", {}),
        undefined
      );
    });
  });

  it("$VAR 解析到空白 → undefined", () => {
    withCleanEnv(() => {
      process.env.IKNOW_TEST_PLACEHOLDER_E = "   ";
      assert.equal(
        expandPlaceholders("$IKNOW_TEST_PLACEHOLDER_E", {}),
        undefined
      );
    });
  });

  it("process.env 优先于 fileMap（env 有值时不读 file）", () => {
    withCleanEnv(() => {
      process.env.IKNOW_TEST_PLACEHOLDER_F = "env-wins";
      assert.equal(
        expandPlaceholders("${IKNOW_TEST_PLACEHOLDER_F}", {
          IKNOW_TEST_PLACEHOLDER_F: "file-loses",
        }),
        "env-wins"
      );
    });
  });
});

describe("expandPlaceholders — 非法形态丢弃（与 settings.ts 对齐）", () => {
  it("${} → undefined（非法占位符）", () => {
    assert.equal(expandPlaceholders("${}", {}), undefined);
  });

  it("${1VAR} → undefined（首字符不是合法标识符起点）", () => {
    assert.equal(expandPlaceholders("${1VAR}", {}), undefined);
  });

  it("${VAR 未闭合 → undefined", () => {
    assert.equal(expandPlaceholders("${VAR", {}), undefined);
  });

  it("${VAR} 含前后空白 → 仍合法（trim 后匹配完整占位符）", () => {
    withCleanEnv(() => {
      process.env.IKNOW_TEST_PLACEHOLDER_G = "ok";
      assert.equal(
        expandPlaceholders("  ${IKNOW_TEST_PLACEHOLDER_G}  ", {}),
        "ok"
      );
    });
  });

  it("${VAR1} 数字后缀合法（标识符含数字合法）", () => {
    withCleanEnv(() => {
      process.env.IKNOW_TEST_PLACEHOLDER_V1 = "v1ok";
      assert.equal(
        expandPlaceholders("${IKNOW_TEST_PLACEHOLDER_V1}", {}),
        "v1ok"
      );
    });
  });

  it("${VAR} 中 VAR 是关键字（如 'yes'） → undefined（dotenv 风格占位符）", () => {
    withCleanEnv(() => {
      process.env.YES = "yes";
      // 整串 "${YES}" 不命中 API_KEY_PLACEHOLDERS（占位符列表只匹配 yes 字面），
      // 但 trim 后值 lowercase === "yes" → 视同未设。
      assert.equal(expandPlaceholders("${YES}", {}), undefined);
    });
  });
});

describe("expandPlaceholders — 多段占位符混排", () => {
  it("${A}${B} 混排全展开", () => {
    withCleanEnv(() => {
      process.env.IKNOW_TEST_PLACEHOLDER_H = "hello";
      process.env.IKNOW_TEST_PLACEHOLDER_I = "world";
      assert.equal(
        expandPlaceholders(
          "${IKNOW_TEST_PLACEHOLDER_H}-${IKNOW_TEST_PLACEHOLDER_I}",
          {}
        ),
        "hello-world"
      );
    });
  });

  it("${A} 与 $B 混排 → 都展开", () => {
    withCleanEnv(() => {
      process.env.IKNOW_TEST_PLACEHOLDER_J = "J-v";
      process.env.IKNOW_TEST_PLACEHOLDER_K = "K-v";
      assert.equal(
        expandPlaceholders(
          "[${IKNOW_TEST_PLACEHOLDER_J}][$IKNOW_TEST_PLACEHOLDER_K]",
          {}
        ),
        "[J-v][K-v]"
      );
    });
  });

  it("任一段缺失 → 整串 undefined", () => {
    withCleanEnv(() => {
      process.env.IKNOW_TEST_PLACEHOLDER_L = "L-v";
      assert.equal(
        expandPlaceholders(
          "${IKNOW_TEST_PLACEHOLDER_L}-${IKNOW_TEST_PLACEHOLDER_MISSING_X}",
          {}
        ),
        undefined
      );
    });
  });
});

describe("expandPlaceholders — prototype 注入 (M2)", () => {
  it("${constructor} → undefined（不命中 Object.prototype，不抛 TypeError）", () => {
    assert.equal(expandPlaceholders("${constructor}", {}), undefined);
  });

  it("${__proto__} → undefined", () => {
    assert.equal(expandPlaceholders("${__proto__}", {}), undefined);
  });

  it("${toString} → undefined", () => {
    assert.equal(expandPlaceholders("${toString}", {}), undefined);
  });

  it("${constructor} + fileMap 有同名键 → 仍 undefined（fileMap 同样 hasOwn 守卫）", () => {
    assert.equal(
      expandPlaceholders("${constructor}", { constructor: "value" }),
      undefined
    );
  });

  it("${constructor} + process.env 无该键 → 不抛 TypeError（消费点守卫触发）", () => {
    assert.doesNotThrow(() => expandPlaceholders("${constructor}", {}));
  });
});

describe('expandPlaceholders — "yes" 占位符过滤', () => {
  it('字面 "yes" → undefined（大小写不敏感）', () => {
    assert.equal(expandPlaceholders("yes", {}), undefined);
    assert.equal(expandPlaceholders("YES", {}), undefined);
    assert.equal(expandPlaceholders("Yes", {}), undefined);
  });

  it('解析到 env 值 = "yes" → undefined', () => {
    withCleanEnv(() => {
      process.env.IKNOW_TEST_PLACEHOLDER_Y = "yes";
      assert.equal(
        expandPlaceholders("${IKNOW_TEST_PLACEHOLDER_Y}", {}),
        undefined
      );
    });
  });

  it('解析到 env 值 = "YES"（大写）→ undefined', () => {
    withCleanEnv(() => {
      process.env.IKNOW_TEST_PLACEHOLDER_Y = "YES";
      assert.equal(
        expandPlaceholders("${IKNOW_TEST_PLACEHOLDER_Y}", {}),
        undefined
      );
    });
  });

  it('解析到 fileMap 值 = "yes" → undefined', () => {
    assert.equal(
      expandPlaceholders("${IKNOW_TEST_PLACEHOLDER_FM}", {
        IKNOW_TEST_PLACEHOLDER_FM: "yes",
      }),
      undefined
    );
  });
});
