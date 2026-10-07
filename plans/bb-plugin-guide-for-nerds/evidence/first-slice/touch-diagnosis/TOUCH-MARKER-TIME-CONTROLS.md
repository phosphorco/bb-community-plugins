# Touch markers, elapsed time and retap controls

Followup diagnosis for steward thr_pk5kwrdyjm. Retained script/data/output:
`touch-close-marker-retap.cjs`, `.json`, `.log` in this thread storage.
Command: `node "$BB_THREAD_STORAGE/touch-close-marker-retap.cjs"`; exit 0.
Chromium 153.0.8010.12; independent fresh contexts, bare HTML control, same abrupt
native CDP header drag and resize/scroll. No BB/React/SDK code participates.

| Condition | First tap | Subsequent tap |
| --- | --- | --- |
| No markers; first tap after100ms | No click; frame remains | After500ms observation, emits click/closes without markers |
| Both markers before first tap; first tap after100ms | No click; frame remains | Emits click/closes with the unchanged markers |
| Both markers added only before second tap | No click; frame remains | Emits click/closes |
| No markers; first tap after1000ms | Emits click/closes | Not needed |

Markers are `data-no-sidebar-swipe` and `data-no-secondary-panel-swipe` on the
owned outer frame. They are ordinary attributes in the bare control, so this
experiment isolates the browser/input confounds rather than certifying how all
native host listeners respond to them. The corrected owned result flag and
actual click traces are retained; observation is500ms after each tap.

Interpretation: second-tap success requires neither marker in this reproduction.
Markers before the first tap do not rescue the abrupt gesture. Enough elapsed
time can restore a first click without markers; prior100ms/450ms pre-tap controls
failed while this1000ms control passed. Exact Chromium transient thresholds are
not established. The earlier paced five8px/40ms gesture also restored first-tap
click in bare HTML and the canonical plugin without either marker.

This rejects inferring a marker fix from the owner's second-tap observation. It
does not prove markers have no effect on every canonical host interaction. A
canonical first-tap marker/no-marker A/B during a fixed runtime generation was
not run while root's builds/reloads were active; no stable interval was needed
for these independent browser controls. Existing native no-marker paced success
remains the concrete canonical evidence.

Read-only host-source checks: sidebar.tsx:271 requires a physical sidebar-inset/
backdrop target before the marker exclusion guard matters; body-portaled frame
DOM is outside that boundary. use-horizontal-dismiss-drag.ts:15 consumes both
markers, but beginPointerDrag/beginTouchDrag are attached to the bounded
secondary shelf (CompactSecondaryPanelShelf.tsx), not globally to the body
portal. The hooks' click suppressors prevent/stop a click when it occurs. The
failed witness has no click at all, and the bare reproduction has no such hooks.
These anchors support the diagnosis but do not certify every host listener.

Recommendation stays: retain the abrupt-input witness as a browser limitation;
use the demonstrated paced native drag and first-tap detach assertion for the
representative touch interaction, without DOM marker/source mutation. Do not
use second-tap success to satisfy first-tap acceptance. A long wait is a useful
control, not evidence for adding an arbitrary delay to product behavior. Root
independently reruns its witness; physical touch hardware remains unverified.

No canonical source/evidence/plan/ledger, install/build/reload/runtime state was
changed. No root output filename was reused.
