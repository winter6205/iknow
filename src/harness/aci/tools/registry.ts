/**
 * ACI 工具集注册层 — 11 件 SSOT（8 基线 + memory_recall/memory_save + tool_search）。
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
 * **append-only**:不重排既有 8 工具顺序(policy byName 键空间与 ADR-0006 稳定);
 * Web 类工具(bash / read_file / grep / glob / edit_file / write_file 之后)
 * 沿用 build-engine.ts 历史顺序;memory_recall / memory_save(#228 layer 3,
 * 条件化:memoryDir 缺席时不入注册表)在 Web 类之后追加;`tool_search`(#224
 * 扩展路径)末尾追加。
 */
import type { IknowEnv } from "../../../config/env.js";
import { createAciRegistry, type AciRegistry } from "../aci-registry.js";
import type { AciToolDef } from "../types.js";
import { createBashTool } from "./bash.js";
import { createReadFileTool } from "./read-file.js";
import { createGrepTool } from "./grep.js";
import { createGlobTool } from "./glob.js";
import { createEditFileTool } from "./edit-file.js";
import { createWriteFileTool } from "./write-file.js";
import { createWebFetchTool } from "./web-fetch.js";
import { createWebSearchTool } from "./web-search.js";
import { createMemoryRecallTool } from "../../memory/tools/recall.js";
import { createMemorySaveTool } from "../../memory/tools/save.js";
import { createToolSearchTool } from "./tool-search.js";
import { createLspToolSet } from "./lsp.js";
import { RegistryConstructionError, ToolExecutionError } from "../../errors.js";

/**
 * 11 件生产工具的命名常量 — SSOT（8 基线 + memory_recall + memory_save + tool_search）。
 *
 * 这是给 LLM agent 调的 11 个生产工具(bash / read_file / grep / glob /
 * edit_file / write_file / web_fetch / web_search / memory_recall /
 * memory_save / tool_search)的命名真值,不是测试 fixture。导出它让两个层分工:
 *   - 装配层:`createDefaultAciRegistry()` 实际把 factories 拼起来,
 *     返回 AciRegistry;生产入口(build-engine / TUI)只跟工厂交互
 *   - 命名层:本常量承载「这 11 个名字是 iknow 工具集」的声明真值,
 *     被测试断言消费(`registry.test.ts` 用它锁工具集不变),也给未来
 *     诊断 / tool_search 类 hook 按名查工具用
 *
 * 即「测试断言消费」不等于「测试工具」— 它是工具集的命名权威,
 * 测试只是这条权威的消费者之一。
 *
 * **Gate 3（SSOT append-only 纪律）**:`createDefaultAciRegistry` 把 factories
 * 按此名单派生装配;若 factories 键与名单不一致(长度/顺序/成员任何一处
 * 分歧),装配期即抛 `RegistryConstructionError`。将来加件只改 factories 忘
 * append 名单(或反之,或重排既有项)装配期立刻失败,不给运行期留隐患。
 * memory_recall / memory_save 是条件化的(memoryDir 缺席时同时缺席,
 * Gate 3 在 `toolsetNames` 端做镜像过滤,见工厂尾部注释)。
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
  "memory_recall", // #228 layer 3（条件化:memoryDir 缺席时不装配）
  "memory_save", // #228 layer 3（同上）
  "tool_search", // #224 扩展路径
  // #251 LSP 工具集 append-only：10 件（9 operation + lsp_diagnostics）。
  // spec 写「8 operation + lsp_diagnostics = 9 件」但列了 9 个 operation 名
  // → 实为 10 件；总量 11→21。append-only 纪律：不重排既有 11 件。
  "lsp_definition", // #251 LSP operation
  "lsp_references", // #251
  "lsp_hover", // #251
  "lsp_document_symbol", // #251
  "lsp_workspace_symbol", // #251
  "lsp_go_to_implementation", // #251
  "lsp_prepare_call_hierarchy", // #251
  "lsp_incoming_calls", // #251
  "lsp_outgoing_calls", // #251
  "lsp_diagnostics", // #251
] as const);

/**
 * 工厂入参:仅消费 env.web 字段(端点覆写 + 出站代理)与沙箱根。
 * 不接收完整 IknowEnv — 避免误传 LLM key 等敏感字段越界。
 */
export interface CreateDefaultAciRegistryOptions {
  readonly env: Pick<IknowEnv, "web">;
  /** 软沙箱根(传入 process.cwd() 或调用方显式路径;fs 工具据此越界拒绝)。 */
  readonly sandboxRoot: string;
  /** 记忆库根目录(#228 layer 3)。缺席时 memory_recall / memory_save 不入注册表。 */
  readonly memoryDir?: string;
  /** #251 onEdit 接缝:edit_file 写盘成功后回调(装配层接 LSP notifier)。 */
  readonly onEdit?: (file: string) => void;
}

