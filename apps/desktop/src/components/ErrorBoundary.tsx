import { Component, type ErrorInfo, type ReactNode } from "react";
import { log } from "../lib/logger";

type Props = { children: ReactNode };
type State = { error: string | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error: error.message };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[muse] ui_crash", error, info.componentStack);
    // Also to the app log: the webview console is gone by the time anyone
    // reads a crash report, and the component stack is what locates it.
    log.error("ui.crash", { message: error.message, stack: info.componentStack?.trim().split("\n").slice(0, 12).join(" < ") });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="empty">
        <h2>Muse hit a display error</h2>
        <p>Your threads on the Muse host were not deleted. Reload the window to continue.</p>
        <p className="muted">{this.state.error}</p>
        <button className="primary" onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    );
  }
}
