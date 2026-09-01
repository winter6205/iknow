import { Component, type ErrorInfo, type ReactNode } from "react";
import { StateBlock } from "./StateBlock";

type Props = {
  children: ReactNode;
};

type State = {
  error: Error | null;
};

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[iknow] UI error", error, info.componentStack);
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      return (
        <StateBlock
          kind="error"
          title="界面异常"
          detail={this.state.error.message || "未知错误"}
          onRetry={this.handleRetry}
          retryLabel="重试渲染"
        />
      );
    }
    return this.props.children;
  }
}