/**
 * 默认工具注册工厂 — SSOT（memoryDir 缺席 → 9 件:8 + tool_search;
 * memoryDir 存在 → 11 件:8 + memory_recall + memory_save + tool_search）。
 *
 * **装配期 fail-fast**:
 *   - proxyUrl 非法(非 http/https / 含凭据)→ `createWebFetchTool` /
 *     `createWebSearchTool` 工厂内 `createDefaultGuardDeps` 同步抛
 *     ToolExecutionError,与 build-engine.ts 既有行为一致
 *     (tests/build-engine.test.ts:94 已锁)。
 *   - **Gate 3（SSOT append-only 纪律）**:`ACI_TOOLSET_NAMES` 与下面
 *     `factories` 记录键不一致（长度/顺序/成员任何一处分歧）→ 同步抛
 *     `RegistryConstructionError`。derived-from-map 形态让闸门有真牙:
 *     将来加件只改 factories 忘 append names(或反之)装配期立刻失败,
 *     不给运行期留隐患（D4）。memory 条件化:memoryDir 缺席时 toolsetNames
 *     先剔除 memory_recall / memory_save 再做 Gate 3 对比,与 factories
 *     键集一致。
 *
 * **返回值**:`AciRegistry`(含 `inner` 协议层 + `catalog` 权限/延迟加载层),
 * 调用方可直接交给 `createExecutor` 与 `createAciExecutor`。
 *
 * **tool_search 自引用**:`tool_search` 需要的是"已装配完成的 registry",
 * 但 registry 自身包含 tool_search（直接持有即自引用循环）。故 deps 用
 * `getRegistry: () => AciRegistry` 惰性闭包,装配完成后由 `assembled.reg`
 * 解引用。装配未完成即被调用 → 抛 ToolExecutionError（fail-fast）。
 */
/**
 * 把 LSP 工具集展开成 factories 记录（10 件:lsp_definition / lsp_references
 * / lsp_hover / lsp_document_symbol / lsp_workspace_symbol /
 * lsp_go_to_implementation / lsp_prepare_call_hierarchy / lsp_incoming_calls
 * / lsp_outgoing_calls / lsp_diagnostics）。createLspToolSet(ctx) 返回冻结
 * AciToolDef 列表；每件按 ACI_TOOLSET_NAMES 中的 key 索引。
 */
function lspTools(directory: string): Record<string, () => AciToolDef> {
  const tools = createLspToolSet({ directory });
  const map: Record<string, () => AciToolDef> = {};
  for (const t of tools) {
    map[t.name] = () => t;
  }
  return map;
}

export function createDefaultAciRegistry(
  opts: CreateDefaultAciRegistryOptions
): AciRegistry {
  const { env, sandboxRoot } = opts;
  const onEdit = opts.onEdit;
  const proxyUrl = env.web.proxy;
  const searchUrl = env.web.searchUrl;
  const memoryDir = opts.memoryDir;

  // holder:tool_search 自引用的惰性解引用点(装配完成前闭包返回 undefined,
  // tool-search.ts:resolveRegistry 触发 ToolExecutionError 兜底)。
  const assembled: { reg?: AciRegistry } = {};

  // append-only:顺序与 build-engine.ts 既有策略(policy byName 键空间)一致。
  // memoryDir 缺席 → memory_recall / memory_save 从 factories 剔除
  // (memoryEnabled=false 的 ask 路径;见 build-engine.ts 条件构造)。
  // 键顺序必须与 ACI_TOOLSET_NAMES 逐项一致(Gate 3):memory_* 在
  // tool_search 之前。
  const factories: Record<string, () => AciToolDef> = {
    bash: () => createBashTool(sandboxRoot),
    read_file: () => createReadFileTool(sandboxRoot),
    grep: () => createGrepTool(sandboxRoot),
    glob: () => createGlobTool(sandboxRoot),
    edit_file: () => createEditFileTool(sandboxRoot, { onEdit }),
    write_file: () => createWriteFileTool(sandboxRoot),
    web_fetch: () => createWebFetchTool({ proxyUrl }),
    web_search: () =>
      createWebSearchTool({ envSearchUrl: searchUrl, proxyUrl }),
    ...(memoryDir
      ? {
          memory_recall: () => createMemoryRecallTool({ memoryDir }),
          memory_save: () => createMemorySaveTool({ memoryDir }),
        }
      : {}),
    tool_search: () =>
      createToolSearchTool({
        getRegistry: () => {
          const r = assembled.reg;
          if (!r) {
            throw new ToolExecutionError("tool_search: registry not assembled");
          }
          return r;
        },
      }),
    // #251 LSP 工具集：NearestRoot 上界 stop=ctx.directory=sandboxRoot
    // （build-engine 传 process.cwd()，与 fs 工具软沙箱同根语义一致）。
    ...lspTools(sandboxRoot),
  };

  // Gate 3 校验:factories 键与 ACI_TOOLSET_NAMES 严格一致(长度+顺序+成员)。
  // memoryDir 缺席时 memory_recall/memory_save 不装配,故对照名单需先剔除
  // 这两个条件键。任何不一致均装配期失败,不留到运行期。
  const factoryNames = Object.keys(factories);
  const toolsetNames = memoryDir
    ? (ACI_TOOLSET_NAMES as ReadonlyArray<string>)
    : (ACI_TOOLSET_NAMES as ReadonlyArray<string>).filter(
        (n) => n !== "memory_recall" && n !== "memory_save"
      );
  if (
    factoryNames.length !== toolsetNames.length ||
    factoryNames.some((n, i) => n !== toolsetNames[i])
  ) {
    throw new RegistryConstructionError(
      `ACI_TOOLSET_NAMES / factories diverge: have=[${factoryNames.join(",")}] want=[${toolsetNames.join(",")}]`
    );
  }

  const tools = toolsetNames.map((n) => factories[n]!());
  const reg = createAciRegistry(tools);
  assembled.reg = reg;
  return reg;
}
