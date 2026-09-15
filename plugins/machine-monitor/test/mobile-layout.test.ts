import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const styles = await readFile(new URL("../app.css", import.meta.url), "utf8");
const app = await readFile(new URL("../app.tsx", import.meta.url), "utf8");

test("panel owns constrained-height scrolling without horizontal overflow", () => {
  const root = styles.match(/\.machine-monitor\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(root, /height:\s*100%/);
  assert.match(root, /min-width:\s*0/);
  assert.match(root, /min-height:\s*0/);
  assert.match(root, /overflow-x:\s*hidden/);
  assert.match(root, /overflow-y:\s*auto/);
  assert.match(root, /overscroll-behavior-y:\s*contain/);
});

test("narrow fleet atlas keeps native controls, layered status, and compact structure", () => {
  assert.match(app, /aria-pressed=\{selected\}/);
  assert.match(app, /aria-describedby=\{descriptionId\}/);
  assert.match(app, /data-connection=\{machine\.connection\}/);
  assert.match(app, /data-freshness=\{machine\.freshness\}/);
  assert.match(app, /data-collector=\{atlas\.collectorState\}/);
  assert.match(app, /data-pressure=\{atlas\.pressureLevel\}/);
  assert.match(app, /--machine-monitor-cpu-pressure/);
  assert.match(app, /--machine-monitor-memory-pressure/);
  assert.match(app, /--machine-monitor-disk-pressure/);
  assert.match(app, /FleetUtilizationChart/);
  assert.match(app, /FLEET_UTILIZATION_ATTENTION_PERCENT/);
  assert.match(app, /data-utilization=\{atlas\.utilization\.state\}/);
  assert.match(app, /onFocus=\{\(\) => onIntent\(machine\)\}/);
  assert.match(app, /onPointerEnter=\{\(\) => onIntent\(machine\)\}/);
  assert.match(styles, /\.machine-monitor__atlas-button\s*\{[^}]*min-width:\s*0/);
  assert.match(styles, /\.machine-monitor__atlas-button\s*\{[^}]*background:\s*linear-gradient\(90deg, var\(--machine-monitor-collector-layer\)/);
  assert.match(styles, /var\(--machine-monitor-cpu-pressure\)/);
  assert.match(styles, /var\(--machine-monitor-memory-pressure\)/);
  assert.match(styles, /var\(--machine-monitor-disk-pressure\)/);
  assert.match(styles, /\.machine-monitor__atlas-button\[data-connection="disconnected"\]/);
  assert.match(styles, /\.machine-monitor__atlas-button\[data-freshness="stale"\]/);
  assert.match(styles, /\.machine-monitor__atlas-button\[data-collector="failure"\]/);
  assert.match(styles, /\.machine-monitor__atlas-metric\[data-level="unavailable"\][^}]*border-style:\s*dashed/);
  assert.match(styles, /\.machine-monitor__fleet-utilization > div\[role="img"\]\s*\{[^}]*height:\s*152px/);
  assert.match(styles, /\.machine-monitor__atlas-score\s*\{[^}]*grid-area:\s*score/);
  assert.match(styles, /\.machine-monitor__atlas-button\[data-utilization="attention"\]/);
  assert.match(styles, /\.machine-monitor__atlas-identity strong[^}]*text-overflow:\s*ellipsis/);
  assert.match(styles, /\.machine-monitor__echarts-theme\s*\{[^}]*border-bottom-color:\s*var\(--primary\)/);
  assert.match(styles, /\.machine-monitor__fleet-picker button:focus-visible/);
  assert.match(styles, /\.machine-monitor__fleet-picker\[data-inspecting\] \.machine-monitor__atlas-button/);
  assert.match(styles, /@container \(max-width:\s*460px\)\s*\{[\s\S]*?\.machine-monitor__fleet-picker > header/);
  assert.match(styles, /@container \(max-width:\s*300px\)\s*\{[\s\S]*?\.machine-monitor__fleet-picker > ol/);
});

test("dashboard and detail charts have definite responsive drawing rectangles and native event action", () => {
  assert.match(styles, /\.machine-monitor__dashboard-chart > div\[role="img"\]\s*\{[^}]*min-height:\s*292px/);
  assert.match(styles, /\.machine-monitor__dashboard-chart > div\[role="img"\][^}]*height:\s*306px/);
  assert.match(styles, /\.machine-monitor__timeline-chart > div\[role="img"\]\s*\{[^}]*min-height:\s*300px/);
  assert.match(styles, /\.machine-monitor__timeline-chart > div\[role="img"\][^}]*height:\s*320px/);
  assert.match(styles, /touch-action:\s*pan-y\s+pinch-zoom/);
  assert.match(styles, /@container \(max-width:\s*760px\)\s*\{[\s\S]*?\.machine-monitor__timeline-chart > div\[role="img"\]/);
  assert.match(app, /navigate\.toThread\(activation\.bbReference\.threadId\)/);
});

test("mobile operational cards and disk breakdown collapse without forcing a wide grid", () => {
  const compact = styles.match(/@container \(max-width:\s*760px\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(compact, /\.machine-monitor__metrics[^\{]*\.machine-monitor__directories > ol[^\{]*\{\s*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(styles, /@container \(max-width:\s*300px\)\s*\{[\s\S]*?\.machine-monitor__dashboard-captions/);
});
