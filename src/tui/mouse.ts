/**
 * src/tui/mouse.ts
 *
 * SGR 鼠标序列守卫（#189 遗留）：app 已移除鼠标捕获（跟随 upstream，
 * 终端原生 scrollback 接管滚轮），此处仅保留 ink useInput 输入守卫——
 * 若终端仍以 SGR 编码上报鼠标事件，用它把 "[<数字;数字;数字M/m" 形态
 * 的序列丢弃，避免污染键盘输入链。
 *
 * ink 7.1.1 的 Key 类型没有 mouse 字段，useInput 也不解析 SGR 鼠标序列；
 * 剥 ESC 后（ink use-input.js:97-99 slice(1)）回调收到 "[<数字;数字;数字M/m"。
 */

/** ink useInput 守卫：SGR 鼠标序列剥 ESC 后形态（ink use-input.js:97-99 slice(1)
 * 剥 ESC 前缀，所以 useInput 回调收到 "[<数字;数字;数字M/m"）。
 * 抽到 mouse.ts 单点维护，避免两处硬编码 regex 漂移（app.tsx 顶层 useInput
 * 守卫 + PromptInput 守卫）。 */
export function isSgrMouseSequence(input: string): boolean {
  return /^\[<\d+;\d+;\d+[Mm]$/.test(input);
}
