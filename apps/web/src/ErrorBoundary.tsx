import React from "react";

// A styled, app-wide error page (a custom error page adapted to an SPA error
// boundary). Catches render-time crashes so the app shows a branded fallback
// instead of a blank screen.
interface State { error: Error | null; }

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="error-page">
        <div className="error-card">
          <div className="error-emoji">🌳</div>
          <h1>Something went wrong</h1>
          <p className="muted">The app hit an unexpected error. Your chats are stored locally and are safe.</p>
          <pre className="error-detail">{this.state.error.message}</pre>
          <div className="row-end">
            <button className="btn btn-primary" onClick={() => location.reload()}>Reload</button>
          </div>
        </div>
      </div>
    );
  }
}
