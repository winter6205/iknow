import type { ReactNode } from "react";

export type AppShellProps = {
  header: ReactNode;
  main: ReactNode;
  side: ReactNode;
  footer?: ReactNode;
};

export function AppShell({ header, main, side, footer }: AppShellProps) {
  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg">
      {header}
      <div className="flex min-h-0 flex-1">
        {side}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {main}
          {footer ? <div className="shrink-0">{footer}</div> : null}
        </main>
      </div>
    </div>
  );
}
