/**
 * 行协议可表示性（D2 出法纪律；两条引擎共用）。
 *
 * 三种出法都是**行协议**：`paths` 每行一条路径、`content` 每行
 * `path:line:text`、`count` 每行 `path:条数`。路径里一旦含 `\n`，一条记录
 * 就会被读成两条（或把下一条吞进自己）；含 `\0` 则与 `--null` 的分隔符
 * 撞车。两种字符都**无法**在行协议里无损表示。
 *
 * 实测（15.1.0，见 `argv.ts` 的 `--null` 说明与 `rg-engine.ts` 的复核）：
 * 含 `\n` 的路径在 rg 侧会把记录拆成两段 —— 前半段被当成一条**假命中**
 * （形如 `name.txt:1:needle here`，而磁盘上并没有这个文件），后半段的
 * 真实路径则对不上任何文件。同一个目录在 Node 侧则是另一种坏法（原样吐出
 * 带换行的路径）。两边坏得不一样，所以**不能**各修各的。
 *
 * 口径：**含 `\n` / `\0` 的路径在任何出法里都不出现**，由本模块在两条引擎
 * 共用的收口处统一剔除。不做路径改写（那会让模型看到与磁盘不同的名字，
 * 后续 `read_file` / `edit_file` 必然失败），也不把换行转义进正文。
 *
 * 剔除后 `head_limit` / `total:` 仍然自洽：
 *   - rg 侧先行 `--glob` 剔除（见 `argv.ts`），于是 `--count` 的分母、
 *     `-l` 的名单里本来就没有它们；
 *   - 收口处再按同一判据过滤（rg 的 `--glob` 不管**显式点名的文件参数**，
 *     `path: "nl\nname.txt"` 这条仍然会到收口处）。
 */

/** 路径是否能在行协议里无损表示。 */
export function isPathRepresentable(path: string): boolean {
  return !path.includes("\n") && !path.includes("\0");
}

/** 从名单里剔掉不可表示的路径（顺序保持，不重复判定）。 */
export function keepRepresentablePaths<T>(
  items: ReadonlyArray<T>,
  pathOf: (item: T) => string
): T[] {
  return items.filter((item) => isPathRepresentable(pathOf(item)));
}

/**
 * rg 遍历期排除含 `\n` 路径的两条 glob（`argv.ts` 与测试共用同一份常量）。
 *
 * 第一条按**基名**判（不含 `/` 的模式按任意深度的基名匹配）：剔掉所有
 * 自身名字含换行的文件与目录。
 *
 * 第二条按**祖先前缀**判：名字含换行的**目录**整棵子树都要剔 —— 少了它，
 * `sub/a\nb/inner.txt` 这类路径的基名是干净的（`inner.txt`），第一条不中，
 * 而它整条路径仍含换行、仍不可表示（实测：只加第一条时这类文件照旧出现，
 * 且被反解析成两条假记录）。
 */
export const NEWLINE_PATH_EXCLUDES: ReadonlyArray<string> = [
  "!*\n*",
  "!*\n*/**",
];
