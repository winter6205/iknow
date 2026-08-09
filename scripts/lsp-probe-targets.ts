/**
 * LSP 探针夹具表 — spec 302-lsp-multilang（§ PROBE_TARGETS，#307 Q3）。
 *
 * 每门语言一个 `{ serverId, targetFile, line, char }` 条目，probe（lsp-probe.ts）
 * 遍历本表 × 生产 `SERVERS` 跑 9-op 真实 server 烟测。
 *
 * 目标文件分两类：
 *  - **真实仓库文件**（typescript / yaml / json）：`targetFile` 是绝对路径，
 *    probe 直接以其为 9-op 目标；`line`/`char` 指向文件内真实符号。
 *  - **运行时生成夹具**（python / dockerfile）：仓库无对应真实目标文件（pyright
 *    需要 root 标记、dockerfile 仓库无 Dockerfile），`fixture` 提供源内容、
 *    `targetFile` 是夹具项目内的相对文件名，probe 在 `.iknow/probe-lsp/<lang>/`
 *    （gitignore）写入后作为目标。`rootMarkers` 是夹具项目根需的标记文件
 *    （pyright 靠 `pyrightconfig.json` 定 root）。
 *
 * 夹具放在 `.iknow/`（gitignore）而非 repo 根，避免被误当真实部署文件。
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库根（= worktree 根）。真实仓库文件路径以此为基准。 */
const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

export interface ProbeTarget {
  /** 生产 `SERVERS` 中对应的 server id（probe 据此选 server）。 */
  readonly serverId: string;
  /** 真实仓库文件绝对路径，或夹具项目内相对文件名（`fixture` 存在时）。 */
  readonly targetFile: string;
  /** 1-based line（handler 层转 0-based）。 */
  readonly line: number;
  /** 0-based character。 */
  readonly char: number;
  /** 夹具源内容；存在时 probe 写入 `.iknow/probe-lsp/<lang>/` 后作为目标。 */
  readonly fixture?: string;
  /** 夹具项目根需要的 root 标记文件（如 pyrightconfig.json）。 */
  readonly rootMarkers?: readonly string[];
}

/**
 * 各语言夹具表。`--lang` 取值即本表 key（typescript/python/yaml/json/dockerfile）。
 *
 * 位置核实（真实文件）：
 *  - typescript：`client.ts:94` `export async function getClient(`，char 22 指向
 *    `getClient` 标识符起始（0-based）。
 *  - yaml：`.github/workflows/s4-red-test-first.yml:9` `    runs-on: ubuntu-latest`，
 *    char 4 指向 `runs-on` 键起始。
 *  - json：`tsconfig.json:2` `  "compilerOptions": {`，char 1 指向键起始。
 */
export const PROBE_TARGETS: Record<string, ProbeTarget> = {
  typescript: {
    serverId: "typescript",
    targetFile: resolve(REPO_ROOT, "src/harness/lsp/client.ts"),
    line: 94,
    char: 22,
  },
  python: {
    serverId: "pyright",
    targetFile: "probe.py",
    line: 1,
    char: 4,
    rootMarkers: ["pyrightconfig.json"],
    fixture:
      'def compute_offset(base: int, step: int = 1) -> int:\n' +
      '    return base + step\n' +
      '\n' +
      'def main() -> None:\n' +
      '    return compute_offset(1)\n',
  },
  yaml: {
    serverId: "yaml-language-server",
    targetFile: "probe.yml",
    line: 5,
    char: 9,
    // yaml-language-server 对仓库 .github/workflows/*.yml 的 definition/hover
    // 实测为空（无锚点）。改用运行时夹具（同 python/dockerfile），在
    // `.iknow/probe-lsp/yaml/probe.yml` 写入含 YAML 锚点的源 —— anchor
    // reference `*defaults` 的 definition 实测返回非空（跳到锚点定义处）。
    rootMarkers: [],
    fixture:
      "defaults: &defaults\n" +
      "  runs-on: ubuntu-latest\n" +
      "jobs:\n" +
      "  build:\n" +
      "    <<: *defaults\n",
  },
  json: {
    serverId: "json-language-server",
    targetFile: resolve(REPO_ROOT, "tsconfig.json"),
    line: 2,
    char: 1,
  },
  dockerfile: {
    serverId: "dockerfile-language-server-nodejs",
    targetFile: "Dockerfile",
    line: 1,
    char: 5,
    // dockerfile-language-server-nodejs 对 FROM 镜像名 / ARG 引用的 definition
    // 实测为 null；但对 `ARG NAME=value` 的**变量名**（本例 `BASE_VERSION`，
    // line 1 char 4-16）definition 返非空（自指 range），hover 返回 value
    // （`{"contents":"20"}`）。夹具带 ARG 引用 + 变量名定位，让 definition/hover
    // 真实非空；references / implementation / workspaceSymbol / callHierarchy
    // 该 server 未声明 provider（见 probe 能力裁剪日志）。
    rootMarkers: [],
    fixture:
      "ARG BASE_VERSION=20\n" +
      "FROM node:${BASE_VERSION}-alpine\n" +
      'RUN echo "hello" && echo "world"\n',
  },
};
