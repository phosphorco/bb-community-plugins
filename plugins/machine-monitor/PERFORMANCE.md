# Fleet selection latency witness

`npm --prefix community-plugins run test:fleet-performance --workspace @phosphorco/bb-plugin-machine-monitor`
is the isolated production-browser lane. It builds the current Machine Monitor
app source to a temporary production bundle, loads it in Chromium, and deletes
the bundle after the run. It never contacts a daemon or starts an event
producer.

## Reproducibility and preflight

| Input | Recorded value |
| --- | --- |
| BB materialized runtime result tree | `6c1a302a5a6ac65d8deddac822aee556444da570` |
| Community plugin source HEAD | `e84349affb738935e8de7e9aae0c373329ce4663` |
| Served production bundle SHA-256 | `e548b2525b9596c564fa20ca381977146d1c1f2535819b3fb94c068d9e94922f` |
| Playwright / browser | `@playwright/test` 1.63.0; Chromium 153.0.8010.12, Playwright revision 1243 (`~/.cache/ms-playwright/chromium-1243`) |
| Viewport / scale | 1280×900, DPR 1 |
| Theme / motion / locale | light / reduced motion / `en-US` |
| Network cache state | HTTP cache disabled; service workers blocked |
| Application cache state | overview resident; request-idle callbacks deliberately held; only machine 03/04/05 are explicitly focus-warmed before cached measurements |
| Fixture | `fleet-performance-fixture-v1`, `fnv1a32:679b2fa2:10344868` |

The fixture has exactly 32 enrolled machines, three core tracks (`cpu.utilization.percent`,
`load.1`, `load.5`) with 720 buckets each, and 500 exact events on selected
machine 00. Those events are test data served by the local RPC seam only; they
are never accepted by the production event schema or emitted by a producer.

The test rejects a changed fixture count, track order/count, selected-event
count, or fingerprint before measuring. It also rejects a run unless its
pre-React bootstrap reports all five probes: Long Tasks `PerformanceObserver`,
animation-frame paint witness, ECharts init/dispose/setOption counter, RPC/host
counter, and interval counter. Before timing, it also verifies that the atlas
is compact, exposes all 32 native cards, preserves source order, and marks the
initial source selected. Useful paint is the second browser animation frame
after the expected selected heading and chart identity commit; no test-runner
wall-clock timer is used as the latency verdict.

## Method

Each distribution contains 12 alternating control/candidate pairs. The cached
candidate alternates between revision-current warmed machines 03 and 04. The
warm-uncached candidate alternates machines 10–21 while their one local-server
RPC is deliberately held across two user clicks, proving client single-flight
and retained content before release. Controls click the current machine. The
trace records a browser-frame useful-paint timestamp, native long tasks,
network/host/chart deltas, DOM mutations, and Chromium heap telemetry.

## Raw production-browser measurements

Run: 2026-09-14, all values in milliseconds. Raw runner output is emitted as
`FLEET_PERFORMANCE_RAW=` by the named script. The compact-atlas receipt kept
the same 32-source fixture, production bundle, Chromium revision, cache mode,
and interaction protocol as the prior receipt.

| Distribution | 12 alternating-control measurements | Candidate measurements | p95 / gate |
| --- | --- | --- | --- |
| Cached | 31.0, 30.5, 31.2, 31.3, 31.1, 31.2, 31.1, 31.3, 31.6, 30.3, 31.1, 31.7 | 31.9, 30.9, 30.8, 30.9, 30.1, 32.1, 31.2, 31.4, 32.4, 31.1, 31.3, 31.5 | **32.4 / ≤50 interaction gate pass** |
| Warm uncached | 31.5, 31.0, 31.6, 31.5, 31.6, 31.8, 31.5, 31.6, 30.9, 31.6, 31.5, 31.2 | 81.7, 80.9, 81.5, 81.2, 80.7, 81.2, 81.4, 80.9, 81.0, 81.4, 81.2, 80.6 | **81.7 / ≤110 atlas-regression ceiling / ≤250 interaction gate pass** |

The refreshed p95 values improved from 33.8ms to 32.4ms cached and from 83.6ms
to 81.7ms warm uncached. The witness rejects cached work above the product
50ms interaction budget and warm-uncached work above 110ms (still stricter
than its 250ms interaction budget). A 45ms source-level cached guard proved
nondeterministic under ordinary browser scheduling despite unchanged source and
the preserved shared-chart topology, so it is not used as a release gate.

