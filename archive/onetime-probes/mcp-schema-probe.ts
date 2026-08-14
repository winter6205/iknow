/**
 * D1 [decision] probe — ajv strict × MCP inputSchema 兼容性探针。
 *
 * 目标：用仓库同款 ajv 配置（`strict: true` + ajv-formats，与
 * `src/harness/tools/registry.ts:30-34` makeAjv() 完全一致）编译三组 MCP
 * 形态 inputSchema（plain / `$ref` / `anyOf`），输出每组 pass/fail。
 *
 * 结论写回 plan 的 D1 裁决区：
 *   - 三组全 pass → T7 直连（MCP 注册路径无需 schema 归一化）
 *   - 任一组 fail  → T7 前置 schema 归一化子步骤（只作用于 MCP 注册路径，
 *                    不改全局 ajv 配置，spec Boundaries Ask first）
 *
 * 一次性探针，不入 npm scripts。运行：`node --experimental-strip-types scripts/mcp-schema-probe.ts`
 */
import Ajv from "ajv";
import addFormats from "ajv-formats";

function makeAjv(): Ajv.default {
  const ajv = new Ajv.default({ strict: true, allErrors: true });
  addFormats.default(ajv);
  return ajv;
}

/** MCP inputSchema 样本：取自真实 MCP server 工具 schema 形态。 */
const SCHEMA_GROUPS: Record<string, unknown[]> = {
  /**
   * plain：扁平 object schema，只有 properties / required / additionalProperties，
   * 无 $ref / 组合关键字。绝大多数 MCP 工具落此形态。
   */
  plain: [
    {
      type: "object",
      properties: {
        query: { type: "string", description: "case-insensitive substring" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        file: { type: "string", description: "path to read" },
        offset: { type: "integer" },
        limit: { type: "integer" },
      },
      additionalProperties: false,
    },
  ],
  /**
   * $ref：schema 内含 $defs（或 definitions）与 $ref 引用（JSON Schema
   * draft-07 及之后的标准形态）。MCP 规范允许，但 strict:true 的 ajv 对
   * 未定义 ref / 悬空引用会拒绝。
   */
  $ref: [
    {
      $defs: {
        namedRef: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
      type: "object",
      properties: {
        target: { $ref: "#/$defs/namedRef" },
        depth: { type: "integer", default: 2 },
      },
      required: ["target"],
      additionalProperties: false,
    },
    {
      definitions: {
        filePath: { type: "string", minLength: 1 },
      },
      type: "object",
      properties: {
        path: { $ref: "#/definitions/filePath" },
      },
      required: ["path"],
    },
  ],
  /**
   * anyOf / oneOf 组合关键字：MCP server 常用「多形态入参」——例如
   * `query` 或 `names` 二选一，或输入可为 string 也可为 object。
   */
  anyOf: [
    {
      anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
      description: "query: keyword or list of names",
    },
    {
      type: "object",
      oneOf: [
        {
          properties: {
            query: { type: "string" },
            additionalProperties: false,
          },
          required: ["query"],
        },
        {
          properties: { names: { type: "array" }, additionalProperties: false },
          required: ["names"],
        },
      ],
    },
  ],
};

let allPass = true;
for (const [group, schemas] of Object.entries(SCHEMA_GROUPS)) {
  let passCount = 0;
  const failures: string[] = [];
  for (const schema of schemas) {
    try {
      const ajv = makeAjv();
      ajv.compile(schema);
      passCount++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(msg.split("\n")[0]);
    }
  }
  const groupPass = passCount === schemas.length;
  if (!groupPass) allPass = false;
  console.log(
    `[${group}] ${passCount}/${schemas.length} compiled` +
      (failures.length ? ` — FAIL: ${failures.join(" | ")}` : " — PASS")
  );
}

console.log(
  allPass
    ? "\nD1 verdict: ALL PASS → T7 直连，MCP 注册路径无需 schema 归一化"
    : "\nD1 verdict: FAIL → T7 前置 schema 归一化子步骤（仅 MCP 注册路径）"
);
process.exit(allPass ? 0 : 1);
