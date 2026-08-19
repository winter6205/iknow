import { useState } from "react";
import { basename } from "./WorkspaceChip";

export type WorkspacePickerProps = {
  readonly recents: ReadonlyArray<string>;
  readonly currentRoot: string | null;
  readonly onBind: (
    path: string,
    opts?: { confirmTrust?: boolean }
  ) => Promise<void>;
  readonly onClose: () => void;
  readonly onNotice: (text: string) => void;
};

/**
 * 绑定请求载荷构造（空/纯空白输入 → null；供单测与组件共享）。把这条
 * 决策从组件里拆出来是为了在 renderToStaticMarkup（无 DOM）测试场景下
 * 也能直接断言"onBind 调用带 confirmTrust 参数"的契约。
 */
export function buildBindPayload(
  input: string,
  confirming: boolean
): { path: string; confirmTrust: boolean } | null {
  const path = input.trim();
  if (!path) return null;
  return { path, confirmTrust: confirming };
}

/**
 * serve-workspace T5: 顶部分区内联 panel（镜像 McpPanel 位置——消息流上方）。
 * 绝对路径输入 + 信任确认 toggle + 已信任根列表（点击填入输入框）。
 * 绑定失败不关闭，错误走 onNotice（消息流 notice 通道）。
 */
export function WorkspacePicker(props: WorkspacePickerProps) {
  const [input, setInput] = useState(props.currentRoot ?? "");
  const [binding, setBinding] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const submit = async () => {
    const payload = buildBindPayload(input, confirming);
    if (!payload) return;
    setBinding(true);
    try {
      await props.onBind(payload.path, { confirmTrust: payload.confirmTrust });
      props.onClose();
    } catch (e) {
      props.onNotice(`绑定失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBinding(false);
      setConfirming(false);
    }
  };

  return (
    <div className="border-b border-ink-3/30 bg-surface px-3 py-2 text-[12px]">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium text-ink">选择工作空间根</span>
        <button type="button" className="text-ink-3" onClick={props.onClose}>
          关闭
        </button>
      </div>
      <div className="flex gap-1">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="/abs/path/to/project"
          aria-label="工作空间绝对路径"
          className="min-w-0 flex-1 rounded-pill border border-ink-3/30 bg-surface px-2 py-1 font-mono text-[11px] outline-none focus:border-accent"
        />
        <button
          type="button"
          onClick={() => setConfirming((c) => !c)}
          title="首次绑定新绝对路径需先确认信任"
          aria-pressed={confirming}
          className={`rounded-pill px-2 py-1 text-[11px] ${confirming ? "bg-warn text-ink" : "text-ink-3 hover:text-ink"}`}
        >
          信任{confirming ? "✓" : ""}
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={binding || !input.trim()}
          className="rounded-pill bg-accent px-3 py-1 text-[11px] font-medium text-ink disabled:opacity-50"
        >
          {binding ? "绑定中…" : "绑定"}
        </button>
      </div>
      {props.recents.length > 0 ? (
        <>
          <p className="mt-2 mb-1 text-ink-3">已信任的根（点击选择）</p>
          <ul className="flex max-h-32 flex-col gap-0.5 overflow-y-auto">
            {props.recents.map((r) => (
              <li key={r}>
                <button
                  type="button"
                  className={`w-full truncate rounded-pill px-2 py-1 text-left font-mono text-[11px] ${
                    r === props.currentRoot
                      ? "bg-accent-soft text-accent"
                      : "hover:bg-accent-soft/50"
                  }`}
                  onClick={() => setInput(r)}
                >
                  {basename(r)} <span className="text-ink-3">· {r}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
