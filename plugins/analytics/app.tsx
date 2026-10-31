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

function AnalyticsIcon({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 20V9m5 11v-6m5 6v-3" />
    <circle cx="15" cy="8" r="5" />
    <path d="m18.5 11.5 3 3" />
  </svg>;
}

export default definePluginApp((app) => {
  app.experimental_icons.register({ name: "analytics/explore", component: AnalyticsIcon });
  app.slots.navPanel({
    id: "analytics",
    title: "Analytics",
    icon: "analytics/explore",
    path: "analytics",
    component: () => <AnalyticsSurfaceBoundary><AnalyticsPanel /></AnalyticsSurfaceBoundary>,
  });
});