All 12 cached candidates had `machineTimeline RPC=0`, `hostCalls=0`,
`chartInit=0`, `chartDispose=0`, one value update, and no Long Tasks. All 12
uncached candidates had exactly one coalesced `machineTimeline` RPC,
`hostCalls=0`, `chartInit=0`, one value update, no Long Tasks, and both the
compact overview and a retained stale timeline before the held response was
released. This is the no-chart-remount receipt for the atlas change.

Revision scope raw records:

| Scenario | Useful paint | Timeline RPC | Host calls | Chart remount | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| Unaffected current machine 03 | 31.4 | 0 | 0 | 0 | retained cache hit |
| Unaffected machine 04 | 31.5 | 0 | 0 | 0 | retained cache hit |
| Revised machine 05 | 81.7 | 1 | 0 | 0 | only target refetched; retained content shown |

After the revision sequence, a 300ms settled-idle window recorded zero RPCs,
host calls, chart init/dispose/setOption calls, interval creations/owners, and
DOM mutations. This is the idle no-poll/no-repeat-render gate.

## Cache and memory bounds

`FleetClient` caps detailed resident timelines at 8,388,608 bytes. The
deterministic fixture serializes to 521,037 bytes for the selected 500-event
timeline and 316,517 bytes for an ordinary 720×3 timeline. Directly loading
all 32 fixture timelines through the production cache retained 26 entries and
8,223,127 bytes—under the cap. The browser run's final Chromium telemetry was
27,600,000 used JS-heap bytes out of 53,500,000 total JS-heap bytes; this is
recorded context, not a separate acceptance threshold.

The normal package test intentionally excludes `fleet-performance*.test.ts`:
parallel test workers perturb a 50ms browser p95. The named performance script
is the required isolated lane and does not relax any production acceptance
number.

## Operational-dashboard ECharts release check

Run: 2026-09-15. The selected-machine surface now retains one ECharts instance
with two grids: CPU, memory-used/total, and root-disk-used/total utilization on
the left (with the inclusive 70% attention line), and five-minute load on the
right. Exact events remain in the explicitly opened source timeline below it.
While an uncached selection is loading, the retained dashboard stays mounted
and names the source of its retained history; it never exposes that source's
event actions as if they belonged to the newly selected machine.

The deterministic performance fixture remains unchanged: 32 sources, three
core tracks with 720 buckets each, and 500 selected-machine events. Its sparse
metric set intentionally proves the dashboard leaves unavailable memory/disk
traces blank rather than inventing a zero percentage. The focused chart suite
separately proves capacity ratios and the fixed attention line. Source order is
retained by native controls; a real Chromium SVG bar hit selects its matching
source, while the chart compiler rejects a late datum after reordering unless
its stable machine key still matches.

The temporary production bundle SHA-256 was
`bda4a74b867d764e249e1108a853f2f200a359dfd098a2ebe5db229e5c1e230c`, using
Chromium 153.0.8010.12 / revision 1243 at 1280×900 DPR 1, light theme, reduced
motion, HTTP cache disabled, and service workers blocked.

| Distribution | Candidate p95 / gate |
| --- | --- |
| Cached selection | **31.3ms / ≤50ms interaction gate pass** |
| Warm-uncached selection | **81.2ms / ≤110ms dashboard-regression ceiling / ≤250ms interaction gate pass** |

The 12 cached candidate paints were 30.3, 30.3, 30.8, 30.5, 30.8, 31.3,
31.1, 31.2, 30.8, 30.8, 31.1, and 31.1ms. The warm-uncached candidates were
80.1, 79.8, 80.9, 80.6, 80.6, 80.3, 81.2, 80.8, 80.6, 81.1, 81.0, and
80.6ms.

The initial surface creates exactly two ECharts instances: the selected-machine
operational dashboard and one shared fleet-utilization chart—never one chart
per source card. Every cached and warm-uncached candidate recorded zero chart
initializations/disposals and no Long Tasks; the settled 300ms idle window had
zero RPCs, chart updates, intervals, or DOM mutations. The browser preflight
asserts that topology so a per-card regression fails before timing samples are
accepted.
