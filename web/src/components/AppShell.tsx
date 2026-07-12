import type { ReactNode } from "react";
import styles from "./AppShell.module.css";

export type AppShellProps = {
  header: ReactNode;
  main: ReactNode;
  side: ReactNode;
  footer?: ReactNode;
};

export function AppShell({ header, main, side, footer }: AppShellProps) {
  return (
    <div className={styles.shell}>
      {header}
      <div className={styles.body}>
        <main className={styles.main}>
          <div className={styles.chat}>{main}</div>
          {footer ? <div className={styles.footer}>{footer}</div> : null}
        </main>
        {side}
      </div>
    </div>
  );
}
