import { Component, lazy, Suspense, type ReactNode } from "react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";

import "./app.css";

// The registered artifact must remain declarative. Opening the stable Analytics
// route is the first point at which its executable surface is requested.
const AnalyticsPanel = lazy(() => import("./frontend/analytics-panel.tsx"));

class AnalyticsSurfaceBoundary extends Component<Readonly<{ children: ReactNode }>, Readonly<{ failed: boolean }>> {
  state = { failed: false };

  static getDerivedStateFromError(): Readonly<{ failed: boolean }> {
    return { failed: true };
  }

  render(): ReactNode {
    if (this.state.failed) {
      return <main className="analytics-shell"><p className="analytics-empty" role="status">
        Analytics could not load. <button type="button" onClick={() => window.location.reload()}>Reload page</button>
      </p></main>;
    }
    return <Suspense fallback={<main className="analytics-shell"><p className="analytics-empty" role="status">Preparing Analytics…</p></main>}>
      {this.props.children}
    </Suspense>;
  }
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "analytics",
    title: "Analytics",
    icon: "ChartNoAxesColumnIncreasing",
    path: "analytics",
    component: () => <AnalyticsSurfaceBoundary><AnalyticsPanel /></AnalyticsSurfaceBoundary>,
  });
});
