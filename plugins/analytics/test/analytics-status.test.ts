import assert from "node:assert/strict";
import test from "node:test";

import { describeIndexStatus } from "../analytics-status.ts";

const base = {
  status: "ready" as const,
  refreshing: false,
  degraded: false,
  lastError: null,
  connection: "connected" as const,
  freshnessLabel: "As of 2 hours ago",
};

test("error status wins over every other signal and surfaces the error text", () => {
  const view = describeIndexStatus({ ...base, status: "error", degraded: true, lastError: "Worker crashed", connection: "reconnecting" });
  assert.equal(view.tone, "error");
  assert.equal(view.headline, "Data unavailable");
  assert.equal(view.note, base.freshnessLabel);
  assert.equal(view.errorText, "Worker crashed");
});

test("refreshing takes priority over degraded and connection state", () => {
  const view = describeIndexStatus({ ...base, refreshing: true, degraded: true, connection: "connecting" });
  assert.equal(view.tone, "indexing");
  assert.equal(view.headline, "Refreshing…");
  assert.equal(view.note, base.freshnessLabel);
});

test("an empty index reports no data instead of an unavailable timestamp", () => {
  const view = describeIndexStatus({ ...base, status: "empty", freshnessLabel: "As of unavailable" });
  assert.deepEqual(view, { tone: "neutral", headline: "No data yet", note: null, errorText: null });
});

test("degraded coverage is called out without an error", () => {
  const view = describeIndexStatus({ ...base, degraded: true });
  assert.equal(view.tone, "attention");
  assert.equal(view.headline, base.freshnessLabel);
  assert.equal(view.note, "Partial data coverage");
  assert.equal(view.errorText, null);
});

test("a non-connected realtime link is named by its actual state", () => {
  assert.equal(describeIndexStatus({ ...base, connection: "connecting" }).note, "Connecting…");
  assert.equal(describeIndexStatus({ ...base, connection: "reconnecting" }).note, "Reconnecting…");
});

test("the steady state is quiet: freshness only, no note or error", () => {
  const view = describeIndexStatus(base);
  assert.deepEqual(view, { tone: "ready", headline: base.freshnessLabel, note: null, errorText: null });
});
