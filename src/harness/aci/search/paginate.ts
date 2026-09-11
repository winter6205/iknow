/**
 * 结果名单分页（SC12「分页」；契约 D3 / SC7）。
 *
 * 三种出法共用同一套 offset / head_limit —— 出法只决定「名单里放什么」，
 * 不决定「怎么切」。切的是**已排序**名单（见 `sort.ts`）。
 *
 * 回执语义（SC7）：
 *   - 名单为空（本次查询确实无命中）→ 空串。
 *   - 名单非空但 offset 越过最后一条 → 精确 `No entries at this offset`。
 *   两条回执互斥，且都不是「无匹配」文案 —— 模型据此区分「换个词」与
 *   「翻页翻过头」。
 */

/** SC7 精确回执；不是空串、不是「无匹配」。 */
export const NO_ENTRIES_AT_OFFSET = "No entries at this offset";

export interface Page<T> {
  readonly items: ReadonlyArray<T>;
  /**
   * offset 越过最后一条且名单非空 → true。调用方据此回
   * `NO_ENTRIES_AT_OFFSET`。
   */
  readonly beyondEnd: boolean;
}

/**
 * 切页。
 *
 * `items` 必须是已排序名单。空名单 → `{ items: [], beyondEnd: false }`
 * （无匹配是空串，不是本回执）。
 */
export function paginate<T>(
  items: ReadonlyArray<T>,
  offset: number,
  headLimit: number
): Page<T> {
  if (items.length === 0) return { items: [], beyondEnd: false };
  if (offset >= items.length) return { items: [], beyondEnd: true };
  return {
    items: items.slice(offset, offset + headLimit),
    beyondEnd: false,
  };
}
