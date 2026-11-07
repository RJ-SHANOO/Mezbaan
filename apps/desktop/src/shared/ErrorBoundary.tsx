import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  /** Which module this boundary guards (e.g. "POS", "Kitchen") — shown in the
   * fallback UI and included in the logged error, so a crash report (or a screenshot
   * from branch staff) says exactly what broke. */
  module: string;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * CLAUDE.md's failure-boundary table: "A desktop screen | An error boundary closes
 * only that module; POS, kitchen and admin use separate windows." The separate
 * windows (P1-18) give OS-level isolation between POS and kitchen; this gives
 * component-level isolation *within* a window, so one broken screen doesn't blank
 * the whole terminal mid-service. Every module's root render goes through one of
 * these — see pos/App.tsx and kitchen/App.tsx.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Rule 16: never swallow errors silently. There's no crash-reporting service
    // wired up yet (that's Sentry on the backend only, so far) — console.error is
    // the honest baseline until P1-18's desktop equivalent exists.
    console.error(`[${this.props.module}] crashed:`, error, errorInfo.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-slate-50 px-6 text-center">
          <p className="text-lg font-semibold text-slate-900">{this.props.module} ran into a problem</p>
          <p className="max-w-sm text-sm text-slate-500">
            This screen crashed, but the rest of the terminal is unaffected. Restart {this.props.module.toLowerCase()} to continue.
          </p>
          <p className="max-w-md truncate text-xs text-slate-400">{this.state.error.message}</p>
        </div>
      );
    }
    return this.props.children;
  }
}
