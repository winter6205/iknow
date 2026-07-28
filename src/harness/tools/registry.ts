/**
 * Registry (015 拥有) — Foundation 的工具注册表。
 *
 * 边界:
 *   - 构造期校验:重复名 / 坏 JSON Schema / validator 编译失败 -> 抛
 *     RegistryConstructionError(永不进入运行期);
 *   - 构造成功后 Registry 不可变(Object.freeze);每次 list() 返回冻结副本;
 *   - 按名定位返回 ToolDef / undefined;
 *   - Registry 不知道 Loop,不执行工具,不向 Model Adapter 暴露原生细节。
 *
 * ajv 配置:strict: true + ajv-formats,不做隐式类型转换、不裁剪未知字段、
 * 不猜测缺失值(015 强制);同源 schema 同时给模型和 Executor 使用。
 */

import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { ValidateFunction } from "ajv";
import { RegistryConstructionError } from "../errors.js";
import type { ToolDef } from "./types.js";

interface CompiledToolDef {
  readonly def: ToolDef;
  readonly validate: ValidateFunction;
}

export interface RegistryImpl {
  readonly list: () => ReadonlyArray<ToolDef>;
  readonly get: (name: string) => ToolDef | undefined;
}

function makeAjv(): Ajv.default {
  const ajv = new Ajv.default({ strict: true, allErrors: true });
  addFormats.default(ajv);
  return ajv;
}

/**
 * 构造 Registry。失败模式:
 *   - 重复工具名 → RegistryConstructionError("duplicate tool name: <n>")
 *   - 缺少 name / 非字符串 name → RegistryConstructionError("tool entry missing name")
 *   - JSON Schema 非法 → RegistryConstructionError("invalid schema for tool <n>: <msg>")
 *   - ajv 编译失败 → RegistryConstructionError("validator compile failed for <n>: <msg>")
 */
export function createRegistry(tools: ReadonlyArray<ToolDef>): RegistryImpl {
  const ajv = makeAjv();
  const compiled: CompiledToolDef[] = [];
  const seen = new Set<string>();

  for (const def of tools) {
    if (typeof def?.name !== "string" || def.name.length === 0) {
      throw new RegistryConstructionError("tool entry missing or empty name");
    }
    if (seen.has(def.name)) {
      throw new RegistryConstructionError(`duplicate tool name: ${def.name}`);
    }
    seen.add(def.name);
    if (!def.inputSchema || typeof def.inputSchema !== "object") {
      throw new RegistryConstructionError(
        `tool ${def.name}: inputSchema must be an object`,
      );
    }
    let validate: ValidateFunction;
    try {
      validate = ajv.compile(def.inputSchema);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new RegistryConstructionError(
        `validator compile failed for ${def.name}: ${msg}`,
      );
    }
    compiled.push({ def, validate });
  }

  const list = Object.freeze(
    compiled.map((c) => Object.freeze({ ...c.def })),
  ) as ReadonlyArray<ToolDef>;
  const byName = new Map<string, ToolDef>(
    list.map((t) => [t.name, t] as const),
  );

  const registry: RegistryImpl = Object.freeze({
    list: () => list,
    get: (name: string) => byName.get(name),
  });
  return registry;
}

/**
 * 内部使用:Executor 取走已编译的 validator,与 Tool/Adapter 同源 schema 严格校验。
 * 015 强制:工具 input_schema 与 Executor 校验用同一份权威 JSON Schema。
 */
export function getValidator(
  registry: RegistryImpl,
  name: string,
): ValidateFunction | undefined {
  const def = registry.get(name);
  if (!def) return undefined;
  // Recompile using same ajv instance to keep validator in sync.
  const ajv = makeAjv();
  return ajv.compile(def.inputSchema);
}