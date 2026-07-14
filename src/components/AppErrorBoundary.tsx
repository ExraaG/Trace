import { AlertTriangle, RefreshCw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // The fallback below intentionally keeps runtime errors visible without logging app settings.
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="grid h-screen place-items-center bg-canvas p-6 text-zinc-200">
        <section className="w-full max-w-lg rounded-xl border border-red-900/60 bg-panel p-6 shadow-2xl shadow-black/50">
          <span className="mb-4 grid h-10 w-10 place-items-center rounded-lg bg-red-500/10 text-red-300">
            <AlertTriangle size={19} />
          </span>
          <h1 className="text-lg font-semibold">Trace hit a UI error</h1>
          <p className="mt-2 text-sm leading-6 text-zinc-400">Your sketches and credentials were not changed. Restart Trace to try again.</p>
          <pre className="mt-4 max-h-32 overflow-auto rounded border border-line bg-zinc-950 p-3 text-xs text-red-300">{this.state.error.message}</pre>
          <button className="toolbar-button mt-5" onClick={() => window.location.reload()}>
            <RefreshCw size={13} /> Restart Trace
          </button>
        </section>
      </main>
    );
  }
}
