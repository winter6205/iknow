/** @jsxImportSource @opentui/react */
/**
 * src/tui/message-shell.tsx
 *
 * #693 T1 D1/D7：共用 assistant 外壳组件 SSOT。
 *
 * 外壳 = assistantBg 底色 + paddingX={1} 水平缩进 + paddingY={0} 贴内容 +
 * 根节点 marginTop（消息间 1 行节奏）。
 *
 * 三个消费方统一套壳：
 *  (a) MessageBlocks assistant 分支（历史消息渲染）；
 *  (b) ChatView 流式草稿槽（运行中 assistant 草稿）；
 *  (c) ChatView renderFoldLines 折叠行容器（思考了 N 秒 / 工具计数）。
 *
 * `memo` 包裹：cols / marginTop 来自父 props，backgroundColor token 来自
 * frozen tuiPalette（浅比较稳定）。children 若是每次新建的 JSX，外壳
 * memo 会失效——这是有意为之：memo 目标是外壳自身不因无关父状态重渲染
 * （如 scrollbox scrollTop / streaming 草稿高频更新）；children 仍由
 * 父组件按需重建，与现行 MessageBlocks memo 边界同源。
 */
import { memo, type ReactNode } from "react";
import { tuiPalette } from "./theme.js";

/**
 * 共用 assistant 外壳组件（memo 包裹）。
 *
 * props：
 *  - `cols`：外壳可用列宽（用作 paddingX 水平缩进后的视觉宽度参考；
 *    当前外壳本身不渲染文字，子节点自带 width，不需要再透传）。
 *  - `marginTop`：根节点顶部 margin（消息间 1 行节奏由父组件传
 *    `visibleIndex===0?0:1`）。
 *  - `children`：壳内内容（文本 / Markdown / 工具摘要行 / 折叠行）。
 */
export const MessageShell = memo(function MessageShell(props: {
  readonly cols?: number;
  readonly marginTop?: number;
  readonly children: ReactNode;
}): ReactNode {
  // cols 仅用于父级契约透传（消费方按惯例传入，外壳本身不做宽度换算——
  // 子节点自带 width={cols-pad}）。缺省不报错。
  void props.cols;
  return (
    <box flexDirection="column" marginTop={props.marginTop ?? 0}>
      <box
        flexDirection="column"
        backgroundColor={tuiPalette.assistantBg}
        paddingX={1}
        paddingY={0}
      >
        {props.children}
      </box>
    </box>
  );
});
