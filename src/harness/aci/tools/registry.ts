/**
 * ACI 工具集注册层 — 8 件 SSOT。
 *
 * **目的**:让所有 harness 入口(CLI `ask` / `chat` / `serve`、TUI `iknow tui`)
 * 共享同一份"工具有哪些 + 怎么注入 env"的装配函数,避免工具集分裂
 * (历史教训:`src/tui/deps.ts` 手写 6 个文件工具漏注册 web_fetch/web_search)。
 *
 * **对齐 upstream**:upstream-openharness 用 `ToolRegistry` 类 +
 * `create_default_tool_registry()` 工厂(`src/openharness/tools/__init__.py:48`),
 * `build_runtime()`(`ui/runtime.py:324`)唯一装配点;UI 层从 `RuntimeBundle.tool_registry`
 * 读,不自己注册。本模块同构实现,但更薄 — 仅做"哪些工具 + env 透传",
 * 不替代 `createAciRegistry`(后者还管协议 registry + 延迟加载 catalog)。
 *
 * **append-only**:不重排既有 6 工具顺序(policy byName 键空间与 ADR-0006 稳定);
 * Web 类工具(bash / read_file / grep / glob / edit_file / write_file 之后)
 * 沿用 build-engine.ts 历史顺序。
 */
import type { IknowEnv } from "../../../config/env.js";
import { createAciRegistry, type AciRegistry } from "../aci-registry.js";
import { createBashTool } from "./bash.js";
import { createReadFileTool } from "./read-file.js";
import { createGrepTool } from "./grep.js";
import { createGlobTool } from "./glob.js";
import { createEditFileTool } from "./edit-file.js";
import { createWriteFileTool } from "./write-file.js";
import { createWebFetchTool } from "./web-fetch.js";
import { createWebSearchTool } from "./web-search.js";

/**
 * 8 件生产工具的命名常量 — SSOT。
 *
 * 这是给 LLM agent 调的 8 个生产工具(bash / read_file / grep / glob /
 * edit_file / write_file / web_fetch / web_search)的命名真值,不是测试
 * fixture。导出它让两个层分工:
 *   - 装配层:`createDefaultAciRegistry()` 实际把 8 个工具工厂拼起来,
 *     返回 AciRegistry;生产入口(build-engine / TUI)只跟工厂交互
 *   - 命名层:本常量承载「这 8 个名字是 iknow 工具集」的声明真值,
 *     被测试断言消费(`registry.test.ts` 用它锁工具集不变),也给未来
 *     诊断 / tool_search 类 hook 按名查工具用
 *
 * 即「测试断言消费」不等于「测试工具」— 它是工具集的命名权威,
 * 测试只是这条权威的消费者之一。
 */
export const ACI_TOOLSET_NAMES = Object.freeze([
  "bash",
  "read_file",
  "grep",
  "glob",
  "edit_file",
  "write_file",
  "web_fetch",
  "web_search",
] as const);

/**
 * 工厂入参:仅消费 env.web 字段(端点覆写 + 出站代理)与沙箱根。
 * 不接收完整 IknowEnv — 避免误传 LLM key 等敏感字段越界。
 */
export interface CreateDefaultAciRegistryOptions {
  readonly env: Pick<IknowEnv, "web">;
  /** 软沙箱根(传入 process.cwd() 或调用方显式路径;fs 工具据此越界拒绝)。 */
  readonly sandboxRoot: string;
}

/**
 * 默认 8 件工具注册工厂 — SSOT。
 *
 * **装配期 fail-fast**:
 *   - proxyUrl 非法(非 http/https / 含凭据)→ `createWebFetchTool` /
 *     `createWebSearchTool` 工厂内 `createDefaultGuardDeps` 同步抛
 *     ToolExecutionError,与 build-engine.ts 既有行为一致
 *     (tests/build-engine.test.ts:94 已锁)。
 *
 * **返回值**:`AciRegistry`(含 `inner` 协议层 + `catalog` 权限/延迟加载层),
 * 调用方可直接交给 `createExecutor` 与 `createAciExecutor`。
 */
export function createDefaultAciRegistry(
  opts: CreateDefaultAciRegistryOptions
): AciRegistry {
  const { env, sandboxRoot } = opts;
  const proxyUrl = env.web.proxy;
  const searchUrl = env.web.searchUrl;
  // append-only:顺序与 build-engine.ts 既有策略(policy byName 键空间)一致。
  const tools = [
    createBashTool(sandboxRoot),
    createReadFileTool(sandboxRoot),
    createGrepTool(sandboxRoot),
    createGlobTool(sandboxRoot),
    createEditFileTool(sandboxRoot),
    createWriteFileTool(sandboxRoot),
    createWebFetchTool({ proxyUrl }),
    createWebSearchTool({ envSearchUrl: searchUrl, proxyUrl }),
  ];
  return createAciRegistry(tools);
}
