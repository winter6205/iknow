/**
 * Registry (015 拥有) — Foundation 的工具注册表。
 *
 * 边界:
 *   - 构造期校验:重复名 / 坏 JSON Schema / validator 编译失败 -> 抛
 *     RegistryConstructionError(永不进入运行期);
 *   - 构造成功后 Registry 不可变(Object.freeze);每次 list() 返回冻结副本;
 *   - 按名定位返回 ToolDef / undefined;
 *   - 暴露已编译的 ajv ValidateFunction(getValidator 方法),Executor 复用
 *     同一份 validator,绝不重新编译 (015 同源 schema 强制);
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

export interface RegistryImpl {
  readonly list: () => ReadonlyArray<ToolDef>;
  readonly get: (name: string) => ToolDef | undefined;
  /** 返回构造期已编译的 ajv validator,未注册则 undefined(同源 schema 复用)。 */
  readonly getValidator: (name: string) => ValidateFunction | undefined;
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
  const seen = new Set<string>();
  const byName = new Map<string, ToolDef>();
  const validators = new Map<string, ValidateFunction>();

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
    const frozenDef = Object.freeze({ ...def }) as ToolDef;
    byName.set(def.name, frozenDef);
    validators.set(def.name, validate);
  }

  const list = Object.freeze(Array.from(byName.values())) as ReadonlyArray<ToolDef>;

  const registry: RegistryImpl = Object.freeze({
    list: () => list,
    get: (name: string) => byName.get(name),
    getValidator: (name: string) => validators.get(name),
  });
  return registry;
}