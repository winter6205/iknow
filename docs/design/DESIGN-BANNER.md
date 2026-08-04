# 启动 banner 视觉定案 · 智慧之眼（#171 支线 → #146 TUI 搬入）

> 正式实现：`src/tui/banner.ts` + `src/tui/banner-art.ts`（搬入自原型分支
> `worktree-tui-design-prototype` `tui-prototype/src/logo-braille/`）。
> 本文件 = 原型分支 `tui-prototype/docs/DESIGN-BANNER.md` 的实施期搬入定稿版：
> 保留设计裁决过程，路径改写为正式实现。源图：`docs/design/1785827453.png`
> （1785827447 / 1785827458 为同批候选稿）。

## 定案一句话

启动 banner = 智慧之眼（braille 变体 C）：方形全构图图案居左 + info 栏居右并排，
双色分层（墨绿线稿 + 金棕 R 符文强调），窄终端降级为不渲染。
字形 = U+2800-28FF 盲文（非 ASCII、非 emoji）——#146 spec 的「banner 纯 ASCII」
要求由本定案显式覆盖（specs/146-tui.md Code Style 已按此回填）。

## 1. 构图裁决（"被挤瘦了" → 方形全构图靠左）

诊断过程（三次迭代，留档防回退）：

1. 全构图内容 bbox 实测 816×785（比例 1.04，**本质方形**）——眼 + 环 + 8 个
   符文方框的构图就是方块；源画布 1664×928 的"宽"几乎全是背景留白。
2. 曾试宽幅网格（36×10，显示比 1.80）letterbox——方形图案缩成小块居中，
   左右大段空白，观感更差，否决。
3. 曾试裁主体（只留眼形，bbox 810×431=1.879 天然横宽）——操作员裁定
   **"符文还是需要"**，否决。

**最终方案（操作员"向左靠可以吗"）**：保留全构图，按天然方形比例渲染
（34 列 × 17 行 braille 码点，显示比 1.00 ≈ 内容 1.04），图案边缘到边缘填满、
无 letterbox 空白 gutter；banner 布局本来就是"图案居左 + info 栏居右"并排。

- info 栏 = 宽矩形，图案自然靠左。**方形图案不可横向拉宽（拉伸会畸变眼睛）。**
- threshold=180 / trimThreshold=200（点阵生成参数，勿动）。

## 2. 双色分层（按源 PNG 上色；背景不上色）

配色代理全分辨率实测（1664×928 直方图 + 连通域分区）：

| 色族     | HEX     | 占比           | 用途                                       |
| -------- | ------- | -------------- | ------------------------------------------ |
| 暖白背景 | #f7f7f1 | 90%            | **不渲染**，终端背景承担                   |
| 墨绿线稿 | #183223 | ~94%（非背景） | 眼轮廓 + 环带符文 + 8 个交叉方框（同色）   |
| 金棕强调 | #b97f1c | ~6%（非背景）  | **仅**瞳孔内 R 符文（bbox 内无绿像素混入） |

渲染为双色分层：绿层 = threshold 管线（180 天然滤掉 V≈185 的金棕像素）；
金层 = RGB mask（r>140 ∧ b<80 ∧ r−b>80）走与绿层**同一几何**（同 bbox / 网格）
的 mask → braille，两层逐 cell 对齐；`banner.ts` 合并时金层非空 cell 整体金色
（少量绿点被覆盖，定案可接受），其余墨绿。

色源：COLORTERM=truecolor → `38;2;24;50;35` / `38;2;185;127;28`（实测值直出）；
否则 ANSI256 → 22 `#005f00` / 136 `#af8700`（CIE76 最近候选）。
NO_COLOR / 非 TTY：paint 退化为 no-op，纯文本渲染（no-color.org 纪律）。

## 3. 布局与降级（正式实现收口）

- V7 布局：banner 之上无外框（框由输入框线框承担）；info 栏仅 version / cwd /
  dataDir（原型 sessionId / tools 等运行时项不搬）。
- **窄终端降级**：cols < 78（`BANNER_MIN_COLS`）→ 返回空行集（不渲染 banner），
  避免断行破碎。
- SHORT 档（单行 `◆ iknow`）：原型 V7 矮终端档，随搬入保留渲染能力，
  产品路径未接线（#146 未要求高度自适应；留 #154 后续）。
- 点阵重生成走原型分支 `build-art.ts` / `gen-gold.ts`（一次性设计期脚本）；
  字形原样搬入 `src/tui/banner-art.ts`，**勿手改**。

## 4. 验证记录（搬入后）

- `tests/tui/render-smoke.test.tsx`：banner 在 40 / 80 / 120 列 renderToString
  无溢出、窄终端降级返回空、UI 元素层无 emoji（U+1F300-1FAFF 缺席断言）。
- pty 冒烟：真实 TTY 下 banner 渲染正常（见
  `docs/handoff/2026-08-05-tui-implementation.md` 手工表）。
