/** @jsxImportSource @opentui/react */
/**
 * src/tui/message-shell.tsx
 *
 * #693 T1 D1/D7：共用 assistant 外壳组件 SSOT。
 * plans/tui-chrome-interaction.md T2：assistant 不再带 panel 填充 —— 外壳
 * 透传（无 backgroundColor、无 paddingX），仅 `marginTop` 节奏容器。assistant
 * 文本走终端默认底色、Markdown 格式化保留（子树自带 width / wrap）。用户消息
 * 仍走 userBg 填充（message-blocks.tsx 内部 box）；输入框 share user 填充
 * 家族（prompt-input.tsx 内部 box）。fold rows 跟 assistant ——
 * ChatView renderFoldLines 复用本壳,本壳无 panel 注入 → 折叠行也保持
 * 透明。
 *
 * 三个消费方共用同一壳（消除「外壳跳变」不一致）：
 *  (a) MessageBlocks assistant 分支（历史消息渲染）；
 *  (b) ChatView 流式草稿槽（运行中 assistant 草稿）；
 *  (c) ChatView renderFoldLines 折叠行容器（思考了 N 秒 / 工具计数）。
 *
 * `memo` 包裹：cols / marginTop 来自父 props（浅比较稳定）。children 若是
 * 每次新建的 JSX,外壳 memo 会失效——这是有意为之：memo 目标是外壳自身不因
 * 无关父状态重渲染（如 scrollbox scrollTop / streaming 草稿高频更新）；
 * children 仍由父组件按需重建，与现行 MessageBlocks memo 边界同源。
 */
import { memo, type ReactNode } from "react";

/**
 * 共用 assistant 外壳组件（memo 包裹）。
 *
 * props：
 *  - `cols`：外壳可用列宽（透传惯例；当前外壳本身不渲染文字,子节点自带
 *    width,不需要再透传）。
 *  - `marginTop`：根节点顶部 margin（消息间 1 行节奏由父组件传
 *    `visibleIndex===0?0:1`）。
 *  - `children`：壳内内容（文本 / Markdown / 工具摘要行 / 折叠行）。
 */
export const MessageShell = memo(function MessageShell(props: {
  readonly cols?: number;
  readonly marginTop?: number;
  readonly children: ReactNode;
}): ReactNode {
  // cols 仅用于父级契约透传（消费方按惯例传入,外壳本身不做宽度换算——
  // 子节点自带 width={cols}）。缺省不报错。
  void props.cols;
  // T2 透传化：不再注入 backgroundColor、不再 paddingX 水平缩进。
  // 内部块（用户消息 / 围栏代码块 / 输入框）各自带 fill,message-shell
  // 只负责消息间 marginTop 节奏。
  return (
    <box flexDirection="column" marginTop={props.marginTop ?? 0}>
      <box flexDirection="column">{props.children}</box>
    </box>
  );
});
