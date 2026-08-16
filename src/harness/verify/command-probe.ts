/**
 * command-probe — D2 自动探测纯函数 (spec 449-evidence-checker, A10 / SC8)。
 *
 * 纯函数层: 零 IO、零 LLM、零 fs。编排层 / 调用方负责读取候选文件后把
 * 内容 (或路径) 压平传进来, 本函数只做字符串形态与 JSON 解析判定。
 *
 * files 数组的两形态契约 (why —— 调用方握有 fs 访问, 本函数只做纯计算):
 *   - 标志文件名 (普通路径字符串, 不以 { 开头):
 *       pyproject.toml | pytest.ini | go.mod | Cargo.toml
 *     命中即直接对应框架 (`package.json` 纯路径不贡献候选, 缺 dep 信息,
 *     fail-closed: 不读文件就猜不出 deps);
 *   - package.json 的 JSON 内容字符串 (以 { 开头): 调用方读取后传入,
 *     本函数解析后看 `dependencies` / `devDependencies` 是否含 vitest /
 *     jest; 含 → 对应 runner; 不含 / 解析失败 → 不贡献候选。
 *
 * 冲突规则 (A10 fail-closed, "不猜"): 候选命令出现 >= 2 个 → null; 候选
 * = 0 个 → null; 候选恰好 1 个 → 返回该命令。多标志文件 (pyproject+go.mod)
 * / 同 package.json 双 dep (vitest+jest) / 分处两条目 (一条 vitest +
 * 一条 jest) / 内容+标志混合 全部 → null。
 */

/** 标志文件名 → 默认验证命令 静态表。 */
const FLAG_FILE_COMMANDS: ReadonlyMap<string, string> = new Map([
  ["pyproject.toml", "pytest"],
  ["pytest.ini", "pytest"],
  ["go.mod", "go test ./..."],
  ["Cargo.toml", "cargo test"],
]);

/**
 * 解析 package.json JSON 字符串, 收集 vitest / jest 在 dependencies 与
 * devDependencies 中的命中候选命令。解析失败 / 形状不符 → 空集 (不贡献
 * 候选, fail-closed 不静默放行)。
 */
function packageJsonCandidates(content: string): ReadonlySet<string> {
  const out = new Set<string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object") return out;
  const obj = parsed as { dependencies?: unknown; devDependencies?: unknown };
  for (const field of ["dependencies", "devDependencies"] as const) {
    const deps = obj[field];
    if (!deps || typeof deps !== "object") continue;
    for (const name of Object.keys(deps as Record<string, unknown>)) {
      if (name === "vitest") out.add("npx vitest run");
      else if (name === "jest") out.add("npx jest");
    }
  }
  return out;
}

/**
 * probeVerifyCommand — D2 自动探测主入口 (spec Code Style)。
 * 返回唯一候选命令, 或 null (无候选 / 冲突 / 解析失败均 fail-closed)。
 */
export function probeVerifyCommand(
  files: ReadonlyArray<string>
): string | null {
  const candidates = new Set<string>();
  for (const file of files) {
    if (file.startsWith("{")) {
      // package.json 内容形态: 解析后看 deps 命中。
      for (const cmd of packageJsonCandidates(file)) {
        candidates.add(cmd);
        if (candidates.size > 1) return null;
      }
    } else {
      // 标志文件名形态: 静态表查表; 命中即对应命令。
      const cmd = FLAG_FILE_COMMANDS.get(file);
      if (cmd !== undefined) {
        candidates.add(cmd);
        if (candidates.size > 1) return null;
      }
    }
  }
  if (candidates.size !== 1) return null;
  return candidates.values().next().value ?? null;
}
